import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { briefMdPath, briefPath, buildPlaceholderBrief, renderBrief } from './prepare.ts';
import { designGate, implementationGate, resolveGateConfig } from './worker-adr-gate.ts';
import { classifyScope, incidentalGlobsFromConfig, type ScopeResult } from './scope-check.ts';
import { collectGitEvidence, evidenceDelta } from './evidence.ts';
import { withinWorkspace } from './worker-contract.ts';
import { matchesAppliesTo } from './adr.ts';
import { reportEvidence } from './worker-workflows.ts';
import type { ReportEvidence } from './worker-workflows.ts';
import { assessPostflight, raceSignal, resolveOpenRouterKey, OUTPUT_LIMIT_ERROR } from './worker-gates.ts';
import { captureBilling, BILLING_DEFAULT_TIMEOUT_MS, type BillingCapture } from './billing.ts';
import { verifyServedProviders } from './data-policy-run.ts';
import { estimateCost, type ContinuationProposal } from './worker-receipt.ts';
import { findUnwiredExports, type UnwiredSymbol } from './wiring-check.ts';
import { verifyIsolation, DEFAULT_PI_TOOLS } from './pi-isolation.ts';
import { timedOutToolLine } from './worker-pi.ts';
import { REVIEW_CONTEXT_FILENAME } from './worker-resume.ts';
import { classifierBudget, outOfTime, remainingMs, runClock, runNow, type RunState } from './worker-preflight.ts';

/** Shared error-message coercion, used across the worker modules. */
const msg=(e:unknown)=>e instanceof Error ? e.message : String(e);

const passing=(status:string)=>status === 'simulation_passed' || status === 'ready_for_review';

function streamWorkerError(state:RunState):any {
 const {streamResult, workerStatus, receipt, receiptOk, legacyError, stderr} = state;
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
 return workerError;
}

function resolveWorkerError(state:RunState):any {
 let workerError=streamWorkerError(state);
 // A typed Pi failure is more actionable than the generic exit/no-message
 // wording, so its summary is the worker error whenever the generic text was
 // what we would otherwise report.
 const workerFailure=state.workerFailure;
 if (workerFailure?.summary && (!workerError
   || workerFailure.category === 'provider_credit_exhausted'
   || workerError === 'Pi assistant message did not complete cleanly.'
   || workerError === 'Pi failed; inspect worker.log.'
   || workerError === 'Pi settled with no assistant messages.')) workerError=workerFailure.summary;
 return workerError;
}

function classifyRunScope(t:any, sourceCwd:string, evidence:any):ScopeResult|undefined {
 if (!t.scope) return undefined;
 let projectConfig:any={};
 try {
  const configPath=join(sourceCwd,'delivery.config.json');
  if (existsSync(configPath)) projectConfig=JSON.parse(readFileSync(configPath,'utf8'));
 } catch { projectConfig={}; }
 return classifyScope(evidence.runChangedFiles, t.scope.owned, {
  incidental: t.scope.incidental ?? incidentalGlobsFromConfig(projectConfig),
  repo: basename(sourceCwd),
 });
}

async function runPostflight(state:RunState, after:any, evidence:any):Promise<void> {
 const {deps, executionCwd, signal, mode, jev, reportWorkflow, reportPath, classify, checks, workerRan, stopped, t} = state;
 if (!(mode !== 'off' && classify && workerRan && !stopped && !outOfTime(state))) return;
 const git = deps.git ?? after;
 let report:ReportEvidence|undefined;
 if (reportWorkflow && reportPath && existsSync(reportPath)) {
  try { report=reportEvidence(readFileSync(reportPath,'utf8'),reportPath); } catch {}
 }
 const allowed = reportPath && withinWorkspace(executionCwd, reportPath) ? [relative(executionCwd, reportPath)] : [];
 try {
  const postflight = await raceSignal(assessPostflight(t, classify, checks, git, classifierBudget(state), evidence, {report,allowed,clock:runClock(state)}), signal);
  jev!.postflight = postflight;
  if (postflight.error) jev!.error = postflight.error;
 } catch (e) {
  jev!.error = `classifier unavailable: ${msg(e)}`;
 }
}

