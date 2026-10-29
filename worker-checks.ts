import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeCheck, spawnChildDetached } from './runtime.ts';
import { resolveCheckCwd } from './worker-contract.ts';
import { remainingMs, type RunState } from './worker-preflight.ts';

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
  for (let i=0;i<t.checks.length;i++) {
   const rem=remainingMs(state);
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

 state.checks=checks; state.interruptedDuringChecks=interruptedDuringChecks;
 state.deadlineDuringChecks=deadlineDuringChecks; state.workerRan=workerRan;
 state.stopped=stopped;
 return state;
}
