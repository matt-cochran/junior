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
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

export type ExecutionSettings = {
 deadlineMs: number;
 quietMs: number;
 toolTimeoutMs: number;
 heartbeatMs: number;
 checkTimeoutMs: number;
 /** Budget carved out of the total wall deadline so the contract's checks can
  * still run after the worker phase is stopped. Must be less than deadlineMs. */
 checkReserveMs: number;
 /** Cap on retained (compacted) bytes persisted from the worker's stdout. The
  * raw stream has a separate hard ceiling of 8x this value. */
 maxOutputBytes: number;
 /** Maximum automatic continuation segments after an output-capped worker
  * segment (0 disables continuation). Integer 0..3. */
 continuations: number;
};

export const EXECUTION_DEFAULTS: ExecutionSettings = {
 deadlineMs: 600000,
 quietMs: 120000,
 toolTimeoutMs: 300000,
 heartbeatMs: 5000,
 checkTimeoutMs: 120000,
 checkReserveMs: 120000,
 maxOutputBytes: 8 * 1024 * 1024,
 continuations: 1,
};

/** Positive finite bounds. Values outside a bound are rejected, not coerced. */
export const EXECUTION_BOUNDS: Record<keyof ExecutionSettings, { min: number; max: number }> = {
 deadlineMs: { min: 1, max: 24 * 60 * 60 * 1000 },
 quietMs: { min: 1, max: 24 * 60 * 60 * 1000 },
 toolTimeoutMs: { min: 1, max: 24 * 60 * 60 * 1000 },
 heartbeatMs: { min: 1, max: 60 * 60 * 1000 },
 checkTimeoutMs: { min: 1, max: 24 * 60 * 60 * 1000 },
 checkReserveMs: { min: 0, max: 24 * 60 * 60 * 1000 },
 maxOutputBytes: { min: 1024 * 1024, max: 32 * 1024 * 1024 },
 continuations: { min: 0, max: 3 },
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
  // checkReserveMs default depends on the resolved deadlineMs, so it is
  // resolved after the deadline is known.
  if (key === 'checkReserveMs') continue;
  const v = src?.[key];
  if (v === undefined || v === null) continue;
  const bound = EXECUTION_BOUNDS[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < bound.min || v > bound.max) {
   throw Error(`Invalid execution.${key} (expected a finite number in [${bound.min}, ${bound.max}])`);
  }
  if (key === 'continuations' && !Number.isInteger(v)) {
   throw Error(`Invalid execution.continuations (expected an integer in [${bound.min}, ${bound.max}])`);
  }
  out[key] = v;
 }
 const reserve = src?.checkReserveMs;
 if (reserve === undefined || reserve === null) {
  out.checkReserveMs = Math.min(120000, out.deadlineMs * 0.2);
 } else {
  const bound = EXECUTION_BOUNDS.checkReserveMs;
  if (typeof reserve !== 'number' || !Number.isFinite(reserve) || reserve < bound.min || reserve > bound.max) {
   throw Error(`Invalid execution.checkReserveMs (expected a finite number in [${bound.min}, ${bound.max}])`);
  }
  out.checkReserveMs = reserve;
 }
 if (!(out.checkReserveMs < out.deadlineMs)) throw Error('Invalid execution.checkReserveMs (expected less than deadlineMs)');
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

export const KILL_GRACE_MS = 2000;

/** Default bound on bytes retained (and persisted) from a single child's
 * stdout/stderr. Far above any real receipt, low enough to prevent memory
 * exhaustion from a runaway process. */
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

type StreamStopReason = 'tool_timeout' | 'deadline' | 'interrupt' | 'startup_error' | 'stream_error' | 'output_truncated' | 'budget' | 'scope';

/** Contract-level limits for a bounded worker run. Every field is optional so
 * an unconstrained contract keeps the previous behavior. */
export type BudgetLimits = {
 maxInputTokens?: number;
 maxFreshInputTokens?: number;
 maxCacheReadTokens?: number;
 maxCachedInputTokens?: number;
 maxOutputTokens?: number;
 maxTotalTokens?: number;
 maxToolCalls?: number;
 maxToolOutputBytes?: number;
 maxResponseCalls?: number;
 mode?: 'warn' | 'enforce';
};

