import { readFileSync } from 'node:fs';
import { isDirectEntry } from './cli-entry.ts';
import { doctor as setupDoctor, init, parseInitOptions, type SetupDeps } from './setup.ts';
import { doctorExternalContextAuthorization } from './auth.ts';
import { validate, contractWarnings } from './worker-contract.ts';
import type { GateDeps } from './worker-gates.ts';
import { createRunState, preflight } from './worker-preflight.ts';
import { launch } from './worker-launch.ts';
import { runChecks } from './worker-checks.ts';
import { finish } from './worker-outcome.ts';

// Re-export the billing surface so callers and tests have one entry point.
export { captureBilling, validateBilling, resolveApiKeyFromEnvironment, readOpenRouterAuthFile, openRouterAuthPath, BILLING_MODES, BILLING_ENDPOINT, BILLING_MAX_TIMEOUT_MS, BILLING_DEFAULT_TIMEOUT_MS, BILLING_MAX_GENERATIONS } from './billing.ts';
export type { BillingConfig, BillingCapture, BillingDeps, BillingFetch, BillingGeneration, BillingReceipt } from './billing.ts';

// Re-export the evidence and isolation APIs so existing imports from worker.ts
// keep working and callers have one entry point.
export { boundEvidence, boundedGitEvidence, collectGitEvidence, evidenceDelta } from './evidence.ts';
export type { GitEvidence, GitFileChange, EvidenceDelta } from './evidence.ts';
export { resolveIsolation, sourceDirty, createDetachedWorktree, isWorktreeOf, acquireLock, lockPathFor, headOf } from './isolation.ts';
export type { IsolationMode, LockHandle } from './isolation.ts';
export { resolveExecutionSettings, validateExecutionSettings, executeWorkerStreaming, executeCheck, spawnChildDetached, ToolWatchdog, RuntimeHeartbeat, EXECUTION_DEFAULTS, EXECUTION_BOUNDS, DEFAULT_MAX_OUTPUT_BYTES, TOOL_TEXT_LIMIT_BYTES, compactEventLine, sanitizeToolCallId } from './runtime.ts';
export type { ExecutionSettings, WorkerStreamResult, SpawnChild, RuntimeSnapshot, RuntimeState, RuntimePhase } from './runtime.ts';

// Receipt parsing/pricing and the deterministic workflow templates live in their
// own modules (ADR 0015 R7 seam X2). They are re-exported so existing imports
// from worker.ts keep working.
export { MALFORMED_LINE_LIMIT, PRICING_RATES, emptyUsage, parseReceipt, mockReceipt, receiptValid, validatePricing, estimateCost } from './worker-receipt.ts';
export type { CostEstimate, PricingRate } from './worker-receipt.ts';
export { EXPLICIT_WORKFLOWS, ANALYSIS_WORKFLOWS, isAnalysisWorkflow, isQaWorkflow, isReportWorkflow, ANALYSIS_REPORT_FILENAME, analysisReportPath, reportEvidence, deterministicCriterion, WORKFLOW_TEMPLATE_IDS, WORKFLOW_DESCRIPTIONS, COMMON_PROMPT_BLOCK, WORKFLOW_PROMPT_BLOCKS, taskWorkflow, choiceVerdict, CONTRACT_PARTS, CONTRACT_PART_DESCRIPTIONS, contractPartVerdict, clarifyDetail, decideWorkflow } from './worker-workflows.ts';
export type { ExplicitWorkflow, Workflow, ReportEvidence, WorkflowDecision, ContractPart } from './worker-workflows.ts';

/** Doctor wrapper that keeps runtime readiness distinct from external-context
 * authorization. The underlying `doctor` result is unchanged; this adds one
 * non-gating `externalContextAuthorization` section. */
export function doctor(deps:SetupDeps = {}, opts:{harness?:string} = {}):any {
 const result:any=setupDoctor(deps,opts);
 const project=deps.cwd ?? process.cwd();
 result.externalContextAuthorization=doctorExternalContextAuthorization(project,result.credentials?.provider ?? '',result.ok);
 return result;
}

