import { writeFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { executeWorkerStreaming, spawnChildDetached, effectiveBudget, type WorkerStreamResult } from './runtime.ts';
import { buildPiArgs, piGuardModulePath, piBashTimeoutSeconds, preparePiAgentOverlay, cleanupPiAgentOverlay } from './worker-pi.ts';
import { classifyPiFailure, type PiFailure } from './pi-failure.ts';
import { buildContinuationCheckpoint, CONTINUATION_PROMPT_LEAD, OUTPUT_LIMIT_CONTINUATION_LINE } from './worker-gates.ts';
import { addUsage, emptyUsage, mockReceipt, parseReceipt, receiptValid } from './worker-receipt.ts';
import { resolveCommandPolicy, type Receipt } from './worker-contract.ts';
import { blockedResult, runClock, workerDeadlineAt, workerOutOfTime, workerRemainingMs, type RunState } from './worker-preflight.ts';
import { readDataPolicy, toRoutingPreferences } from './data-policy.ts';
import { admit, resolveMachineConfig, type AdmissionGrant, type AdmissionResult, type AdmissionWait, type ResolvedMachineConfig } from './admission.ts';

type SegmentRecord={index:number; eventsPath:string; stopReason:string; outputTruncated:boolean; outputLimited:boolean; checkpointPath:string|null};

type AdmissionFn=(req:Parameters<typeof admit>[0])=>ReturnType<typeof admit>;

export type AdmissionAttempt =
 | { admitted:true; grant:AdmissionGrant }
 | { admitted:false; error:'E_ADMISSION_TIMEOUT'|'E_ADMISSION_INTERRUPTED'; wait:AdmissionWait|null; waitedMs:number };

/** Take a machine slot for a worker or check, publishing each wait to the live
 * heartbeat and the run's admission log. A caller that gets a grant must
 * release it in a finally; a failed attempt has already published its wait. */
export async function acquireAdmission(state:RunState, req:{kind:'worker'|'check'; holder:string; argv?:string[]; config:ResolvedMachineConfig; timeoutMs?:number; nextPhase:'worker'|'checks'}):Promise<AdmissionAttempt> {
 const {deps, heartbeat, emit, signal}=state;
 const admissionDeps=deps as typeof deps & {admit?:AdmissionFn; admissionStateDir?:string; procRoot?:string};
 const injected=admissionDeps.admit;
 const config=req.timeoutMs === undefined ? req.config : {...req.config, admissionTimeoutMs:req.timeoutMs};
 if (!config.enabled && !injected) {
  heartbeat.update({phase:req.nextPhase, admission:null});
  return {admitted:true, grant:{waitedMs:0, pool:null, release(){}}};
 }
 const admitFn=injected ?? admit;
 let lastWait:AdmissionWait|null=null;
 const result:AdmissionResult=await admitFn({kind:req.kind, holder:req.holder, argv:req.argv, config,
  clock:runClock(state), signal,
  ...(admissionDeps.admissionStateDir === undefined ? {} : {stateDir:admissionDeps.admissionStateDir}),
  ...(admissionDeps.procRoot === undefined ? {} : {procRoot:admissionDeps.procRoot}),
  onWait:(wait)=>{ lastWait=wait; heartbeat.update({phase:'admission', admission:wait}); emit(`waiting for admission: ${wait.detail}`); }});
 const waitedMs=result.ok ? result.grant.waitedMs : result.waitedMs;
 const wait=result.ok ? lastWait : (result.wait ?? lastWait);
 if (wait) {
  const entry={...wait, waitedMs} as AdmissionWait & {waitedMs:number};
  state.admissionWaits=[...(state.admissionWaits ?? []), entry];
 }
 heartbeat.update({phase:req.nextPhase, admission:null});
 return result.ok
  ? {admitted:true, grant:result.grant}
  : {admitted:false, error:result.error, wait, waitedMs};
}

type LaunchRun={
 stdout:string; stderr:string; legacyError:string|undefined; workerStatus:number;
 streamResult:WorkerStreamResult|undefined; workerFailure:PiFailure|null|undefined;
 segments:SegmentRecord[]; segmentReceipts:Receipt[]; retriedFailure:boolean;
 eventsPath:string; logPath:string; piBashEnv:any;
};

function policyRoutingFor(state:RunState):any {
 const {sourceCwd, executionCwd} = state;
 // ADR 0017 R3: the Pi worker carries the same routing preferences through
 // compat.openRouterRouting in its run-local models.json overlay.
 const policyRoot=sourceCwd ?? executionCwd;
 const dataPolicy=state.dataPolicyRouting === undefined && policyRoot ? readDataPolicy(policyRoot) : null;
 // Preflight already resolved the policy, including any region-resolved `only`
 // list (ADR 0017 R2, R4). Use that routing when present instead of recomputing,
 // so the worker cannot loosen or bypass the fail-closed resolution.
 return state.dataPolicyRouting !== undefined
  ? state.dataPolicyRouting
  : (dataPolicy ? toRoutingPreferences(dataPolicy) : undefined);
}

function applyGuardEnv(state:RunState, piBashEnv:any, policyRouting:any):void {
 const {sourceCwd, isolation, dir, affinityKey, openrouterRouting, t, executionCwd} = state;
 if (isolation === 'worktree') {
  piBashEnv.JUNIOR_PI_WRITE_ROOTS = [executionCwd, dir].join(delimiter);
  piBashEnv.JUNIOR_PI_SOURCE_ROOT = sourceCwd;
 } else {
  piBashEnv.JUNIOR_PI_WRITE_ROOTS = [sourceCwd, dir].join(delimiter);
  delete piBashEnv.JUNIOR_PI_SOURCE_ROOT;
 }
 if (affinityKey) piBashEnv.JUNIOR_PI_AFFINITY_KEY = affinityKey;
 else delete piBashEnv.JUNIOR_PI_AFFINITY_KEY;
 // The guard merges this over the request's provider object at request time,
 // after Pi applies models.json compat, so the data policy is merged last: a
 // profile's routing (order, affinity) can never loosen it (ADR 0017 R3).
 const requestRouting=openrouterRouting || policyRouting ? { ...(openrouterRouting ?? {}), ...(policyRouting ?? {}) } : null;
 if (requestRouting) piBashEnv.JUNIOR_PI_OPENROUTER_ROUTING = JSON.stringify(requestRouting);
 else delete piBashEnv.JUNIOR_PI_OPENROUTER_ROUTING;
 // The guard enforces the contract's command placement on every bash call. The
 // policy is passed with manifest rules already merged, so the guard never
 // reads the manifest; an unset value means no policy.
 const commandPolicy=resolveCommandPolicy(t, sourceCwd);
 if (commandPolicy) piBashEnv.JUNIOR_COMMAND_POLICY = JSON.stringify(commandPolicy);
 else delete piBashEnv.JUNIOR_COMMAND_POLICY;
}

function runMock(run:LaunchRun):void {
 run.stdout='Simulation only; no implementation performed.';
 writeFileSync(run.eventsPath,run.stdout);
 writeFileSync(run.logPath,'');
 run.segments.push({index:0,eventsPath:run.eventsPath,stopReason:'mock',outputTruncated:false,outputLimited:false,checkpointPath:null});
}

function runSkipped(state:RunState, run:LaunchRun, preInterrupt:boolean, preDeadline:boolean):void {
 // The wall deadline (or an interruption) elapsed during readiness, isolation
 // or the classifier. Never start the paid worker; keep an inspectable handback.
 writeFileSync(run.eventsPath,''); writeFileSync(run.logPath,'');
 run.workerStatus=1;
 run.streamResult = { stdout:'', stderr:'', exitCode:null, signal:null,
  interrupted:preInterrupt, timedOut:false, deadlineExceeded:preDeadline, outputTruncated:false,
  stopReason: preInterrupt ? 'interrupted' : 'deadline_exceeded', runtime:state.heartbeat.snapshot() };
 run.segments.push({index:0,eventsPath:run.eventsPath,stopReason:run.streamResult.stopReason,outputTruncated:false,outputLimited:false,checkpointPath:null});
}

function runLegacy(state:RunState, run:LaunchRun):void {
 const {deps, requested, resume, t, executionCwd, prompt, isolationArgs} = state;
 const spawnTimeout=Math.max(1, Math.min(600000, 600000, Math.max(1, workerRemainingMs(state))));
 const r=deps.spawnPi('pi',[...buildPiArgs(requested, resume?.parentSessionId ?? null, t.thinking ?? 'low', piGuardModulePath(), isolationArgs),prompt],{cwd:executionCwd,encoding:'utf8',timeout:spawnTimeout,maxBuffer:33554432,env:run.piBashEnv});
 run.stdout=r.stdout || ''; run.stderr=r.stderr || '';
 run.workerStatus=r.status ?? (r.error ? 1 : 0);
 run.legacyError=r.error?.message;
 writeFileSync(run.eventsPath,run.stdout);
 writeFileSync(run.logPath,run.stderr);
 run.segments.push({index:0,eventsPath:run.eventsPath,stopReason:'legacy',outputTruncated:false,outputLimited:false,checkpointPath:null});
}

async function runSegment(state:RunState, run:LaunchRun, seg:{spawnChild:any, maxSegmentOutputBytes:any, segEventsPath:string, segLogPath:string, sessionId:string|null, segmentPrompt:string}):Promise<{segResult:WorkerStreamResult, segReceipt:Receipt}> {
 const {settings, heartbeat, requested, requestedSource, signal, runtimePath, t, executionCwd, isolationArgs} = state;
 let segResult:WorkerStreamResult;
 let segReceipt:Receipt;
 let segmentRetried = false;
 for (;;) {
  segResult = await executeWorkerStreaming({
   spawnChild:seg.spawnChild, command:'pi',
   args:[...buildPiArgs(requested, seg.sessionId, t.thinking ?? 'low', piGuardModulePath(), isolationArgs),seg.segmentPrompt],
   cwd:executionCwd, env:run.piBashEnv, eventsPath:seg.segEventsPath, logPath:seg.segLogPath, runtimePath, settings, deadlineAt:workerDeadlineAt(state),
   phase:'worker', signal, heartbeat, clock:runClock(state), maxOutputBytes: seg.maxSegmentOutputBytes,
   budget:effectiveBudget(state.decision.selected, t.budget), readScope:t.readScope,
  });
  run.stdout=segResult.stdout; run.stderr=segResult.stderr;
  run.workerStatus=segResult.exitCode ?? 1;
  run.legacyError=segResult.error;
  run.streamResult=segResult;
  segReceipt=parseReceipt(segResult.stdout ?? '', {...requested,source:requestedSource}, {outputTruncated: !!segResult.outputTruncated});
  // A transport failure that produced no assistant message is the only
  // failure safe to retry, and only once for the whole run. A stop Junior
  // made itself (budget, scope, watchdog, deadline, interrupt, output cap)
  // is not a Pi failure, so only Pi's own exits are classified.
  const piExited=segResult.stopReason === 'completed' || segResult.stopReason === 'failed';
  const failure=piExited ? classifyPiFailure({exitCode:segResult.exitCode, stderr:segResult.stderr, assistantMessages:segReceipt.assistantMessages, errorMessages:eventErrorMessages(segResult.stdout ?? '')}) : null;
  run.workerFailure=failure;
  if (!failure?.retryable || segReceipt.assistantMessages !== 0 || run.retriedFailure) break;
  run.retriedFailure=true;
  segmentRetried=true;
  await runClock(state).sleep(2000);
 }
 if (segmentRetried && run.workerFailure) run.workerFailure={...run.workerFailure, retried:true} as PiFailure;
 return {segResult, segReceipt};
}

function shouldContinue(state:RunState, segResult:WorkerStreamResult, segReceipt:Receipt, continuationIndex:number):boolean {
 // Continue when the segment hit the accumulation cap or the model's
 // per-message output limit; both leave the deliverable unfinished.
 if (!segResult.outputTruncated && !segReceipt.outputLimited) return false;
 // A budget or scope stop also marks the output truncated, but continuing
 // would spend past the limit that stopped it.
 if (segResult.budgetExceeded || segResult.scopeExceeded) return false;
 if (continuationIndex >= state.settings.continuations) return false;
 if (workerRemainingMs(state) < 60000) return false;
 return true;
}

async function runStreaming(state:RunState, run:LaunchRun):Promise<void> {
 const {deps, settings, dir, heartbeat, resume, t, executionCwd, prompt} = state;
 const spawnChild = deps.spawnChild ?? spawnChildDetached;
 const maxSegmentOutputBytes = deps.maxOutputBytes ?? settings.maxOutputBytes;
 let segmentPrompt = prompt;
 let continuationIndex = 0;
 for (;;) {
  // Continuation segments are new sessions (no --session) so a capped model
  // gets a fresh context with the checkpoint instead of a truncated history.
  const segEventsPath = continuationIndex === 0 ? run.eventsPath : join(dir, `events-${continuationIndex}.jsonl`);
  const segLogPath = continuationIndex === 0 ? run.logPath : join(dir, `worker-${continuationIndex}.log`);
  const sessionId = continuationIndex === 0 ? (resume?.parentSessionId ?? null) : null;
  const {segResult, segReceipt} = await runSegment(state, run, {spawnChild, maxSegmentOutputBytes, segEventsPath, segLogPath, sessionId, segmentPrompt});
  run.segmentReceipts.push(segReceipt);
  run.segments.push({index:continuationIndex,eventsPath:segEventsPath,stopReason:segResult.stopReason,outputTruncated:!!segResult.outputTruncated,outputLimited:segReceipt.outputLimited,checkpointPath:null});
  if (!shouldContinue(state, segResult, segReceipt, continuationIndex)) break;
  const nextIndex = continuationIndex + 1;
  const checkpointPath = join(dir, `checkpoint-${nextIndex}.md`);
  const checkpointText = buildContinuationCheckpoint(executionCwd, t, segEventsPath);
  writeFileSync(checkpointPath, checkpointText);
  run.segments[run.segments.length-1].checkpointPath = checkpointPath;
  segmentPrompt = `${prompt}\n\n${CONTINUATION_PROMPT_LEAD}\n\n${checkpointText}`;
  if (segReceipt.outputLimited) segmentPrompt += `\n\n${OUTPUT_LIMIT_CONTINUATION_LINE}`;
  continuationIndex = nextIndex;
  // The next segment starts clean: clear the previous segment's cap stop so
  // runtime.json reflects only the segment that actually ends the run.
  heartbeat.setState('running', { outputTruncated: false, stopReason: null } as any);
 }
}

function assembleReceipt(state:RunState, run:LaunchRun):Receipt {
 const {mock, requested, requestedSource} = state;
 const {segmentReceipts, streamResult} = run;
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
  receipt=parseReceipt(run.stdout,{...requested,source:requestedSource},{outputTruncated: !!streamResult?.outputTruncated});
  if (streamResult?.outputTruncated) receipt.outputTruncated = true;
 }
 return receipt;
}

