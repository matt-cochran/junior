import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { validate,run,parseReceipt,mockReceipt,receiptValid,emptyUsage,
 jevMode,assessPreflight,boundEvidence,boundedGitEvidence,resolveClassifierModel,
 estimateCost,validatePricing,
 taskWorkflow,decideWorkflow,choiceVerdict,buildPrompt,promptParts,buildPiArgs,piGuardModulePath,piBashTimeoutSeconds,
 resolveResume,loadResume,sessionLockKey,COMMON_PROMPT_BLOCK,WORKFLOW_PROMPT_BLOCKS,WORKFLOW_TEMPLATE_IDS,
 EXPLICIT_WORKFLOWS,WORKFLOW_DESCRIPTIONS,ANALYSIS_WORKFLOWS,ANALYSIS_REPORT_FILENAME,analysisReportPath,analysisReportBlock,isAnalysisWorkflow,
 hopToolBlock,discoverReportBlock,investigateReportBlock,
 collectGitEvidence,evidenceDelta,resolveIsolation,sourceDirty,createDetachedWorktree,
 isWorktreeOf,acquireLock,lockPathFor,
 resolveExecutionSettings,validateExecutionSettings,executeWorkerStreaming,spawnChildDetached,
 ToolWatchdog,EXECUTION_DEFAULTS,RuntimeHeartbeat } from './worker.ts';
import { doctor,init,setupCompanions,installSkill,inspectSkill,parseInitOptions,discoverInstalledPi,loadDefaults,checkCredentialsOnline,detectSlowMount,SUPPORTED_NODE_MIN,DEFAULT_PROVIDER,DEFAULT_MODEL,PI_PACKAGE,INSTALL_TIMEOUT_MS,PACKAGED_SKILL_PATH } from './setup.ts';
import { compactHandoff } from './handoff.ts';
const task=(code=0,extra:any={})=>({id:'smoke',deliverable:'Smoke test',cwd:mkdtempSync(join(tmpdir(),'delivery-')),acceptance:['Check passes'],checks:[{command:process.execPath,args:['-e',`process.exit(${code})`]}],...extra});
const cli=(args:string[])=>spawnSync(process.execPath,['worker.ts',...args],{encoding:'utf8'});
const resultFile=(value:any)=>{const f=join(mkdtempSync(join(tmpdir(),'delivery-')),'result.json');writeFileSync(f,typeof value==='string'?value:JSON.stringify(value));return f;};
const saved=(status:string)=>({id:'smoke',status,checks:[{command:'node',args:['-e',''],exitCode:status==='checks_failed'?1:0}],artifactDir:'/tmp/artifact'});

const U=(input:number,output:number,total:number)=>({input,output,cacheRead:0,cacheWrite:0,totalTokens:total,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}});
const assistant=(over:any={})=>JSON.stringify({type:'message_end',message:{role:'assistant',provider:'openrouter',model:'m',usage:U(1,2,3),stopReason:'stop',...over}});
const stream=(...records:any[])=>records.map((r:any)=>typeof r==='string'?r:JSON.stringify(r)).join('\n')+'\n';

// The README documentation tests assert against the whole public documentation
// set: the README front page plus every file under docs/.
const documentation=()=>[readFileSync(join(process.cwd(),'README.md'),'utf8'),...readdirSync(join(process.cwd(),'docs')).filter((f)=>f.endsWith('.md')).map((f)=>readFileSync(join(process.cwd(),'docs',f),'utf8'))].join('\n');

// --- offline Jev classifier mocks: no SDK load, no paid calls ---
const bool=(p:number)=>({type:'bool',probability:p});
const gateUsage={input:5,output:2,totalTokens:7,cost:{total:0.0002}};
const gateClassifier=(pre:any,post:any={AC1:bool(0.95)}):any=>async({questions}:any)=>{
 const isPre=Object.prototype.hasOwnProperty.call(questions,'contract_clear');
 return {stopReason:'stop',provider:'openrouter',model:'typesafe/jev-1.13',answers:isPre?pre:post,usage:gateUsage};
};
const outage:any=async()=>({stopReason:'error',errorMessage:'classifier outage'});
const JEVPASS={requires_frontier:bool(0.05),contract_clear:bool(0.95),blocking_assumptions:bool(0.05)};

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
 const r=parseReceipt(stream({type:'session',id:'sess-1'},assistant(),assistant(),{type:'agent_settled'}),{provider:'openrouter',model:'m'});
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

// --- estimated execution cost (offline; no pricing is fetched) ---
const PRICING={input:1,output:2,cacheRead:0.5,cacheWrite:0.25,source:'test-fixture',date:'2025-01-01'};
// 1M input, 2M output, 1M cacheRead, 1M cacheWrite, raw Pi cost reported as 0.
const costReceipt=(over:any={})=>parseReceipt(stream(
 JSON.stringify({type:'message_end',message:{role:'assistant',provider:'openrouter',model:'m',usage:{input:1_000_000,output:2_000_000,cacheRead:1_000_000,cacheWrite:1_000_000,totalTokens:5_000_000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0},...over},stopReason:'stop'}}),
 {type:'agent_settled'}));

test('Zero Pi catalog cost without verified pricing is unknown, not free',()=>{
 const r=costReceipt();
 assert.equal(r.usage.cost.available,true);
 assert.equal(r.usage.cost.total,0);
 const c=estimateCost(r,undefined);
 assert.equal(c.estimatedUsd,null);
 assert.equal(c.billedUsd,null);
 assert.equal(c.piReported.total,0);
 assert.match(c.unknownReason,/pricing/);
});
test('Estimate uses explicit rates and stays separate from raw Pi cost',()=>{
 const r=costReceipt();
 const c=estimateCost(r,PRICING);
 // (1M/1M)*1 + (2M/1M)*2 + (1M/1M)*0.5 + (1M/1M)*0.25 = 5.75
 assert.equal(c.estimatedUsd,5.75);
 assert.equal(c.pricingSource,'test-fixture');
 assert.equal(c.pricingDate,'2025-01-01');
 assert.equal(c.billedUsd,null);
 assert.equal(c.piReported.total,0);
});
test('Estimate excludes reasoning to avoid double counting output',()=>{
 const withReasoning=estimateCost(costReceipt({reasoning:9_000_000}),PRICING);
 const without=estimateCost(costReceipt(),PRICING);
 assert.equal(withReasoning.estimatedUsd,without.estimatedUsd);
 assert.equal(withReasoning.estimatedUsd,5.75);
});
test('Missing rates produce unknown estimate only when the bucket is used',()=>{
 const r=costReceipt();
 assert.equal(estimateCost(r,undefined).estimatedUsd,null);
 // input/output supplied, cache rates absent, cache usage positive
 const partial=estimateCost(r,{input:1,output:2,source:'s',date:'d'});
 assert.equal(partial.estimatedUsd,null);
 assert.match(partial.unknownReason,/cacheRead/);
 // missing rate for a zero-usage bucket does not block the estimate
 const noCache=estimateCost(costReceipt({cacheRead:0,cacheWrite:0}),{input:1,output:2,source:'s',date:'d'});
 assert.equal(noCache.estimatedUsd,5);
});
test('Invalid pricing rates are rejected by validate',()=>{
 assert.throws(()=>validate({...task(),pricing:{input:-1,source:'s',date:'d'}}),/Invalid pricing\.input/);
 assert.throws(()=>validate({...task(),pricing:{output:Number.NaN,source:'s',date:'d'}}),/Invalid pricing\.output/);
 assert.throws(()=>validate({...task(),pricing:{cacheRead:'1',source:'s',date:'d'}}),/Invalid pricing\.cacheRead/);
 assert.throws(()=>validate({...task(),pricing:{input:1,date:'d'}}),/Missing pricing\.source/);
 assert.throws(()=>validate({...task(),pricing:{input:1,source:'s'}}),/Missing pricing\.date/);
 assert.throws(()=>validatePricing(null),/Invalid pricing/);
 assert.doesNotThrow(()=>validate({...task(),pricing:PRICING}));
});
test('Multiple or unknown observed models produce unknown estimate',()=>{
 const multi=parseReceipt(stream(assistant(),assistant({provider:'anthropic',model:'claude'}),{type:'agent_settled'}));
 assert.equal(multi.observed.length,2);
 assert.equal(estimateCost(multi,PRICING).estimatedUsd,null);
 assert.match(estimateCost(multi,PRICING).unknownReason,/multiple/);
 const unknownModel=parseReceipt(stream(assistant({provider:undefined,model:undefined}),{type:'agent_settled'}));
 assert.equal(estimateCost(unknownModel,PRICING).estimatedUsd,null);
});
test('Run result carries cost with billedUsd null and raw Pi cost separate',async()=>{
 const r=await run(task(0,{pricing:PRICING}),true);
 assert.equal(r.cost.billedUsd,null);
 assert.equal(r.cost.estimatedUsd,null); // mock reports no usage
 assert.equal(r.cost.piReported.available,false);
 assert.equal(r.receipt.usage.cost.available,false);
});
test('Status exposes estimated cost when present',()=>{
 const cost={estimatedUsd:5.75,pricingSource:'test-fixture',pricingDate:'2025-01-01',billedUsd:null,piReported:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0,available:true}};
 const r=cli(['status',resultFile({...saved('simulation_passed'),cost})]);
 assert.equal(r.status,0);
 const o=JSON.parse(r.stdout);
 assert.equal(o.cost.estimatedUsd,5.75);
 assert.equal(o.cost.pricingSource,'test-fixture');
 assert.equal(o.cost.billedUsd,null);
});

// --- deterministic workflow templates (offline; no paid calls) ---
const choice=(c:string,confidence=0.9)=>({type:'choice',choice:c,probabilities:{[c]:confidence},confidence});
const workflowClassifier=(pre:any,post:any={AC1:bool(0.95)}):any=>{
 let sawWorkflow=false;
 const classify:any=async({questions}:any)=>{
  const isPre=Object.prototype.hasOwnProperty.call(questions,'contract_clear');
  if(isPre) sawWorkflow=Object.prototype.hasOwnProperty.call(questions,'workflow');
  return {stopReason:'stop',provider:'openrouter',model:'typesafe/jev-1.13',answers:isPre?pre:post,usage:gateUsage};
 };
 classify.sawWorkflow=()=>sawWorkflow;
 return classify;
};