/** Default enforced budget for report-only workflows: enough room to inspect
 * broadly, but bounded so a runaway report run still stops. */
export const REPORT_WORKFLOW_BUDGET: BudgetLimits = { maxToolCalls: 25, maxTotalTokens: 400000, mode: 'enforce' };

const REPORT_WORKFLOWS = new Set(['evaluate', 'qa', 'recon', 'investigate']);

/** Return a copy of the report-workflow default for report workflows, or null
 * for every other workflow so an unconstrained contract keeps its behavior. */
export function defaultWorkflowBudget(workflow: string): BudgetLimits | null {
 if (!REPORT_WORKFLOWS.has(workflow)) return null;
 return { ...REPORT_WORKFLOW_BUDGET };
}

/** Merge a contract budget over the workflow default field by field. Contract
 * fields win; workflow defaults fill the gaps; non-report workflows use only
 * the contract budget. */
export function effectiveBudget(workflow: string, contractBudget?: BudgetLimits): BudgetLimits | null {
 const base = defaultWorkflowBudget(workflow);
 if (!base) return contractBudget ? { ...contractBudget } : null;
 const merged: BudgetLimits = { ...base };
 if (contractBudget) {
  for (const key of Object.keys(contractBudget) as (keyof BudgetLimits)[]) {
   const value = contractBudget[key];
   if (value !== undefined) (merged as any)[key] = value;
  }
 }
 return merged;
}

/** Optional read boundary for the worker's read-like tool calls. */
export type ReadScopeLimit = {
 mode?: 'context-only' | 'context-plus-dependencies' | string;
 paths?: string[];
 maxFiles?: number;
 maxBytes?: number;
 allowGraft?: boolean;
};

/** Accounting for one runtime phase. The worker stream currently reports one
 * phase, but the shape keeps readiness/checks accounting additive. */
export type PhaseAccounting = {
 phase: string;
 readFiles: number;
 readCalls: number;
 readBytes: number;
 toolCalls: number;
 responseCalls: number;
 inputTokens: number;
 outputTokens: number;
 cacheReadTokens: number;
 cacheWriteTokens: number;
 totalTokens: number;
 toolOutputBytes: number;
 /** Short aliases used by compact receipts. */
 files: number;
 bytes: number;
 tokens: number;
};

/** Requested versus observed bounded-context usage. */
export type BudgetAccounting = {
 requested: BudgetLimits;
 readScope: ReadScopeLimit | null;
 mode: 'warn' | 'enforce';
 used: Omit<PhaseAccounting, 'phase'>;
 exceeded: boolean;
 exceededField: string | null;
 stopReason: string | null;
 largestReads: { toolCallId: string; toolName: string | null; path: string | null; bytes: number }[];
 phases: PhaseAccounting[];
};

/** Per-run output accounting: total raw stdout bytes, retained (compacted)
 * bytes, per-event-type raw byte counts, and the three largest tool results.
 * When a bounded contract supplies `budget` or `readScope`, the optional
 * `budget`/`phaseAccounting` fields report observed reads and model usage. */
