// ---------------------------------------------------------------------------
// Streaming worker execution for the runtime (ADR 0016).
//
// executeWorkerStreaming owns the child lifecycle, heartbeat, bounded output
// retention and accounting for one live Pi execution; its mutable state lives
// in one StreamRun shared by the helpers below.
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_MAX_OUTPUT_BYTES, KILL_GRACE_MS, type BudgetLimits, type ExecutionSettings, type StreamStopReason } from './runtime-settings.ts';
import { RuntimeHeartbeat, ToolWatchdog, killChildGroup, type ChildProcessLike } from './runtime-process.ts';
import {
 compactEventLine,
 isReadLikeTool,
 normalizeReadPath,
 readPathMatches,
 readToolPath,
 sanitizeToolCallId,
 splitLines,
 type BudgetAccounting,
 type ExecuteWorkerOptions,
 type PhaseAccounting,
 type ReadScopeLimit,
 type WorkerStreamResult,
} from './runtime-events.ts';

type ToolResultEntry = { toolCallId: string; toolName: string | null; bytes: number };
type ReadEntry = { toolCallId: string; toolName: string | null; path: string | null; bytes: number };

type StreamRun = {
 opts: ExecuteWorkerOptions;
 settings: ExecutionSettings;
 eventsPath: string;
 logPath: string;
 heartbeat: RuntimeHeartbeat;
 watchdog: ToolWatchdog;
 maxOutputBytes: number;
 maxRawOutputBytes: number;
 writtenToolOutput: Set<string>;
 stdout: string;
 stderr: string;
 pending: string;
 rawStdoutBytes: number;
 stopReason: StreamStopReason | null;
 timedOut: boolean;
 deadlineExceeded: boolean;
 interrupted: boolean;
 outputTruncated: boolean;
 startupError: string | undefined;
 streamError: string | undefined;
 persistError: string | undefined;
 exitCode: number | null;
 exitSignal: string | null;
 timedOutTool: { name: string; command?: string } | undefined;
 byType: Record<string, number>;
 largestToolResults: ToolResultEntry[];
 finished: boolean;
 killTimer: ReturnType<typeof setTimeout> | undefined;
 killEscalationComplete: boolean;
 completionRequested: boolean;
 child: ChildProcessLike | undefined;
 monitor: ReturnType<typeof setInterval> | undefined;
 budgetLimits: BudgetLimits | undefined;
 readScope: ReadScopeLimit | null;
 readAllowedPaths: string[];
 budgetMode: 'warn' | 'enforce';
 budgetExceeded: boolean;
 scopeExceeded: boolean;
 exceededField: string | null;
 readCalls: number;
 readBytes: number;
 toolCalls: number;
 responseCalls: number;
 inputTokens: number;
 outputTokens: number;
 cacheReadTokens: number;
 cacheWriteTokens: number;
 totalTokens: number;
 readFiles: Set<string>;
 readMeta: Map<string, { toolName: string; path: string | null }>;
 toolBytes: Map<string, number>;
 readBytesByCall: Map<string, number>;
 largestReads: ReadEntry[];
 budgetPhase: NonNullable<ExecuteWorkerOptions['phase']>;
 boundedRequested: boolean;
 resolveDone: (r: WorkerStreamResult) => void;
 onAbort: () => void;
};

function sumValues(map: Map<string, number>): number {
 let total = 0;
 for (const value of map.values()) total += value;
 return total;
}

