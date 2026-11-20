import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { PolicyEvent } from './policy-events.ts';
import { loadHopContext } from './hop-context.ts';
import { resolveIsolation, sourceDirty, createDetachedWorktree, worktreeWriteRemediation, isWorktreeOf, acquireLock, ensureLocalExcludes, validateIsolationSetup, provisionIsolationSetup, configuredIsolationSetup, type IsolationMode, type LockHandle, type IsolationSetup } from './isolation.ts';
import { resolveExecutionSettings, RuntimeHeartbeat, type ExecutionSettings } from './runtime.ts';
import { loadModelConfig, rosterChoiceCriteria, findProfile } from './roster.ts';
import type { ModelConfig } from './roster.ts';
import { assertCommodity, ModelPolicyError } from './model-policy.ts';
import { collectGitEvidence } from './evidence.ts';
import { resolveDiscoverReport, startClarification } from './clarify.ts';
import { sessionLockKey, loadResume, resumeExecutionCwd, REVIEW_PROMPT_MAX_CHARS, loadReview, type ResumeInfo } from './worker-resume.ts';
import { importResumeSession } from './pi-overlay.ts';
import { DEFAULT_JEV, jevMode, readStickyRoute, stickyApprovalHolds, writeStickyRoute } from './worker-approval.ts';
import type { ModelPolicyRecord, ModelRoute } from './worker-approval.ts';
import { CLASSIFIER_TIMEOUT_MS, assessPreflight, createJevClassifier, readProjectJevProvider, raceSignal, raceAbort } from './worker-gates.ts';
import type { GateClassifier, GateDeps, JevGateRecord } from './worker-gates.ts';
import { buildExternalContextPreflight, externalContextRequired, resolveCommandPolicy, resolveContext } from './worker-contract.ts';
import { contractFeature, matrixContextFor, type MatrixContext } from './matrix-context.ts';
import type { ReceiptModelSource } from './worker-contract.ts';
import { taskWorkflow } from './worker-workflows.ts';
import { readDataPolicy } from './data-policy.ts';
import { isolationRecord, decideRoute, settleModelApproval, settleBudgetApproval, applyDataPolicy, runTicketGate, clarificationApplies, prepareWorkflowDecision, finishPreflight, type PreflightCtx } from './worker-preflight-phases.ts';

import type { JevProvider } from './gateway.ts';
import { systemClock, type Clock } from './clock.ts';

/** Shared error-message coercion, used across the worker modules. */
const msg=(e:unknown)=>e instanceof Error ? e.message : String(e);

/** The explicit state one worker run carries between its phases (ADR 0015 X5). */
export interface RunState {
 t:any; mock:boolean; deps:GateDeps; settings:ExecutionSettings;
 sourceCwd:string; executionCwd:string; isolation:IsolationMode; dir:string;
 requested:{ provider:string; model:string }; modelConfig:ModelConfig;
 deadlineAt:number; heartbeat:RuntimeHeartbeat; emit:(line:string)=>void;
 resume:any; review:any; lineage:any; decision:any; jev:any;
 signal?:AbortSignal; locks:LockHandle[];
 /** The run's clock (`deps.clock`, default `systemClock`); the runtime layer reads `state.clock`. */
 clock:Clock;
 /** #281: typed policy events recorded by guards during the run (see policy-events.ts). */
 policyEvents?:PolicyEvent[];
 // phase outputs are added as optional fields: prompt, receipt, streamResult, checks, workerError, status
 prompt?:string; receipt?:any; streamResult?:any; checks?:any[]; workerError?:string; status?:string;
 release?:()=>void;
 [key:string]:any;
}

/** Deadline arithmetic shared by every phase; `state.deadlineAt` is authoritative. */
/** The run's clock and current time. A state built without `clock` uses its
 * heartbeat's clock (the runtime's), then the system clock. */
export const runClock=(state:RunState):Clock=>state.clock ?? state.heartbeat?.clock ?? systemClock;
export const runNow=(state:RunState)=>runClock(state).now();
export const remainingMs=(state:RunState)=>state.deadlineAt-runNow(state);
export const outOfTime=(state:RunState)=>runNow(state) >= state.deadlineAt;
// The worker is stopped before the total deadline so the reserved budget is
// available to the contract's checks, which remain bounded by the total wall
// deadline.
export const workerDeadlineAt=(state:RunState)=>state.deadlineAt-state.settings.checkReserveMs;
export const workerRemainingMs=(state:RunState)=>workerDeadlineAt(state)-runNow(state);
export const workerOutOfTime=(state:RunState)=>runNow(state) >= workerDeadlineAt(state);
export const classifierBudget=(state:RunState)=>Math.max(1, Math.min(state.classifierBase, Math.max(1, remainingMs(state))));