export type OutputBreakdown = {
 rawBytes: number;
 retainedBytes: number;
 byType: Record<string, number>;
 largestToolResults: { toolCallId: string; toolName: string | null; bytes: number }[];
 budget?: BudgetAccounting;
 phaseAccounting?: PhaseAccounting[];
};

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
 /** True when a bounded-context limit stopped the worker before completion. */
 incomplete?: boolean;
 budgetExceeded?: boolean;
 scopeExceeded?: boolean;
 stopReason: string;
 /** The tool whose execution exceeded the per-tool limit, when the run stopped
  * on `tool_timeout`. `command` is the `tool_execution_start` `args.command`. */
 timedOutTool?: { name: string; command?: string };
 runtime: RuntimeSnapshot;
 outputBreakdown: OutputBreakdown;
 budget?: BudgetAccounting;
 phaseAccounting?: PhaseAccounting[];
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
 /** Environment for the spawned child; defaults to the current process env. */
 env?: NodeJS.ProcessEnv;
 /** Optional output cap override (bytes); defaults to DEFAULT_MAX_OUTPUT_BYTES. */
 maxOutputBytes?: number;
 onActivity?: (snapshot: RuntimeSnapshot) => void;
 /** Optional shared heartbeat so one runtime.json reflects every phase of the
  * whole run, not only the worker phase. */
 heartbeat?: RuntimeHeartbeat;
 /** Optional bounded-context budget. `enforce` stops the worker as soon as an
  * observed limit is crossed; `warn` records the overrun and continues. */
 budget?: BudgetLimits;
 /** Optional read boundary for read-like tool calls. */
 readScope?: ReadScopeLimit;
 /** Optional explicit context paths allowed by a `context-only` read scope. */
 contextPaths?: string[];
 /** Optional contract context entries; their paths are allowed by a
  * `context-only` read scope in addition to `readScope.paths`. */
 context?: Array<{ path?: string } | string>;
};

/** Split strict JSONL incrementally. Returns complete lines and leaves an
 * incomplete trailing fragment for the next chunk. */
export function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
 const text = buffer + chunk;
 const parts = text.split('\n');
 const rest = parts.pop() ?? '';
 return { lines: parts, rest };
}

/** A single tool result text block larger than this is replaced by its head and
 * tail plus an omission marker, with the full text written once beside the
 * events log. */
export const TOOL_TEXT_LIMIT_BYTES = 32 * 1024;
/** Bytes kept from each end of an oversized tool text block. */
export const TOOL_TEXT_KEEP_BYTES = 16 * 1024;

/** Restrict a tool call id to a safe flat filename. */
export function sanitizeToolCallId(id: string): string {
 const base = String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
 return base || 'unknown';
}

/** Replace oversized text blocks in a tool result content array with a head and
 * tail plus a marker, writing the full text once to the sidecar directory.
 * Returns true when at least one block was rewritten. */
function compactToolContent(container: any, toolCallId: string, outputDir: string, written: Set<string>): boolean {
 if (!container || typeof container !== 'object' || Array.isArray(container)) return false;
 const content = container.content;
 if (!Array.isArray(content)) return false;
 let changed = false;
 for (const block of content) {
  if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') continue;
  if (block.text.length <= TOOL_TEXT_LIMIT_BYTES) continue;
  const full = block.text;
  const sidecar = join(outputDir, `${toolCallId}.txt`);
  if (!written.has(toolCallId)) {
   try { mkdirSync(outputDir, { recursive: true }); writeFileSync(sidecar, full); written.add(toolCallId); }
   catch { /* the marker still points at the intended path */ }
  }
  const omitted = full.length - 2 * TOOL_TEXT_KEEP_BYTES;
  const marker = `[... ${omitted} bytes omitted; full text: tool-output/${toolCallId}.txt ...]`;
  block.text = `${full.slice(0, TOOL_TEXT_KEEP_BYTES)}\n${marker}\n${full.slice(full.length - TOOL_TEXT_KEEP_BYTES)}`;
  changed = true;
 }
 return changed;
}

/** Compact one raw stdout line for persistence. Returns the line to retain, or
 * null when the event is dropped entirely. Non-JSON and non-compacted lines are
 * returned verbatim so malformed-line detection still works. */
