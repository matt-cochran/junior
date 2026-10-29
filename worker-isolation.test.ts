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

// --- D07 worktree isolation + complete bounded evidence (offline; temporary real Git repos) ---
test('Validate accepts isolation values and rejects unknown ones',()=>{
 assert.doesNotThrow(()=>validate({...task(),isolation:'none'}));
 assert.doesNotThrow(()=>validate({...task(),isolation:'worktree'}));
 assert.throws(()=>validate({...task(),isolation:'docker'}),/Invalid isolation/);
});

test('Complete evidence includes staged, unstaged, deleted, renamed and untracked files',()=>{
 const repo=gitRepo();
 commitFile(repo,'tracked.txt','one\n');
 commitFile(repo,'old.txt','old\n');
 commitFile(repo,'del.txt','del\n');
 writeFileSync(join(repo.dir,'tracked.txt'),'staged\n'); repo.git(['add','tracked.txt']);
 writeFileSync(join(repo.dir,'tracked.txt'),'staged\nunstaged\n');
 repo.git(['mv','old.txt','renamed.txt']);
 rmSync(join(repo.dir,'del.txt'));
 writeFileSync(join(repo.dir,'new.txt'),'hello untracked\n');
 writeFileSync(join(repo.dir,'bin.dat'),Buffer.from([0,1,2,3,255]));
 const ev=boundedGitEvidence(repo.dir);
 const byPath:any=Object.fromEntries(ev.changedFiles.map(f=>[f.path,f]));
 assert.ok(byPath['tracked.txt'],'tracked.txt listed');
 assert.equal(byPath['tracked.txt'].status,'M');
 assert.equal(byPath['del.txt'].status,'D');
 assert.equal(byPath['renamed.txt'].status,'R');
 assert.equal(byPath['renamed.txt'].oldPath,'old.txt');
 assert.equal(byPath['new.txt'].untracked,true);
 assert.ok(byPath['new.txt'].content.includes('hello untracked'));
 assert.equal(byPath['bin.dat'].binary,true);
 assert.equal(byPath['bin.dat'].content,undefined);
 assert.match(ev.diff,/rename from old\.txt/);
 assert.match(ev.diff,/deleted file/);
 assert.match(ev.diff,/\+unstaged/);
 assert.match(ev.diff,/hello untracked/);
 assert.equal(ev.truncated,false);
 assert.equal(ev.limits.diffTruncated,false);
});

test('Evidence never follows untracked symlinks out of the checkout',()=>{
 const repo=gitRepo();
 commitFile(repo,'a.txt','a\n');
 symlinkSync('/etc/passwd',join(repo.dir,'linkout'));
 symlinkSync('a.txt',join(repo.dir,'linkin'));
 const ev=boundedGitEvidence(repo.dir);
 const out=ev.changedFiles.find(f=>f.path==='linkout')!;
 assert.equal(out.symlink,true);
 assert.equal(out.content,undefined);
 assert.match(out.note||'',/symlink/);
 assert.ok(!ev.diff.includes('root:'),'symlink target content must not leak');
 const inside=ev.changedFiles.find(f=>f.path==='linkin')!;
 assert.equal(inside.symlink,true);
 assert.equal(inside.content,undefined);
});

test('Evidence reports explicit truncation metadata',()=>{
 const repo=gitRepo();
 commitFile(repo,'a.txt','a\n');
 writeFileSync(join(repo.dir,'big.txt'),'x'.repeat(500));
 const ev=boundedGitEvidence(repo.dir,50);
 assert.equal(ev.truncated,true);
 assert.equal(ev.limits.diffTruncated,true);
 assert.ok(ev.diff.length<=50);
});

test('Before/after evidence distinguishes preexisting changes from run changes',()=>{
 const repo=gitRepo();
 commitFile(repo,'a.txt','base\n');
 writeFileSync(join(repo.dir,'a.txt'),'preexisting\n');
 const before=collectGitEvidence(repo.dir);
 writeFileSync(join(repo.dir,'run.txt'),'from run\n');
 const after=collectGitEvidence(repo.dir);
 const delta=evidenceDelta(before,after);
 assert.ok(delta.runChangedFiles.some(f=>f.path==='run.txt'));
 assert.ok(!delta.runChangedFiles.some(f=>f.path==='a.txt'));
 assert.ok(delta.preexistingFiles.some(f=>f.path==='a.txt'));
 assert.equal(delta.changed,true);
});

