import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findProfile } from './roster.ts';
import { buildIsolationArgs, type IsolationVerdict } from './pi-isolation.ts';
import { loadPrepareHistory, shouldCheckBack, briefMdPath } from './prepare.ts';
import { REVIEW_CONTEXT_FILENAME } from './worker-resume.ts';
import { clarityGateApplies } from './clarify.ts';
import { buildPrompt } from './worker-prompt.ts';
import { probePiCapabilities } from './worker-pi.ts';
import { buildModelApprovalRequest, decideModelRoute, resolveExplicitApproval } from './worker-approval.ts';
import type { ModelApprovalRequest } from './worker-approval.ts';
import { raceSignal, affinityKeyFor } from './worker-gates.ts';
import { buildExternalContextPreflight, externalContextRequired } from './worker-contract.ts';
import type { ReceiptModelSource } from './worker-contract.ts';
import { analysisReportPath, decideWorkflow, isReportWorkflow, WORKFLOW_TEMPLATE_IDS } from './worker-workflows.ts';
import { estimateCost, mockReceipt } from './worker-receipt.ts';
import { dataPolicyPreflight } from './data-policy-run.ts';
import { ticketGate } from './worker-adr-gate.ts';
import { renderTicketReport } from './adr-tickets.ts';
import { effectiveBudget } from './runtime-settings.ts';
import { findBudgetApproval } from './human-approval.ts';
import { recordPolicyEvent } from './policy-events.ts';
import type { RunState } from './worker-preflight.ts';

// Preflight phases after the run locks are held: model routing and consent, the
// data policy and ticket gates, workflow selection, the final disclosure and the
// prompt (ADR 0015 X5). worker-preflight.ts orders them.

const msg=(e:unknown)=>e instanceof Error ? e.message : String(e);

/** The mutable values one preflight carries between its ordered phases. They
 * are copied onto the run state once preflight completes. */
export interface PreflightCtx {
 t:any; requested:{ provider:string; model:string }; requestedSource:ReceiptModelSource;
 deadlineAt:number; lineage:any; jev:any;
 [key:string]:any;
}

/** The isolation record shared by every terminal outcome after the checkout is decided. */
export function isolationRecord(state:RunState, c:PreflightCtx) {
 return { mode:state.isolation, ...(c.worktreePath?{worktree:c.worktreePath}:{}) };
}

export function decideRoute(state:RunState, c:PreflightCtx):void {
 const t=c.t;
 // Model routing is decided before the worker spawns, so every receipt and
 // argv builder below sees the final requested model.
 c.modelRoute=c.stickyRoute ?? decideModelRoute(state.modelConfig, c.jev?.preflight?.answers?.model_profile, { eligible:c.routingEligible, skipped:c.routingSkipped, approveModel:t.approveModel, approvedProfiles:t.approvedProfiles });
 if (c.modelRoute.applied && !c.stickyRoute) {
  c.requested={ provider:c.modelRoute.provider, model:c.modelRoute.model };
  c.requestedSource='routed';
 }
}

export function buildApproval(state:RunState, c:PreflightCtx):ModelApprovalRequest|undefined {
 const {modelConfig, deps} = state;
 const {requested, modelRoute} = c;
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
 } else if (c.requestedSource === 'task' && requested.model !== modelConfig.model) {
  const approval=resolveExplicitApproval(modelConfig, c.t, requested, c.prior);
  if (approval) c.modelRoute={...modelRoute, approval};
  else modelApproval=buildModelApprovalRequest({
   target:{ profile:null, provider:requested.provider, model:requested.model, confidence:null, strengths:null },
   config:modelConfig, env:deps.env,
   reason:`The contract requests model '${requested.model}' explicitly. It differs from the project default '${modelConfig.model}', so a human must approve it.`,
  });
 }
 return modelApproval;
}