export { TASK_FIELDS, CHECK_FIELDS, PLAN_FIELDS, withinWorkspace, withinRealWorkspace, resolveCheckCwd, CONTEXT_MAX_ENTRIES, CONTEXT_MAX_LINES, CONTEXT_MAX_CHARS, externalContextDestination, externalContextRequired, validateExternalContextConsent, externalContextFiles, resolveExternalContextAuthorization, buildExternalContextPreflight, validateContext, READ_SCOPE_MODES, READ_SCOPE_FIELDS, BUDGET_MODES, BUDGET_FIELDS, SCOPE_EXPANSION_FIELDS, validateReadScope, validateBudget, validateScopeExpansion, scopeExpansionPaths, scopeExpansionRequest, readScopePathMatches, readScopeAllowedPaths, isReadAllowed, assertReadAllowed, readScopedFile, boundedContextBlock, validatePlan, resolveContext, codeContextBlock, acceptanceText, acceptanceWhen, acceptanceTexts, validate, SPLIT_WARNING_CONTEXT_PATHS, SPLIT_WARNING_ACCEPTANCE, contractWarnings } from './worker-contract.ts';
export type { ContextEntry, ResolvedContextEntry, ExternalContextAuthorization, ReadScopeMode, Usage, ObservedPair, ReceiptModelSource, Receipt } from './worker-contract.ts';
export { SESSION_ID_RE, sessionLockKey, resolveResume, loadResume, priorExecutionCwd, resumeExecutionCwd, REVIEW_PROMPT_MAX_CHARS, REVIEW_DIFF_MAX_CHARS, REVIEW_CONTEXT_FILENAME, validateReviewSubject, buildReviewContext, loadReview } from './worker-resume.ts';
export type { ResumeInfo } from './worker-resume.ts';
export { qaReportBlock, analysisReportBlock, discoverReportBlock, investigateReportBlock, prepareReportBlock, reportBlockFor, hopToolBlock, toolDirectionsBlock, promptParts, buildPrompt } from './worker-prompt.ts';
export { piGuardModulePath, piBashTimeoutSeconds, buildPiArgs, preparePiAgentOverlay, probePiCapabilities } from './worker-pi.ts';
export { DEFAULT_JEV, CONFIDENCE_THRESHOLD, MAX_GATE_QUESTIONS, jevMode, resolveExplicitApproval, buildModelApprovalRequest, stickyRoutePath, readStickyRoute, stickyApprovalHolds, writeStickyRoute, decideModelRoute, answerConfidence } from './worker-approval.ts';
export type { JevMode, ModelApproval, ModelRoute, ModelApprovalRequest, ModelPolicyRecord, StickyRoute } from './worker-approval.ts';
export { CLASSIFIER_TIMEOUT_MS, assessPreflight, assessPostflight, resolveOpenRouterKey, createPiClassifier, resolveClassifierModel, createTypesafeClassifier, typesafeAnswers, typesafeUsage, createJevClassifier, readProjectJevProvider, lastAssistantText, buildContinuationCheckpoint, affinityKeyFor, raceSignal, raceAbort } from './worker-gates.ts';
export type { GateQuestion, GateAnswer, GateClassifierResult, GateClassifier, GateUsage, JevAttention, JevPreflight, JevCriterion, JevPostflight, JevGateRecord, SpawnResult, GateDeps } from './worker-gates.ts';
export { CHECKPOINT_GIT_MAX_BYTES, CHECKPOINT_ASSISTANT_MAX_BYTES, CONTINUATION_PROMPT_LEAD, OUTPUT_LIMIT_CONTINUATION_LINE, OUTPUT_LIMIT_ERROR } from './worker-gates.ts';

// X5 run() phases (ADR 0015 R7): one explicit RunState, four phase functions.
export { createRunState, preflight } from './worker-preflight.ts';
export type { RunState } from './worker-preflight.ts';
export { launch } from './worker-launch.ts';
export { runChecks } from './worker-checks.ts';
export { finish } from './worker-outcome.ts';