test('Validate accepts workflow values and rejects unknown ones',()=>{
 for(const w of ['recon','test_first','checks_first','fmeca','evaluate','auto']) assert.doesNotThrow(()=>validate(task(0,{workflow:w})));
 assert.throws(()=>validate(task(0,{workflow:'bogus'})),/Invalid workflow/);
 assert.doesNotThrow(()=>validate(task(0,{resumeFrom:'/tmp/prior/result.json'})));
 assert.throws(()=>validate(task(0,{resumeFrom:''})),/Invalid resumeFrom/);
});
test('Missing workflow defaults to auto and explicit values pass through',()=>{
 assert.equal(taskWorkflow(task()),'auto');
 assert.equal(taskWorkflow({workflow:'recon'}),'recon');
 assert.equal(taskWorkflow({workflow:'bogus'}),'auto');
 const d=decideWorkflow({workflow:'test_first'},undefined,true);
 assert.equal(d.selected,'test_first');
 assert.equal(d.source,'explicit');
 assert.equal(d.recommended,null);
});
test('Explicit workflow overrides the classifier and skips its choice question',async()=>{
 const classifier:any=workflowClassifier({...JEVPASS, workflow:choice('test_first',0.95)});
 const r=await run(task(0,{workflow:'recon',jev:{mode:'shadow'}}),true,{classify:classifier});
 assert.equal(r.workflow.requested,'recon');
 assert.equal(r.workflow.selected,'recon');
 assert.equal(r.workflow.source,'explicit');
 assert.equal(classifier.sawWorkflow(),false);
});
test('Auto workflow uses one confident Jev choice with descriptions',async()=>{
 const classifier:any=workflowClassifier({...JEVPASS, workflow:choice('test_first',0.95)});
 const r=await run(task(0,{workflow:'auto',jev:{mode:'shadow'}}),true,{classify:classifier});
 assert.equal(classifier.sawWorkflow(),true);
 assert.equal(r.workflow.source,'choice');
 assert.equal(r.workflow.selected,'test_first');
 assert.equal(r.workflow.recommended,'test_first');
});
test('Auto workflow with below-threshold classification defaults to checks_first and records recommendation',async()=>{
 const classifier:any=workflowClassifier({...JEVPASS, workflow:choice('test_first',0.5)});
 const r=await run(task(0,{workflow:'auto',jev:{mode:'shadow'}}),true,{classify:classifier});
 assert.equal(r.workflow.selected,'checks_first');
 assert.equal(r.workflow.source,'default');
 assert.equal(r.workflow.recommended,'test_first');
 assert.equal(r.workflow.confidence,0.5);
 assert.match(r.workflow.note,/below confidence/);
});
test('Auto workflow with a classifier outage defaults to checks_first',async()=>{
 const r=await run(task(0,{workflow:'auto',jev:{mode:'shadow'}}),true,{classify:outage});
 assert.equal(r.workflow.selected,'checks_first');
 assert.equal(r.workflow.source,'default');
 assert.equal(r.workflow.recommended,'checks_first');
 assert.match(r.workflow.note,/unavailable/);
});
test('Auto workflow without Jev deterministically uses checks_first',async()=>{
 const r=await run(task(0,{workflow:'auto'}),true);
 assert.equal(r.workflow.selected,'checks_first');
 assert.equal(r.workflow.source,'default');
 assert.equal(r.workflow.recommended,'checks_first');
});
test('Classifier failure is bounded by a timeout and defaults to checks_first',async()=>{
 const hanging:any=async()=>new Promise(()=>{});
 const r=await run(task(0,{workflow:'auto',jev:{mode:'shadow'}}),true,{classify:hanging,classifierTimeoutMs:20});
 assert.equal(r.status,'simulation_passed');
 assert.equal(r.jev.preflight.status,'uncertain');
 assert.match(r.jev.preflight.error,/timed out/);
 assert.equal(r.workflow.selected,'checks_first');
 assert.equal(r.workflow.source,'default');
 assert.match(r.workflow.note,/timed out/);
});
test('Prompt is fixed common + workflow blocks plus the task contract',()=>{
 const t=task(0,{workflow:'test_first',deliverable:'Add widget'});
 const prompt=buildPrompt(t,'test_first');
 assert.ok(prompt.includes(COMMON_PROMPT_BLOCK));
 assert.ok(prompt.includes(WORKFLOW_PROMPT_BLOCKS.test_first));
 assert.ok(!prompt.includes(WORKFLOW_PROMPT_BLOCKS.recon));
 assert.ok(prompt.includes(JSON.stringify(t)));
 const recon=promptParts('recon');
 assert.equal(recon.common,COMMON_PROMPT_BLOCK);
 assert.equal(recon.resume,null);
 assert.ok(WORKFLOW_PROMPT_BLOCKS.recon.includes('.delivery'));
 assert.ok(WORKFLOW_PROMPT_BLOCKS.recon.includes('not a sandbox guarantee'));
});
test('Prompt and selected template IDs are saved as artifacts',async()=>{
 const r=await run(task(0,{workflow:'recon'}),true);
 const prompt=readFileSync(join(r.artifactDir,'prompt.txt'),'utf8');
 assert.ok(prompt.includes(WORKFLOW_PROMPT_BLOCKS.recon));
 const meta=JSON.parse(readFileSync(join(r.artifactDir,'workflow.json'),'utf8'));
 assert.equal(meta.selected,'recon');
 assert.equal(meta.workflowTemplateId,WORKFLOW_TEMPLATE_IDS.recon);
 assert.equal(meta.common,WORKFLOW_TEMPLATE_IDS.common);
 assert.equal(r.templates.workflow,WORKFLOW_TEMPLATE_IDS.recon);
});

