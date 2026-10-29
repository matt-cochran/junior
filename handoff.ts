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
import { redactSecrets } from './pi-failure.ts';
import { CONFIDENCE_THRESHOLD, type ModelRoute, type ModelPolicyRecord } from './worker.ts';
import type { ScopeResult } from './scope-check.ts';
import type { BudgetAccounting, PhaseAccounting } from './runtime.ts';

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
 attention: {target:string; decision:string; reason:string; probability:number|null; mode:string; workerBlocked:boolean;
  /** Clarify detail: the contract part, its bounded excerpt, and the questions. */
  part?:{name:string; probability:number|null}; excerpt?:string; questions?:string[]} | null;
 id: string;
 outcome: string;
 source: string;
 /** Requested source checkout (the task `cwd`), preserved even when execution
  * happened in an isolated worktree. */
 sourceCwd: string | null;
 execution: { cwd: string | null; artifact: string | null; isolation: string };
 /** External-context egress preflight and its recorded authorization, or null
  * when the result predates the check. */
 externalContext: any | null;
 /** Scope classification when the contract named an owned list, else null. */
 scope: ScopeResult | null;
 /** Pi isolation flags applied for the run, or null when it did not probe. */
 piIsolation: { applied: string[]; missing: string[]; ambient: boolean; probed: boolean; honored: boolean | null } | null;
 artifact: string | null;
 /** Number of worker segments that ran (1 unless automatic continuation ran). */
 segments: number;
 changedFiles: string[];
 checks: { command: string; exitCode: number | null; passed: boolean; error?: string }[];
 unresolved: string[];
 /** Streaming output accounting: raw versus retained bytes and the largest
  * tool results. Null when the result has no stream breakdown (mock/legacy). */
 output: { rawBytes: number; retainedBytes: number; largestToolResults: { toolCallId: string; toolName: string | null; bytes: number }[]; budget?: BudgetAccounting; phaseAccounting?: PhaseAccounting[] } | null;
 /** Requested versus observed bounded-context usage. Null for an unbounded contract. */
 budget: BudgetAccounting | null;
 /** Observed reads and model usage by runtime phase. Null for an unbounded contract. */
 phaseAccounting: PhaseAccounting[] | null;
 model: {
  requested: { provider: string; model: string; source?: string } | null;
  /** The Jev model-routing record, or null when this result predates routing. */
  routing: ModelRoute | null;
  /** The run/plan/project consent that allowed the routed model, or null. */
  approval: { source: string; key: string } | null;
  /** The human consent request written when a run stopped for approval. */
  approvalRequest: any | null;
  /** The commodity-policy refusal record, or null when no model was refused. */
  policy: ModelPolicyRecord | null;
  observed: { provider: string; model: string }[];
  observedUnknown: boolean;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usageAvailable: boolean;
  /** Prompt-cache accounting for this run. `hitRate` is cacheRead divided by
   * input plus cacheRead, or null when there was no activity to measure. */
  cache: { input: number; cacheRead: number; cacheWrite: number; hitRate: number | null };
  /** Captured upstream provider aggregates from billing, or null when this run
   * captured no provider billing. */
  upstream: { provider: string | null; generations: number; cachedTokens: number }[] | null;
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
  checkReserveMs: number | null;
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
 /** The clarification batch for a needs_answers result, or absent otherwise. */
 clarification?: {sessionId:string; round:number; questions:any[]};
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

const REPORT_WORKFLOWS = new Set(['evaluate','qa','recon','investigate']);

function reportWorkflowName(result: any): string | null {
 const workflow = result?.analysis?.workflow
  ?? (typeof result?.workflow === 'string' ? result.workflow : result?.workflow?.selected)
  ?? (typeof result?.review?.from === 'string' ? result.review.from : null);
 return typeof workflow === 'string' && REPORT_WORKFLOWS.has(workflow) ? workflow : null;
}

/** The project path from either a bare path or an already-rendered consent
 * command, so a preflight that records the command does not duplicate it. */
function consentProject(value: unknown, fallback: unknown): string | null {
 if (typeof value === 'string' && value.trim()) {
  const match = value.match(/--project\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? value.trim();
 }
 return typeof fallback === 'string' && fallback.trim() ? fallback : null;
}

/** Deduplicate event stop reasons into a short, stable summary, then add the
 * actionable causes recorded on the result (consent, check timeout, budget,
 * resume and typed Pi failures). */
export function stopReasonSummary(input: any): string[] {
 const result = input && typeof input === 'object' ? input : null;
 const receipt = input?.receipt && typeof input.receipt === 'object' ? input.receipt : input;
 const raw = Array.isArray(receipt?.stopReasons) ? receipt.stopReasons : [];
 const seen: string[] = [];
 const add = (value: unknown) => { const s = String(value); if (!seen.includes(s)) seen.push(s); };
 for (const r of raw) add(r);

 if (!result) return seen;

 const external = result.externalContext;
 const authorization = external?.authorization ?? external?.preflight?.authorization;
 if (result.status === 'needs_external_context_consent' || (authorization?.required !== false && authorization?.granted === false) || result.externalContextConsent?.approve) {
  const consent = result.externalContextConsent;
  const provider = consent?.provider ?? external?.preflight?.provider ?? external?.provider ?? 'provider';
  const project = consentProject(consent?.approve?.project ?? authorization?.approve?.project, result.sourceCwd ?? result.executionCwd ?? result.execution?.cwd);
  add(`consent_required: run "junior auth consent grant ${provider} --project ${project ?? '<cwd>'}" or set externalContextConsent`);
 }

 const checks = Array.isArray(result.checks) ? result.checks : [];
 const timeoutMs = result.runtime?.checkTimeoutMs ?? result.execution?.checkTimeoutMs ?? result.settings?.checkTimeoutMs ?? result.checkTimeoutMs;
 checks.forEach((check: any, index: number) => {
  if (check?.timedOut) add(`check_timeout: check ${index + 1} killed after ${check.timeoutMs ?? timeoutMs ?? 'unknown'} ms (raise execution.checkTimeoutMs)`);
 });

 const budget = result.budget ?? result.outputBreakdown?.budget;
 const stopReason = result.runtime?.stopReason ?? result.stopReason ?? result.status;
 if (budget?.exceeded || budget?.stopReason === 'budget_exceeded' || stopReason === 'budget_exceeded' || raw.includes('budget_exceeded')) {
  const field = budget?.exceededField;
  const workflow = reportWorkflowName(result);
  const reportState = workflow
   ? (result.analysis?.reportPresent === true || result.reportPresent === true ? 'partial' : 'missing')
   : null;
  add(`budget_exceeded${field ? ` (${field})` : ''}${reportState ? `; report: ${reportState}` : ''}`);
 }

 const failure = result.workerFailure;
 const resumeError = typeof result.resume?.error === 'string' ? result.resume.error : '';
 const resumeUnavailable = failure?.category === 'resume_session_unavailable'
  || result.status === 'resume_session_unavailable'
  || /resume_session_unavailable/.test(resumeError);
 if (resumeUnavailable) {
  const sessionId = result.resume?.sessionId ?? result.resume?.parentSessionId ?? result.sessionId ?? receipt?.sessionId
   ?? result.resumeFallback?.sessionId ?? failure?.sessionId;
  // The compact receipt names the session by its first 8 characters only;
  // the full id stays in the local result for diagnostics.
  add(`resume_session_unavailable${sessionId ? `: session ${redactSecrets(String(sessionId)).slice(0, 8)}…` : ''}`);
 }

 if (failure && typeof failure === 'object') {
  if (typeof failure.summary === 'string' && failure.summary.trim()) {
   add(`worker_failure${failure.category ? ` ${failure.category}` : ''}: ${failure.summary}`);
  } else if (typeof failure.category === 'string' && failure.category.trim()) {
   add(`worker_failure: ${failure.category}`);
  }
 }

 if (result.analysis && result.analysis.reportPresent === false) {
  add(`analysis_report_missing: ${result.analysis.report ?? 'unknown path'}`);
 }

 return seen;
}

/** Bound criterion text for a compact unresolved entry (80 chars, then an
 * ellipsis), so a long criterion never floods the receipt. */
function criterionLabel(text: unknown): string {
 const s = typeof text === 'string' ? text : String(text ?? '');
 return s.length > 80 ? `${s.slice(0, 80)}...` : s;
}

/** One self-explanatory unresolved acceptance entry: criterion id, verdict word,
 * the criterion text and the classifier probability against the threshold. */
function unresolvedCriterion(kind: 'gap' | 'uncertain', c: any): string {
 const id = String(c?.id ?? 'AC?');
 const p = c?.probability;
 const reason = typeof p === 'number' && Number.isFinite(p)
  ? `P(satisfied)=${p}, threshold ${CONFIDENCE_THRESHOLD}`
  : `no classifier probability, threshold ${CONFIDENCE_THRESHOLD}`;
 return `${id} ${kind}: "${criterionLabel(c?.text)}" (${reason})`;
}

/** Actionable, human-readable unresolved issues from an otherwise final result. */
export function unresolvedIssues(result: any): string[] {
 const out: string[] = [];
 if (result?.workerError) out.push(String(result.workerError));
 for (const check of Array.isArray(result?.checks) ? result.checks : []) {
  if (check.exitCode !== 0 || check.error || check.timedOut || check.outputTruncated) out.push(`check failed: ${[check.command, ...(check.args || [])].join(' ')}${check.error ? ': ' + check.error : ''}`);
 }
 const post = result?.jev?.postflight;
 const criteria = Array.isArray(post?.criteria) ? post.criteria : [];
 const criterionById = new Map<string, any>(criteria.map((c: any) => [String(c?.id), c]));
 for (const id of (Array.isArray(post?.gapIds) ? post.gapIds : [])) out.push(unresolvedCriterion('gap', criterionById.get(String(id)) ?? { id }));
 for (const id of (Array.isArray(post?.uncertainIds) ? post.uncertainIds : [])) out.push(unresolvedCriterion('uncertain', criterionById.get(String(id)) ?? { id }));
 if (result?.outputTruncated || result?.receipt?.outputTruncated) out.push('worker output truncated at the cap');
 else if (result?.receipt?.malformed) out.push(`malformed event lines: ${(result.receipt.malformedLines || []).join(', ')}`);
 if (result?.runtime?.timedOut) out.push('tool execution timed out');
 if (result?.runtime?.deadlineExceeded) out.push('total wall deadline exceeded');
 if (result?.runtime?.interrupted) out.push('run interrupted by signal');
 if (result?.resume?.error) out.push(`resume: ${result.resume.error}`);
 if (result?.lineage?.rejected) out.push('repair rejected by lineage budget');
 if (result?.analysis && result.analysis.reportPresent === false) out.push(`analysis report missing: ${result.analysis.report ?? 'unknown path'}`);
 const isolationProblems = result?.piIsolation?.verification?.problems;
 if (Array.isArray(isolationProblems) && isolationProblems.length > 0) out.push(`isolation not honored: ${isolationProblems.join('; ')}`);
 if (Array.isArray(result?.scope?.outOfScope) && result.scope.outOfScope.length > 0) out.push(`out of scope: ${result.scope.outOfScope.join(', ')}`);
 const budget = result?.budget ?? result?.outputBreakdown?.budget;
 if (budget?.exceeded) out.push(`bounded context ${budget.stopReason ?? 'limit exceeded'}${budget.exceededField ? `: ${budget.exceededField}` : ''}`);
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
 // A Pi custom provider (a litellm proxy, ADR-0007) without `cost` in Pi's
 // models.json reports 0 for real token use; that zero is unpriced, not free.
 const provider = r?.receipt?.requested?.provider;
 const tokens = Number(r?.receipt?.usage?.totalTokens ?? 0);
 const unpricedZero = provider !== undefined && provider !== 'openrouter' && piTotal === 0 && tokens > 0;
 const piUsd = piReported?.available === true && !unpricedZero ? finiteUsd(piTotal) : null;
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
  if (piUsd === null) missing.push(unpricedZero ? `missing Pi pricing: provider ${provider} reported 0 for ${tokens} tokens; add cost to its Pi models.json entry` : 'missing Pi pricing');
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
 const cacheInput = r.receipt?.usage?.input ?? 0;
 const cacheRead = r.receipt?.usage?.cacheRead ?? 0;
 const cacheTotal = cacheInput + cacheRead;
 const hitRate = cacheTotal > 0 ? Math.round((cacheRead / cacheTotal) * 100) / 100 : null;
 const report = typeof r.analysis?.report === 'string' ? r.analysis.report : null;
 const budget = r.budget ?? r.outputBreakdown?.budget ?? null;
 const phaseAccounting = r.phaseAccounting ?? r.outputBreakdown?.phaseAccounting ?? null;
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
  scope: r.scope && typeof r.scope === 'object' ? {
   checked: !!r.scope.checked,
   inScope: Array.isArray(r.scope.inScope) ? r.scope.inScope : [],
   incidental: Array.isArray(r.scope.incidental) ? r.scope.incidental : [],
   outOfScope: Array.isArray(r.scope.outOfScope) ? r.scope.outOfScope : [],
  } : null,
  externalContext: r.externalContext && typeof r.externalContext === 'object' ? r.externalContext : null,
  piIsolation: r.piIsolation && typeof r.piIsolation === 'object' ? {
   applied: Array.isArray(r.piIsolation.applied) ? r.piIsolation.applied : [],
   missing: Array.isArray(r.piIsolation.missing) ? r.piIsolation.missing : [],
   ambient: !!r.piIsolation.ambient,
   probed: !!r.piIsolation.probed,
   honored: r.piIsolation.verification?.checked ? !!r.piIsolation.verification.honored : null,
  } : null,
  artifact: dir,
  segments: Array.isArray(r.segments) ? r.segments.length : 0,
  changedFiles,
  checks: (Array.isArray(r.checks) ? r.checks : []).map((c: any) => ({
   command: [c?.command, ...(Array.isArray(c?.args) ? c.args : [])].filter(Boolean).join(' '),
   exitCode: c?.exitCode ?? null,
   passed: c?.exitCode === 0 && !c?.error && !c?.timedOut && !c?.outputTruncated,
   ...(c?.error ? { error: String(c.error) } : {}),
  })),
  unresolved: unresolvedIssues(r),
  output: r.outputBreakdown ? { rawBytes: r.outputBreakdown.rawBytes, retainedBytes: r.outputBreakdown.retainedBytes, largestToolResults: r.outputBreakdown.largestToolResults, ...(r.outputBreakdown.budget ? { budget: r.outputBreakdown.budget } : {}), ...(r.outputBreakdown.phaseAccounting ? { phaseAccounting: r.outputBreakdown.phaseAccounting } : {}) } : null,
  budget,
  phaseAccounting,
  model: {
   requested: r.receipt?.requested ?? null,
   routing: r.modelRouting ?? null,
   approval: r.modelRouting?.approval ?? null,
   approvalRequest: r.modelApproval ?? null,
   policy: r.modelPolicy ?? null,
   observed: Array.isArray(r.receipt?.observed) ? r.receipt.observed : [],
   observedUnknown: r.receipt?.observedUnknown ?? true,
   tokens: r.receipt?.usage?.totalTokens ?? 0,
   input: r.receipt?.usage?.input ?? 0,
   output: r.receipt?.usage?.output ?? 0,
   cacheRead: r.receipt?.usage?.cacheRead ?? 0,
   cacheWrite: r.receipt?.usage?.cacheWrite ?? 0,
   usageAvailable: r.receipt?.usage?.available ?? false,
   cache: { input: cacheInput, cacheRead, cacheWrite: r.receipt?.usage?.cacheWrite ?? 0, hitRate },
   upstream: r.billing?.providers ?? null,
   responseIds: Array.isArray(r.receipt?.responseIds) ? r.receipt.responseIds : [],
   cost,
  },
  runtime: {
   state: r.runtime?.state ?? null,
   stopReason: r.runtime?.stopReason ?? null,
   elapsedMs: r.runtime?.elapsedMs ?? null,
   deadlineMs: r.runtime?.deadlineMs ?? null,
   checkReserveMs: r.runtime?.checkReserveMs ?? null,
   quietMs: r.runtime?.quietMs ?? null,
   toolTimeoutMs: r.runtime?.toolTimeoutMs ?? null,
   heartbeatMs: r.runtime?.heartbeatMs ?? null,
   interrupted: !!r.runtime?.interrupted,
   timedOut: !!r.runtime?.timedOut,
   deadlineExceeded: !!r.runtime?.deadlineExceeded,
   stopReasonSummary: stopReasonSummary(r),
  },
  analysis,
  review,
  ...(r.clarification && typeof r.clarification === 'object' ? {clarification:{
   sessionId:String(r.clarification.sessionId ?? ''),
   round:Number(r.clarification.round ?? 0),
   questions:Array.isArray(r.clarification.questions) ? r.clarification.questions : [],
  }} : {}),
  artifacts: artifactPaths(dir, report),
 };
}
