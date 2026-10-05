// ---------------------------------------------------------------------------
// Bounded runtime for a live Pi execution.
//
// Live Pi runs use a streaming async child process (never `spawnSync`). The
// runtime keeps a persistent `events.jsonl` (raw Pi JSONL stdout), `worker.log`
// (raw stderr) and an atomically rewritten `runtime.json` heartbeat, and it
// enforces three independent bounds:
//
//   * total wall `deadlineMs` from before readiness/isolation/classifier,
//   * per-tool `toolTimeoutMs` measured from `tool_execution_start` through
//     `tool_execution_end` (updates never reset the duration),
//   * a `quietMs` idle threshold that only changes the reported state; quiet
//     never restarts or kills the child.
//
// On a tool timeout or wall-deadline breach the Linux detached process group is
// stopped with SIGTERM and then a bounded SIGKILL, which also covers shell
// descendants. An injected AbortSignal (or a real SIGINT/SIGTERM) produces an
// `interrupted` handback. No automatic retry or restart is ever performed.
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

export type ExecutionSettings = {
 deadlineMs: number;
 quietMs: number;
 toolTimeoutMs: number;
 heartbeatMs: number;
 checkTimeoutMs: number;
};

export const EXECUTION_DEFAULTS: ExecutionSettings = {
 deadlineMs: 600000,
 quietMs: 120000,
 toolTimeoutMs: 300000,
 heartbeatMs: 5000,
 checkTimeoutMs: 120000,
};

/** Positive finite bounds. Values outside a bound are rejected, not coerced. */
export const EXECUTION_BOUNDS: Record<keyof ExecutionSettings, { min: number; max: number }> = {
 deadlineMs: { min: 1, max: 24 * 60 * 60 * 1000 },
 quietMs: { min: 1, max: 24 * 60 * 60 * 1000 },
 toolTimeoutMs: { min: 1, max: 24 * 60 * 60 * 1000 },
 heartbeatMs: { min: 1, max: 60 * 60 * 1000 },
 checkTimeoutMs: { min: 1, max: 24 * 60 * 60 * 1000 },
};

export const EXECUTION_FIELDS = Object.keys(EXECUTION_DEFAULTS) as (keyof ExecutionSettings)[];

/** Read the raw settings block. A nested `execution` object wins over top-level
 * task fields, so a task can group runtime settings without ambiguity. */
function settingsSource(t: any): any {
 if (t && typeof t.execution === 'object' && t.execution !== null && !Array.isArray(t.execution)) return t.execution;
 return t ?? {};
}

/** Validate and resolve execution settings from a task. Any supplied value must
 * be a finite number within its bound; omitted values take the default. Throws
 * on an invalid value so a bad contract fails before any paid call. */
export function resolveExecutionSettings(t: any): ExecutionSettings {
 const src = settingsSource(t);
 const out: any = { ...EXECUTION_DEFAULTS };
 for (const key of EXECUTION_FIELDS) {
  const v = src?.[key];
  if (v === undefined || v === null) continue;
  const bound = EXECUTION_BOUNDS[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < bound.min || v > bound.max) {
   throw Error(`Invalid execution.${key} (expected a finite number in [${bound.min}, ${bound.max}])`);
  }
  out[key] = v;
 }
 return out as ExecutionSettings;
}

export function validateExecutionSettings(t: any): void {
 resolveExecutionSettings(t);
}

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

/** Atomically-rewritten runtime.json heartbeat. `poll()` is cheap and is driven
 * by the streaming executor; it flips `running` to `quiet` after `quietMs` of
 * inactivity and writes at most every `heartbeatMs`. */
