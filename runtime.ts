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
// This file is a re-export facade; the implementation lives in
// runtime-settings.ts, runtime-process.ts, runtime-events.ts and
// runtime-stream.ts (ADR 0016).

export {
  EXECUTION_DEFAULTS,
  EXECUTION_BOUNDS,
  EXECUTION_FIELDS,
  resolveExecutionSettings,
  validateExecutionSettings,
  KILL_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  REPORT_WORKFLOW_BUDGET,
  defaultWorkflowBudget,
  effectiveBudget,
} from './runtime-settings.ts';
export type { ExecutionSettings, BudgetLimits } from './runtime-settings.ts';

export {
  RuntimeHeartbeat,
  ToolWatchdog,
  spawnChildDetached,
  killChildGroup,
  executeCheck,
  isSuccessStatus,
} from './runtime-process.ts';
export type {
  RuntimeState,
  RuntimePhase,
  RuntimeSnapshot,
  ProgressSink,
  ChildProcessLike,
  SpawnChild,
  CheckResult,
  ExecuteCheckOptions,
} from './runtime-process.ts';

export {
  splitLines,
  TOOL_TEXT_LIMIT_BYTES,
  TOOL_TEXT_KEEP_BYTES,
  sanitizeToolCallId,
  compactEventLine,
  normalizeReadPath,
  readPathMatches,
  isReadLikeTool,
  readToolPath,
} from './runtime-events.ts';
export type {
  ReadScopeLimit,
  PhaseAccounting,
  BudgetAccounting,
  OutputBreakdown,
  WorkerStreamResult,
  ExecuteWorkerOptions,
} from './runtime-events.ts';

export { executeWorkerStreaming } from './runtime-stream.ts';