function phaseAccounting(run: StreamRun): PhaseAccounting {
 const bytes = run.readBytes;
 const tokens = run.totalTokens;
 const { readCalls, toolCalls, responseCalls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = run;
 return { phase: run.budgetPhase, readFiles: run.readFiles.size, readCalls, readBytes: bytes,
  toolCalls, responseCalls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
  totalTokens: tokens, toolOutputBytes: sumValues(run.toolBytes), files: run.readFiles.size, bytes, tokens };
}

function budgetAccounting(run: StreamRun): BudgetAccounting | undefined {
 if (!run.boundedRequested) return undefined;
 const used = phaseAccounting(run);
 const { phase: _phase, ...withoutPhase } = used;
 const stopReason = run.stopReason;
 return { requested: run.budgetLimits ?? {}, readScope: run.readScope, mode: run.budgetMode, used: withoutPhase,
  exceeded: run.budgetExceeded || run.scopeExceeded, exceededField: run.exceededField, stopReason: stopReason === 'budget' ? 'budget_exceeded' : stopReason === 'scope' ? 'needs_manager_scope' : null,
  largestReads: run.largestReads.slice(0, 3), phases: [used] };
}

function recordRead(run: StreamRun, toolCallId: string, toolName: string | null, path: string | null): void {
 if (!isReadLikeTool(toolName)) return;
 if (!run.readMeta.has(toolCallId)) {
  run.readMeta.set(toolCallId, { toolName: String(toolName), path });
  run.readCalls++;
  if (path) run.readFiles.add(normalizeReadPath(path));
  if (run.readScope) {
   const allowed = run.readAllowedPaths.some((pattern) => readPathMatches(pattern, path ?? ''));
   if (!allowed || !path) { run.scopeExceeded = true; if (!run.exceededField) run.exceededField = 'readScope'; requestStop(run, 'scope'); }
  }
 } else if (!run.readMeta.get(toolCallId)?.path && path) {
  const prior = run.readMeta.get(toolCallId)!;
  prior.path = path;
  run.readFiles.add(normalizeReadPath(path));
 }
}

function recordToolBytes(run: StreamRun, toolCallId: string, bytes: number): void {
 if (!Number.isFinite(bytes) || bytes <= 0) return;
 const prior = run.toolBytes.get(toolCallId) ?? 0;
 if (bytes > prior) run.toolBytes.set(toolCallId, bytes);
 const meta = run.readMeta.get(toolCallId);
 if (meta) {
  const largestReads = run.largestReads;
  const priorRead = run.readBytesByCall.get(toolCallId) ?? 0;
  if (bytes > priorRead) { run.readBytes += bytes - priorRead; run.readBytesByCall.set(toolCallId, bytes); }
  const existing = largestReads.find((r) => r.toolCallId === toolCallId);
  const entry = { toolCallId, toolName: meta.toolName, path: meta.path, bytes: Math.max(priorRead, bytes) };
  if (existing) Object.assign(existing, entry); else largestReads.push(entry);
  largestReads.sort((a, b) => b.bytes - a.bytes);
  if (largestReads.length > 3) largestReads.length = 3;
 }
}

function addUsage(run: StreamRun, usage: any): void {
 if (!usage || typeof usage !== 'object') return;
 const n = (v: any) => typeof v === 'number' && Number.isFinite(v) ? v : 0;
 run.inputTokens += n(usage.input);
 run.outputTokens += n(usage.output);
 run.cacheReadTokens += n(usage.cacheRead);
 run.cacheWriteTokens += n(usage.cacheWrite);
 run.totalTokens += n(usage.totalTokens) || n(usage.input) + n(usage.output) + n(usage.cacheRead) + n(usage.cacheWrite);
}

function checkBudgetLimits(run: StreamRun): void {
 const { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, totalTokens, toolCalls, responseCalls } = run;
 const fields: [keyof BudgetLimits, number][] = [
  ['maxInputTokens', inputTokens], ['maxFreshInputTokens', inputTokens],
  ['maxCacheReadTokens', cacheReadTokens], ['maxCachedInputTokens', cacheReadTokens + cacheWriteTokens],
  ['maxOutputTokens', outputTokens], ['maxTotalTokens', totalTokens || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens],
  ['maxToolCalls', toolCalls], ['maxToolOutputBytes', sumValues(run.toolBytes)], ['maxResponseCalls', responseCalls],
 ];
 for (const [field, value] of fields) {
  const limit = run.budgetLimits?.[field];
  if (typeof limit === 'number' && value > limit) {
   run.budgetExceeded = true;
   if (!run.exceededField) run.exceededField = String(field);
   if (run.budgetMode === 'enforce') requestStop(run, 'budget');
   break;
  }
 }
}

function checkReadScopeLimits(run: StreamRun, readScope: ReadScopeLimit): void {
 if (typeof readScope.maxFiles === 'number' && run.readFiles.size > readScope.maxFiles) {
  run.scopeExceeded = true; if (!run.exceededField) run.exceededField = 'readScope.maxFiles'; requestStop(run, 'scope');
 }
 if (typeof readScope.maxBytes === 'number' && run.readBytes > readScope.maxBytes) {
  run.scopeExceeded = true; if (!run.exceededField) run.exceededField = 'readScope.maxBytes'; requestStop(run, 'scope');
 }
}

function checkBudget(run: StreamRun): void {
 if (!run.budgetLimits && !run.readScope) return;
 checkBudgetLimits(run);
 if (run.readScope) checkReadScopeLimits(run, run.readScope);
}

// Persist raw stdout/stderr immediately; a persistence failure is recorded but
// never aborts the run.
function appendCapture(run: StreamRun, path: string, text: string): void {
 try { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, text); }
 catch (e: any) { if (!run.persistError) run.persistError = e?.message || String(e); }
}