// --- D09 analysis-only workflows: fmeca and evaluate (offline; no paid calls) ---
test('Validate accepts analysis workflows and preserves them',()=>{
 for(const w of ['fmeca','evaluate']) assert.doesNotThrow(()=>validate(task(0,{workflow:w})));
 assert.equal(taskWorkflow({workflow:'fmeca'}),'fmeca');
 assert.equal(taskWorkflow({workflow:'evaluate'}),'evaluate');
 assert.ok((EXPLICIT_WORKFLOWS as readonly string[]).includes('fmeca'));
 assert.ok((EXPLICIT_WORKFLOWS as readonly string[]).includes('evaluate'));
 assert.ok(WORKFLOW_DESCRIPTIONS.fmeca.length>0 && WORKFLOW_DESCRIPTIONS.evaluate.length>0);
 assert.equal(WORKFLOW_TEMPLATE_IDS.fmeca,'delivery-fmeca-1');
 assert.equal(WORKFLOW_TEMPLATE_IDS.evaluate,'delivery-evaluate-1');
 assert.equal(isAnalysisWorkflow('fmeca'),true);
 assert.equal(isAnalysisWorkflow('evaluate'),true);
 assert.equal(isAnalysisWorkflow('recon'),true);
 assert.equal(isAnalysisWorkflow('test_first'),false);
 assert.deepEqual([...ANALYSIS_WORKFLOWS],['recon','fmeca','evaluate','discover','investigate']);
});
test('fmeca and evaluate prompt blocks carry the bounded evidence contract',()=>{
 const fmeca=WORKFLOW_PROMPT_BLOCKS.fmeca;
 assert.match(fmeca,/analysis-only/i);
 assert.match(fmeca,/UX \/ user interaction/);
 assert.match(fmeca,/runtime behavior/);
 assert.match(fmeca,/technical architecture/);
 assert.match(fmeca,/project \/ delivery design/);
 assert.match(fmeca,/at most 3 iterations/);
 assert.match(fmeca,/8-15 highest-impact failure modes/);
 assert.match(fmeca,/do not invent/i);
 assert.match(fmeca,/prevention, then early detection, then fail-fast/);
 assert.match(fmeca,/TRIZ only for a real trade-off/);
 assert.match(fmeca,/tested\/proven-here/);
 assert.match(fmeca,/adapted/);
 assert.match(fmeca,/speculation/);
 assert.match(fmeca,/production observability/);
 assert.match(fmeca,/residual Severity and Probability/);
 assert.match(fmeca,/Proposing a fix does not eliminate a risk/);
 assert.match(fmeca,/Do not modify production code/);
 assert.match(fmeca,/proposal only/);
 const evaluate=WORKFLOW_PROMPT_BLOCKS.evaluate;
 assert.match(evaluate,/architecture validity/i);
 assert.match(evaluate,/Essential, Useful, Speculative or Unjustified/);
 assert.match(evaluate,/simpler alternative/i);
 assert.match(evaluate,/calibration risk/i);
 assert.match(evaluate,/observability risk/i);
 assert.match(evaluate,/over-engineering risk/i);
 assert.match(evaluate,/incremental-delivery risk/i);
 assert.match(evaluate,/Do not modify production code/);
 assert.match(evaluate,/proposal only/);
});
test('Analysis prompt appends a deterministic report path, code workflows do not',()=>{
 const t=task(0,{workflow:'fmeca',deliverable:'Review'});
 const report=join(t.cwd,'.delivery','x',ANALYSIS_REPORT_FILENAME);
 const prompt=buildPrompt(t,'fmeca',null,report);
 assert.ok(prompt.includes(report));
 assert.ok(prompt.includes(analysisReportBlock(report)));
 assert.match(prompt,/needs_review until that file exists/);
 const code=buildPrompt(t,'test_first');
 assert.ok(!code.includes('Analysis report requirement'));
 assert.equal(analysisReportPath('/tmp/art'),join('/tmp/art',ANALYSIS_REPORT_FILENAME));
 assert.equal(promptParts('fmeca').report,null);
});
test('Explicit fmeca/evaluate overrides the classifier and skips its choice question',async()=>{
 for(const w of ['fmeca','evaluate']){
  const classifier:any=workflowClassifier({...JEVPASS, workflow:choice('test_first',0.95)});
  const r=await run(task(0,{workflow:w,jev:{mode:'shadow'}}),true,{classify:classifier});
  assert.equal(r.workflow.requested,w);
  assert.equal(r.workflow.selected,w);
  assert.equal(r.workflow.source,'explicit');
  assert.equal(classifier.sawWorkflow(),false);
 }
});
test('Auto workflow can select fmeca or evaluate through one Jev choice',async()=>{
 for(const w of ['fmeca','evaluate']){
  const classifier:any=workflowClassifier({...JEVPASS, workflow:choice(w,0.95)});
  const r=await run(task(0,{workflow:'auto',jev:{mode:'shadow'}}),true,{classify:classifier});
  assert.equal(classifier.sawWorkflow(),true);
  assert.equal(r.workflow.source,'choice');
  assert.equal(r.workflow.selected,w);
  assert.equal(r.workflow.recommended,w);
 }
});
// --- D10 discover/investigate analysis workflows (offline; no paid calls) ---
test('Validate accepts the discover workflow',()=>{
 assert.doesNotThrow(()=>validate(task(0,{workflow:'discover'})));
});
test('Validate accepts the investigate workflow',()=>{
 assert.doesNotThrow(()=>validate(task(0,{workflow:'investigate'})));
});
test('The invalid-workflow error names discover and investigate',()=>{
 assert.throws(()=>validate(task(0,{workflow:'bogus'})),/discover.*investigate/);
});
test('discover is classified as an analysis workflow',()=>{
 assert.equal(isAnalysisWorkflow('discover'),true);
});
test('investigate is classified as an analysis workflow',()=>{
 assert.equal(isAnalysisWorkflow('investigate'),true);
});
test('taskWorkflow preserves the discover value',()=>{
 assert.equal(taskWorkflow({workflow:'discover'}),'discover');
});
test('taskWorkflow preserves the investigate value',()=>{
 assert.equal(taskWorkflow({workflow:'investigate'}),'investigate');
});
test('EXPLICIT_WORKFLOWS lists discover',()=>{
 assert.ok((EXPLICIT_WORKFLOWS as readonly string[]).includes('discover'));
});
test('EXPLICIT_WORKFLOWS lists investigate',()=>{
 assert.ok((EXPLICIT_WORKFLOWS as readonly string[]).includes('investigate'));
});
test('WORKFLOW_DESCRIPTIONS offers discover to the Jev workflow choice',()=>{
 assert.ok(WORKFLOW_DESCRIPTIONS.discover.length>0);
});
test('WORKFLOW_DESCRIPTIONS offers investigate to the Jev workflow choice',()=>{
 assert.ok(WORKFLOW_DESCRIPTIONS.investigate.length>0);
});
test('The discover prompt names the elicitation CLI call',()=>{
 assert.match(WORKFLOW_PROMPT_BLOCKS.discover,/junior tools call/);
});
test('The discover prompt names the readiness.assess result',()=>{
 assert.match(WORKFLOW_PROMPT_BLOCKS.discover,/readiness\.assess/);
});
test('The investigate prompt names the scientific-process CLI call',()=>{
 assert.match(WORKFLOW_PROMPT_BLOCKS.investigate,/junior tools call/);
});
test('The investigate prompt forbids concluding Supported without observations',()=>{
 assert.match(WORKFLOW_PROMPT_BLOCKS.investigate,/Never conclude Supported without supporting observations/);
});
test('The hop tool block names the hop path and the elicitation CLI call',()=>{
 const block=hopToolBlock({hopFrom:'/tmp/handoff/hop.json'},'discover');
 assert.match(block!,/junior tools call \/tmp\/handoff\/hop\.json elicitation/);
});
test('The hop tool block is absent without hopFrom',()=>{
 assert.equal(hopToolBlock({workflow:'discover'}),null);
});
test('The discover prompt states the hop path when hopFrom is set',()=>{
 const prompt=buildPrompt(task(0,{workflow:'discover',hopFrom:'/tmp/handoff/hop.json'}),'discover');
 assert.ok(prompt.includes('junior tools call /tmp/handoff/hop.json elicitation'));
});
test('The discover report block requires the established claims',()=>{
 assert.match(discoverReportBlock('/tmp/art/analysis-report.md'),/established claims/i);
});
test('The investigate report block requires the recommended next experiment or conclusion',()=>{
 assert.match(investigateReportBlock('/tmp/art/analysis-report.md'),/recommended next experiment or conclusion/i);
});
test('A discover run reports needs_review until its analysis report exists',async()=>{
 const r=await run(task(0,{workflow:'discover'}),true);
 assert.equal(r.status,'needs_review');
});
test('An investigate run reports needs_review until its analysis report exists',async()=>{
 const r=await run(task(0,{workflow:'investigate'}),true);
 assert.equal(r.status,'needs_review');
});
test('Analysis run without its report is needs_review, not completion',async()=>{
 const r=await run(task(0,{workflow:'fmeca'}),true);
 assert.equal(r.status,'needs_review');
 assert.equal(r.analysis.workflow,'fmeca');
 assert.equal(r.analysis.reportPresent,false);
 assert.match(r.workerError,/Analysis report missing/);
 assert.equal(existsSync(r.analysis.report),false);
 const h=compactHandoff(r);
 assert.equal(h.outcome,'needs_review');
 assert.equal(h.analysis.reportPresent,false);
 assert.equal(h.artifacts.report,r.analysis.report);
 assert.ok(h.unresolved.some((u:string)=>/analysis report missing/.test(u)));
});
test('Analysis run with its report in the artifactDir is ready_for_review',async()=>{
 const captured:any={};
 const spawnPi=(_c:string,args:string[])=>{
  const prompt=args[args.length-1];
  const m=/exact artifact path: ([^\n]+)/.exec(prompt);
  if(m){captured.report=m[1];writeFileSync(m[1],'# Analysis report\n');}
  return {status:0,stdout:stream({type:'session',id:SESSION_A},assistant(),{type:'agent_settled'}),stderr:''};
 };
 const r=await run(task(0,{workflow:'evaluate',provider:'openrouter',model:'m'}),false,{spawnPi});
 assert.equal(r.status,'ready_for_review');
 assert.equal(r.analysis.workflow,'evaluate');
 assert.equal(r.analysis.reportPresent,true);
 assert.equal(r.analysis.report,captured.report);
 assert.ok(r.analysis.report.startsWith(r.artifactDir));
 assert.ok(existsSync(r.analysis.report));
 const h=compactHandoff(r);
 assert.equal(h.outcome,'ready_for_review');
 assert.equal(h.analysis.reportPresent,true);
 assert.equal(h.artifacts.report,r.analysis.report);
 assert.deepEqual(h.unresolved,[]);
});
test('Implementation workflows have no analysis report requirement',async()=>{
 const r=await run(task(0,{workflow:'checks_first'}),true);
 assert.equal(r.status,'simulation_passed');
 assert.equal(r.analysis,undefined);
 const h=compactHandoff(r);
 assert.equal(h.analysis,null);
 assert.equal(h.artifacts.report,null);
});
test('Analysis-to-implementation requires an explicit workflow',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-'));
 const parentDir=join(cwd,'.delivery','prior','1');
 mkdirSync(parentDir,{recursive:true});
 writeFileSync(join(parentDir,'result.json'),JSON.stringify(priorResult(cwd,{workflow:{selected:'fmeca'}})));
 const classifier:any=workflowClassifier({...JEVPASS, workflow:choice('test_first',0.95)});
 const t=task(0,{cwd,provider:'openrouter',model:'m',workflow:'auto',jev:{mode:'shadow'},resumeFrom:join(parentDir,'result.json')});
 const r=await run(t,true,{classify:classifier});
 assert.equal(r.workflow.selected,'checks_first');
 assert.equal(r.workflow.recommended,'test_first');
 assert.match(r.workflow.note,/requires an explicit workflow/);
});
test('Pi argv passes explicit --session on resume and never --continue',()=>{
 assert.deepEqual(buildPiArgs({provider:'openrouter',model:'m'},'sess'),['--provider','openrouter','--model','m','--mode','json','--session','sess','-e',piGuardModulePath()]);
 assert.deepEqual(buildPiArgs({provider:'openrouter',model:'m'}),['--provider','openrouter','--model','m','--mode','json','-e',piGuardModulePath()]);
 assert.ok(!buildPiArgs({provider:'openrouter',model:'m'},'sess').includes('--continue'));
});
test('Pi argv loads the pi-guard extension from an existing module path',()=>{
 const args=buildPiArgs({provider:'openrouter',model:'m'});
 const at=args.indexOf('-e');
 assert.ok(at>=0 && existsSync(args[at+1]));
});
test('piBashTimeoutSeconds reserves ten seconds on long tool budgets',()=>{
 assert.equal(piBashTimeoutSeconds(300000),290);
});
test('piBashTimeoutSeconds halves short tool budgets with a one second floor',()=>{
 assert.equal(piBashTimeoutSeconds(1000),1);
});
test('Live Pi child environment carries the derived bash timeout',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 let seen:any;
 const fake=makeFakeChild();
 const t=okTask(repo,{id:'guard-env',execution:{quietMs:100000,heartbeatMs:20,toolTimeoutMs:8000,checkTimeoutMs:5000,deadlineMs:30000}});
 const p=run(t,false,{spawnChild:(_c:string,_a:string[],opts:any)=>{seen=opts;return fake.child;}});
 fake.emit({type:'agent_start'});
 fake.emit({type:'message_end',message:{role:'assistant',provider:'openrouter',model:'m',usage:U(1,1,2),stopReason:'stop'}});
 fake.emit({type:'agent_settled'});
 fake.end(0);
 await p;
 assert.equal(seen.env.JUNIOR_PI_BASH_TIMEOUT_S,'4');
});
test('A tool timeout names the tool and truncated command in the result unresolved list',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fake=makeFakeChild();
 const command='x'.repeat(300);
 const t=okTask(repo,{id:'guard-unresolved',execution:{quietMs:100000,heartbeatMs:20,toolTimeoutMs:60,checkTimeoutMs:5000,deadlineMs:30000}});
 const p=run(t,false,{spawnChild:()=>fake.child});
 fake.emit({type:'tool_execution_start',toolCallId:'c1',toolName:'bash',args:{command}});
 const r=await p;
 assert.equal((r.unresolved as string[]).find((u)=>u.includes('bash')),`tool timed out: bash: ${command.slice(0,200)}`);
});
test('A tool timeout names the tool and truncated command in the compact handoff unresolved list',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fake=makeFakeChild();
 const command='y'.repeat(300);
 const t=okTask(repo,{id:'guard-handoff',execution:{quietMs:100000,heartbeatMs:20,toolTimeoutMs:60,checkTimeoutMs:5000,deadlineMs:30000}});
 const p=run(t,false,{spawnChild:()=>fake.child});
 fake.emit({type:'tool_execution_start',toolCallId:'c1',toolName:'bash',args:{command}});
 const r=await p;
 assert.ok(compactHandoff(r).unresolved.some((u)=>u.includes(`bash: ${command.slice(0,200)}`)));
});
// --- Step 3 automatic continuation (offline; fake segments that hit the cap) ---
const CONTINUATION_CAP=1024;
const until=async(fn:()=>boolean,ms=8000)=>{const start=Date.now();while(!fn()){if(Date.now()-start>ms)throw Error('timed out waiting for condition');await delay(20);}};
const continuationFixture=(repo:any,continuations=1,extra:any={})=>{
 const fakes:any[]=[];const argvs:string[][]=[];
 const spawnChild=(_c:string,args:string[])=>{argvs.push(args);const f=makeFakeChild();fakes.push(f);return f.child;};
 const t=okTask(repo,{id:'cont',acceptance:['distinctive acceptance phrase'],execution:{continuations,quietMs:100000,heartbeatMs:20,toolTimeoutMs:5000,checkTimeoutMs:5000},...extra});
 const p=run(t,false,{spawnChild,maxOutputBytes:CONTINUATION_CAP});
 return {t,p,fakes,argvs};
};
const firstAssistant=(f:any,text:string,usage:any=U(1,2,3))=>f.emit({type:'message_end',message:{role:'assistant',provider:'openrouter',model:'m',usage,stopReason:'stop',content:[{type:'text',text}]}});
const exhaustCap=(f:any)=>f.emit({type:'tool_execution_start',toolCallId:'c1',toolName:'bash',args:{command:'z'.repeat(4000)}});
const completeSegment=(f:any,usage:any=U(1,1,2))=>{f.emit({type:'session',id:'seg-session'});f.emit({type:'message_end',message:{role:'assistant',provider:'openrouter',model:'m',usage,stopReason:'stop'}});f.emit({type:'agent_settled'});f.end(0);};
const driveToContinuation=async(fakes:any[],argvs:string[][],firstUsage:any=U(1,2,3))=>{
 await until(()=>fakes.length>=1);
 fakes[0].emit({type:'session',id:'seg-one'});
 firstAssistant(fakes[0],'work done in the first segment',firstUsage);
 exhaustCap(fakes[0]);
 await until(()=>fakes.length>=2);
};
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
const SESSION_A='123e4567-e89b-12d3-a456-426614174000';
const priorResult=(cwd:string,over:any={}):any=>({id:'prior',status:'ready_for_review',cwd,artifactDir:join(cwd,'.delivery','prior','1'),workflow:{selected:'recon'},receipt:{source:'pi_message_end',requested:{provider:'openrouter',model:'m'},sessionId:SESSION_A},...over});
test('Resume validation rejects cwd, provider/model and invalid session',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-'));
 const prior=priorResult(cwd);
 assert.ok(resolveResume(prior,{provider:'openrouter',model:'m'},cwd,'p').info);
 assert.match(resolveResume(prior,{provider:'openrouter',model:'m'},join(cwd,'other'),'p').error,/cwd mismatch/);
 assert.match(resolveResume(prior,{provider:'openrouter',model:'other'},cwd,'p').error,/provider\/model mismatch/);
 assert.match(resolveResume({...prior,receipt:{...prior.receipt,sessionId:''}},{provider:'openrouter',model:'m'},cwd,'p').error,/no Pi session ID/);
 assert.match(resolveResume({...prior,receipt:{...prior.receipt,sessionId:'bad id!'}},{provider:'openrouter',model:'m'},cwd,'p').error,/not valid/);
 assert.match(resolveResume({...prior,receipt:undefined},{provider:'openrouter',model:'m'},cwd,'p').error,/no receipt/);
});
test('Resume mismatch blocks before the worker starts',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-'));
 const parentDir=join(cwd,'.delivery','prior','1');
 mkdirSync(parentDir,{recursive:true});
 const prior=priorResult(cwd,{cwd:join(cwd,'elsewhere')});
 writeFileSync(join(parentDir,'result.json'),JSON.stringify(prior));
 let spawned=false;
 const spawnPi=()=>{spawned=true;return {status:0,stdout:'',stderr:''};};
 const r=await run(task(0,{cwd,provider:'openrouter',model:'m',resumeFrom:join(parentDir,'result.json')}),false,{spawnPi});
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
 writeFileSync(join(parentDir,'result.json'),JSON.stringify(priorResult(cwd)));
 let captured:any;
 const spawnPi=(command:string,args:string[])=>{captured={command,args};return {status:0,stdout:stream({type:'session',id:SESSION_A},assistant(),{type:'agent_settled'}),stderr:''};};
 const t=task(0,{cwd,provider:'openrouter',model:'m',workflow:'checks_first',deliverable:'Continue work',resumeFrom:join(parentDir,'result.json')});
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
 writeFileSync(join(parentDir,'result.json'),JSON.stringify(priorResult(cwd)));
 let spawned=false;
 const spawnPi=(_c:string,args:string[])=>{spawned=true;return {status:0,stdout:stream({type:'session',id:SESSION_A},assistant(),{type:'agent_settled'}),stderr:''};};
 const classifier:any=workflowClassifier({...JEVPASS, workflow:choice('test_first',0.95)});
 const t=task(0,{cwd,provider:'openrouter',model:'m',workflow:'auto',jev:{mode:'shadow'},resumeFrom:join(parentDir,'result.json')});
 const r=await run(t,false,{spawnPi,classify:classifier});
 assert.equal(spawned,true);
 assert.equal(r.workflow.selected,'checks_first');
 assert.equal(r.workflow.recommended,'test_first');
 assert.match(r.workflow.note,/requires an explicit workflow/);
});