/** Every pre-worker refusal writes an inspectable result plus a runtime heartbeat. */
export function blockedResult(state:RunState, workerError:string, extra:any={}):any {
 const {heartbeat, emit, mock, t, dir, lineage}=state;
 heartbeat.setState('failed',{stopReason:'blocked', error:workerError});
 emit('finished needs_review');
 const out:any={ id:t.id, simulated:mock, status:'needs_review', workerExitCode:null,
  workerError, checks:[], artifactDir:dir, runtime:heartbeat.snapshot(), lineage, ...extra };
 writeFileSync(join(dir,'result.json'),JSON.stringify(out,null,2));
 return out;
}

/** Create the run directory, model request and runtime heartbeat before any phase runs. */
export function createRunState(t:any, mock:boolean, deps:GateDeps):RunState {
 const clock=deps.clock ?? systemClock;
 const runStartedAt=clock.now();
 const settings=resolveExecutionSettings(t);
 const sourceCwd=resolve(t.cwd);
 const isolation=resolveIsolation(t).mode;
 // Record Junior's own run-artifact tree in the repository-local exclude before
 // the first artifact is written, so `.delivery/` never surfaces as a target
 // change. A non-git cwd has nothing to touch and is left alone.
 ensureLocalExcludes(sourceCwd, ['/.delivery/']);
 const stamp=String(clock.now());
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
 const heartbeat=new RuntimeHeartbeat(runtimePath, settings, runStartedAt, deadlineAt, 'readiness', deps.progress, clock);
 heartbeat.begin();
 emit('readiness');
 return { t, mock, deps, settings, sourceCwd, executionCwd:sourceCwd, isolation, dir,
  requested, requestedSource, modelConfig, deadlineAt, heartbeat, emit,
  resume:undefined, review:undefined, lineage:undefined, decision:undefined, jev,
  signal:undefined, locks:[], clock, runStartedAt, mode, jevProviderSetting, runtimePath,
  explicitProvider, explicitModel, modelProfile };
}

function initLineage(state:RunState, c:PreflightCtx):any {
 const {heartbeat, runStartedAt} = state;
 const t=c.t;
 c.lineage={ rootId:t.id, repairs:0,
  maxRepairs: typeof t.maxRepairs==='number' ? t.maxRepairs : 1,
  deadlineAt: typeof t.lineageDeadlineMs==='number' ? new Date(runStartedAt+t.lineageDeadlineMs).toISOString() : null };
 state.lineage=c.lineage;
 // ADR 0018 R3: a ticket id must be a non-empty string. Reject it here, before
 // the ticket adapter or any provider can make a network call.
 if (t.ticket !== undefined && (typeof t.ticket!=='string' || !t.ticket.trim())) {
  return blockedResult(state, 'Invalid ticket (expected a non-empty string)');
 }
 // One absolute lineage deadline (when supplied) also bounds this root run, so
 // a whole recovery chain shares a single wall-clock budget.
 if (typeof t.lineageDeadlineMs==='number') {
  c.deadlineAt=Math.min(c.deadlineAt, runStartedAt+t.lineageDeadlineMs);
  state.deadlineAt=c.deadlineAt;
  heartbeat.update({ deadlineAt:new Date(c.deadlineAt).toISOString(), remainingMs:Math.max(0, c.deadlineAt-runNow(state)) });
 }
 return undefined;
}

function resolvePinnedModel(state:RunState, c:PreflightCtx):any {
 const {modelConfig, modelProfile} = state;
 // A contract may pin a roster profile. The pin still needs human consent when
 // it differs from the project default, exactly like an explicit model.
 c.pinnedProfile=modelProfile ? findProfile(modelConfig, modelProfile) : null;
 if (modelProfile && !c.pinnedProfile) return blockedResult(state, `modelProfile '${modelProfile}' is not in the roster`);
 if (c.pinnedProfile) {
  c.requested={ provider:c.pinnedProfile.provider, model:c.pinnedProfile.model };
  c.requestedSource='task';
 }

 // Commodity-only executor policy: refuse a frontier or unknown requested
 // model before any classifier or worker cost, including mock runs.
 let modelPolicy:ModelPolicyRecord|undefined;
 try {
  assertCommodity(c.requested.provider, c.requested.model);
 } catch (e) {
  if (!(e instanceof ModelPolicyError)) throw e;
  modelPolicy={ provider:c.requested.provider, model:c.requested.model, class:e.verdict.class, reason:e.verdict.reason, code:e.code };
  return blockedResult(state, `${e.code}: ${e.verdict.reason}`, { modelPolicy });
 }
 return undefined;
}