function terminalStatus(state:RunState):string {
 const {mock, streamResult, workerStatus, receiptOk, checks, signal, deadlineDuringChecks} = state;
 if (streamResult?.interrupted || signal?.aborted) return 'interrupted';
 if (streamResult?.timedOut) return 'worker_failed';
 const budgetStopped = streamResult?.budgetExceeded === true
  || streamResult?.stopReason === 'budget_exceeded'
  || streamResult?.budget?.stopReason === 'budget_exceeded';
 if (budgetStopped) return 'budget_exceeded';
 if (streamResult?.outputTruncated) return 'output_truncated';
 if (streamResult?.deadlineExceeded || deadlineDuringChecks || outOfTime(state)) return 'deadline_exceeded';
 if (streamResult?.persistError || streamResult?.streamError) return 'worker_failed';
 if (workerStatus !== 0) return 'worker_failed';
 if (!receiptOk) return 'receipt_failed';
 if (checks.some((c:any)=>c.exitCode !== 0 || c.error || c.timedOut || c.outputTruncated)) return 'checks_failed';
 return mock ? 'simulation_passed' : 'ready_for_review';
}

async function gatePrepareBrief(state:RunState, adrGateIssues:string[]):Promise<any> {
 const {mock, sourceCwd, dir, prepareRun, preparePlan, classify, t} = state;
 // A mock prepare run has no model to author the brief, so synthesize a
 // well-formed placeholder; a live run reads (and augments) what the worker
 // wrote. The brief always carries the routed playbooks so the correction-rate
 // history can be attributed to them.
 if (prepareRun && mock && !existsSync(briefPath(dir))) {
  const placeholder = buildPlaceholderBrief(t);
  writeFileSync(briefPath(dir), JSON.stringify(placeholder, null, 2));
  writeFileSync(briefMdPath(dir), renderBrief(placeholder));
 }
 // ADR 0018 R3/R5: gate the brief's design options before the manager is
 // asked to choose. The gated brief (findings and all) is what the manager
 // reads, so a flagged option is visible before implementation starts.
 let prepareBrief:any=null;
 if (!(prepareRun && existsSync(briefPath(dir)))) return prepareBrief;
 try { prepareBrief=JSON.parse(readFileSync(briefPath(dir),'utf8')); } catch { prepareBrief=null; }
 if (!prepareBrief) return prepareBrief;
 prepareBrief.playbooks=(preparePlan?.playbooks ?? []).map((p:any)=>p.id);
 if (classify) {
  try {
   prepareBrief=await designGate({cwd:sourceCwd,brief:prepareBrief,deliverable:t.plan?.deliverable ?? t.id,classify});
  } catch (e) {
   adrGateIssues.push(`ADR design gate skipped: ${msg(e)}`);
  }
 }
 writeFileSync(briefPath(dir), JSON.stringify(prepareBrief, null, 2));
 writeFileSync(briefMdPath(dir), renderBrief(prepareBrief));
 return prepareBrief;
}

function applyContractDowngrades(state:RunState, o:{status:string, workerError:any, analysis:any, reportPresent:boolean, prepareBrief:any, evidence:any}):{status:string, workerError:any} {
 const {reportPath, prepareRun, isQa} = state;
 let {status, workerError} = o;
 // An analysis-only workflow reports completion only when its deterministic
 // report exists in the run artifact directory. A missing report downgrades an
 // otherwise-passing run; it never upgrades a failure. This is a contract
 // boundary, not a sandbox guarantee.
 if (o.analysis && passing(status) && !o.reportPresent) {
  status='needs_review';
  workerError = workerError || `Analysis report missing: expected ${reportPath}; analysis-only workflows report completion only after the report exists.`;
 }
 // A completed prepare run stops at a choice, not at review: the manager must
 // pick an option before any implementation.
 if (prepareRun && o.prepareBrief && (passing(status) || status === 'needs_review')) {
  status='needs_choice';
 }

 // QA is report-only. If the reviewer changed production files despite the
 // instruction, the existing evidence delta flags it as needs_review; there is
 // no automatic remediation.
 if (isQa && o.evidence.changed && passing(status)) {
  status='needs_review';
  workerError = workerError || `QA run changed production files despite report-only instructions: ${o.evidence.runChangedFiles.map((f:any)=>f.path).join(', ')}`;
 }
 return {status, workerError};
}