export function settleModelApproval(state:RunState, c:PreflightCtx):any {
 const {modelConfig, heartbeat, emit, dir, mock, sourceCwd, mode} = state;
 let modelApproval=buildApproval(state, c);
 if (modelApproval) {
  if (modelConfig.unapproved === 'default') {
   c.modelRoute={...c.modelRoute, needsApproval:false, declined:true,
    reason:`models.unapproved is 'default'; the recommendation was recorded but not applied: ${modelApproval.reason}`};
   modelApproval=undefined;
  } else {
   heartbeat.setState('failed',{stopReason:'needs_model_approval'});
   emit('finished needs_model_approval');
   writeFileSync(join(dir,'model-approval.json'),JSON.stringify(modelApproval,null,2));
   const out:any={ id:c.t.id, simulated:mock, status:'needs_model_approval', workerExitCode:null,
    workerError:modelApproval.reason, checks:[], artifactDir:dir, runtime:heartbeat.snapshot(), lineage:c.lineage,
    sourceCwd, executionCwd:c.executionCwd, isolation:isolationRecord(state, c),
    modelRouting:c.modelRoute, modelApproval };
   if (mode !== 'off') out.jev=c.jev;
   writeFileSync(join(dir,'result.json'),JSON.stringify(out,null,2));
   return out;
  }
 }
 return undefined;
}

export async function applyDataPolicy(state:RunState, c:PreflightCtx):Promise<any> {
 const {sourceCwd, deps, heartbeat, emit, mock, dir} = state;
 const policyPreflight=await dataPolicyPreflight({
  cwd:sourceCwd,
  provider:c.requested.provider,
  model:c.requested.model,
  fetch:(deps as any).dataPolicyFetch,
 });
 if (!policyPreflight.ok) {
  heartbeat.setState('failed',{stopReason:'data_policy_unsatisfied', error:policyPreflight.reason});
  emit('finished data_policy_unsatisfied');
  const out:any={ id:c.t.id, simulated:mock, status:'data_policy_unsatisfied', workerExitCode:null,
   workerError:policyPreflight.reason, checks:[], artifactDir:dir, runtime:heartbeat.snapshot(), lineage:c.lineage,
   sourceCwd, executionCwd:c.executionCwd, isolation:isolationRecord(state, c),
   modelRouting:c.modelRoute };
  writeFileSync(join(dir,'result.json'),JSON.stringify(out,null,2));
  return out;
 }
 c.dataPolicy=policyPreflight.policy;
 c.dataPolicyRouting=policyPreflight.routing;
 c.dataPolicyDirectory=policyPreflight.directory ?? [];
 return undefined;
}

export async function runTicketGate(state:RunState, c:PreflightCtx):Promise<any> {
 const {sourceCwd, deps, heartbeat, emit, mock, dir, mode} = state;
 const t=c.t;
 emit('ticket-adr-gate');
 try {
  const gated=await raceSignal(ticketGate({
   cwd:sourceCwd,
   ticketId:t.ticket,
   deliverable:t.plan?.deliverable ?? t.id,
   classify:c.classify,
   ...((deps as any).ticketAdapter ? {adapter:(deps as any).ticketAdapter} : {}),
  }), c.signal);
  if (gated.status === 'needs_adr_decision') {
   writeFileSync(join(dir,'ticket-adr-gate.md'),renderTicketReport([gated.result]));
   heartbeat.setState('failed',{stopReason:'needs_adr_decision'});
   emit('finished needs_adr_decision');
   const out:any={ id:t.id, simulated:mock, status:'needs_adr_decision', workerExitCode:null,
    workerError:`ADR conformance findings on ticket ${t.ticket} need a human decision: junior adr decide`,
    checks:[], artifactDir:dir, runtime:heartbeat.snapshot(), lineage:c.lineage,
    sourceCwd, executionCwd:c.executionCwd, isolation:isolationRecord(state, c),
    modelRouting:c.modelRoute, adrGate:gated.result.gate };
   if (mode !== 'off') out.jev=c.jev;
   writeFileSync(join(dir,'result.json'),JSON.stringify(out,null,2));
   return out;
  }
  state.ticketGate={ ticketId:t.ticket, fromCache:gated.result.fromCache,
   irrelevant:gated.result.irrelevant, findings:gated.result.gate.findings.length };
 } catch (e) {
  state.ticketGateUnresolved=`ADR ticket gate skipped: ${msg(e)}`;
 }
 return undefined;
}

