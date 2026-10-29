// ---------------------------------------------------------------------------
// Streaming child process primitives for the runtime (ADR 0016).
//
// This module holds the heartbeat, tool watchdog, detached spawn and kill
// helpers, plus the async bounded check executor.
// ---------------------------------------------------------------------------

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { DEFAULT_MAX_OUTPUT_BYTES, KILL_GRACE_MS, type ExecutionSettings } from './runtime-settings.ts';
import type { OutputBreakdown } from './runtime-events.ts';

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export type RuntimeState =
 | 'starting' | 'running' | 'quiet' | 'tool_timed_out' | 'deadline_exceeded'
 | 'failed' | 'interrupted' | 'ready_for_review';

export type RuntimePhase = 'readiness' | 'isolation' | 'classifier' | 'worker' | 'checks' | 'postflight' | 'done';

export type RuntimeSnapshot = {
 state: RuntimeState;
 phase: RuntimePhase;
 startedAt: string;
 heartbeatAt: string;
 lastActivityAt: string;
 elapsedMs: number;
 remainingMs: number;
 deadlineAt: string;
 deadlineMs: number;
 quietMs: number;
 toolTimeoutMs: number;
 heartbeatMs: number;
 checkTimeoutMs: number;
 checkReserveMs: number;
 currentTool: string | null;
 activeToolMs: number | null;
 exitCode: number | null;
 signal: string | null;
 stopReason: string | null;
 interrupted: boolean;
 timedOut: boolean;
 deadlineExceeded: boolean;
 error?: string;
};

const iso = (ms: number) => new Date(ms).toISOString();

/** Optional short, human-readable progress lines (one per phase change and a
 * bounded heartbeat). The sink is best-effort: a throwing sink never aborts a
 * run. */
export type ProgressSink = (line: string) => void;

/** Atomically-rewritten runtime.json heartbeat. `poll()` is cheap and is driven
 * by the streaming executor; it flips `running` to `quiet` after `quietMs` of
 * inactivity and writes at most every `heartbeatMs`. When a progress sink is
 * supplied it also emits a heartbeat line at most every `heartbeatMs` while
 * the worker phase is active. */
export class RuntimeHeartbeat {
 private snap: RuntimeSnapshot;
 private lastWriteAt = 0;
 private lastProgressAt = 0;
 private readonly path: string;
 private readonly progress?: ProgressSink;
 constructor(path: string, settings: ExecutionSettings, startedAt: number, deadlineAt: number, phase: RuntimePhase = 'worker', progress?: ProgressSink) {
  this.path = path;
  this.progress = progress;
  this.snap = {
   state: 'starting', phase,
   startedAt: iso(startedAt), heartbeatAt: iso(startedAt), lastActivityAt: iso(startedAt),
   elapsedMs: 0, remainingMs: Math.max(0, deadlineAt - startedAt), deadlineAt: iso(deadlineAt),
   deadlineMs: settings.deadlineMs, quietMs: settings.quietMs, toolTimeoutMs: settings.toolTimeoutMs,
   heartbeatMs: settings.heartbeatMs, checkTimeoutMs: settings.checkTimeoutMs,
   checkReserveMs: settings.checkReserveMs,
   currentTool: null, activeToolMs: null, exitCode: null, signal: null, stopReason: null,
   interrupted: false, timedOut: false, deadlineExceeded: false,
  };
 }
 snapshot(): RuntimeSnapshot { return { ...this.snap }; }
 private write(force = false): void {
  const now = Date.now();
  if (!force && now - this.lastWriteAt < this.snap.heartbeatMs) return;
  this.lastWriteAt = now;
  this.snap.heartbeatAt = iso(now);
  try {
   mkdirSync(dirname(this.path), { recursive: true });
   const tmp = `${this.path}.${process.pid}.tmp`;
   writeFileSync(tmp, JSON.stringify(this.snap, null, 2) + '\n');
   renameSync(tmp, this.path);
  } catch { /* best effort: a heartbeat write must never abort a run */ }
 }
 begin(): void { this.snap.state = 'running'; this.write(true); }
 update(patch: Partial<RuntimeSnapshot>): void { Object.assign(this.snap, patch); this.write(true); }
 setState(state: RuntimeState, extra: Partial<RuntimeSnapshot> = {}): void { this.snap.state = state; Object.assign(this.snap, extra); this.write(true); }
 /** Record activity and, if the child had gone quiet, return it to `running`. */
 activity(now: number, tool: string | null): void {
  this.snap.lastActivityAt = iso(now);
  if (this.snap.state === 'quiet') { this.snap.state = 'running'; this.write(true); }
  if (tool !== undefined) this.snap.currentTool = tool;
 }
 /** Recompute elapsed/remaining, apply the quiet threshold and maybe persist. */
 poll(now: number, currentTool: string | null, activeToolMs: number | null): void {
  this.snap.elapsedMs = now - Date.parse(this.snap.startedAt);
  this.snap.remainingMs = Math.max(0, Date.parse(this.snap.deadlineAt) - now);
  this.snap.currentTool = currentTool;
  this.snap.activeToolMs = activeToolMs;
  this.emitHeartbeat(now, currentTool);
  if (this.snap.state === 'running' && now - Date.parse(this.snap.lastActivityAt) >= this.snap.quietMs) {
   this.snap.state = 'quiet';
   this.write(true);
   return;
  }
  this.write();
 }
 /** Emit at most one bounded heartbeat progress line per `heartbeatMs`, only
  * while the worker phase is active. Best-effort: never throws. */
 private emitHeartbeat(now: number, currentTool: string | null): void {
  if (!this.progress || this.snap.phase !== 'worker') return;
  if (now - this.lastProgressAt < this.snap.heartbeatMs) return;
  this.lastProgressAt = now;
  const elapsedSeconds = Math.max(0, Math.round((now - Date.parse(this.snap.startedAt)) / 1000));
  try { this.progress(`heartbeat ${elapsedSeconds}s${currentTool ? ` tool=${currentTool}` : ''}`); }
  catch { /* progress must never abort a run */ }
 }
}

