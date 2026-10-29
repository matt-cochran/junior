import {loadHopContext} from './hop-context.ts';
import {isDirectEntry} from './cli-entry.ts';
import { readFileSync, mkdirSync, writeFileSync, existsSync, realpathSync, symlinkSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute, sep, delimiter, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { doctor as setupDoctor, init, parseInitOptions, type SetupDeps } from './setup.ts';
import { collectGitEvidence, evidenceDelta, type GitEvidence, type EvidenceDelta } from './evidence.ts';
import { resolveIsolation, sourceDirty, createDetachedWorktree, isWorktreeOf, acquireLock, lockPathFor, headOf, ensureLocalExcludes, validateIsolationSetup, provisionIsolationSetup, configuredIsolationSetup, type IsolationMode, type LockHandle, type IsolationSetup } from './isolation.ts';
import { resolveExecutionSettings, validateExecutionSettings, executeWorkerStreaming, executeCheck, spawnChildDetached, RuntimeHeartbeat, type ExecutionSettings, type WorkerStreamResult, type SpawnChild, type RuntimeSnapshot, type RuntimePhase } from './runtime.ts';
import { captureBilling, validateBilling, resolveApiKeyFromEnvironment, readOpenRouterAuthFile, openRouterAuthPath, BILLING_DEFAULT_TIMEOUT_MS, type BillingCapture, type BillingFetch } from './billing.ts';
import { loadPlaybooks } from './playbooks.ts';
import { routeTools, type ToolRoute } from './tool-routing.ts';
import { loadModelConfig, rosterChoiceCriteria, findProfile } from './roster.ts';
import type { ModelConfig, RoutingMode } from './roster.ts';
import { assertCommodity, ModelPolicyError } from './model-policy.ts';
import type { ModelClass } from './model-policy.ts';
import { readLocalCatalog, type ModelPrice } from './models.ts';
import { priceDelta, readCachedCatalog, piAgentDir } from './model-updates.ts';
import { briefMdPath, briefPath, buildPlaceholderBrief, loadPrepareHistory, renderBrief, shouldCheckBack } from './prepare.ts';
import { clarificationApplies, clarityGateApplies, resolveDiscoverReport, startClarification, type ClarifyDeps } from './clarify.ts';
import { validatePiContext, buildIsolationArgs, parsePiCapabilities, verifyIsolation, DEFAULT_PI_TOOLS, type PiCapabilities, type IsolationVerdict } from './pi-isolation.ts';
import { classifyScope, incidentalGlobsFromConfig, type ScopeResult } from './scope-check.ts';
import { resolveJevGateway, validateJevProvider, GatewayError, type JevProvider, type GatewayDeps, type ResolvedJevGateway } from './gateway.ts';
import { readExternalContextConsent, verifyExternalContextConsentToken, externalContextCredentialSource, doctorExternalContextAuthorization } from './auth.ts';

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
// own modules (ADR 0015 R7 seam X2). They are imported for local use and
// re-exported so existing imports from worker.ts keep working.
import { addUsage, emptyUsage, estimateCost, mockReceipt, num, parseReceipt, receiptValid, validatePricing } from './worker-receipt.ts';
export { MALFORMED_LINE_LIMIT, PRICING_RATES, emptyUsage, parseReceipt, mockReceipt, receiptValid, validatePricing, estimateCost } from './worker-receipt.ts';
export type { CostEstimate, PricingRate } from './worker-receipt.ts';
import { analysisReportPath, clarifyDetail, COMMON_PROMPT_BLOCK, CONTRACT_PART_DESCRIPTIONS, contractPartVerdict, decideWorkflow, deterministicCriterion, isReportWorkflow, reportEvidence, taskWorkflow, WORKFLOW_DESCRIPTIONS, WORKFLOW_PROMPT_BLOCKS, WORKFLOW_TEMPLATE_IDS } from './worker-workflows.ts';
import type { ContractPart, ExplicitWorkflow, ReportEvidence } from './worker-workflows.ts';
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

import { TASK_FIELDS, CHECK_FIELDS, PLAN_FIELDS, withinWorkspace, withinRealWorkspace, resolveCheckCwd, CONTEXT_MAX_ENTRIES, CONTEXT_MAX_LINES, CONTEXT_MAX_CHARS, externalContextDestination, externalContextRequired, validateExternalContextConsent, externalContextFiles, resolveExternalContextAuthorization, buildExternalContextPreflight, validateContext, READ_SCOPE_MODES, READ_SCOPE_FIELDS, BUDGET_MODES, BUDGET_FIELDS, SCOPE_EXPANSION_FIELDS, validateReadScope, validateBudget, validateScopeExpansion, scopeExpansionPaths, scopeExpansionRequest, readScopePathMatches, readScopeAllowedPaths, isReadAllowed, assertReadAllowed, readScopedFile, boundedContextBlock, validatePlan, resolveContext, codeContextBlock, acceptanceText, acceptanceWhen, acceptanceTexts, validate, SPLIT_WARNING_CONTEXT_PATHS, SPLIT_WARNING_ACCEPTANCE, contractWarnings } from './worker-contract.ts';
import type { ContextEntry, ResolvedContextEntry, ExternalContextAuthorization, ReadScopeMode, Usage, ObservedPair, ReceiptModelSource, Receipt } from './worker-contract.ts';
export { TASK_FIELDS, CHECK_FIELDS, PLAN_FIELDS, withinWorkspace, withinRealWorkspace, resolveCheckCwd, CONTEXT_MAX_ENTRIES, CONTEXT_MAX_LINES, CONTEXT_MAX_CHARS, externalContextDestination, externalContextRequired, validateExternalContextConsent, externalContextFiles, resolveExternalContextAuthorization, buildExternalContextPreflight, validateContext, READ_SCOPE_MODES, READ_SCOPE_FIELDS, BUDGET_MODES, BUDGET_FIELDS, SCOPE_EXPANSION_FIELDS, validateReadScope, validateBudget, validateScopeExpansion, scopeExpansionPaths, scopeExpansionRequest, readScopePathMatches, readScopeAllowedPaths, isReadAllowed, assertReadAllowed, readScopedFile, boundedContextBlock, validatePlan, resolveContext, codeContextBlock, acceptanceText, acceptanceWhen, acceptanceTexts, validate, SPLIT_WARNING_CONTEXT_PATHS, SPLIT_WARNING_ACCEPTANCE, contractWarnings } from './worker-contract.ts';
export type { ContextEntry, ResolvedContextEntry, ExternalContextAuthorization, ReadScopeMode, Usage, ObservedPair, ReceiptModelSource, Receipt } from './worker-contract.ts';

/** Shared error-message coercion, used across the worker modules. */
const msg=(e:unknown)=>e instanceof Error ? e.message : String(e);

// X3 modules: resume/review loading, prompt construction, and Pi process setup.
import { sessionLockKey, loadResume, resumeExecutionCwd, REVIEW_CONTEXT_FILENAME, loadReview, type ResumeInfo } from './worker-resume.ts';
import { buildPrompt } from './worker-prompt.ts';
import { piGuardModulePath, piBashTimeoutSeconds, timedOutToolLine, buildPiArgs, preparePiAgentOverlay, probePiCapabilities } from './worker-pi.ts';
export { SESSION_ID_RE, sessionLockKey, resolveResume, loadResume, priorExecutionCwd, resumeExecutionCwd, REVIEW_PROMPT_MAX_CHARS, REVIEW_DIFF_MAX_CHARS, REVIEW_CONTEXT_FILENAME, validateReviewSubject, buildReviewContext, loadReview } from './worker-resume.ts';
export type { ResumeInfo } from './worker-resume.ts';
export { qaReportBlock, analysisReportBlock, discoverReportBlock, investigateReportBlock, prepareReportBlock, reportBlockFor, hopToolBlock, toolDirectionsBlock, promptParts, buildPrompt } from './worker-prompt.ts';
export { piGuardModulePath, piBashTimeoutSeconds, buildPiArgs, preparePiAgentOverlay, probePiCapabilities } from './worker-pi.ts';


// Re-export the approval and gate surfaces so existing imports from worker.ts
// keep working after the seam split (ADR-0015 R7).
export { DEFAULT_JEV, CONFIDENCE_THRESHOLD, MAX_GATE_QUESTIONS, jevMode, resolveExplicitApproval, buildModelApprovalRequest, stickyRoutePath, readStickyRoute, stickyApprovalHolds, writeStickyRoute, decideModelRoute, answerConfidence } from './worker-approval.ts';
export type { JevMode, ModelApproval, ModelRoute, ModelApprovalRequest, ModelPolicyRecord, StickyRoute } from './worker-approval.ts';
export { CLASSIFIER_TIMEOUT_MS, assessPreflight, assessPostflight, resolveOpenRouterKey, createPiClassifier, resolveClassifierModel, createTypesafeClassifier, typesafeAnswers, typesafeUsage, createJevClassifier, readProjectJevProvider, lastAssistantText, buildContinuationCheckpoint, affinityKeyFor, raceSignal, raceAbort } from './worker-gates.ts';
export type { GateQuestion, GateAnswer, GateClassifierResult, GateClassifier, GateUsage, JevAttention, JevPreflight, JevCriterion, JevPostflight, JevGateRecord, SpawnResult, GateDeps } from './worker-gates.ts';
export { CHECKPOINT_GIT_MAX_BYTES, CHECKPOINT_ASSISTANT_MAX_BYTES, CONTINUATION_PROMPT_LEAD, OUTPUT_LIMIT_CONTINUATION_LINE, OUTPUT_LIMIT_ERROR } from './worker-gates.ts';
import { CONFIDENCE_THRESHOLD, DEFAULT_JEV, buildModelApprovalRequest, decideModelRoute, jevMode, readStickyRoute, resolveExplicitApproval, stickyApprovalHolds, writeStickyRoute } from './worker-approval.ts';
import type { ModelApprovalRequest, ModelPolicyRecord, ModelRoute } from './worker-approval.ts';
import { CLASSIFIER_TIMEOUT_MS, CONTINUATION_PROMPT_LEAD, OUTPUT_LIMIT_CONTINUATION_LINE, OUTPUT_LIMIT_ERROR, affinityKeyFor, assessPostflight, assessPreflight, buildContinuationCheckpoint, createJevClassifier, readProjectJevProvider, resolveOpenRouterKey, raceSignal, raceAbort } from './worker-gates.ts';
import type { GateClassifier, GateDeps, JevGateRecord } from './worker-gates.ts';

export async function run(t:any, mock=false, deps:GateDeps = {}) {
 validate(t);
 const runStartedAt=Date.now();
 const settings=resolveExecutionSettings(t);
 const sourceCwd=resolve(t.cwd);
 const isolation=resolveIsolation(t).mode;
 // Record Junior's own run-artifact tree in the repository-local exclude before
 // the first artifact is written, so `.delivery/` never surfaces as a target
 // change. A non-git cwd has nothing to touch and is left alone.
 ensureLocalExcludes(sourceCwd, ['/.delivery/']);
 const stamp=String(Date.now());
 const dir=join(sourceCwd,'.delivery',t.id,stamp);
 mkdirSync(dir,{recursive:true});
 const modelConfig=loadModelConfig(sourceCwd);
 const explicitProvider=typeof t.provider==='string' && t.provider.trim() ? t.provider : null;
 const explicitModel=typeof t.model==='string' && t.model.trim() ? t.model : null;
 const modelProfile=typeof t.modelProfile==='string' && t.modelProfile.trim() ? t.modelProfile.trim() : null;
 let requested={ provider:explicitProvider ?? modelConfig.provider, model:explicitModel ?? modelConfig.model };
 let requestedSource:ReceiptModelSource=explicitProvider || explicitModel ? 'task' : modelConfig.source;
 const mode=jevMode(t);
 const jevProviderSetting:JevProvider = (t.jev?.provider as JevProvider | undefined)
  ?? (deps.readJevProvider ?? readProjectJevProvider)(sourceCwd);
 const jev:JevGateRecord|undefined = mode === 'off' ? undefined : {
  mode,
  model:{ provider:DEFAULT_JEV.provider, id:DEFAULT_JEV.id, explicit:false },
  attempted:false,
  enforced:false,
 };

 // The total wall deadline starts here, before readiness/isolation/classifier,
 // and is tightened by an inherited repair-lineage deadline when one exists.
 let deadlineAt=runStartedAt+settings.deadlineMs;
 const runtimePath=join(dir,'runtime.json');
 const emit=(line:string)=>{ try { deps.progress?.(line); } catch { /* progress must never abort a run */ } };
 const heartbeat=new RuntimeHeartbeat(runtimePath, settings, runStartedAt, deadlineAt, 'readiness', deps.progress);
 heartbeat.begin();
 emit('readiness');
 const remainingMs=()=>deadlineAt-Date.now();
 const outOfTime=()=>Date.now() >= deadlineAt;
 // The worker is stopped before the total deadline so the reserved budget is
 // available to the contract's checks, which remain bounded by the total wall
 // deadline.
 const workerDeadlineAt=()=>deadlineAt-settings.checkReserveMs;
 const workerRemainingMs=()=>workerDeadlineAt()-Date.now();
 const workerOutOfTime=()=>Date.now() >= workerDeadlineAt();

 let lineage:any={ rootId:t.id, repairs:0,
  maxRepairs: typeof t.maxRepairs==='number' ? t.maxRepairs : 1,
  deadlineAt: typeof t.lineageDeadlineMs==='number' ? new Date(runStartedAt+t.lineageDeadlineMs).toISOString() : null };
 // One absolute lineage deadline (when supplied) also bounds this root run, so
 // a whole recovery chain shares a single wall-clock budget.
 if (typeof t.lineageDeadlineMs==='number') {
  deadlineAt=Math.min(deadlineAt, runStartedAt+t.lineageDeadlineMs);
  heartbeat.update({ deadlineAt:new Date(deadlineAt).toISOString(), remainingMs:Math.max(0, deadlineAt-Date.now()) });
 }

 // Every pre-worker refusal writes an inspectable result plus a runtime heartbeat.
 const blocked=(workerError:string, extra:any={})=>{
  heartbeat.setState('failed',{stopReason:'blocked', error:workerError});
  emit('finished needs_review');
  const out:any={ id:t.id, simulated:mock, status:'needs_review', workerExitCode:null,
   workerError, checks:[], artifactDir:dir, runtime:heartbeat.snapshot(), lineage, ...extra };
  writeFileSync(join(dir,'result.json'),JSON.stringify(out,null,2));
  return out;
 };

 // A contract may pin a roster profile. The pin still needs human consent when
 // it differs from the project default, exactly like an explicit model.
 const pinnedProfile=modelProfile ? findProfile(modelConfig, modelProfile) : null;
 if (modelProfile && !pinnedProfile) return blocked(`modelProfile '${modelProfile}' is not in the roster`);
 if (pinnedProfile) {
  requested={ provider:pinnedProfile.provider, model:pinnedProfile.model };
  requestedSource='task';
 }

 // Commodity-only executor policy: refuse a frontier or unknown requested
 // model before any classifier or worker cost, including mock runs.
 let modelPolicy:ModelPolicyRecord|undefined;
 try {
  assertCommodity(requested.provider, requested.model);
 } catch (e) {
  if (!(e instanceof ModelPolicyError)) throw e;
  modelPolicy={ provider:requested.provider, model:requested.model, class:e.verdict.class, reason:e.verdict.reason, code:e.code };
  return blocked(`${e.code}: ${e.verdict.reason}`, { modelPolicy });
 }

 // Model routing is eligible only for a non-resume task with no explicit model,
 // with Jev and routing both enabled and at least two roster profiles.
 const resumeRequested=(typeof t.resumeFrom==='string' && !!t.resumeFrom.trim())
  || (typeof t.repairFrom==='string' && !!t.repairFrom.trim());
 // Sticky routing: one model per deliverable. A non-resume run with no explicit
 // model reuses the model an earlier run with the same id recorded, provided
 // the recorded approval still holds or the model is the current default.
 const sticky=!explicitProvider && !explicitModel && !pinnedProfile && !resumeRequested
  ? readStickyRoute(sourceCwd, t.id) : null;
 let stickyRoute:ModelRoute|undefined;
 if (sticky && stickyApprovalHolds(modelConfig, t, sticky)) {
  requested={ provider:sticky.provider, model:sticky.model };
  requestedSource='routed';
  stickyRoute={ mode, eligible:false, profile:sticky.profile, confidence:null,
   applied:sticky.model !== modelConfig.model, provider:sticky.provider, model:sticky.model,
   reason:"sticky: reused the deliverable's earlier model",
   ...(sticky.approval?{approval:sticky.approval}:{}) };
 }
 const routingSkipped=explicitProvider || explicitModel ? 'explicit task model'
  : pinnedProfile ? 'explicit task model'
  : resumeRequested ? 'resume keeps the prior model'
  : stickyRoute ? "sticky: reused the deliverable's earlier model"
  : mode === 'off' ? 'jev off'
  : modelConfig.routing === 'off' ? 'routing off'
  : modelConfig.roster.length < 2 ? 'roster has fewer than two profiles'
  : undefined;
 const routingEligible=routingSkipped === undefined;
 const modelProfiles=routingEligible ? rosterChoiceCriteria(modelConfig.roster) : undefined;

 // External-context preflight: before any classifier or worker provider call,
 // disclose the destination/model/scope and require recorded consent. Without
 // it the run fails closed with an inspectable request, never a paid attempt.
 let externalContext:any=null;
 if (externalContextRequired(requested.provider)) {
  const preflight=buildExternalContextPreflight(t, sourceCwd, requested, deps);
  externalContext={ preflight, authorization:preflight.authorization };
  writeFileSync(join(dir,'external-context-preflight.json'),JSON.stringify(preflight,null,2));
 }

 // Resolve an explicit continuation (or an explicit repair) before spending any
 // classifier or worker cost.
 if (t.hopFrom !== undefined) {
  if (typeof t.hopFrom !== 'string' || !t.hopFrom.trim()) return blocked('Invalid hopFrom path');
  try {
   const hopContext=loadHopContext(resolve(sourceCwd,t.hopFrom));
   if(t.hopRevision !== undefined && t.hopRevision !== hopContext.revision) return blocked('HOP revision changed; inspect the handoff and redispatch against the current revision');
   t={...t,hopContext};
  }
  catch(e) { return blocked(`HOP rejected before paid calls: ${msg(e)}`); }
 }
 const explicitWorkflow=taskWorkflow(t);
 let isQa=explicitWorkflow === 'qa';
 const reviewRequested=isQa || (explicitWorkflow === 'auto' && typeof t.reviewFrom === 'string' && !!t.reviewFrom.trim());
 let review:any;
 let reviewContext:string|null=null;
 if (reviewRequested) {
  if (typeof t.resumeFrom==='string' && t.resumeFrom.trim()) {
   return blocked('qa rejected before any paid call: resumeFrom is not allowed for workflow qa; QA runs a fresh reviewer session to avoid implementer-session bias', { review:{ from:null, error:'resumeFrom not allowed for qa' } });
  }
  if (typeof t.repairFrom==='string' && t.repairFrom.trim()) {
   return blocked('qa rejected before any paid call: repairFrom is not allowed for workflow qa; QA is report-only and never repairs', { review:{ from:null, error:'repairFrom not allowed for qa' } });
  }
  if (isolation === 'worktree') {
   return blocked('qa rejected before any paid call: workflow qa must inspect the subject checkout including uncommitted changes; isolation=worktree would review the wrong HEAD and is incompatible. Use isolation=none (the qa CLI default).', { review:{ from:null, error:'worktree isolation incompatible with qa' } });
  }
  const reviewFrom=typeof t.reviewFrom==='string' && t.reviewFrom.trim() ? resolve(sourceCwd,t.reviewFrom) : null;
  if (!reviewFrom) {
   return blocked('qa rejected before any paid call: reviewFrom is required and must point at the prior result.json under review', { review:{ from:null, error:'reviewFrom required' } });
  }
  const loaded=loadReview(t, sourceCwd);
  if (loaded.error) {
   return blocked(`reviewFrom rejected: ${loaded.error}`, { review:{ from:reviewFrom, error:loaded.error } });
  }
  reviewContext=loaded.context ?? null;
  const priorWorkflow=loaded.prior.workflow && typeof loaded.prior.workflow === 'object'
   ? (loaded.prior.workflow.selected ?? loaded.prior.workflow.workflow ?? null) : (loaded.prior.workflow ?? null);
  review={ from:reviewFrom, priorResult:{ id:loaded.prior.id, status:loaded.prior.status, workflow:priorWorkflow, artifactDir:loaded.prior.artifactDir } };
 }

 const resumeField = typeof t.repairFrom==='string' && t.repairFrom.trim() ? t.repairFrom
  : (typeof t.resumeFrom==='string' && t.resumeFrom.trim() ? t.resumeFrom : null);
 const isRepair = typeof t.repairFrom==='string' && !!t.repairFrom.trim();
 let resume:ResumeInfo|undefined;
 let prior:any;
 if (resumeField) {
  const loaded=loadResume({...t, resumeFrom:resumeField}, requested, sourceCwd);
  if (loaded.error) {
   return blocked(`resumeFrom rejected: ${loaded.error}`, {
    resume:{ from:resolve(sourceCwd,resumeField), error:loaded.error } });
  }
  resume=loaded.info;
  prior=loaded.prior;
  if (isRepair) {
   const priorLineage = prior && typeof prior.lineage==='object' && prior.lineage ? prior.lineage : null;
   const repairs=(typeof priorLineage?.repairs==='number'?priorLineage.repairs:0)+1;
   const maxRepairs= typeof t.maxRepairs==='number' ? t.maxRepairs
    : (typeof priorLineage?.maxRepairs==='number' ? priorLineage.maxRepairs : 1);
   const rootId= priorLineage?.rootId ?? (typeof prior?.id==='string' ? prior.id : t.id);
   lineage={ rootId, repairs, maxRepairs, deadlineAt: typeof priorLineage?.deadlineAt==='string' ? priorLineage.deadlineAt : null };
   if (repairs > maxRepairs) {
    return blocked(`repair rejected before any paid call: repair ${repairs} exceeds maxRepairs ${maxRepairs} for lineage ${rootId}`, { lineage:{...lineage, rejected:true} });
   }
   const inherited= typeof priorLineage?.deadlineAt==='string' ? Date.parse(priorLineage.deadlineAt) : NaN;
   if (Number.isFinite(inherited)) {
    deadlineAt=Math.min(deadlineAt, inherited);
    lineage.deadlineAt=new Date(inherited).toISOString();
    heartbeat.update({ deadlineAt:new Date(deadlineAt).toISOString(), remainingMs:Math.max(0, deadlineAt-Date.now()) });
   }
   if (Date.now() >= deadlineAt) {
    return blocked('repair rejected before any paid call: the lineage deadline has already elapsed', { lineage });
   }
  }
 }

 // Decide the execution checkout before any paid call. Worktree isolation
 // requires a clean source and refuses rather than silently omitting edits.
 heartbeat.update({phase:'isolation'});
 emit('isolation');
 let executionCwd=sourceCwd;
 let worktreePath:string|undefined;
 if (isolation === 'worktree') {
  if (resume) {
   const compat=resumeExecutionCwd(prior, sourceCwd, 'worktree');
   if (compat.error) return blocked(`resumeFrom rejected: ${compat.error}`);
   executionCwd=compat.executionCwd!;
   if (!isWorktreeOf(sourceCwd, executionCwd, Math.max(1, remainingMs()))) {
    return blocked(`resumeFrom rejected: prior execution checkout is no longer a registered worktree of ${sourceCwd}: ${executionCwd}`);
   }
   worktreePath=executionCwd;
  } else {
   const dirty=sourceDirty(sourceCwd, Math.max(1, remainingMs()));
   if (dirty.error) return blocked(`isolation=worktree cannot inspect the source checkout: ${dirty.error}`);
   if (dirty.dirty) return blocked(`isolation=worktree requires a clean source checkout; commit or stash these changes (or use isolation=none):\n${dirty.status}`);
   worktreePath=join(dir,'worktree');
   const made=createDetachedWorktree(sourceCwd, worktreePath, Math.max(1, remainingMs()));
   if (!made.ok) return blocked(`isolation=worktree could not create a detached worktree at ${worktreePath}: ${made.error}`);
   executionCwd=worktreePath;
  }
 } else if (resume) {
  const compat=resumeExecutionCwd(prior, sourceCwd, 'none');
  if (compat.error) return blocked(`resumeFrom rejected: ${compat.error}`);
  executionCwd=compat.executionCwd!;
 }

 // Opt-in provisioning runs after the detached worktree exists and before any
 // paid worker, classifier or independent check. It is ignored for isolation
 // none, and any setup failure is its own terminal outcome, never a check
 // failure, so Pi is not started against a half-provisioned checkout.
 if (isolation === 'worktree') {
  const rawSetup = t.isolationSetup !== undefined ? t.isolationSetup : configuredIsolationSetup(sourceCwd);
  if (rawSetup !== undefined) {
   const isolationSetupFailed=(error:string)=>{
    heartbeat.setState('failed',{stopReason:'isolation_setup_failed', error});
    const out:any={ id:t.id, simulated:mock, status:'isolation_setup_failed', workerExitCode:null,
     workerError:error, checks:[], artifactDir:dir, runtime:heartbeat.snapshot(), lineage,
     sourceCwd, executionCwd, isolation:{mode:isolation, ...(worktreePath?{worktree:worktreePath}:{})} };
    writeFileSync(join(dir,'result.json'),JSON.stringify(out,null,2));
    return out;
   };
   try { validateIsolationSetup(rawSetup); }
   catch(e) { return isolationSetupFailed(`Invalid isolationSetup: ${msg(e)}`); }
   const provisioned=provisionIsolationSetup(rawSetup as IsolationSetup, sourceCwd, executionCwd, dir, { deadlineAt, checkTimeoutMs:settings.checkTimeoutMs });
   if (!provisioned.ok) return isolationSetupFailed(`isolationSetup failed: ${provisioned.error}`);
   if (provisioned.excludePatterns.length) ensureLocalExcludes(executionCwd, provisioned.excludePatterns);
  }
 }

 // Acquire advisory locks before any classifier or worker call. A held lock
 // fails fast; every lock we acquire is released in the finally below.
 const locks:LockHandle[]=[];
 const lockDir=join(sourceCwd,'.delivery','locks');
 const lockInfo={ id:t.id, artifactDir:dir, sourceCwd, executionCwd };
 const checkoutLock=acquireLock(lockDir, `checkout:${executionCwd}`, lockInfo);
 if (checkoutLock.error) return blocked(`cannot start run: ${checkoutLock.error}`);
 locks.push(checkoutLock.handle!);
 if (resume) {
  const sessionLock=acquireLock(lockDir, sessionLockKey(resume), lockInfo);
  if (sessionLock.error) {
   // The checkout lock is already held; release it before the early return so
   // a failed session-lock acquisition cannot leak the checkout lock.
   for (const l of locks) l.release();
   return blocked(`cannot start run: ${sessionLock.error}`);
  }
  locks.push(sessionLock.handle!);
 }

 // An external signal (or a real SIGINT/SIGTERM on a live run) interrupts the
 // child, preserves partial logs/evidence and still releases the locks.
 const ownController = (!deps.signal && !mock && !deps.spawnPi) ? new AbortController() : null;
 const signal = deps.signal ?? ownController?.signal;
 const onSignal=()=>{ ownController?.abort(); };
 if (ownController) { process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal); }

 try {
  heartbeat.update({phase:'readiness'});
  // Capture pre-run evidence so preexisting work is distinguishable from the
  // changes this run makes. The complete before/after pair is saved below.
  const before=collectGitEvidence(executionCwd, { timeoutMs: Math.max(1, remainingMs()) });

  // Resolve the classifier for the readiness gate before any worker is started.
  heartbeat.update({phase:'classifier'});
  const classifierBase = deps.classifierTimeoutMs ?? CLASSIFIER_TIMEOUT_MS;
  const classifierBudget = () => Math.max(1, Math.min(classifierBase, Math.max(1, remainingMs())));
  let classify:GateClassifier|undefined = deps.classify;
  if (mode !== 'off' && !classify) {
   if (mock) {
    jev!.skipped = 'mock run without an injected classifier';
   } else {
    try {
     const resolved = await raceAbort(createJevClassifier(jevProviderSetting, { gateway: deps.gateway, fetch: deps.jevFetch, pi: deps.jevPi }), classifierBudget(), signal);
     classify = resolved.classify;
     jev!.gateway = resolved.gateway;
     jev!.model = { provider: resolved.gateway, id: resolved.model, explicit: false };
     if ((classify as any).explicitModel) jev!.model.explicit = true;
    } catch (e) {
     jev!.error = `classifier unavailable: ${msg(e)}`;
    }
   }
  }

  // Resolve the contract code context once, before preflight, so the readiness
  // classifier and the worker prompt see the same bounded excerpts.
  const codeContext = resolveContext(t);

  // Preflight (readiness) gate runs before the worker. `auto` runs exactly one
  // extra Jev choice question inside this call.
  emit('preflight');
  if (mode !== 'off' && classify && !outOfTime()) {
   jev!.attempted = true;
   try {
    const preflight = await raceSignal(assessPreflight(t, classify, { workflowQuestion: explicitWorkflow === 'auto', modelProfiles, timeoutMs: classifierBudget(), context:codeContext }), signal);
    jev!.preflight = preflight;
    if (preflight.error) jev!.error = preflight.error;
   } catch (e) {
    jev!.error = `classifier unavailable: ${msg(e)}`;
   }
  }

  // Model routing is decided before the worker spawns, so every receipt and
  // argv builder below sees the final requested model.
  let modelRoute=stickyRoute ?? decideModelRoute(modelConfig, jev?.preflight?.answers?.model_profile, { eligible:routingEligible, skipped:routingSkipped, approveModel:t.approveModel, approvedProfiles:t.approvedProfiles });
  if (modelRoute.applied && !stickyRoute) {
   requested={ provider:modelRoute.provider, model:modelRoute.model };
   requestedSource='routed';
  }

  // Human consent: a target model that differs from the project pin needs a
  // run, plan or project approval before any Pi worker starts.
  let modelApproval:ModelApprovalRequest|undefined;
  if (modelRoute.needsApproval && modelRoute.profile) {
   const profile=findProfile(modelConfig, modelRoute.profile);
   if (profile) {
    modelApproval=buildModelApprovalRequest({
     target:{ profile:profile.id, provider:profile.provider, model:profile.model, confidence:modelRoute.confidence, strengths:profile.strengths },
     config:modelConfig, env:deps.env,
     reason:`Jev picked model profile '${profile.id}' at confidence ${modelRoute.confidence ?? 'unknown'}; matched strengths: ${profile.strengths}. It differs from the project default '${modelConfig.model}', so a human must approve it.`,
    });
   }
  } else if (requestedSource === 'task' && requested.model !== modelConfig.model) {
   const approval=resolveExplicitApproval(modelConfig, t, requested, prior);
   if (approval) modelRoute={...modelRoute, approval};
   else modelApproval=buildModelApprovalRequest({
    target:{ profile:null, provider:requested.provider, model:requested.model, confidence:null, strengths:null },
    config:modelConfig, env:deps.env,
    reason:`The contract requests model '${requested.model}' explicitly. It differs from the project default '${modelConfig.model}', so a human must approve it.`,
   });
  }
  if (modelApproval) {
   if (modelConfig.unapproved === 'default') {
    modelRoute={...modelRoute, needsApproval:false, declined:true,
     reason:`models.unapproved is 'default'; the recommendation was recorded but not applied: ${modelApproval.reason}`};
    modelApproval=undefined;
   } else {
    heartbeat.setState('failed',{stopReason:'needs_model_approval'});
    emit('finished needs_model_approval');
    writeFileSync(join(dir,'model-approval.json'),JSON.stringify(modelApproval,null,2));
    const out:any={ id:t.id, simulated:mock, status:'needs_model_approval', workerExitCode:null,
     workerError:modelApproval.reason, checks:[], artifactDir:dir, runtime:heartbeat.snapshot(), lineage,
     sourceCwd, executionCwd, isolation:{ mode:isolation, ...(worktreePath?{worktree:worktreePath}:{}) },
     modelRouting:modelRoute, modelApproval };
    if (mode !== 'off') out.jev=jev;
    writeFileSync(join(dir,'result.json'),JSON.stringify(out,null,2));
    return out;
   }
  }

  // The model is final and consented: remember it for the next run of this
  // deliverable so the deliverable keeps one model.
  writeStickyRoute(sourceCwd, t.id, {
   profile:modelRoute.profile ?? null,
   provider:requested.provider,
   model:requested.model,
   approval:modelRoute.approval ?? null,
  });

  // Refresh the disclosure with the final model/provider that will receive the
  // source text. A routed provider still needs its own consent.
  // Pin OpenRouter's upstream provider per deliverable so its prompt cache
  // stays warm across continuation segments, repairs and re-dispatches. The
  // affinity key is the lineage root, so a repair chain shares the provider the
  // root run selected. The selected profile is the one whose model is the
  // final requested model, with the routing's own profile preferred.
  const routedProfile = modelRoute.profile ? findProfile(modelConfig, modelRoute.profile) : null;
  const selectedProfile = routedProfile && routedProfile.model===requested.model
   ? routedProfile
   : (modelConfig.roster.find((profile)=>profile.model===requested.model) ?? null);
  const affinityKey = requested.provider==='openrouter' ? affinityKeyFor(sourceCwd, lineage.rootId ?? t.id) : null;
  const openrouterRouting = requested.provider==='openrouter' && selectedProfile?.openrouter ? selectedProfile.openrouter : null;
  const providerRouting = { affinityKey, openrouter:openrouterRouting };

  // Workflow selection is deterministic and kept separate from gate status.
  const classifierRan = mode !== 'off' && !!classify && !!jev!.preflight && !jev!.preflight.error;
  let decision = decideWorkflow(t, jev?.preflight?.answers?.workflow, classifierRan, jev?.error || jev?.preflight?.error);
  // A prior analysis or QA recommendation is never an automatic authorization to
  // change production code: a report-only parent plus `auto` cannot select
  // the code-writing test_first template. Only an explicit new workflow can.
  if (resume && isReportWorkflow(resume.parentWorkflow) && decision.selected === 'test_first' && explicitWorkflow === 'auto') {
   decision = {...decision, selected:'checks_first', source:'default', recommended:'test_first',
    note:`prior run was ${resume.parentWorkflow}; test_first requires an explicit workflow in the new contract`};
  }
  // `auto` can never authorize a QA review without a prior subject: fall back to
  // the inspect-first template and record the recommendation.
  if (decision.selected === 'qa' && explicitWorkflow === 'auto' && !review) {
   decision = {...decision, selected:'checks_first', source:'default', recommended:'qa',
    note:'qa requires reviewFrom; auto cannot authorize a QA review without a prior result' };
  }
  // Prepare check-back gate: a capable junior does the legwork first and checks
  // back before acting. When Jev flags an unclear contract or a blocking
  // assumption, or the routed playbooks include a decision/plan playbook, run
  // the prepare workflow and hand back a brief for the manager to choose from.
  // A contract already derived from a prepare brief never checks back again.
  const prepareHistory = loadPrepareHistory(sourceCwd);
  const preparePlan = jev?.preflight?.attention?.toolPlan ?? null;
  // A workflow the manager chose explicitly is never replaced (Jev is advisory,
  // ADR-0003): the check-back applies when the contract leaves `workflow` on
  // auto, or sets `checkBack: "always"`; `checkBack: "off"` disables it. When
  // it is recommended but not applied, the receipt says so.
  const checkBackMode = t.checkBack === 'always' || t.checkBack === 'off' ? t.checkBack : 'auto';
  // Clarification gate: an unclear contract (or a vague-feature routing) is
  // interviewed before any commodity work. `checkBack: "off"` disables the loop,
  // and a contract already derived from a prepare brief or a prior clarification
  // never re-enters it. An explicit workflow still clarifies a contract that
  // Jev judges unclear (ADR-0003); it is never replaced for vague-feature routing
  // alone.
  if ((t.hopFrom || deps.clarify?.hopPath || deps.clarify?.callHop)
      && clarityGateApplies({
       attention: jev?.preflight?.attention ?? null,
       workflow: explicitWorkflow,
       checkBack: checkBackMode,
       preparedFrom: t.preparedFrom,
       clarifiedFrom: t.clarifiedFrom,
       playbooks: preparePlan?.playbooks,
      })) {
   try {
    emit('clarify');
    const batch = await startClarification(t, {
      dir,
      hopPath: t.hopFrom ? resolve(sourceCwd, t.hopFrom) : deps.clarify?.hopPath,
      callHop: deps.clarify?.callHop,
      discoverReport: deps.clarify?.discoverReport ?? resolveDiscoverReport(t, sourceCwd) ?? undefined,
      playbooks: (preparePlan?.playbooks ?? []).map((p:any)=>p.id),
      maxQuestions: deps.clarify?.maxQuestions,
      maxRounds: deps.clarify?.maxRounds,
     });
     heartbeat.update({phase:'done', elapsedMs:Date.now()-runStartedAt, remainingMs:Math.max(0, remainingMs())});
     heartbeat.setState('ready_for_review',{stopReason:'needs_answers'});
     const attentionQuestions=jev?.preflight?.attention?.questions ?? [];
     const questions=batch.questions.length > 0
      ? batch.questions
      : attentionQuestions.map((question:string, i:number)=>({
       id:`Q${i+1}`,
       question,
       why:`Jev flagged the ${jev?.preflight?.attention?.part?.name ?? 'acceptance'} part of the contract`,
       suggestedAnswer:null,
       claimIds:[],
      }));
     const clarifyResult:any={ id:t.id, simulated:mock, status:'needs_answers', workerExitCode:null,
      checks:[], artifactDir:dir, jev, workflow:decision, runtime:heartbeat.snapshot(), lineage,
      sourceCwd, executionCwd, isolation:{ mode:isolation, ...(worktreePath?{worktree:worktreePath}:{}) },
      toolPlan: preparePlan, modelRouting:modelRoute,
      clarification:{ sessionId:batch.sessionId, round:batch.round, questions } };
     writeFileSync(join(dir,'result.json'),JSON.stringify(clarifyResult,null,2));
     return clarifyResult;
   } catch (e) {
    // A session that cannot open must not crash the run; record it and fall
    // through to the normal prepare/implement decision.
    emit(`clarify unavailable: ${msg(e)}`);
   }
  }
  // Clarification has no worker/provider handoff. Enforce the final disclosure
  // only once the contract is clear, immediately before Pi or a provider can
  // receive source text.
  if (externalContextRequired(requested.provider)) {
   const preflight=buildExternalContextPreflight(t, sourceCwd, requested, deps);
   externalContext={ preflight, authorization:preflight.authorization };
   writeFileSync(join(dir,'external-context-preflight.json'),JSON.stringify(preflight,null,2));
   if (!preflight.authorization.granted) {
    const request={ provider:requested.provider, destination:preflight.destination, model:requested.model,
     scope:preflight.scope, reason:preflight.authorization.reason,
     approve:{ run:'set "externalContextConsent": true in the contract, or pass a provider/project consent token', project:`junior auth consent ${requested.provider} --project ${sourceCwd}` } };
    heartbeat.setState('failed',{stopReason:'needs_external_context_consent', error:request.reason});
    emit('finished needs_external_context_consent');
    const out:any={ id:t.id, simulated:mock, status:'needs_external_context_consent', workerExitCode:null,
     workerError:`external-context consent required: ${request.reason}`, checks:[], artifactDir:dir,
     runtime:heartbeat.snapshot(), lineage, sourceCwd, executionCwd, isolation:{ mode:isolation, ...(worktreePath?{worktree:worktreePath}:{}) },
     modelRouting:modelRoute, externalContext, externalContextConsent:request };
    writeFileSync(join(dir,'result.json'),JSON.stringify(out,null,2));
    return out;
   }
  }
  // Probe the installed Pi CLI once for this non-mock run, before the first
  // spawn, and derive the isolation arguments from the task's piContext.
  let piIsolation:{applied:string[]; missing:string[]; ambient:boolean; probed:boolean; verification?:IsolationVerdict}|null=null;
  let isolationArgs:string[]=[];
  if (!mock) {
   // Offline spawn seams bypass the real CLI probe; production runs always probe.
   const capabilities = deps.piCapabilities !== undefined
    ? deps.piCapabilities
    : (deps.spawnPi || deps.spawnChild) ? null : probePiCapabilities();
   const isolationPlan = buildIsolationArgs(t.piContext, capabilities);
   isolationArgs = isolationPlan.args;
   piIsolation = { applied:isolationPlan.applied, missing:isolationPlan.missing, ambient:isolationPlan.ambient, probed:capabilities !== null };
  }
  const checkBackRecommended = typeof t.preparedFrom !== 'string' && decision.selected !== 'prepare'
      && shouldCheckBack(jev?.preflight?.attention ?? null, preparePlan, prepareHistory);
  if (checkBackRecommended && jev?.preflight?.attention) jev.preflight.attention.checkBackRecommended = true;
  if (checkBackRecommended && checkBackMode !== 'off' && (checkBackMode === 'always' || explicitWorkflow === 'auto')) {
   decision = {...decision, selected:'prepare', source:'default', recommended:'prepare',
    note:'Prepare check-back: the readiness assessment or routed playbooks call for researched options before implementation.'};
  }
  const prepareRun = decision.selected === 'prepare';
  isQa=decision.selected === 'qa';
  const reportWorkflow = isReportWorkflow(decision.selected);
  // The report path is deterministic for the run and is only appended to a
  // report-only prompt. It is never generated by Jev.
  const reportPath = prepareRun ? briefMdPath(dir) : (reportWorkflow ? analysisReportPath(dir) : null);
  const templates={ common:WORKFLOW_TEMPLATE_IDS.common, workflow:WORKFLOW_TEMPLATE_IDS[decision.selected] };
  writeFileSync(join(dir,'workflow.json'),JSON.stringify({ promptTemplateId:WORKFLOW_TEMPLATE_IDS.common, common:templates.common, selected:decision.selected, workflowTemplateId:templates.workflow, report:reportPath, decision },null,2));

  // Enforce preflight: block before spending worker cost. A required tool whose
  // manager setup is unmet (no hopFrom to record its session) is a clarify, not
  // a delegate, and is raised before the worker starts.
  if (mode === 'enforce') {
   const pf = jev!.preflight;
   const hasHop = !!(t?.hopContext?.from ?? (typeof t?.hopFrom === 'string' && t.hopFrom.trim()));
   const requiredTool = pf?.attention?.toolPlan?.tools.find((entry)=>entry.relevance === 'required') ?? null;
   const toolUnmet = !!requiredTool && !hasHop && !!pf && pf.status === 'pass';
   if (toolUnmet) {
    pf.attention = {...pf.attention, decision:'clarify', trigger:'tool_setup',
     reason:`required tool setup is unmet: ${requiredTool.tool} requires a hop handoff (hopFrom) so its session can be recorded before the worker starts.`};
   }
   const gateUnmet = !jev!.preflight || jev!.preflight.status !== 'pass';
   if (gateUnmet || toolUnmet) {
    jev!.enforced = true;
    const reason = jev!.preflight?.attention?.reason || 'Manager assessment required.';
    const blocker = toolUnmet ? 'Required tool setup is unmet; worker not started. ' : 'Jev preflight did not pass; worker not started. ';
    const preReceipt = mock ? mockReceipt({...requested,source:requestedSource}) : undefined;
    heartbeat.setState('failed',{stopReason:'blocked', error:blocker + reason});
    const blockedResult:any={ id:t.id, simulated:mock, status:'needs_review', workerExitCode:null,
     workerError:blocker + reason, receipt:preReceipt,
     cost: preReceipt ? estimateCost(preReceipt, t.pricing) : undefined,
     checks:[], artifactDir:dir, jev, workflow:decision, templates, runtime:heartbeat.snapshot(), lineage,
     sourceCwd, executionCwd, isolation:{ mode:isolation, ...(worktreePath?{worktree:worktreePath}:{}) },
     toolPlan: jev!.preflight?.attention?.toolPlan ?? null, modelRouting:modelRoute };
    writeFileSync(join(dir,'result.json'),JSON.stringify(blockedResult,null,2));
    return blockedResult;
   }
  }

  const prompt=buildPrompt(t, decision.selected, resume, reportPath, reviewContext, codeContext, jev?.preflight?.attention?.toolPlan ?? null, executionCwd);
  writeFileSync(join(dir,'prompt.txt'),prompt);
  if (reviewContext) writeFileSync(join(dir,REVIEW_CONTEXT_FILENAME),reviewContext);

  // Execute the worker. Live runs use the streaming async child lifecycle and
  // never spawnSync; the injected spawnPi seam remains for legacy offline tests.
  heartbeat.update({phase:'worker'});
  emit('worker started');
  const eventsPath=join(dir,'events.jsonl');
  const logPath=join(dir,'worker.log');
  let stdout='', stderr='', legacyError:string|undefined;
  let workerStatus=0;
  let streamResult:WorkerStreamResult|undefined;
  type SegmentRecord={index:number; eventsPath:string; stopReason:string; outputTruncated:boolean; outputLimited:boolean; checkpointPath:string|null};
  const segments:SegmentRecord[]=[];
  const segmentReceipts:Receipt[]=[];
  const preInterrupt = !!signal?.aborted;
  const preDeadline = !preInterrupt && workerOutOfTime();
  // Pi's own bash timeout must fire before Junior's watchdog so a slow command
  // fails only that tool call and returns a tool error to the model. The guard
  // also confines writes to the execution checkout and keeps a worktree run out
  // of the source checkout.
  const piBashEnv:any = { ...(deps.env ?? process.env), JUNIOR_PI_BASH_TIMEOUT_S: String(piBashTimeoutSeconds(settings.toolTimeoutMs)) };
  const piOverlay=preparePiAgentOverlay(dir,piBashEnv);
  if (!piOverlay.dir) return blocked(`Pi worker was not started: ${piOverlay.error}. Ensure the repository .delivery directory is writable.`);
  piBashEnv.PI_CODING_AGENT_DIR=piOverlay.dir;
  if (isolation === 'worktree') {
   piBashEnv.JUNIOR_PI_WRITE_ROOTS = [executionCwd, dir].join(delimiter);
   piBashEnv.JUNIOR_PI_SOURCE_ROOT = sourceCwd;
  } else {
   piBashEnv.JUNIOR_PI_WRITE_ROOTS = [sourceCwd, dir].join(delimiter);
   delete piBashEnv.JUNIOR_PI_SOURCE_ROOT;
  }
  if (affinityKey) piBashEnv.JUNIOR_PI_AFFINITY_KEY = affinityKey;
  else delete piBashEnv.JUNIOR_PI_AFFINITY_KEY;
  if (openrouterRouting) piBashEnv.JUNIOR_PI_OPENROUTER_ROUTING = JSON.stringify(openrouterRouting);
  else delete piBashEnv.JUNIOR_PI_OPENROUTER_ROUTING;
  if (mock) {
   stdout='Simulation only; no implementation performed.';
   writeFileSync(eventsPath,stdout);
   writeFileSync(logPath,'');
   segments.push({index:0,eventsPath,stopReason:'mock',outputTruncated:false,outputLimited:false,checkpointPath:null});
  } else if (preInterrupt || preDeadline) {
   // The wall deadline (or an interruption) elapsed during readiness, isolation
   // or the classifier. Never start the paid worker; keep an inspectable handback.
   writeFileSync(eventsPath,''); writeFileSync(logPath,'');
   workerStatus=1;
   streamResult = { stdout:'', stderr:'', exitCode:null, signal:null,
    interrupted:preInterrupt, timedOut:false, deadlineExceeded:preDeadline, outputTruncated:false,
    stopReason: preInterrupt ? 'interrupted' : 'deadline_exceeded', runtime:heartbeat.snapshot() };
   segments.push({index:0,eventsPath,stopReason:streamResult.stopReason,outputTruncated:false,outputLimited:false,checkpointPath:null});
  } else if (deps.spawnPi) {
   const spawnTimeout=Math.max(1, Math.min(600000, 600000, Math.max(1, workerRemainingMs())));
   const r=deps.spawnPi('pi',[...buildPiArgs(requested, resume?.parentSessionId ?? null, t.thinking ?? 'low', piGuardModulePath(), isolationArgs),prompt],{cwd:executionCwd,encoding:'utf8',timeout:spawnTimeout,maxBuffer:33554432,env:piBashEnv});
   stdout=r.stdout || ''; stderr=r.stderr || '';
   workerStatus=r.status ?? (r.error ? 1 : 0);
   legacyError=r.error?.message;
   writeFileSync(eventsPath,stdout);
   writeFileSync(logPath,stderr);
   segments.push({index:0,eventsPath,stopReason:'legacy',outputTruncated:false,outputLimited:false,checkpointPath:null});
  } else {
   const spawnChild = deps.spawnChild ?? spawnChildDetached;
   const maxSegmentOutputBytes = deps.maxOutputBytes ?? settings.maxOutputBytes;
   let segmentPrompt = prompt;
   let continuationIndex = 0;
   for (;;) {
    // Continuation segments are new sessions (no --session) so a capped model
    // gets a fresh context with the checkpoint instead of a truncated history.
    const segEventsPath = continuationIndex === 0 ? eventsPath : join(dir, `events-${continuationIndex}.jsonl`);
    const segLogPath = continuationIndex === 0 ? logPath : join(dir, `worker-${continuationIndex}.log`);
    const sessionId = continuationIndex === 0 ? (resume?.parentSessionId ?? null) : null;
    const segResult = await executeWorkerStreaming({
     spawnChild, command:'pi',
     args:[...buildPiArgs(requested, sessionId, t.thinking ?? 'low', piGuardModulePath(), isolationArgs),segmentPrompt],
     cwd:executionCwd, env:piBashEnv, eventsPath:segEventsPath, logPath:segLogPath, runtimePath, settings, deadlineAt:workerDeadlineAt(),
     phase:'worker', signal, heartbeat, maxOutputBytes: maxSegmentOutputBytes,
    });
    stdout=segResult.stdout; stderr=segResult.stderr;
    workerStatus=segResult.exitCode ?? 1;
    legacyError=segResult.error;
    streamResult=segResult;
    const segReceipt=parseReceipt(segResult.stdout ?? '', {...requested,source:requestedSource}, {outputTruncated: !!segResult.outputTruncated});
    segmentReceipts.push(segReceipt);
    segments.push({index:continuationIndex,eventsPath:segEventsPath,stopReason:segResult.stopReason,outputTruncated:!!segResult.outputTruncated,outputLimited:segReceipt.outputLimited,checkpointPath:null});
    // Continue when the segment hit the accumulation cap or the model's
    // per-message output limit; both leave the deliverable unfinished.
    if (!segResult.outputTruncated && !segReceipt.outputLimited) break;
    if (continuationIndex >= settings.continuations) break;
    if (workerRemainingMs() < 60000) break;
    const nextIndex = continuationIndex + 1;
    const checkpointPath = join(dir, `checkpoint-${nextIndex}.md`);
    const checkpointText = buildContinuationCheckpoint(executionCwd, t, segEventsPath);
    writeFileSync(checkpointPath, checkpointText);
    segments[segments.length-1].checkpointPath = checkpointPath;
    segmentPrompt = `${prompt}\n\n${CONTINUATION_PROMPT_LEAD}\n\n${checkpointText}`;
    if (segReceipt.outputLimited) segmentPrompt += `\n\n${OUTPUT_LIMIT_CONTINUATION_LINE}`;
    continuationIndex = nextIndex;
    // The next segment starts clean: clear the previous segment's cap stop so
    // runtime.json reflects only the segment that actually ends the run.
    heartbeat.setState('running', { outputTruncated: false, stopReason: null } as any);
   }
  }
  // The receipt reflects the final segment so readiness/validity is judged on
  // what the last segment actually completed; token usage and cost sum every
  // segment so the run is not under-reported.
  let receipt:Receipt;
  if (mock) {
   receipt=mockReceipt({...requested,source:requestedSource});
  } else if (segmentReceipts.length) {
   receipt=segmentReceipts[segmentReceipts.length-1];
   const totalUsage=emptyUsage();
   for (const r of segmentReceipts) addUsage(totalUsage, r.usage);
   receipt.usage=totalUsage;
   const ids=new Set<string>();
   const generations:Receipt['generations']=[];
   for (const r of segmentReceipts) {
    for (const id of r.responseIds) ids.add(id);
    for (const g of r.generations) generations.push(g);
   }
   receipt.responseIds=[...ids];
   receipt.generations=generations;
  } else {
   receipt=parseReceipt(stdout,{...requested,source:requestedSource},{outputTruncated: !!streamResult?.outputTruncated});
   if (streamResult?.outputTruncated) receipt.outputTruncated = true;
  }
  const receiptOk=mock || receiptValid(receipt);

  // Independent checks run only after a clean worker, and each is bounded by
  // both the remaining wall deadline and the per-tool limit.
  let workerRan=mock || (workerStatus === 0 && receiptOk);
  let checks:any[]=[];
  let interruptedDuringChecks=false;
  let deadlineDuringChecks=false;
  const stopped = !!streamResult && (streamResult.timedOut || streamResult.deadlineExceeded || streamResult.interrupted);
  // A worker stopped by its reserved worker deadline still runs the contract's
  // checks (bounded by the remaining total wall deadline); an interruption, a
  // per-tool timeout or a fatal stream/persist error never does.
  const workerDeadlineStopped = !!streamResult && streamResult.deadlineExceeded && !streamResult.interrupted && !streamResult.timedOut
   && !streamResult.streamError && !streamResult.persistError;
  // A worker stopped at the output cap never runs its checks: the receipt is
  // incomplete and the run is reported as output_truncated.
  const checksEligible = !streamResult?.outputTruncated && (stopped ? workerDeadlineStopped : (workerStatus === 0 && receiptOk));
  if (checksEligible) {
   for (let i=0;i<t.checks.length;i++) {
    const rem=remainingMs();
    if (rem <= 0) { deadlineDuringChecks=true; break; }
    const c=t.checks[i];
    emit(`check ${i+1}/${t.checks.length}`);
    const timeout=Math.max(1, Math.min(settings.checkTimeoutMs, settings.toolTimeoutMs, rem));
    const resolved=resolveCheckCwd(c.cwd, sourceCwd, executionCwd);
    if (resolved.error) {
     writeFileSync(join(dir,`check-${i}.log`),`${resolved.error}\n`);
     checks.push({...c,exitCode:null,error:resolved.error,timedOut:false,interrupted:false,outputTruncated:false});
     continue;
    }
    const checkCwd=resolved.cwd!;
    const r=await executeCheck({ spawnChild:spawnChildDetached, command:c.command, args:c.args, cwd:checkCwd,
     timeoutMs:timeout, deadlineAt, signal, maxOutputBytes:deps.maxOutputBytes, heartbeat });
    writeFileSync(join(dir,`check-${i}.log`),`${r.stdout || ''}\n${r.stderr || ''}`);
    checks.push({...c,cwd:checkCwd,exitCode:r.exitCode,error:r.error,timedOut:r.timedOut,interrupted:r.interrupted,outputTruncated:r.outputTruncated});
    if (r.interrupted || signal?.aborted) { interruptedDuringChecks=true; break; }
    if (r.deadlineExceeded) { deadlineDuringChecks=true; break; }
   }
  }
  let workerError=legacyError;
  if (!workerError && streamResult?.interrupted) workerError='Run interrupted by signal; partial logs and edits preserved.';
  if (!workerError && streamResult?.deadlineExceeded) workerError='Total wall deadline exceeded; Pi process group was stopped.';
  if (!workerError && streamResult?.timedOut) workerError='Tool execution exceeded the per-tool timeout; Pi process group was stopped.'+ (streamResult.timedOutTool ? ` ${timedOutToolLine(streamResult.timedOutTool)}.` : '');
  if (!workerError && streamResult?.streamError) workerError=`Worker output stream failed: ${streamResult.streamError}`;
  if (!workerError && streamResult?.persistError) workerError=`Could not persist worker logs/events: ${streamResult.persistError}`;
  if (!workerError && streamResult?.outputTruncated) workerError='Worker output exceeded the accumulation cap; the worker was stopped.';
  if (!workerError && workerStatus !== 0) workerError=String(stderr).includes('No API key found for openrouter') ? 'OpenRouter authentication missing. Start pi and use /login to configure OpenRouter, then retry.' : 'Pi failed; inspect worker.log.';
  if (!workerError && receipt.outputLimited) workerError=OUTPUT_LIMIT_ERROR;
  if (!workerError && !receiptOk) workerError = receipt.malformed ? 'Pi event stream contained malformed JSONL; inspect events.jsonl.' : receipt.errored || receipt.aborted ? 'Pi assistant message did not complete cleanly.' : receipt.assistantMessages === 0 ? 'Pi settled with no assistant messages.' : 'Pi never reported agent_settled; inspect events.jsonl.';

  // Capture post-run evidence and the run-only delta even after a timeout,
  // deadline breach or interruption, and persist the complete evidence pair.
  const after=collectGitEvidence(executionCwd, { timeoutMs: Math.max(1, remainingMs()) });
  const evidence=evidenceDelta(before, after);
  let scopeResult:ScopeResult|undefined;
  if (t.scope) {
   let projectConfig:any={};
   try {
    const configPath=join(sourceCwd,'delivery.config.json');
    if (existsSync(configPath)) projectConfig=JSON.parse(readFileSync(configPath,'utf8'));
   } catch { projectConfig={}; }
   scopeResult=classifyScope(evidence.runChangedFiles, t.scope.owned, {
    incidental: t.scope.incidental ?? incidentalGlobsFromConfig(projectConfig),
    repo: basename(sourceCwd),
   });
  }
  writeFileSync(join(dir,'evidence.json'),JSON.stringify({
   sourceCwd, executionCwd, isolation,
   before: evidence.before, after: evidence.after,
   runChangedFiles: evidence.runChangedFiles, preexistingFiles: evidence.preexistingFiles,
   changed: evidence.changed,
  },null,2));

  // Postflight (completion) gate runs against the independent checks and the
  // complete bounded evidence.
  heartbeat.update({phase:'postflight'});
  emit('postflight');
  if (mode !== 'off' && classify && workerRan && !stopped && !outOfTime()) {
   const git = deps.git ?? after;
   let report:ReportEvidence|undefined;
   if (reportWorkflow && reportPath && existsSync(reportPath)) {
    try { report=reportEvidence(readFileSync(reportPath,'utf8'),reportPath); } catch {}
   }
   const allowed = reportPath && withinWorkspace(executionCwd, reportPath) ? [relative(executionCwd, reportPath)] : [];
   try {
    const postflight = await raceSignal(assessPostflight(t, classify, checks, git, classifierBudget(), evidence, {report,allowed}), signal);
    jev!.postflight = postflight;
    if (postflight.error) jev!.error = postflight.error;
   } catch (e) {
    jev!.error = `classifier unavailable: ${msg(e)}`;
   }
  }

  // Terminal status. No success is ever reported after the wall deadline.
  let status:string;
  if (streamResult?.interrupted || signal?.aborted) status='interrupted';
  else if (streamResult?.timedOut) status='worker_failed';
  else if (streamResult?.outputTruncated) status='output_truncated';
  else if (streamResult?.deadlineExceeded || deadlineDuringChecks || outOfTime()) status='deadline_exceeded';
  else if (streamResult?.persistError || streamResult?.streamError) status='worker_failed';
  else if (workerStatus !== 0) status='worker_failed';
  else if (!receiptOk) status='receipt_failed';
  else if (checks.some((c:any)=>c.exitCode !== 0 || c.error || c.timedOut || c.outputTruncated)) status='checks_failed';
  else status= mock ? 'simulation_passed' : 'ready_for_review';

  // A mock prepare run has no model to author the brief, so synthesize a
  // well-formed placeholder; a live run reads (and augments) what the worker
  // wrote. The brief always carries the routed playbooks so the correction-rate
  // history can be attributed to them.
  if (prepareRun && mock && !existsSync(briefPath(dir))) {
   const placeholder = buildPlaceholderBrief(t);
   writeFileSync(briefPath(dir), JSON.stringify(placeholder, null, 2));
   writeFileSync(briefMdPath(dir), renderBrief(placeholder));
  }
  let prepareBrief:any=null;
  if (prepareRun && existsSync(briefPath(dir))) {
   try { prepareBrief=JSON.parse(readFileSync(briefPath(dir),'utf8')); } catch { prepareBrief=null; }
   if (prepareBrief) {
    prepareBrief.playbooks=(preparePlan?.playbooks ?? []).map((p:any)=>p.id);
    writeFileSync(briefPath(dir), JSON.stringify(prepareBrief, null, 2));
   }
  }

  // An analysis-only workflow reports completion only when its deterministic
  // report exists in the run artifact directory. A missing report downgrades an
  // otherwise-passing run; it never upgrades a failure. This is a contract
  // boundary, not a sandbox guarantee.
  const reportPresent = reportPath ? existsSync(reportPath) : false;
  const analysis = reportWorkflow && reportPath ? { workflow:decision.selected, report:reportPath, reportPresent } : undefined;
  if (analysis && (status === 'simulation_passed' || status === 'ready_for_review') && !reportPresent) {
   status='needs_review';
   workerError = workerError || `Analysis report missing: expected ${reportPath}; analysis-only workflows report completion only after the report exists.`;
  }
  // A completed prepare run stops at a choice, not at review: the manager must
  // pick an option before any implementation.
  if (prepareRun && prepareBrief && (status === 'simulation_passed' || status === 'ready_for_review' || status === 'needs_review')) {
   status='needs_choice';
  }

  // QA is report-only. If the reviewer changed production files despite the
  // instruction, the existing evidence delta flags it as needs_review; there is
  // no automatic remediation.
  if (isQa && evidence.changed && (status === 'simulation_passed' || status === 'ready_for_review')) {
   status='needs_review';
   workerError = workerError || `QA run changed production files despite report-only instructions: ${evidence.runChangedFiles.map((f:any)=>f.path).join(', ')}`;
  }

  // Enforce can only downgrade an otherwise-passing run; it never upgrades
  // worker/checks failures.
  if (mode === 'enforce' && (status === 'simulation_passed' || status === 'ready_for_review')) {
   const bad = !jev!.preflight || jev!.preflight.status !== 'pass' || !jev!.postflight || jev!.postflight.status !== 'pass';
   if (bad) { status = 'needs_review'; jev!.enforced = true; }
  }

  emit(`finished ${status}`);
  // Finalize the shared runtime heartbeat with the terminal state.
  heartbeat.update({phase:'done', elapsedMs:Date.now()-runStartedAt, remainingMs:Math.max(0, remainingMs())});
  if (status === 'ready_for_review' || status === 'simulation_passed') heartbeat.setState('ready_for_review',{stopReason:status==='simulation_passed'?'simulation_passed':'ready_for_review'});
  else if (status === 'interrupted') heartbeat.setState('interrupted',{interrupted:true, stopReason:'interrupted'});
  else if (status === 'deadline_exceeded') heartbeat.setState('deadline_exceeded',{deadlineExceeded:true, stopReason:'deadline_exceeded'});
  else if (streamResult?.timedOut) heartbeat.setState('tool_timed_out',{timedOut:true, stopReason:'tool_timed_out'});
  else heartbeat.setState('failed',{stopReason:status});

  // Optional bounded authoritative OpenRouter billing capture. It never changes
  // the primary outcome; when billing is unavailable the concise reason is kept
  // as a recorded limitation.
  let billing:BillingCapture|undefined;
  if (!mock && t.billing) {
   const budgetMs = typeof t.billing.timeoutMs === 'number' ? t.billing.timeoutMs : BILLING_DEFAULT_TIMEOUT_MS;
   try {
    billing = await raceSignal(captureBilling(receipt, t.billing, { timeoutMs:budgetMs, deadlineAt }, {
     fetch:deps.billingFetch,
     resolveApiKey:deps.billingResolveApiKey ?? resolveOpenRouterKey,
    }), signal);
   } catch {
    billing = { billedUsd:null, source:null, reason:'billing lookup interrupted', generationCount:0, capturedCount:0, providers:[] };
   }
  }

  const runtime=heartbeat.snapshot();
  const result:any={id:t.id,simulated:mock,status,workerExitCode:workerStatus,workerError,receipt,cost:estimateCost(receipt,t.pricing,billing),checks,artifactDir:dir,workflow:decision,templates,runtime,lineage,outputTruncated: streamResult?.outputTruncated ?? false,segments,modelRouting:modelRoute,providerRouting,outputBreakdown: streamResult?.outputBreakdown ?? null};
  result.toolPlan=jev?.preflight?.attention?.toolPlan ?? null;
  // Verify against Pi's own system message that the applied isolation took
  // effect, so a Pi upgrade that ignores a flag is reported, not assumed.
  if (piIsolation && piIsolation.applied.length > 0 && segments[0] && existsSync(segments[0].eventsPath)) {
   try {
    piIsolation.verification=verifyIsolation(readFileSync(segments[0].eventsPath,'utf8'), {
     applied: piIsolation.applied,
     tools: Array.isArray(t.piContext?.tools) ? t.piContext.tools : [...DEFAULT_PI_TOOLS],
    });
   } catch { /* an unreadable event stream leaves the run unverified */ }
  }
  if (piIsolation) result.piIsolation=piIsolation;
  if (externalContext) result.externalContext=externalContext;
  if (scopeResult) result.scope=scopeResult;
  if (prepareRun) { result.brief=prepareBrief; result.checkBack={ required:prepareBrief !== null, historyCount:prepareHistory.length }; }
  result.unresolved=[];
  if (streamResult?.timedOut && streamResult.timedOutTool) {
   result.timedOutTool={ name:streamResult.timedOutTool.name, command:streamResult.timedOutTool.command ?? null };
   result.unresolved.push(timedOutToolLine(streamResult.timedOutTool));
  }
  if (receipt.outputLimited) result.unresolved.push(OUTPUT_LIMIT_ERROR);
  if (billing) result.billing={ source:billing.source, billedUsd:billing.billedUsd, reason:billing.reason ?? null, generationCount:billing.generationCount, capturedCount:billing.capturedCount, providers:billing.providers ?? [] };
  result.sourceCwd=sourceCwd;
  result.executionCwd=executionCwd;
  result.isolation={ mode:isolation, ...(worktreePath?{worktree:worktreePath}:{}) };
  result.evidence={
   artifact:join(dir,'evidence.json'),
   changedFiles:after.changedFiles,
   runChangedFiles:evidence.runChangedFiles,
   preexistingFiles:evidence.preexistingFiles,
   truncated:after.truncated,
   unavailable:after.unavailable,
  };
  result.cache={ reuse:'best effort', guaranteed:false,
   note:'Pi session/prompt cache reuse is best effort and never guaranteed. Observed cacheRead counters and requested/observed model stay in the receipt; no actual billing is claimed.' };
  if (resume) result.resume={ from:resume.from, parentResult:resume.parentResult, parentSessionId:resume.parentSessionId,
   parentWorkflow:resume.parentWorkflow, sessionId:receipt.sessionId || resume.parentSessionId, requested };
  if (isRepair) result.repair={ from:resume?.from, parentSessionId:resume?.parentSessionId, rootId:lineage.rootId, repairs:lineage.repairs, maxRepairs:lineage.maxRepairs };
  if (t.hopContext) result.handoff={from:t.hopContext.from,projectId:t.hopContext.projectId,revision:t.hopContext.revision,managerAcceptance:t.hopContext.managerAcceptance};
  if (review) result.review={ from:review.from, priorResult:review.priorResult, context:join(dir,REVIEW_CONTEXT_FILENAME) };
  if (mode !== 'off') result.jev=jev;
  if (analysis) result.analysis=analysis;
  writeFileSync(join(dir,'result.json'),JSON.stringify(result,null,2));
  return result;
 } finally {
  for (const l of locks) l.release();
  if (ownController) { process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); }
 }
}