test('worktree isolation refuses a dirty source before any worker call',async()=>{
 const repo=gitRepo();
 commitFile(repo,'a.txt','base\n');
 writeFileSync(join(repo.dir,'a.txt'),'dirty\n');
 let spawned=false;
 const r=await run(wtTask(repo),false,{spawnPi:()=>{spawned=true;return {status:0,stdout:'',stderr:''};}});
 assert.equal(r.status,'needs_review');
 assert.match(r.workerError,/clean|uncommitted|dirty/i);
 assert.equal(spawned,false);
 assert.equal(r.executionCwd,undefined);
});

test('worktree isolation executes Pi and checks in the isolated checkout, leaving source untouched',async()=>{
 const repo=gitRepo();
 commitFile(repo,'a.txt','base\n');
 let spawnedCwd:string|undefined;
 const spawnPi=(command:string,args:string[],opts:any)=>{spawnedCwd=opts.cwd;writeFileSync(join(opts.cwd,'worker-output.txt'),'made\n');return {status:0,stdout:stream({type:'session',id:'sess-wt'},assistant(),{type:'agent_settled'}),stderr:''};};
 const r=await run(wtTask(repo),false,{spawnPi});
 assert.equal(r.status,'ready_for_review');
 assert.equal(r.sourceCwd,repo.dir);
 assert.ok(r.executionCwd && r.executionCwd!==repo.dir);
 assert.equal(spawnedCwd,r.executionCwd);
 assert.equal(r.isolation.mode,'worktree');
 assert.ok(r.artifactDir.startsWith(join(repo.dir,'.delivery')));
 assert.ok(!existsSync(join(repo.dir,'worker-output.txt')));
 assert.ok(!existsSync(join(repo.dir,'check-marker.txt')));
 assert.ok(existsSync(join(r.executionCwd,'worker-output.txt')));
 assert.ok(existsSync(join(r.executionCwd,'check-marker.txt')));
 assert.ok(existsSync(r.executionCwd));
 assert.equal(r.checks[0].exitCode,0);
});
test('worktree isolation sets JUNIOR_PI_SOURCE_ROOT to the source checkout',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 let seen:any;
 await run(wtTask(repo),false,{spawnPi:(_c,_a,opts)=>{seen=opts;return {status:0,stdout:stream({type:'session',id:'s'},assistant(),{type:'agent_settled'}),stderr:''};}});
 assert.equal(seen.env.JUNIOR_PI_SOURCE_ROOT,repo.dir);
});
test('worktree isolation scopes JUNIOR_PI_WRITE_ROOTS to the execution checkout and artifact dir',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 let seen:any;
 const r=await run(wtTask(repo),false,{spawnPi:(_c,_a,opts)=>{seen=opts;return {status:0,stdout:stream({type:'session',id:'s'},assistant(),{type:'agent_settled'}),stderr:''};}});
 assert.equal(seen.env.JUNIOR_PI_WRITE_ROOTS,[r.executionCwd,r.artifactDir].join(delimiter));
});
test('isolation none scopes JUNIOR_PI_WRITE_ROOTS to the source checkout and artifact dir',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 let seen:any;
 const r=await run(okTask(repo),false,{spawnPi:(_c,_a,opts)=>{seen=opts;return {status:0,stdout:stream({type:'session',id:'s'},assistant(),{type:'agent_settled'}),stderr:''};}});
 assert.equal(seen.env.JUNIOR_PI_WRITE_ROOTS,[repo.dir,r.artifactDir].join(delimiter));
});
test('isolation none leaves JUNIOR_PI_SOURCE_ROOT unset',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 let seen:any;
 await run(okTask(repo),false,{spawnPi:(_c,_a,opts)=>{seen=opts;return {status:0,stdout:stream({type:'session',id:'s'},assistant(),{type:'agent_settled'}),stderr:''};}});
 assert.equal(seen.env.JUNIOR_PI_SOURCE_ROOT,undefined);
});
test('sandboxed Pi takes a lock in its run-local overlay, never in the source agent dir',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const agent=join(repo.dir,'read-only-agent'); mkdirSync(agent,{recursive:true});
 writeFileSync(join(agent,'auth.json'),JSON.stringify({openrouter:{type:'api',key:'not-a-real-secret'}}));
 await run(okTask(repo),false,{env:{...process.env,PI_CODING_AGENT_DIR:agent},spawnPi:(_c,_a,opts)=>{writeFileSync(join(opts.env.PI_CODING_AGENT_DIR,'auth.json.lock'),'lock');return {status:0,stdout:stream({type:'session',id:'s'},assistant(),{type:'agent_settled'}),stderr:''};}});
 assert.equal(existsSync(join(agent,'auth.json.lock')),false);
});