export class RuntimeHeartbeat {
 private snap: RuntimeSnapshot;
 private lastWriteAt = 0;
 private readonly path: string;
 constructor(path: string, settings: ExecutionSettings, startedAt: number, deadlineAt: number, phase: RuntimePhase = 'worker') {
  this.path = path;
  this.snap = {
   state: 'starting', phase,
   startedAt: iso(startedAt), heartbeatAt: iso(startedAt), lastActivityAt: iso(startedAt),
   elapsedMs: 0, remainingMs: Math.max(0, deadlineAt - startedAt), deadlineAt: iso(deadlineAt),
   deadlineMs: settings.deadlineMs, quietMs: settings.quietMs, toolTimeoutMs: settings.toolTimeoutMs,
   heartbeatMs: settings.heartbeatMs, checkTimeoutMs: settings.checkTimeoutMs,
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
  if (this.snap.state === 'running' && now - Date.parse(this.snap.lastActivityAt) >= this.snap.quietMs) {
   this.snap.state = 'quiet';
   this.write(true);
   return;
  }
  this.write();
 }
}

// ---------------------------------------------------------------------------
// Tool watchdog
// ---------------------------------------------------------------------------

type ActiveTool = { name: string; startedAt: number };

/** Correlates Pi `tool_execution_start/update/end` events by `toolCallId`. The
 * duration runs from start through end; an update only refreshes activity and
 * never resets the duration. */
export class ToolWatchdog {
 private active = new Map<string, ActiveTool>();
 onEvent(ev: any, now: number): void {
  if (!ev || typeof ev !== 'object') return;
  const id = typeof ev.toolCallId === 'string' && ev.toolCallId ? ev.toolCallId : (typeof ev.toolName === 'string' ? `name:${ev.toolName}` : null);
  if (!id) return;
  if (ev.type === 'tool_execution_start') this.active.set(id, { name: ev.toolName || 'tool', startedAt: now });
  else if (ev.type === 'tool_execution_update') { if (!this.active.has(id)) this.active.set(id, { name: ev.toolName || 'tool', startedAt: now }); }
  else if (ev.type === 'tool_execution_end') this.active.delete(id);
 }
 currentTool(): string | null {
  let latest: ActiveTool | null = null;
  for (const t of this.active.values()) if (!latest || t.startedAt >= latest.startedAt) latest = t;
  return latest ? latest.name : null;
 }
 activeCount(): number { return this.active.size; }
 longest(now: number): { id: string; name: string; elapsedMs: number } | null {
  let out: { id: string; name: string; elapsedMs: number } | null = null;
  for (const [id, t] of this.active) {
   const elapsedMs = now - t.startedAt;
   if (!out || elapsedMs > out.elapsedMs) out = { id, name: t.name, elapsedMs };
  }
  return out;
 }
 /** The first active tool that has exceeded the per-tool limit, if any. */
 expired(now: number, toolTimeoutMs: number): { id: string; name: string; elapsedMs: number } | null {
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

export const KILL_GRACE_MS = 2000;

/** Default bound on bytes retained (and persisted) from a single child's
 * stdout/stderr. Far above any real receipt, low enough to prevent memory
 * exhaustion from a runaway process. */
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

type StreamStopReason = 'tool_timeout' | 'deadline' | 'interrupt' | 'startup_error' | 'stream_error' | 'output_limit';

export type WorkerStreamResult = {
 stdout: string;
 stderr: string;
 exitCode: number | null;
 signal: string | null;
 error?: string;
 /** Set when a stdout/stderr stream emitted an error. */
 streamError?: string;
 /** Set when persisting events.jsonl/worker.log failed. */
 persistError?: string;
 interrupted: boolean;
 timedOut: boolean;
 deadlineExceeded: boolean;
 /** True when stdout/stderr exceeded the accumulation cap; the receipt is not complete. */
 outputTruncated: boolean;
 stopReason: string;
 runtime: RuntimeSnapshot;
};

export type ExecuteWorkerOptions = {
 spawnChild: SpawnChild;
 command: string;
 args: string[];
 cwd: string;
 eventsPath: string;
 logPath: string;
 runtimePath: string;
 settings: ExecutionSettings;
 deadlineAt: number;
 phase?: RuntimePhase;
 signal?: AbortSignal;
 /** Optional output cap override (bytes); defaults to DEFAULT_MAX_OUTPUT_BYTES. */
 maxOutputBytes?: number;
 onActivity?: (snapshot: RuntimeSnapshot) => void;
 /** Optional shared heartbeat so one runtime.json reflects every phase of the
  * whole run, not only the worker phase. */
 heartbeat?: RuntimeHeartbeat;
};

/** Split strict JSONL incrementally. Returns complete lines and leaves an
 * incomplete trailing fragment for the next chunk. */
export function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
 const text = buffer + chunk;
 const parts = text.split('\n');
 const rest = parts.pop() ?? '';
 return { lines: parts, rest };
}

/** Execute a live Pi child with streaming persistence, heartbeat and bounds.
 * Always resolves with an inspectable result, even on startup error, malformed
 * or partial events, timeout, deadline breach or interruption. Completion is
 * driven by `close`, not `exit`, so trailing stdout/stderr bytes are never
 * dropped. */
export async function executeWorkerStreaming(opts: ExecuteWorkerOptions): Promise<WorkerStreamResult> {
 const { settings, spawnChild, command, args, cwd, eventsPath, logPath, runtimePath } = opts;
 const startedAt = Date.now();
 const heartbeat = opts.heartbeat ?? new RuntimeHeartbeat(runtimePath, settings, startedAt, opts.deadlineAt, opts.phase ?? 'worker');
 const watchdog = new ToolWatchdog();
 const maxOutputBytes = typeof opts.maxOutputBytes === 'number' && opts.maxOutputBytes > 0 ? opts.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES;
 heartbeat.update({ phase: opts.phase ?? 'worker' });
 if (!opts.heartbeat) heartbeat.begin();

 let stdout = '';
 let stderr = '';
 let pending = '';
 let stopReason: StreamStopReason | null = null;
 let timedOut = false;
 let deadlineExceeded = false;
 let interrupted = false;
 let outputTruncated = false;
 let startupError: string | undefined;
 let streamError: string | undefined;
 let persistError: string | undefined;
 let exitCode: number | null = null;
 let exitSignal: string | null = null;
 let finished = false;
 let killTimer: ReturnType<typeof setTimeout> | undefined;
 let killEscalationComplete = false;
 let completionRequested = false;
 let child: ChildProcessLike | undefined;
 let monitor: ReturnType<typeof setInterval> | undefined;

 let resolveDone!: (r: WorkerStreamResult) => void;
 const done = new Promise<WorkerStreamResult>((res) => { resolveDone = res; });

 // Persist raw stdout/stderr immediately; a persistence failure is recorded but
 // never aborts the run. Both files are created up front so a startup failure
 // still leaves an inspectable events.jsonl / worker.log pair.
 const append = (path: string, text: string): void => {
  try { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, text); }
  catch (e: any) { if (!persistError) persistError = e?.message || String(e); }
 };
 append(eventsPath, '');
 append(logPath, '');

