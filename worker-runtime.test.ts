import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { validate,run as runWorker,parseReceipt,mockReceipt,receiptValid,emptyUsage,
 jevMode,assessPreflight,assessPostflight,boundEvidence,boundedGitEvidence,resolveClassifierModel,reportEvidence,deterministicCriterion,
 createTypesafeClassifier,createJevClassifier,
 estimateCost,validatePricing,CONTRACT_PARTS,
 taskWorkflow,decideWorkflow,choiceVerdict,buildPrompt,promptParts,buildPiArgs,piGuardModulePath,piBashTimeoutSeconds,
 resolveResume,loadResume,sessionLockKey,COMMON_PROMPT_BLOCK,WORKFLOW_PROMPT_BLOCKS,WORKFLOW_TEMPLATE_IDS,
 EXPLICIT_WORKFLOWS,WORKFLOW_DESCRIPTIONS,ANALYSIS_WORKFLOWS,ANALYSIS_REPORT_FILENAME,analysisReportPath,analysisReportBlock,isAnalysisWorkflow,
 hopToolBlock,discoverReportBlock,investigateReportBlock,
 collectGitEvidence,evidenceDelta,resolveIsolation,sourceDirty,createDetachedWorktree,
 isWorktreeOf,acquireLock,lockPathFor,
 resolveExecutionSettings,validateExecutionSettings,executeWorkerStreaming,spawnChildDetached,
 ToolWatchdog,EXECUTION_DEFAULTS,RuntimeHeartbeat,decideModelRoute,affinityKeyFor,
 validateReadScope,validateBudget,validateScopeExpansion,scopeExpansionPaths,resolveContext,readScopePathMatches,doctor as workerDoctor } from './worker.ts';
import { doctor,init,setupCompanions,installSkill,inspectSkill,parseInitOptions,discoverInstalledPi,loadDefaults,checkCredentialsOnline,detectSlowMount,SUPPORTED_NODE_MIN,DEFAULT_PROVIDER,DEFAULT_MODEL,PI_PACKAGE,INSTALL_TIMEOUT_MS,PACKAGED_SKILL_PATH,TESTED_PI_VERSION } from './setup.ts';
import { compactHandoff } from './handoff.ts';
import { recordExternalContextConsent } from './auth.ts';
import { GatewayError } from './gateway.ts';
import { loadPlaybooks } from './playbooks.ts';
import { seedSession, run, task, COMMODITY_MODEL, ROUTED_MODEL, cli, resultFile, saved, U, assistant, stream, documentation, bool, gateUsage, gateClassifier, outage, JEVPASS, jsonFetch, captureFetch, typesafeGateway, stubClassifier, PRICING, costReceipt, choice, workflowClassifier, CONTINUATION_CAP, until, continuationFixture, firstAssistant, exhaustCap, completeSegment, driveToContinuation, lengthSegment, driveLengthToContinuation, SESSION_A, priorResult, okExec, setupDeps, writeAgent, withPiDir, modelGate, routingCwd, routeConfig, approvalCwd, pricedAgent, approvalFile, initRepo, exampleTaskFrom, skillSource, codexSkill, claudeSkill, gitRepo, commitFile, wtTask, okSpawn, okTask, priorNone, delay, artifactFor, readRuntime, makeFakeChild, waitForPid, aliveAfter, termIgnoringDescendant, handoffResult, addNestedPackage, cwdCheck, makeDirLink, markerCheck, symlinkEscape, tempGitRepo, localExclude, emptyQuestionHop, artifactTask, deliveryPath, onlineAgent, capturePreflight, contextdir, linkRepo, routingClassifier, routingSeam, routingPlan, stickyCwd, stickyFile, isolationCapabilities, bounded } from './worker-helpers.test.ts';

// --- D08 runtime handoff: streaming lifecycle, deadlines, repair lineage (offline; no paid calls) ---
test('Validated execution settings default and reject out-of-bound values',()=>{
 assert.deepEqual(resolveExecutionSettings({}),EXECUTION_DEFAULTS);
 assert.equal(resolveExecutionSettings({execution:{deadlineMs:123,quietMs:456,toolTimeoutMs:789,heartbeatMs:11,checkTimeoutMs:22}}).deadlineMs,123);
 assert.throws(()=>validate(task(0,{execution:{deadlineMs:0}})),/Invalid execution\.deadlineMs/);
 assert.throws(()=>validate(task(0,{execution:{quietMs:-1}})),/Invalid execution\.quietMs/);
 assert.throws(()=>validate(task(0,{execution:{toolTimeoutMs:Infinity}})),/Invalid execution\.toolTimeoutMs/);
 assert.throws(()=>validate(task(0,{heartbeatMs:'x'})),/Invalid execution\.heartbeatMs/);
 assert.doesNotThrow(()=>validateExecutionSettings({execution:{deadlineMs:1}}));
});

test('Tool watchdog does not reset duration on updates and clears on end',()=>{
 const w=new ToolWatchdog();
 w.onEvent({type:'tool_execution_start',toolCallId:'c1',toolName:'bash'},1000);
 w.onEvent({type:'tool_execution_update',toolCallId:'c1',toolName:'bash'},1500);
 assert.equal(w.longest(1600)!.elapsedMs,600);
 assert.equal(w.currentTool(),'bash');
 assert.ok(w.expired(2000,500));
 w.onEvent({type:'tool_execution_end',toolCallId:'c1',toolName:'bash'},1700);
 assert.equal(w.currentTool(),null);
 assert.equal(w.expired(3000,500),null);
});

test('Common prompt restricts searches to the checkout and forbids broad filesystem search',()=>{
 assert.match(COMMON_PROMPT_BLOCK,/execution checkout/);
 assert.match(COMMON_PROMPT_BLOCK,/broad filesystem search/);
 assert.match(COMMON_PROMPT_BLOCK,/not a sandbox guarantee/);
});