function routingSkipReason(state:RunState, pinned:boolean, resumeRequested:boolean, sticky:boolean):string|undefined {
 const {modelConfig, mode, explicitProvider, explicitModel} = state;
 if (explicitProvider || explicitModel) return 'explicit task model';
 if (pinned) return 'explicit task model';
 if (resumeRequested) return 'resume keeps the prior model';
 if (sticky) return "sticky: reused the deliverable's earlier model";
 if (mode === 'off') return 'jev off';
 if (modelConfig.routing === 'off') return 'routing off';
 if (modelConfig.roster.length < 2) return 'roster has fewer than two profiles';
 return undefined;
}

function resolveRoutingEligibility(state:RunState, c:PreflightCtx):void {
 const {sourceCwd, modelConfig, mode, explicitProvider, explicitModel} = state;
 const t=c.t;
 const pinnedProfile=c.pinnedProfile;
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
  c.requested={ provider:sticky.provider, model:sticky.model };
  c.requestedSource='routed';
  stickyRoute={ mode, eligible:false, profile:sticky.profile, confidence:null,
   applied:sticky.model !== modelConfig.model, provider:sticky.provider, model:sticky.model,
   reason:"sticky: reused the deliverable's earlier model",
   ...(sticky.approval?{approval:sticky.approval}:{}) };
 }
 const routingSkipped=routingSkipReason(state, !!pinnedProfile, resumeRequested, !!stickyRoute);
 const routingEligible=routingSkipped === undefined;
 c.stickyRoute=stickyRoute;
 c.routingSkipped=routingSkipped;
 c.routingEligible=routingEligible;
 c.modelProfiles=routingEligible ? rosterChoiceCriteria(modelConfig.roster) : undefined;
}

function initialExternalContext(state:RunState, c:PreflightCtx):void {
 const {deps, sourceCwd, dir} = state;
 // External-context preflight: before any classifier or worker provider call,
 // disclose the destination/model/scope and require recorded consent. Without
 // it the run fails closed with an inspectable request, never a paid attempt.
 c.externalContext=null;
 if (externalContextRequired(c.requested.provider)) {
  const preflight=buildExternalContextPreflight(c.t, sourceCwd, c.requested, deps);
  c.externalContext={ preflight, authorization:preflight.authorization };
  writeFileSync(join(dir,'external-context-preflight.json'),JSON.stringify(preflight,null,2));
 }
}

function applyHopContext(state:RunState, c:PreflightCtx):any {
 const t=c.t;
 // Resolve an explicit continuation (or an explicit repair) before spending any
 // classifier or worker cost.
 if (t.hopFrom !== undefined) {
  if (typeof t.hopFrom !== 'string' || !t.hopFrom.trim()) return blockedResult(state, 'Invalid hopFrom path');
  try {
   const hopContext=loadHopContext(resolve(state.sourceCwd,t.hopFrom));
   if(t.hopRevision !== undefined && t.hopRevision !== hopContext.revision) return blockedResult(state, 'HOP revision changed; inspect the handoff and redispatch against the current revision');
   c.t={...t,hopContext};
   state.t=c.t;
  }
  catch(e) { return blockedResult(state, `HOP rejected before paid calls: ${msg(e)}`); }
 }
 return undefined;
}

function reviewRefusal(state:RunState, t:any):any {
 if (typeof t.resumeFrom==='string' && t.resumeFrom.trim()) {
  return blockedResult(state, 'qa rejected before any paid call: resumeFrom is not allowed for workflow qa; QA runs a fresh reviewer session to avoid implementer-session bias', { review:{ from:null, error:'resumeFrom not allowed for qa' } });
 }
 if (typeof t.repairFrom==='string' && t.repairFrom.trim()) {
  return blockedResult(state, 'qa rejected before any paid call: repairFrom is not allowed for workflow qa; QA is report-only and never repairs', { review:{ from:null, error:'repairFrom not allowed for qa' } });
 }
 if (state.isolation === 'worktree') {
  return blockedResult(state, 'qa rejected before any paid call: workflow qa must inspect the subject checkout including uncommitted changes; isolation=worktree would review the wrong HEAD and is incompatible. Use isolation=none (the qa CLI default).', { review:{ from:null, error:'worktree isolation incompatible with qa' } });
 }
 return undefined;
}

