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

// --- commodity-only executor policy and Jev model routing ---
test('A mock run with an explicit frontier model is refused for review',async()=>{
 const r=await run(task(0,{provider:'anthropic',model:'claude-opus'}),true);
 assert.equal(r.status,'needs_review');
});
test('A refused frontier model leaves the worker exit code unset',async()=>{
 const r=await run(task(0,{provider:'anthropic',model:'claude-opus'}),true);
 assert.equal(r.workerExitCode,null);
});
test('A refused frontier model reports the frontier policy code',async()=>{
 const r=await run(task(0,{provider:'anthropic',model:'claude-opus'}),true);
 assert.match(r.workerError,/^frontier_model_refused/);
});
test('An unknown explicit model is refused with the unknown policy code',async()=>{
 const r=await run(task(0,{provider:'openrouter',model:'acme/unknown-1'}),true);
 assert.match(r.workerError,/^unknown_model_refused/);
});
test('A frontier model pinned in project config never reaches the worker',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-frontier-pin-'));
 writeFileSync(join(cwd,'delivery.config.json'),JSON.stringify({provider:'anthropic',model:'claude-opus'}));
 let spawned=false;
 await run(task(0,{cwd}),false,{spawnPi:()=>{spawned=true;return {status:0,stdout:'',stderr:''};}});
 assert.equal(spawned,false);
});
test('A run with no explicit model and no config records the builtin default and source',async()=>{
 const r=await run(task(),true);
 assert.deepEqual(r.receipt.requested,{provider:'openrouter',model:COMMODITY_MODEL,source:'builtin'});
});
test('A default routed profile retains the exact project pin and reports its source',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-project-pin-'));
 const pinned='deepseek/deepseek-v4.1-flash-1017';
 writeFileSync(join(cwd,'delivery.config.json'),JSON.stringify({
  provider:'openrouter',model:pinned,models:{routing:'auto',autoUpgrade:false},
 }));
 const r=await run(task(0,{cwd,jev:{mode:'shadow'}}),true,{classify:modelGate('general',0.9)});
 assert.deepEqual(r.receipt.requested,{provider:'openrouter',model:pinned,source:'project'});
 assert.equal(r.modelRouting.applied,false);
 assert.equal(r.modelRouting.profile,'general');
});
test('Auto routing applies a confident non-default model profile with a run approval',async()=>{
 const r=await run(task(0,{jev:{mode:'shadow'},approveModel:'long-horizon'}),true,{classify:modelGate('long-horizon',0.9)});
 assert.deepEqual(r.receipt.requested,{provider:'openrouter',model:ROUTED_MODEL,source:'routed'});
});
test('Auto routing records that a run-approved model route was applied',async()=>{
 const r=await run(task(0,{jev:{mode:'shadow'},approveModel:'long-horizon'}),true,{classify:modelGate('long-horizon',0.9)});
 assert.equal(r.modelRouting.applied,true);
});
test('Shadow routing keeps the default requested model',async()=>{
 const r=await run(task(0,{cwd:routingCwd('shadow'),jev:{mode:'shadow'}}),true,{classify:modelGate('long-horizon',0.9)});
 assert.equal(r.receipt.requested.model,COMMODITY_MODEL);
});
test('Shadow routing records the recommended model profile',async()=>{
 const r=await run(task(0,{cwd:routingCwd('shadow'),jev:{mode:'shadow'}}),true,{classify:modelGate('long-horizon',0.9)});
 assert.equal(r.modelRouting.profile,'long-horizon');
});
test('Shadow routing records the recommendation as not applied',async()=>{
 const r=await run(task(0,{cwd:routingCwd('shadow'),jev:{mode:'shadow'}}),true,{classify:modelGate('long-horizon',0.9)});
 assert.equal(r.modelRouting.applied,false);
});
test('A routed answer below the confidence threshold keeps the default model',async()=>{
 const r=await run(task(0,{jev:{mode:'shadow'}}),true,{classify:modelGate('long-horizon',0.5)});
 assert.equal(r.receipt.requested.model,COMMODITY_MODEL);
});
test('An explicit task model makes model routing ineligible',async()=>{
 const r=await run(task(0,{provider:'openrouter',model:'moonshotai/kimi-k3',jev:{mode:'shadow'}}),true,{classify:modelGate('long-horizon',0.9)});
 assert.equal(r.modelRouting.eligible,false);
});
test('An explicit task model is not asked a model profile question',async()=>{
 let questions:any;
 const classifier:any=async({questions:q}:any)=>{questions=q;return {stopReason:'stop',answers:JEVPASS};};
 await run(task(0,{provider:'openrouter',model:'moonshotai/kimi-k3',jev:{mode:'shadow'}}),true,{classify:classifier});
 assert.equal(Object.prototype.hasOwnProperty.call(questions,'model_profile'),false);
});
test('decideModelRoute applies a confident non-default profile with a run approval',()=>{
 assert.equal(decideModelRoute(routeConfig('auto'),{type:'choice',value:'long-horizon',confidence:0.9},{eligible:true,approveModel:'long-horizon'}).applied,true);
});
test('decideModelRoute records but does not apply a recommendation in shadow mode',()=>{
 assert.equal(decideModelRoute(routeConfig('shadow'),{type:'choice',value:'long-horizon',confidence:0.9},{eligible:true}).applied,false);
});
test('decideModelRoute keeps the default below the confidence threshold',()=>{
 assert.equal(decideModelRoute(routeConfig('auto'),{type:'choice',value:'long-horizon',confidence:0.5},{eligible:true}).model,COMMODITY_MODEL);
});
test('decideModelRoute ignores an unknown model profile',()=>{
 assert.match(decideModelRoute(routeConfig('auto'),{type:'choice',value:'missing',confidence:0.9},{eligible:true}).reason,/not in the roster/);
});
test('decideModelRoute marks a confident non-default profile as needing approval',()=>{
 assert.equal(decideModelRoute(routeConfig('auto'),{type:'choice',value:'long-horizon',confidence:0.9},{eligible:true}).needsApproval,true);
});
test('decideModelRoute names the missing approval in the reason',()=>{
 assert.match(decideModelRoute(routeConfig('auto'),{type:'choice',value:'long-horizon',confidence:0.9},{eligible:true}).reason,/approval/);
});
test('decideModelRoute applies a confident non-default profile with a project approval',()=>{
 assert.equal(decideModelRoute({...routeConfig('auto'),approved:['long-horizon']},{type:'choice',value:'long-horizon',confidence:0.9},{eligible:true}).applied,true);
});
test('decideModelRoute records the project approval source',()=>{
 assert.deepEqual(decideModelRoute({...routeConfig('auto'),approved:['long-horizon']},{type:'choice',value:'long-horizon',confidence:0.9},{eligible:true}).approval,{source:'project',key:'long-horizon'});
});