test('Run captures before/after evidence artifact and run-change summary',async()=>{
 const repo=gitRepo();
 commitFile(repo,'a.txt','base\n');
 writeFileSync(join(repo.dir,'a.txt'),'preexisting\n');
 const spawnPi=okSpawn((_c,_a,opts)=>{writeFileSync(join(opts.cwd,'run.txt'),'from run\n');});
 const r=await run(okTask(repo),false,{spawnPi});
 assert.equal(r.status,'ready_for_review');
 assert.equal(r.executionCwd,r.sourceCwd);
 const artifact=JSON.parse(readFileSync(join(r.artifactDir,'evidence.json'),'utf8'));
 assert.ok(artifact.before);
 assert.ok(artifact.after);
 assert.ok(artifact.runChangedFiles.some((f:any)=>f.path==='run.txt'));
 assert.ok(!artifact.runChangedFiles.some((f:any)=>f.path==='a.txt'));
 assert.ok(artifact.preexistingFiles.some((f:any)=>f.path==='a.txt'));
 assert.ok(r.evidence.runChangedFiles.some((f:any)=>f.path==='run.txt'));
});

test('Jev postflight receives complete changed-file evidence',async()=>{
 const repo=gitRepo();
 commitFile(repo,'a.txt','base\n');
 let postState:any;
 const classifier:any=async({state,questions}:any)=>{if(!Object.prototype.hasOwnProperty.call(questions,'contract_clear'))postState=state;const isPre=Object.prototype.hasOwnProperty.call(questions,'contract_clear');return {stopReason:'stop',provider:'openrouter',model:'typesafe/jev-1.13',answers:isPre?JEVPASS:{AC1:bool(0.95)},usage:gateUsage};};
 const spawnPi=okSpawn((_c,_a,opts)=>{writeFileSync(join(opts.cwd,'run.txt'),'x\n');});
 const r=await run(okTask(repo,{jev:{mode:'shadow'}}),false,{spawnPi,classify:classifier});
 assert.equal(r.status,'ready_for_review');
 assert.ok(Array.isArray(postState.git.changedFiles));
 assert.ok(postState.git.changedFiles.some((f:any)=>f.path==='run.txt'));
 assert.ok(Array.isArray(postState.runChanges.changedFiles));
 assert.ok(postState.runChanges.changedFiles.some((f:any)=>f.path==='run.txt'));
});

test('Held execution lock rejects a concurrent run before worker or classifier calls',async()=>{
 const repo=gitRepo();
 commitFile(repo,'a.txt','base\n');
 const lockDir=join(repo.dir,'.delivery','locks');
 const held=acquireLock(lockDir,`checkout:${repo.dir}`,{purpose:'test'});
 assert.ok(held.handle);
 let spawned=false, classified=false;
 const classifier:any=async()=>{classified=true;return {stopReason:'stop',provider:'openrouter',model:'typesafe/jev-1.13',answers:JEVPASS,usage:gateUsage};};
 const r=await run(okTask(repo,{jev:{mode:'shadow'}}),true,{classify:classifier,spawnPi:()=>{spawned=true;return {status:0,stdout:'',stderr:''};}});
 assert.equal(r.status,'needs_review');
 assert.match(r.workerError,/lock/i);
 assert.equal(spawned,false);
 assert.equal(classified,false);
 assert.ok(existsSync(held.lockPath),'unknown/stale lock is not auto-deleted');
 held.handle!.release();
 assert.ok(!existsSync(held.lockPath));
});

