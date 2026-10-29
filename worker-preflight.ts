import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadHopContext } from './hop-context.ts';
import { resolveIsolation, sourceDirty, createDetachedWorktree, isWorktreeOf, acquireLock, ensureLocalExcludes, validateIsolationSetup, provisionIsolationSetup, configuredIsolationSetup, type IsolationMode, type LockHandle, type IsolationSetup } from './isolation.ts';
import { resolveExecutionSettings, RuntimeHeartbeat, type ExecutionSettings } from './runtime.ts';
import { loadModelConfig, rosterChoiceCriteria, findProfile } from './roster.ts';
import type { ModelConfig } from './roster.ts';
import { assertCommodity, ModelPolicyError } from './model-policy.ts';
import { collectGitEvidence } from './evidence.ts';
import { clarityGateApplies, resolveDiscoverReport, startClarification } from './clarify.ts';
import { buildIsolationArgs, type IsolationVerdict } from './pi-isolation.ts';
import { loadPrepareHistory, shouldCheckBack, briefMdPath } from './prepare.ts';
import { sessionLockKey, loadResume, resumeExecutionCwd, REVIEW_CONTEXT_FILENAME, REVIEW_PROMPT_MAX_CHARS, loadReview, type ResumeInfo } from './worker-resume.ts';
import { importResumeSession } from './pi-overlay.ts';
import { buildPrompt } from './worker-prompt.ts';
import { probePiCapabilities } from './worker-pi.ts';
import { DEFAULT_JEV, buildModelApprovalRequest, decideModelRoute, jevMode, readStickyRoute, resolveExplicitApproval, stickyApprovalHolds, writeStickyRoute } from './worker-approval.ts';
import type { ModelApprovalRequest, ModelPolicyRecord, ModelRoute } from './worker-approval.ts';
import { CLASSIFIER_TIMEOUT_MS, assessPreflight, createJevClassifier, readProjectJevProvider, raceSignal, raceAbort, affinityKeyFor } from './worker-gates.ts';
import type { GateClassifier, GateDeps, JevGateRecord } from './worker-gates.ts';
import { buildExternalContextPreflight, externalContextRequired, resolveContext } from './worker-contract.ts';
import type { ReceiptModelSource } from './worker-contract.ts';
import { analysisReportPath, decideWorkflow, isReportWorkflow, taskWorkflow, WORKFLOW_TEMPLATE_IDS } from './worker-workflows.ts';
import { estimateCost, mockReceipt } from './worker-receipt.ts';
import type { JevProvider } from './gateway.ts';

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
 // phase outputs are added as optional fields: prompt, receipt, streamResult, checks, workerError, status
 prompt?:string; receipt?:any; streamResult?:any; checks?:any[]; workerError?:string; status?:string;
 release?:()=>void;
 [key:string]:any;
}

/** Deadline arithmetic shared by every phase; `state.deadlineAt` is authoritative. */
export const remainingMs=(state:RunState)=>state.deadlineAt-Date.now();
export const outOfTime=(state:RunState)=>Date.now() >= state.deadlineAt;
// The worker is stopped before the total deadline so the reserved budget is
// available to the contract's checks, which remain bounded by the total wall
// deadline.
export const workerDeadlineAt=(state:RunState)=>state.deadlineAt-state.settings.checkReserveMs;
export const workerRemainingMs=(state:RunState)=>workerDeadlineAt(state)-Date.now();
export const workerOutOfTime=(state:RunState)=>Date.now() >= workerDeadlineAt(state);
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
 return { t, mock, deps, settings, sourceCwd, executionCwd:sourceCwd, isolation, dir,
  requested, requestedSource, modelConfig, deadlineAt, heartbeat, emit,
  resume:undefined, review:undefined, lineage:undefined, decision:undefined, jev,
  signal:undefined, locks:[], runStartedAt, mode, jevProviderSetting, runtimePath,
  explicitProvider, explicitModel, modelProfile };
}