async function runImplementationGate(state:RunState, status:string, evidence:any, adrGateIssues:string[]):Promise<{status:string, gate:any}> {
 const {mock, sourceCwd, executionCwd, dir, prepareRun, reportWorkflow, isQa, classify, t} = state;
 // ADR 0018 R3-R5: a live code handoff is checked at the implementation stage
 // before it is ready for review. A blocked gate needs a human decision (or
 // stops an unattended run); it never silently passes.
 let implementationAdrGate:any=null;
 if (!(!mock && !prepareRun && !reportWorkflow && !isQa && status === 'ready_for_review')) return {status, gate:implementationAdrGate};
 if (classify) {
  try {
   const gated=await implementationGate({
    cwd:sourceCwd,
    changedFiles:evidence.runChangedFiles.map((f:any)=>f.path),
    deliverable:t.plan?.deliverable ?? t.id,
    classify,
    unattended:t.unattended === true,
    contentRoot:executionCwd,
   });
   implementationAdrGate=gated.result;
   if (gated.markdown !== null) writeFileSync(join(dir,'adr-gate.md'),gated.markdown);
   if (gated.status !== null) {
    status=gated.status;
    adrGateIssues.push('ADR conformance findings need a human decision: junior adr decide (see adr-gate.md)');
   }
  } catch (e) {
   adrGateIssues.push(`ADR gate skipped: ${msg(e)}`);
  }
 } else {
  let hasAdrGate=false;
  try { hasAdrGate=resolveGateConfig(sourceCwd) !== null; } catch { hasAdrGate=false; }
  if (hasAdrGate) adrGateIssues.push('ADR gate skipped: classifier unavailable');
 }
 return {status, gate:implementationAdrGate};
}

function finalizeHeartbeat(state:RunState, status:string):void {
 const {heartbeat, streamResult, runStartedAt} = state;
 // Finalize the shared runtime heartbeat with the terminal state.
 heartbeat.update({phase:'done', elapsedMs:runNow(state)-runStartedAt, remainingMs:Math.max(0, remainingMs(state))});
 if (status === 'ready_for_review' || status === 'simulation_passed') heartbeat.setState('ready_for_review',{stopReason:status==='simulation_passed'?'simulation_passed':'ready_for_review'});
 else if (status === 'interrupted') heartbeat.setState('interrupted',{interrupted:true, stopReason:'interrupted'});
 else if (status === 'deadline_exceeded') heartbeat.setState('deadline_exceeded',{deadlineExceeded:true, stopReason:'deadline_exceeded'});
 else if (streamResult?.timedOut) heartbeat.setState('tool_timed_out',{timedOut:true, stopReason:'tool_timed_out'});
 else heartbeat.setState('failed',{stopReason:status});
}

async function captureRunBilling(state:RunState):Promise<BillingCapture|undefined> {
 const {mock, deps, receipt, signal, deadlineAt, t} = state;
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
 return billing;
}