export async function run(t:any, mock=false, deps:GateDeps = {}) {
 validate(t);
 const state=createRunState(t, mock, deps);
 try {
  // Preflight runs synchronously unless a classifier or clarify step awaits.
  // Awaiting its promise only when it did keeps the launch call (and the Pi
  // spawn) in the same synchronous step as the inline run() it replaces.
  const pre=preflight(state);
  if (!state.preflightDone) {
   const resolved=await pre;
   if (resolved !== state) return resolved;
  }
  const launched=await launch(state);
  if (launched !== state) return launched;
  await runChecks(state);
  return await finish(state);
 } finally {
  state.release?.();
 }
}

function readResultFile(path:string):any {
 let raw:string;
 try { raw=readFileSync(path,'utf8'); } catch { throw Error(`Cannot read result file: ${path}`); }
 let result:any;
 try { result=JSON.parse(raw); } catch { throw Error(`Invalid JSON in result file: ${path}`); }
 return result;
}

function assertResultShape(result:any):void {
 if (!result || typeof result!=='object' || Array.isArray(result)) throw Error('Malformed result: expected an object');
 if (typeof result.id!=='string' || !result.id.trim()) throw Error('Malformed result: missing id');
 if (typeof result.status!=='string' || !result.status.trim()) throw Error('Malformed result: missing status');
 if (!Array.isArray(result.checks)) throw Error('Malformed result: missing checks');
 if (typeof result.artifactDir!=='string' || !result.artifactDir.trim()) throw Error('Malformed result: missing artifactDir');
}

// Optional result fields copied in this order when present with the given type.
// Old result files have no receipt; estimated cost, Jev gate records, workflow
// selection, template IDs, continuation, cache note, isolation/execution
// checkout, complete evidence, runtime heartbeat, lineage/repair budget and
// worker error are all optional additions.
const OPTIONAL_STATUS_FIELDS:Array<[string,'object'|'string']>=[
 ['receipt','object'],['cost','object'],['jev','object'],
 ['workflow','object'],['templates','object'],['resume','object'],['cache','object'],
 ['sourceCwd','string'],['executionCwd','string'],['isolation','object'],['evidence','object'],
 ['runtime','object'],['lineage','object'],['repair','object'],['analysis','object'],['review','object'],
 ['workerError','string'],
];

function hasOptionalField(value:any, kind:'object'|'string'):boolean {
 return kind === 'string' ? typeof value === 'string' : Boolean(value && typeof value === 'object');
}

export function status(path:string) {
 const result=readResultFile(path);
 assertResultShape(result);
 const out:any={id:result.id,outcome:result.status,checks:result.checks,artifactDir:result.artifactDir};
 for (const [key,kind] of OPTIONAL_STATUS_FIELDS) if (hasOptionalField(result[key],kind)) out[key]=result[key];
 return out;
}
if (isDirectEntry(import.meta.url)) {
 try {
 const argv=process.argv.slice(2);
 const command=argv[0];
 if (command==='doctor') {
 const result=doctor();
 console.log(JSON.stringify(result,null,2));
 if (!result.ok) process.exitCode=1;
 } else if (command==='init') {
 const result=init({}, parseInitOptions(argv));
 console.log(JSON.stringify(result,null,2));
 if (result.install && !result.install.ok) process.exitCode=1;
 } else {
 const path=argv[1], flag=argv[2];
 if (!path || !['validate','run','status'].includes(command)) throw Error('Usage: node worker.ts doctor | init [--install] | validate|run|status task.json [--mock]');
 if (command==='status') {
 const result=status(path);
 console.log(JSON.stringify(result,null,2));
 } else {
 const t=validate(JSON.parse(readFileSync(path,'utf8')));
 const result=command==='validate' ? {valid:true,id:t.id,warnings:contractWarnings(t)} : await run(t,flag==='--mock');
 console.log(JSON.stringify(result,null,2));
 if(result.status && !['simulation_passed','ready_for_review'].includes(result.status)) process.exitCode=1;
 }
 }
 } catch(e) {console.error(String(e));process.exitCode=1;}
}