export function compactEventLine(rawLine: string, eventsPath: string, written: Set<string> = new Set()): string | null {
 let ev: any;
 try { ev = JSON.parse(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine); }
 catch { return rawLine; }
 if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return rawLine;
 const type = ev.type;
 if (type === 'message_update' || type === 'tool_execution_update') return null;
 if (type === 'turn_end') return JSON.stringify({ type: 'turn_end', toolResultCount: Array.isArray(ev.toolResults) ? ev.toolResults.length : 0 });
 if (type === 'agent_end') return JSON.stringify({ type: 'agent_end', willRetry: !!ev.willRetry, messageCount: Array.isArray(ev.messages) ? ev.messages.length : 0 });
 const outputDir = join(dirname(eventsPath), 'tool-output');
 if (type === 'tool_execution_end') {
  const toolCallId = sanitizeToolCallId(typeof ev.toolCallId === 'string' && ev.toolCallId ? ev.toolCallId : (typeof ev.toolName === 'string' ? ev.toolName : 'unknown'));
  return compactToolContent(ev.result, toolCallId, outputDir, written) ? JSON.stringify(ev) : rawLine;
 }
 if (type === 'message_end') {
  const m = ev.message;
  if (m && typeof m === 'object' && m.role === 'toolResult') {
   const rawId = typeof m.toolCallId === 'string' && m.toolCallId ? m.toolCallId : (typeof ev.toolCallId === 'string' ? ev.toolCallId : 'unknown');
   const toolCallId = sanitizeToolCallId(rawId);
   return compactToolContent(m, toolCallId, outputDir, written) ? JSON.stringify(ev) : rawLine;
  }
  return rawLine;
 }
 return rawLine;
}