// ---------------------------------------------------------------------------
// Tool watchdog
// ---------------------------------------------------------------------------

type ActiveTool = { name: string; startedAt: number; command?: string };

/** The command string from a `tool_execution_start` `args` payload, when present. */
function toolCommand(args: any): string | undefined {
 return args && typeof args === 'object' && typeof args.command === 'string' ? args.command : undefined;
}

/** Correlates Pi `tool_execution_start/update/end` events by `toolCallId`. The
 * duration runs from start through end; an update only refreshes activity and
 * never resets the duration. The start `args.command`, when present, is kept so
 * a timeout can name the offending command. */
export class ToolWatchdog {
 private active = new Map<string, ActiveTool>();
 onEvent(ev: any, now: number): void {
  if (!ev || typeof ev !== 'object') return;
  const id = typeof ev.toolCallId === 'string' && ev.toolCallId ? ev.toolCallId : (typeof ev.toolName === 'string' ? `name:${ev.toolName}` : null);
  if (!id) return;
  if (ev.type === 'tool_execution_start') this.active.set(id, { name: ev.toolName || 'tool', startedAt: now, command: toolCommand(ev.args) });
  else if (ev.type === 'tool_execution_update') { if (!this.active.has(id)) this.active.set(id, { name: ev.toolName || 'tool', startedAt: now, command: toolCommand(ev.args) }); }
  else if (ev.type === 'tool_execution_end') this.active.delete(id);
 }
 currentTool(): string | null {
  let latest: ActiveTool | null = null;
  for (const t of this.active.values()) if (!latest || t.startedAt >= latest.startedAt) latest = t;
  return latest ? latest.name : null;
 }
 activeCount(): number { return this.active.size; }
 longest(now: number): { id: string; name: string; elapsedMs: number; command?: string } | null {
  let out: { id: string; name: string; elapsedMs: number; command?: string } | null = null;
  for (const [id, t] of this.active) {
   const elapsedMs = now - t.startedAt;
   if (!out || elapsedMs > out.elapsedMs) out = { id, name: t.name, elapsedMs, command: t.command };
  }
  return out;
 }
 /** The first active tool that has exceeded the per-tool limit, if any. */
 expired(now: number, toolTimeoutMs: number): { id: string; name: string; elapsedMs: number; command?: string } | null {
  const l = this.longest(now);
  return l && l.elapsedMs >= toolTimeoutMs ? l : null;
 }
}

// ---------------------------------------------------------------------------
// Streaming child process
// ---------------------------------------------------------------------------

export type ChildProcessLike = {
 pid?: number;
 stdout: NodeJS.ReadableStream | null;
 stderr: NodeJS.ReadableStream | null;
 on(event: string, listener: (...args: any[]) => void): any;
 kill(signal?: NodeJS.Signals): boolean;
};