test('Locks are released after a run on success and on check failure',async()=>{
 const repo=gitRepo();
 commitFile(repo,'a.txt','base\n');
 const lockPath=lockPathFor(join(repo.dir,'.delivery','locks'),`checkout:${repo.dir}`);
 await run(okTask(repo),false,{spawnPi:okSpawn()});
 assert.ok(!existsSync(lockPath),'released after success');
 await run(okTask(repo,{id:'ev-fail',checks:[{command:process.execPath,args:['-e','process.exit(1)']}]}),false,{spawnPi:okSpawn()});
 assert.ok(!existsSync(lockPath),'released after checks failure');
});

test('Resume rejects incompatible isolation before paid calls',async()=>{
 const repo=gitRepo();
 commitFile(repo,'a.txt','base\n');
 const priorDir=join(repo.dir,'.delivery','prior','1');mkdirSync(priorDir,{recursive:true});
 const prior={id:'prior',status:'ready_for_review',artifactDir:priorDir,sourceCwd:repo.dir,executionCwd:repo.dir,isolation:{mode:'none'},receipt:{source:'pi_message_end',requested:{provider:'openrouter',model:COMMODITY_MODEL},sessionId:SESSION_A}};
 writeFileSync(join(priorDir,'result.json'),JSON.stringify(prior));seedSession(priorDir);
 let spawned=false;
 const r=await run(okTask(repo,{id:'resume',provider:'openrouter',model:COMMODITY_MODEL,isolation:'worktree',resumeFrom:join(priorDir,'result.json')}),false,{spawnPi:()=>{spawned=true;return {status:0,stdout:'',stderr:''};}});
 assert.equal(r.status,'needs_review');
 assert.match(r.workerError,/isolation/i);
 assert.equal(spawned,false);
});

test('Resume with worktree isolation reuses the prior execution checkout',async()=>{
 const repo=gitRepo();
 commitFile(repo,'a.txt','base\n');
 const wtPath=join(repo.dir,'.delivery','prior-wt');
 assert.equal(createDetachedWorktree(repo.dir,wtPath).ok,true);
 const priorDir=join(repo.dir,'.delivery','prior','2');mkdirSync(priorDir,{recursive:true});
 const prior={id:'prior',status:'ready_for_review',artifactDir:priorDir,sourceCwd:repo.dir,executionCwd:wtPath,isolation:{mode:'worktree'},receipt:{source:'pi_message_end',requested:{provider:'openrouter',model:COMMODITY_MODEL},sessionId:SESSION_A}};
 writeFileSync(join(priorDir,'result.json'),JSON.stringify(prior));seedSession(priorDir);
 let spawnedCwd:string|undefined;
 const spawnPi=(command:string,args:string[],opts:any)=>{spawnedCwd=opts.cwd;return {status:0,stdout:stream({type:'session',id:SESSION_A},assistant(),{type:'agent_settled'}),stderr:''};};
 const r=await run(okTask(repo,{id:'resume-wt',provider:'openrouter',model:COMMODITY_MODEL,isolation:'worktree',resumeFrom:join(priorDir,'result.json')}),false,{spawnPi});
 assert.equal(r.status,'ready_for_review');
 assert.equal(r.executionCwd,wtPath);
 assert.equal(spawnedCwd,wtPath);
 assert.equal(r.resume.sessionId,SESSION_A);
});

test('README documents isolation defaults, limitations, review workflow and evidence limits',()=>{
 const md=documentation();
 assert.match(md,/isolation/i);
 assert.match(md,/worktree/i);
 assert.match(md,/changedFiles|changed files/i);
 assert.match(md,/not a sandbox|non-sandbox|not sandbox/i);
 assert.match(md,/git worktree list/i);
 assert.match(md,/truncat/i);
});

test('README documents the fmeca/evaluate workflows, commands and report lifecycle',()=>{
 const md=documentation();
 assert.match(md,/fmeca/i);
 assert.match(md,/evaluate/i);
 assert.match(md,/analysis-report\.md/);
 assert.match(md,/needs_review/);
 assert.match(md,/explicit authorization/i);
 assert.match(md,/node worker\.ts run/);
 assert.match(md,/analysis report lifecycle/i);
});

test('Blocked enforce preflight releases the checkout lock',async()=>{
 const repo=gitRepo();
 commitFile(repo,'a.txt','base\n');
 const classifier=gateClassifier({contract_clear:bool(0.1),blocking_assumptions:bool(0.95)});
 const lockPath=lockPathFor(join(repo.dir,'.delivery','locks'),`checkout:${repo.dir}`);
 const r=await run(okTask(repo,{id:'pre',jev:{mode:'enforce'}}),true,{classify:classifier});
 assert.equal(r.status,'needs_review');
 assert.match(r.workerError,/preflight/);
 assert.ok(!existsSync(lockPath),'lock released on blocked preflight');
});