// --- human consent before a non-default model runs ---
test('A routed non-default profile without approval stops for model approval',async()=>{
 const r=await run(task(0,{jev:{mode:'shadow'}}),true,{classify:modelGate('long-horizon',0.9)});
 assert.equal(r.status,'needs_model_approval');
});
test('A routed non-default profile without approval leaves the worker exit code unset',async()=>{
 const r=await run(task(0,{jev:{mode:'shadow'}}),true,{classify:modelGate('long-horizon',0.9)});
 assert.equal(r.workerExitCode,null);
});
test('A routed non-default profile without approval writes the approval request artifact',async()=>{
 const r=await run(task(0,{jev:{mode:'shadow'}}),true,{classify:modelGate('long-horizon',0.9)});
 assert.equal(existsSync(join(r.artifactDir,'model-approval.json')),true);
});
test('The model-approval request mirrors into result.modelApproval',async()=>{
 const r=await run(task(0,{jev:{mode:'shadow'}}),true,{classify:modelGate('long-horizon',0.9)});
 assert.deepEqual(r.modelApproval,approvalFile(r));
});
test('The model-approval request carries both approve commands',async()=>{
 const r=await run(task(0,{jev:{mode:'shadow'}}),true,{classify:modelGate('long-horizon',0.9)});
 assert.deepEqual(approvalFile(r).approve,{run:'junior handoff <task> --approve-model long-horizon',project:'junior model approve long-horizon'});
});
test('The model-approval request carries the price delta from the local catalog',async()=>{
 const agent=pricedAgent({[COMMODITY_MODEL]:{input:0.03,output:0.08},[ROUTED_MODEL]:{input:0.09,output:0.24}});
 const r=await run(task(0,{jev:{mode:'shadow'}}),true,{classify:modelGate('long-horizon',0.9),env:{PI_CODING_AGENT_DIR:agent}});
 assert.equal(approvalFile(r).price.outputRatio,3);
});
test('The model-approval request falls back to cached online catalog prices',async()=>{
 const home=mkdtempSync(join(tmpdir(),'delivery-cache-'));
 writeFileSync(join(home,'model-catalog.json'),JSON.stringify({checkedAt:Date.now(),ids:[COMMODITY_MODEL,ROUTED_MODEL],prices:{[COMMODITY_MODEL]:{inputPerM:0.03,outputPerM:0.08,cacheReadPerM:null},[ROUTED_MODEL]:{inputPerM:0.09,outputPerM:0.24,cacheReadPerM:null}}}));
 const r=await run(task(0,{jev:{mode:'shadow'}}),true,{classify:modelGate('long-horizon',0.9),env:{JUNIOR_HOME:home,PI_CODING_AGENT_DIR:join(home,'empty-agent')}});
 assert.equal(approvalFile(r).price.outputRatio,3);
});
test('The model-approval request prefers cached online prices over the local catalog',async()=>{
 const home=mkdtempSync(join(tmpdir(),'delivery-cache-'));
 writeFileSync(join(home,'model-catalog.json'),JSON.stringify({checkedAt:Date.now(),ids:[COMMODITY_MODEL,ROUTED_MODEL],prices:{[COMMODITY_MODEL]:{inputPerM:0.03,outputPerM:0.08,cacheReadPerM:null},[ROUTED_MODEL]:{inputPerM:0.09,outputPerM:0.4,cacheReadPerM:null}}}));
 const agent=pricedAgent({[COMMODITY_MODEL]:{input:0.03,output:0.72},[ROUTED_MODEL]:{input:0.09,output:0.24}});
 const r=await run(task(0,{jev:{mode:'shadow'}}),true,{classify:modelGate('long-horizon',0.9),env:{JUNIOR_HOME:home,PI_CODING_AGENT_DIR:agent}});
 assert.equal(approvalFile(r).price.outputRatio,5);
});
test('The model-approval request explains how to decline and run on the default model',async()=>{
 const r=await run(task(0,{jev:{mode:'shadow'}}),true,{classify:modelGate('long-horizon',0.9)});
 assert.match(approvalFile(r).decline,/"modelProfile": "general"/);
});
test('A routed profile approved for the run applies the routed model',async()=>{
 const r=await run(task(0,{jev:{mode:'shadow'},approveModel:'long-horizon'}),true,{classify:modelGate('long-horizon',0.9)});
 assert.equal(r.receipt.requested.model,ROUTED_MODEL);
});
test('A routed profile approved for the run records the run approval source',async()=>{
 const r=await run(task(0,{jev:{mode:'shadow'},approveModel:'long-horizon'}),true,{classify:modelGate('long-horizon',0.9)});
 assert.equal(r.modelRouting.approval.source,'run');
});
test('A project-approved profile is applied with the project approval source',async()=>{
 const r=await run(task(0,{cwd:approvalCwd({approved:['long-horizon']}),jev:{mode:'shadow'}}),true,{classify:modelGate('long-horizon',0.9)});
 assert.equal(r.modelRouting.approval.source,'project');
});
test('A plan-approved profile is applied with the plan approval source',async()=>{
 const r=await run(task(0,{jev:{mode:'shadow'},approvedProfiles:['long-horizon']}),true,{classify:modelGate('long-horizon',0.9)});
 assert.equal(r.modelRouting.approval.source,'plan');
});
test('An explicit task model without approval stops for model approval',async()=>{
 const r=await run(task(0,{provider:'openrouter',model:ROUTED_MODEL}),true);
 assert.equal(r.status,'needs_model_approval');
});
test('An explicit task model can be approved by its matching profile id',async()=>{
 const r=await run(task(0,{provider:'openrouter',model:ROUTED_MODEL,approveModel:'long-horizon'}),true);
 assert.equal(r.receipt.requested.model,ROUTED_MODEL);
});
test('An explicit task model that is run-approved runs on that model',async()=>{
 const r=await run(task(0,{provider:'openrouter',model:ROUTED_MODEL,approveModel:'moonshotai/kimi-k2.7-code'}),true);
 assert.equal(r.receipt.requested.model,ROUTED_MODEL);
});
test('models.unapproved default runs on the default model',async()=>{
 const r=await run(task(0,{cwd:approvalCwd({unapproved:'default'}),jev:{mode:'shadow'}}),true,{classify:modelGate('long-horizon',0.9)});
 assert.equal(r.receipt.requested.model,COMMODITY_MODEL);
});
test('models.unapproved default records the declined recommendation',async()=>{
 const r=await run(task(0,{cwd:approvalCwd({unapproved:'default'}),jev:{mode:'shadow'}}),true,{classify:modelGate('long-horizon',0.9)});
 assert.equal(r.modelRouting.declined,true);
});
test('compactHandoff exposes the approval request for a blocked run',()=>{
 const request={profile:'long-horizon',provider:'openrouter',model:ROUTED_MODEL,defaultModel:COMMODITY_MODEL,confidence:0.9,strengths:'s',reason:'r',price:{from:null,to:null,inputRatio:null,outputRatio:null,pricier:null},approve:{run:'r',project:'p'}};
 assert.deepEqual(compactHandoff({status:'needs_model_approval',modelApproval:request}).model.approvalRequest,request);
});
test('compactHandoff exposes the applied model approval',()=>{
 const approval={source:'run',key:'long-horizon'};
 assert.deepEqual(compactHandoff({modelRouting:{approval}}).model.approval,approval);
});
test('compactHandoff passes the needs_model_approval outcome through',()=>{
 assert.equal(compactHandoff({status:'needs_model_approval'}).outcome,'needs_model_approval');
});
test('compactHandoff exposes the model routing record',()=>{
 const route={mode:'auto',eligible:true,profile:'long-horizon',confidence:0.9,applied:true,provider:'openrouter',model:ROUTED_MODEL,reason:'auto-routed'};
 assert.deepEqual(compactHandoff({modelRouting:route}).model.routing,route);
});
test('compactHandoff exposes the model policy record',()=>{
 const policy={provider:'anthropic',model:'claude-opus',class:'frontier',reason:'vendor anthropic is frontier',code:'frontier_model_refused'};
 assert.deepEqual(compactHandoff({modelPolicy:policy}).model.policy,policy);
});
test('compactHandoff exposes the retained output breakdown',()=>{
 const h=compactHandoff({outputBreakdown:{rawBytes:100,retainedBytes:40,byType:{message_update:60},largestToolResults:[{toolCallId:'c1',toolName:'bash',bytes:9}]}});
 assert.deepEqual(h.output,{rawBytes:100,retainedBytes:40,largestToolResults:[{toolCallId:'c1',toolName:'bash',bytes:9}]});
});
test('compactHandoff reports a null output breakdown when the result has none',()=>{
 assert.equal(compactHandoff({}).output,null);
});
test('CLI doctor needs no task file and exits nonzero when prerequisites fail',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-cli-'));
 const r=spawnSync(process.execPath,['worker.ts','doctor'],{encoding:'utf8',cwd:process.cwd(),env:{...process.env,PATH:'',HOME:cwd,PI_CODING_AGENT_DIR:join(cwd,'agent')}});
 assert.equal(r.status,1);
 const out=JSON.parse(r.stdout);
 assert.equal(out.command,'doctor');
 assert.equal(out.ok,false);
 assert.ok(Array.isArray(out.checks));
});
test('README documents WSL setup, commands, supported version, flags and paid-smoke opt-in',()=>{
 const md=documentation();
 assert.match(md,/doctor/);
 assert.match(md,/init --install/);
 assert.match(md,/\/login/);
 assert.match(md,/\/model/);
 assert.match(md,/22\.19/);
 assert.match(md,/paid smoke/i);
});
test('Init --install reuses the pinned tested version when Pi is currently absent',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-init-'));
 init(setupDeps(cwd,{installedPi:{name:PI_PACKAGE,version:'1.2.3'}}));
 const calls:any[]=[];
 const exec=(cmd:string,args:string[],opts:any)=>{calls.push({cmd,args,opts});return okExec(cmd,args);};
 const r:any=init(setupDeps(cwd,{execPath:join(cwd,'missing-node'),exec}),{install:true});
 assert.equal(r.install.spec,`${PI_PACKAGE}@${TESTED_PI_VERSION}`);
 const npm=calls.find((c)=>c.cmd==='npm');
 assert.deepEqual(npm.args,['install','-g','--ignore-scripts',`${PI_PACKAGE}@${TESTED_PI_VERSION}`]);
});

