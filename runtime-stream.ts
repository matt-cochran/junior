// ---------------------------------------------------------------------------
// Streaming worker execution for the runtime (ADR 0016).
//
// executeWorkerStreaming is kept whole: it owns the child lifecycle, heartbeat,
// bounded output retention and accounting for one live Pi execution.
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_MAX_OUTPUT_BYTES, KILL_GRACE_MS, type BudgetLimits, type StreamStopReason } from './runtime-settings.ts';
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
 type WorkerStreamResult,
} from './runtime-events.ts';

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