test('Held Pi session lock rejects a resume before paid calls and is not auto-deleted',async()=>{
 const repo=gitRepo();
 commitFile(repo,'a.txt','base\n');
 const from=priorNone(repo,'3');
 const lockDir=join(repo.dir,'.delivery','locks');
 const held=acquireLock(lockDir,`session:${SESSION_A}`,{purpose:'test'});
 assert.ok(held.handle);
 let spawned=false;
 const r=await run(okTask(repo,{id:'resume-lock',provider:'openrouter',model:COMMODITY_MODEL,resumeFrom:from}),false,{spawnPi:()=>{spawned=true;return {status:0,stdout:'',stderr:''};}});
 assert.equal(r.status,'needs_review');
 assert.match(r.workerError,/lock/i);
 assert.equal(spawned,false);
 assert.ok(existsSync(held.lockPath),'held session lock is not auto-deleted');
 held.handle!.release();
});

test('Pi session lock is released after a resume run',async()=>{
 const repo=gitRepo();
 commitFile(repo,'a.txt','base\n');
 const from=priorNone(repo,'4');
 const lockPath=lockPathFor(join(repo.dir,'.delivery','locks'),`session:${SESSION_A}`);
 const r=await run(okTask(repo,{id:'resume-rel',provider:'openrouter',model:COMMODITY_MODEL,resumeFrom:from}),false,{spawnPi:okSpawn()});
 assert.equal(r.status,'ready_for_review');
 assert.ok(!existsSync(lockPath),'session lock released after resume');
});

test('status exposes isolation, execution checkout and evidence summary',async()=>{
 const repo=gitRepo();
 commitFile(repo,'a.txt','base\n');
 const r=await run(okTask(repo),false,{spawnPi:okSpawn((_c,_a,opts)=>{writeFileSync(join(opts.cwd,'run.txt'),'x\n');})});
 const f=join(r.artifactDir,'result.json');
 const out=JSON.parse(cli(['status',f]).stdout);
 assert.equal(out.sourceCwd,repo.dir);
 assert.equal(out.executionCwd,repo.dir);
 assert.equal(out.isolation.mode,'none');
 assert.ok(out.evidence.changedFiles.some((x:any)=>x.path==='run.txt'));
});

// --- D08 regression: D07 review gaps ---
test('evidenceDelta detects a content edit to an already modified tracked file',()=>{
 const repo=gitRepo();
 commitFile(repo,'a.txt','base\n');
 writeFileSync(join(repo.dir,'a.txt'),'before-run\n');
 const before=collectGitEvidence(repo.dir);
 writeFileSync(join(repo.dir,'a.txt'),'after-run\n');
 const after=collectGitEvidence(repo.dir);
 const delta=evidenceDelta(before,after);
 assert.ok(delta.runChangedFiles.some(f=>f.path==='a.txt'),'tracked edit by the run is a run change');
 assert.equal(delta.changed,true);
 assert.ok(!delta.preexistingFiles.some(f=>f.path==='a.txt'));
});

test('Failed session lock acquisition releases the already-acquired checkout lock',async()=>{
 const repo=gitRepo();
 commitFile(repo,'a.txt','base\n');
 const from=priorNone(repo,'gap2');
 const lockDir=join(repo.dir,'.delivery','locks');
 const held=acquireLock(lockDir,`session:${SESSION_A}`,{purpose:'test'});
 assert.ok(held.handle);
 const checkoutLockPath=lockPathFor(lockDir,`checkout:${repo.dir}`);
 let spawned=false;
 const r=await run(okTask(repo,{id:'resume-lock-gap',provider:'openrouter',model:COMMODITY_MODEL,resumeFrom:from}),false,{spawnPi:()=>{spawned=true;return {status:0,stdout:'',stderr:''};}});
 assert.equal(r.status,'needs_review');
 assert.match(r.workerError,/lock/i);
 assert.equal(spawned,false);
 assert.ok(!existsSync(checkoutLockPath),'checkout lock must be released when the session lock cannot be acquired');
 held.handle!.release();
});