test('Doctor rejects empty saved credentials and a broken Pi executable',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-doc-'));
 const bin=withPiDir(cwd), agent=writeAgent(cwd,{auth:{openrouter:{type:'api_key',key:'  '}}});
 const d=doctor(setupDeps(cwd,{env:{PATH:bin,PI_CODING_AGENT_DIR:agent},exec:()=>({status:1,stdout:''})}));
 assert.equal(d.credentials.present,false);
 assert.equal(d.checks.find(c=>c.id==='pi')!.ok,false);
 assert.equal(d.ok,false);
});
test('Fresh init can install the pinned tested Pi without installed package metadata and rechecks readiness',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-init-'));
 const bin=join(cwd,'bin'); mkdirSync(bin,{recursive:true});
 const agent=writeAgent(cwd), calls:any[]=[];
 const deps=setupDeps(cwd,{installedPi:null,env:{PATH:bin,PI_CODING_AGENT_DIR:agent},execPath:join(bin,'node'),exec:(command:string,args:string[],opts:any)=>{
  calls.push({command,args,opts});
  if(command==='npm') writeFileSync(join(bin,'pi'),'#!/bin/sh\n');
  return okExec(command,args);
 }});
 const r=init(deps,{install:true});
 assert.equal(r.install!.ok,true);
 assert.equal(r.ready,true);
 assert.deepEqual(calls.find(c=>c.command==='npm').args,['install','-g','--ignore-scripts',`${PI_PACKAGE}@${TESTED_PI_VERSION}`]);
 const again=init(deps,{install:true});
 assert.equal(again.install!.attempted,false);
 assert.equal(calls.filter(c=>c.command==='npm').length,1);
 assert.ok(calls.filter(c=>c.command==='pi').every(c=>c.args.includes('--offline') && c.opts.env.PI_OFFLINE==='1'));
});
test('Doctor checks the configured provider and model',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-doc-'));
 const bin=withPiDir(cwd), agent=writeAgent(cwd,{auth:{deepseek:{type:'api_key',key:'secret'}},catalog:{deepseek:{models:[{id:'custom-model'}]}}});
 writeFileSync(join(cwd,'delivery.config.json'),JSON.stringify({provider:'deepseek',model:'custom-model'}));
 const d=doctor(setupDeps(cwd,{env:{PATH:bin,PI_CODING_AGENT_DIR:agent}}));
 assert.equal(d.ok,true);
 assert.equal(d.model.id,'custom-model');
 assert.equal(d.credentials.provider,'deepseek');
});