function verifyRunDataPolicy(state:RunState, billing:BillingCapture|undefined):{record:any, issues:string[], violated:boolean} {
 // ADR 0017 R5: verify the upstream providers that actually served the run.
 // A provider outside the policy fails the run even when its checks passed. A
 // policy that could not be verified is recorded as a limitation, never a
 // silent pass.
 let dataPolicyRecord:any;
 const dataPolicyIssues:string[]=[];
 if (!state.dataPolicy) return {record:dataPolicyRecord, issues:dataPolicyIssues, violated:false};
 const routing=state.dataPolicyRouting ?? null;
 const resolvedOnly=Array.isArray((routing as any)?.only)
  ? ((routing as any).only as unknown[]).filter((value):value is string=>typeof value==='string')
  : undefined;
 const captured=Array.isArray(billing?.providers) ? billing.providers : [];
 if (captured.length===0) {
  dataPolicyRecord={ routing, providers:[], verified:false };
  dataPolicyIssues.push(billing?.reason
   ? `data policy: served providers could not be verified; billing capture failed: ${billing.reason}`
   : 'data policy: served providers could not be verified; set billing in the contract to capture them');
  return {record:dataPolicyRecord, issues:dataPolicyIssues, violated:false};
 }
 const verification=verifyServedProviders(
  state.dataPolicy,
  captured.map((entry:any)=>({ provider:typeof entry.provider==='string' ? entry.provider : null })),
  Array.isArray(state.dataPolicyDirectory) ? state.dataPolicyDirectory : [],
  resolvedOnly,
 );
 dataPolicyRecord={ routing, providers:verification.providers, verified:true };
 if (!verification.ok) {
  for (const entry of verification.providers) {
   if (!entry.allowed) dataPolicyIssues.push(`data policy: served provider ${entry.provider ?? 'unknown'} violated the policy: ${entry.reason ?? 'not allowed'}`);
  }
  state.heartbeat.setState('failed',{stopReason:'data_policy_violated'});
 }
 return {record:dataPolicyRecord, issues:dataPolicyIssues, violated:!verification.ok};
}

type Outcome={status:string, workerError:any, billing:BillingCapture|undefined, evidence:any, after:any, unwired:UnwiredSymbol[],
 scopeResult:ScopeResult|undefined, implementationAdrGate:any, dataPolicyRecord:any, adrGateIssues:string[], dataPolicyIssues:string[], prepareBrief:any, analysis:any};

function verifyPiIsolation(state:RunState):void {
 const {piIsolation, segments, t} = state;
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
}

function baseResult(state:RunState, o:Outcome):any {
 const {mock, settings, dir, heartbeat, decision, lineage, modelRoute, providerRouting, templates, streamResult, workerStatus, receipt, segments, checks, jev, t} = state;
 const runtime=heartbeat.snapshot();
 const result:any={id:t.id,simulated:mock,status:o.status,workerExitCode:workerStatus,workerError:o.workerError,receipt,cost:estimateCost(receipt,t.pricing,o.billing),checks,artifactDir:dir,workflow:decision,templates,runtime,lineage,outputTruncated: streamResult?.outputTruncated ?? false,segments,modelRouting:modelRoute,providerRouting,outputBreakdown: streamResult?.outputBreakdown ?? null,unwired:o.unwired};
 result.checkTimeoutMs=settings.checkTimeoutMs;
 if (state.workerFailure) result.workerFailure=state.workerFailure;
 result.toolPlan=jev?.preflight?.attention?.toolPlan ?? null;
 return result;
}

function attachGateResults(state:RunState, result:any, o:Outcome):void {
 const {piIsolation, externalContext, prepareRun, prepareHistory, streamResult, receipt} = state;
 if (piIsolation) result.piIsolation=piIsolation;
 if (externalContext) result.externalContext=externalContext;
 if (o.dataPolicyRecord) result.dataPolicy=o.dataPolicyRecord;
 if (state.matrixContext) result.matrixContext=state.matrixContext;
 if (o.scopeResult) result.scope=o.scopeResult;
 if (o.implementationAdrGate) result.adrGate=o.implementationAdrGate;
 // The ticket-stage check ran in preflight (ADR 0018 R3); surface its outcome.
 if ((state as any).ticketGate) result.ticketGate=(state as any).ticketGate;
 if ((state as any).ticketGateUnresolved) o.adrGateIssues.push((state as any).ticketGateUnresolved);
 if (prepareRun) { result.brief=o.prepareBrief; result.checkBack={ required:o.prepareBrief !== null, historyCount:prepareHistory.length }; }
 result.unresolved=[];
 for (const issue of o.adrGateIssues) result.unresolved.push(issue);
 for (const issue of o.dataPolicyIssues) result.unresolved.push(issue);
 if (streamResult?.timedOut && streamResult.timedOutTool) {
  result.timedOutTool={ name:streamResult.timedOutTool.name, command:streamResult.timedOutTool.command ?? null };
  result.unresolved.push(timedOutToolLine(streamResult.timedOutTool));
 }
 if (receipt.outputLimited) result.unresolved.push(OUTPUT_LIMIT_ERROR);
 const billing=o.billing;
 if (billing) result.billing={ source:billing.source, billedUsd:billing.billedUsd, reason:billing.reason ?? null, generationCount:billing.generationCount, capturedCount:billing.capturedCount, providers:billing.providers ?? [] };
}