function applyFinalHeartbeat(run: StreamRun): void {
 const { heartbeat, exitCode, exitSignal } = run;
 switch (run.stopReason) {
  case 'interrupt': heartbeat.setState('interrupted', { interrupted: true, stopReason: 'interrupted', exitCode, signal: exitSignal }); break;
  case 'deadline': heartbeat.setState('deadline_exceeded', { deadlineExceeded: true, stopReason: 'deadline_exceeded', exitCode, signal: exitSignal }); break;
  case 'tool_timeout': heartbeat.setState('tool_timed_out', { timedOut: true, stopReason: 'tool_timed_out', exitCode, signal: exitSignal }); break;
  case 'startup_error': heartbeat.setState('failed', { error: run.startupError, stopReason: 'failed', exitCode, signal: exitSignal }); break;
  case 'stream_error': heartbeat.setState('failed', { error: run.streamError, stopReason: 'failed', exitCode, signal: exitSignal }); break;
  case 'output_truncated': heartbeat.setState('failed', { stopReason: 'output_truncated', outputTruncated: true, exitCode, signal: exitSignal }); break;
  case 'budget': heartbeat.setState('failed', { stopReason: 'budget_exceeded', outputTruncated: true, budgetExceeded: true, incomplete: true, exitCode, signal: exitSignal } as any); break;
  case 'scope': heartbeat.setState('failed', { stopReason: 'needs_manager_scope', outputTruncated: true, scopeExceeded: true, incomplete: true, exitCode, signal: exitSignal } as any); break;
  default: heartbeat.setState(exitCode === 0 ? 'running' : 'failed', { stopReason: exitCode === 0 ? 'completed' : 'failed', exitCode, signal: exitSignal });
 }
}

function buildStreamResult(run: StreamRun): WorkerStreamResult {
 const { stdout, stderr, exitCode, exitSignal, stopReason, budgetExceeded, scopeExceeded } = run;
 const runtime = run.heartbeat.snapshot();
 const reason = runtime.stopReason ?? (exitCode === 0 ? 'completed' : 'failed');
 const accounting = budgetAccounting(run);
 const phases = accounting?.phases;
 return { stdout, stderr, exitCode, signal: exitSignal, error: run.startupError, streamError: run.streamError, persistError: run.persistError, interrupted: run.interrupted, timedOut: run.timedOut, deadlineExceeded: run.deadlineExceeded, outputTruncated: run.outputTruncated,
  ...(stopReason === 'budget' || stopReason === 'scope' ? { incomplete: true } : {}),
  ...(budgetExceeded ? { budgetExceeded: true } : {}),
  ...(scopeExceeded ? { scopeExceeded: true } : {}),
  stopReason: reason, timedOutTool: run.timedOutTool, runtime,
  outputBreakdown: { rawBytes: run.rawStdoutBytes, retainedBytes: stdout.length, byType: run.byType, largestToolResults: run.largestToolResults, ...(accounting ? { budget: accounting, phaseAccounting: phases } : {}) },
  ...(accounting ? { budget: accounting } : {}),
  ...(phases ? { phaseAccounting: phases } : {}) } as WorkerStreamResult;
}

