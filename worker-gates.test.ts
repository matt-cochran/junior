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

// --- offline Jev classifier mocks: no SDK load, no paid calls ---
test('Reject incomplete contract',()=>assert.throws(()=>validate({id:'x'})));
test('Reject invalid jev mode',()=>assert.throws(()=>validate({...task(),jev:{mode:'bogus'}}),/Invalid jev.mode/));
test('Jev config defaults off',()=>{
 assert.equal(jevMode(task()),'off');
 assert.equal(jevMode({jev:{mode:'shadow'}}),'shadow');
 assert.equal(jevMode({jev:{mode:'enforce'}}),'enforce');
 assert.equal(jevMode({jev:{mode:'off'}}),'off');
});
test('Independent check passes simulation',async()=>{const r=await run(task(),true);assert.equal(r.status,'simulation_passed');assert.equal(r.simulated,true);});
test('Failed check prevents success',async()=>assert.equal((await run(task(1),true)).status,'checks_failed'));
test('Status reports saved successful run',()=>{const r=cli(['status',resultFile(saved('ready_for_review'))]);assert.equal(r.status,0);const o=JSON.parse(r.stdout);assert.equal(o.id,'smoke');assert.equal(o.outcome,'ready_for_review');assert.deepEqual(o.checks,saved('ready_for_review').checks);assert.equal(o.artifactDir,'/tmp/artifact');assert.equal(o.receipt,undefined);});
test('Status reports saved failed run',()=>{const r=cli(['status',resultFile(saved('checks_failed'))]);assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).outcome,'checks_failed');});
test('Status rejects missing file',()=>{const r=cli(['status',join(tmpdir(),'delivery-missing-'+Date.now()+'.json')]);assert.notEqual(r.status,0);assert.match(r.stderr,/Cannot read result file/);});
test('Status rejects invalid JSON',()=>{const r=cli(['status',resultFile('{not json')]);assert.notEqual(r.status,0);assert.match(r.stderr,/Invalid JSON/);});
test('Status rejects malformed result',()=>{const r=cli(['status',resultFile({id:'x'})]);assert.notEqual(r.status,0);assert.match(r.stderr,/Malformed result/);});
test('Status exposes receipt when present',()=>{const receipt=mockReceipt({provider:'openrouter',model:'m'});const r=cli(['status',resultFile({...saved('simulation_passed'),receipt})]);assert.equal(r.status,0);const o=JSON.parse(r.stdout);assert.equal(o.receipt.source,'mock');assert.equal(o.receipt.requested.model,'m');});