// --- D06 init/doctor (offline; no installs, no paid calls) ---
const okExec=(_cmd:string,args:string[])=>({status:0,stdout:args.includes('--version')?'pi 1.0.3\n':'',stderr:''});
const setupDeps=(cwd:string,over:any={})=>({cwd,env:{PATH:'',HOME:cwd,...(over.env||{})},execPath:join(cwd,'node'),nodeVersion:'26.5.0',exec:okExec,...over});
const writeAgent=(cwd:string,over:any={})=>{
 const agent=join(cwd,'agent'); mkdirSync(agent,{recursive:true});
 writeFileSync(join(agent,'auth.json'),JSON.stringify(over.auth ?? {openrouter:{type:'api',key:'SUPER-SECRET-VALUE'}}));
 writeFileSync(join(agent,'models-store.json'),JSON.stringify(over.catalog ?? {openrouter:{models:[{id:DEFAULT_MODEL,type:'chat'}]}}));
 return agent;
};
const withPiDir=(cwd:string)=>{const bin=join(cwd,'bin');mkdirSync(bin,{recursive:true});writeFileSync(join(bin,'pi'),'#!/bin/sh\n');return bin;};

test('Doctor reports ready from injected pi, credentials and local catalog',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-doc-'));
 const bin=withPiDir(cwd); const agent=writeAgent(cwd);
 const d=doctor(setupDeps(cwd,{env:{PATH:bin,PI_CODING_AGENT_DIR:agent},execPath:join(bin,'node')}));
 assert.equal(d.command,'doctor');
 assert.equal(d.ok,true);
 assert.equal(d.node.supported,true);
 assert.equal(d.pi.found,true);
 assert.equal(d.pi.version,'1.0.3');
 assert.equal(d.pi.pathMismatch,false);
 assert.equal(d.credentials.present,true);
 assert.equal(d.credentials.sources.includes('auth.json'),true);
 assert.equal(d.model.available,true);
 assert.ok(d.checks.every((c:any)=>c.ok));
 // Never return or print credential values.
 assert.ok(!JSON.stringify(d).includes('SUPER-SECRET-VALUE'));
});
test('Doctor fails with actionable install guidance when Pi is missing',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-doc-'));
 const agent=writeAgent(cwd);
 const d=doctor(setupDeps(cwd,{env:{PATH:join(cwd,'empty-bin'),PI_CODING_AGENT_DIR:agent}}));
 assert.equal(d.ok,false);
 assert.equal(d.pi.found,false);
 const text=d.remediation.join(' ');
 assert.match(text,/init --install/);
 assert.match(text,/npm install -g --ignore-scripts/);
});
test('Doctor fails without credentials and guides to pi /login without values',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-doc-'));
 const bin=withPiDir(cwd); const agent=join(cwd,'agent'); mkdirSync(agent,{recursive:true});
 const d=doctor(setupDeps(cwd,{env:{PATH:bin,PI_CODING_AGENT_DIR:agent}}));
 assert.equal(d.ok,false);
 assert.equal(d.credentials.present,false);
 assert.match(d.remediation.join(' '),/\/login/);
});
test('Doctor reports an actionable missing-model diagnosis',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-doc-'));
 const bin=withPiDir(cwd); const agent=writeAgent(cwd,{catalog:{openrouter:{models:[{id:'deepseek/deepseek-v3.2',type:'chat'}]}}});
 const d=doctor(setupDeps(cwd,{env:{PATH:bin,PI_CODING_AGENT_DIR:agent}}));
 assert.equal(d.model.available,false);
 assert.equal(d.ok,false);
 assert.match(d.model.note,/pi update --models|\/model/);
});
test('Doctor reveals a PATH/nvm mismatch between pi and node',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-doc-'));
 const nvmBin=join(cwd,'nvm','v24.21.0','bin'); mkdirSync(nvmBin,{recursive:true});
 const otherBin=withPiDir(cwd); const agent=writeAgent(cwd);
 const d=doctor(setupDeps(cwd,{env:{PATH:otherBin,PI_CODING_AGENT_DIR:agent},execPath:join(nvmBin,'node')}));
 assert.equal(d.pi.found,true);
 assert.equal(d.pi.pathMismatch,true);
 assert.match(d.pi.note,/nvm|PATH/);
 assert.match(d.remediation.join(' '),/active nvm/);
});
test('Init creates defaults and example task only when absent; repeat preserves',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-init-'));
 const deps=setupDeps(cwd,{installedPi:{name:PI_PACKAGE,version:'1.0.3'}});
 const first:any=init(deps);
 assert.equal(first.command,'init');
 assert.ok(first.created.includes('delivery.config.json'));
 assert.ok(first.created.includes('tasks/example-task.json'));
 const cfg=JSON.parse(readFileSync(join(cwd,'delivery.config.json'),'utf8'));
 assert.equal(cfg.provider,DEFAULT_PROVIDER);
 assert.equal(cfg.model,DEFAULT_MODEL);
 assert.equal(cfg.pi.testedVersion,'1.0.3');
 // A local edit survives a repeat init.
 const custom='{"provider":"custom","model":"custom/model"}\n';
 writeFileSync(join(cwd,'delivery.config.json'),custom);
 const second:any=init(deps);
 assert.deepEqual(second.created,[]);
 assert.ok(second.preserved.includes('delivery.config.json'));
 assert.ok(second.preserved.includes('tasks/example-task.json'));
 assert.equal(readFileSync(join(cwd,'delivery.config.json'),'utf8'),custom);
});
test('Ordinary init reports install instruction and never invokes npm',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-init-'));
 const calls:any[]=[];
 const deps=setupDeps(cwd,{installedPi:{name:PI_PACKAGE,version:'1.0.3'},exec:(cmd:string,args:string[],opts:any)=>{calls.push({cmd,args,opts});return okExec(cmd,args);}});
 const r:any=init(deps);
 assert.equal(calls.length,0);
 assert.equal(r.install,undefined);
 assert.equal(r.ready,false);
 assert.match(r.instructions.join(' '),/init --install/);
});
test('Init --install uses the exact tested version via npm argv with a bounded timeout',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-init-'));
 const calls:any[]=[];
 const exec=(cmd:string,args:string[],opts:any)=>{calls.push({cmd,args,opts});return okExec(cmd,args);};
 const deps=setupDeps(cwd,{installedPi:{name:PI_PACKAGE,version:'1.0.3'},exec});
 const r:any=init(deps,{install:true});
 assert.equal(r.install.requested,true);
 assert.equal(r.install.attempted,true);
 assert.equal(r.install.ok,true);
 const npm=calls.find((c)=>c.cmd==='npm');
 assert.deepEqual(npm.args,['install','-g','--ignore-scripts',`${PI_PACKAGE}@1.0.3`]);
 assert.equal(npm.opts.timeout,INSTALL_TIMEOUT_MS);
 assert.equal(npm.opts.shell,undefined);
});
test('Discover installed Pi name/version from the local package.json',()=>{
 const info=discoverInstalledPi({execPath:'/mock/bin/node', readFile:()=>JSON.stringify({name:PI_PACKAGE,version:'1.0.3'})});
 assert.ok(info);
 assert.equal(info!.name,PI_PACKAGE);
 assert.match(info!.version,/^\d+\.\d+\.\d+/);
});
test('Run consumes project defaults and an explicit task provider/model wins',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-defaults-'));
 writeFileSync(join(cwd,'delivery.config.json'),JSON.stringify({provider:'openrouter',model:'deepseek/deepseek-v4.1-flash'}));
 const defaults=loadDefaults(cwd);
 assert.equal(defaults.provider,'openrouter');
 assert.equal(defaults.model,'deepseek/deepseek-v4.1-flash');
 const r=await run(task(0,{cwd}),true);
 assert.equal(r.receipt.requested.provider,'openrouter');
 assert.equal(r.receipt.requested.model,'deepseek/deepseek-v4.1-flash');
 const r2=await run(task(0,{cwd,provider:'anthropic',model:'claude'}),true);
 assert.equal(r2.receipt.requested.provider,'anthropic');
 assert.equal(r2.receipt.requested.model,'claude');
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
 assert.equal(r.install.spec,`${PI_PACKAGE}@1.0.3`);
 const npm=calls.find((c)=>c.cmd==='npm');
 assert.deepEqual(npm.args,['install','-g','--ignore-scripts',`${PI_PACKAGE}@1.0.3`]);
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
 assert.deepEqual(calls.find(c=>c.command==='npm').args,['install','-g','--ignore-scripts',`${PI_PACKAGE}@1.0.3`]);
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

// --- D06b init local exclusions + immediate mock handoff (real Git fixtures) ---
const initRepo=()=>{
 const dir=mkdtempSync(join(tmpdir(),'delivery-init-git-'));
 const git=(args:string[])=>spawnSync('git',args,{cwd:dir,encoding:'utf8'});
 git(['init','-q']);
 git(['config','user.email','t@example.com']);
 git(['config','user.name','tester']);
 git(['config','commit.gpgsign','false']);
 writeFileSync(join(dir,'base.txt'),'base\n');
 git(['add','base.txt']);
 git(['commit','-qm','base']);
 return {dir,git};
};
const exampleTaskFrom=(dir:string)=>JSON.parse(readFileSync(join(dir,'tasks','example-task.json'),'utf8'));

test('Init adds local exclusions so generated scaffold does not dirty the checkout',()=>{
 const repo=initRepo();
 init(setupDeps(repo.dir,{execPath:process.execPath}));
 assert.equal(sourceDirty(repo.dir).dirty,false);
});
test('Init preserves existing local exclude content',()=>{
 const repo=initRepo();
 const exclude=join(repo.dir,'.git','info','exclude');
 writeFileSync(exclude,'# user rule\n/my-secret\n');
 init(setupDeps(repo.dir,{execPath:process.execPath}));
 assert.match(readFileSync(exclude,'utf8'),/user rule/);
});
test('Init leaves a pre-existing untracked config visible as a source change',()=>{
 const repo=initRepo();
 writeFileSync(join(repo.dir,'delivery.config.json'),'{"provider":"openrouter","model":"x"}\n');
 init(setupDeps(repo.dir,{execPath:process.execPath}));
 assert.match(sourceDirty(repo.dir).status||'',/delivery\.config\.json/);
});
test('Init leaves a pre-existing untracked example task visible as a source change',()=>{
 const repo=initRepo();
 mkdirSync(join(repo.dir,'tasks'),{recursive:true});
 writeFileSync(join(repo.dir,'tasks','example-task.json'),'{}\n');
 init(setupDeps(repo.dir,{execPath:process.execPath}));
 assert.match(sourceDirty(repo.dir).status||'',/tasks\//);
});
test('Init leaves a pre-existing customized skill visible as a source change',()=>{
 const repo=initRepo();
 mkdirSync(join(repo.dir,'.agents','skills','junior'),{recursive:true});
 writeFileSync(join(repo.dir,'.agents','skills','junior','SKILL.md'),'custom\n');
 init(setupDeps(repo.dir,{execPath:process.execPath}),{target:'codex'});
 assert.match(sourceDirty(repo.dir).status||'',/\.agents\//);
});
test('Init preserves an untracked user file as a source change',()=>{
 const repo=initRepo();
 writeFileSync(join(repo.dir,'user.txt'),'user\n');
 init(setupDeps(repo.dir,{execPath:process.execPath}));
 assert.match(sourceDirty(repo.dir).status||'',/user\.txt/);
});
test('Init preserves a tracked user modification as a source change',()=>{
 const repo=initRepo();
 writeFileSync(join(repo.dir,'base.txt'),'changed\n');
 init(setupDeps(repo.dir,{execPath:process.execPath}));
 assert.match(sourceDirty(repo.dir).status||'',/base\.txt/);
});
test('Init does not broadly ignore the tasks directory',()=>{
 const repo=initRepo();
 mkdirSync(join(repo.dir,'tasks'),{recursive:true});
 writeFileSync(join(repo.dir,'tasks','keep.txt'),'keep\n');
 repo.git(['add','tasks/keep.txt']);
 repo.git(['commit','-qm','track tasks']);
 init(setupDeps(repo.dir,{execPath:process.execPath}));
 writeFileSync(join(repo.dir,'tasks','other-task.json'),'{}\n');
 assert.match(sourceDirty(repo.dir).status||'',/tasks\/other-task\.json/);
});
test('Fresh init followed immediately by a mock worktree handoff succeeds',async()=>{
 const repo=initRepo();
 init(setupDeps(repo.dir,{execPath:process.execPath}));
 const r=await run({...exampleTaskFrom(repo.dir),isolation:'worktree'},true);
 assert.equal(r.status,'simulation_passed');
});
test('A second consecutive mock worktree handoff after init succeeds',async()=>{
 const repo=initRepo();
 init(setupDeps(repo.dir,{execPath:process.execPath}));
 const task=exampleTaskFrom(repo.dir);
 await run({...task,isolation:'worktree'},true);
 const r=await run({...task,isolation:'worktree'},true);
 assert.equal(r.status,'simulation_passed');
});

// --- D10 packaged skill install + diagnosis (offline; temporary destinations only) ---
const skillSource=(content:string)=>{const d=mkdtempSync(join(tmpdir(),'delivery-skill-src-'));const f=join(d,'SKILL.md');writeFileSync(f,content);return f;};
const codexSkill=(root:string)=>join(root,'.agents','skills','junior','SKILL.md');
const claudeSkill=(root:string)=>join(root,'.claude','skills','junior','SKILL.md');

test('Project init installs the packaged Codex skill into the target checkout',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-'));
 init(setupDeps(cwd));
 assert.equal(existsSync(codexSkill(cwd)),true);
});
test('Project init installs the packaged Claude skill into the target checkout',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-'));
 init(setupDeps(cwd));
 assert.equal(existsSync(claudeSkill(cwd)),true);
});
test('Installed skill content matches the packaged source resolved relative to the module',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-'));
 init(setupDeps(cwd));
 assert.equal(readFileSync(codexSkill(cwd),'utf8'),readFileSync(PACKAGED_SKILL_PATH,'utf8'));
});
test('Project init never writes user-wide skill locations',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const home=mkdtempSync(join(tmpdir(),'delivery-home-'));
 init(setupDeps(cwd,{env:{HOME:home}}));
 assert.ok(!existsSync(codexSkill(home)) && !existsSync(claudeSkill(home)));
});
test('User-scope init installs the Codex skill under HOME/.agents/skills',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const home=mkdtempSync(join(tmpdir(),'delivery-home-'));
 init(setupDeps(cwd,{env:{HOME:home}}),{scope:'user',target:'codex'});
 assert.equal(existsSync(codexSkill(home)),true);
});
test('User-scope init installs the Claude skill under HOME/.claude/skills',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const home=mkdtempSync(join(tmpdir(),'delivery-home-'));
 init(setupDeps(cwd,{env:{HOME:home}}),{scope:'user',target:'claude'});
 assert.equal(existsSync(claudeSkill(home)),true);
});
test('Target none installs no skill files',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-'));
 init(setupDeps(cwd),{target:'none'});
 assert.ok(!existsSync(codexSkill(cwd)) && !existsSync(claudeSkill(cwd)));
});
test('Explicit user skill root installs the skill at the given root',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const root=join(mkdtempSync(join(tmpdir(),'delivery-root-')),'skills');
 init(setupDeps(cwd),{scope:'user',target:'codex',skillRoot:root});
 assert.equal(existsSync(join(root,'junior','SKILL.md')),true);
});
test('Repeat init reports the already-installed skill as identical',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const deps=setupDeps(cwd);
 init(deps,{target:'codex'});
 assert.equal(init(deps,{target:'codex'}).skill.actions[0].status,'identical');
});
test('Changed packaged skill leaves an unchanged installed copy in place',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const src=skillSource('v1\n'); const deps=setupDeps(cwd,{skillSource:src});
 init(deps,{target:'codex'}); writeFileSync(src,'v2\n');
 init(deps,{target:'codex'});
 assert.equal(readFileSync(codexSkill(cwd),'utf8'),'v1\n');
});
test('Changed packaged skill is reported as outdated, not replaced',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const src=skillSource('v1\n'); const deps=setupDeps(cwd,{skillSource:src});
 init(deps,{target:'codex'}); writeFileSync(src,'v2\n');
 assert.equal(init(deps,{target:'codex'}).skill.actions[0].status,'outdated');
});
test('Explicit upgrade replaces an unchanged installed skill with the new packaged source',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const src=skillSource('v1\n'); const deps=setupDeps(cwd,{skillSource:src});
 init(deps,{target:'codex'}); writeFileSync(src,'v2\n');
 init(deps,{target:'codex',upgrade:true});
 assert.equal(readFileSync(codexSkill(cwd),'utf8'),'v2\n');
});
test('Customized skill is preserved on rerun',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const deps=setupDeps(cwd);
 init(deps,{target:'codex'}); writeFileSync(codexSkill(cwd),'custom\n');
 init(deps,{target:'codex'});
 assert.equal(readFileSync(codexSkill(cwd),'utf8'),'custom\n');
});
test('Customized skill is reported as a conflict',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const deps=setupDeps(cwd);
 init(deps,{target:'codex'}); writeFileSync(codexSkill(cwd),'custom\n');
 assert.equal(init(deps,{target:'codex'}).skill.actions[0].status,'customized');
});
test('Explicit upgrade never replaces a customized skill',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const deps=setupDeps(cwd);
 init(deps,{target:'codex'}); writeFileSync(codexSkill(cwd),'custom\n');
 init(deps,{target:'codex',upgrade:true});
 assert.equal(readFileSync(codexSkill(cwd),'utf8'),'custom\n');
});
test('Explicit force replaces a customized skill with the packaged source',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const deps=setupDeps(cwd);
 init(deps,{target:'codex'}); writeFileSync(codexSkill(cwd),'custom\n');
 init(deps,{target:'codex',force:true});
 assert.equal(readFileSync(codexSkill(cwd),'utf8'),readFileSync(PACKAGED_SKILL_PATH,'utf8'));
});
test('Doctor reports project skill readiness separately from Pi execution readiness',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const bin=withPiDir(cwd); const agent=writeAgent(cwd);
 const d=doctor(setupDeps(cwd,{env:{PATH:bin,PI_CODING_AGENT_DIR:agent}}));
 assert.equal(d.skill.ready,false);
});
test('Doctor keeps Pi execution readiness green when the project skill is absent',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const bin=withPiDir(cwd); const agent=writeAgent(cwd);
 assert.equal(doctor(setupDeps(cwd,{env:{PATH:bin,PI_CODING_AGENT_DIR:agent}})).ok,true);
});
test('Doctor reports an installed project skill as ready',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const bin=withPiDir(cwd); const agent=writeAgent(cwd);
 init(setupDeps(cwd,{env:{PATH:bin,PI_CODING_AGENT_DIR:agent}}));
 assert.equal(doctor(setupDeps(cwd,{env:{PATH:bin,PI_CODING_AGENT_DIR:agent}})).skill.ready,true);
});
test('Parse init options selects user scope and the requested target',()=>{
 assert.equal(parseInitOptions(['init','--user','--target=claude']).scope,'user');
});
test('Parse init options reads an explicit skill root',()=>{
 assert.equal(parseInitOptions(['--skill-root=/tmp/skills']).skillRoot,'/tmp/skills');
});
test('Parse init options maps --no-skill to no target',()=>{
 assert.equal(parseInitOptions(['--no-skill']).target,'none');
});
test('junior.ts init --target=claude installs only the Claude project skill',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const home=mkdtempSync(join(tmpdir(),'delivery-home-'));
 spawnSync(process.execPath,[join(process.cwd(),'junior.ts'),'init','--target=claude','--no-install'],{encoding:'utf8',cwd,env:{...process.env,PATH:'',HOME:home,PI_CODING_AGENT_DIR:join(home,'agent'),JUNIOR_NO_INSTALL:'1'}});
 assert.equal(existsSync(claudeSkill(cwd)),true);
});

