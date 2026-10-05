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
  cacheRead: number;
  cacheWrite: number;
  usageAvailable: boolean;
  cost: {
   estimatedUsd: number | null;
   billedUsd: null;
   piReportedTotal: number | null;
   available: boolean;
   unknownReason?: string;
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

/** Build the compact handoff from a full worker result. */
export function compactHandoff(result: any): CompactHandoff {
 const r = result || {};
 const dir = typeof r.artifactDir === 'string' && r.artifactDir ? r.artifactDir : null;
 const evidenceChanged = r.evidence?.runChangedFiles ?? r.evidence?.changedFiles ?? [];
 const changedFiles = (Array.isArray(evidenceChanged) ? evidenceChanged : [])
  .map((f: any) => (typeof f === 'string' ? f : f?.path))
  .filter((p: any) => typeof p === 'string');
 const estimatedUsd = r.cost?.estimatedUsd ?? null;
 const piTotal = r.cost?.piReported?.total ?? null;
 // A zero raw Pi catalog total is NOT a known charge: Pi can report
 // `available: true` with a zero total when no pricing catalog matched. Only a
 // real estimate, or a strictly positive Pi-reported total, is a known charge.
 const costAvailable = estimatedUsd !== null
  || (r.cost?.piReported?.available === true && typeof piTotal === 'number' && piTotal > 0);
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
   cacheRead: r.receipt?.usage?.cacheRead ?? 0,
   cacheWrite: r.receipt?.usage?.cacheWrite ?? 0,
   usageAvailable: r.receipt?.usage?.available ?? false,
   cost: {
    estimatedUsd,
    billedUsd: null,
    piReportedTotal: piTotal,
    available: costAvailable,
    ...(r.cost?.unknownReason ? { unknownReason: String(r.cost.unknownReason) } : {}),
   },
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