// --- J3 tool routing: trait questions, routed plan and tool_setup gate ---
test('The Jev readiness request carries one binary question per catalog trait',async()=>{
 let questions:any;
 const classifier:any=async({questions:q}:any)=>{questions=q;return {stopReason:'stop',answers:JEVPASS};};
 await assessPreflight(task(),classifier);
 const asked=Object.keys(questions).filter((k)=>k.startsWith('trait_')).map((k)=>k.slice('trait_'.length)).sort();
 assert.deepEqual(asked,[...loadPlaybooks().traits].sort());
});
test('A decided trait attaches a routed tool plan to the readiness attention',async()=>{
 const pre=await assessPreflight(task(),routingSeam({risky_change:0.95}));
 assert.ok(pre.attention.toolPlan?.tools.some((tool)=>tool.tool==='fmeca'));
});
test('The compact receipt carries the routed tool plan manager setup',async()=>{
 const r=await run(task(0,{jev:{mode:'shadow'}}),true,{classify:routingSeam({risky_change:0.95})});
 assert.ok(compactHandoff(r).attention?.toolPlan?.managerSetup.some((line)=>/FMECA/.test(line)));
});
test('A failed classifier yields a null tool plan on a continued shadow handoff',async()=>{
 const r=await run(task(0,{jev:{mode:'shadow'}}),true,{classify:outage});
 assert.equal(r.jev.preflight.attention.toolPlan,null);
});
test('The worker prompt includes tool routing directions when hopFrom is set',()=>{
 const prompt=buildPrompt(task(0,{hopFrom:'/tmp/handoff/hop.json'}),'test_first',null,null,null,null,routingPlan);
 assert.match(prompt,/junior tools call \/tmp\/handoff\/hop\.json fmeca/);
});
test('The worker prompt omits tool routing directions without hopFrom',()=>{
 const prompt=buildPrompt(task(0,{}),'test_first',null,null,null,null,routingPlan);
 assert.ok(!prompt.includes('Tool routing directions'));
});
test('Enforce mode with a required tool and no hopFrom returns the tool_setup clarify trigger',async()=>{
 const r=await run(task(0,{jev:{mode:'enforce'}}),false,{classify:routingSeam({risky_change:0.95}),spawnPi:()=>({status:0,stdout:stream('stop')})});
 assert.equal(r.jev.preflight.attention.trigger,'tool_setup');
});
test('Enforce mode with a required tool and no hopFrom does not start the worker',async()=>{
 let started=0;
 await run(task(0,{jev:{mode:'enforce'}}),false,{classify:routingSeam({risky_change:0.95}),spawnPi:()=>{started+=1;return {status:0,stdout:stream('stop')};}});
 assert.equal(started,0);
});
test('The readiness request omits trait questions when they would exceed the per-call limit',async()=>{
 let questions:any;
 const classifier:any=async({questions:q}:any)=>{questions=q;return {stopReason:'stop',answers:JEVPASS};};
 await assessPreflight(task(),classifier,{maxQuestions:3});
 assert.equal(Object.keys(questions).filter((k)=>k.startsWith('trait_')).length,0);
});

