// ---------------------------------------------------------------------------
// Compact manager handoff projection.
//
// The full result.json is large (receipt, evidence, events, gate records). A
// manager usually wants one small, stable object: outcome, where it ran, what
// changed, which checks failed, the model/token totals, the honest cost and the
// runtime stop reason. `compactHandoff` builds exactly that. Full detail stays
// in the artifacts (`events.jsonl`, `worker.log`, `runtime.json`,
// `evidence.json`, `result.json`) and is available through `status --full`.
//
// Repeated per-event stop reasons are deduplicated into a small summary so the
// compact handoff never dumps one entry per emitted event.
// ---------------------------------------------------------------------------

import { join } from 'node:path';

export type HandoffArtifacts = {
 result: string | null;
 events: string | null;
 workerLog: string | null;
 runtime: string | null;
 evidence: string | null;
 /** Deterministic analysis report path for analysis-only workflows, else null. */
 report: string | null;
};

export type CompactHandoff = {
 attention: {target:string; decision:string; reason:string; probability:number|null; mode:string; workerBlocked:boolean} | null;
 id: string;
 outcome: string;
 source: string;
 /** Requested source checkout (the task `cwd`), preserved even when execution
  * happened in an isolated worktree. */
 sourceCwd: string | null;
 execution: { cwd: string | null; artifact: string | null; isolation: string };
 artifact: string | null;
 changedFiles: string[];
 checks: { command: string; exitCode: number | null; passed: boolean; error?: string }[];
 unresolved: string[];
 model: {
  requested: { provider: string; model: string } | null;
  observed: { provider: string; model: string }[];
  observedUnknown: boolean;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usageAvailable: boolean;
  /** Provider response IDs preserved by Pi (OpenRouter generation IDs). The
   * handle for obtaining authoritative provider billing. When the task opts in
   * to bounded billing capture the worker fetches the matching generation and
   * sets `cost.billedUsd`. */
  responseIds: string[];
  cost: {
   /** One compact amount chosen by preference: authoritative captured provider
    * billing, then a finite Pi-reported total, then a configured estimate. */
   amountUsd: number | null;
   /** Which source produced `amountUsd`; `pi_reported` is a Pi catalog estimate,
    * never a provider bill. */
   source: 'provider' | 'pi_reported' | 'estimate' | null;
   available: boolean;
   estimatedUsd: number | null;
   billedUsd: number | null;
   piReportedTotal: number | null;
   unknownReason?: string;
   /** Concise reason an opted-in authoritative provider bill is unavailable. */
   billingReason?: string;
  };
 };
 runtime: {
  state: string | null;
  stopReason: string | null;
  elapsedMs: number | null;
  deadlineMs: number | null;
  quietMs: number | null;
  toolTimeoutMs: number | null;
  heartbeatMs: number | null;
  interrupted: boolean;
  timedOut: boolean;
  deadlineExceeded: boolean;
  stopReasonSummary: string[];
 };
 /** Analysis-only handback detail: the required report path and whether it was
  * present. Null for implementation workflows. */
 analysis: {
  workflow: string;
  report: string | null;
  reportPresent: boolean;
 } | null;
 /** Report-only QA review detail: the subject result and the grounded context
  * artifact. Null for non-QA workflows. */
 review: {
  from: string;
  priorResult: any;
  context: string | null;
 } | null;
 artifacts: HandoffArtifacts;
};

function artifactPaths(dir: string | null, report: string | null = null): HandoffArtifacts {
 if (!dir) return { result: null, events: null, workerLog: null, runtime: null, evidence: null, report };
 return {
  result: join(dir, 'result.json'),
  events: join(dir, 'events.jsonl'),
  workerLog: join(dir, 'worker.log'),
  runtime: join(dir, 'runtime.json'),
  evidence: join(dir, 'evidence.json'),
  report,
 };
}

/** Deduplicate event stop reasons into a short, stable summary. */
export function stopReasonSummary(receipt: any): string[] {
 const raw = Array.isArray(receipt?.stopReasons) ? receipt.stopReasons : [];
 const seen: string[] = [];
 for (const r of raw) { const s = String(r); if (!seen.includes(s)) seen.push(s); }
 return seen;
}