test('Parser dedupes repeated observed events and sums usage',()=>{
 const r=parseReceipt(stream({type:'session',id:'sess-1'},assistant(),assistant(),{type:'agent_settled'}),{provider:'openrouter',model:COMMODITY_MODEL});
 assert.equal(r.sessionId,'sess-1');
 assert.equal(r.assistantMessages,2);
 assert.deepEqual(r.observed,[{provider:'openrouter',model:'m'}]);
 assert.equal(r.observedUnknown,false);
 assert.equal(r.usage.input,2);
 assert.equal(r.usage.output,4);
 assert.equal(r.usage.totalTokens,6);
 assert.equal(r.settled,true);
 assert.equal(receiptValid(r),true);
});
test('Parser records multiple unique provider/model pairs',()=>{
 const r=parseReceipt(stream(assistant(),assistant({provider:'anthropic',model:'claude'}),{type:'agent_settled'}));
 assert.deepEqual(r.observed,[{provider:'openrouter',model:'m'},{provider:'anthropic',model:'claude'}]);
 assert.equal(r.usage.totalTokens,6);
});
test('Parser marks missing observed metadata as unknown',()=>{
 const r=parseReceipt(stream(assistant({provider:undefined,model:undefined}),{type:'agent_settled'}));
 assert.deepEqual(r.observed,[{provider:'unknown',model:'unknown'}]);
 const none=parseReceipt(stream({type:'session',id:'s'},{type:'agent_settled'}));
 assert.deepEqual(none.observed,[]);
 assert.equal(none.observedUnknown,true);
});
test('Parser ignores turn_end, agent_end and message_update usage',()=>{
 const streamText=stream(
  {type:'session',id:'s'},
  assistant(),
  {type:'turn_end',message:{role:'assistant',usage:U(100,100,200)},toolResults:[]},
  {type:'agent_end',messages:[{role:'assistant',usage:U(100,100,200)}],willRetry:false},
  {type:'message_update',usage:U(100,100,200),assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'x'}},
  {type:'agent_settled'});
 const r=parseReceipt(streamText);
 assert.equal(r.usage.input,1);
 assert.equal(r.usage.output,2);
 assert.equal(r.usage.totalTokens,3);
});
test('Parser surfaces malformed JSONL and keeps valid records',()=>{
 const r=parseReceipt(stream({type:'session',id:'s'},'{not json',assistant(),{type:'agent_settled'}));
 assert.equal(r.malformed,true);
 assert.deepEqual(r.malformedLines,[2]);
 assert.equal(r.sessionId,'s');
 assert.equal(r.settled,true);
 assert.equal(receiptValid(r),false);
});
test('Parser flags error, aborted and missing settlement',()=>{
 const errored=parseReceipt(stream(assistant({stopReason:'error'}),{type:'agent_settled'}));
 assert.equal(errored.errored,true);
 assert.equal(receiptValid(errored),false);
 const aborted=parseReceipt(stream(assistant({stopReason:'aborted'}),{type:'agent_settled'}));
 assert.equal(aborted.aborted,true);
 assert.equal(receiptValid(aborted),false);
 const unsettled=parseReceipt(stream(assistant()));
 assert.equal(unsettled.settled,false);
 assert.equal(receiptValid(unsettled),false);
});
test('Parser counts an error recovered by a later assistant message',()=>{
 const r=parseReceipt(stream(assistant({stopReason:'error'}),assistant({stopReason:'toolUse'}),assistant(),{type:'agent_settled'}));
 assert.equal(r.recoveredErrors,1);
});
test('Parser accepts a settled stream whose recovered error was followed cleanly',()=>{
 const r=parseReceipt(stream(assistant({stopReason:'error'}),assistant({stopReason:'toolUse'}),assistant(),{type:'agent_settled'}));
 assert.equal(receiptValid(r),true);
});
test('Parser marks a final length stop as output-limited',()=>{
 const r=parseReceipt(stream(assistant(),assistant({stopReason:'length'}),{type:'agent_settled'}));
 assert.equal(r.outputLimited,true);
});
test('Parser rejects a settled stream whose final message hit the length limit',()=>{
 const r=parseReceipt(stream(assistant(),assistant({stopReason:'length'}),{type:'agent_settled'}));
 assert.equal(receiptValid(r),false);
});
test('Mock receipt never claims an observed model',async()=>{
 const r=mockReceipt({provider:'openrouter',model:'requested-model'});
 assert.equal(r.source,'mock');
 assert.deepEqual(r.observed,[]);
 assert.equal(r.observedUnknown,true);
 assert.equal(r.requested.model,'requested-model');
 const runResult=await run(task(),true);
 assert.equal(runResult.receipt.source,'mock');
 assert.deepEqual(runResult.receipt.observed,[]);
 assert.equal(receiptValid(runResult.receipt),false);
});

test('Empty usage is explicitly unavailable, not free',()=>{
 const u=emptyUsage();
 assert.equal(u.available,false);
 assert.equal(u.cost.available,false);
});
test('Receipt exposes usage and cost availability separately',()=>{
 // usage + cost reported
 const withCost=parseReceipt(stream(assistant(),{type:'agent_settled'}));
 assert.equal(withCost.usage.available,true);
 assert.equal(withCost.usage.cost.available,true);
 // usage reported, cost absent: must not masquerade as free
 const noCost=parseReceipt(stream(
  JSON.stringify({type:'message_end',message:{role:'assistant',provider:'openrouter',model:'m',usage:{input:1,output:2,totalTokens:3},stopReason:'stop'}}),
  {type:'agent_settled'}));
 assert.equal(noCost.usage.available,true);
 assert.equal(noCost.usage.cost.available,false);
 assert.equal(noCost.usage.cost.total,0);
 // an empty cost object is not a report
 const emptyCost=parseReceipt(stream(
  JSON.stringify({type:'message_end',message:{role:'assistant',provider:'openrouter',model:'m',usage:{input:1,cost:{}},stopReason:'stop'}}),
  {type:'agent_settled'}));
 assert.equal(emptyCost.usage.cost.available,false);
 // no usage at all
 const none=parseReceipt(stream({type:'session',id:'s'},{type:'agent_settled'}));
 assert.equal(none.usage.available,false);
 assert.equal(none.usage.cost.available,false);
});
test('Settled stream with no assistant messages is rejected',()=>{
 const r=parseReceipt(stream({type:'session',id:'s'},{type:'message_end',message:{role:'user'}},{type:'agent_settled'}));
 assert.equal(r.settled,true);
 assert.equal(r.assistantMessages,0);
 assert.equal(receiptValid(r),false);
});