export function resolveProviderRouting(state:RunState, c:PreflightCtx):void {
 const {modelConfig, sourceCwd} = state;
 const {requested, modelRoute} = c;
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
 c.affinityKey = requested.provider==='openrouter' ? affinityKeyFor(sourceCwd, c.lineage.rootId ?? c.t.id) : null;
 c.openrouterRouting = requested.provider==='openrouter' && selectedProfile?.openrouter ? selectedProfile.openrouter : null;
 c.providerRouting = { affinityKey:c.affinityKey, openrouter:c.openrouterRouting };
}

export function decideRunWorkflow(state:RunState, c:PreflightCtx):void {
 const {mode} = state;
 const {t, jev, resume, explicitWorkflow} = c;
 // Workflow selection is deterministic and kept separate from gate status.
 const classifierRan = mode !== 'off' && !!c.classify && !!jev!.preflight && !jev!.preflight.error;
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
 if (decision.selected === 'qa' && explicitWorkflow === 'auto' && !c.review) {
  decision = {...decision, selected:'checks_first', source:'default', recommended:'qa',
   note:'qa requires reviewFrom; auto cannot authorize a QA review without a prior result' };
 }
 c.decision=decision;
}

export function clarificationApplies(state:RunState, c:PreflightCtx):boolean {
 const {deps} = state;
 const t=c.t;
 // Clarification gate: an unclear contract (or a vague-feature routing) is
 // interviewed before any commodity work. `checkBack: "off"` disables the loop,
 // and a contract already derived from a prepare brief or a prior clarification
 // never re-enters it. An explicit workflow still clarifies a contract that
 // Jev judges unclear (ADR-0003); it is never replaced for vague-feature routing
 // alone.
 return !!((t.hopFrom || deps.clarify?.hopPath || deps.clarify?.callHop)
     && clarityGateApplies({
      attention: c.jev?.preflight?.attention ?? null,
      workflow: c.explicitWorkflow,
      checkBack: c.checkBackMode,
      preparedFrom: t.preparedFrom,
      clarifiedFrom: t.clarifiedFrom,
      playbooks: c.preparePlan?.playbooks,
     }));
}

export function finalExternalContext(state:RunState, c:PreflightCtx):any {
 const {deps, sourceCwd, dir, heartbeat, emit, mock} = state;
 const {t, requested} = c;
 // Clarification has no worker/provider handoff. Enforce the final disclosure
 // only once the contract is clear, immediately before Pi or a provider can
 // receive source text.
 if (externalContextRequired(requested.provider)) {
  const preflight=buildExternalContextPreflight(t, sourceCwd, requested, deps);
  c.externalContext={ preflight, authorization:preflight.authorization };
  writeFileSync(join(dir,'external-context-preflight.json'),JSON.stringify(preflight,null,2));
  if (!preflight.authorization.granted) {
   const request={ provider:requested.provider, destination:preflight.destination, model:requested.model,
    scope:preflight.scope, reason:preflight.authorization.reason,
    approve:{ run:'set "externalContextConsent": true in the contract, or pass a provider/project consent token', project:`junior auth consent ${requested.provider} --project ${sourceCwd}` } };
   heartbeat.setState('failed',{stopReason:'needs_external_context_consent', error:request.reason});
   emit('finished needs_external_context_consent');
   const out:any={ id:t.id, simulated:mock, status:'needs_external_context_consent', workerExitCode:null,
    workerError:`external-context consent required: ${request.reason}`, checks:[], artifactDir:dir,
    runtime:heartbeat.snapshot(), lineage:c.lineage, sourceCwd, executionCwd:c.executionCwd, isolation:isolationRecord(state, c),
    modelRouting:c.modelRoute, externalContext:c.externalContext, externalContextConsent:request };
   writeFileSync(join(dir,'result.json'),JSON.stringify(out,null,2));
   return out;
  }
 }
 return undefined;
}