function resolveReview(state:RunState, c:PreflightCtx):any {
 const {sourceCwd} = state;
 const t=c.t;
 c.explicitWorkflow=taskWorkflow(t);
 c.isQa=c.explicitWorkflow === 'qa';
 const reviewRequested=c.isQa || (c.explicitWorkflow === 'auto' && typeof t.reviewFrom === 'string' && !!t.reviewFrom.trim());
 c.review=undefined;
 c.reviewContext=null;
 if (reviewRequested) {
  const refused=reviewRefusal(state, t);
  if (refused) return refused;
  const reviewFrom=typeof t.reviewFrom==='string' && t.reviewFrom.trim() ? resolve(sourceCwd,t.reviewFrom) : null;
  if (!reviewFrom) {
   return blockedResult(state, 'qa rejected before any paid call: reviewFrom is required and must point at the prior result.json under review', { review:{ from:null, error:'reviewFrom required' } });
  }
  const loaded=loadReview(t, sourceCwd);
  if (loaded.error) {
   return blockedResult(state, `reviewFrom rejected: ${loaded.error}`, { review:{ from:reviewFrom, error:loaded.error } });
  }
  c.reviewContext=loaded.context ?? null;
  const priorWorkflow=loaded.prior.workflow && typeof loaded.prior.workflow === 'object'
   ? (loaded.prior.workflow.selected ?? loaded.prior.workflow.workflow ?? null) : (loaded.prior.workflow ?? null);
  c.review={ from:reviewFrom, priorResult:{ id:loaded.prior.id, status:loaded.prior.status, workflow:priorWorkflow, artifactDir:loaded.prior.artifactDir } };
 }
 return undefined;
}

function readPriorReport(priorArtifactDir:string|undefined):string|null {
 let priorReport:string|null=null;
 if (priorArtifactDir) {
  const priorReportPath=join(priorArtifactDir,'analysis-report.md');
  if (existsSync(priorReportPath)) {
   try {
    const text=readFileSync(priorReportPath,'utf8');
    priorReport=text.length > REVIEW_PROMPT_MAX_CHARS ? `${text.slice(0,REVIEW_PROMPT_MAX_CHARS)}\n... (truncated)` : text;
   } catch { priorReport=null; }
  }
 }
 return priorReport;
}

// Pi sessions are run-local. Import exactly the parent session into this
// run's overlay before any classifier or worker starts. A missing session is
// fatal for implementation workflows; report-only workflows fall back to a
// fresh session seeded with the prior report.
function importResumeSessionOrFallback(state:RunState, c:PreflightCtx):any {
 const resume=c.resume as ResumeInfo;
 const explicitWorkflow=c.explicitWorkflow;
 const priorArtifactDir=resume.parentResult.artifactDir;
 const imported=priorArtifactDir
  ? importResumeSession(priorArtifactDir, resume.parentSessionId, join(state.dir,'pi-agent'))
  : { error:{ code:'resume_session_unavailable' as const, missing:join(state.dir,'pi-agent'), message:'resume prior result has no artifactDir' } };
 if (imported.error) {
  const reportOnly=explicitWorkflow==='evaluate' || explicitWorkflow==='qa' || explicitWorkflow==='recon' || explicitWorkflow==='investigate';
  if (!reportOnly) {
   return blockedResult(state, `resume session unavailable: ${imported.error.message}`, {
    status:'resume_session_unavailable',
    resume:{ error:'resume_session_unavailable', from:resume.from, sessionId:resume.parentSessionId } });
  }
  const priorReport=readPriorReport(priorArtifactDir);
  c.reviewContext=priorReport;
  state.reviewContext=priorReport;
  state.resumeFallback={ reason:imported.error.message, priorResult:resume.from, sessionId:`${resume.parentSessionId.slice(0,8)}…` };
  c.resume=undefined;
 }
 return undefined;
}