test('Streaming runtime reports running -> quiet -> running and quiet never kills',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fake=makeFakeChild();
 const t=okTask(repo,{id:'quiet',execution:{quietMs:80,heartbeatMs:15,toolTimeoutMs:5000,checkTimeoutMs:5000,deadlineMs:30000}});
 const p=run(t,false,{spawnChild:()=>fake.child});
 fake.emit({type:'agent_start'});
 await delay(220);
 const art=artifactFor(repo,'quiet');
 assert.equal(readRuntime(art).state,'quiet','idle past quietMs is reported quiet');
 assert.equal(fake.state.killed,false,'quiet must not kill the child');
 fake.emit({type:'tool_execution_start',toolCallId:'c1',toolName:'bash'});
 await delay(40);
 assert.equal(readRuntime(art).state,'running','activity returns state to running');
 assert.equal(readRuntime(art).currentTool,'bash');
 fake.emit({type:'tool_execution_end',toolCallId:'c1',toolName:'bash'});
 fake.emit({type:'message_end',message:{role:'assistant',provider:'openrouter',model:'m',usage:U(1,1,2),stopReason:'stop'}});
 fake.emit({type:'agent_settled'});
 fake.end(0);
 const r=await p;
 assert.equal(r.status,'ready_for_review');
 assert.equal(r.runtime.state,'ready_for_review');
 assert.equal(fake.state.killed,false);
});

test('Streaming runtime exposes live heartbeat and log visibility',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fake=makeFakeChild();
 const t=okTask(repo,{id:'live',execution:{quietMs:100000,heartbeatMs:20,toolTimeoutMs:5000,checkTimeoutMs:5000,deadlineMs:30000}});
 const p=run(t,false,{spawnChild:()=>fake.child});
 fake.emit({type:'tool_execution_start',toolCallId:'c1',toolName:'bash'});
 await delay(80);
 const art=artifactFor(repo,'live');
 assert.ok(existsSync(join(art,'runtime.json')),'runtime heartbeat exists while running');
 assert.equal(readRuntime(art).state,'running');
 assert.equal(readRuntime(art).currentTool,'bash');
 assert.match(readFileSync(join(art,'events.jsonl'),'utf8'),/tool_execution_start/);
 fake.emit({type:'tool_execution_end',toolCallId:'c1',toolName:'bash'});
 fake.emit({type:'message_end',message:{role:'assistant',provider:'openrouter',model:'m',usage:U(1,1,2),stopReason:'stop'}});
 fake.emit({type:'agent_settled'});
 fake.end(0);
 const r=await p;
 assert.equal(r.status,'ready_for_review');
});

test('Tool timeout stops the process group with TERM and produces a failed receipt',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fake=makeFakeChild();
 let spawns=0;
 const t=okTask(repo,{id:'tool-timeout',execution:{quietMs:100000,heartbeatMs:20,toolTimeoutMs:80,checkTimeoutMs:5000,deadlineMs:30000}});
 const p=run(t,false,{spawnChild:()=>{spawns++;return fake.child;}});
 fake.emit({type:'tool_execution_start',toolCallId:'c1',toolName:'bash'});
 const r=await p;
 assert.equal(spawns,1,'no automatic retry/restart');
 assert.equal(r.status,'worker_failed');
 assert.equal(r.runtime.state,'tool_timed_out');
 assert.equal(r.runtime.timedOut,true);
 assert.equal(r.runtime.stopReason,'tool_timed_out');
 assert.equal(fake.state.killed,true);
 assert.ok(fake.state.killSignals.includes('SIGTERM'));
 assert.ok(existsSync(join(r.artifactDir,'events.jsonl')));
 assert.ok(existsSync(join(r.artifactDir,'evidence.json')));
});

test('Total wall deadline covers checks and no success is reported after it',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const slowCheck={command:process.execPath,args:['-e','setTimeout(()=>{},1000)']};
 const t=okTask(repo,{id:'deadline',checks:[slowCheck],execution:{deadlineMs:300,quietMs:100000,heartbeatMs:20,toolTimeoutMs:10000,checkTimeoutMs:10000}});
 const r=await run(t,false,{spawnPi:okSpawn()});
 assert.equal(r.status,'deadline_exceeded');
 assert.equal(r.runtime.deadlineExceeded,true);
 assert.equal(r.runtime.state,'deadline_exceeded');
});

test('Descendant shell processes are cancelled with the process group',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const pidFile=join(repo.dir,'grandchild.pid');
 const script="const {spawn}=require('child_process');const fs=require('fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(c.pid));console.log(JSON.stringify({type:'tool_execution_start',toolCallId:'c1',toolName:'bash'}));setInterval(()=>{},1000);";
 const res=await executeWorkerStreaming({
  spawnChild:spawnChildDetached,command:process.execPath,args:['-e',script,pidFile],cwd:repo.dir,
  eventsPath:join(repo.dir,'events.jsonl'),logPath:join(repo.dir,'worker.log'),runtimePath:join(repo.dir,'runtime.json'),
  settings:{...EXECUTION_DEFAULTS,toolTimeoutMs:800,quietMs:100000,heartbeatMs:20},
  deadlineAt:Date.now()+10000,
 });
 assert.equal(res.timedOut,true);
 let gpid=0;
 for(let i=0;i<20 && !gpid;i++){try{gpid=Number(readFileSync(pidFile,'utf8'));}catch{await delay(25);}}
 assert.ok(gpid>0,'grandchild pid recorded');
 let alive=true;
 for(let i=0;i<30 && alive;i++){try{process.kill(gpid,0);await delay(50);}catch{alive=false;}}
 assert.equal(alive,false,'grandchild was killed with the process group');
});

