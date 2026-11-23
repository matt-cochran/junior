import { writeFileSync } from 'node:fs';
import { checkIdentity, classifyCheck } from './evidence-identity.ts';
import { join } from 'node:path';
import { executeCheck, spawnChildDetached } from './runtime.ts';
import { resolveCheckCwd, resolveCommandPolicy } from './worker-contract.ts';
import { COMMAND_PLACEMENT_ERROR, DEFAULT_COMMAND_GUARDS, decideCommand, type CommandDecision } from './command-policy.ts';
import { POLICY_GUARD_ERROR, STALE_EVIDENCE_ERROR, guardCommand, isBuildCommand } from './command-guards.ts';
import { recordPolicyEvent } from './policy-events.ts';
import { remainingMs, runClock, type RunState } from './worker-preflight.ts';
import { resolveMachineConfig, type ResolvedMachineConfig } from './admission.ts';
import { acquireAdmission, type AdmissionAttempt } from './worker-launch.ts';

/** A refusal message names the reason, the matching rule and the wrapper so a
 * refused check can be corrected without guessing which policy line applied. */
function placementError(decision:CommandDecision):string {
 const parts=[decision.reason ?? COMMAND_PLACEMENT_ERROR];
 if (decision.rule) parts.push(`rule: ${decision.rule.match.join(' ')}`);
 if (decision.wrapper) parts.push(`wrapper: ${decision.wrapper}`);
 return parts.join('; ');
}

type CheckStop='deadline'|'interrupted'|'halt'|null;
type BuildState='ok'|'failed'|'none';

/** State shared by every check of one run. */
interface CheckRun {
 state:RunState;
 machine:ResolvedMachineConfig;
 policy:ReturnType<typeof resolveCommandPolicy>;
 guards:NonNullable<ReturnType<typeof resolveCommandPolicy>>['guards'];
 checks:any[];
 lastBuild:BuildState;
}

/** One check, screened and placed, ready for admission. */
interface PreparedCheck {
 index:number;
 check:any;
 argv:string[];
 timeoutMs:number;
 placement:CommandDecision['placement'];
 stale:boolean;
 cwd:string;
}

function writeCheckLog(run:CheckRun, index:number, text:string):void {
 writeFileSync(join(run.state.dir,`check-${index}.log`), text);
}

/** Record a check that never ran, with its error as its log. */
function recordUnrun(run:CheckRun, index:number, record:any):void {
 writeCheckLog(run, index, `${record.error}\n`);
 run.checks.push(record);
}

/** Apply placement policy and command guards. A refusal is returned; otherwise
 * whether the check's evidence is flagged stale. */
function screenCheck(run:CheckRun, argv:string[], decision:CommandDecision, index:number):{refused:string; error:string}|{stale:boolean} {
 if (decision.decision === 'refuse') {
  if (isBuildCommand(argv)) run.lastBuild='failed';
  return {refused:COMMAND_PLACEMENT_ERROR, error:placementError(decision)};
 }
 const guard=guardCommand(argv, {source:'check', lastBuild:run.lastBuild, guards:run.guards});
 if (guard?.action === 'refuse') {
  recordPolicyEvent(run.state, {...guard.event, checkIndex:index});
  if (isBuildCommand(argv)) run.lastBuild='failed';
  return {refused:POLICY_GUARD_ERROR, error:guard.event.reason};
 }
 if (guard?.action === 'flag_stale') {
  recordPolicyEvent(run.state, {...guard.event, checkIndex:index});
  return {stale:true};
 }
 return {stale:false};
}

/** Screen and place check `index`; null when it was recorded as not run. */
function prepareCheck(run:CheckRun, index:number, remaining:number):PreparedCheck|null {
 const {settings, sourceCwd, executionCwd, t} = run.state;
 const check=t.checks[index];
 const timeoutMs=Math.max(1, Math.min(settings.checkTimeoutMs, settings.toolTimeoutMs, remaining));
 const argv=[check.command, ...(Array.isArray(check.args) ? check.args : [])];
 const decision=decideCommand(run.policy, argv);
 const unrun={...check,timeoutMs,placement:decision.placement,exitCode:null};
 const screened=screenCheck(run, argv, decision, index);
 if ('refused' in screened) {
  recordUnrun(run, index, {...unrun,refused:screened.refused,error:screened.error,timedOut:false,interrupted:false,outputTruncated:false});
  return null;
 }
 const resolved=resolveCheckCwd(check.cwd, sourceCwd, executionCwd);
 if (resolved.error) {
  recordUnrun(run, index, {...unrun,error:resolved.error,timedOut:false,interrupted:false,outputTruncated:false});
  return null;
 }
 return {index, check, argv, timeoutMs, placement:decision.placement, stale:screened.stale, cwd:resolved.cwd!};
}

