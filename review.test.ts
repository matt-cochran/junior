import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {run, collectGitEvidence, evidenceDelta} from './worker.ts';
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