test('Session lock key is derived from the parent session id, not a post-run session id',()=>{
 assert.equal(sessionLockKey({parentSessionId:'parent-1',sessionId:'new-2'} as any),'session:parent-1');
});

// --- Issue #14: check cwd resolution and strict contract keys (offline) ---
test('A check with a relative nested cwd runs in the nested package directory',async()=>{
 const repo=gitRepo(); addNestedPackage(repo);
 await run(okTask(repo,{checks:[cwdCheck('packages/app')]}),true);
 assert.ok(existsSync(join(repo.dir,'packages','app','marker.txt')));
});

test('A check with a relative nested cwd records the nested execution path',async()=>{
 const repo=gitRepo(); addNestedPackage(repo);
 const r=await run(okTask(repo,{checks:[cwdCheck('packages/app')]}),true);
 assert.equal(r.checks[0].cwd,join(repo.dir,'packages','app'));
});

test('A check without cwd records the execution checkout as its cwd',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const r=await run(okTask(repo,{checks:[cwdCheck()]}),true);
 assert.equal(r.checks[0].cwd,r.executionCwd);
});

test('A check with a relative nested cwd in worktree isolation resolves under the execution checkout',async()=>{
 const repo=gitRepo(); addNestedPackage(repo);
 const r=await run(okTask(repo,{isolation:'worktree',checks:[cwdCheck('packages/app')]}),true);
 assert.equal(r.checks[0].cwd,join(r.executionCwd!,'packages','app'));
});

test('An absolute source-checkout cwd is remapped to the isolated worktree path',async()=>{
 const repo=gitRepo(); addNestedPackage(repo);
 const r=await run(okTask(repo,{isolation:'worktree',checks:[cwdCheck(join(repo.dir,'packages','app'))]}),true);
 assert.equal(r.checks[0].cwd,join(r.executionCwd!,'packages','app'));
});

test('An absolute remapped worktree cwd runs in the isolated package',async()=>{
 const repo=gitRepo(); addNestedPackage(repo);
 const r=await run(okTask(repo,{isolation:'worktree',checks:[cwdCheck(join(repo.dir,'packages','app'))]}),true);
 assert.ok(existsSync(join(r.executionCwd!,'packages','app','marker.txt')));
});

test('Validate rejects a relative check cwd that escapes the workspace',()=>{
 assert.throws(()=>validate({...task(),checks:[{command:process.execPath,args:[],cwd:'../outside'}]}),/check\.cwd/);
});

test('Validate rejects an absolute check cwd outside the workspace',()=>{
 assert.throws(()=>validate({...task(),checks:[{command:process.execPath,args:[],cwd:join(tmpdir(),'delivery-outside-'+Date.now())}]}),/check\.cwd/);
});

test('Validate rejects a malformed check cwd',()=>{
 assert.throws(()=>validate({...task(),checks:[{command:process.execPath,args:[],cwd:123}]}),/check\.cwd/);
});

test('Validate rejects an unknown check field',()=>{
 assert.throws(()=>validate({...task(),checks:[{command:process.execPath,args:[],workdir:'packages/app'}]}),/Unknown check field/);
});

test('Validate rejects an unknown top-level contract field',()=>{
 assert.throws(()=>validate({...task(),dependencies:[]}),/Unknown contract field/);
});

test('Validate retains every supported top-level contract field',()=>{
 const full={...task(),constraints:['bounded'],provider:'openrouter',model:'m',thinking:'low',
  pricing:{input:1,output:1,source:'catalog',date:'2026-01-01'},jev:{mode:'shadow'},
  workflow:'test_first',isolation:'none',resumeFrom:'prior/result.json',repairFrom:'prior/result.json',
  reviewFrom:'prior/result.json',maxRepairs:1,lineageDeadlineMs:1000,hopFrom:'hop.json',hopRevision:1,
  hopContext:{from:'hop.json'},
  execution:{deadlineMs:600000,quietMs:120000,toolTimeoutMs:300000,heartbeatMs:5000,checkTimeoutMs:120000},
  deadlineMs:600000,quietMs:120000,toolTimeoutMs:300000,heartbeatMs:5000,checkTimeoutMs:120000};
 assert.doesNotThrow(()=>validate(full));
});