test('SIGINT-style interruption yields an interrupted handback, preserves artifacts and releases locks',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fake=makeFakeChild();
 const controller=new AbortController();
 const t=okTask(repo,{id:'interrupt',execution:{quietMs:100000,heartbeatMs:20,toolTimeoutMs:5000,checkTimeoutMs:5000,deadlineMs:30000}});
 const p=run(t,false,{spawnChild:()=>fake.child,signal:controller.signal});
 fake.emit({type:'tool_execution_start',toolCallId:'c1',toolName:'bash'});
 await delay(60);
 controller.abort();
 const r=await p;
 assert.equal(r.status,'interrupted');
 assert.equal(r.runtime.interrupted,true);
 assert.equal(r.runtime.state,'interrupted');
 assert.equal(fake.state.killed,true);
 assert.ok(existsSync(join(r.artifactDir,'runtime.json')));
 assert.ok(existsSync(join(r.artifactDir,'events.jsonl')));
 assert.ok(existsSync(join(r.artifactDir,'evidence.json')));
 assert.ok(!existsSync(lockPathFor(join(repo.dir,'.delivery','locks'),`checkout:${repo.dir}`)),'checkout lock released on interruption');
});

test('Repair over budget is rejected before any paid call',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const priorDir=join(repo.dir,'.delivery','prior','budget');mkdirSync(priorDir,{recursive:true});
 const prior={id:'prior',status:'ready_for_review',artifactDir:priorDir,sourceCwd:repo.dir,executionCwd:repo.dir,isolation:{mode:'none'},lineage:{rootId:'prior',repairs:1,maxRepairs:1,deadlineAt:null},receipt:{source:'pi_message_end',requested:{provider:'openrouter',model:COMMODITY_MODEL},sessionId:SESSION_A}};
 writeFileSync(join(priorDir,'result.json'),JSON.stringify(prior));seedSession(priorDir);
 let spawned=false;
 const r=await run(okTask(repo,{id:'repair-rej',provider:'openrouter',model:COMMODITY_MODEL,repairFrom:join(priorDir,'result.json')}),false,{spawnPi:()=>{spawned=true;return {status:0,stdout:'',stderr:''};}});
 assert.equal(spawned,false,'rejected before the worker starts');
 assert.equal(r.status,'needs_review');
 assert.match(r.workerError,/repair rejected/);
 assert.equal(r.lineage.repairs,2);
 assert.equal(r.lineage.rejected,true);
});

test('Repair within budget reuses the session and persists the lineage counter',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const priorDir=join(repo.dir,'.delivery','prior','okrepair');mkdirSync(priorDir,{recursive:true});
 const prior={id:'prior',status:'ready_for_review',artifactDir:priorDir,sourceCwd:repo.dir,executionCwd:repo.dir,isolation:{mode:'none'},lineage:{rootId:'prior',repairs:0,maxRepairs:1,deadlineAt:null},receipt:{source:'pi_message_end',requested:{provider:'openrouter',model:COMMODITY_MODEL},sessionId:SESSION_A}};
 writeFileSync(join(priorDir,'result.json'),JSON.stringify(prior));seedSession(priorDir);
 const from=join(priorDir,'result.json');
 const r=await run(okTask(repo,{id:'repair-ok',provider:'openrouter',model:COMMODITY_MODEL,repairFrom:from}),false,{spawnPi:okSpawn()});
 assert.equal(r.status,'ready_for_review');
 assert.equal(r.lineage.repairs,1);
 assert.equal(r.lineage.maxRepairs,1);
 assert.equal(r.repair.repairs,1);
 assert.equal(r.repair.parentSessionId,SESSION_A);
 assert.ok(!existsSync(lockPathFor(join(repo.dir,'.delivery','locks'),`session:${SESSION_A}`)),'session lock released');
});

test('An openrouter run passes an affinity key derived from the lineage root to the worker env',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 let seen:any;
 await run(okTask(repo,{id:'affinity-root',provider:'openrouter',model:COMMODITY_MODEL}),false,{spawnPi:(_c,_a,opts)=>{seen=opts;return {status:0,stdout:stream({type:'session',id:'s'},assistant(),{type:'agent_settled'}),stderr:''};}});
 assert.equal(seen.env.JUNIOR_PI_AFFINITY_KEY,affinityKeyFor(resolve(repo.dir),'affinity-root'));
});

test('A repair run shares the affinity key of its root run',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const priorDir=join(repo.dir,'.delivery','prior','affinity');mkdirSync(priorDir,{recursive:true});
 const prior={id:'prior',status:'ready_for_review',artifactDir:priorDir,sourceCwd:repo.dir,executionCwd:repo.dir,isolation:{mode:'none'},lineage:{rootId:'root-affinity',repairs:0,maxRepairs:1,deadlineAt:null},receipt:{source:'pi_message_end',requested:{provider:'openrouter',model:COMMODITY_MODEL},sessionId:SESSION_A}};
 writeFileSync(join(priorDir,'result.json'),JSON.stringify(prior));seedSession(priorDir);
 let seen:any;
 await run(okTask(repo,{id:'repair-affinity',provider:'openrouter',model:COMMODITY_MODEL,repairFrom:join(priorDir,'result.json')}),false,{spawnPi:(_c,_a,opts)=>{seen=opts;return {status:0,stdout:stream({type:'session',id:SESSION_A},assistant(),{type:'agent_settled'}),stderr:''};}});
 assert.equal(seen.env.JUNIOR_PI_AFFINITY_KEY,affinityKeyFor(resolve(repo.dir),'root-affinity'));
});