/** Actionable, human-readable unresolved issues from an otherwise final result. */
export function unresolvedIssues(result: any): string[] {
 const out: string[] = [];
 if (result?.workerError) out.push(String(result.workerError));
 for (const check of Array.isArray(result?.checks) ? result.checks : []) {
  if (check.exitCode !== 0 || check.error || check.timedOut || check.outputTruncated) out.push(`check failed: ${[check.command, ...(check.args || [])].join(' ')}${check.error ? ': ' + check.error : ''}`);
 }
 const post = result?.jev?.postflight;
 if (post?.gapIds?.length) out.push(`acceptance gaps: ${post.gapIds.join(', ')}`);
 if (post?.uncertainIds?.length) out.push(`uncertain acceptance: ${post.uncertainIds.join(', ')}`);
 if (result?.receipt?.malformed) out.push(`malformed event lines: ${(result.receipt.malformedLines || []).join(', ')}`);
 if (result?.runtime?.timedOut) out.push('tool execution timed out');
 if (result?.runtime?.deadlineExceeded) out.push('total wall deadline exceeded');
 if (result?.runtime?.interrupted) out.push('run interrupted by signal');
 if (result?.resume?.error) out.push(`resume: ${result.resume.error}`);
 if (result?.lineage?.rejected) out.push('repair rejected by lineage budget');
 if (result?.analysis && result.analysis.reportPresent === false) out.push(`analysis report missing: ${result.analysis.report ?? 'unknown path'}`);
 return out;
}

/** Whether a status counts as a successful handback. */
export function isSuccessOutcome(outcome: string | null | undefined): boolean {
 return outcome === 'ready_for_review' || outcome === 'simulation_passed';
}