function applyRepairLineage(state:RunState, c:PreflightCtx):any {
 const {heartbeat} = state;
 const t=c.t;
 const prior=c.prior;
 const priorLineage = prior && typeof prior.lineage==='object' && prior.lineage ? prior.lineage : null;
 const repairs=(typeof priorLineage?.repairs==='number'?priorLineage.repairs:0)+1;
 const maxRepairs= typeof t.maxRepairs==='number' ? t.maxRepairs
  : (typeof priorLineage?.maxRepairs==='number' ? priorLineage.maxRepairs : 1);
 const rootId= priorLineage?.rootId ?? (typeof prior?.id==='string' ? prior.id : t.id);
 const lineage:any={ rootId, repairs, maxRepairs, deadlineAt: typeof priorLineage?.deadlineAt==='string' ? priorLineage.deadlineAt : null };
 c.lineage=lineage;
 state.lineage=lineage;
 if (repairs > maxRepairs) {
  return blockedResult(state, `repair rejected before any paid call: repair ${repairs} exceeds maxRepairs ${maxRepairs} for lineage ${rootId}`, { lineage:{...lineage, rejected:true} });
 }
 const inherited= typeof priorLineage?.deadlineAt==='string' ? Date.parse(priorLineage.deadlineAt) : NaN;
 if (Number.isFinite(inherited)) {
  c.deadlineAt=Math.min(c.deadlineAt, inherited);
  state.deadlineAt=c.deadlineAt;
  lineage.deadlineAt=new Date(inherited).toISOString();
  heartbeat.update({ deadlineAt:new Date(c.deadlineAt).toISOString(), remainingMs:Math.max(0, c.deadlineAt-runNow(state)) });
 }
 if (runNow(state) >= c.deadlineAt) {
  return blockedResult(state, 'repair rejected before any paid call: the lineage deadline has already elapsed', { lineage });
 }
 return undefined;
}

function resolveResumeAndRepair(state:RunState, c:PreflightCtx):any {
 const {sourceCwd} = state;
 const t=c.t;
 const resumeField = typeof t.repairFrom==='string' && t.repairFrom.trim() ? t.repairFrom
  : (typeof t.resumeFrom==='string' && t.resumeFrom.trim() ? t.resumeFrom : null);
 c.isRepair = typeof t.repairFrom==='string' && !!t.repairFrom.trim();
 c.resume=undefined;
 c.prior=undefined;
 if (resumeField) {
  const loaded=loadResume({...t, resumeFrom:resumeField}, c.requested, sourceCwd);
  if (loaded.error) {
   return blockedResult(state, `resumeFrom rejected: ${loaded.error}`, {
    resume:{ from:resolve(sourceCwd,resumeField), error:loaded.error } });
  }
  c.resume=loaded.info;
  c.prior=loaded.prior;
  const fallback=importResumeSessionOrFallback(state, c);
  if (fallback) return fallback;
  if (c.isRepair) {
   const rejected=applyRepairLineage(state, c);
   if (rejected) return rejected;
  }
 }
 return undefined;
}

function resolveWorktreeCheckout(state:RunState, c:PreflightCtx):any {
 const {sourceCwd, dir} = state;
 if (c.resume) {
  const compat=resumeExecutionCwd(c.prior, sourceCwd, 'worktree');
  if (compat.error) return blockedResult(state, `resumeFrom rejected: ${compat.error}`);
  c.executionCwd=compat.executionCwd!;
  if (!isWorktreeOf(sourceCwd, c.executionCwd, Math.max(1, remainingMs(state)))) {
   return blockedResult(state, `resumeFrom rejected: prior execution checkout is no longer a registered worktree of ${sourceCwd}: ${c.executionCwd}`);
  }
  c.worktreePath=c.executionCwd;
 } else {
  const dirty=sourceDirty(sourceCwd, Math.max(1, remainingMs(state)));
  if (dirty.error) return blockedResult(state, `isolation=worktree cannot inspect the source checkout: ${dirty.error}`);
  if (dirty.dirty) return blockedResult(state, `isolation=worktree requires a clean source checkout; commit or stash these changes (or use isolation=none):\n${dirty.status}`);
  c.worktreePath=join(dir,'worktree');
  const made=createDetachedWorktree(sourceCwd, c.worktreePath, Math.max(1, remainingMs(state)));
  if (!made.ok) return blockedResult(state, `isolation=worktree could not create a detached worktree at ${c.worktreePath}: ${made.error}${worktreeWriteRemediation(String(made.error ?? ''))}`);
  c.executionCwd=c.worktreePath;
 }
 return undefined;
}

function resolveExecutionCheckout(state:RunState, c:PreflightCtx):any {
 const {sourceCwd, isolation, heartbeat, emit} = state;
 // Decide the execution checkout before any paid call. Worktree isolation
 // requires a clean source and refuses rather than silently omitting edits.
 heartbeat.update({phase:'isolation'});
 emit('isolation');
 c.executionCwd=sourceCwd;
 c.worktreePath=undefined;
 if (isolation === 'worktree') {
  return resolveWorktreeCheckout(state, c);
 } else if (c.resume) {
  const compat=resumeExecutionCwd(c.prior, sourceCwd, 'none');
  if (compat.error) return blockedResult(state, `resumeFrom rejected: ${compat.error}`);
  c.executionCwd=compat.executionCwd!;
 }
 return undefined;
}