// --- D07 worktree isolation + complete bounded evidence (offline; temporary real Git repos) ---
const gitRepo=()=>{
 const dir=mkdtempSync(join(tmpdir(),'delivery-git-'));
 const git=(args:string[])=>spawnSync('git',args,{cwd:dir,encoding:'utf8'});
 git(['init','-q']);
 git(['config','user.email','t@example.com']);
 git(['config','user.name','tester']);
 git(['config','commit.gpgsign','false']);
 writeFileSync(join(dir,'.gitignore'),'.delivery/\n');
 git(['add','.gitignore']);
 git(['commit','-qm','ignore']);
 return {dir,git};
};
const commitFile=(repo:any,name:string,content:string)=>{writeFileSync(join(repo.dir,name),content);repo.git(['add',name]);repo.git(['commit','-qm',`add ${name}`]);};
const wtTask=(repo:any,extra:any={})=>({id:'wt',deliverable:'isolated work',cwd:repo.dir,acceptance:['checks pass'],checks:[{command:process.execPath,args:['-e',"require('fs').writeFileSync('check-marker.txt','1')"]}],isolation:'worktree',...extra});
const okSpawn=(onSpawn?:any)=>(command:string,args:string[],opts:any)=>{if(onSpawn)onSpawn(command,args,opts);return {status:0,stdout:stream({type:'session',id:'sess-wt'},assistant(),{type:'agent_settled'}),stderr:''};};
const okTask=(repo:any,extra:any={})=>({id:'ev',deliverable:'evidence',cwd:repo.dir,acceptance:['ok'],checks:[{command:process.execPath,args:['-e','process.exit(0)']}],...extra});

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
 const prior={id:'prior',status:'ready_for_review',artifactDir:priorDir,sourceCwd:repo.dir,executionCwd:repo.dir,isolation:{mode:'none'},receipt:{source:'pi_message_end',requested:{provider:'openrouter',model:'m'},sessionId:SESSION_A}};
 writeFileSync(join(priorDir,'result.json'),JSON.stringify(prior));
 let spawned=false;
 const r=await run(okTask(repo,{id:'resume',provider:'openrouter',model:'m',isolation:'worktree',resumeFrom:join(priorDir,'result.json')}),false,{spawnPi:()=>{spawned=true;return {status:0,stdout:'',stderr:''};}});
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
 const prior={id:'prior',status:'ready_for_review',artifactDir:priorDir,sourceCwd:repo.dir,executionCwd:wtPath,isolation:{mode:'worktree'},receipt:{source:'pi_message_end',requested:{provider:'openrouter',model:'m'},sessionId:SESSION_A}};
 writeFileSync(join(priorDir,'result.json'),JSON.stringify(prior));
 let spawnedCwd:string|undefined;
 const spawnPi=(command:string,args:string[],opts:any)=>{spawnedCwd=opts.cwd;return {status:0,stdout:stream({type:'session',id:SESSION_A},assistant(),{type:'agent_settled'}),stderr:''};};
 const r=await run(okTask(repo,{id:'resume-wt',provider:'openrouter',model:'m',isolation:'worktree',resumeFrom:join(priorDir,'result.json')}),false,{spawnPi});
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

