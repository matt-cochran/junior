import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {initHop,saveHop,callHop,inspectHop,recordManagerAcceptance} from './tools/tools.ts';
import {loadHopContext,discoverHops,resolveHop,selectActiveHop} from './hop-context.ts';
import {run} from './worker.ts';

function fixture(t:any) {
 const dir=mkdtempSync(join(tmpdir(),'junior-hop-context-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'hop.json');
 const tools=Object.fromEntries(['fmeca','cpm','crossmatrix'].map(name=>[name,{command:process.execPath,args:[join(import.meta.dirname,'tools/test-fixtures/fake-mcp.mjs')],env:{FAKE_MCP_MODE:'echo'},sourceVersion:'test',sourceSha:'0'.repeat(40)}]));
 initHop(path,{projectId:'shared',tools});return {dir,path};
}
function task(dir:string,path:string) {return {id:'hop-task',cwd:dir,hopFrom:path,deliverable:'Use the shared handoff',acceptance:['Shared state is considered'],checks:[{command:process.execPath,args:['-e','process.exit(0)']}],externalContextConsent:true,jev:{mode:'shadow'}};}

function project(t:any) {
 const root=mkdtempSync(join(tmpdir(),'junior-hop-discovery-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 return root;
}
function nestedHop(root:string,name:string,projectId=name) {
 const path=join(root,'.delivery',name,'hop.json');
 const tools=Object.fromEntries(['fmeca','cpm','crossmatrix'].map(tool=>[tool,{command:process.execPath,args:[join(import.meta.dirname,'tools/test-fixtures/fake-mcp.mjs')],env:{FAKE_MCP_MODE:'echo'},sourceVersion:'test',sourceSha:'0'.repeat(40)}]));
 initHop(path,{projectId,tools});return path;
}

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

test('discoverHops finds no manifest in a project without nested Hops',t=>{
 const root=project(t);assert.deepEqual(discoverHops(root),[]);
});
test('discoverHops finds the single Hop nested under .delivery',t=>{
 const root=project(t);nestedHop(root,'cicd-execution');
 assert.deepEqual(discoverHops(root).map(hop=>hop.relativePath),['.delivery/cicd-execution/hop.json']);
});
test('discoverHops ignores Hop manifests inside dependency directories',t=>{
 const root=project(t);nestedHop(root,'cicd-execution');nestedHop(join(root,'.delivery','cicd-execution','node_modules','package'),'hidden');
 assert.deepEqual(discoverHops(root).map(hop=>hop.relativePath),['.delivery/cicd-execution/hop.json']);
});
test('resolveHop selects the only nested Hop without an absolute path',t=>{
 const root=project(t);const path=nestedHop(root,'cicd-execution');const selected=resolveHop(root);
 assert.deepEqual({status:selected.status,path:selected.status==='selected'?selected.path:null},{status:'selected',path:realpathSync(path)});
});
test('resolveHop uses the default Hop path when no nested Hop exists',t=>{
 const root=project(t);const selected=resolveHop(root);
 assert.equal(selected.status==='none'?selected.path:null,join(root,'.delivery','setup','hop.json'));
});
test('resolveHop reports every nested Hop in deterministic order without guessing',t=>{
 const root=project(t);nestedHop(root,'beta');nestedHop(root,'alpha');const selected=resolveHop(root);
 assert.deepEqual(selected.status==='ambiguous'?selected.candidates.map(hop=>hop.relativePath):[],['.delivery/alpha/hop.json','.delivery/beta/hop.json']);
});
test('An ambiguous Hop selection gives an actionable --hop command',t=>{
 const root=project(t);nestedHop(root,'beta');nestedHop(root,'alpha');const selected=resolveHop(root);
 assert.match(selected.status==='ambiguous'?selected.candidates[0].selectCommand:'',/^junior compact --hop \".*\.delivery\/alpha\/hop\.json\"$/);
});
test('resolveHop uses a configured tools.hop selection before discovery',t=>{
 const root=project(t);nestedHop(root,'alpha');const selected=nestedHop(root,'beta');
 writeFileSync(join(root,'delivery.config.json'),JSON.stringify({tools:{hop:'.delivery/beta/hop.json'}}));
 const resolved=resolveHop(root);
 assert.equal(resolved.status==='selected'?resolved.path:null,realpathSync(selected));
});
test('selectActiveHop makes the chosen nested Hop the active selection',t=>{
 const root=project(t);nestedHop(root,'alpha');const selected=nestedHop(root,'beta');
 selectActiveHop(root,selected);const resolved=resolveHop(root);
 assert.deepEqual(resolved.status==='selected'?{status:resolved.status,source:resolved.source,path:resolved.path}:null,{status:'selected',source:'active',path:realpathSync(selected)});
});
test('An explicit Hop path wins over multiple nested candidates',t=>{
 const root=project(t);nestedHop(root,'alpha');const selected=nestedHop(root,'beta');const resolved=resolveHop(root,{explicit:selected});
 assert.equal(resolved.status==='selected'?resolved.path:null,realpathSync(selected));
});
