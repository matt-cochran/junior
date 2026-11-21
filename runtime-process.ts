// ---------------------------------------------------------------------------
// Streaming child process primitives for the runtime (ADR 0016).
//
// This module holds the heartbeat, tool watchdog, detached spawn and kill
// helpers, plus the async bounded check executor.
// ---------------------------------------------------------------------------

import { closeSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DEFAULT_MAX_OUTPUT_BYTES, KILL_GRACE_MS, type ExecutionSettings } from './runtime-settings.ts';
import type { OutputBreakdown } from './runtime-events.ts';
import { systemClock, type Clock, type ClockTimer } from './clock.ts';

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export type RuntimeState =
 | 'starting' | 'running' | 'quiet' | 'tool_timed_out' | 'deadline_exceeded'
 | 'failed' | 'interrupted' | 'ready_for_review';

export type RuntimePhase = 'readiness' | 'isolation' | 'classifier' | 'admission' | 'worker' | 'checks' | 'postflight' | 'done';

export type RuntimeSnapshot = {
 state: RuntimeState;
 phase: RuntimePhase;
 /** #277: why the run is waiting for admission, while it waits. */
 admission?: { reason: string; detail: string; pool: string | null; since: string } | null;
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
 * the worker phase is active. The optional `clock` (default `systemClock`)
 * times heartbeat writes, and executors sharing this heartbeat fall back to it
 * for their own timers when they are not given a clock explicitly. */
export class RuntimeHeartbeat {
 readonly clock: Clock;
 private snap: RuntimeSnapshot;
 private lastWriteAt = 0;
 private lastProgressAt = 0;
 private readonly path: string;
 private readonly progress?: ProgressSink;
 constructor(path: string, settings: ExecutionSettings, startedAt: number, deadlineAt: number, phase: RuntimePhase = 'worker', progress?: ProgressSink, clock: Clock = systemClock) {
  this.clock = clock;
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
 /** Directory holding the run artifacts (where runtime.json lives). */
 captureDir(): string { return dirname(this.path); }
 private write(force = false): void {
  const now = this.clock.now();
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

export type SpawnChildOptions = {
 cwd: string;
 env?: NodeJS.ProcessEnv;
 /** Capture stdout in this file instead of a pipe. */
 stdoutPath?: string;
 /** Capture stderr in this file instead of a pipe. */
 stderrPath?: string;
 /** Clock for the capture-file tail poll (default `systemClock`). The
  * executors deliberately do not forward their own clock here: the poll only
  * pumps bytes a real child already wrote, so it stays on real time even when a
  * test drives deadlines and kill grace from a manual clock. */
 clock?: Clock;
};

export type SpawnChild = (command: string, args: string[], opts: SpawnChildOptions) => ChildProcessLike;

type FileTail = {
 stream: PassThrough;
 readAvailable(): void;
 end(): void;
};

const TAIL_POLL_MS = 25;

/** Tail one capture file as a Readable so the caller's existing line handling
 * sees every byte even though the child wrote to a plain file descriptor. */
function createFileTail(path: string): FileTail {
 const stream = new PassThrough();
 const buffer = Buffer.alloc(64 * 1024);
 let fd: number | null = null;
 let offset = 0;
 const open = (): number | null => {
  if (fd !== null) return fd;
  try { fd = openSync(path, 'r'); } catch { fd = null; }
  return fd;
 };
 const readAvailable = (): void => {
  const handle = open();
  if (handle === null) return;
  for (;;) {
   let bytes = 0;
   try { bytes = readSync(handle, buffer, 0, buffer.length, offset); }
   catch { return; }
   if (bytes <= 0) return;
   offset += bytes;
   stream.write(buffer.subarray(0, bytes));
  }
 };
 return {
  stream,
  readAvailable,
  end(): void {
   readAvailable();
   stream.end();
   if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } fd = null; }
  },
 };
}

/** Wrap a capture-backed child so its exit/close follow the tail streams. */
function captureChild(raw: ChildProcess, clock: Clock, stdoutTail?: FileTail, stderrTail?: FileTail): ChildProcessLike {
 const wrapper = new EventEmitter() as unknown as ChildProcessLike & EventEmitter;
 wrapper.pid = raw.pid;
 wrapper.stdout = stdoutTail ? stdoutTail.stream : raw.stdout;
 wrapper.stderr = stderrTail ? stderrTail.stream : raw.stderr;
 wrapper.kill = (signal?: NodeJS.Signals) => raw.kill(signal as any);
 let finished = false;
 const poll = clock.setInterval(() => { stdoutTail?.readAvailable(); stderrTail?.readAvailable(); }, TAIL_POLL_MS);
 const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
  if (finished) return;
  finished = true;
  clock.clearInterval(poll);
  stdoutTail?.end();
  stderrTail?.end();
  // Let the final tail chunks reach data listeners before the lifecycle events.
  setImmediate(() => {
   wrapper.emit('exit', code, signal);
   wrapper.emit('close', code, signal);
  });
 };
 raw.on('error', (err: Error) => { wrapper.emit('error', err); });
 raw.on('exit', (code: number | null, signal: NodeJS.Signals | null) => { finish(code, signal); });
 raw.on('close', (code: number | null, signal: NodeJS.Signals | null) => { finish(code, signal); });
 return wrapper;
}

/** Detached spawn so the child leads its own process group on Linux; this lets
 * cancellation reach shell children rather than only the direct process. When
 * capture paths are supplied they become plain fds, which keep working inside a
 * Codex workspace-write sandbox where child pipes lose all output. */
export const spawnChildDetached: SpawnChild = (command, args, opts) => {
 const stdoutPath = opts.stdoutPath;
 const stderrPath = opts.stderrPath;
 if (!stdoutPath && !stderrPath) {
  return spawn(command, args, {
   cwd: opts.cwd,
   env: opts.env ?? process.env,
   detached: process.platform !== 'win32',
   stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as ChildProcessLike;
 }

 let stdoutFd: number | undefined;
 let stderrFd: number | undefined;
 const fds: number[] = [];
 let child: ChildProcessLike;
 try {
  if (stdoutPath) { mkdirSync(dirname(stdoutPath), { recursive: true }); stdoutFd = openSync(stdoutPath, 'w', 0o600); fds.push(stdoutFd); }
  if (stderrPath) { mkdirSync(dirname(stderrPath), { recursive: true }); stderrFd = openSync(stderrPath, 'w', 0o600); fds.push(stderrFd); }
  const raw = spawn(command, args, {
   cwd: opts.cwd,
   env: opts.env ?? process.env,
   detached: process.platform !== 'win32',
   stdio: ['ignore', stdoutFd ?? 'pipe', stderrFd ?? 'pipe'],
  });
  const stdoutTail = stdoutPath ? createFileTail(stdoutPath) : undefined;
  const stderrTail = stderrPath ? createFileTail(stderrPath) : undefined;
  child = captureChild(raw, opts.clock ?? systemClock, stdoutTail, stderrTail);
 } finally {
  for (const fd of fds) { try { closeSync(fd); } catch { /* already closed */ } }
 }
 return child;
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
 /** Optional file-backed capture paths (sandbox-safe stdout/stderr). */
 stdoutPath?: string;
 stderrPath?: string;
 /** Clock for the timeout/deadline monitor and the SIGKILL grace timer;
  * defaults to the heartbeat's clock, then `systemClock`. */
 clock?: Clock;
};

/** Run one acceptance check as an async bounded process. The whole process
 * group is stopped with SIGTERM then a bounded SIGKILL, so a hung check with a
 * TERM-ignoring descendant cannot survive. Always resolves; never throws. */
let checkCaptureSequence = 0;

type CheckStopReason = 'timeout' | 'deadline' | 'interrupt' | 'output_truncated';

type CheckRun = {
 opts: ExecuteCheckOptions;
 clock: Clock;
 startedAt: number;
 maxOutputBytes: number;
 stdout: string;
 stderr: string;
 exitCode: number | null;
 exitSignal: string | null;
 error: string | undefined;
 interrupted: boolean;
 timedOut: boolean;
 deadlineExceeded: boolean;
 outputTruncated: boolean;
 rawBytes: number;
 finished: boolean;
 killTimer: ClockTimer | undefined;
 killEscalationComplete: boolean;
 completionRequested: boolean;
 child: ChildProcessLike | undefined;
 monitor: ClockTimer | undefined;
 resolveDone: (r: CheckResult) => void;
 onAbort: () => void;
};

function pushCheckOutput(run: CheckRun, kind: 'stdout' | 'stderr', chunk: any): void {
 const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
 if (kind === 'stdout') run.rawBytes += text.length;
 const current = kind === 'stdout' ? run.stdout : run.stderr;
 if (current.length >= run.maxOutputBytes) { run.outputTruncated = true; requestCheckStop(run, 'output_truncated'); return; }
 const remaining = run.maxOutputBytes - current.length;
 let accepted = text;
 if (accepted.length > remaining) { accepted = accepted.slice(0, remaining); run.outputTruncated = true; }
 if (kind === 'stdout') run.stdout += accepted; else run.stderr += accepted;
 if (run.outputTruncated) requestCheckStop(run, 'output_truncated');
}

function finalizeCheck(run: CheckRun): void {
 if (run.finished) return;
 run.completionRequested = true;
 if (run.killTimer && !run.killEscalationComplete) return;
 run.finished = true;
 if (run.monitor) run.clock.clearInterval(run.monitor);
 // Do not clear killTimer: a TERM-ignoring descendant must still be SIGKILLed
 // even after the direct child exits.
 run.opts.signal?.removeEventListener?.('abort', run.onAbort);
 const { stdout, stderr, exitCode, error, interrupted, timedOut, deadlineExceeded, outputTruncated, rawBytes } = run;
 run.resolveDone({ stdout, stderr, exitCode, signal: run.exitSignal, error, interrupted, timedOut, deadlineExceeded, outputTruncated, outputBreakdown: { rawBytes, retainedBytes: stdout.length, byType: {}, largestToolResults: [] } });
}

function terminateCheckChild(run: CheckRun, child: ChildProcessLike): void {
 killChildGroup(child, 'SIGTERM');
 run.killTimer = run.clock.setTimeout(() => { if (run.child) killChildGroup(run.child, 'SIGKILL'); run.killEscalationComplete = true; if (run.completionRequested) finalizeCheck(run); }, KILL_GRACE_MS);
}

function requestCheckStop(run: CheckRun, reason: CheckStopReason): void {
 if (run.finished) return;
 if (reason === 'timeout') run.timedOut = true;
 else if (reason === 'deadline') run.deadlineExceeded = true;
 else if (reason === 'interrupt') run.interrupted = true;
 if (run.child) {
  terminateCheckChild(run, run.child);
 } else {
  finalizeCheck(run);
 }
}

function attachCheckChild(run: CheckRun, stream: ChildProcessLike): void {
 const opts = run.opts;
 stream.stdout?.on('data', (c: any) => pushCheckOutput(run, 'stdout', c));
 stream.stderr?.on('data', (c: any) => pushCheckOutput(run, 'stderr', c));
 stream.on('error', (err: Error) => {
  if (!run.error) run.error = err?.message || String(err);
  // A broken stream must still tear down the process group, not orphan it.
  if (run.child) {
   terminateCheckChild(run, run.child);
  }
  finalizeCheck(run);
 });
 stream.on('exit', (code: number | null, signal: string | null) => { run.exitCode = code ?? null; run.exitSignal = signal ?? null; });
 stream.on('close', (code: number | null, signal: string | null) => {
  if (run.exitCode === null && code !== undefined) run.exitCode = code ?? null;
  if (run.exitSignal === null && signal) run.exitSignal = signal;
  finalizeCheck(run);
 });
 run.monitor = run.clock.setInterval(() => {
  const now = run.clock.now();
  opts.heartbeat?.poll(now, null, null);
  if (run.finished || run.timedOut || run.deadlineExceeded || run.interrupted) return;
  if (now - run.startedAt >= opts.timeoutMs) requestCheckStop(run, 'timeout');
  else if (now >= opts.deadlineAt) requestCheckStop(run, 'deadline');
 }, 25);
}

export async function executeCheck(opts: ExecuteCheckOptions): Promise<CheckResult> {
 const clock = opts.clock ?? opts.heartbeat?.clock ?? systemClock;
 const startedAt = clock.now();
 const maxOutputBytes = typeof opts.maxOutputBytes === 'number' && opts.maxOutputBytes > 0 ? opts.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES;
 const captureDir = opts.heartbeat?.captureDir?.();
 const captureSequence = checkCaptureSequence++;
 const stdoutPath = opts.stdoutPath ?? (captureDir ? join(captureDir, `check-${captureSequence}.stdout`) : undefined);
 const stderrPath = opts.stderrPath ?? (captureDir ? join(captureDir, `check-${captureSequence}.stderr`) : undefined);

 let resolveDone!: (r: CheckResult) => void;
 const done = new Promise<CheckResult>((res) => { resolveDone = res; });
 const run: CheckRun = {
  opts, clock, startedAt, maxOutputBytes,
  stdout: '', stderr: '', exitCode: null, exitSignal: null, error: undefined,
  interrupted: false, timedOut: false, deadlineExceeded: false, outputTruncated: false,
  rawBytes: 0, finished: false, killTimer: undefined, killEscalationComplete: false,
  completionRequested: false, child: undefined, monitor: undefined,
  resolveDone, onAbort: () => { run.interrupted = true; requestCheckStop(run, 'interrupt'); },
 };

 opts.heartbeat?.update({ phase: 'checks' });

 if (opts.signal) {
  if (opts.signal.aborted) run.onAbort();
  else opts.signal.addEventListener?.('abort', run.onAbort);
 }

 try {
  if (!opts.signal?.aborted) run.child = opts.spawnChild(opts.command, opts.args, { cwd: opts.cwd, stdoutPath, stderrPath });
 } catch (err: any) {
  run.error = err?.message || String(err);
 }

 if (run.child) {
  attachCheckChild(run, run.child);
 } else {
  finalizeCheck(run);
 }

 return done;
}

export function isSuccessStatus(status: string | null | undefined): boolean {
 return status === 'ready_for_review' || status === 'simulation_passed';
}