const priorNone=(repo:any,slot:string)=>{const priorDir=join(repo.dir,'.delivery','prior',slot);mkdirSync(priorDir,{recursive:true});const prior={id:'prior',status:'ready_for_review',artifactDir:priorDir,sourceCwd:repo.dir,executionCwd:repo.dir,isolation:{mode:'none'},receipt:{source:'pi_message_end',requested:{provider:'openrouter',model:'m'},sessionId:SESSION_A}};writeFileSync(join(priorDir,'result.json'),JSON.stringify(prior));return join(priorDir,'result.json');};

test('Held Pi session lock rejects a resume before paid calls and is not auto-deleted',async()=>{
 const repo=gitRepo();
 commitFile(repo,'a.txt','base\n');
 const from=priorNone(repo,'3');
 const lockDir=join(repo.dir,'.delivery','locks');
 const held=acquireLock(lockDir,`session:${SESSION_A}`,{purpose:'test'});
 assert.ok(held.handle);
 let spawned=false;
 const r=await run(okTask(repo,{id:'resume-lock',provider:'openrouter',model:'m',resumeFrom:from}),false,{spawnPi:()=>{spawned=true;return {status:0,stdout:'',stderr:''};}});
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
 const r=await run(okTask(repo,{id:'resume-rel',provider:'openrouter',model:'m',resumeFrom:from}),false,{spawnPi:okSpawn()});
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
 const r=await run(okTask(repo,{id:'resume-lock-gap',provider:'openrouter',model:'m',resumeFrom:from}),false,{spawnPi:()=>{spawned=true;return {status:0,stdout:'',stderr:''};}});
 assert.equal(r.status,'needs_review');
 assert.match(r.workerError,/lock/i);
 assert.equal(spawned,false);
 assert.ok(!existsSync(checkoutLockPath),'checkout lock must be released when the session lock cannot be acquired');
 held.handle!.release();
});

test('Session lock key is derived from the parent session id, not a post-run session id',()=>{
 assert.equal(sessionLockKey({parentSessionId:'parent-1',sessionId:'new-2'} as any),'session:parent-1');
});

// --- D08 runtime handoff: streaming lifecycle, deadlines, repair lineage (offline; no paid calls) ---
const delay=(ms:number)=>new Promise((r)=>setTimeout(r,ms));
const artifactFor=(repo:any,id:string)=>{const base=join(repo.dir,'.delivery',id);const stamps=readdirSync(base).sort();return join(base,stamps[stamps.length-1]);};
const readRuntime=(art:string)=>JSON.parse(readFileSync(join(art,'runtime.json'),'utf8'));

const makeFakeChild=()=>{
 const ee=new EventEmitter();
 const stdout=new PassThrough();
 const stderr=new PassThrough();
 let exited=false;
 const state={killed:false, killSignals:[] as string[], spawned:0};
 // Completion is driven by `close`; provide both `exit` and `close` so fixtures
 // match a real pipe child (and never lose trailing bytes).
 const finish=(code:number|null,sig:string|null)=>{if(exited)return;exited=true;stdout.end();stderr.end();ee.emit('exit',code,sig);ee.emit('close',code,sig);};
 const child:any={
  pid:0, stdout, stderr,
  on:(event:string,cb:any)=>{ee.on(event,cb);return child;},
  kill:(sig?:string)=>{state.killed=true;state.killSignals.push(sig||'SIGTERM');finish(null,sig||'SIGTERM');return true;},
 };
 const emit=(ev:any)=>stdout.write(JSON.stringify(ev)+'\n');
 const emitRaw=(line:string)=>stdout.write(line);
 const end=(code=0)=>finish(code,null);
 return {child,emit,emitRaw,end,ee,state,stdout,stderr};
};

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
 const prior={id:'prior',status:'ready_for_review',artifactDir:priorDir,sourceCwd:repo.dir,executionCwd:repo.dir,isolation:{mode:'none'},lineage:{rootId:'prior',repairs:1,maxRepairs:1,deadlineAt:null},receipt:{source:'pi_message_end',requested:{provider:'openrouter',model:'m'},sessionId:SESSION_A}};
 writeFileSync(join(priorDir,'result.json'),JSON.stringify(prior));
 let spawned=false;
 const r=await run(okTask(repo,{id:'repair-rej',provider:'openrouter',model:'m',repairFrom:join(priorDir,'result.json')}),false,{spawnPi:()=>{spawned=true;return {status:0,stdout:'',stderr:''};}});
 assert.equal(spawned,false,'rejected before the worker starts');
 assert.equal(r.status,'needs_review');
 assert.match(r.workerError,/repair rejected/);
 assert.equal(r.lineage.repairs,2);
 assert.equal(r.lineage.rejected,true);
});

test('Repair within budget reuses the session and persists the lineage counter',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const priorDir=join(repo.dir,'.delivery','prior','okrepair');mkdirSync(priorDir,{recursive:true});
 const prior={id:'prior',status:'ready_for_review',artifactDir:priorDir,sourceCwd:repo.dir,executionCwd:repo.dir,isolation:{mode:'none'},lineage:{rootId:'prior',repairs:0,maxRepairs:1,deadlineAt:null},receipt:{source:'pi_message_end',requested:{provider:'openrouter',model:'m'},sessionId:SESSION_A}};
 writeFileSync(join(priorDir,'result.json'),JSON.stringify(prior));
 const from=join(priorDir,'result.json');
 const r=await run(okTask(repo,{id:'repair-ok',provider:'openrouter',model:'m',repairFrom:from}),false,{spawnPi:okSpawn()});
 assert.equal(r.status,'ready_for_review');
 assert.equal(r.lineage.repairs,1);
 assert.equal(r.lineage.maxRepairs,1);
 assert.equal(r.repair.repairs,1);
 assert.equal(r.repair.parentSessionId,SESSION_A);
 assert.ok(!existsSync(lockPathFor(join(repo.dir,'.delivery','locks'),`session:${SESSION_A}`)),'session lock released');
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
 writeFileSync(taskPath,JSON.stringify({id:'junior-h',deliverable:'x',cwd:repo.dir,acceptance:['ok'],checks:[{command:process.execPath,args:['-e','process.exit(0)']}]}));
 const r=spawnSync(process.execPath,['junior.ts','handoff',taskPath,'--mock'],{encoding:'utf8',env:{...process.env,JUNIOR_NO_INSTALL:'1'}});
 assert.equal(r.status,0,r.stderr);
 const o=JSON.parse(r.stdout);
 assert.equal(o.id,'junior-h');
 assert.equal(o.outcome,'simulation_passed');
 assert.equal(o.execution.isolation,'worktree');
 assert.ok(o.artifacts.result && existsSync(o.artifacts.result));

 writeFileSync(taskPath,JSON.stringify({id:'junior-none',deliverable:'x',cwd:repo.dir,acceptance:['ok'],isolation:'none',checks:[{command:process.execPath,args:['-e','process.exit(0)']}]}));
 const r2=spawnSync(process.execPath,['junior.ts','handoff',taskPath,'--mock'],{encoding:'utf8',env:{...process.env,JUNIOR_NO_INSTALL:'1'}});
 assert.equal(r2.status,0,r2.stderr);
 assert.equal(JSON.parse(r2.stdout).execution.isolation,'none');
});

test('junior.ts validate and status --full use the existing worker structures',()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const cfg=mkdtempSync(join(tmpdir(),'junior-cfg-'));
 const taskPath=join(cfg,'t.json');
 writeFileSync(taskPath,JSON.stringify({id:'su',deliverable:'x',cwd:repo.dir,acceptance:['ok'],checks:[{command:process.execPath,args:['-e','process.exit(0)']}]}));
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
const waitForPid=async(path:string,tries=100)=>{for(let i=0;i<tries;i++){try{const p=Number(readFileSync(path,'utf8'));if(p>0)return p;}catch{}await delay(25);}return 0;};
const aliveAfter=async(pid:number,tries=80)=>{for(let i=0;i<tries;i++){try{process.kill(pid,0);await delay(50);}catch{return false;}}return true;};
const termIgnoringDescendant=()=>"process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000)";

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

// --- Issue #13/#16: compact labelled cost and token receipt (offline) ---
const handoffResult=(over:any={}):any=>({id:'c',status:'ready_for_review',artifactDir:'/a',
 receipt:{requested:{provider:'openrouter',model:'m'},observed:[{provider:'openrouter',model:'m'}],observedUnknown:false,
  usage:{input:11,output:22,cacheRead:3,cacheWrite:4,totalTokens:40,available:true},responseIds:['gen-abc']},
 cost:{estimatedUsd:null,piReported:{total:null,available:false}},...over});

test('Compact cost prefers captured provider billing over Pi and estimate',()=>{
 const h=compactHandoff(handoffResult({cost:{billedUsd:1.5,estimatedUsd:2,piReported:{total:3,available:true}}}));
 assert.equal(h.model.cost.source,'provider');
});
test('Compact cost prefers the captured provider amount over the other candidates',()=>{
 const h=compactHandoff(handoffResult({cost:{billedUsd:1.5,estimatedUsd:2,piReported:{total:3,available:true}}}));
 assert.equal(h.model.cost.amountUsd,1.5);
});
test('Compact cost falls back to a finite Pi-reported total over configured pricing',()=>{
 const h=compactHandoff(handoffResult({cost:{billedUsd:null,estimatedUsd:2,piReported:{total:3,available:true}}}));
 assert.equal(h.model.cost.source,'pi_reported');
});
test('Compact cost falls back to configured pricing when no provider or Pi cost exists',()=>{
 const h=compactHandoff(handoffResult({cost:{billedUsd:null,estimatedUsd:2,piReported:{total:null,available:false}}}));
 assert.equal(h.model.cost.source,'estimate');
});
test('Compact cost treats a Pi-reported numeric zero as available',()=>{
 const h=compactHandoff(handoffResult({cost:{billedUsd:null,estimatedUsd:null,piReported:{total:0,available:true}}}));
 assert.equal(h.model.cost.available,true);
});
test('Compact cost treats a negative Pi-reported total as unknown',()=>{
 const h=compactHandoff(handoffResult({cost:{billedUsd:null,estimatedUsd:null,piReported:{total:-1,available:true}}}));
 assert.equal(h.model.cost.available,false);
});
test('Compact cost treats an absent Pi-reported cost as unknown',()=>{
 const h=compactHandoff(handoffResult({cost:{billedUsd:null,estimatedUsd:null,piReported:{total:0,available:false}}}));
 assert.equal(h.model.cost.available,false);
});
test('Compact cost keeps the legacy estimated amount alongside the compact amount',()=>{
 const h=compactHandoff(handoffResult({cost:{billedUsd:null,estimatedUsd:2,piReported:{total:3,available:true}}}));
 assert.equal(h.model.cost.estimatedUsd,2);
});
test('Compact cost unknown reason names the missing upstream billing',()=>{
 const h=compactHandoff(handoffResult({cost:{billedUsd:null,estimatedUsd:null,piReported:{total:null,available:false}}}));
 assert.match(String(h.model.cost.unknownReason),/upstream billing/i);
});
test('Compact cost unknown reason names the missing Pi pricing',()=>{
 const h=compactHandoff(handoffResult({cost:{billedUsd:null,estimatedUsd:null,piReported:{total:null,available:false}}}));
 assert.match(String(h.model.cost.unknownReason),/Pi pricing/i);
});
test('Compact receipt exposes the input token count',()=>{
 const h=compactHandoff(handoffResult());
 assert.equal(h.model.input,11);
});
test('Compact receipt exposes the output token count',()=>{
 const h=compactHandoff(handoffResult());
 assert.equal(h.model.output,22);
});
test('Parser records the provider response id from an assistant message_end',()=>{
 const r=parseReceipt(stream(assistant({responseId:'gen-abc'}),{type:'agent_settled'}));
 assert.deepEqual(r.responseIds,['gen-abc']);
});
test('Parser dedupes repeated provider response ids',()=>{
 const r=parseReceipt(stream(assistant({responseId:'gen-abc'}),assistant({responseId:'gen-abc'}),{type:'agent_settled'}));
 assert.equal(r.responseIds.length,1);
});
test('Compact handoff exposes the captured provider response ids',()=>{
 const h=compactHandoff(handoffResult());
 assert.deepEqual(h.model.responseIds,['gen-abc']);
});
test('Compact cost of a legacy result without cost data is unknown',()=>{
 const h=compactHandoff({id:'old',status:'ready_for_review',artifactDir:'/a',receipt:{usage:{}}});
 assert.equal(h.model.cost.available,false);
});
test('Compact cost falls back to the raw receipt cost when no projection exists',()=>{
 const h=compactHandoff({id:'old',status:'ready_for_review',artifactDir:'/a',receipt:{usage:{cost:{total:0,available:true}}}});
 assert.equal(h.model.cost.source,'pi_reported');
});

test('Cancellation completes kill escalation before returning handback',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'junior-cancel-order-'));
 const ee:any=new EventEmitter(); ee.stdout=new PassThrough(); ee.stderr=new PassThrough();
 const signals:string[]=[];
 ee.kill=(signal:string)=>{signals.push(signal); if(signal==='SIGTERM') setImmediate(()=>ee.emit('close',null,'SIGTERM')); return true;};
 const r=await executeWorkerStreaming({spawnChild:()=>ee,command:'fixture',args:[],cwd:dir,eventsPath:join(dir,'events.jsonl'),logPath:join(dir,'worker.log'),runtimePath:join(dir,'runtime.json'),settings:resolveExecutionSettings({execution:{deadlineMs:50,heartbeatMs:10,quietMs:10}}),deadlineAt:Date.now()+50});
 assert.equal(r.deadlineExceeded,true);
 assert.deepEqual(signals,['SIGTERM','SIGKILL']);
});