export function probePiIsolation(state:RunState, c:PreflightCtx):void {
 const {mock, deps} = state;
 // Probe the installed Pi CLI once for this non-mock run, before the first
 // spawn, and derive the isolation arguments from the task's piContext.
 let piIsolation:{applied:string[]; missing:string[]; ambient:boolean; probed:boolean; verification?:IsolationVerdict}|null=null;
 let isolationArgs:string[]=[];
 if (!mock) {
  // Offline spawn seams bypass the real CLI probe; production runs always probe.
  const capabilities = deps.piCapabilities !== undefined
   ? deps.piCapabilities
   : (deps.spawnPi || deps.spawnChild) ? null : probePiCapabilities();
  const isolationPlan = buildIsolationArgs(c.t.piContext, capabilities);
  isolationArgs = isolationPlan.args;
  piIsolation = { applied:isolationPlan.applied, missing:isolationPlan.missing, ambient:isolationPlan.ambient, probed:capabilities !== null };
 }
 c.piIsolation=piIsolation;
 c.isolationArgs=isolationArgs;
}

export function applyCheckBackAndTemplates(state:RunState, c:PreflightCtx):void {
 const {dir} = state;
 const {t, jev, preparePlan, prepareHistory, checkBackMode, explicitWorkflow} = c;
 const checkBackRecommended = typeof t.preparedFrom !== 'string' && c.decision.selected !== 'prepare'
     && shouldCheckBack(jev?.preflight?.attention ?? null, preparePlan, prepareHistory);
 if (checkBackRecommended && jev?.preflight?.attention) jev.preflight.attention.checkBackRecommended = true;
 if (checkBackRecommended && checkBackMode !== 'off' && (checkBackMode === 'always' || explicitWorkflow === 'auto')) {
  c.decision = {...c.decision, selected:'prepare', source:'default', recommended:'prepare',
   note:'Prepare check-back: the readiness assessment or routed playbooks call for researched options before implementation.'};
 }
 const decision=c.decision;
 c.prepareRun = decision.selected === 'prepare';
 c.isQa=decision.selected === 'qa';
 c.reportWorkflow = isReportWorkflow(decision.selected);
 // The report path is deterministic for the run and is only appended to a
 // report-only prompt. It is never generated by Jev.
 c.reportPath = c.prepareRun ? briefMdPath(dir) : (c.reportWorkflow ? analysisReportPath(dir) : null);
 c.templates={ common:WORKFLOW_TEMPLATE_IDS.common, workflow:WORKFLOW_TEMPLATE_IDS[decision.selected] };
 writeFileSync(join(dir,'workflow.json'),JSON.stringify({ promptTemplateId:WORKFLOW_TEMPLATE_IDS.common, common:c.templates.common, selected:decision.selected, workflowTemplateId:c.templates.workflow, report:c.reportPath, decision },null,2));
}