function attachRunContext(state:RunState, result:any, o:Outcome):void {
 const {sourceCwd, executionCwd, isolation, dir, requested, resume, review, mode, jev, lineage, worktreePath, isRepair, receipt, t} = state;
 const {after, evidence} = o;
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
 if (state.resumeFallback) result.resumeFallback=state.resumeFallback;
 if (isRepair) result.repair={ from:resume?.from, parentSessionId:resume?.parentSessionId, rootId:lineage.rootId, repairs:lineage.repairs, maxRepairs:lineage.maxRepairs };
 if (t.hopContext) result.handoff={from:t.hopContext.from,projectId:t.hopContext.projectId,revision:t.hopContext.revision,managerAcceptance:t.hopContext.managerAcceptance};
 if (review) result.review={ from:review.from, priorResult:review.priorResult, context:join(dir,REVIEW_CONTEXT_FILENAME) };
 if (mode !== 'off') result.jev=jev;
 if (o.analysis) result.analysis=o.analysis;
 if (state.policyEvents && state.policyEvents.length > 0) result.policyEvents=state.policyEvents;
}

function normalizeContractPath(value:string):string {
 let path=value.trim().replaceAll('\\','/');
 while (path.startsWith('./')) path=path.slice(2);
 return path;
}

/** Owned (and, when supplied, allowed) contract files in declaration order,
 * normalized so they compare with Git's repository-relative paths. */
function contractScopeFiles(t:any):string[] {
 const files:string[]=[];
 const add=(value:any):void=>{
  const raw=typeof value==='string' ? value : (value && typeof value==='object' && typeof value.path==='string' ? value.path : '');
  if (!raw.trim()) return;
  const path=normalizeContractPath(raw);
  if (path && !files.includes(path)) files.push(path);
 };
 const scope=t?.scope;
 if (!scope || typeof scope!=='object' || Array.isArray(scope)) return files;
 for (const key of ['owned','allowed'] as const) {
  if (!Array.isArray(scope[key])) continue;
  for (const entry of scope[key]) add(entry);
 }
 return files;
}

const isTestFile=(path:string):boolean=>
 /(^|\/)(__tests__|tests?|specs?)\//i.test(path)
 || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path)
 || /(^|\/)(test_[^/]+|[^/]+_test)\.[a-z0-9]+$/i.test(path);

function buildContinuation(state:RunState, status:string, evidence:any, resultPath:string):ContinuationProposal|undefined {
 const {streamResult, t}=state;
 const budgetStopped = status === 'budget_exceeded'
  || streamResult?.budgetExceeded === true
  || streamResult?.stopReason === 'budget_exceeded'
  || streamResult?.budget?.stopReason === 'budget_exceeded';
 const reason:ContinuationProposal['reason']|null = budgetStopped
  ? 'budget_exceeded'
  : status === 'output_truncated' ? 'output_truncated' : null;
 if (reason === null) return undefined;

 const changedFiles=(Array.isArray(evidence?.runChangedFiles) ? evidence.runChangedFiles : [])
  .map((file:any)=>typeof file?.path==='string' ? normalizeContractPath(file.path) : '')
  .filter(Boolean);
 const remainingFiles=contractScopeFiles(t)
  .filter((owned)=>!changedFiles.some((changed)=>owned === changed || matchesAppliesTo(owned, changed)));
 const codeFiles=remainingFiles.filter((file)=>!isTestFile(file));
 const testFiles=remainingFiles.filter((file)=>isTestFile(file));
 const split:ContinuationProposal['split']=[];
 if (codeFiles.length > 0 && testFiles.length > 0) {
  split.push({ id:'code', files:codeFiles, note:'code files first' });
  split.push({ id:'tests', files:testFiles, note:'test files after the code part' });
 } else if (remainingFiles.length > 0 || codeFiles.length > 0 || testFiles.length > 0) {
  const onlyTests=codeFiles.length === 0 && testFiles.length > 0;
  split.push({ id:onlyTests ? 'tests' : 'code', files:remainingFiles, note:'all remaining owned files' });
 }
 const next:Record<string, unknown>={ id:`${t?.id}-cont-1` };
 if (t?.cwd !== undefined) next.cwd=t.cwd;
 if (t?.workflow !== undefined) next.workflow=t.workflow;
 if (t?.acceptance !== undefined) next.acceptance=t.acceptance;
 if (t?.checks !== undefined) next.checks=t.checks;
 if (t?.isolation !== undefined) next.isolation=t.isolation;
 next.resumeFrom=resultPath;
 return { reason, remainingFiles, changedFiles, split, next };
}