// --- Issue #14: check cwd resolution and strict contract keys (offline) ---
const addNestedPackage=(repo:any)=>{mkdirSync(join(repo.dir,'packages','app'),{recursive:true});writeFileSync(join(repo.dir,'packages','app','package.json'),'{"name":"app"}\n');repo.git(['add','packages']);repo.git(['commit','-qm','add package']);};
const cwdCheck=(cwd?:any)=>({command:process.execPath,args:['-e',"require('fs').writeFileSync('marker.txt','1')"],...(cwd!==undefined?{cwd}:{})});
const makeDirLink=(target:string,link:string)=>{try{symlinkSync(target,link,process.platform==='win32'?'junction':'dir');return true;}catch{return false;}};
const markerCheck=(cwd:string)=>({command:process.execPath,args:['-e',"require('fs').writeFileSync('marker.txt','1')"],cwd});
const symlinkEscape=()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const outside=mkdtempSync(join(tmpdir(),'delivery-outside-'));
 const link=join(repo.dir,'linkout');
 if(!makeDirLink(outside,link)) return null;
 return {repo,outside,link,check:markerCheck(link)};
};

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

// --- companion tools and default install (offline; injected seams, temporary Git repos) ---
const tempGitRepo=()=>{
 const dir=mkdtempSync(join(tmpdir(),'delivery-init-git-'));
 spawnSync('git',['init','-q'],{cwd:dir});
 return dir;
};
const localExclude=(dir:string)=>{try{return readFileSync(join(dir,'.git','info','exclude'),'utf8');}catch{return '';}};

test('Parse init options installs tools by default',()=>{
 assert.equal(parseInitOptions([]).install,true);
});
test('Parse init options --no-install opts out of every install',()=>{
 assert.equal(parseInitOptions(['--no-install']).install,false);
});
test('Parse init options --no-companions skips the companion tools',()=>{
 assert.equal(parseInitOptions(['--no-companions']).companions,false);
});
test('An upgraded project skill is recorded as a local Git exclusion',()=>{
 const cwd=tempGitRepo(); const src=skillSource('v1\n'); const deps=setupDeps(cwd,{skillSource:src});
 init(deps,{target:'codex'}); writeFileSync(join(cwd,'.git','info','exclude'),''); writeFileSync(src,'v2\n');
 init(deps,{target:'codex',upgrade:true});
 assert.match(localExclude(cwd),/^\/\.agents\/skills\/junior\/$/m);
});
test('Files a companion skill installer creates are recorded as local Git exclusions',()=>{
 const cwd=tempGitRepo(); const bin=join(cwd,'.bin');
 mkdirSync(join(cwd,'.agent'),{recursive:true}); writeFileSync(join(cwd,'.agent','notes.md'),'already untracked\n');
 const exec=(cmd:string,args:string[])=>{
  if (args[0]==='init') { mkdirSync(join(cwd,'.agent','skills','jevitate-explore'),{recursive:true}); writeFileSync(join(cwd,'.agent','skills','jevitate-explore','SKILL.md'),'x'); }
  return {status:0,stdout:`${cmd} 1.0.0\n`};
 };
 setupCompanions({cwd,env:{PATH:bin},exists:(p:string)=>p===join(bin,'jevitate'),exec},{target:'claude',scope:'project'});
 assert.match(localExclude(cwd),/^\/\.agent\/skills\/jevitate-explore\/SKILL\.md$/m);
});
test('A tracked file a companion installer edits is reported, not excluded',()=>{
 const cwd=tempGitRepo(); const bin=join(cwd,'.bin');
 writeFileSync(join(cwd,'AGENTS.md'),'mine\n'); spawnSync('git',['add','AGENTS.md'],{cwd}); spawnSync('git',['-c','user.email=t@e','-c','user.name=t','commit','-qm','a'],{cwd});
 const exec=(cmd:string,args:string[])=>{ if (args[0]==='init') writeFileSync(join(cwd,'AGENTS.md'),'mine\n<jevitate/>\n'); return {status:0,stdout:`${cmd} 1.0.0\n`}; };
 const r=setupCompanions({cwd,env:{PATH:bin},exists:(p:string)=>p===join(bin,'jevitate'),exec},{target:'claude',scope:'project'});
 assert.deepEqual(r.modifiedTracked,['AGENTS.md']);
});
test('Doctor reports companion tools separately from Pi readiness',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-doc-'));
 assert.equal((doctor(setupDeps(cwd)) as any).companions.ready,false);
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

// --- B01 run artifacts never appear as target-checkout changes (real Git fixtures) ---
const artifactTask=(repo:any,extra:any={})=>({id:'b01',deliverable:'artifact isolation',cwd:repo.dir,acceptance:['checks pass'],checks:[{command:process.execPath,args:['-e','process.exit(0)']}],...extra});
const deliveryPath=(p:string)=>p==='.delivery'||p.startsWith('.delivery/');

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

// --- B09 opt-in online credential check (injected fetch; never real network) ---
const onlineAgent=(cwd:string,key:string)=>{const agent=writeAgent(cwd,{auth:{openrouter:{type:'api',key}}});return {agent};};

test('Online credential check reports a funded openrouter key as ready',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-online-'));
 const {agent}=onlineAgent(cwd,'sk-or-funded');
 const fetch=async()=>({status:200,json:async()=>({data:{usage:2,limit:10}})});
 const r=await checkCredentialsOnline(setupDeps(cwd,{env:{PI_CODING_AGENT_DIR:agent},fetch}));
 assert.equal(r.ready,true);
});
test('Online credential check marks a rejected openrouter key as invalid',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-online-'));
 const {agent}=onlineAgent(cwd,'sk-or-rejected');
 const fetch=async()=>({status:401,json:async()=>({})});
 const r=await checkCredentialsOnline(setupDeps(cwd,{env:{PI_CODING_AGENT_DIR:agent},fetch}));
 assert.equal(r.valid,false);
});
test('Online credential check reports an exhausted openrouter key as not ready',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-online-'));
 const {agent}=onlineAgent(cwd,'sk-or-exhausted');
 const fetch=async()=>({status:200,json:async()=>({data:{usage:10,limit:10}})});
 const r=await checkCredentialsOnline(setupDeps(cwd,{env:{PI_CODING_AGENT_DIR:agent},fetch}));
 assert.equal(r.ready,false);
});
test('Online credential check never serializes the provider key',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-online-'));
 const key='sk-or-super-secret-online';
 const {agent}=onlineAgent(cwd,key);
 const fetch=async()=>({status:200,json:async()=>({data:{usage:0,limit:5}})});
 const r=await checkCredentialsOnline(setupDeps(cwd,{env:{PI_CODING_AGENT_DIR:agent},fetch}));
 assert.ok(!JSON.stringify(r).includes(key));
});
test('Online credential check sends the bearer key to the openrouter key endpoint',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-online-'));
 const {agent}=onlineAgent(cwd,'sk-or-wire');
 let captured:any;
 const fetch=async(url:string,init:any)=>{captured={url,headers:init.headers};return {status:200,json:async()=>({data:{usage:0,limit:5}})};};
 await checkCredentialsOnline(setupDeps(cwd,{env:{PI_CODING_AGENT_DIR:agent},fetch}));
 assert.deepEqual(captured,{url:'https://openrouter.ai/api/v1/key',headers:{Authorization:'Bearer sk-or-wire'}});
});
test('Offline doctor performs no online credential request',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-online-'));
 const bin=withPiDir(cwd); const {agent}=onlineAgent(cwd,'sk-or-offline');
 let calls=0;
 const fetch=async()=>{calls++;return {status:200,json:async()=>({data:{}})};};
 doctor(setupDeps(cwd,{env:{PATH:bin,PI_CODING_AGENT_DIR:agent},fetch}));
 assert.equal(calls,0);
});
test('Evidence collected from a subdirectory cwd still reports a change elsewhere in the repository',()=>{
 const repo=gitRepo(); mkdirSync(join(repo.dir,'pkg')); commitFile(repo,'pkg/a.txt','a\n'); commitFile(repo,'shared.txt','s\n');
 writeFileSync(join(repo.dir,'shared.txt'),'changed\n');
 assert.equal(collectGitEvidence(join(repo.dir,'pkg')).changedFiles.some((f:any)=>f.path==='shared.txt'),true);
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

const capturePreflight=async(t:any)=>{ let seen:any; const classifier:any=async({state}:any)=>{seen=state;return {stopReason:'stop',answers:JEVPASS};}; await assessPreflight(t,classifier); return seen; };
const contextdir=(name:string,body:string)=>{const dir=mkdtempSync(join(tmpdir(),'delivery-ctx-'));writeFileSync(join(dir,name),body);return dir;};

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

// --- B06 opt-in isolation setup (links, copies, setup commands) ---
const linkRepo=()=>{
 const repo=gitRepo();
 commitFile(repo,'.gitignore','.delivery/\ndeps/\n');
 mkdirSync(join(repo.dir,'deps'),{recursive:true});
 writeFileSync(join(repo.dir,'deps','secret.txt'),'s\n');
 return repo;
};

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
 commitFile(repo,'delivery.config.json',JSON.stringify({provider:'openrouter',model:'m',isolationSetup:{commands:[{command:process.execPath,args:['-e',"require('fs').writeFileSync('setup-marker.txt','1')"]}]}}));
 const checks=[{command:process.execPath,args:['-e',"require('fs').readFileSync('setup-marker.txt')"]}];
 const r=await run(okTask(repo,{isolation:'worktree',checks}),true);
 assert.equal(r.checks[0].exitCode,0);
});