test('Missing classifier catalog entry is supplied explicitly',()=>{
 const found=resolveClassifierModel({getModelOfType:()=>({provider:'openrouter',id:'typesafe/jev-1.13'})});
 assert.equal(found.explicit,false);
 const missing=resolveClassifierModel({getModelOfType:()=>undefined});
 assert.equal(missing.explicit,true);
 assert.deepEqual(missing.model,{provider:'openrouter',id:'typesafe/jev-1.13'});
});

// --- Jev gateway classifier (ADR-0006): injected fetch and Pi factory only ---
test('Typesafe classifier posts to the systemone endpoint',async()=>{
 const {calls,impl}=captureFetch(jsonFetch({answers:{},usage:{}}));
 await createTypesafeClassifier(typesafeGateway,impl)({state:{},questions:{}});
 assert.equal(calls[0].url,'https://api.typesafe.ai/v1/systemone');
});
test('Typesafe classifier sends the bearer authorization header',async()=>{
 const {calls,impl}=captureFetch(jsonFetch({answers:{},usage:{}}));
 await createTypesafeClassifier(typesafeGateway,impl)({state:{},questions:{}});
 assert.equal(calls[0].init.headers.authorization,'Bearer ts-secret-key');
});
test('Typesafe classifier sends a bool question as the System One noul type',async()=>{
 const {calls,impl}=captureFetch(jsonFetch({answers:{},usage:{}}));
 const state={deliverable:'x'};const questions={AC1:{type:'bool',instructions:'y'}};
 await createTypesafeClassifier(typesafeGateway,impl)({state,questions});
 assert.deepEqual(JSON.parse(calls[0].init.body),{state,model:'jev-latest',questions:{AC1:{type:'noul',instructions:'y'}}});
});
test('Typesafe classifier sends a choice question unchanged',async()=>{
 const {calls,impl}=captureFetch(jsonFetch({answers:{},usage:{}}));
 const questions={W:{type:'choice',instructions:'y',criteria:{a:'A',b:'B'}}};
 await createTypesafeClassifier(typesafeGateway,impl)({state:{},questions});
 assert.deepEqual(JSON.parse(calls[0].init.body).questions,questions);
});
test('Typesafe classifier passes the abort signal through',async()=>{
 const {calls,impl}=captureFetch(jsonFetch({answers:{},usage:{}}));
 const controller=new AbortController();
 await createTypesafeClassifier(typesafeGateway,impl)({state:{},questions:{}},{signal:controller.signal});
 assert.equal(calls[0].init.signal,controller.signal);
});
test('Typesafe classifier reports the typesafe provider on success',async()=>{
 const classifier=createTypesafeClassifier(typesafeGateway,captureFetch(jsonFetch({answers:{},usage:{}})).impl);
 assert.equal((await classifier({state:{},questions:{}})).provider,'typesafe');
});
test('Typesafe classifier reports the gateway model id on success',async()=>{
 const classifier=createTypesafeClassifier(typesafeGateway,captureFetch(jsonFetch({answers:{},usage:{}})).impl);
 assert.equal((await classifier({state:{},questions:{}})).model,'jev-latest');
});
test('Typesafe classifier maps a noul answer to a bool probability',async()=>{
 const classifier=createTypesafeClassifier(typesafeGateway,captureFetch(jsonFetch({answers:{AC1:{type:'noul',noul:0.9}},usage:{}})).impl);
 assert.deepEqual((await classifier({state:{},questions:{}})).answers,{AC1:{type:'bool',probability:0.9}});
});
test('Typesafe classifier maps System One token usage',async()=>{
 const classifier=createTypesafeClassifier(typesafeGateway,captureFetch(jsonFetch({answers:{},usage:{input_tokens:10,output_tokens:4}})).impl);
 assert.deepEqual((await classifier({state:{},questions:{}})).usage,{input:10,output:4,totalTokens:14});
});
test('Typesafe classifier names the HTTP status on a non-2xx response',async()=>{
 const classifier=createTypesafeClassifier(typesafeGateway,captureFetch(jsonFetch({},500)).impl);
 assert.match((await classifier({state:{},questions:{}})).errorMessage,/HTTP 500/);
});
test('Typesafe classifier failure never exposes the gateway key',async()=>{
 const classifier=createTypesafeClassifier(typesafeGateway,captureFetch(jsonFetch({},401)).impl);
 assert.doesNotMatch((await classifier({state:{},questions:{}})).errorMessage,/ts-secret-key/);
});
test('createJevClassifier auto with only an openrouter key uses the Pi path',async()=>{
 let def:any;
 const pi:any=async(modelDef:any)=>{def=modelDef;return stubClassifier(modelDef);};
 await createJevClassifier('auto',{gateway:{env:{OPENROUTER_API_KEY:'or-key'},readAuthFile:()=>'{}'},pi});
 assert.deepEqual(def,{provider:'openrouter',id:'typesafe/jev-1.13'});
});
test('createJevClassifier auto with only an openrouter key reports the openrouter gateway',async()=>{
 const pi:any=async(modelDef:any)=>stubClassifier(modelDef);
 const resolved=await createJevClassifier('auto',{gateway:{env:{OPENROUTER_API_KEY:'or-key'},readAuthFile:()=>'{}'},pi});
 assert.equal(resolved.gateway,'openrouter');
});
test('createJevClassifier auto with a typesafe key returns the direct HTTP classifier',async()=>{
 const {impl}=captureFetch(jsonFetch({answers:{},usage:{}}));
 const resolved=await createJevClassifier('auto',{gateway:{env:{TYPESAFE_JEV_API_KEY:'ts-key'},readAuthFile:()=>'{}'},fetch:impl});
 assert.equal(resolved.gateway,'typesafe');
});
test('createJevClassifier with explicit typesafe and no key rejects with GatewayError',async()=>{
 try {
  await createJevClassifier('typesafe',{gateway:{env:{OPENROUTER_API_KEY:'or-key'},readAuthFile:()=>'{}'}});
  assert.fail('expected createJevClassifier to reject');
 } catch (error) {
  assert.ok(error instanceof GatewayError);
 }
});
test('createJevClassifier missing key rejection carries jev_provider_key_missing',async()=>{
 try {
  await createJevClassifier('typesafe',{gateway:{env:{OPENROUTER_API_KEY:'or-key'},readAuthFile:()=>'{}'}});
  assert.fail('expected createJevClassifier to reject');
 } catch (error) {
  assert.equal((error as GatewayError).code,'jev_provider_key_missing');
 }
});
test('validate rejects an unknown jev.provider naming the allowed values',()=>{
 assert.throws(()=>validate({...task(),jev:{mode:'shadow',provider:'litellm'}}),/auto, openrouter or typesafe/);
});
test('Run records the openrouter gateway when Jev resolves through Pi',async()=>{
 const spawnPi=()=>({status:0,stdout:stream({type:'session',id:SESSION_A},assistant(),{type:'agent_settled'}),stderr:''});
 const jevPi:any=async(modelDef:any)=>stubClassifier(modelDef);
 const r=await run(task(0,{jev:{mode:'shadow'}}),false,{spawnPi,jevPi,gateway:{env:{OPENROUTER_API_KEY:'or-key'},readAuthFile:()=>'{}'}});
 assert.equal(r.jev.gateway,'openrouter');
});
test('Run records the gateway Jev model id in the jev record',async()=>{
 const spawnPi=()=>({status:0,stdout:stream({type:'session',id:SESSION_A},assistant(),{type:'agent_settled'}),stderr:''});
 const jevPi:any=async(modelDef:any)=>stubClassifier(modelDef);
 const r=await run(task(0,{jev:{mode:'shadow'}}),false,{spawnPi,jevPi,gateway:{env:{OPENROUTER_API_KEY:'or-key'},readAuthFile:()=>'{}'}});
 assert.equal(r.jev.model.id,'typesafe/jev-1.13');
});
test('Git diff evidence is bounded and unavailable outside a repo',()=>{
 const b=boundEvidence('stat','0123456789',4);
 assert.equal(b.diff,'0123');
 assert.equal(b.truncated,true);
 assert.equal(b.stat,'stat');
 const n=boundEvidence('','',10,'not a repo');
 assert.equal(n.unavailable,'not a repo');
 const g=boundedGitEvidence(mkdtempSync(join(tmpdir(),'delivery-')),10);
 assert.ok(g.unavailable,'non-repo git diff should be unavailable');
 assert.ok(g.diff.length<=10);
});