export function status(path:string) {
 let raw:string;
 try { raw=readFileSync(path,'utf8'); } catch { throw Error(`Cannot read result file: ${path}`); }
 let result:any;
 try { result=JSON.parse(raw); } catch { throw Error(`Invalid JSON in result file: ${path}`); }
 if (!result || typeof result!=='object' || Array.isArray(result)) throw Error('Malformed result: expected an object');
 if (typeof result.id!=='string' || !result.id.trim()) throw Error('Malformed result: missing id');
 if (typeof result.status!=='string' || !result.status.trim()) throw Error('Malformed result: missing status');
 if (!Array.isArray(result.checks)) throw Error('Malformed result: missing checks');
 if (typeof result.artifactDir!=='string' || !result.artifactDir.trim()) throw Error('Malformed result: missing artifactDir');
 const out:any={id:result.id,outcome:result.status,checks:result.checks,artifactDir:result.artifactDir};
 // Old result files have no receipt; expose it only when present.
 if (result.receipt && typeof result.receipt === 'object') out.receipt=result.receipt;
 // Estimated cost is optional and only present on results that carry it.
 if (result.cost && typeof result.cost === 'object') out.cost=result.cost;
 // Jev gate records are optional and only present for jev-enabled tasks.
 if (result.jev && typeof result.jev === 'object') out.jev=result.jev;
 // Workflow selection, template IDs, continuation and cache note are optional.
 if (result.workflow && typeof result.workflow === 'object') out.workflow=result.workflow;
 if (result.templates && typeof result.templates === 'object') out.templates=result.templates;
 if (result.resume && typeof result.resume === 'object') out.resume=result.resume;
 if (result.cache && typeof result.cache === 'object') out.cache=result.cache;
 // Isolation/execution checkout and complete evidence are optional additions.
 if (typeof result.sourceCwd === 'string') out.sourceCwd=result.sourceCwd;
 if (typeof result.executionCwd === 'string') out.executionCwd=result.executionCwd;
 if (result.isolation && typeof result.isolation === 'object') out.isolation=result.isolation;
 if (result.evidence && typeof result.evidence === 'object') out.evidence=result.evidence;
 // Runtime heartbeat, lineage/repair budget and worker error are optional.
 if (result.runtime && typeof result.runtime === 'object') out.runtime=result.runtime;
 if (result.lineage && typeof result.lineage === 'object') out.lineage=result.lineage;
 if (result.repair && typeof result.repair === 'object') out.repair=result.repair;
 if (result.analysis && typeof result.analysis === 'object') out.analysis=result.analysis;
 if (result.review && typeof result.review === 'object') out.review=result.review;
 if (typeof result.workerError === 'string') out.workerError=result.workerError;
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