// Enforce preflight: block before spending worker cost. A required tool whose
// manager setup is unmet (no hopFrom to record its session) is a clarify, not
// a delegate, and is raised before the worker starts.
export function enforcePreflightGate(state:RunState, c:PreflightCtx):any {
 const {mock, heartbeat, dir, sourceCwd} = state;
 const {t, jev} = c;
 const pf = jev!.preflight;
 const hasHop = !!(t?.hopContext?.from ?? (typeof t?.hopFrom === 'string' && t.hopFrom.trim()));
 const requiredTool = pf?.attention?.toolPlan?.tools.find((entry:any)=>entry.relevance === 'required') ?? null;
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
  const preReceipt = mock ? mockReceipt({...c.requested,source:c.requestedSource}) : undefined;
  heartbeat.setState('failed',{stopReason:'blocked', error:blocker + reason});
  const blockedResult:any={ id:t.id, simulated:mock, status:'needs_review', workerExitCode:null,
   workerError:blocker + reason, receipt:preReceipt,
   cost: preReceipt ? estimateCost(preReceipt, t.pricing) : undefined,
   checks:[], artifactDir:dir, jev, workflow:c.decision, templates:c.templates, runtime:heartbeat.snapshot(), lineage:c.lineage,
   sourceCwd, executionCwd:c.executionCwd, isolation:isolationRecord(state, c),
   toolPlan: jev!.preflight?.attention?.toolPlan ?? null, modelRouting:c.modelRoute };
  writeFileSync(join(dir,'result.json'),JSON.stringify(blockedResult,null,2));
  return blockedResult;
 }
 return undefined;
}

export function writeRunPrompt(state:RunState, c:PreflightCtx):void {
 const {dir} = state;
 c.prompt=buildPrompt(c.t, c.decision.selected, c.resume, c.reportPath, c.reviewContext, c.codeContext, c.jev?.preflight?.attention?.toolPlan ?? null, c.executionCwd);
 writeFileSync(join(dir,'prompt.txt'),c.prompt);
 if (c.reviewContext) writeFileSync(join(dir,REVIEW_CONTEXT_FILENAME),c.reviewContext);
}

export function commitPreflightState(state:RunState, c:PreflightCtx):void {
 state.t=c.t; state.requested=c.requested; state.requestedSource=c.requestedSource;
 state.deadlineAt=c.deadlineAt; state.lineage=c.lineage;
 state.executionCwd=c.executionCwd; state.worktreePath=c.worktreePath;
 state.resume=c.resume; state.prior=c.prior; state.review=c.review; state.reviewContext=c.reviewContext;
 state.isRepair=c.isRepair; state.isQa=c.isQa; state.decision=c.decision; state.modelRoute=c.modelRoute;
 state.externalContext=c.externalContext; state.affinityKey=c.affinityKey;
 state.openrouterRouting=c.openrouterRouting; state.providerRouting=c.providerRouting;
 state.prepareRun=c.prepareRun; state.preparePlan=c.preparePlan; state.prepareHistory=c.prepareHistory;
 state.reportWorkflow=c.reportWorkflow; state.reportPath=c.reportPath; state.templates=c.templates;
 state.piIsolation=c.piIsolation; state.isolationArgs=c.isolationArgs; state.prompt=c.prompt;
 state.classify=c.classify; state.before=c.before;
 // Mark the synchronous completion so run() can reach launch without an extra
 // microtask when no classifier or clarify step had to await.
 state.preflightDone=true;
}

/** Workflow selection and the prepare check-back inputs, in order. */
export function prepareWorkflowDecision(state:RunState, c:PreflightCtx):void {
 resolveProviderRouting(state, c);
 decideRunWorkflow(state, c);
 // Prepare check-back gate: a capable junior does the legwork first and checks
 // back before acting. When Jev flags an unclear contract or a blocking
 // assumption, or the routed playbooks include a decision/plan playbook, run
 // the prepare workflow and hand back a brief for the manager to choose from.
 // A contract already derived from a prepare brief never checks back again.
 c.prepareHistory = loadPrepareHistory(state.sourceCwd);
 c.preparePlan = c.jev?.preflight?.attention?.toolPlan ?? null;
 // A workflow the manager chose explicitly is never replaced (Jev is advisory,
 // ADR-0003): the check-back applies when the contract leaves `workflow` on
 // auto, or sets `checkBack: "always"`; `checkBack: "off"` disables it. When
 // it is recommended but not applied, the receipt says so.
 c.checkBackMode = c.t.checkBack === 'always' || c.t.checkBack === 'off' ? c.t.checkBack : 'auto';
}