// --- Issue #14 review repair: symlinked check cwd escapes (offline) ---
test('A check cwd symlink pointing outside the workspace is not executed',async(t:any)=>{
 const c=symlinkEscape(); if(!c){t.skip('directory symlinks unavailable');return;}
 await run(okTask(c.repo,{checks:[c.check]}),true);
 assert.equal(existsSync(join(c.outside,'marker.txt')),false);
});

test('A check cwd symlink pointing outside the workspace fails the run',async(t:any)=>{
 const c=symlinkEscape(); if(!c){t.skip('directory symlinks unavailable');return;}
 const r=await run(okTask(c.repo,{checks:[c.check]}),true);
 assert.equal(r.status,'checks_failed');
});

test('A check cwd symlink escape is recorded with a useful reason',async(t:any)=>{
 const c=symlinkEscape(); if(!c){t.skip('directory symlinks unavailable');return;}
 const r=await run(okTask(c.repo,{checks:[c.check]}),true);
 assert.match(r.checks[0].error,/outside the workspace/);
});

test('A check cwd symlink escape never runs in the workspace root',async(t:any)=>{
 const c=symlinkEscape(); if(!c){t.skip('directory symlinks unavailable');return;}
 await run(okTask(c.repo,{checks:[c.check]}),true);
 assert.equal(existsSync(join(c.repo.dir,'marker.txt')),false);
});

test('A check cwd symlink pointing inside the workspace is allowed to run',async(t:any)=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const target=join(repo.dir,'inside'); mkdirSync(target);
 const link=join(repo.dir,'linkin');
 if(!makeDirLink(target,link)){t.skip('directory symlinks unavailable');return;}
 const r=await run(okTask(repo,{checks:[markerCheck(link)]}),true);
 assert.equal(existsSync(join(target,'marker.txt')),true);
});

// --- B01 run artifacts never appear as target-checkout changes (real Git fixtures) ---
test('An isolation none mock run reports no .delivery path in changedFiles',async()=>{
 const repo=initRepo();
 const r=await run(artifactTask(repo),true);
 assert.equal(r.evidence.changedFiles.some((f:any)=>deliveryPath(f.path)),false);
});

test('An isolation none mock run reports no .delivery path in runChangedFiles',async()=>{
 const repo=initRepo();
 const r=await run(artifactTask(repo),true);
 assert.equal(r.evidence.runChangedFiles.some((f:any)=>deliveryPath(f.path)),false);
});

test('An isolation none mock run leaves no .delivery entry in git status',async()=>{
 const repo=initRepo();
 await run(artifactTask(repo),true);
 const status=spawnSync('git',['status','--porcelain'],{cwd:repo.dir,encoding:'utf8'}).stdout;
 assert.equal(status.includes('.delivery'),false);
});

test('An isolation none run records the run-artifact tree in the repository-local exclude',async()=>{
 const repo=initRepo();
 await run(artifactTask(repo),true);
 assert.match(readFileSync(join(repo.dir,'.git','info','exclude'),'utf8'),/^\/\.delivery\/$/m);
});

test('A mock run in a non-git cwd completes without a repository-local exclude',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-nogit-'));
 const r=await run({id:'b01',deliverable:'artifact isolation',cwd,acceptance:['checks pass'],checks:[{command:process.execPath,args:['-e','process.exit(0)']}]},true);
 assert.equal(r.status,'simulation_passed');
});

// --- B06 opt-in isolation setup (links, copies, setup commands) ---
test('validate accepts a well-formed isolationSetup',()=>{
 assert.doesNotThrow(()=>validate({...task(),isolation:'worktree',isolationSetup:{links:[{from:'a',to:'b'}],copy:['c'],commands:[{command:'node',args:['x'],cwd:'d'}]}}));
});

test('validate rejects an absolute isolationSetup link path',()=>{
 assert.throws(()=>validate({...task(),isolation:'worktree',isolationSetup:{links:[{from:'/etc/passwd',to:'deps'}]}}),/Invalid isolationSetup/);
});

test('validate rejects an isolationSetup link that escapes via dot-dot',()=>{
 assert.throws(()=>validate({...task(),isolation:'worktree',isolationSetup:{links:[{from:'..',to:'deps'}]}}),/Invalid isolationSetup/);
});