/** A finite, nonnegative USD amount, else null (unknown). */
function finiteUsd(v: any): number | null {
 return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** One compact, truthfully-labelled cost. Prefer an authoritative captured
 * provider bill, then a finite Pi-reported total (including a reported zero),
 * then an independently configured pricing estimate. Pi's catalog cost is never
 * labelled as provider billing. Legacy fields stay present for compatibility. */
export function compactCost(r: any): CompactHandoff['model']['cost'] {
 const providerUsd = finiteUsd(r?.cost?.billedUsd);
 // `cost.piReported` is the projected copy; fall back to the raw receipt so a
 // result written before the cost projection still reports a finite Pi total.
 const piReported = r?.cost?.piReported ?? r?.receipt?.usage?.cost;
 const piTotal = r?.cost?.piReportedTotal ?? piReported?.total ?? null;
 const piUsd = piReported?.available === true ? finiteUsd(piTotal) : null;
 const estimateUsd = finiteUsd(r?.cost?.estimatedUsd);

 let amountUsd: number | null = null;
 let source: 'provider' | 'pi_reported' | 'estimate' | null = null;
 if (providerUsd !== null) { amountUsd = providerUsd; source = 'provider'; }
 else if (piUsd !== null) { amountUsd = piUsd; source = 'pi_reported'; }
 else if (estimateUsd !== null) { amountUsd = estimateUsd; source = 'estimate'; }

 const out: CompactHandoff['model']['cost'] = {
  amountUsd,
  source,
  available: amountUsd !== null,
  estimatedUsd: estimateUsd,
  billedUsd: providerUsd,
  piReportedTotal: typeof piTotal === 'number' ? piTotal : null,
 };
 if (r?.cost?.billingReason) out.billingReason = String(r.cost.billingReason);
 if (amountUsd === null) {
  const missing: string[] = [];
  if (providerUsd === null) missing.push(r?.cost?.billingReason ? `missing upstream billing: ${r.cost.billingReason}` : 'missing upstream billing');
  if (piUsd === null) missing.push('missing Pi pricing');
  if (estimateUsd === null) missing.push(r?.cost?.unknownReason ? String(r.cost.unknownReason) : 'no configured pricing estimate');
  out.unknownReason = missing.join('; ');
 }
 return out;
}

/** Build the compact handoff from a full worker result. */
export function compactHandoff(result: any): CompactHandoff {
 const r = result || {};
 const dir = typeof r.artifactDir === 'string' && r.artifactDir ? r.artifactDir : null;
 const evidenceChanged = r.evidence?.runChangedFiles ?? r.evidence?.changedFiles ?? [];
 const changedFiles = (Array.isArray(evidenceChanged) ? evidenceChanged : [])
  .map((f: any) => (typeof f === 'string' ? f : f?.path))
  .filter((p: any) => typeof p === 'string');
 const cost = compactCost(r);
 const report = typeof r.analysis?.report === 'string' ? r.analysis.report : null;
 const analysis = r.analysis && typeof r.analysis === 'object' ? {
  workflow: String(r.analysis.workflow ?? ''),
  report,
  reportPresent: !!r.analysis.reportPresent,
 } : null;
 const review = r.review && typeof r.review === 'object' ? {
  from: String(r.review.from ?? ''),
  priorResult: r.review.priorResult ?? null,
  context: typeof r.review.context === 'string' ? r.review.context : null,
 } : null;
 return {
  ...(r.handoff ? {handoff:r.handoff} : {}),
  id: String(r.id ?? 'unknown'),
  outcome: String(r.status ?? r.outcome ?? 'unknown'),
  attention: r.jev?.preflight?.attention ? {...r.jev.preflight.attention, mode:r.jev.mode, workerBlocked:r.jev.enforced === true && r.workerExitCode === null} : null,
  source: r.simulated ? 'mock' : (r.receipt?.source ?? 'pi_message_end'),
  sourceCwd: r.sourceCwd ?? null,
  execution: {
   cwd: r.executionCwd ?? r.sourceCwd ?? null,
   artifact: dir,
   isolation: r.isolation?.mode ?? 'none',
  },
  artifact: dir,
  changedFiles,
  checks: (Array.isArray(r.checks) ? r.checks : []).map((c: any) => ({
   command: [c?.command, ...(Array.isArray(c?.args) ? c.args : [])].filter(Boolean).join(' '),
   exitCode: c?.exitCode ?? null,
   passed: c?.exitCode === 0 && !c?.error && !c?.timedOut && !c?.outputTruncated,
   ...(c?.error ? { error: String(c.error) } : {}),
  })),
  unresolved: unresolvedIssues(r),
  model: {
   requested: r.receipt?.requested ?? null,
   observed: Array.isArray(r.receipt?.observed) ? r.receipt.observed : [],
   observedUnknown: r.receipt?.observedUnknown ?? true,
   tokens: r.receipt?.usage?.totalTokens ?? 0,
   input: r.receipt?.usage?.input ?? 0,
   output: r.receipt?.usage?.output ?? 0,
   cacheRead: r.receipt?.usage?.cacheRead ?? 0,
   cacheWrite: r.receipt?.usage?.cacheWrite ?? 0,
   usageAvailable: r.receipt?.usage?.available ?? false,
   responseIds: Array.isArray(r.receipt?.responseIds) ? r.receipt.responseIds : [],
   cost,
  },
  runtime: {
   state: r.runtime?.state ?? null,
   stopReason: r.runtime?.stopReason ?? null,
   elapsedMs: r.runtime?.elapsedMs ?? null,
   deadlineMs: r.runtime?.deadlineMs ?? null,
   quietMs: r.runtime?.quietMs ?? null,
   toolTimeoutMs: r.runtime?.toolTimeoutMs ?? null,
   heartbeatMs: r.runtime?.heartbeatMs ?? null,
   interrupted: !!r.runtime?.interrupted,
   timedOut: !!r.runtime?.timedOut,
   deadlineExceeded: !!r.runtime?.deadlineExceeded,
   stopReasonSummary: stopReasonSummary(r.receipt),
  },
  analysis,
  review,
  artifacts: artifactPaths(dir, report),
 };
}