test('Shadow records a blocking preflight and continues',async()=>{
 const classifier=gateClassifier({contract_clear:bool(0.2),blocking_assumptions:bool(0.9)},{AC1:bool(0.9)});
 const r=await run(task(0,{jev:{mode:'shadow'}}),true,{classify:classifier});
 assert.equal(r.status,'simulation_passed');
 assert.equal(r.jev.mode,'shadow');
 assert.equal(r.jev.attempted,true);
 assert.equal(r.jev.preflight.status,'block');
 assert.equal(r.jev.enforced,false);
 assert.equal(r.jev.postflight.status,'pass');
 assert.equal(r.jev.model.id,'typesafe/jev-1.13');
 assert.equal(r.jev.preflight.answers.contract_clear.type,'bool');
});
test('Enforce blocks readiness before the worker on an unclear contract',async()=>{
 const classifier=gateClassifier({contract_clear:bool(0.1),blocking_assumptions:bool(0.95)});
 const r=await run(task(0,{jev:{mode:'enforce'}}),true,{classify:classifier});
 assert.equal(r.status,'needs_review');
 assert.equal(r.jev.preflight.status,'block');
 assert.equal(r.jev.enforced,true);
 assert.deepEqual(r.checks,[]);
 assert.equal(r.jev.postflight,undefined);
});
test('Enforce marks needs_review on a postflight gap',async()=>{
 const classifier=gateClassifier(JEVPASS,{AC1:bool(0.1)});
 const r=await run(task(0,{jev:{mode:'enforce'}}),true,{classify:classifier});
 assert.equal(r.status,'needs_review');
 assert.equal(r.jev.preflight.status,'pass');
 assert.equal(r.jev.postflight.status,'gaps');
 assert.deepEqual(r.jev.postflight.gapIds,['AC1']);
 assert.equal(r.jev.postflight.criteria[0].verdict,'gap');
});
test('Enforce keeps a passing run when gates pass',async()=>{
 const classifier=gateClassifier(JEVPASS,{AC1:bool(0.95)});
 const r=await run(task(0,{jev:{mode:'enforce'}}),true,{classify:classifier});
 assert.equal(r.status,'simulation_passed');
 assert.equal(r.jev.preflight.status,'pass');
 assert.equal(r.jev.postflight.status,'pass');
 assert.equal(r.jev.enforced,false);
 assert.deepEqual(r.jev.postflight.gapIds,[]);
});
test('Gate outage is uncertain and recorded without upgrading',async()=>{
 const enforced=await run(task(0,{jev:{mode:'enforce'}}),true,{classify:outage});
 assert.equal(enforced.status,'needs_review');
 assert.equal(enforced.jev.preflight.status,'uncertain');
 assert.match(enforced.jev.error,/outage/);
 const shadow=await run(task(0,{jev:{mode:'shadow'}}),true,{classify:outage});
 assert.equal(shadow.status,'simulation_passed');
 assert.equal(shadow.jev.preflight.status,'uncertain');
 assert.equal(shadow.jev.postflight.status,'uncertain');
 assert.match(shadow.jev.postflight.error,/outage/);
});
test('Low-confidence gate answers are uncertain',async()=>{
 const classifier=gateClassifier({contract_clear:bool(0.5),blocking_assumptions:bool(0.5)},{AC1:bool(0.5)});
 const r=await run(task(0,{jev:{mode:'enforce'}}),true,{classify:classifier});
 assert.equal(r.status,'needs_review');
 assert.equal(r.jev.preflight.status,'uncertain');
});
test('Passing gates cannot override failed checks',async()=>{
 const classifier=gateClassifier(JEVPASS,{AC1:bool(0.99)});
 const r=await run(task(1,{jev:{mode:'enforce'}}),true,{classify:classifier});
 assert.equal(r.status,'checks_failed');
 assert.equal(r.jev.preflight.status,'pass');
 assert.equal(r.jev.enforced,false);
});
test('Postflight receives checks and bounded git evidence; usage recorded',async()=>{
 let postState:any;
 const classifier:any=async({state,questions}:any)=>{
  if(!Object.prototype.hasOwnProperty.call(questions,'contract_clear')) postState=state;
  const isPre=Object.prototype.hasOwnProperty.call(questions,'contract_clear');
  return {stopReason:'stop',provider:'openrouter',model:'typesafe/jev-1.13',answers:isPre?JEVPASS:{AC1:bool(0.99)},usage:gateUsage};
 };
 const git={stat:'1 file changed',diff:'x'.repeat(50),truncated:true};
 const r=await run(task(0,{jev:{mode:'shadow'}}),true,{classify:classifier,git});
 assert.equal(r.jev.postflight.usage.available,true);
 assert.equal(r.jev.postflight.usage.cost.available,true);
 assert.equal(r.jev.postflight.usage.cost.total,0.0002);
 assert.equal(r.jev.postflight.usage.input,5);
 assert.equal(r.jev.postflight.answers.AC1.type,'bool');
 assert.equal(r.jev.postflight.reportedModel,'typesafe/jev-1.13');
 assert.equal(r.jev.preflight.reportedProvider,'openrouter');
 assert.equal(postState.git.truncated,true);
 assert.equal(postState.git.diff.length,50);
 assert.equal(postState.checks[0].passed,true);
});
test('Multiple acceptance criteria yield actionable criterion IDs',async()=>{
 const t=task(0,{acceptance:['First holds','Second holds'],jev:{mode:'shadow'}});
 const classifier=gateClassifier(JEVPASS,{AC1:bool(0.95),AC2:bool(0.05)});
 const r=await run(t,true,{classify:classifier});
 assert.deepEqual(r.jev.postflight.gapIds,['AC2']);
 assert.deepEqual(r.jev.postflight.uncertainIds,[]);
 assert.equal(r.jev.postflight.criteria.length,2);
 assert.equal(r.jev.postflight.status,'gaps');
});
test('Mock run without injected classifier skips gates and records why',async()=>{
 const shadow=await run(task(0,{jev:{mode:'shadow'}}),true);
 assert.equal(shadow.status,'simulation_passed');
 assert.equal(shadow.jev.attempted,false);
 assert.match(shadow.jev.skipped,/classifier/);
 // enforce cannot verify without a gate result, so it does not claim ready
 const enforced=await run(task(0,{jev:{mode:'enforce'}}),true);
 assert.equal(enforced.status,'needs_review');
 assert.equal(enforced.jev.attempted,false);
 assert.equal(enforced.jev.enforced,true);
});
test('Status exposes jev gate records when present',()=>{
 const jev={mode:'shadow',attempted:true,enforced:false,model:{provider:'openrouter',id:'typesafe/jev-1.13'}};
 const r=cli(['status',resultFile({...saved('simulation_passed'),jev})]);
 assert.equal(r.status,0);
 const o=JSON.parse(r.stdout);
 assert.equal(o.jev.mode,'shadow');
});