/** Normalize a read path for deterministic scope matching. */
export function normalizeReadPath(path: unknown): string {
 return String(path ?? '').trim().replaceAll('\\','/').replace(/^\.\//,'').replace(/\/+$/,'');
}

/** Match one declared read path: exact file, directory prefix or simple glob. */
export function readPathMatches(pattern: string, candidate: string): boolean {
 const p = normalizeReadPath(pattern);
 const c = normalizeReadPath(candidate);
 if (!p || !c) return false;
 if (p === c) return true;
 if (!/[*?]/.test(p)) return c.startsWith(`${p}/`);
 let re = '^';
 for (let i = 0; i < p.length; i++) {
  const ch = p[i];
  if (ch === '*') { if (p[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*'; }
  else if (ch === '?') re += '[^/]';
  else if (/[\\^$.*+?()[\]{}|]/.test(ch)) re += '\\' + ch;
  else re += ch;
 }
 re += '$';
 try { return new RegExp(re).test(c); } catch { return false; }
}

const READ_TOOL_NAMES = new Set(['read','read_file','file_read','view','open','cat','head','tail','grep','rg','glob','list','ls','find','tree']);
/** True when a tool call is a read-like operation subject to the read scope. */
export function isReadLikeTool(name: string | null | undefined): boolean {
 return !!name && READ_TOOL_NAMES.has(String(name).toLowerCase());
}

/** Extract the path a read-like tool names in its arguments. */
export function readToolPath(ev: any): string | null {
 const args = ev?.args ?? ev?.arguments ?? ev?.message?.args ?? null;
 if (!args || typeof args !== 'object') return null;
 for (const key of ['path','file_path','filePath','file','filename','target','cwd']) {
  const value = (args as any)[key];
  if (typeof value === 'string' && value.trim()) return value;
 }
 return null;
}

function emptyPhaseAccounting(phase: string): PhaseAccounting {
 return { phase, readFiles:0, readCalls:0, readBytes:0, toolCalls:0, responseCalls:0,
  inputTokens:0, outputTokens:0, cacheReadTokens:0, cacheWriteTokens:0, totalTokens:0,
  toolOutputBytes:0, files:0, bytes:0, tokens:0 };
}

/** Execute a live Pi child with streaming persistence, heartbeat and bounds.
 * Always resolves with an inspectable result, even on startup error, malformed
 * or partial events, timeout, deadline breach or interruption. Completion is
 * driven by `close`, not `exit`, so trailing stdout/stderr bytes are never
 * dropped. A bounded contract (`budget`/`readScope`) is enforced from observed
 * events and its accounting is attached to `outputBreakdown`. */
export async function executeWorkerStreaming(opts: ExecuteWorkerOptions): Promise<WorkerStreamResult> {
 const { settings, spawnChild, command, args, cwd, eventsPath, logPath, runtimePath } = opts;
 const startedAt = Date.now();
 const heartbeat = opts.heartbeat ?? new RuntimeHeartbeat(runtimePath, settings, startedAt, opts.deadlineAt, opts.phase ?? 'worker');
 const watchdog = new ToolWatchdog();
 const maxOutputBytes = typeof opts.maxOutputBytes === 'number' && opts.maxOutputBytes > 0 ? opts.maxOutputBytes : (settings.maxOutputBytes > 0 ? settings.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES);
 // The retained cap bounds what is persisted; a much higher raw ceiling stops
 // a runaway stream that produces only dropped events.
 const maxRawOutputBytes = maxOutputBytes * 8;
 const writtenToolOutput = new Set<string>();
 heartbeat.update({ phase: opts.phase ?? 'worker' });
 if (!opts.heartbeat) heartbeat.begin();

 let stdout = '';
 let stderr = '';
 let pending = '';
 let rawStdoutBytes = 0;
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
 let timedOutTool: { name: string; command?: string } | undefined;
 const byType: Record<string, number> = {};
 const largestToolResults: { toolCallId: string; toolName: string | null; bytes: number }[] = [];
 let finished = false;
 let killTimer: ReturnType<typeof setTimeout> | undefined;
 let killEscalationComplete = false;
 let completionRequested = false;
 let child: ChildProcessLike | undefined;
 let monitor: ReturnType<typeof setInterval> | undefined;
 const budgetLimits = opts.budget;
 const readScope = opts.readScope ?? null;
 const readContextPaths = [
  ...(Array.isArray(opts.contextPaths) ? opts.contextPaths : []),
  ...(Array.isArray(opts.context) ? opts.context.map((entry) => typeof entry === 'string' ? entry : entry?.path ?? '') : []),
 ].filter((path): path is string => typeof path === 'string' && !!path.trim());
 const readAllowedPaths = readScope
  ? [...(Array.isArray(readScope.paths) ? readScope.paths : []), ...readContextPaths]
  : [];
 const budgetMode: 'warn' | 'enforce' = budgetLimits?.mode === 'warn' ? 'warn' : 'enforce';
 let budgetExceeded = false;
 let scopeExceeded = false;
 let exceededField: string | null = null;
 let readCalls = 0;
 let readBytes = 0;
 let toolCalls = 0;
 let responseCalls = 0;
 let inputTokens = 0;
 let outputTokens = 0;
 let cacheReadTokens = 0;
 let cacheWriteTokens = 0;
 let totalTokens = 0;
 const readFiles = new Set<string>();
 const readMeta = new Map<string, { toolName: string; path: string | null }>();
 const toolBytes = new Map<string, number>();
 const readBytesByCall = new Map<string, number>();
 let largestReads: { toolCallId: string; toolName: string | null; path: string | null; bytes: number }[] = [];
 const budgetPhase = opts.phase ?? 'worker';
 const boundedRequested = !!(budgetLimits || readScope);

 function sumValues(map: Map<string, number>): number {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
 }

 function phaseAccounting(): PhaseAccounting {
  const bytes = readBytes;
  const tokens = totalTokens;
  return { phase: budgetPhase, readFiles: readFiles.size, readCalls, readBytes: bytes,
   toolCalls, responseCalls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
   totalTokens: tokens, toolOutputBytes: sumValues(toolBytes), files: readFiles.size, bytes, tokens };
 }

 function budgetAccounting(): BudgetAccounting | undefined {
  if (!boundedRequested) return undefined;
  const used = phaseAccounting();
  const { phase: _phase, ...withoutPhase } = used;
  return { requested: budgetLimits ?? {}, readScope, mode: budgetMode, used: withoutPhase,
   exceeded: budgetExceeded || scopeExceeded, exceededField, stopReason: stopReason === 'budget' ? 'budget_exceeded' : stopReason === 'scope' ? 'needs_manager_scope' : null,
   largestReads: largestReads.slice(0, 3), phases: [used] };
 }

 function recordRead(toolCallId: string, toolName: string | null, path: string | null): void {
  if (!isReadLikeTool(toolName)) return;
  if (!readMeta.has(toolCallId)) {
   readMeta.set(toolCallId, { toolName: String(toolName), path });
   readCalls++;
   if (path) readFiles.add(normalizeReadPath(path));
   if (readScope) {
    const allowed = readAllowedPaths.some((pattern) => readPathMatches(pattern, path ?? ''));
    if (!allowed || !path) { scopeExceeded = true; if (!exceededField) exceededField = 'readScope'; requestStop('scope'); }
   }
  } else if (!readMeta.get(toolCallId)?.path && path) {
   const prior = readMeta.get(toolCallId)!;
   prior.path = path;
   readFiles.add(normalizeReadPath(path));
  }
 }

 function recordToolBytes(toolCallId: string, bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const prior = toolBytes.get(toolCallId) ?? 0;
  if (bytes > prior) toolBytes.set(toolCallId, bytes);
  const meta = readMeta.get(toolCallId);
  if (meta) {
   const priorRead = readBytesByCall.get(toolCallId) ?? 0;
   if (bytes > priorRead) { readBytes += bytes - priorRead; readBytesByCall.set(toolCallId, bytes); }
   const existing = largestReads.find((r) => r.toolCallId === toolCallId);
   const entry = { toolCallId, toolName: meta.toolName, path: meta.path, bytes: Math.max(priorRead, bytes) };
   if (existing) Object.assign(existing, entry); else largestReads.push(entry);
   largestReads.sort((a, b) => b.bytes - a.bytes);
   if (largestReads.length > 3) largestReads.length = 3;
  }
 }

 function addUsage(usage: any): void {
  if (!usage || typeof usage !== 'object') return;
  const n = (v: any) => typeof v === 'number' && Number.isFinite(v) ? v : 0;
  inputTokens += n(usage.input);
  outputTokens += n(usage.output);
  cacheReadTokens += n(usage.cacheRead);
  cacheWriteTokens += n(usage.cacheWrite);
  totalTokens += n(usage.totalTokens) || n(usage.input) + n(usage.output) + n(usage.cacheRead) + n(usage.cacheWrite);
 }

 function checkBudget(): void {
  if (!budgetLimits && !readScope) return;
  const fields: [keyof BudgetLimits, number][] = [
   ['maxInputTokens', inputTokens], ['maxFreshInputTokens', inputTokens],
   ['maxCacheReadTokens', cacheReadTokens], ['maxCachedInputTokens', cacheReadTokens + cacheWriteTokens],
   ['maxOutputTokens', outputTokens], ['maxTotalTokens', totalTokens || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens],
   ['maxToolCalls', toolCalls], ['maxToolOutputBytes', sumValues(toolBytes)], ['maxResponseCalls', responseCalls],
  ];
  for (const [field, value] of fields) {
   const limit = budgetLimits?.[field];
   if (typeof limit === 'number' && value > limit) {
    budgetExceeded = true;
    if (!exceededField) exceededField = String(field);
    if (budgetMode === 'enforce') requestStop('budget');
    break;
   }
  }
  if (readScope) {
   if (typeof readScope.maxFiles === 'number' && readFiles.size > readScope.maxFiles) {
    scopeExceeded = true; if (!exceededField) exceededField = 'readScope.maxFiles'; requestStop('scope');
   }
   if (typeof readScope.maxBytes === 'number' && readBytes > readScope.maxBytes) {
    scopeExceeded = true; if (!exceededField) exceededField = 'readScope.maxBytes'; requestStop('scope');
   }
  }
 }

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
  else if (stopReason === 'output_truncated') heartbeat.setState('failed', { stopReason: 'output_truncated', outputTruncated: true, exitCode, signal: exitSignal });
  else if (stopReason === 'budget') heartbeat.setState('failed', { stopReason: 'budget_exceeded', outputTruncated: true, budgetExceeded: true, incomplete: true, exitCode, signal: exitSignal });
  else if (stopReason === 'scope') heartbeat.setState('failed', { stopReason: 'needs_manager_scope', outputTruncated: true, scopeExceeded: true, incomplete: true, exitCode, signal: exitSignal });
  else heartbeat.setState(exitCode === 0 ? 'running' : 'failed', { stopReason: exitCode === 0 ? 'completed' : 'failed', exitCode, signal: exitSignal });
  const runtime = heartbeat.snapshot();
  const reason = runtime.stopReason ?? (exitCode === 0 ? 'completed' : 'failed');
  const accounting = budgetAccounting();
  const phases = accounting?.phases;
  resolveDone({ stdout, stderr, exitCode, signal: exitSignal, error: startupError, streamError, persistError, interrupted, timedOut, deadlineExceeded, outputTruncated,
   ...(stopReason === 'budget' || stopReason === 'scope' ? { incomplete: true } : {}),
   ...(budgetExceeded ? { budgetExceeded: true } : {}),
   ...(scopeExceeded ? { scopeExceeded: true } : {}),
   stopReason: reason, timedOutTool, runtime,
   outputBreakdown: { rawBytes: rawStdoutBytes, retainedBytes: stdout.length, byType, largestToolResults, ...(accounting ? { budget: accounting, phaseAccounting: phases } : {}) },
   ...(accounting ? { budget: accounting } : {}),
   ...(phases ? { phaseAccounting: phases } : {}) });
 }

 function requestStop(reason: StreamStopReason): void {
  if (stopReason) return;
  stopReason = reason;
  if (reason === 'tool_timeout') timedOut = true;
  else if (reason === 'deadline') deadlineExceeded = true;
  else if (reason === 'interrupt') interrupted = true;
  else if (reason === 'budget') { budgetExceeded = true; outputTruncated = true; }
  else if (reason === 'scope') { scopeExceeded = true; outputTruncated = true; }
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

 function trackBudgetEvent(ev: any): void {
  if (!ev || typeof ev !== 'object') return;
  const type = ev.type;
  const jsonBytesLocal = (v: any): number => { try { const text = JSON.stringify(v); return typeof text === 'string' ? text.length : 0; } catch { return 0; } };
  if (type === 'tool_execution_start') {
   toolCalls++;
   const id = typeof ev.toolCallId === 'string' && ev.toolCallId ? ev.toolCallId : 'unknown';
   const name = typeof ev.toolName === 'string' && ev.toolName ? ev.toolName : null;
   recordRead(id, name, readToolPath(ev));
  } else if (type === 'tool_execution_end') {
   const id = typeof ev.toolCallId === 'string' && ev.toolCallId ? ev.toolCallId : 'unknown';
   const name = typeof ev.toolName === 'string' && ev.toolName ? ev.toolName : null;
   recordRead(id, name, readToolPath(ev));
   recordToolBytes(id, jsonBytesLocal(ev.result));
  } else if (type === 'message_end') {
   const message = ev.message;
   if (message && typeof message === 'object' && message.role === 'assistant') {
    responseCalls++;
    addUsage(message.usage);
   }
   if (message && typeof message === 'object' && message.role === 'toolResult') {
    const id = typeof message.toolCallId === 'string' && message.toolCallId ? message.toolCallId : 'unknown';
    const name = typeof message.toolName === 'string' && message.toolName ? message.toolName : null;
    recordRead(id, name, readToolPath(ev));
    recordToolBytes(id, jsonBytesLocal(message));
   }
  }
  checkBudget();
 }

 function handleLine(line: string): void {
  const now = Date.now();
  let ev: any = null;
  if (line.trim()) { try { ev = JSON.parse(line.endsWith('\r') ? line.slice(0, -1) : line); } catch { ev = null; } }
  if (ev && typeof ev === 'object') { watchdog.onEvent(ev, now); trackBudgetEvent(ev); }
  heartbeat.activity(now, watchdog.currentTool());
  const longest = watchdog.longest(now);
  heartbeat.poll(now, watchdog.currentTool(), longest ? longest.elapsedMs : null);
  opts.onActivity?.(heartbeat.snapshot());
 }

 // Retain one compacted line under the cap and persist it, whole or not at all.
 // The cap is a stop condition: once a line cannot fit in the remaining budget
 // the process group is torn down exactly like a wall-deadline breach, so a
 // runaway child cannot keep producing after the cap and events.jsonl always
 // ends on a complete JSON line plus a newline.
 function retainStdout(line: string): void {
  const text = line + '\n';
  if (stdout.length + text.length > maxOutputBytes) { outputTruncated = true; requestStop('output_truncated'); return; }
  stdout += text;
  append(eventsPath, text);
 }

 const jsonBytes = (v: any): number => { const s = JSON.stringify(v); return typeof s === 'string' ? s.length : 0; };

 function recordToolResult(r: { toolCallId: string; toolName: string | null; bytes: number }): void {
  // A tool result arrives as tool_execution_end and as a toolResult message;
  // keep one entry per call with the larger size.
  const prior = largestToolResults.find((e) => e.toolCallId === r.toolCallId);
  if (prior) { if (r.bytes > prior.bytes) prior.bytes = r.bytes; if (!prior.toolName) prior.toolName = r.toolName; }
  else largestToolResults.push(r);
  largestToolResults.sort((a, b) => b.bytes - a.bytes);
  if (largestToolResults.length > 3) largestToolResults.length = 3;
 }

 // Account for every raw line, including dropped message_update and
 // tool_execution_update events, before compaction or retention.
 function recordBreakdown(rawLine: string): void {
  let ev: any;
  try { ev = JSON.parse(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine); }
  catch { return; }
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return;
  const type = typeof ev.type === 'string' ? ev.type : null;
  if (type) byType[type] = (byType[type] ?? 0) + rawLine.length;
  if (type === 'tool_execution_end') {
   const toolCallId = typeof ev.toolCallId === 'string' && ev.toolCallId ? ev.toolCallId : (typeof ev.toolName === 'string' ? ev.toolName : 'unknown');
   recordToolResult({ toolCallId, toolName: typeof ev.toolName === 'string' && ev.toolName ? ev.toolName : null, bytes: jsonBytes(ev.result) });
  } else if (type === 'message_end') {
   const m = ev.message;
   if (m && typeof m === 'object' && m.role === 'toolResult') {
    const toolCallId = typeof m.toolCallId === 'string' && m.toolCallId ? m.toolCallId : (typeof ev.toolCallId === 'string' ? ev.toolCallId : 'unknown');
    recordToolResult({ toolCallId, toolName: typeof m.toolName === 'string' && m.toolName ? m.toolName : null, bytes: jsonBytes(m) });
   }
  }
 }

 // Feed every raw line to the watchdog/heartbeat and breakdown, then persist
 // its compacted form. Dropped events (message_update, tool_execution_update)
 // are not kept.
 function processStdoutLine(rawLine: string): void {
  handleLine(rawLine);
  recordBreakdown(rawLine);
  const compacted = compactEventLine(rawLine, eventsPath, writtenToolOutput);
  if (compacted === null) return;
  retainStdout(compacted);
 }

 // Append up to the cap and report the accepted (possibly truncated) text.
 function pushOutput(kind: 'stdout' | 'stderr', text: string): string {
  const current = kind === 'stdout' ? stdout : stderr;
  if (current.length >= maxOutputBytes) { outputTruncated = true; requestStop('output_truncated'); return ''; }
  const remaining = maxOutputBytes - current.length;
  let accepted = text;
  if (accepted.length > remaining) { accepted = accepted.slice(0, remaining); outputTruncated = true; }
  if (kind === 'stdout') stdout += accepted; else stderr += accepted;
  append(kind === 'stdout' ? eventsPath : logPath, accepted);
  // The cap is a stop condition, not just a display bound: once output is
  // truncated the process group is torn down exactly like a wall-deadline
  // breach, so a runaway child cannot keep producing after the cap.
  if (outputTruncated) requestStop('output_truncated');
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
  if (pending.trim()) processStdoutLine(pending);
  finalize();
 }

 try {
  if (!opts.signal?.aborted) child = spawnChild(command, args, { cwd, env: opts.env });
 } catch (err: any) {
  startupError = err?.message || String(err);
  stopReason = 'startup_error';
 }

 if (child) {
  const stream = child;
  if (stream.stdout) {
   stream.stdout.on('data', (chunk: any) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    rawStdoutBytes += text.length;
    const split = splitLines(pending, text);
    pending = split.rest;
    for (const line of split.lines) processStdoutLine(line);
    if (!stopReason && rawStdoutBytes > maxRawOutputBytes) { outputTruncated = true; requestStop('output_truncated'); }
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
   if (expired) { timedOutTool = { name: expired.name, command: expired.command }; requestStop('tool_timeout'); }
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