/** Preflight: setup, model policy/routing, consent, HOP, review/resume, isolation,
 * locks, classifier, workflow decision, clarify/prepare and the prompt. A returned
 * Result is a blocked/hold outcome; on success the same state object is returned. */
export async function preflight(state:RunState):Promise<RunState|any> {
 const {mock, deps, settings, sourceCwd, isolation, dir, modelConfig, mode, heartbeat, emit,
  explicitProvider, explicitModel, modelProfile, jevProviderSetting, runtimePath, runStartedAt} = state;
 let t=state.t;
 let requested=state.requested;
 let requestedSource=state.requestedSource;
 let deadlineAt=state.deadlineAt;
 let jev=state.jev;
 let lineage:any={ rootId:t.id, repairs:0,
  maxRepairs: typeof t.maxRepairs==='number' ? t.maxRepairs : 1,
  deadlineAt: typeof t.lineageDeadlineMs==='number' ? new Date(runStartedAt+t.lineageDeadlineMs).toISOString() : null };
 state.lineage=lineage;
 // One absolute lineage deadline (when supplied) also bounds this root run, so
 // a whole recovery chain shares a single wall-clock budget.
 if (typeof t.lineageDeadlineMs==='number') {
  deadlineAt=Math.min(deadlineAt, runStartedAt+t.lineageDeadlineMs);
  state.deadlineAt=deadlineAt;
  heartbeat.update({ deadlineAt:new Date(deadlineAt).toISOString(), remainingMs:Math.max(0, deadlineAt-Date.now()) });
 }

 // A contract may pin a roster profile. The pin still needs human consent when
 // it differs from the project default, exactly like an explicit model.
 const pinnedProfile=modelProfile ? findProfile(modelConfig, modelProfile) : null;
 if (modelProfile && !pinnedProfile) return blockedResult(state, `modelProfile '${modelProfile}' is not in the roster`);
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
  return blockedResult(state, `${e.code}: ${e.verdict.reason}`, { modelPolicy });
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
  if (typeof t.hopFrom !== 'string' || !t.hopFrom.trim()) return blockedResult(state, 'Invalid hopFrom path');
  try {
   const hopContext=loadHopContext(resolve(sourceCwd,t.hopFrom));
   if(t.hopRevision !== undefined && t.hopRevision !== hopContext.revision) return blockedResult(state, 'HOP revision changed; inspect the handoff and redispatch against the current revision');
   t={...t,hopContext};
   state.t=t;
  }
  catch(e) { return blockedResult(state, `HOP rejected before paid calls: ${msg(e)}`); }
 }
 const explicitWorkflow=taskWorkflow(t);
 let isQa=explicitWorkflow === 'qa';
 const reviewRequested=isQa || (explicitWorkflow === 'auto' && typeof t.reviewFrom === 'string' && !!t.reviewFrom.trim());
 let review:any;
 let reviewContext:string|null=null;
 if (reviewRequested) {
  if (typeof t.resumeFrom==='string' && t.resumeFrom.trim()) {
   return blockedResult(state, 'qa rejected before any paid call: resumeFrom is not allowed for workflow qa; QA runs a fresh reviewer session to avoid implementer-session bias', { review:{ from:null, error:'resumeFrom not allowed for qa' } });
  }
  if (typeof t.repairFrom==='string' && t.repairFrom.trim()) {
   return blockedResult(state, 'qa rejected before any paid call: repairFrom is not allowed for workflow qa; QA is report-only and never repairs', { review:{ from:null, error:'repairFrom not allowed for qa' } });
  }
  if (isolation === 'worktree') {
   return blockedResult(state, 'qa rejected before any paid call: workflow qa must inspect the subject checkout including uncommitted changes; isolation=worktree would review the wrong HEAD and is incompatible. Use isolation=none (the qa CLI default).', { review:{ from:null, error:'worktree isolation incompatible with qa' } });
  }
  const reviewFrom=typeof t.reviewFrom==='string' && t.reviewFrom.trim() ? resolve(sourceCwd,t.reviewFrom) : null;
  if (!reviewFrom) {
   return blockedResult(state, 'qa rejected before any paid call: reviewFrom is required and must point at the prior result.json under review', { review:{ from:null, error:'reviewFrom required' } });
  }
  const loaded=loadReview(t, sourceCwd);
  if (loaded.error) {
   return blockedResult(state, `reviewFrom rejected: ${loaded.error}`, { review:{ from:reviewFrom, error:loaded.error } });
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
   return blockedResult(state, `resumeFrom rejected: ${loaded.error}`, {
    resume:{ from:resolve(sourceCwd,resumeField), error:loaded.error } });
  }
  resume=loaded.info;
  prior=loaded.prior;
  // Pi sessions are run-local. Import exactly the parent session into this
  // run's overlay before any classifier or worker starts. A missing session is
  // fatal for implementation workflows; report-only workflows fall back to a
  // fresh session seeded with the prior report.
  {
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
    reviewContext=priorReport;
    state.reviewContext=priorReport;
    state.resumeFallback={ reason:imported.error.message, priorResult:resume.from, sessionId:`${resume.parentSessionId.slice(0,8)}…` };
    resume=undefined;
   }
  }
  if (isRepair) {
   const priorLineage = prior && typeof prior.lineage==='object' && prior.lineage ? prior.lineage : null;
   const repairs=(typeof priorLineage?.repairs==='number'?priorLineage.repairs:0)+1;
   const maxRepairs= typeof t.maxRepairs==='number' ? t.maxRepairs
    : (typeof priorLineage?.maxRepairs==='number' ? priorLineage.maxRepairs : 1);
   const rootId= priorLineage?.rootId ?? (typeof prior?.id==='string' ? prior.id : t.id);
   lineage={ rootId, repairs, maxRepairs, deadlineAt: typeof priorLineage?.deadlineAt==='string' ? priorLineage.deadlineAt : null };
   state.lineage=lineage;
   if (repairs > maxRepairs) {
    return blockedResult(state, `repair rejected before any paid call: repair ${repairs} exceeds maxRepairs ${maxRepairs} for lineage ${rootId}`, { lineage:{...lineage, rejected:true} });
   }
   const inherited= typeof priorLineage?.deadlineAt==='string' ? Date.parse(priorLineage.deadlineAt) : NaN;
   if (Number.isFinite(inherited)) {
    deadlineAt=Math.min(deadlineAt, inherited);
    state.deadlineAt=deadlineAt;
    lineage.deadlineAt=new Date(inherited).toISOString();
    heartbeat.update({ deadlineAt:new Date(deadlineAt).toISOString(), remainingMs:Math.max(0, deadlineAt-Date.now()) });
   }
   if (Date.now() >= deadlineAt) {
    return blockedResult(state, 'repair rejected before any paid call: the lineage deadline has already elapsed', { lineage });
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
   if (compat.error) return blockedResult(state, `resumeFrom rejected: ${compat.error}`);
   executionCwd=compat.executionCwd!;
   if (!isWorktreeOf(sourceCwd, executionCwd, Math.max(1, remainingMs(state)))) {
    return blockedResult(state, `resumeFrom rejected: prior execution checkout is no longer a registered worktree of ${sourceCwd}: ${executionCwd}`);
   }
   worktreePath=executionCwd;
  } else {
   const dirty=sourceDirty(sourceCwd, Math.max(1, remainingMs(state)));
   if (dirty.error) return blockedResult(state, `isolation=worktree cannot inspect the source checkout: ${dirty.error}`);
   if (dirty.dirty) return blockedResult(state, `isolation=worktree requires a clean source checkout; commit or stash these changes (or use isolation=none):\n${dirty.status}`);
   worktreePath=join(dir,'worktree');
   const made=createDetachedWorktree(sourceCwd, worktreePath, Math.max(1, remainingMs(state)));
   if (!made.ok) return blockedResult(state, `isolation=worktree could not create a detached worktree at ${worktreePath}: ${made.error}`);
   executionCwd=worktreePath;
  }
 } else if (resume) {
  const compat=resumeExecutionCwd(prior, sourceCwd, 'none');
  if (compat.error) return blockedResult(state, `resumeFrom rejected: ${compat.error}`);
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
 const locks=state.locks;
 const lockDir=join(sourceCwd,'.delivery','locks');
 const lockInfo={ id:t.id, artifactDir:dir, sourceCwd, executionCwd };
 const checkoutLock=acquireLock(lockDir, `checkout:${executionCwd}`, lockInfo);
 if (checkoutLock.error) return blockedResult(state, `cannot start run: ${checkoutLock.error}`);
 locks.push(checkoutLock.handle!);
 if (resume) {
  const sessionLock=acquireLock(lockDir, sessionLockKey(resume), lockInfo);
  if (sessionLock.error) {
   // The checkout lock is already held; release it before the early return so
   // a failed session-lock acquisition cannot leak the checkout lock.
   for (const l of locks) l.release();
   return blockedResult(state, `cannot start run: ${sessionLock.error}`);
  }
  locks.push(sessionLock.handle!);
 }

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

 heartbeat.update({phase:'readiness'});
 // Capture pre-run evidence so preexisting work is distinguishable from the
 // changes this run makes. The complete before/after pair is saved below.
 const before=collectGitEvidence(executionCwd, { timeoutMs: Math.max(1, remainingMs(state)) });

 // Resolve the classifier for the readiness gate before any worker is started.
 heartbeat.update({phase:'classifier'});
 const classifierBase = deps.classifierTimeoutMs ?? CLASSIFIER_TIMEOUT_MS;
 state.classifierBase=classifierBase;
 let classify:GateClassifier|undefined = deps.classify;
 if (mode !== 'off' && !classify) {
  if (mock) {
   jev!.skipped = 'mock run without an injected classifier';
  } else {
   try {
    const resolved = await raceAbort(createJevClassifier(jevProviderSetting, { gateway: deps.gateway, fetch: deps.jevFetch, pi: deps.jevPi }), classifierBudget(state), signal);
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
 if (mode !== 'off' && classify && !outOfTime(state)) {
  jev!.attempted = true;
  try {
   const preflight = await raceSignal(assessPreflight(t, classify, { workflowQuestion: explicitWorkflow === 'auto', modelProfiles, timeoutMs: classifierBudget(state), context:codeContext }), signal);
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
    heartbeat.update({phase:'done', elapsedMs:Date.now()-runStartedAt, remainingMs:Math.max(0, remainingMs(state))});
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

 state.t=t; state.requested=requested; state.requestedSource=requestedSource;
 state.deadlineAt=deadlineAt; state.lineage=lineage;
 state.executionCwd=executionCwd; state.worktreePath=worktreePath;
 state.resume=resume; state.prior=prior; state.review=review; state.reviewContext=reviewContext;
 state.isRepair=isRepair; state.isQa=isQa; state.decision=decision; state.modelRoute=modelRoute;
 state.externalContext=externalContext; state.affinityKey=affinityKey;
 state.openrouterRouting=openrouterRouting; state.providerRouting=providerRouting;
 state.prepareRun=prepareRun; state.preparePlan=preparePlan; state.prepareHistory=prepareHistory;
 state.reportWorkflow=reportWorkflow; state.reportPath=reportPath; state.templates=templates;
 state.piIsolation=piIsolation; state.isolationArgs=isolationArgs; state.prompt=prompt;
 state.classify=classify; state.before=before;
 // Mark the synchronous completion so run() can reach launch without an extra
 // microtask when no classifier or clarify step had to await.
 state.preflightDone=true;
 return state;
}