/** Final disclosure through the prompt; returns a held outcome or undefined. */
export function finishPreflight(state:RunState, c:PreflightCtx):any {
 const consentHeld=finalExternalContext(state, c);
 if (consentHeld) return consentHeld;
 probePiIsolation(state, c);
 applyCheckBackAndTemplates(state, c);
 if (state.mode === 'enforce') {
  const enforced=enforcePreflightGate(state, c);
  if (enforced) return enforced;
 }
 writeRunPrompt(state, c);
 commitPreflightState(state, c);
 return undefined;
}

/** The parent run's total-token budget, from the stream accounting recorded on
 * a prior result. Older results have no accounting, so the comparison is
 * skipped rather than guessed. */
function parentMaxTotalTokens(prior:any):number|null {
 const candidates=[
  prior?.budget?.requested?.maxTotalTokens,
  prior?.outputBreakdown?.budget?.requested?.maxTotalTokens,
  prior?.budget?.maxTotalTokens,
  prior?.receipt?.budget?.requested?.maxTotalTokens,
 ];
 for (const value of candidates) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
 }
 return null;
}

/**
 * #281: a contract budget above the workflow default, or above the parent run's
 * budget on a resume, needs a human-issued approval token. Returns the blocked
 * `needs_budget_approval` result, or undefined to continue.
 */
export function settleBudgetApproval(state:RunState, c:PreflightCtx):any {
 const {sourceCwd, dir, heartbeat, emit, mock, mode} = state;
 const t=c.t;
 const requested=t?.budget?.maxTotalTokens;
 if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return undefined;
 const workflow=c.explicitWorkflow && c.explicitWorkflow !== 'auto' ? c.explicitWorkflow : 'checks_first';
 const defaultTokens=effectiveBudget(workflow).maxTotalTokens;
 const parentTokens=c.prior ? parentMaxTotalTokens(c.prior) : null;
 const exceedsDefault=typeof defaultTokens === 'number' && requested > defaultTokens;
 const exceedsParent=parentTokens !== null && requested > parentTokens;
 if (!exceedsDefault && !exceedsParent) return undefined;
 if (findBudgetApproval(sourceCwd, t.id, requested)) return undefined;
 const command=`junior auth budget approve ${t.id} --tokens ${requested} --project ${sourceCwd}`;
 const reason=exceedsParent
  ? `budget.maxTotalTokens ${requested} exceeds the parent run's ${parentTokens}; a human must approve the increase (${command})`
  : `budget.maxTotalTokens ${requested} exceeds the workflow default ${defaultTokens}; a human must approve the increase (${command})`;
 const request={ id:t.id, requested, default:defaultTokens ?? null, parent:parentTokens, command, reason };
 recordPolicyEvent(state, {
  kind:'budget_raise_unapproved',
  action:'refused',
  source:'check',
  command:`budget.maxTotalTokens=${requested}`,
  reason,
 });
 heartbeat.setState('failed',{stopReason:'needs_budget_approval'});
 emit('finished needs_budget_approval');
 writeFileSync(join(dir,'budget-approval.json'),JSON.stringify(request,null,2));
 const out:any={ id:t.id, simulated:mock, status:'needs_budget_approval', workerExitCode:null,
  workerError:reason, checks:[], artifactDir:dir, runtime:heartbeat.snapshot(), lineage:c.lineage,
  sourceCwd, executionCwd:c.executionCwd, isolation:isolationRecord(state, c),
  modelRouting:c.modelRoute, budgetApproval:request, policyEvents:state.policyEvents };
 if (mode !== 'off') out.jev=c.jev;
 writeFileSync(join(dir,'result.json'),JSON.stringify(out,null,2));
 return out;
}
