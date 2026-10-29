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

// --- Step 3 automatic continuation (offline; fake segments that hit the cap) ---
test('Execution settings default continuations to one',()=>{
 assert.equal(resolveExecutionSettings({}).continuations,1);
});
test('A capped segment with a continuation completes ready_for_review',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const {p,fakes,argvs}=continuationFixture(repo);
 await driveToContinuation(fakes,argvs);
 completeSegment(fakes[1]);
 const r=await p;
 assert.equal(r.status,'ready_for_review');
});
test('A continued run records two segments',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const {p,fakes,argvs}=continuationFixture(repo);
 await driveToContinuation(fakes,argvs);
 completeSegment(fakes[1]);
 const r=await p;
 assert.equal(r.segments.length,2);
});
test('A continuation segment starts with no --session',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const {p,fakes,argvs}=continuationFixture(repo);
 await driveToContinuation(fakes,argvs);
 completeSegment(fakes[1]);
 await p;
 assert.ok(!argvs[1].includes('--session'));
});
test('A continuation prompt carries the checkpoint text',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const {p,fakes,argvs}=continuationFixture(repo);
 await driveToContinuation(fakes,argvs);
 completeSegment(fakes[1]);
 await p;
 assert.ok(argvs[1][argvs[1].length-1].includes('distinctive acceptance phrase'));
});
test('A continuation checkpoint records the git status',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const {p,fakes,argvs}=continuationFixture(repo);
 writeFileSync(join(repo.dir,'a.txt'),'modified\n');
 await driveToContinuation(fakes,argvs);
 completeSegment(fakes[1]);
 const r=await p;
 assert.match(readFileSync(join(r.artifactDir,'checkpoint-1.md'),'utf8'),/a\.txt/);
});
test('A continuation checkpoint records the acceptance list',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const {p,fakes,argvs}=continuationFixture(repo);
 await driveToContinuation(fakes,argvs);
 completeSegment(fakes[1]);
 const r=await p;
 assert.match(readFileSync(join(r.artifactDir,'checkpoint-1.md'),'utf8'),/distinctive acceptance phrase/);
});
test('Result usage sums tokens across continuation segments',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const {p,fakes,argvs}=continuationFixture(repo);
 await driveToContinuation(fakes,argvs,U(1,2,3));
 completeSegment(fakes[1],U(10,20,30));
 const r=await p;
 assert.equal(r.receipt.usage.totalTokens,33);
});
test('A length-limited first segment starts a continuation segment',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const {p,fakes}=continuationFixture(repo);
 await driveLengthToContinuation(fakes);
 completeSegment(fakes[1]);
 const r=await p;
 assert.equal(r.segments.length,2);
});
test('A length-limited first segment continues to a valid receipt',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const {p,fakes}=continuationFixture(repo);
 await driveLengthToContinuation(fakes);
 completeSegment(fakes[1]);
 const r=await p;
 assert.equal(receiptValid(r.receipt),true);
});
test('A length-limited continuation prompt names the per-message output limit',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const {p,fakes,argvs}=continuationFixture(repo);
 await driveLengthToContinuation(fakes);
 completeSegment(fakes[1]);
 await p;
 assert.ok(argvs[1][argvs[1].length-1].includes('per-message output limit'));
});
test('An exhausted length-limited run reports the per-message output limit error',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const {p,fakes}=continuationFixture(repo,1);
 await until(()=>fakes.length>=1);
 lengthSegment(fakes[0]);
 await until(()=>fakes.length>=2);
 lengthSegment(fakes[1]);
 const r=await p;
 assert.match(r.workerError,/per-message output limit/);
});
test('An exhausted length-limited run names the output limit in unresolved',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const {p,fakes}=continuationFixture(repo,1);
 await until(()=>fakes.length>=1);
 lengthSegment(fakes[0]);
 await until(()=>fakes.length>=2);
 lengthSegment(fakes[1]);
 const r=await p;
 assert.ok((r.unresolved as string[]).some((u)=>u.includes('per-message output limit')));
});
test('A capped run with continuations 0 ends output_truncated',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const {p,fakes}=continuationFixture(repo,0);
 await until(()=>fakes.length>=1);
 fakes[0].emit({type:'session',id:'seg-only'});
 firstAssistant(fakes[0],'capped work');
 exhaustCap(fakes[0]);
 const r=await p;
 assert.equal(r.status,'output_truncated');
});
test('A capped run with continuations 0 records exactly one segment',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const {p,fakes}=continuationFixture(repo,0);
 await until(()=>fakes.length>=1);
 fakes[0].emit({type:'session',id:'seg-only'});
 firstAssistant(fakes[0],'capped work');
 exhaustCap(fakes[0]);
 const r=await p;
 assert.equal(r.segments.length,1);
});
test('Compact handoff reports the segment count',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const r=await run(okTask(repo,{id:'seg-count'}),false,{spawnPi:okSpawn()});
 assert.equal(compactHandoff(r).segments,1);
});
test('Continuations above three are rejected by validate',()=>{
 assert.throws(()=>validate(task(0,{execution:{continuations:4}})),/Invalid execution\.continuations/);
});
test('A fractional continuations value is rejected by validate',()=>{
 assert.throws(()=>validate(task(0,{execution:{continuations:1.5}})),/Invalid execution\.continuations/);
});
test('A top-level continuations setting enables a continuation segment',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fakes:any[]=[];const argvs:string[][]=[];
 const spawnChild=(_c:string,args:string[])=>{argvs.push(args);const f=makeFakeChild();fakes.push(f);return f.child;};
 const t=okTask(repo,{id:'cont-top',acceptance:['distinctive acceptance phrase'],continuations:1});
 const p=run(t,false,{spawnChild,maxOutputBytes:CONTINUATION_CAP});
 await driveToContinuation(fakes,argvs);
 completeSegment(fakes[1]);
 const r=await p;
 assert.equal(r.segments.length,2);
});
test('Resume validation rejects cwd, provider/model and invalid session',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-'));
 const prior=priorResult(cwd);
 assert.ok(resolveResume(prior,{provider:'openrouter',model:COMMODITY_MODEL},cwd,'p').info);
 assert.match(resolveResume(prior,{provider:'openrouter',model:COMMODITY_MODEL},join(cwd,'other'),'p').error,/cwd mismatch/);
 assert.match(resolveResume(prior,{provider:'openrouter',model:'other'},cwd,'p').error,/provider\/model mismatch/);
 assert.match(resolveResume({...prior,receipt:{...prior.receipt,sessionId:''}},{provider:'openrouter',model:COMMODITY_MODEL},cwd,'p').error,/no Pi session ID/);
 assert.match(resolveResume({...prior,receipt:{...prior.receipt,sessionId:'bad id!'}},{provider:'openrouter',model:COMMODITY_MODEL},cwd,'p').error,/not valid/);
 assert.match(resolveResume({...prior,receipt:undefined},{provider:'openrouter',model:COMMODITY_MODEL},cwd,'p').error,/no receipt/);
});
test('Resume mismatch blocks before the worker starts',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-'));
 const parentDir=join(cwd,'.delivery','prior','1');
 mkdirSync(parentDir,{recursive:true});
 const prior=priorResult(cwd,{cwd:join(cwd,'elsewhere')});
 writeFileSync(join(parentDir,'result.json'),JSON.stringify(prior));seedSession(parentDir);
 let spawned=false;
 const spawnPi=()=>{spawned=true;return {status:0,stdout:'',stderr:''};};
 const r=await run(task(0,{cwd,provider:'openrouter',model:COMMODITY_MODEL,resumeFrom:join(parentDir,'result.json')}),false,{spawnPi});
 assert.equal(r.status,'needs_review');
 assert.match(r.workerError,/resumeFrom rejected/);
 assert.match(r.resume.error,/cwd mismatch/);
 assert.equal(spawned,false);
});
test('Resume missing file is rejected',async()=>{
 const r=await run(task(0,{resumeFrom:'nope/result.json'}),false,{spawnPi:()=>({status:0,stdout:'',stderr:''})});
 assert.equal(r.status,'needs_review');
 assert.match(r.resume.error,/not readable/);
});
test('Resume passes explicit --session, appends the contract and records the parent',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-'));
 const parentDir=join(cwd,'.delivery','prior','1');
 mkdirSync(parentDir,{recursive:true});
 writeFileSync(join(parentDir,'result.json'),JSON.stringify(priorResult(cwd)));seedSession(parentDir);
 let captured:any;
 const spawnPi=(command:string,args:string[])=>{captured={command,args};return {status:0,stdout:stream({type:'session',id:SESSION_A},assistant(),{type:'agent_settled'}),stderr:''};};
 const t=task(0,{cwd,provider:'openrouter',model:COMMODITY_MODEL,workflow:'checks_first',deliverable:'Continue work',resumeFrom:join(parentDir,'result.json')});
 const r=await run(t,false,{spawnPi});
 assert.equal(captured.command,'pi');
 assert.equal(captured.args[captured.args.indexOf('--session')+1],SESSION_A);
 assert.ok(!captured.args.includes('--continue'));
 const prompt=captured.args[captured.args.length-1];
 assert.ok(prompt.includes('Resume context'));
 assert.ok(prompt.includes(SESSION_A));
 assert.ok(prompt.includes(JSON.stringify(t)));
 assert.equal(r.status,'ready_for_review');
 assert.equal(r.resume.parentSessionId,SESSION_A);
 assert.equal(r.resume.sessionId,SESSION_A);
 assert.equal(r.resume.parentResult.status,'ready_for_review');
 assert.equal(r.cache.guaranteed,false);
 assert.match(r.cache.note,/best effort/);
 assert.equal(r.receipt.usage.cacheRead,0);
});
test('Resume from a prior recon run never auto-approves test_first',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-'));
 const parentDir=join(cwd,'.delivery','prior','1');
 mkdirSync(parentDir,{recursive:true});
 writeFileSync(join(parentDir,'result.json'),JSON.stringify(priorResult(cwd)));seedSession(parentDir);
 let spawned=false;
 const spawnPi=(_c:string,args:string[])=>{spawned=true;return {status:0,stdout:stream({type:'session',id:SESSION_A},assistant(),{type:'agent_settled'}),stderr:''};};
 const classifier:any=workflowClassifier({...JEVPASS, workflow:choice('test_first',0.95)});
 const t=task(0,{cwd,provider:'openrouter',model:COMMODITY_MODEL,workflow:'auto',jev:{mode:'shadow'},resumeFrom:join(parentDir,'result.json')});
 const r=await run(t,false,{spawnPi,classify:classifier});
 assert.equal(spawned,true);
 assert.equal(r.workflow.selected,'checks_first');
 assert.equal(r.workflow.recommended,'test_first');
 assert.match(r.workflow.note,/requires an explicit workflow/);
});