test('An openrouter run passes the selected profile routing to the worker env',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 writeFileSync(join(repo.dir,'delivery.config.json'),JSON.stringify({provider:'openrouter',model:COMMODITY_MODEL,models:{roster:[{id:'general',openrouter:{order:['deepinfra']}}]}}));
 let seen:any;
 await run(okTask(repo,{id:'routing-env',provider:'openrouter',model:COMMODITY_MODEL}),false,{spawnPi:(_c,_a,opts)=>{seen=opts;return {status:0,stdout:stream({type:'session',id:'s'},assistant(),{type:'agent_settled'}),stderr:''};}});
 assert.equal(seen.env.JUNIOR_PI_OPENROUTER_ROUTING,JSON.stringify({order:['deepinfra']}));
});

test('An openrouter run records the selected profile provider routing on the result',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 writeFileSync(join(repo.dir,'delivery.config.json'),JSON.stringify({provider:'openrouter',model:COMMODITY_MODEL,models:{roster:[{id:'general',openrouter:{order:['deepinfra']}}]}}));
 const r=await run(okTask(repo,{id:'routing-result',provider:'openrouter',model:COMMODITY_MODEL}),false,{spawnPi:okSpawn()});
 assert.deepEqual(r.providerRouting,{affinityKey:affinityKeyFor(resolve(repo.dir),'routing-result'),openrouter:{order:['deepinfra']}});
});

test('Child startup error and malformed events both produce inspectable failed receipts',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const errFake=makeFakeChild();
 const errP=run(okTask(repo,{id:'startup-error',execution:{quietMs:100000,heartbeatMs:20,toolTimeoutMs:5000,checkTimeoutMs:5000,deadlineMs:30000}}),false,{spawnChild:()=>errFake.child});
 setImmediate(()=>errFake.ee.emit('error',new Error('spawn pi ENOENT')));
 const err=await errP;
 assert.equal(err.status,'worker_failed');
 assert.equal(err.runtime.state,'failed');
 assert.match(err.workerError,/ENOENT/);
 assert.ok(existsSync(join(err.artifactDir,'events.jsonl')));

 const badFake=makeFakeChild();
 const badP=run(okTask(repo,{id:'malformed',execution:{quietMs:100000,heartbeatMs:20,toolTimeoutMs:5000,checkTimeoutMs:5000,deadlineMs:30000}}),false,{spawnChild:()=>badFake.child});
 badFake.emitRaw('{not json}\n');
 badFake.emit({type:'message_end',message:{role:'assistant',provider:'openrouter',model:'m',usage:U(1,1,2),stopReason:'stop'}});
 badFake.emit({type:'agent_settled'});
 badFake.end(0);
 const bad=await badP;
 assert.equal(bad.status,'receipt_failed');
 assert.equal(bad.receipt.malformed,true);
 assert.ok(existsSync(join(bad.artifactDir,'events.jsonl')));
});

test('Compact handoff is small, dedupes stop reasons and exposes artifact paths',()=>{
 const result:any={id:'h',status:'ready_for_review',artifactDir:'/tmp/art',executionCwd:'/cwd',isolation:{mode:'worktree'},
  checks:[{command:'node',args:['x'],exitCode:0}],
  receipt:{requested:{provider:'openrouter',model:'m'},observed:[{provider:'openrouter',model:'m'}],observedUnknown:false,
   usage:{totalTokens:7,available:true},stopReasons:['stop','stop','tool_use']},
  cost:{estimatedUsd:0.001,piReported:{total:0.002,available:true}},
  runtime:{state:'ready_for_review',stopReason:'ready_for_review',elapsedMs:5,deadlineMs:600000,quietMs:1000,toolTimeoutMs:2000,heartbeatMs:100,
   interrupted:false,timedOut:false,deadlineExceeded:false},
  evidence:{artifact:'/tmp/art/evidence.json',runChangedFiles:[{path:'a.txt'}]}};
 const h=compactHandoff(result);
 assert.equal(h.id,'h');
 assert.equal(h.outcome,'ready_for_review');
 assert.equal(h.execution.cwd,'/cwd');
 assert.equal(h.execution.isolation,'worktree');
 assert.deepEqual(h.changedFiles,['a.txt']);
 assert.equal(h.checks[0].passed,true);
 assert.equal(h.model.tokens,7);
 assert.equal(h.model.cost.estimatedUsd,0.001);
 assert.equal(h.model.cost.billedUsd,null);
 assert.deepEqual(h.runtime.stopReasonSummary,['stop','tool_use']);
 assert.equal(h.artifacts.events,'/tmp/art/events.jsonl');
 assert.deepEqual(h.unresolved,[]);
});

test('junior.ts handoff defaults to worktree isolation and prints compact JSON',()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const cfg=mkdtempSync(join(tmpdir(),'junior-cfg-'));
 const taskPath=join(cfg,'task.json');
 writeFileSync(taskPath,JSON.stringify({id:'junior-h',deliverable:'x',cwd:repo.dir,acceptance:['ok'],checks:[{command:process.execPath,args:['-e','process.exit(0)']}],externalContextConsent:true}));
 const r=spawnSync(process.execPath,['junior.ts','handoff',taskPath,'--mock'],{encoding:'utf8',env:{...process.env,JUNIOR_NO_INSTALL:'1'}});
 assert.equal(r.status,0,r.stderr);
 const o=JSON.parse(r.stdout);
 assert.equal(o.id,'junior-h');
 assert.equal(o.outcome,'simulation_passed');
 assert.equal(o.execution.isolation,'worktree');
 assert.ok(o.artifacts.result && existsSync(o.artifacts.result));

 writeFileSync(taskPath,JSON.stringify({id:'junior-none',deliverable:'x',cwd:repo.dir,acceptance:['ok'],isolation:'none',checks:[{command:process.execPath,args:['-e','process.exit(0)']}],externalContextConsent:true}));
 const r2=spawnSync(process.execPath,['junior.ts','handoff',taskPath,'--mock'],{encoding:'utf8',env:{...process.env,JUNIOR_NO_INSTALL:'1'}});
 assert.equal(r2.status,0,r2.stderr);
 assert.equal(JSON.parse(r2.stdout).execution.isolation,'none');
});

