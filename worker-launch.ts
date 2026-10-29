import { writeFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { executeWorkerStreaming, spawnChildDetached, type WorkerStreamResult } from './runtime.ts';
import { buildPiArgs, piGuardModulePath, piBashTimeoutSeconds, preparePiAgentOverlay } from './worker-pi.ts';
import { buildContinuationCheckpoint, CONTINUATION_PROMPT_LEAD, OUTPUT_LIMIT_CONTINUATION_LINE } from './worker-gates.ts';
import { addUsage, emptyUsage, mockReceipt, parseReceipt, receiptValid } from './worker-receipt.ts';
import type { Receipt } from './worker-contract.ts';
import { blockedResult, workerDeadlineAt, workerOutOfTime, workerRemainingMs, type RunState } from './worker-preflight.ts';

/** Launch: Pi overlay/guard env, spawn or stream the worker, continuations and the receipt. */
export async function launch(state:RunState):Promise<RunState|any> {
 const {mock, deps, settings, sourceCwd, isolation, dir, heartbeat, emit, requested,
  requestedSource, resume, signal, affinityKey, openrouterRouting, runtimePath, t, executionCwd,
  prompt, isolationArgs} = state;
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
 const preDeadline = !preInterrupt && workerOutOfTime(state);
 // Pi's own bash timeout must fire before Junior's watchdog so a slow command
 // fails only that tool call and returns a tool error to the model. The guard
 // also confines writes to the execution checkout and keeps a worktree run out
 // of the source checkout.
 const piBashEnv:any = { ...(deps.env ?? process.env), JUNIOR_PI_BASH_TIMEOUT_S: String(piBashTimeoutSeconds(settings.toolTimeoutMs)) };
 const piOverlay=preparePiAgentOverlay(dir,piBashEnv);
 if (!piOverlay.dir) return blockedResult(state, `Pi worker was not started: ${piOverlay.error}. Ensure the repository .delivery directory is writable.`);
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
  const spawnTimeout=Math.max(1, Math.min(600000, 600000, Math.max(1, workerRemainingMs(state))));
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
    cwd:executionCwd, env:piBashEnv, eventsPath:segEventsPath, logPath:segLogPath, runtimePath, settings, deadlineAt:workerDeadlineAt(state),
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
   if (workerRemainingMs(state) < 60000) break;
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

 state.stdout=stdout; state.stderr=stderr; state.legacyError=legacyError;
 state.workerStatus=workerStatus; state.streamResult=streamResult;
 state.segments=segments; state.segmentReceipts=segmentReceipts;
 state.receipt=receipt; state.receiptOk=receiptOk;
 return state;
}