function buildResult(state:RunState, o:Outcome):any {
 const result=baseResult(state, o);
 verifyPiIsolation(state);
 attachGateResults(state, result, o);
 attachRunContext(state, result, o);
 const continuation=buildContinuation(state, o.status, o.evidence, join(state.dir, 'result.json'));
 if (continuation) result.continuation=continuation;
 return result;
}

/** Finish: workerError, evidence, postflight, status, billing and the result write. */
export async function finish(state:RunState):Promise<any> {
 const {sourceCwd, executionCwd, isolation, dir, heartbeat, emit, mode, jev, decision, reportWorkflow, reportPath, before, t} = state;
 let workerError=resolveWorkerError(state);

 // Capture post-run evidence and the run-only delta even after a timeout,
 // deadline breach or interruption, and persist the complete evidence pair.
 const after=collectGitEvidence(executionCwd, { timeoutMs: Math.max(1, remainingMs(state)) });
 const evidence=evidenceDelta(before, after);
 // Advisory wiring check: new exports with no production reference. It reads
 // only the post-run evidence and never contributes to the terminal status.
 let unwired:UnwiredSymbol[]=[];
 try { unwired=findUnwiredExports(executionCwd, evidence.runChangedFiles, { diff: after.diff }); } catch {}
 const scopeResult=classifyRunScope(t, sourceCwd, evidence);
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
 await runPostflight(state, after, evidence);

 // Terminal status. No success is ever reported after the wall deadline.
 let status=terminalStatus(state);
 const adrGateIssues:string[]=[];
 const prepareBrief=await gatePrepareBrief(state, adrGateIssues);

 const reportPresent = reportPath ? existsSync(reportPath) : false;
 const analysis = reportWorkflow && reportPath ? { workflow:decision.selected, report:reportPath, reportPresent } : undefined;
 ({status, workerError}=applyContractDowngrades(state, {status, workerError, analysis, reportPresent, prepareBrief, evidence}));

 const gated=await runImplementationGate(state, status, evidence, adrGateIssues);
 status=gated.status;
 const implementationAdrGate=gated.gate;

 // Enforce can only downgrade an otherwise-passing run; it never upgrades
 // worker/checks failures.
 if (mode === 'enforce' && passing(status)) {
  const bad = !jev!.preflight || jev!.preflight.status !== 'pass' || !jev!.postflight || jev!.postflight.status !== 'pass';
  if (bad) { status = 'needs_review'; jev!.enforced = true; }
 }

 emit(`finished ${status}`);
 finalizeHeartbeat(state, status);
 const billing=await captureRunBilling(state);
 const policy=verifyRunDataPolicy(state, billing);
 if (policy.violated) status='data_policy_violated';

 const result=buildResult(state, {status, workerError, billing, evidence, after, unwired, scopeResult, implementationAdrGate,
  dataPolicyRecord:policy.record, adrGateIssues, dataPolicyIssues:policy.issues, prepareBrief, analysis});
 state.workerError=workerError; state.status=status; state.billing=billing;
 writeFileSync(join(dir,'result.json'),JSON.stringify(result,null,2));
 return result;
}