test('validate rejects a malformed isolationSetup command entry',()=>{
 assert.throws(()=>validate({...task(),isolation:'worktree',isolationSetup:{commands:[{command:''}]}}),/Invalid isolationSetup/);
});

test('isolationSetup links a gitignored dependency dir so a check can read through it',async()=>{
 const repo=linkRepo();
 const checks=[{command:process.execPath,args:['-e',"require('fs').readFileSync('deps/secret.txt')"]}];
 const r=await run(okTask(repo,{isolation:'worktree',isolationSetup:{links:[{from:'deps',to:'deps'}]},checks}),true);
 assert.equal(r.checks[0].exitCode,0);
});

test('a linked isolationSetup path is absent from run change evidence',async()=>{
 const repo=linkRepo();
 const r=await run(okTask(repo,{isolation:'worktree',isolationSetup:{links:[{from:'deps',to:'deps'}]}}),true);
 assert.ok(!r.evidence.runChangedFiles.some((f:any)=>f.path==='deps'||f.path.startsWith('deps/')));
});

test('a failing isolationSetup command ends the run as isolation_setup_failed',async()=>{
 const repo=gitRepo();
 const r=await run(okTask(repo,{isolation:'worktree',isolationSetup:{commands:[{command:process.execPath,args:['-e','process.exit(3)']}]}}),true);
 assert.equal(r.status,'isolation_setup_failed');
});

test('a commandPolicy-refused isolationSetup command ends the run as isolation_setup_failed',async()=>{
 const repo=gitRepo();
 const r=await run(okTask(repo,{isolation:'worktree',commandPolicy:{enforce:true,rules:[{match:['git'],placement:'local'}]},isolationSetup:{commands:[{command:process.execPath,args:['-e','process.exit(0)']}]}}),true);
 assert.match(r.workerError,/isolationSetup failed: .*E_COMMAND_PLACEMENT|isolationSetup failed: .*refus/i);
});

test('Pi is not started when isolationSetup fails',async()=>{
 const repo=gitRepo();
 let spawned=false;
 await run(okTask(repo,{isolation:'worktree',isolationSetup:{commands:[{command:process.execPath,args:['-e','process.exit(3)']}]}}),false,{spawnPi:()=>{spawned=true;return {status:0,stdout:'',stderr:''};}});
 assert.equal(spawned,false);
});

test('isolationSetup writes its command output to isolation-setup.log',async()=>{
 const repo=gitRepo();
 const r=await run(okTask(repo,{isolation:'worktree',isolationSetup:{commands:[{command:process.execPath,args:['-e',"console.log('setup-output-marker')"]}]}}),true);
 assert.match(readFileSync(join(r.artifactDir,'isolation-setup.log'),'utf8'),/setup-output-marker/);
});

test('isolationSetup is ignored when isolation is none',async()=>{
 const repo=gitRepo();
 const r=await run(okTask(repo,{isolation:'none',isolationSetup:{commands:[{command:process.execPath,args:['-e','process.exit(3)']}]}}),true);
 assert.equal(r.status,'simulation_passed');
});

test('delivery.config.json isolationSetup provisions the worktree',async()=>{
 const repo=gitRepo();
 commitFile(repo,'delivery.config.json',JSON.stringify({provider:'openrouter',model:COMMODITY_MODEL,isolationSetup:{commands:[{command:process.execPath,args:['-e',"require('fs').writeFileSync('setup-marker.txt','1')"]}]}}));
 const checks=[{command:process.execPath,args:['-e',"require('fs').readFileSync('setup-marker.txt')"]}];
 const r=await run(okTask(repo,{isolation:'worktree',checks}),true);
 assert.equal(r.checks[0].exitCode,0);
});

test('a contract isolationSetup takes precedence over delivery.config.json',async()=>{
 const repo=gitRepo();
 commitFile(repo,'delivery.config.json',JSON.stringify({provider:'openrouter',model:COMMODITY_MODEL,isolationSetup:{commands:[{command:process.execPath,args:['-e','process.exit(3)']}]}}));
 const isolationSetup={commands:[{command:process.execPath,args:['-e',"require('fs').writeFileSync('contract-marker.txt','1')"]}]};
 const r=await run(okTask(repo,{isolation:'worktree',isolationSetup}),true);
 assert.equal(r.status,'simulation_passed');
});