export type SpawnChild = (command: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => ChildProcessLike;

/** Detached spawn so the child leads its own process group on Linux; this lets
 * cancellation reach shell children rather than only the direct process. */
export const spawnChildDetached: SpawnChild = (command, args, opts) => {
 return spawn(command, args, {
  cwd: opts.cwd,
  env: opts.env ?? process.env,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
 }) as unknown as ChildProcessLike;
};

/** Stop the child's whole process group (Linux/macOS) or the child itself. */
export function killChildGroup(child: ChildProcessLike, signal: NodeJS.Signals): void {
 const pid = child.pid;
 if (pid && process.platform !== 'win32') {
  try { process.kill(-pid, signal); return; } catch { /* fall through to direct kill */ }
 }
 try { child.kill(signal); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// Async bounded check executor
// ---------------------------------------------------------------------------

export type CheckResult = {
 stdout: string;
 stderr: string;
 exitCode: number | null;
 signal: string | null;
 error?: string;
 interrupted: boolean;
 timedOut: boolean;
 deadlineExceeded: boolean;
 outputTruncated: boolean;
 outputBreakdown: OutputBreakdown;
};

export type ExecuteCheckOptions = {
 spawnChild: SpawnChild;
 command: string;
 args: string[];
 cwd: string;
 /** Bound on this check alone, measured from spawn. */
 timeoutMs: number;
 /** Absolute wall deadline shared with the whole run. */
 deadlineAt: number;
 signal?: AbortSignal;
 maxOutputBytes?: number;
 heartbeat?: RuntimeHeartbeat;
};

/** Run one acceptance check as an async bounded process. The whole process
 * group is stopped with SIGTERM then a bounded SIGKILL, so a hung check with a
 * TERM-ignoring descendant cannot survive. Always resolves; never throws. */
export async function executeCheck(opts: ExecuteCheckOptions): Promise<CheckResult> {
 const startedAt = Date.now();
 const maxOutputBytes = typeof opts.maxOutputBytes === 'number' && opts.maxOutputBytes > 0 ? opts.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES;
 let stdout = '';
 let stderr = '';
 let exitCode: number | null = null;
 let exitSignal: string | null = null;
 let error: string | undefined;
 let interrupted = false;
 let timedOut = false;
 let deadlineExceeded = false;
 let outputTruncated = false;
 let rawBytes = 0;
 let finished = false;
 let killTimer: ReturnType<typeof setTimeout> | undefined;
 let killEscalationComplete = false;
 let completionRequested = false;
 let child: ChildProcessLike | undefined;
 let monitor: ReturnType<typeof setInterval> | undefined;

 let resolveDone!: (r: CheckResult) => void;
 const done = new Promise<CheckResult>((res) => { resolveDone = res; });

 opts.heartbeat?.update({ phase: 'checks' });

 function push(kind: 'stdout' | 'stderr', chunk: any): void {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  if (kind === 'stdout') rawBytes += text.length;
  const current = kind === 'stdout' ? stdout : stderr;
  if (current.length >= maxOutputBytes) { outputTruncated = true; requestStop('output_truncated'); return; }
  const remaining = maxOutputBytes - current.length;
  let accepted = text;
  if (accepted.length > remaining) { accepted = accepted.slice(0, remaining); outputTruncated = true; }
  if (kind === 'stdout') stdout += accepted; else stderr += accepted;
  if (outputTruncated) requestStop('output_truncated');
 }

 function finalize(): void {
  if (finished) return;
  completionRequested = true;
  if (killTimer && !killEscalationComplete) return;
  finished = true;
  if (monitor) clearInterval(monitor);
  // Do not clear killTimer: a TERM-ignoring descendant must still be SIGKILLed
  // even after the direct child exits.
  opts.signal?.removeEventListener?.('abort', onAbort);
  resolveDone({ stdout, stderr, exitCode, signal: exitSignal, error, interrupted, timedOut, deadlineExceeded, outputTruncated, outputBreakdown: { rawBytes, retainedBytes: stdout.length, byType: {}, largestToolResults: [] } });
 }

 function requestStop(reason: 'timeout' | 'deadline' | 'interrupt' | 'output_truncated'): void {
  if (finished) return;
  if (reason === 'timeout') timedOut = true;
  else if (reason === 'deadline') deadlineExceeded = true;
  else if (reason === 'interrupt') interrupted = true;
  if (child) {
   killChildGroup(child, 'SIGTERM');
   killTimer = setTimeout(() => { if (child) killChildGroup(child, 'SIGKILL'); killEscalationComplete = true; if (completionRequested) finalize(); }, KILL_GRACE_MS);
  } else {
   finalize();
  }
 }

 function onAbort(): void { interrupted = true; requestStop('interrupt'); }
 if (opts.signal) {
  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener?.('abort', onAbort);
 }

 try {
  if (!opts.signal?.aborted) child = opts.spawnChild(opts.command, opts.args, { cwd: opts.cwd });
 } catch (err: any) {
  error = err?.message || String(err);
 }

 if (child) {
  const stream = child;
  stream.stdout?.on('data', (c: any) => push('stdout', c));
  stream.stderr?.on('data', (c: any) => push('stderr', c));
  stream.on('error', (err: Error) => {
   if (!error) error = err?.message || String(err);
   // A broken stream must still tear down the process group, not orphan it.
   if (child) {
    killChildGroup(child, 'SIGTERM');
    killTimer = setTimeout(() => { if (child) killChildGroup(child, 'SIGKILL'); killEscalationComplete = true; if (completionRequested) finalize(); }, KILL_GRACE_MS);
   }
   finalize();
  });
  stream.on('exit', (code: number | null, signal: string | null) => { exitCode = code ?? null; exitSignal = signal ?? null; });
  stream.on('close', (code: number | null, signal: string | null) => {
   if (exitCode === null && code !== undefined) exitCode = code ?? null;
   if (exitSignal === null && signal) exitSignal = signal;
   finalize();
  });
  monitor = setInterval(() => {
   const now = Date.now();
   opts.heartbeat?.poll(now, null, null);
   if (finished || timedOut || deadlineExceeded || interrupted) return;
   if (now - startedAt >= opts.timeoutMs) requestStop('timeout');
   else if (now >= opts.deadlineAt) requestStop('deadline');
  }, 25);
 } else {
  finalize();
 }

 return done;
}

export function isSuccessStatus(status: string | null | undefined): boolean {
 return status === 'ready_for_review' || status === 'simulation_passed';
}