test('junior.ts validate and status --full use the existing worker structures',()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const cfg=mkdtempSync(join(tmpdir(),'junior-cfg-'));
 const taskPath=join(cfg,'t.json');
 writeFileSync(taskPath,JSON.stringify({id:'su',deliverable:'x',cwd:repo.dir,acceptance:['ok'],checks:[{command:process.execPath,args:['-e','process.exit(0)']}],externalContextConsent:true}));
 const v=spawnSync(process.execPath,['junior.ts','validate',taskPath],{encoding:'utf8',env:{...process.env,JUNIOR_NO_INSTALL:'1'}});
 assert.equal(v.status,0,v.stderr);
 assert.equal(JSON.parse(v.stdout).valid,true);
 const rr=spawnSync(process.execPath,['junior.ts','handoff',taskPath,'--mock','--full'],{encoding:'utf8',env:{...process.env,JUNIOR_NO_INSTALL:'1'}});
 assert.equal(rr.status,0,rr.stderr);
 const full=JSON.parse(rr.stdout);
 assert.equal(full.status,'simulation_passed');
 assert.ok(full.receipt && full.runtime && full.lineage);
 const resultFile=join(full.artifactDir,'result.json');
 const statusOut=spawnSync(process.execPath,['junior.ts','status',resultFile,'--full'],{encoding:'utf8',env:{...process.env,JUNIOR_NO_INSTALL:'1'}});
 assert.equal(statusOut.status,0,statusOut.stderr);
 assert.equal(JSON.parse(statusOut.stdout).outcome,'simulation_passed');
});

// --- D08 review fixes: lifecycle correctness, bounded checks/output, honest compact cost ---
test('Streaming completion consumes trailing receipt bytes delivered after exit via close',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const ee=new EventEmitter(); const stdout=new PassThrough(); const stderr=new PassThrough();
 const child:any={pid:0,stdout,stderr,on:(e:string,cb:any)=>{ee.on(e,cb);return child;},kill:()=>true};
 const t=okTask(repo,{id:'trailing',execution:{quietMs:100000,heartbeatMs:20,toolTimeoutMs:5000,checkTimeoutMs:5000,deadlineMs:30000}});
 const p=run(t,false,{spawnChild:()=>child});
 stdout.write(JSON.stringify({type:'session',id:'s'})+'\n');
 ee.emit('exit',0,null); // exit before the final receipt bytes arrive
 stdout.write(assistant({stopReason:'stop'})+'\n');
 stdout.write(JSON.stringify({type:'agent_settled'})+'\n');
 stdout.end();
 ee.emit('close',0,null);
 const r=await p;
 assert.equal(r.status,'ready_for_review','trailing receipt bytes delivered after exit must not be lost');
 assert.equal(r.receipt.settled,true);
 assert.equal(r.receipt.assistantMessages,1);
});

test('Process-group cancellation SIGKILLs a TERM-ignoring descendant after the parent exits',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const pidFile=join(repo.dir,'parent-term-descendant.pid');
 const parentScript=[
  "const {spawn}=require('child_process');const fs=require('fs');",
  `const d=spawn(process.execPath,['-e',${JSON.stringify(termIgnoringDescendant())}],{stdio:'ignore'});`,
  "fs.writeFileSync(process.argv[1],String(d.pid));",
  "process.on('SIGTERM',()=>process.exit(0));",
  "console.log(JSON.stringify({type:'tool_execution_start',toolCallId:'c1',toolName:'bash'}));",
  "setInterval(()=>{},1000);",
 ].join('');
 const res=await executeWorkerStreaming({
  spawnChild:spawnChildDetached,command:process.execPath,args:['-e',parentScript,pidFile],cwd:repo.dir,
  eventsPath:join(repo.dir,'events.jsonl'),logPath:join(repo.dir,'worker.log'),runtimePath:join(repo.dir,'runtime.json'),
  settings:{...EXECUTION_DEFAULTS,toolTimeoutMs:600,quietMs:100000,heartbeatMs:20},
  deadlineAt:Date.now()+10000,
 });
 assert.equal(res.timedOut,true);
 const gpid=await waitForPid(pidFile);
 assert.ok(gpid>0,'TERM-ignoring descendant pid recorded');
 assert.equal(await aliveAfter(gpid),false,'descendant that ignores TERM must still be SIGKILLed after the parent exits');
});

test('An interrupted run cancels a hung check process tree and keeps the heartbeat live',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const pidFile=join(repo.dir,'hung-check.pid');
 const checkScript=[
  "const {spawn}=require('child_process');const fs=require('fs');",
  `const d=spawn(process.execPath,['-e',${JSON.stringify(termIgnoringDescendant())}],{stdio:'ignore'});`,
  "fs.writeFileSync(process.argv[1],String(d.pid));",
  "setInterval(()=>{},1000);",
 ].join('');
 const controller=new AbortController();
 const t=okTask(repo,{id:'check-interrupt',checks:[{command:process.execPath,args:['-e',checkScript,pidFile]}],
  execution:{deadlineMs:30000,quietMs:100000,heartbeatMs:20,toolTimeoutMs:3000,checkTimeoutMs:3000}});
 const p=run(t,false,{spawnPi:okSpawn(),signal:controller.signal});
 const cpid=await waitForPid(pidFile);
 assert.ok(cpid>0,'hung check started');
 // Heartbeat must advance to the checks phase while the check is running.
 const art=artifactFor(repo,'check-interrupt');
 assert.equal(readRuntime(art).phase,'checks','heartbeat stays live during checks');
 controller.abort();
 const r=await p;
 assert.equal(r.status,'interrupted');
 assert.equal(r.runtime.interrupted,true);
 assert.equal(await aliveAfter(cpid),false,'the hung check process tree must be cancelled on interruption');
});