function isolationSetupFailed(state:RunState, c:PreflightCtx, error:string):any {
 const {heartbeat, mock, dir, sourceCwd, isolation} = state;
 heartbeat.setState('failed',{stopReason:'isolation_setup_failed', error});
 const out:any={ id:c.t.id, simulated:mock, status:'isolation_setup_failed', workerExitCode:null,
  workerError:error, checks:[], artifactDir:dir, runtime:heartbeat.snapshot(), lineage:c.lineage,
  sourceCwd, executionCwd:c.executionCwd, isolation:{mode:isolation, ...(c.worktreePath?{worktree:c.worktreePath}:{})} };
 writeFileSync(join(dir,'result.json'),JSON.stringify(out,null,2));
 return out;
}

// Opt-in provisioning runs after the detached worktree exists and before any
// paid worker, classifier or independent check. It is ignored for isolation
// none, and any setup failure is its own terminal outcome, never a check
// failure, so Pi is not started against a half-provisioned checkout.
function provisionWorktree(state:RunState, c:PreflightCtx):any {
 const {sourceCwd, dir, settings} = state;
 const t=c.t;
 const rawSetup = t.isolationSetup !== undefined ? t.isolationSetup : configuredIsolationSetup(sourceCwd);
 if (rawSetup !== undefined) {
  try { validateIsolationSetup(rawSetup); }
  catch(e) { return isolationSetupFailed(state, c, `Invalid isolationSetup: ${msg(e)}`); }
  let commandPolicy;
  try { commandPolicy=resolveCommandPolicy(t, sourceCwd); }
  catch(e) { return isolationSetupFailed(state, c, `Invalid commandPolicy: ${msg(e)}`); }
  const provisioned=provisionIsolationSetup(rawSetup as IsolationSetup, sourceCwd, c.executionCwd, dir, { deadlineAt:c.deadlineAt, checkTimeoutMs:settings.checkTimeoutMs, commandPolicy, clock:runClock(state) });
  if (!provisioned.ok) return isolationSetupFailed(state, c, `isolationSetup failed: ${provisioned.error}`);
  if (provisioned.excludePatterns.length) ensureLocalExcludes(c.executionCwd, provisioned.excludePatterns);
 }
 return undefined;
}

function acquireRunLocks(state:RunState, c:PreflightCtx):any {
 const {sourceCwd, dir} = state;
 // Acquire advisory locks before any classifier or worker call. A held lock
 // fails fast; every lock we acquire is released in the finally below.
 const locks=state.locks;
 const lockDir=join(sourceCwd,'.delivery','locks');
 const lockInfo={ id:c.t.id, artifactDir:dir, sourceCwd, executionCwd:c.executionCwd };
 const checkoutLock=acquireLock(lockDir, `checkout:${c.executionCwd}`, lockInfo, runClock(state));
 if (checkoutLock.error) return blockedResult(state, `cannot start run: ${checkoutLock.error}`);
 locks.push(checkoutLock.handle!);
 if (c.resume) {
  const sessionLock=acquireLock(lockDir, sessionLockKey(c.resume), lockInfo, runClock(state));
  if (sessionLock.error) {
   // The checkout lock is already held; release it before the early return so
   // a failed session-lock acquisition cannot leak the checkout lock.
   for (const l of locks) l.release();
   return blockedResult(state, `cannot start run: ${sessionLock.error}`);
  }
  locks.push(sessionLock.handle!);
 }
 return undefined;
}

function installSignalHandling(state:RunState, c:PreflightCtx):void {
 const {deps, mock} = state;
 const locks=state.locks;
 // An external signal (or a real SIGINT/SIGTERM on a live run) interrupts the
 // child, preserves partial logs/evidence and still releases the locks.
 const ownController = (!deps.signal && !mock && !deps.spawnPi) ? new AbortController() : null;
 const signal = deps.signal ?? ownController?.signal;
 const onSignal=()=>{ ownController?.abort(); };
 if (ownController) { process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal); }
 state.signal=signal;
 state.ownController=ownController;
 state.onSignal=onSignal;
 state.release=()=>{ for (const l of locks) l.release(); if (ownController) { process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); } };
 c.signal=signal;
}

async function resolveJevClassifier(state:RunState, c:PreflightCtx):Promise<void> {
 const {deps, jevProviderSetting} = state;
 const jev=c.jev;
 try {
  const resolved = await raceAbort(createJevClassifier(jevProviderSetting, { gateway: deps.gateway, fetch: deps.jevFetch, pi: deps.jevPi }), classifierBudget(state), c.signal, runClock(state));
  c.classify = resolved.classify;
  jev!.gateway = resolved.gateway;
  jev!.model = { provider: resolved.gateway, id: resolved.model, explicit: false };
  if ((c.classify as any).explicitModel) jev!.model.explicit = true;
 } catch (e) {
  jev!.error = `classifier unavailable: ${msg(e)}`;
 }
}