 function finalize(): void {
  if (finished) return;
  completionRequested = true;
  if (killTimer && !killEscalationComplete) return;
  finished = true;
  if (monitor) clearInterval(monitor);
  // The kill-escalation timer is deliberately NOT cleared on direct child exit:
  // a descendant that ignores SIGTERM must still receive the bounded SIGKILL.
  opts.signal?.removeEventListener?.('abort', onAbort);
  if (stopReason === 'interrupt') heartbeat.setState('interrupted', { interrupted: true, stopReason: 'interrupted', exitCode, signal: exitSignal });
  else if (stopReason === 'deadline') heartbeat.setState('deadline_exceeded', { deadlineExceeded: true, stopReason: 'deadline_exceeded', exitCode, signal: exitSignal });
  else if (stopReason === 'tool_timeout') heartbeat.setState('tool_timed_out', { timedOut: true, stopReason: 'tool_timed_out', exitCode, signal: exitSignal });
  else if (stopReason === 'startup_error') heartbeat.setState('failed', { error: startupError, stopReason: 'failed', exitCode, signal: exitSignal });
  else if (stopReason === 'stream_error') heartbeat.setState('failed', { error: streamError, stopReason: 'failed', exitCode, signal: exitSignal });
  else if (stopReason === 'output_limit') heartbeat.setState('failed', { stopReason: 'failed', exitCode, signal: exitSignal });
  else heartbeat.setState(exitCode === 0 ? 'running' : 'failed', { stopReason: exitCode === 0 ? 'completed' : 'failed', exitCode, signal: exitSignal });
  const runtime = heartbeat.snapshot();
  const reason = runtime.stopReason ?? (exitCode === 0 ? 'completed' : 'failed');
  resolveDone({ stdout, stderr, exitCode, signal: exitSignal, error: startupError, streamError, persistError, interrupted, timedOut, deadlineExceeded, outputTruncated, stopReason: reason, runtime });
 }

 function requestStop(reason: StreamStopReason): void {
  if (stopReason) return;
  stopReason = reason;
  if (reason === 'tool_timeout') timedOut = true;
  else if (reason === 'deadline') deadlineExceeded = true;
  else if (reason === 'interrupt') interrupted = true;
  if (child) {
   killChildGroup(child, 'SIGTERM');
   killTimer = setTimeout(() => { if (child) killChildGroup(child, 'SIGKILL'); killEscalationComplete = true; if (completionRequested) finalize(); }, KILL_GRACE_MS);
  }
  if (reason === 'startup_error' || reason === 'stream_error') finalize();
 }