test('A synchronous spawn throw yields a recoverable failure result with evidence',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const t=okTask(repo,{id:'spawn-throw',execution:{deadlineMs:30000,quietMs:100000,heartbeatMs:20,toolTimeoutMs:5000,checkTimeoutMs:5000}});
 const r=await run(t,false,{spawnChild:()=>{throw new Error('spawn pi EACCES');}});
 assert.equal(r.status,'worker_failed');
 assert.match(String(r.workerError),/EACCES/);
 assert.ok(existsSync(join(r.artifactDir,'evidence.json')),'evidence preserved on startup throw');
 assert.ok(existsSync(join(r.artifactDir,'runtime.json')));
});

test('Unbounded worker output is capped and classified as truncated, not a valid receipt',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fake=makeFakeChild();
 const t=okTask(repo,{id:'output-cap',execution:{deadlineMs:30000,quietMs:100000,heartbeatMs:20,toolTimeoutMs:5000,checkTimeoutMs:5000}});
 const p=run(t,false,{spawnChild:()=>fake.child,maxOutputBytes:4096} as any);
 fake.emitRaw('x'.repeat(200000));
 fake.emit({type:'message_end',message:{role:'assistant',provider:'openrouter',model:'m',usage:U(1,1,2),stopReason:'stop'}});
 fake.emit({type:'agent_settled'});
 fake.end(0);
 const r=await p;
 assert.equal(r.outputTruncated,true,'truncation must be surfaced explicitly');
 assert.notEqual(r.status,'ready_for_review');
 assert.match(String(r.workerError),/accumulation cap; the worker was stopped/i);
 assert.ok(existsSync(join(r.artifactDir,'evidence.json')));
});

test('An expired wall deadline skips worker startup',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 let workerStarted=false;
 const t=okTask(repo,{id:'expired',execution:{deadlineMs:10,quietMs:100000,heartbeatMs:20,toolTimeoutMs:5000,checkTimeoutMs:5000}});
 const r=await run(t,false,{spawnChild:()=>{workerStarted=true;return makeFakeChild().child;}});
 assert.equal(workerStarted,false,'worker must not start after the wall deadline');
 assert.equal(r.status,'deadline_exceeded');
 assert.ok(existsSync(join(r.artifactDir,'evidence.json')),'evidence still captured without a worker');
});

test('Disk persistence failure is surfaced without aborting the run',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fake=makeFakeChild();
 const eventsDir=join(repo.dir,'events-as-dir'); mkdirSync(eventsDir);
 const p=executeWorkerStreaming({
  spawnChild:()=>fake.child,command:'pi',args:[],cwd:repo.dir,
  eventsPath:eventsDir,logPath:join(repo.dir,'worker.log'),runtimePath:join(repo.dir,'runtime.json'),
  settings:{...EXECUTION_DEFAULTS,quietMs:100000,heartbeatMs:20},deadlineAt:Date.now()+10000,
 });
 fake.emit({type:'agent_settled'});
 fake.end(0);
 const res=await p;
 assert.ok(res.persistError,'disk persistence failure is surfaced');
 assert.equal(res.exitCode,0);
});

test('Output stream errors are surfaced as a recoverable failure',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fake=makeFakeChild();
 const p=executeWorkerStreaming({
  spawnChild:()=>fake.child,command:'pi',args:[],cwd:repo.dir,
  eventsPath:join(repo.dir,'events.jsonl'),logPath:join(repo.dir,'worker.log'),runtimePath:join(repo.dir,'runtime.json'),
  settings:{...EXECUTION_DEFAULTS,quietMs:100000,heartbeatMs:20},deadlineAt:Date.now()+10000,
 });
 await delay(10);
 try { fake.stdout.emit('error',new Error('stream boom')); } catch { /* baseline has no handler; the fix must consume it */ }
 const res=await p;
 assert.match(String(res.streamError),/boom/);
 assert.notEqual(res.stopReason,'completed');
});

test('Async check executor enforces its deadline and kills a TERM-ignoring descendant',async()=>{
 const { executeCheck } = await import('./worker.ts') as any;
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const pidFile=join(repo.dir,'hung-check-exec.pid');
 const checkScript=[
  "const {spawn}=require('child_process');const fs=require('fs');",
  `const d=spawn(process.execPath,['-e',${JSON.stringify(termIgnoringDescendant())}],{stdio:'ignore'});`,
  "fs.writeFileSync(process.argv[1],String(d.pid));",
  "setInterval(()=>{},1000);",
 ].join('');
 const res=await executeCheck({
  spawnChild:spawnChildDetached,command:process.execPath,args:['-e',checkScript,pidFile],cwd:repo.dir,
  timeoutMs:600,deadlineAt:Date.now()+10000,
 });
 assert.equal(res.timedOut,true);
 assert.equal(res.exitCode,null);
 const cpid=await waitForPid(pidFile);
 assert.ok(cpid>0,'hung check descendant pid recorded');
 assert.equal(await aliveAfter(cpid),false,'check executor must kill the whole process tree');
});