function applyMatrixContext(state:RunState, c:PreflightCtx, matrixContext:MatrixContext):void {
 const t=c.t;
 if (matrixContext.entries.length > 0) {
  const explicit = Array.isArray(t.context) ? t.context : [];
  const seen = new Set(explicit.map((entry:any)=>entry?.path).filter((path:any)=>typeof path === 'string'));
  t.context = [...explicit, ...matrixContext.entries.filter((entry) => !seen.has(entry.path))];
 }
 if (matrixContext.feature !== undefined) {
  state.matrixContext = {
   feature: matrixContext.feature,
   paths: matrixContext.entries.map((entry) => entry.path),
   ...(matrixContext.note === undefined ? {} : { note: matrixContext.note }),
  };
 }
}

async function runReadinessGate(state:RunState, c:PreflightCtx):Promise<void> {
 const jev=c.jev;
 jev!.attempted = true;
 try {
  const preflight = await raceSignal(assessPreflight(c.t, c.classify, { workflowQuestion: c.explicitWorkflow === 'auto', modelProfiles:c.modelProfiles, timeoutMs: classifierBudget(state), context:c.codeContext, clock:runClock(state) }), c.signal);
  jev!.preflight = preflight;
  if (preflight.error) jev!.error = preflight.error;
 } catch (e) {
  jev!.error = `classifier unavailable: ${msg(e)}`;
 }
}

async function runClarification(state:RunState, c:PreflightCtx):Promise<any> {
 const {deps, sourceCwd, dir, heartbeat, emit, mock, runStartedAt} = state;
 const {t, jev, preparePlan} = c;
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
   heartbeat.update({phase:'done', elapsedMs:runNow(state)-runStartedAt, remainingMs:Math.max(0, remainingMs(state))});
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
    checks:[], artifactDir:dir, jev, workflow:c.decision, runtime:heartbeat.snapshot(), lineage:c.lineage,
    sourceCwd, executionCwd:c.executionCwd, isolation:isolationRecord(state, c),
    toolPlan: preparePlan, modelRouting:c.modelRoute,
    clarification:{ sessionId:batch.sessionId, round:batch.round, questions } };
   writeFileSync(join(dir,'result.json'),JSON.stringify(clarifyResult,null,2));
   return clarifyResult;
 } catch (e) {
  // A session that cannot open must not crash the run; record it and fall
  // through to the normal prepare/implement decision.
  emit(`clarify unavailable: ${msg(e)}`);
 }
 return undefined;
}

/** Setup through locks: model policy/routing, consent, HOP, review/resume,
 * isolation and locks. Synchronous; returns a blocked outcome or undefined. */
function preflightSetup(state:RunState, c:PreflightCtx):any {
 const lineageBlocked=initLineage(state, c);
 if (lineageBlocked) return lineageBlocked;
 const modelBlocked=resolvePinnedModel(state, c);
 if (modelBlocked) return modelBlocked;
 resolveRoutingEligibility(state, c);
 initialExternalContext(state, c);
 const hopBlocked=applyHopContext(state, c);
 if (hopBlocked) return hopBlocked;
 const reviewBlocked=resolveReview(state, c);
 if (reviewBlocked) return reviewBlocked;
 const resumeBlocked=resolveResumeAndRepair(state, c);
 if (resumeBlocked) return resumeBlocked;
 const checkoutBlocked=resolveExecutionCheckout(state, c);
 if (checkoutBlocked) return checkoutBlocked;
 if (state.isolation === 'worktree') {
  const setupFailed=provisionWorktree(state, c);
  if (setupFailed) return setupFailed;
 }
 return acquireRunLocks(state, c);
}

/** Pre-run evidence and the injected classifier. Returns true when a Jev
 * classifier must still be resolved (the only awaited step of this phase). */
function prepareClassifier(state:RunState, c:PreflightCtx):boolean {
 const {mock, deps, mode, heartbeat} = state;
 heartbeat.update({phase:'readiness'});
 // Capture pre-run evidence so preexisting work is distinguishable from the
 // changes this run makes. The complete before/after pair is saved below.
 c.before=collectGitEvidence(c.executionCwd, { timeoutMs: Math.max(1, remainingMs(state)) });

 // Resolve the classifier for the readiness gate before any worker is started.
 heartbeat.update({phase:'classifier'});
 const classifierBase = deps.classifierTimeoutMs ?? CLASSIFIER_TIMEOUT_MS;
 state.classifierBase=classifierBase;
 c.classify = deps.classify as GateClassifier|undefined;
 if (mode !== 'off' && !c.classify) {
  if (mock) {
   c.jev!.skipped = 'mock run without an injected classifier';
  } else {
   return true;
  }
 }
 return false;
}