/** Launch: Pi overlay/guard env, spawn or stream the worker, continuations and the receipt. */
export async function launch(state:RunState):Promise<RunState|any> {
 const {mock, deps, settings, dir, heartbeat, emit, signal, t} = state;
 // Execute the worker. Live runs use the streaming async child lifecycle and
 // never spawnSync; the injected spawnPi seam remains for legacy offline tests.
 const machine=resolveMachineConfig(state.sourceCwd, t);
 heartbeat.update({phase:'worker'});
 emit('worker started');
 const preInterrupt = !!signal?.aborted;
 const preDeadline = !preInterrupt && workerOutOfTime(state);
 // Pi's own bash timeout must fire before Junior's watchdog so a slow command
 // fails only that tool call and returns a tool error to the model. The guard
 // also confines writes to the execution checkout and keeps a worktree run out
 // of the source checkout.
 const piBashEnv:any = { ...(deps.env ?? process.env), JUNIOR_PI_BASH_TIMEOUT_S: String(piBashTimeoutSeconds(settings.toolTimeoutMs)) };
 const policyRouting=policyRoutingFor(state);
 const piOverlay=preparePiAgentOverlay(dir,piBashEnv, policyRouting ? {routing:policyRouting} : undefined);
 if (!piOverlay.dir) return blockedResult(state, `Pi worker was not started: ${piOverlay.error}. Ensure the repository .delivery directory is writable.`);
 piBashEnv.PI_CODING_AGENT_DIR=piOverlay.dir;
 applyGuardEnv(state, piBashEnv, policyRouting);
 const run:LaunchRun={ stdout:'', stderr:'', legacyError:undefined, workerStatus:0, streamResult:undefined, workerFailure:undefined,
  segments:[], segmentReceipts:[], retriedFailure:false, eventsPath:join(dir,'events.jsonl'), logPath:join(dir,'worker.log'), piBashEnv };
 let workerGrant:AdmissionGrant|undefined;
 try {
  if (mock) runMock(run);
  else if (preInterrupt || preDeadline) runSkipped(state, run, preInterrupt, preDeadline);
  else if (deps.spawnPi) runLegacy(state, run);
  // Admission off (and no injected admit): spawn without an await in between,
  // exactly as before admission existed.
  else if (!machine.enabled && !(deps as any).admit) await runStreaming(state, run);
  else {
   // The worker slot is held only around Pi. It is released before launch
   // returns, so the checks that follow never hold two machine slots. Waiting
   // for that slot may not consume the time reserved for the contract checks.
   const admissionTimeoutMs=Math.max(0, Math.min(machine.admissionTimeoutMs, workerRemainingMs(state)));
   if (admissionTimeoutMs <= 0) {
    run.workerStatus=1;
    writeFileSync(run.eventsPath,''); writeFileSync(run.logPath,'');
    state.admissionTimeout={kind:'worker', waitedMs:0, wait:null};
    run.legacyError='Worker admission timed out: no worker time remains before the reserved check window.';
   } else {
    const attempt=await acquireAdmission(state, {kind:'worker', holder:`${t.id}:worker`, config:machine, timeoutMs:admissionTimeoutMs, nextPhase:'worker'});
    if (!attempt.admitted) {
     run.workerStatus=1;
     writeFileSync(run.eventsPath,''); writeFileSync(run.logPath,'');
     if (attempt.error === 'E_ADMISSION_TIMEOUT') {
      state.admissionTimeout={kind:'worker', waitedMs:attempt.waitedMs, wait:attempt.wait};
      run.legacyError=`Worker admission timed out after ${attempt.waitedMs} ms${attempt.wait ? `: ${attempt.wait.detail}` : ''}.`;
     } else {
      run.legacyError=`Worker admission interrupted${attempt.wait ? `: ${attempt.wait.detail}` : ''}.`;
     }
    } else {
     workerGrant=attempt.grant;
     await runStreaming(state, run);
    }
   }
  }
 } finally {
  workerGrant?.release();
  // Pi has finished on every path; copied credentials and lock files never
  // outlive the process that needed them. Session files stay for resume.
  cleanupPiAgentOverlay(piOverlay.dir);
 }
 const receipt=assembleReceipt(state, run);
 const receiptOk=mock || receiptValid(receipt);

 state.stdout=run.stdout; state.stderr=run.stderr; state.legacyError=run.legacyError;
 state.workerStatus=run.workerStatus; state.streamResult=run.streamResult;
 state.workerFailure=run.workerFailure;
 state.segments=run.segments; state.segmentReceipts=run.segmentReceipts;
 state.receipt=receipt; state.receiptOk=receiptOk;
 return state;
}

/** Pi's own error texts from the event stream (`errorMessage`/`finalError`),
 * never tool output, so the failure classifier sees credential errors that Pi
 * reports only as an event (#203). */
export function eventErrorMessages(eventsText:string):string[] {
 const out:string[]=[];
 for (const line of eventsText.split('\n')) {
  if (!line.includes('rror')) continue;
  try {
   const ev=JSON.parse(line);
   for (const value of [ev?.errorMessage, ev?.finalError, ev?.message?.errorMessage]) {
    if (typeof value === 'string' && value && !out.includes(value)) out.push(value);
   }
  } catch { /* not a JSON event line */ }
 }
 return out;
}