test('Compact handoff preserves source cwd and token/cache totals',()=>{
 const base:any={id:'c',status:'ready_for_review',artifactDir:'/a',sourceCwd:'/src',executionCwd:'/exec',
  isolation:{mode:'worktree'},checks:[],receipt:{requested:{provider:'openrouter',model:'m'},observed:[],observedUnknown:true,
   usage:{input:10,output:20,cacheRead:5,cacheWrite:2,totalTokens:37,available:true}},
  cost:{estimatedUsd:null,piReported:{total:0,available:true},unknownReason:'no verified task pricing supplied'}};
 const h=compactHandoff(base);
 assert.equal(h.sourceCwd,'/src');
 assert.equal(h.execution.cwd,'/exec');
 assert.equal(h.model.cacheRead,5);
 assert.equal(h.model.cacheWrite,2);
 assert.equal(h.model.tokens,37);
 assert.equal(h.model.cost.available,true,'a reported numeric zero is a known (free) charge');
 assert.equal(h.model.cost.billedUsd,null);
 assert.equal(compactHandoff({...base,cost:{estimatedUsd:0.5,piReported:{total:0,available:true}}}).model.cost.available,true);
 assert.equal(compactHandoff({...base,cost:{estimatedUsd:null,piReported:{total:0.25,available:true}}}).model.cost.available,true);
});

// --- Issue #22: reserved check budget after the worker deadline (offline) ---
test('Check reserve defaults to the smaller of 120s and 20% of the deadline',()=>{
 assert.equal(resolveExecutionSettings({execution:{deadlineMs:1000}}).checkReserveMs,200);
});
test('Check reserve is capped at 120s for long deadlines',()=>{
 assert.equal(resolveExecutionSettings({execution:{deadlineMs:600000}}).checkReserveMs,120000);
});
test('A check reserve at least the deadline is rejected',()=>{
 assert.throws(()=>validate(task(0,{execution:{deadlineMs:1000,checkReserveMs:1000}})),/checkReserveMs/);
});
test('A worker stopped by its reserved deadline still records check results',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fake=makeFakeChild();
 const t=okTask(repo,{id:'reserve-checks',execution:{deadlineMs:1500,checkReserveMs:1000,quietMs:100000,heartbeatMs:20,toolTimeoutMs:10000,checkTimeoutMs:1000}});
 const r=await run(t,false,{spawnChild:()=>fake.child});
 assert.equal(r.checks.length,1);
});
test('A worker stopped by its reserved deadline keeps the run deadline_exceeded',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fake=makeFakeChild();
 const t=okTask(repo,{id:'reserve-status',execution:{deadlineMs:1500,checkReserveMs:1000,quietMs:100000,heartbeatMs:20,toolTimeoutMs:10000,checkTimeoutMs:1000}});
 const r=await run(t,false,{spawnChild:()=>fake.child});
 assert.equal(r.status,'deadline_exceeded');
});
test('An interrupted run still records no checks',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fake=makeFakeChild();
 const controller=new AbortController();
 const t=okTask(repo,{id:'reserve-interrupt',execution:{deadlineMs:1500,checkReserveMs:1000,quietMs:100000,heartbeatMs:20,toolTimeoutMs:10000,checkTimeoutMs:1000}});
 const p=run(t,false,{spawnChild:()=>fake.child,signal:controller.signal});
 await delay(60);
 controller.abort();
 const r=await p;
 assert.equal(r.checks.length,0);
});
test('The compact handoff reports the total wall deadline',()=>{
 const h=compactHandoff({runtime:{deadlineMs:600000}});
 assert.equal(h.runtime.deadlineMs,600000);
});
test('The compact handoff reports the reserved check budget',()=>{
 const h=compactHandoff({runtime:{checkReserveMs:120000}});
 assert.equal(h.runtime.checkReserveMs,120000);
});

