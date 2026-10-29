// ---------------------------------------------------------------------------
// Execution settings and bounded-context budgets for the runtime (ADR 0016).
//
// This module holds the settings types and defaults plus the budget helpers.
// It has no imports so every later runtime module can depend on it.
// ---------------------------------------------------------------------------

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