// --- Jev attention field resolution (issue #11/#18) ---
test('Delegate attention names the frontier question as its trigger',async()=>{
 const pre=await assessPreflight(task(),gateClassifier(JEVPASS));
 assert.equal(pre.attention.trigger,'requires_frontier');
});
test('Clarify attention from an unclear contract names the contract_clear question',async()=>{
 const pre=await assessPreflight(task(),gateClassifier({requires_frontier:bool(0.05),contract_clear:bool(0.2),blocking_assumptions:bool(0.05)}));
 assert.equal(pre.attention.trigger,'contract_clear');
});
test('Clarify attention from an unclear contract carries the contract_clear probability',async()=>{
 const pre=await assessPreflight(task(),gateClassifier({requires_frontier:bool(0.05),contract_clear:bool(0.41),blocking_assumptions:bool(0.05)}));
 assert.equal(pre.attention.probability,0.41);
});
test('Clarify attention from a blocking assumption names the blocking_assumptions question',async()=>{
 const pre=await assessPreflight(task(),gateClassifier({requires_frontier:bool(0.05),contract_clear:bool(0.95),blocking_assumptions:bool(0.83)}));
 assert.equal(pre.attention.trigger,'blocking_assumptions');
});
test('Clarify attention from a blocking assumption carries the blocking_assumptions probability',async()=>{
 const pre=await assessPreflight(task(),gateClassifier({requires_frontier:bool(0.05),contract_clear:bool(0.95),blocking_assumptions:bool(0.83)}));
 assert.equal(pre.attention.probability,0.83);
});
test('Attention reports every classifier question probability',async()=>{
 const pre=await assessPreflight(task(),gateClassifier(JEVPASS));
 assert.deepEqual(pre.attention.probabilities,{requires_frontier:0.05,contract_clear:0.95,blocking_assumptions:0.05});
});
test('Attention reports the confidence threshold',async()=>{
 const pre=await assessPreflight(task(),gateClassifier(JEVPASS));
 assert.equal(pre.attention.threshold,0.6);
});
test('Classifier failure marks the attention trigger as error',async()=>{
 const pre=await assessPreflight(task(),outage);
 assert.equal(pre.attention.trigger,'error');
});
test('Clarify reason cites the contract_clear probability against the real threshold',async()=>{
 const pre=await assessPreflight(task(),gateClassifier({requires_frontier:bool(0.05),contract_clear:bool(0.41),blocking_assumptions:bool(0.05)}));
 assert.equal(pre.attention.reason,'contract not judged clear: P(contract_clear)=0.41 < 0.6');
});
test('Compact receipt exposes the attention trigger',async()=>{
 const classifier=gateClassifier({requires_frontier:bool(0.05),contract_clear:bool(0.2),blocking_assumptions:bool(0.05)});
 const r=await run(task(0,{jev:{mode:'shadow'}}),true,{classify:classifier});
 assert.equal(compactHandoff(r).attention.trigger,'contract_clear');
});