function finalize(run: StreamRun): void {
 if (run.finished) return;
 run.completionRequested = true;
 if (run.killTimer && !run.killEscalationComplete) return;
 run.finished = true;
 if (run.monitor) clearInterval(run.monitor);
 // The kill-escalation timer is deliberately NOT cleared on direct child exit:
 // a descendant that ignores SIGTERM must still receive the bounded SIGKILL.
 run.opts.signal?.removeEventListener?.('abort', run.onAbort);
 applyFinalHeartbeat(run);
 run.resolveDone(buildStreamResult(run));
}

function requestStop(run: StreamRun, reason: StreamStopReason): void {
 if (run.stopReason) return;
 run.stopReason = reason;
 if (reason === 'tool_timeout') run.timedOut = true;
 else if (reason === 'deadline') run.deadlineExceeded = true;
 else if (reason === 'interrupt') run.interrupted = true;
 else if (reason === 'budget') { run.budgetExceeded = true; run.outputTruncated = true; }
 else if (reason === 'scope') { run.scopeExceeded = true; run.outputTruncated = true; }
 if (run.child) {
  killChildGroup(run.child, 'SIGTERM');
  run.killTimer = setTimeout(() => { if (run.child) killChildGroup(run.child, 'SIGKILL'); run.killEscalationComplete = true; if (run.completionRequested) finalize(run); }, KILL_GRACE_MS);
 }
 if (reason === 'startup_error' || reason === 'stream_error') finalize(run);
}

const jsonBytesLocal = (v: any): number => { try { const text = JSON.stringify(v); return typeof text === 'string' ? text.length : 0; } catch { return 0; } };

function trackToolResultMessage(run: StreamRun, ev: any, message: any): void {
 const id = typeof message.toolCallId === 'string' && message.toolCallId ? message.toolCallId : 'unknown';
 const name = typeof message.toolName === 'string' && message.toolName ? message.toolName : null;
 recordRead(run, id, name, readToolPath(ev));
 recordToolBytes(run, id, jsonBytesLocal(message));
}

function trackBudgetEvent(run: StreamRun, ev: any): void {
 if (!ev || typeof ev !== 'object') return;
 const type = ev.type;
 if (type === 'tool_execution_start') {
  run.toolCalls++;
  const id = typeof ev.toolCallId === 'string' && ev.toolCallId ? ev.toolCallId : 'unknown';
  const name = typeof ev.toolName === 'string' && ev.toolName ? ev.toolName : null;
  recordRead(run, id, name, readToolPath(ev));
 } else if (type === 'tool_execution_end') {
  const id = typeof ev.toolCallId === 'string' && ev.toolCallId ? ev.toolCallId : 'unknown';
  const name = typeof ev.toolName === 'string' && ev.toolName ? ev.toolName : null;
  recordRead(run, id, name, readToolPath(ev));
  recordToolBytes(run, id, jsonBytesLocal(ev.result));
 } else if (type === 'message_end') {
  const message = ev.message;
  if (message && typeof message === 'object' && message.role === 'assistant') {
   run.responseCalls++;
   addUsage(run, message.usage);
  }
  if (message && typeof message === 'object' && message.role === 'toolResult') trackToolResultMessage(run, ev, message);
 }
 checkBudget(run);
}