 function onAbort(): void { interrupted = true; requestStop('interrupt'); }
 if (opts.signal) {
  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener?.('abort', onAbort);
 }

 function handleLine(line: string): void {
  const now = Date.now();
  let ev: any = null;
  if (line.trim()) { try { ev = JSON.parse(line.endsWith('\r') ? line.slice(0, -1) : line); } catch { ev = null; } }
  if (ev && typeof ev === 'object') watchdog.onEvent(ev, now);
  heartbeat.activity(now, watchdog.currentTool());
  const longest = watchdog.longest(now);
  heartbeat.poll(now, watchdog.currentTool(), longest ? longest.elapsedMs : null);
  opts.onActivity?.(heartbeat.snapshot());
 }

 // Append up to the cap and report the accepted (possibly truncated) text.
 function pushOutput(kind: 'stdout' | 'stderr', text: string): string {
  const current = kind === 'stdout' ? stdout : stderr;
  if (current.length >= maxOutputBytes) { outputTruncated = true; return ''; }
  const remaining = maxOutputBytes - current.length;
  let accepted = text;
  if (accepted.length > remaining) { accepted = accepted.slice(0, remaining); outputTruncated = true; }
  if (kind === 'stdout') stdout += accepted; else stderr += accepted;
  append(kind === 'stdout' ? eventsPath : logPath, accepted);
  return accepted;
 }

 function onStreamError(err: Error): void {
  if (!streamError) streamError = err?.message || String(err);
  requestStop('stream_error');
 }
 function onChildError(err: Error): void {
  startupError = err?.message || String(err);
  if (child) { requestStop('startup_error'); return; }
  stopReason = 'startup_error';
  finalize();
 }
 function onExit(code: number | null, signal: string | null): void {
  exitCode = code ?? null;
  exitSignal = signal ?? null;
 }
 function onClose(code: number | null, signal: string | null): void {
  if (exitCode === null && code !== undefined) exitCode = code ?? null;
  if (exitSignal === null && signal) exitSignal = signal;
  if (pending.trim()) handleLine(pending);
  finalize();
 }

 try {
  if (!opts.signal?.aborted) child = spawnChild(command, args, { cwd });
 } catch (err: any) {
  startupError = err?.message || String(err);
  stopReason = 'startup_error';
 }

 if (child) {
  const stream = child;
  if (stream.stdout) {
   stream.stdout.on('data', (chunk: any) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const accepted = pushOutput('stdout', text);
    if (!accepted) return;
    const split = splitLines(pending, accepted);
    pending = split.rest;
    for (const line of split.lines) handleLine(line);
   });
   stream.stdout.on?.('error', onStreamError);
  }
  if (stream.stderr) {
   stream.stderr.on('data', (chunk: any) => { pushOutput('stderr', typeof chunk === 'string' ? chunk : chunk.toString('utf8')); });
   stream.stderr.on?.('error', onStreamError);
  }
  stream.on('error', onChildError);
  stream.on('exit', onExit);
  stream.on('close', onClose);
  // Monitor for tool timeouts and the wall deadline. Quiet is reported by the
  // heartbeat but is explicitly not a stop condition.
  monitor = setInterval(() => {
   const now = Date.now();
   const longest = watchdog.longest(now);
   heartbeat.poll(now, watchdog.currentTool(), longest ? longest.elapsedMs : null);
   if (stopReason) return;
   const expired = watchdog.expired(now, settings.toolTimeoutMs);
   if (expired) requestStop('tool_timeout');
   else if (now >= opts.deadlineAt) requestStop('deadline');
  }, 25);
 } else {
  if (!stopReason) { startupError = 'worker did not start'; stopReason = 'startup_error'; }
  finalize();
 }

 return done;
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
  const current = kind === 'stdout' ? stdout : stderr;
  if (current.length >= maxOutputBytes) { outputTruncated = true; return; }
  const remaining = maxOutputBytes - current.length;
  let accepted = text;
  if (accepted.length > remaining) { accepted = accepted.slice(0, remaining); outputTruncated = true; }
  if (kind === 'stdout') stdout += accepted; else stderr += accepted;
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
  resolveDone({ stdout, stderr, exitCode, signal: exitSignal, error, interrupted, timedOut, deadlineExceeded, outputTruncated });
 }

 function requestStop(reason: 'timeout' | 'deadline' | 'interrupt'): void {
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