test('The readiness request asks which contract part is least clear',async()=>{
 let questions:any;
 const classifier:any=async({questions:q}:any)=>{questions=q;return {stopReason:'stop',answers:JEVPASS};};
 await assessPreflight(task(),classifier);
 assert.deepEqual(Object.keys(questions.contract_part.criteria),[...CONTRACT_PARTS]);
});
test('A blocking-assumption clarify names the classifier contract part',async()=>{
 const pre=await assessPreflight(task(),gateClassifier({requires_frontier:bool(0.05),contract_clear:bool(0.95),blocking_assumptions:bool(0.83),contract_part:choice('constraints',0.9)}));
 assert.equal(pre.attention.part?.name,'constraints');
});
test('A blocking-assumption clarify quotes the constraints as an excerpt',async()=>{
 const t=task(0,{constraints:['Use Node only']});
 const pre=await assessPreflight(t,gateClassifier({requires_frontier:bool(0.05),contract_clear:bool(0.95),blocking_assumptions:bool(0.83),contract_part:choice('constraints',0.9)}));
 assert.equal(pre.attention.excerpt,'Use Node only');
});
test('A contract-clear clarify carries at least one question',async()=>{
 const pre=await assessPreflight(task(),gateClassifier({requires_frontier:bool(0.05),contract_clear:bool(0.2),blocking_assumptions:bool(0.05),contract_part:choice('acceptance',0.9)}));
 assert.ok((pre.attention.questions?.length ?? 0)>=1);
});
test('An unanswered contract part falls back to acceptance',async()=>{
 const pre=await assessPreflight(task(),gateClassifier({requires_frontier:bool(0.05),contract_clear:bool(0.2),blocking_assumptions:bool(0.05)}));
 assert.deepEqual(pre.attention.part,{name:'acceptance',probability:null});
});
test('An unanswered contract part still yields a clarify question',async()=>{
 const pre=await assessPreflight(task(),gateClassifier({requires_frontier:bool(0.05),contract_clear:bool(0.2),blocking_assumptions:bool(0.05)}));
 assert.ok((pre.attention.questions?.length ?? 0)>=1);
});
test('A delegate attention carries no clarify detail fields',async()=>{
 const pre=await assessPreflight(task(),gateClassifier(JEVPASS));
 assert.deepEqual(Object.keys(pre.attention).filter((k)=>['part','excerpt','questions'].includes(k)),[]);
});
test('A needs_answers result numbers fallback attention questions from Q1',async()=>{
 const classifier=gateClassifier({requires_frontier:bool(0.05),contract_clear:bool(0.2),blocking_assumptions:bool(0.05),contract_part:choice('acceptance',0.9)});
 const r=await run(task(0,{jev:{mode:'shadow'}}),true,{classify:classifier,clarify:{callHop:emptyQuestionHop}});
 assert.deepEqual(r.clarification.questions.map((q:any)=>q.id),['Q1']);
});
test('A needs_answers result carries the attention question text',async()=>{
 const classifier=gateClassifier({requires_frontier:bool(0.05),contract_clear:bool(0.2),blocking_assumptions:bool(0.05),contract_part:choice('acceptance',0.9)});
 const r=await run(task(0,{jev:{mode:'shadow'}}),true,{classify:classifier,clarify:{callHop:emptyQuestionHop}});
 assert.equal(r.clarification.questions[0].question,r.jev.preflight.attention.questions[0]);
});
test('Compact receipt exposes the clarification batch',()=>{
 const clarification={sessionId:'clarify:clar',round:1,questions:[{id:'Q1',question:'Which?',why:'Jev flagged the acceptance part of the contract',suggestedAnswer:null,claimIds:[]}]};
 assert.deepEqual(compactHandoff({status:'needs_answers',clarification}).clarification,clarification);
});