function handleLine(run: StreamRun, line: string): void {
 const { watchdog, heartbeat } = run;
 const now = Date.now();
 let ev: any = null;
 if (line.trim()) { try { ev = JSON.parse(line.endsWith('\r') ? line.slice(0, -1) : line); } catch { ev = null; } }
 if (ev && typeof ev === 'object') { watchdog.onEvent(ev, now); trackBudgetEvent(run, ev); }
 heartbeat.activity(now, watchdog.currentTool());
 const longest = watchdog.longest(now);
 heartbeat.poll(now, watchdog.currentTool(), longest ? longest.elapsedMs : null);
 run.opts.onActivity?.(heartbeat.snapshot());
}

// Retain one compacted line under the cap and persist it, whole or not at all.
// The cap is a stop condition: once a line cannot fit in the remaining budget
// the process group is torn down exactly like a wall-deadline breach, so a
// runaway child cannot keep producing after the cap and events.jsonl always
// ends on a complete JSON line plus a newline.
function retainStdout(run: StreamRun, line: string): void {
 const text = line + '\n';
 if (run.stdout.length + text.length > run.maxOutputBytes) { run.outputTruncated = true; requestStop(run, 'output_truncated'); return; }
 run.stdout += text;
 appendCapture(run, run.eventsPath, text);
}

const jsonBytes = (v: any): number => { const s = JSON.stringify(v); return typeof s === 'string' ? s.length : 0; };

