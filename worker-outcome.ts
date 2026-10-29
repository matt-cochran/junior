import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { briefMdPath, briefPath, buildPlaceholderBrief, renderBrief } from './prepare.ts';
import { classifyScope, incidentalGlobsFromConfig, type ScopeResult } from './scope-check.ts';
import { collectGitEvidence, evidenceDelta } from './evidence.ts';
import { withinWorkspace } from './worker-contract.ts';
import { reportEvidence } from './worker-workflows.ts';
import type { ReportEvidence } from './worker-workflows.ts';
import { assessPostflight, raceSignal, resolveOpenRouterKey, OUTPUT_LIMIT_ERROR } from './worker-gates.ts';
import { captureBilling, BILLING_DEFAULT_TIMEOUT_MS, type BillingCapture } from './billing.ts';
import { estimateCost } from './worker-receipt.ts';
import { verifyIsolation, DEFAULT_PI_TOOLS } from './pi-isolation.ts';
import { timedOutToolLine } from './worker-pi.ts';
import { REVIEW_CONTEXT_FILENAME } from './worker-resume.ts';
import { classifierBudget, outOfTime, remainingMs, type RunState } from './worker-preflight.ts';

/** Shared error-message coercion, used across the worker modules. */
const msg=(e:unknown)=>e instanceof Error ? e.message : String(e);

/** Finish: workerError, evidence, postflight, status, billing and the result write. */
export async function finish(state:RunState):Promise<any> {
 const {mock, deps, settings, sourceCwd, executionCwd, isolation, dir, heartbeat, emit,
  requested, requestedSource, resume, prior, review, signal, mode, jev, decision, lineage,
  modelRoute, providerRouting, externalContext, piIsolation, worktreePath, reportWorkflow,
  reportPath, prepareRun, preparePlan, prepareHistory, isQa, isRepair, templates, classify,
  before, streamResult, workerStatus, receipt, receiptOk, legacyError, segments, checks,
  workerRan, stopped, deadlineAt, deadlineDuringChecks, runStartedAt, stderr, t} = state;
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
 const after=collectGitEvidence(executionCwd, { timeoutMs: Math.max(1, remainingMs(state)) });
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
 if (mode !== 'off' && classify && workerRan && !stopped && !outOfTime(state)) {
  const git = deps.git ?? after;
  let report:ReportEvidence|undefined;
  if (reportWorkflow && reportPath && existsSync(reportPath)) {
   try { report=reportEvidence(readFileSync(reportPath,'utf8'),reportPath); } catch {}
  }
  const allowed = reportPath && withinWorkspace(executionCwd, reportPath) ? [relative(executionCwd, reportPath)] : [];
  try {
   const postflight = await raceSignal(assessPostflight(t, classify, checks, git, classifierBudget(state), evidence, {report,allowed}), signal);
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
 else if (streamResult?.deadlineExceeded || deadlineDuringChecks || outOfTime(state)) status='deadline_exceeded';
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
 heartbeat.update({phase:'done', elapsedMs:Date.now()-runStartedAt, remainingMs:Math.max(0, remainingMs(state))});
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
 state.workerError=workerError; state.status=status; state.billing=billing;
 writeFileSync(join(dir,'result.json'),JSON.stringify(result,null,2));
 return result;
}