// --- B05 verified code context for the Jev readiness preflight ---
test('validate accepts a well-formed context entry',()=>{
 const t=task(0,{context:[{path:'src/a.ts',start:2,end:9}]});
 assert.doesNotThrow(()=>validate(t));
});
test('validate rejects a non-array context',()=>{
 assert.throws(()=>validate(task(0,{context:'src/a.ts'})),/context \(expected an array\)/);
});
test('validate rejects an absolute context path',()=>{
 assert.throws(()=>validate(task(0,{context:[{path:join(tmpdir(),'a.ts')}]})),/context\.path \(expected a relative path\)/);
});
test('validate rejects a context path escaping cwd via dotdot',()=>{
 assert.throws(()=>validate(task(0,{context:[{path:'../outside.ts'}]})),/context\.path \(outside the workspace\)/);
});
test('validate rejects a context start that is not a positive integer',()=>{
 assert.throws(()=>validate(task(0,{context:[{path:'a.ts',start:0}]})),/context\.start \(expected a positive integer\)/);
});
test('validate rejects a context range whose start exceeds its end',()=>{
 assert.throws(()=>validate(task(0,{context:[{path:'a.ts',start:5,end:2}]})),/context start must not exceed end/);
});
test('validate rejects more than twenty context entries',()=>{
 const context=Array.from({length:21},(_,i)=>({path:`f${i}.ts`}));
 assert.throws(()=>validate(task(0,{context})),/at most 20 context entries/);
});
test('validate rejects a non-string context path',()=>{
 assert.throws(()=>validate(task(0,{context:[{path:7}]})),/context\.path \(expected a non-empty string\)/);
});

