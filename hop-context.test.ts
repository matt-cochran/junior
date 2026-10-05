import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {initHop,saveHop,callHop,inspectHop,recordManagerAcceptance} from './tools/tools.ts';
import {loadHopContext} from './hop-context.ts';
import {run} from './worker.ts';

function fixture(t:any) {
 const dir=mkdtempSync(join(tmpdir(),'junior-hop-context-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'hop.json');
 const tools=Object.fromEntries(['fmeca','cpm','crossmatrix'].map(name=>[name,{command:process.execPath,args:[join(import.meta.dirname,'tools/test-fixtures/fake-mcp.mjs')],env:{FAKE_MCP_MODE:'echo'},sourceVersion:'test',sourceSha:'0'.repeat(40)}]));
 initHop(path,{projectId:'shared',tools});return {dir,path};
}
function task(dir:string,path:string) {return {id:'hop-task',cwd:dir,hopFrom:path,deliverable:'Use the shared handoff',acceptance:['Shared state is considered'],checks:[{command:process.execPath,args:['-e','process.exit(0)']}],jev:{mode:'shadow'}};}

test('The manager and executor can read the same persisted project revision',t=>{
 const {path}=fixture(t);assert.equal(loadHopContext(path).projectId,'shared');
});
test('A state change invalidates earlier manager acceptance',async t=>{
 const {path}=fixture(t);await recordManagerAcceptance(path,true,'reviewed');
 await callHop(path,'fmeca',{tool:'state.get',arguments:{session_id:'s'}});
 assert.equal(inspectHop(path).managerAcceptance,'pending');
});
test('Jev receives the shared handoff revision in its classifier context',async t=>{
 const {dir,path}=fixture(t);let revision:any;
 await run(task(dir,path),true,{classify:async context=>{revision=context.state.handoff?.revision;return {stopReason:'stop',answers:{},usage:{}};}});
 assert.equal(revision,0);
});
test('A modified snapshot blocks delegation before the worker starts',async t=>{
 const {dir,path}=fixture(t);const hop=inspectHop(path);const model=JSON.stringify({risks:[]});
 const manifest=JSON.parse((await import('node:fs')).readFileSync(path,'utf8'));
 writeFileSync(join(dir,'snapshot.json'),model);
 manifest.snapshots=[{id:'s',tool:'fmeca',toolName:'state.get',kind:'read',revision:0,path:'snapshot.json',sha256:createHash('sha256').update(model).digest('hex'),createdAt:new Date().toISOString()}];
 saveHop(path,manifest);writeFileSync(join(dir,'snapshot.json'),'tampered');
 let calls=0;await run(task(dir,path),false,{spawnPi:()=>{calls++;return {status:0};}});
 assert.equal(calls,0);
});
test('A stale handoff revision blocks execution before any worker call',async t=>{
 const {dir,path}=fixture(t);let calls=0;
 await run({...task(dir,path),hopRevision:99},false,{spawnPi:()=>{calls++;return {status:0};}});
 assert.equal(calls,0);
});