function rememberStickyRoute(state:RunState, c:PreflightCtx):void {
 // The model is final and consented: remember it for the next run of this
 // deliverable so the deliverable keeps one model.
 writeStickyRoute(state.sourceCwd, c.t.id, {
  profile:c.modelRoute.profile ?? null,
  provider:c.requested.provider,
  model:c.requested.model,
  approval:c.modelRoute.approval ?? null,
 }, runClock(state));
}

/** ADR 0018 R3/R5/R8: true when the ticket gate must run; a classifier-less
 * ticket run records the skip instead. */
function ticketGateRuns(state:RunState, c:PreflightCtx):boolean {
 if (typeof c.t.ticket==='string' && c.t.ticket.trim() && !state.mock) {
  if (!c.classify) {
   state.ticketGateUnresolved='ADR ticket gate skipped: classifier unavailable';
  } else {
   return true;
  }
 }
 return false;
}

/** Preflight: setup, model policy/routing, consent, HOP, review/resume, isolation,
 * locks, classifier, workflow decision, clarify/prepare and the prompt. A returned
 * Result is a blocked/hold outcome; on success the same state object is returned. */
export async function preflight(state:RunState):Promise<RunState|any> {
 const {sourceCwd, mode, emit} = state;
 const c:PreflightCtx={ t:state.t, requested:state.requested, requestedSource:state.requestedSource,
  deadlineAt:state.deadlineAt, lineage:undefined, jev:state.jev };
 const setupBlocked=preflightSetup(state, c);
 if (setupBlocked) return setupBlocked;
 installSignalHandling(state, c);
 if (prepareClassifier(state, c)) await resolveJevClassifier(state, c);

 // Add the contract feature's code-map files before resolving context. Explicit
 // contract entries stay first; matrix entries are deduplicated by path and are
 // advisory, so a missing store or query failure never blocks the run.
 // Only a contract naming a feature pays for the lookup (and its await).
 const matrixContext = contractFeature(c.t) === undefined ? { entries: [] } as MatrixContext : await matrixContextFor(c.t);
 applyMatrixContext(state, c, matrixContext);

 // Resolve the contract code context once, before preflight, so the readiness
 // classifier and the worker prompt see the same bounded excerpts.
 c.codeContext = resolveContext(c.t);

 // Preflight (readiness) gate runs before the worker. `auto` runs exactly one
 // extra Jev choice question inside this call.
 emit('preflight');
 if (mode !== 'off' && c.classify && !outOfTime(state)) await runReadinessGate(state, c);

 decideRoute(state, c);
 const approvalHeld=settleModelApproval(state, c);
 if (approvalHeld) return approvalHeld;
 const budgetHeld=settleBudgetApproval(state, c);
 if (budgetHeld) return budgetHeld;
 rememberStickyRoute(state, c);

 // ADR 0017 R4: resolve the data-destination policy before the final disclosure
 // and before Pi or any provider receives source text. A run whose policy leaves
 // no upstream provider fails closed with zero model calls, following the same
 // inspectable early-return shape as the consent refusal below.
 c.dataPolicy=null;
 c.dataPolicyRouting=null;
 c.dataPolicyDirectory=[];
 // Keep the no-policy path synchronous (existing preflight/launch tests rely on
 // Pi spawning in the same step); only a declared policy needs the async
 // metadata resolution.
 if (c.requested.provider==='openrouter' && readDataPolicy(sourceCwd)) {
  const policyBlocked=await applyDataPolicy(state, c);
  if (policyBlocked) return policyBlocked;
 }
 state.dataPolicy=c.dataPolicy;
 state.dataPolicyRouting=c.dataPolicyRouting;
 state.dataPolicyDirectory=c.dataPolicyDirectory;

 // The ticket-stage decision is carried to the later stages, so a flag stops
 // for a human now, before any worker or prepare run starts.
 if (ticketGateRuns(state, c)) {
  const ticketHeld=await runTicketGate(state, c);
  if (ticketHeld) return ticketHeld;
 }

 prepareWorkflowDecision(state, c);
 if (clarificationApplies(state, c)) {
  const clarifyResult=await runClarification(state, c);
  if (clarifyResult) return clarifyResult;
 }
 const held=finishPreflight(state, c);
 if (held) return held;
 return state;
}