// --- sticky per-deliverable model routing ----------------------------------
test('A run writes a sticky route record for its task id',async()=>{
 const cwd=stickyCwd();
 await run(task(0,{cwd}),true);
 assert.equal(existsSync(join(cwd,'.delivery','smoke','route.json')),true);
});
test('The sticky route record names the model the run used',async()=>{
 const cwd=stickyCwd();
 await run(task(0,{cwd,jev:{mode:'shadow'},approveModel:'long-horizon'}),true,{classify:modelGate('long-horizon',0.9)});
 assert.equal(stickyFile(cwd).model,ROUTED_MODEL);
});
test('The sticky route record carries the approval that allowed the model',async()=>{
 const cwd=stickyCwd();
 await run(task(0,{cwd,jev:{mode:'shadow'},approveModel:'long-horizon'}),true,{classify:modelGate('long-horizon',0.9)});
 assert.deepEqual(stickyFile(cwd).approval,{source:'run',key:'long-horizon'});
});
test('A second run with the same id reuses the approved routed model',async()=>{
 const cwd=stickyCwd();
 await run(task(0,{cwd,jev:{mode:'shadow'},approveModel:'long-horizon'}),true,{classify:modelGate('long-horizon',0.9)});
 const r=await run(task(0,{cwd,jev:{mode:'shadow'},approveModel:'long-horizon'}),true,{classify:modelGate('long-horizon',0.9)});
 assert.equal(r.receipt.requested.model,ROUTED_MODEL);
});
test('A second run with the same id is not asked a model_profile question',async()=>{
 const cwd=stickyCwd();
 await run(task(0,{cwd,jev:{mode:'shadow'},approveModel:'long-horizon'}),true,{classify:modelGate('long-horizon',0.9)});
 let preflight:any;
 const classifier:any=async({questions:q}:any)=>{if(Object.prototype.hasOwnProperty.call(q,'contract_clear'))preflight=q;return {stopReason:'stop',answers:JEVPASS};};
 await run(task(0,{cwd,jev:{mode:'shadow'},approveModel:'long-horizon'}),true,{classify:classifier});
 assert.equal(Object.prototype.hasOwnProperty.call(preflight,'model_profile'),false);
});
test('The sticky reuse is recorded as not eligible for re-routing',async()=>{
 const cwd=stickyCwd();
 await run(task(0,{cwd,jev:{mode:'shadow'},approveModel:'long-horizon'}),true,{classify:modelGate('long-horizon',0.9)});
 const r=await run(task(0,{cwd,jev:{mode:'shadow'},approveModel:'long-horizon'}),true,{classify:modelGate('long-horizon',0.9)});
 assert.equal(r.modelRouting.eligible,false);
});
test('The sticky reuse reports the sticky reason',async()=>{
 const cwd=stickyCwd();
 await run(task(0,{cwd,jev:{mode:'shadow'},approveModel:'long-horizon'}),true,{classify:modelGate('long-horizon',0.9)});
 const r=await run(task(0,{cwd,jev:{mode:'shadow'},approveModel:'long-horizon'}),true,{classify:modelGate('long-horizon',0.9)});
 assert.match(r.modelRouting.reason,/^sticky:/);
});
test('The sticky reuse marks the routed model as applied',async()=>{
 const cwd=stickyCwd();
 await run(task(0,{cwd,jev:{mode:'shadow'},approveModel:'long-horizon'}),true,{classify:modelGate('long-horizon',0.9)});
 const r=await run(task(0,{cwd,jev:{mode:'shadow'},approveModel:'long-horizon'}),true,{classify:modelGate('long-horizon',0.9)});
 assert.equal(r.modelRouting.applied,true);
});
test('The sticky record is ignored when its approval was revoked',async()=>{
 const cwd=stickyCwd();
 await run(task(0,{cwd,jev:{mode:'shadow'},approveModel:'long-horizon'}),true,{classify:modelGate('long-horizon',0.9)});
 const r=await run(task(0,{cwd,jev:{mode:'shadow'}}),true,{classify:modelGate('long-horizon',0.9)});
 assert.equal(r.status,'needs_model_approval');
});
test('A contract modelProfile without approval stops with needs_model_approval',async()=>{
 const r=await run(task(0,{modelProfile:'long-horizon'}),true);
 assert.equal(r.status,'needs_model_approval');
});
test('A contract modelProfile approved for the run applies the pinned model',async()=>{
 const r=await run(task(0,{modelProfile:'long-horizon',approveModel:'long-horizon'}),true);
 assert.equal(r.receipt.requested.model,ROUTED_MODEL);
});

