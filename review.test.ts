import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {run, collectGitEvidence, evidenceDelta, assessPreflight} from './worker.ts';
import {compactHandoff} from './handoff.ts';

function temp(t:any) { const dir=mkdtempSync(join(tmpdir(),'junior-review-')); t.after(()=>rmSync(dir,{recursive:true,force:true})); return dir; }
function stream(reason:string) {return [{type:'session',id:'review-fixture'}, {type:'message_end',message:{role:'assistant',provider:'openrouter',model:'deepseek/deepseek-v4.1-flash',stopReason:reason,usage:{input:1,output:1,totalTokens:2}}}, {type:'agent_settled'}].map(x=>JSON.stringify(x)).join('\n');}

test('An output-limited worker cannot hand back success despite passing checks', async t=>{
 const cwd=temp(t);
 const result=await run({id:'limited',cwd,deliverable:'Required behavior',acceptance:['Required behavior is delivered'],workflow:'checks_first',checks:[{command:process.execPath,args:['-e','process.exit(0)']}]},false,{spawnPi:()=>({status:0,stdout:stream('length')})});
 assert.equal(result.status,'receipt_failed');
});

test('A timed-out check remains failed when its process exits zero',()=>{
 const receipt=compactHandoff({checks:[{command:'check',args:[],exitCode:0,timedOut:true}]});
 assert.equal(receipt.checks[0].passed,false);
});

test('A failed check is an actionable unresolved issue in the manager receipt',()=>{
 const receipt=compactHandoff({checks:[{command:'check',args:[],exitCode:1}]});
 assert.equal(receipt.unresolved[0],'check failed: check');
});

test('An untracked file edit is detectable after the prompt content budget is exhausted',t=>{
 const cwd=temp(t);
 function git(args:string[]) { const r=spawnSync('git',args,{cwd,encoding:'utf8'}); if(r.status!==0) throw Error(r.stderr); }
 git(['init','--quiet']); git(['-c','user.name=Test','-c','user.email=test@example.com','commit','--allow-empty','-m','baseline','--quiet']);
 writeFileSync(join(cwd,'new.txt'),'first');
 const before=collectGitEvidence(cwd,{maxUntrackedBytes:0});
 writeFileSync(join(cwd,'new.txt'),'other');
 const after=collectGitEvidence(cwd,{maxUntrackedBytes:0});
 assert.deepEqual(evidenceDelta(before,after).runChangedFiles.map(f=>f.path),['new.txt']);
});
test('A misspelled mock flag is rejected before it can start a paid run',t=>{
 const cwd=temp(t);
 const result=spawnSync(process.execPath,[join(import.meta.dirname,'junior.ts'),'handoff',join(cwd,'absent.json'),'--mok'],{encoding:'utf8'});
 assert.match(result.stderr,/Unknown option for handoff: --mok/);
});
test('Compact status rejects a malformed saved result',t=>{
 const cwd=temp(t);const path=join(cwd,'invalid.json');writeFileSync(path,'{}');
 const result=spawnSync(process.execPath,[join(import.meta.dirname,'junior.ts'),'status',path],{encoding:'utf8'});
 assert.match(result.stderr,/Malformed result: missing id/);
});

const gateTask={id:'routing',deliverable:'Implement an approved bounded behavior',acceptance:['Public behavior matches the contract'],checks:[{command:process.execPath,args:['-e','process.exit(0)']}]};
const routingClassifier=(probability?:number):any=>async()=>({stopReason:'stop',answers:{contract_clear:{type:'bool',probability:0.95},blocking_assumptions:{type:'bool',probability:0.05},...(probability===undefined?{}:{requires_frontier:{type:'bool',probability}})}});
test('A frontier-required task is assigned to frontier attention',async()=>{
 assert.equal((await assessPreflight(gateTask,routingClassifier(0.95))).attention.target,'frontier');
});
test('A confidently delegatable task passes readiness',async()=>{
 assert.equal((await assessPreflight(gateTask,routingClassifier(0.05))).status,'pass');
});
test('Missing frontier classification cannot silently pass readiness',async()=>{
 assert.equal((await assessPreflight(gateTask,routingClassifier())).status,'uncertain');
});
test('Uncertain frontier classification asks the manager to decide',async()=>{
 assert.equal((await assessPreflight(gateTask,routingClassifier(0.5))).attention.target,'manager');
});
test('Enforced frontier attention does not start the commodity worker',async t=>{
 let started=0;const cwd=temp(t);
 await run({...gateTask,cwd,jev:{mode:'enforce'}},false,{classify:routingClassifier(0.95),spawnPi:()=>{started++;return {status:0,stdout:stream('stop')};}});
 assert.equal(started,0);
});
test('The compact receipt exposes frontier attention to the manager',async t=>{
 const cwd=temp(t);const result=await run({...gateTask,cwd,jev:{mode:'enforce'}},false,{classify:routingClassifier(0.95)});
 assert.equal(compactHandoff(result).attention?.decision,'frontier_required');
});
test('Shadow frontier classification remains advisory',async t=>{
 const cwd=temp(t);const result=await run({...gateTask,cwd,jev:{mode:'shadow'}},true,{classify:async({questions}:any)=>Object.hasOwn(questions,'requires_frontier')?routingClassifier(0.95)():{stopReason:'stop',answers:{AC1:{type:'bool',probability:0.95}}}});
 assert.equal(result.status,'simulation_passed');
});