// --- P03: worker output accumulation cap stops the worker and is reported once ---
test('Streaming worker past the output cap reports an output_truncated stop reason',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'delivery-cap-'));
 const fake=makeFakeChild();
 const p=executeWorkerStreaming({
  spawnChild:()=>fake.child,command:'pi',args:[],cwd:dir,
  eventsPath:join(dir,'events.jsonl'),logPath:join(dir,'worker.log'),runtimePath:join(dir,'runtime.json'),
  settings:{...EXECUTION_DEFAULTS,quietMs:100000,heartbeatMs:20},deadlineAt:Date.now()+10000,maxOutputBytes:128,
 });
 fake.emitRaw('x'.repeat(200000));
 fake.end(0);
 const res=await p;
 assert.equal(res.stopReason,'output_truncated');
});
test('Streaming worker past the output cap stops the child',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'delivery-cap-'));
 const fake=makeFakeChild();
 const p=executeWorkerStreaming({
  spawnChild:()=>fake.child,command:'pi',args:[],cwd:dir,
  eventsPath:join(dir,'events.jsonl'),logPath:join(dir,'worker.log'),runtimePath:join(dir,'runtime.json'),
  settings:{...EXECUTION_DEFAULTS,quietMs:100000,heartbeatMs:20},deadlineAt:Date.now()+10000,maxOutputBytes:128,
 });
 fake.emitRaw('x'.repeat(200000));
 fake.end(0);
 await p;
 assert.equal(fake.state.killed,true);
});
test('A worker run past the output cap reports status output_truncated',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fake=makeFakeChild();
 const t=okTask(repo,{id:'cap-status',execution:{deadlineMs:30000,quietMs:100000,heartbeatMs:20,toolTimeoutMs:5000,checkTimeoutMs:5000}});
 const p=run(t,false,{spawnChild:()=>fake.child,maxOutputBytes:128});
 fake.emitRaw('x'.repeat(200000));
 fake.end(0);
 const r=await p;
 assert.equal(r.status,'output_truncated');
});
test('A worker run past the output cap reports the output cap error message',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fake=makeFakeChild();
 const t=okTask(repo,{id:'cap-error',execution:{deadlineMs:30000,quietMs:100000,heartbeatMs:20,toolTimeoutMs:5000,checkTimeoutMs:5000}});
 const p=run(t,false,{spawnChild:()=>fake.child,maxOutputBytes:128});
 fake.emitRaw('x'.repeat(200000));
 fake.end(0);
 const r=await p;
 assert.equal(r.workerError,'Worker output exceeded the accumulation cap; the worker was stopped.');
});
test('A worker run past the output cap does not run contract checks',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fake=makeFakeChild();
 const t=okTask(repo,{id:'cap-checks',execution:{deadlineMs:30000,quietMs:100000,heartbeatMs:20,toolTimeoutMs:5000,checkTimeoutMs:5000}});
 const p=run(t,false,{spawnChild:()=>fake.child,maxOutputBytes:128});
 fake.emitRaw('x'.repeat(200000));
 fake.end(0);
 const r=await p;
 assert.equal(r.checks.length,0);
});
test('A cut final event line under truncation is not counted as malformed',()=>{
 const r=parseReceipt('{"type":"session","id":"s"}\n{"type":"message_end"',{},{outputTruncated:true});
 assert.deepEqual(r.malformedLines,[]);
});
test('A cut final event line under truncation is reported as a truncated tail',()=>{
 const r=parseReceipt('{"type":"session","id":"s"}\n{"type":"message_end"',{},{outputTruncated:true});
 assert.equal(r.truncatedTail,true);
});
test('Malformed line numbers are capped at twenty entries',()=>{
 const bad=Array.from({length:30},(_,i)=>`{bad${i}`).join('\n')+'\n';
 const r=parseReceipt(bad);
 assert.equal(r.malformedLines.length,20);
});
test('Malformed count still totals every malformed line',()=>{
 const bad=Array.from({length:30},(_,i)=>`{bad${i}`).join('\n')+'\n';
 const r=parseReceipt(bad);
 assert.equal(r.malformedCount,30);
});
test('A compact handoff of a truncated worker lists one output truncation entry',()=>{
 const malformedLines=Array.from({length:2000},(_,i)=>i+1);
 const receipt:any={source:'pi_message_end',outputTruncated:true,malformed:true,malformedLines,malformedCount:2000,truncatedTail:true};
 const h=compactHandoff({id:'cap',status:'output_truncated',receipt,checks:[]});
 assert.ok(h.unresolved.includes('worker output truncated at the cap'));
});
test('A compact handoff of a truncated worker omits the malformed line list',()=>{
 const malformedLines=Array.from({length:2000},(_,i)=>i+1);
 const receipt:any={source:'pi_message_end',outputTruncated:true,malformed:true,malformedLines,malformedCount:2000,truncatedTail:true};
 const h=compactHandoff({id:'cap',status:'output_truncated',receipt,checks:[]});
 assert.equal(h.unresolved.filter((u:string)=>/malformed event lines/.test(u)).length,0);
});
test('A worker run past the output cap reports runtime stop reason output_truncated',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fake=makeFakeChild();
 const t=okTask(repo,{id:'cap-stop-reason',execution:{deadlineMs:30000,quietMs:100000,heartbeatMs:20,toolTimeoutMs:5000,checkTimeoutMs:5000}});
 const p=run(t,false,{spawnChild:()=>fake.child,maxOutputBytes:128});
 fake.emitRaw('x'.repeat(200000));
 fake.end(0);
 const r=await p;
 assert.equal(r.runtime.stopReason,'output_truncated');
});
test('A worker run past the output cap is reported as output truncated',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fake=makeFakeChild();
 const t=okTask(repo,{id:'cap-tail',execution:{deadlineMs:30000,quietMs:100000,heartbeatMs:20,toolTimeoutMs:5000,checkTimeoutMs:5000}});
 const p=run(t,false,{spawnChild:()=>fake.child,maxOutputBytes:128});
 fake.emitRaw('x'.repeat(200000));
 fake.end(0);
 const r=await p;
 assert.equal(r.outputTruncated,true);
});

// --- J41a stream compaction: maxOutputBytes bound and split warnings ---
test('validate rejects execution.maxOutputBytes above 32 MiB',()=>{
 assert.throws(()=>validate(task(0,{execution:{maxOutputBytes:32*1024*1024+1}})),/Invalid execution\.maxOutputBytes/);
});
test('validate accepts execution.maxOutputBytes at 32 MiB',()=>{
 assert.doesNotThrow(()=>validate(task(0,{execution:{maxOutputBytes:32*1024*1024}})));
});
test('junior validate warns to split a contract naming seven distinct context paths',()=>{
 const repo=gitRepo();
 const context=[];
 for(let i=0;i<7;i++){const p=`ctx-${i}.txt`;writeFileSync(join(repo.dir,p),'x\n');context.push({path:p});}
 const cfg=mkdtempSync(join(tmpdir(),'junior-warn-'));
 const taskPath=join(cfg,'t.json');
 writeFileSync(taskPath,JSON.stringify({id:'warn-paths',deliverable:'x',cwd:repo.dir,acceptance:['ok'],context,checks:[{command:process.execPath,args:['-e','process.exit(0)']}]}));
 const v=spawnSync(process.execPath,['junior.ts','validate',taskPath],{encoding:'utf8',env:{...process.env,JUNIOR_NO_INSTALL:'1'}});
 assert.match(JSON.parse(v.stdout).warnings[0],/chained contracts/);
});
test('junior validate warns to split a contract with eleven acceptance criteria',()=>{
 const repo=gitRepo();
 const acceptance=Array.from({length:11},(_,i)=>`criterion ${i}`);
 const cfg=mkdtempSync(join(tmpdir(),'junior-warn-'));
 const taskPath=join(cfg,'t.json');
 writeFileSync(taskPath,JSON.stringify({id:'warn-acc',deliverable:'x',cwd:repo.dir,acceptance,checks:[{command:process.execPath,args:['-e','process.exit(0)']}]}));
 const v=spawnSync(process.execPath,['junior.ts','validate',taskPath],{encoding:'utf8',env:{...process.env,JUNIOR_NO_INSTALL:'1'}});
 assert.match(JSON.parse(v.stdout).warnings[0],/chained contracts/);
});