test('The affinity key never contains the deliverable id',()=>{
 assert.equal(affinityKeyFor('/project','secret-feature-name').includes('secret-feature-name'),false);
});
test('Compact cost treats an unpriced zero from a non-OpenRouter provider as unknown',()=>{
 const h=compactHandoff(handoffResult({receipt:{requested:{provider:'litellm',model:'deepseek/deepseek-v4.1-flash'},usage:{totalTokens:1200}},cost:{billedUsd:null,estimatedUsd:null,piReported:{total:0,available:true}}}));
 assert.equal(h.model.cost.available,false);
});
test('Compact cost names the missing Pi pricing for an unpriced zero',()=>{
 const h=compactHandoff(handoffResult({receipt:{requested:{provider:'litellm',model:'deepseek/deepseek-v4.1-flash'},usage:{totalTokens:1200}},cost:{billedUsd:null,estimatedUsd:null,piReported:{total:0,available:true}}}));
 assert.match(String(h.model.cost.unknownReason),/provider litellm reported 0 for 1200 tokens/);
});
test('Compact cost keeps a reported zero from OpenRouter as a known free cost',()=>{
 const h=compactHandoff(handoffResult({receipt:{requested:{provider:'openrouter',model:'deepseek/deepseek-v4.1-flash:free'},usage:{totalTokens:1200}},cost:{billedUsd:null,estimatedUsd:null,piReported:{total:0,available:true}}}));
 assert.equal(h.model.cost.amountUsd,0);
});
test('Typesafe classifier includes the API error text on a non-2xx response',async()=>{
 const res={ok:false,status:400,json:async()=>({}),text:async()=>'{"error":"unknown model jev-1.13"}'};
 const classifier=createTypesafeClassifier(typesafeGateway,captureFetch(res).impl);
 assert.match((await classifier({state:{},questions:{}})).errorMessage,/HTTP 400: .*unknown model/);
});
test('Typesafe classifier redacts the key if the API echoes it',async()=>{
 const res={ok:false,status:401,json:async()=>({}),text:async()=>'bad key ts-secret-key'};
 const classifier=createTypesafeClassifier(typesafeGateway,captureFetch(res).impl);
 assert.doesNotMatch((await classifier({state:{},questions:{}})).errorMessage,/ts-secret-key/);
});