test('a contract isolationSetup takes precedence over delivery.config.json',async()=>{
 const repo=gitRepo();
 commitFile(repo,'delivery.config.json',JSON.stringify({provider:'openrouter',model:'m',isolationSetup:{commands:[{command:process.execPath,args:['-e','process.exit(3)']}]}}));
 const isolationSetup={commands:[{command:process.execPath,args:['-e',"require('fs').writeFileSync('contract-marker.txt','1')"]}]};
 const r=await run(okTask(repo,{isolation:'worktree',isolationSetup}),true);
 assert.equal(r.status,'simulation_passed');
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

// --- Issue #17: self-explanatory unresolved acceptance and conditional criteria ---

test('Unresolved uncertain acceptance names the criterion text and probability',async()=>{
 const t=task(0,{acceptance:['Where a component lacks a data-testid the check must skip'],jev:{mode:'shadow'}});
 const classifier=gateClassifier(JEVPASS,{AC1:bool(0.5)});
 const h=compactHandoff(await run(t,true,{classify:classifier}));
 assert.equal(h.unresolved[0],'AC1 uncertain: "Where a component lacks a data-testid the check must skip" (P(satisfied)=0.5, threshold 0.6)');
});
test('Unresolved acceptance gap names the criterion text and probability',async()=>{
 const t=task(0,{acceptance:['Every path has a test'],jev:{mode:'shadow'}});
 const classifier=gateClassifier(JEVPASS,{AC1:bool(0.1)});
 const h=compactHandoff(await run(t,true,{classify:classifier}));
 assert.equal(h.unresolved[0],'AC1 gap: "Every path has a test" (P(satisfied)=0.1, threshold 0.6)');
});
test('A long criterion text is truncated in the unresolved entry',async()=>{
 const t=task(0,{acceptance:['x'.repeat(120)],jev:{mode:'shadow'}});
 const classifier=gateClassifier(JEVPASS,{AC1:bool(0.1)});
 const h=compactHandoff(await run(t,true,{classify:classifier}));
 assert.equal(h.unresolved[0],`AC1 gap: "${'x'.repeat(80)}..." (P(satisfied)=0.1, threshold 0.6)`);
});
test('A conditional criterion whose condition was not exercised resolves not_applicable',async()=>{
 const t=task(0,{acceptance:[{text:'Applies only to Node 18',when:'the change targets Node 18'}],jev:{mode:'shadow'}});
 const classifier=gateClassifier(JEVPASS,{AC1:bool(0.95),AC1_when:bool(0.05)});
 const r=await run(t,true,{classify:classifier});
 assert.equal(r.jev.postflight.criteria[0].verdict,'not_applicable');
});
test('A not-applicable criterion does not appear in the unresolved receipt',async()=>{
 const t=task(0,{acceptance:[{text:'Applies only to Node 18',when:'the change targets Node 18'}],jev:{mode:'shadow'}});
 const classifier=gateClassifier(JEVPASS,{AC1:bool(0.95),AC1_when:bool(0.05)});
 const h=compactHandoff(await run(t,true,{classify:classifier}));
 assert.deepEqual(h.unresolved,[]);
});
test('A not-applicable criterion does not block an enforce run',async()=>{
 const t=task(0,{acceptance:[{text:'Applies only to Node 18',when:'the change targets Node 18'}],jev:{mode:'enforce'}});
 const classifier=gateClassifier(JEVPASS,{AC1:bool(0.95),AC1_when:bool(0.05)});
 const r=await run(t,true,{classify:classifier});
 assert.equal(r.status,'simulation_passed');
});
test('A string-only acceptance contract keeps the existing met verdict',async()=>{
 const classifier=gateClassifier(JEVPASS,{AC1:bool(0.95)});
 const r=await run(task(0,{jev:{mode:'enforce'}}),true,{classify:classifier});
 assert.equal(r.jev.postflight.criteria[0].verdict,'met');
});
test('validate accepts an object acceptance item with text and when',()=>{
 assert.doesNotThrow(()=>validate({...task(),acceptance:[{text:'conditional criterion',when:'condition holds'}]}));
});
test('validate rejects an acceptance object with empty text',()=>{
 assert.throws(()=>validate({...task(),acceptance:[{text:'   '}]}),/acceptance/i);
});
test('validate rejects an acceptance object with an empty when condition',()=>{
 assert.throws(()=>validate({...task(),acceptance:[{text:'criterion',when:'   '}]}),/when/i);
});
test('Preflight state carries the acceptance text for object items',async()=>{
 let preState:any;
 const classifier:any=async({state,questions}:any)=>{
  if(Object.prototype.hasOwnProperty.call(questions,'contract_clear')) preState=state;
  const isPre=Object.prototype.hasOwnProperty.call(questions,'contract_clear');
  return {stopReason:'stop',provider:'openrouter',model:'typesafe/jev-1.13',answers:isPre?JEVPASS:{AC1:bool(0.95)},usage:gateUsage};
 };
 await run(task(0,{acceptance:[{text:'object criterion text',when:'condition'}],jev:{mode:'shadow'}}),true,{classify:classifier});
 assert.deepEqual(preState.acceptance,['object criterion text']);
});
test('Postflight state carries the acceptance text for object items',async()=>{
 let postState:any;
 const classifier:any=async({state,questions}:any)=>{
  if(!Object.prototype.hasOwnProperty.call(questions,'contract_clear')) postState=state;
  const isPre=Object.prototype.hasOwnProperty.call(questions,'contract_clear');
  return {stopReason:'stop',provider:'openrouter',model:'typesafe/jev-1.13',answers:isPre?JEVPASS:{AC1:bool(0.95)},usage:gateUsage};
 };
 await run(task(0,{acceptance:[{text:'object criterion text',when:'condition'}],jev:{mode:'shadow'}}),true,{classify:classifier});
 assert.deepEqual(postState.acceptance,['object criterion text']);
});

// --- Issue #23: evidence labels stop overstating certainty (offline) ---
test('fmeca prompt requires quoting the cited span before a proven-here label',()=>{
 const prompt=buildPrompt(task(0,{workflow:'fmeca'}),'fmeca');
 assert.ok(prompt.includes('quote the cited span (a few lines, with path:line)'));
});
test('evaluate prompt requires quoting the cited span before a proven-here label',()=>{
 const prompt=buildPrompt(task(0,{workflow:'evaluate'}),'evaluate');
 assert.ok(prompt.includes('quote the cited span (a few lines, with path:line)'));
});
test('recon prompt labels an unquoted proven-here claim inferred',()=>{
 const prompt=buildPrompt(task(0,{workflow:'recon'}),'recon');
 assert.ok(prompt.includes('inferred, not proven-here'));
});
test('test_first prompt omits the evidence-quote rule',()=>{
 const prompt=buildPrompt(task(0,{workflow:'test_first'}),'test_first');
 assert.ok(!prompt.includes('quote the cited span (a few lines, with path:line)'));
});
test('analysis report block requires quoting the cited span before a proven-here label',()=>{
 assert.ok(analysisReportBlock('/tmp/art/analysis-report.md').includes('quote the cited span (a few lines, with path:line)'));
});
test('The fmeca prompt tells the worker how to consult the TRIZ catalog without a paid call',()=>{
 assert.match(buildPrompt(task(),'fmeca'),/`triz catalog`/);
});

// --- B07 progress reporting, live status and slow-mount detection ---
test('detectSlowMount flags a /mnt drive-letter checkout',()=>{
 assert.ok(detectSlowMount('/mnt/c/repo',{readMounts:()=>''}));
});
test('detectSlowMount flags a 9p mounted checkout',()=>{
 assert.ok(detectSlowMount('/mnt/shared/repo',{readMounts:()=>'//server /mnt/shared 9p rw 0 0\n'}));
});
test('detectSlowMount ignores a native home checkout',()=>{
 assert.equal(detectSlowMount('/home/u/repo',{readMounts:()=>'//server /mnt/shared 9p rw 0 0\n'}),null);
});
test('doctor includes a slow-mount warning for a 9p checkout',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-slow-'));
 const d=doctor(setupDeps(cwd,{readMounts:()=>`client ${cwd} 9p rw 0 0\n`}));
 assert.equal(d.warnings.length,1);
});
test('RuntimeHeartbeat emits a heartbeat line through the progress sink',()=>{
 const dir=mkdtempSync(join(tmpdir(),'delivery-hb-'));
 const lines:string[]=[];
 const now=Date.now();
 const hb=new RuntimeHeartbeat(join(dir,'runtime.json'),{...EXECUTION_DEFAULTS,heartbeatMs:1000},now,now+10000,'worker',(l)=>lines.push(l));
 hb.begin();
 hb.poll(now+1000,'bash',50);
 assert.ok(lines.some((l)=>/^heartbeat \d+s tool=bash$/.test(l)));
});
test('Mock run reports the worker phase through the injected progress sink',async()=>{
 const lines:string[]=[];
 await run(task(),true,{progress:(l)=>lines.push(l)});
 assert.ok(lines.some((l)=>/worker/.test(l)));
});
test('Mock run reports each check through the injected progress sink',async()=>{
 const lines:string[]=[];
 await run(task(),true,{progress:(l)=>lines.push(l)});
 assert.ok(lines.some((l)=>/^check 1\/1\b/.test(l)));
});

// --- JUNIOR_NO_INSTALL guard (issue #28) -------------------------------------

test('Init with JUNIOR_NO_INSTALL and a missing Pi invokes no exec',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-noinstall-'));
 const calls:any[]=[];
 const deps=setupDeps(cwd,{env:{JUNIOR_NO_INSTALL:'1'},exec:(cmd:string,args:string[],opts:any)=>{calls.push({cmd,args,opts});return okExec(cmd,args);}});
 init(deps,{install:true});
 assert.equal(calls.length,0);
});
test('Init with JUNIOR_NO_INSTALL reports the Pi install as skipped',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-noinstall-'));
 const deps=setupDeps(cwd,{env:{JUNIOR_NO_INSTALL:'1'}});
 const r:any=init(deps,{install:true});
 assert.equal(r.install.skipped,'JUNIOR_NO_INSTALL');
});
test('junior init spawned with JUNIOR_NO_INSTALL and an empty PATH exits successfully',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-noinstall-'));
 const r=spawnSync(process.execPath,[join(process.cwd(),'junior.ts'),'init'],{encoding:'utf8',cwd,env:{...process.env,PATH:'',HOME:cwd,PI_CODING_AGENT_DIR:join(cwd,'agent'),JUNIOR_NO_INSTALL:'1'}});
 assert.equal(r.status,0,r.stderr);
});
test('junior init spawned with JUNIOR_NO_INSTALL reports an unattempted install summary',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-noinstall-'));
 const r=spawnSync(process.execPath,[join(process.cwd(),'junior.ts'),'init'],{encoding:'utf8',cwd,env:{...process.env,PATH:'',HOME:cwd,PI_CODING_AGENT_DIR:join(cwd,'agent'),JUNIOR_NO_INSTALL:'1'}});
 assert.equal(JSON.parse(r.stdout).installSummary.attempted,false);
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
test('A worker run past the output cap marks the receipt truncated tail',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fake=makeFakeChild();
 const t=okTask(repo,{id:'cap-tail',execution:{deadlineMs:30000,quietMs:100000,heartbeatMs:20,toolTimeoutMs:5000,checkTimeoutMs:5000}});
 const p=run(t,false,{spawnChild:()=>fake.child,maxOutputBytes:128});
 fake.emitRaw('x'.repeat(200000));
 fake.end(0);
 const r=await p;
 assert.equal(r.receipt.truncatedTail,true);
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
