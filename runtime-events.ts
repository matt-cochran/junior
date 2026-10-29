// ---------------------------------------------------------------------------
// Runtime result types, event compaction and read-path helpers (ADR 0016).
//
// This module holds the public result and accounting shapes, JSONL splitting,
// tool-output compaction and the bounded read-scope matchers.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BudgetLimits, ExecutionSettings } from './runtime-settings.ts';
import type { RuntimeHeartbeat, RuntimePhase, RuntimeSnapshot } from './runtime-process.ts';

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