test('Classifier state carries the resolved excerpt text for a context entry',async()=>{
 const dir=contextdir('a.ts','line one\nline two\nline three\n');
 const seen=await capturePreflight(task(0,{cwd:dir,context:[{path:'a.ts'}]}));
 assert.match(seen.context[0].text,/line two/);
});
test('An out-of-range context end is clamped to the file length',async()=>{
 const dir=contextdir('a.ts','a\nb\nc\n');
 const seen=await capturePreflight(task(0,{cwd:dir,context:[{path:'a.ts',start:1,end:99}]}));
 assert.equal(seen.context[0].end,3);
});
test('An unreadable context path yields a classifier error entry',async()=>{
 const dir=contextdir('present.ts','x\n');
 const seen=await capturePreflight(task(0,{cwd:dir,context:[{path:'missing.ts'}]}));
 assert.ok(seen.context[0].error);
});
test('Blocking assumptions instructions name the independent checks',async()=>{
 let questions:any;
 const classifier:any=async({questions:q}:any)=>{questions=q;return {stopReason:'stop',answers:JEVPASS};};
 await assessPreflight(task(),classifier);
 assert.match(questions.blocking_assumptions.instructions,/independent checks/);
});
test('Blocking assumptions instructions name the provided code context',async()=>{
 let questions:any;
 const classifier:any=async({questions:q}:any)=>{questions=q;return {stopReason:'stop',answers:JEVPASS};};
 await assessPreflight(task(),classifier);
 assert.match(questions.blocking_assumptions.instructions,/code context/);
});
test('Worker prompt includes a Code context heading for a contract context entry',async()=>{
 const dir=contextdir('a.ts','alpha\n');
 const r=await run(task(0,{cwd:dir,workflow:'test_first',context:[{path:'a.ts'}]}),true);
 assert.match(readFileSync(join(r.artifactDir,'prompt.txt'),'utf8'),/Code context/);
});
test('Worker prompt includes the resolved context excerpt text',async()=>{
 const dir=contextdir('a.ts','alpha\n');
 const r=await run(task(0,{cwd:dir,workflow:'test_first',context:[{path:'a.ts'}]}),true);
 assert.match(readFileSync(join(r.artifactDir,'prompt.txt'),'utf8'),/alpha/);
});
test('A context entry longer than 200 lines keeps exactly 200 lines',async()=>{
 const dir=contextdir('big.ts',Array.from({length:250},(_,i)=>`line ${i+1}`).join('\n')+'\n');
 const seen=await capturePreflight(task(0,{cwd:dir,context:[{path:'big.ts'}]}));
 assert.equal(seen.context[0].text.split('\n').length,200);
});
test('A context entry cut to the line cap is marked truncated',async()=>{
 const dir=contextdir('big.ts',Array.from({length:250},(_,i)=>`line ${i+1}`).join('\n')+'\n');
 const seen=await capturePreflight(task(0,{cwd:dir,context:[{path:'big.ts'}]}));
 assert.equal(seen.context[0].truncated,true);
});
test('Total resolved context text never exceeds 40000 characters',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'delivery-ctx-'));
 for(let i=0;i<5;i++) writeFileSync(join(dir,`f${i}.ts`),Array.from({length:200},()=>'x'.repeat(80)).join('\n')+'\n');
 const context=Array.from({length:5},(_,i)=>({path:`f${i}.ts`}));
 const seen=await capturePreflight(task(0,{cwd:dir,context}));
 assert.ok(seen.context.reduce((n:number,e:any)=>n+(e.text?.length??0),0)<=40000);
});