/** Record a check that could not get a machine slot. Both outcomes stop the checks. */
function admissionRefused(run:CheckRun, prepared:PreparedCheck, attempt:Extract<AdmissionAttempt,{admitted:false}>):CheckStop {
 const timedOut=attempt.error === 'E_ADMISSION_TIMEOUT';
 const detail=attempt.wait ? `: ${attempt.wait.detail}` : '';
 const error=timedOut
  ? `Check admission timed out after ${attempt.waitedMs} ms${detail}.`
  : `Check admission interrupted${detail}.`;
 const {index, check, timeoutMs, placement} = prepared;
 recordUnrun(run, index, {...check,timeoutMs,placement,exitCode:null,
  refused:timedOut ? 'E_ADMISSION_TIMEOUT' : 'E_ADMISSION_INTERRUPTED',error,
  timedOut:false,interrupted:!timedOut,outputTruncated:false});
 if (!timedOut) return 'interrupted';
 run.state.admissionTimeout={kind:'check', waitedMs:attempt.waitedMs, wait:attempt.wait, checkIndex:index};
 return 'halt';
}

/** Admit and run one prepared check, then record its result. */
async function executePrepared(run:CheckRun, prepared:PreparedCheck):Promise<CheckStop> {
 const {state, machine} = run;
 const {deps, executionCwd, heartbeat, signal, deadlineAt, t} = state;
 const {index, check, argv, timeoutMs, placement, stale, cwd} = prepared;
 // The wait for a slot is bounded by the remaining run deadline, never by
 // the check's own timeout: that timeout starts once the check is admitted.
 const admissionTimeoutMs=Math.max(0, Math.min(machine.admissionTimeoutMs, remainingMs(state)));
 const attempt=await acquireAdmission(state, {kind:'check', holder:`${t.id}:check-${index}`, argv, config:machine, timeoutMs:admissionTimeoutMs, nextPhase:'checks'});
 if (!attempt.admitted) return admissionRefused(run, prepared, attempt);
 const checkStartedAt=runClock(state).now();
 let r:Awaited<ReturnType<typeof executeCheck>>;
 try {
  r=await executeCheck({ spawnChild:spawnChildDetached, command:check.command, args:check.args, cwd,
   timeoutMs, deadlineAt, signal, maxOutputBytes:deps.maxOutputBytes, heartbeat, clock:runClock(state) });
 } finally { attempt.grant.release(); }
 writeCheckLog(run, index, `${r.stdout || ''}\n${r.stderr || ''}`);
 run.checks.push({...check,cwd,timeoutMs,placement,exitCode:r.exitCode,
  error:stale ? STALE_EVIDENCE_ERROR : r.error,
  ...(stale ? {staleEvidence:true} : {}),
  timedOut:r.timedOut,interrupted:r.interrupted,outputTruncated:r.outputTruncated,
  phase:classifyCheck(argv), durationMs:runClock(state).now()-checkStartedAt,
  identity:checkIdentity({cwd:executionCwd, check})});
 if (isBuildCommand(argv)) {
  run.lastBuild = r.exitCode === 0 && !r.error && !r.timedOut && !r.interrupted ? 'ok' : 'failed';
 }
 if (r.interrupted || signal?.aborted) return 'interrupted';
 if (r.deadlineExceeded) return 'deadline';
 return null;
}

/** Run the contract's checks in order until one stops the run. */
async function runContractChecks(state:RunState):Promise<{checks:any[]; stop:CheckStop}> {
 const {sourceCwd, emit, t} = state;
 const policy=resolveCommandPolicy(t, sourceCwd);
 const run:CheckRun={state, machine:resolveMachineConfig(sourceCwd, t), policy, guards:policy?.guards ?? DEFAULT_COMMAND_GUARDS, checks:[], lastBuild:'none'};
 for (let i=0;i<t.checks.length;i++) {
  const remaining=remainingMs(state);
  if (remaining <= 0) return {checks:run.checks, stop:'deadline'};
  emit(`check ${i+1}/${t.checks.length}`);
  const prepared=prepareCheck(run, i, remaining);
  if (!prepared) continue;
  const stop=await executePrepared(run, prepared);
  if (stop) return {checks:run.checks, stop};
 }
 return {checks:run.checks, stop:null};
}

/** Contract checks: independent, bounded by the wall deadline and the per-tool limit. */
export async function runChecks(state:RunState):Promise<RunState> {
 const {mock, streamResult, workerStatus, receiptOk} = state;
 // Independent checks run only after a clean worker, and each is bounded by
 // both the remaining wall deadline and the per-tool limit.
 const workerRan=mock || (workerStatus === 0 && receiptOk);
 const stopped = !!streamResult && (streamResult.timedOut || streamResult.deadlineExceeded || streamResult.interrupted);
 // A worker stopped by its reserved worker deadline still runs the contract's
 // checks (bounded by the remaining total wall deadline); an interruption, a
 // per-tool timeout or a fatal stream/persist error never does.
 const workerDeadlineStopped = !!streamResult && streamResult.deadlineExceeded && !streamResult.interrupted && !streamResult.timedOut
  && !streamResult.streamError && !streamResult.persistError;
 // A worker stopped at the output cap never runs its checks: the receipt is
 // incomplete and the run is reported as output_truncated.
 const checksEligible = !streamResult?.outputTruncated && (stopped ? workerDeadlineStopped : (workerStatus === 0 && receiptOk));
 const {checks, stop} = checksEligible ? await runContractChecks(state) : {checks:[], stop:null as CheckStop};

 state.checks=checks; state.interruptedDuringChecks=stop === 'interrupted';
 state.deadlineDuringChecks=stop === 'deadline'; state.workerRan=workerRan;
 state.stopped=stopped;
 return state;
}
