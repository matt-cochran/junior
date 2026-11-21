import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeCheck, spawnChildDetached } from './runtime.ts';
import { resolveCheckCwd, resolveCommandPolicy } from './worker-contract.ts';
import { COMMAND_PLACEMENT_ERROR, DEFAULT_COMMAND_GUARDS, decideCommand, type CommandDecision } from './command-policy.ts';
import { POLICY_GUARD_ERROR, STALE_EVIDENCE_ERROR, guardCommand, isBuildCommand } from './command-guards.ts';
import { recordPolicyEvent } from './policy-events.ts';
import { remainingMs, runClock, type RunState } from './worker-preflight.ts';

/** A refusal message names the reason, the matching rule and the wrapper so a
 * refused check can be corrected without guessing which policy line applied. */
function placementError(decision:CommandDecision):string {
 const parts=[decision.reason ?? COMMAND_PLACEMENT_ERROR];
 if (decision.rule) parts.push(`rule: ${decision.rule.match.join(' ')}`);
 if (decision.wrapper) parts.push(`wrapper: ${decision.wrapper}`);
 return parts.join('; ');
}

/** Contract checks: independent, bounded by the wall deadline and the per-tool limit. */
export async function runChecks(state:RunState):Promise<RunState> {
 const {mock, deps, settings, sourceCwd, executionCwd, dir, heartbeat, emit, signal,
  deadlineAt, streamResult, workerStatus, receiptOk, t} = state;
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
  const policy=resolveCommandPolicy(t, sourceCwd);
  const guards=policy?.guards ?? DEFAULT_COMMAND_GUARDS;
  let lastBuild:'ok'|'failed'|'none'='none';
  for (let i=0;i<t.checks.length;i++) {
   const rem=remainingMs(state);
   if (rem <= 0) { deadlineDuringChecks=true; break; }
   const c=t.checks[i];
   emit(`check ${i+1}/${t.checks.length}`);
   const timeout=Math.max(1, Math.min(settings.checkTimeoutMs, settings.toolTimeoutMs, rem));
   const argv=[c.command, ...(Array.isArray(c.args) ? c.args : [])];
   const decision=decideCommand(policy, argv);
   if (decision.decision === 'refuse') {
    if (isBuildCommand(argv)) lastBuild='failed';
    const error=placementError(decision);
    writeFileSync(join(dir,`check-${i}.log`),`${error}\n`);
    checks.push({...c,timeoutMs:timeout,placement:decision.placement,exitCode:null,refused:COMMAND_PLACEMENT_ERROR,
     error,timedOut:false,interrupted:false,outputTruncated:false});
    continue;
   }
   const guard=guardCommand(argv, {source:'check', lastBuild, guards});
   if (guard?.action === 'refuse') {
    recordPolicyEvent(state, {...guard.event, checkIndex:i});
    if (isBuildCommand(argv)) lastBuild='failed';
    const error=guard.event.reason;
    writeFileSync(join(dir,`check-${i}.log`),`${error}\n`);
    checks.push({...c,timeoutMs:timeout,placement:decision.placement,exitCode:null,refused:POLICY_GUARD_ERROR,
     error,timedOut:false,interrupted:false,outputTruncated:false});
    continue;
   }
   const stale=guard?.action === 'flag_stale';
   if (stale) recordPolicyEvent(state, {...guard.event, checkIndex:i});
   const resolved=resolveCheckCwd(c.cwd, sourceCwd, executionCwd);
   if (resolved.error) {
    writeFileSync(join(dir,`check-${i}.log`),`${resolved.error}\n`);
    checks.push({...c,timeoutMs:timeout,placement:decision.placement,exitCode:null,error:resolved.error,timedOut:false,interrupted:false,outputTruncated:false});
    continue;
   }
   const checkCwd=resolved.cwd!;
   const r=await executeCheck({ spawnChild:spawnChildDetached, command:c.command, args:c.args, cwd:checkCwd,
    timeoutMs:timeout, deadlineAt, signal, maxOutputBytes:deps.maxOutputBytes, heartbeat, clock:runClock(state) });
   writeFileSync(join(dir,`check-${i}.log`),`${r.stdout || ''}\n${r.stderr || ''}`);
   checks.push({...c,cwd:checkCwd,timeoutMs:timeout,placement:decision.placement,exitCode:r.exitCode,
    error:stale ? STALE_EVIDENCE_ERROR : r.error,
    ...(stale ? {staleEvidence:true} : {}),
    timedOut:r.timedOut,interrupted:r.interrupted,outputTruncated:r.outputTruncated});
   if (isBuildCommand(argv)) {
    lastBuild = r.exitCode === 0 && !r.error && !r.timedOut && !r.interrupted ? 'ok' : 'failed';
   }
   if (r.interrupted || signal?.aborted) { interruptedDuringChecks=true; break; }
   if (r.deadlineExceeded) { deadlineDuringChecks=true; break; }
  }
 }

 state.checks=checks; state.interruptedDuringChecks=interruptedDuringChecks;
 state.deadlineDuringChecks=deadlineDuringChecks; state.workerRan=workerRan;
 state.stopped=stopped;
 return state;
}