function recordToolResult(run: StreamRun, r: ToolResultEntry): void {
 const largestToolResults = run.largestToolResults;
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
function recordBreakdown(run: StreamRun, rawLine: string): void {
 let ev: any;
 try { ev = JSON.parse(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine); }
 catch { return; }
 if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return;
 const type = typeof ev.type === 'string' ? ev.type : null;
 if (type) run.byType[type] = (run.byType[type] ?? 0) + rawLine.length;
 if (type === 'tool_execution_end') {
  const toolCallId = typeof ev.toolCallId === 'string' && ev.toolCallId ? ev.toolCallId : (typeof ev.toolName === 'string' ? ev.toolName : 'unknown');
  recordToolResult(run, { toolCallId, toolName: typeof ev.toolName === 'string' && ev.toolName ? ev.toolName : null, bytes: jsonBytes(ev.result) });
 } else if (type === 'message_end') {
  const m = ev.message;
  if (m && typeof m === 'object' && m.role === 'toolResult') {
   const toolCallId = typeof m.toolCallId === 'string' && m.toolCallId ? m.toolCallId : (typeof ev.toolCallId === 'string' ? ev.toolCallId : 'unknown');
   recordToolResult(run, { toolCallId, toolName: typeof m.toolName === 'string' && m.toolName ? m.toolName : null, bytes: jsonBytes(m) });
  }
 }
}

// Feed every raw line to the watchdog/heartbeat and breakdown, then persist
// its compacted form. Dropped events (message_update, tool_execution_update)
// are not kept.
function processStdoutLine(run: StreamRun, rawLine: string): void {
 handleLine(run, rawLine);
 recordBreakdown(run, rawLine);
 const compacted = compactEventLine(rawLine, run.eventsPath, run.writtenToolOutput);
 if (compacted === null) return;
 retainStdout(run, compacted);
}

// Append up to the cap and report the accepted (possibly truncated) text.
function pushOutput(run: StreamRun, kind: 'stdout' | 'stderr', text: string): string {
 const current = kind === 'stdout' ? run.stdout : run.stderr;
 if (current.length >= run.maxOutputBytes) { run.outputTruncated = true; requestStop(run, 'output_truncated'); return ''; }
 const remaining = run.maxOutputBytes - current.length;
 let accepted = text;
 if (accepted.length > remaining) { accepted = accepted.slice(0, remaining); run.outputTruncated = true; }
 if (kind === 'stdout') run.stdout += accepted; else run.stderr += accepted;
 appendCapture(run, kind === 'stdout' ? run.eventsPath : run.logPath, accepted);
 // The cap is a stop condition, not just a display bound: once output is
 // truncated the process group is torn down exactly like a wall-deadline
 // breach, so a runaway child cannot keep producing after the cap.
 if (run.outputTruncated) requestStop(run, 'output_truncated');
 return accepted;
}

function onStdoutData(run: StreamRun, chunk: any): void {
 const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
 run.rawStdoutBytes += text.length;
 const split = splitLines(run.pending, text);
 run.pending = split.rest;
 for (const line of split.lines) processStdoutLine(run, line);
 if (!run.stopReason && run.rawStdoutBytes > run.maxRawOutputBytes) { run.outputTruncated = true; requestStop(run, 'output_truncated'); }
}

function onChildError(run: StreamRun, err: Error): void {
 run.startupError = err?.message || String(err);
 if (run.child) { requestStop(run, 'startup_error'); return; }
 run.stopReason = 'startup_error';
 finalize(run);
}

function onClose(run: StreamRun, code: number | null, signal: string | null): void {
 if (run.exitCode === null && code !== undefined) run.exitCode = code ?? null;
 if (run.exitSignal === null && signal) run.exitSignal = signal;
 if (run.pending.trim()) processStdoutLine(run, run.pending);
 finalize(run);
}

// Monitor for tool timeouts and the wall deadline. Quiet is reported by the
// heartbeat but is explicitly not a stop condition.
function monitorTick(run: StreamRun): void {
 const { watchdog } = run;
 const now = Date.now();
 const longest = watchdog.longest(now);
 run.heartbeat.poll(now, watchdog.currentTool(), longest ? longest.elapsedMs : null);
 if (run.stopReason) return;
 const expired = watchdog.expired(now, run.settings.toolTimeoutMs);
 if (expired) { run.timedOutTool = { name: expired.name, command: expired.command }; requestStop(run, 'tool_timeout'); }
 else if (now >= run.opts.deadlineAt) requestStop(run, 'deadline');
}

function attachStreamChild(run: StreamRun, stream: ChildProcessLike): void {
 const onStreamError = (err: Error): void => {
  if (!run.streamError) run.streamError = err?.message || String(err);
  requestStop(run, 'stream_error');
 };
 if (stream.stdout) {
  stream.stdout.on('data', (chunk: any) => onStdoutData(run, chunk));
  stream.stdout.on?.('error', onStreamError);
 }
 if (stream.stderr) {
  stream.stderr.on('data', (chunk: any) => { pushOutput(run, 'stderr', typeof chunk === 'string' ? chunk : chunk.toString('utf8')); });
  stream.stderr.on?.('error', onStreamError);
 }
 stream.on('error', (err: Error) => onChildError(run, err));
 stream.on('exit', (code: number | null, signal: string | null) => {
  run.exitCode = code ?? null;
  run.exitSignal = signal ?? null;
 });
 stream.on('close', (code: number | null, signal: string | null) => onClose(run, code, signal));
 run.monitor = setInterval(() => monitorTick(run), 25);
}

function readAllowedPathsFor(opts: ExecuteWorkerOptions, readScope: ReadScopeLimit | null): string[] {
 const readContextPaths = [
  ...(Array.isArray(opts.contextPaths) ? opts.contextPaths : []),
  ...(Array.isArray(opts.context) ? opts.context.map((entry) => typeof entry === 'string' ? entry : entry?.path ?? '') : []),
 ].filter((path): path is string => typeof path === 'string' && !!path.trim());
 return readScope
  ? [...(Array.isArray(readScope.paths) ? readScope.paths : []), ...readContextPaths]
  : [];
}

function createStreamRun(
 opts: ExecuteWorkerOptions,
 heartbeat: RuntimeHeartbeat,
 maxOutputBytes: number,
 resolveDone: (r: WorkerStreamResult) => void,
): StreamRun {
 const budgetLimits = opts.budget;
 const readScope = opts.readScope ?? null;
 const run: StreamRun = {
  opts, settings: opts.settings, eventsPath: opts.eventsPath, logPath: opts.logPath,
  heartbeat, watchdog: new ToolWatchdog(), maxOutputBytes,
  // The retained cap bounds what is persisted; a much higher raw ceiling stops
  // a runaway stream that produces only dropped events.
  maxRawOutputBytes: maxOutputBytes * 8,
  writtenToolOutput: new Set<string>(),
  stdout: '', stderr: '', pending: '', rawStdoutBytes: 0, stopReason: null,
  timedOut: false, deadlineExceeded: false, interrupted: false, outputTruncated: false,
  startupError: undefined, streamError: undefined, persistError: undefined,
  exitCode: null, exitSignal: null, timedOutTool: undefined,
  byType: {}, largestToolResults: [],
  finished: false, killTimer: undefined, killEscalationComplete: false, completionRequested: false,
  child: undefined, monitor: undefined,
  budgetLimits, readScope, readAllowedPaths: readAllowedPathsFor(opts, readScope),
  budgetMode: budgetLimits?.mode === 'warn' ? 'warn' : 'enforce',
  budgetExceeded: false, scopeExceeded: false, exceededField: null,
  readCalls: 0, readBytes: 0, toolCalls: 0, responseCalls: 0,
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
  readFiles: new Set<string>(), readMeta: new Map(), toolBytes: new Map(), readBytesByCall: new Map(),
  largestReads: [],
  budgetPhase: opts.phase ?? 'worker',
  boundedRequested: !!(budgetLimits || readScope),
  resolveDone,
  onAbort: () => { run.interrupted = true; requestStop(run, 'interrupt'); },
 };
 return run;
}

/** Execute a live Pi child with streaming persistence, heartbeat and bounds.
 * Always resolves with an inspectable result, even on startup error, malformed
 * or partial events, timeout, deadline breach or interruption. Completion is
 * driven by `close`, not `exit`, so trailing stdout/stderr bytes are never
 * dropped. A bounded contract (`budget`/`readScope`) is enforced from observed
 * events and its accounting is attached to `outputBreakdown`. */
export async function executeWorkerStreaming(opts: ExecuteWorkerOptions): Promise<WorkerStreamResult> {
 const { settings, spawnChild, command, args, cwd, eventsPath, logPath, runtimePath } = opts;
 const captureStdoutPath = `${eventsPath}.stdout`;
 const captureStderrPath = `${logPath}.stderr`;
 const startedAt = Date.now();
 const heartbeat = opts.heartbeat ?? new RuntimeHeartbeat(runtimePath, settings, startedAt, opts.deadlineAt, opts.phase ?? 'worker');
 const maxOutputBytes = typeof opts.maxOutputBytes === 'number' && opts.maxOutputBytes > 0 ? opts.maxOutputBytes : (settings.maxOutputBytes > 0 ? settings.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES);
 heartbeat.update({ phase: opts.phase ?? 'worker' });
 if (!opts.heartbeat) heartbeat.begin();

 let resolveDone!: (r: WorkerStreamResult) => void;
 const done = new Promise<WorkerStreamResult>((res) => { resolveDone = res; });
 const run = createStreamRun(opts, heartbeat, maxOutputBytes, resolveDone);

 // Both files are created up front so a startup failure still leaves an
 // inspectable events.jsonl / worker.log pair.
 appendCapture(run, eventsPath, '');
 appendCapture(run, logPath, '');

 if (opts.signal) {
  if (opts.signal.aborted) run.onAbort();
  else opts.signal.addEventListener?.('abort', run.onAbort);
 }

 try {
  if (!opts.signal?.aborted) run.child = spawnChild(command, args, { cwd, env: opts.env, stdoutPath: captureStdoutPath, stderrPath: captureStderrPath });
 } catch (err: any) {
  run.startupError = err?.message || String(err);
  run.stopReason = 'startup_error';
 }

 if (run.child) {
  attachStreamChild(run, run.child);
 } else {
  if (!run.stopReason) { run.startupError = 'worker did not start'; run.stopReason = 'startup_error'; }
  finalize(run);
 }

 return done;
}
