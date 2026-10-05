import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validate,run,parseReceipt,mockReceipt,receiptValid,emptyUsage,
 jevMode,boundEvidence,boundedGitEvidence,resolveClassifierModel,
 estimateCost,validatePricing,
 taskWorkflow,decideWorkflow,choiceVerdict,buildPrompt,promptParts,buildPiArgs,
 resolveResume,loadResume,COMMON_PROMPT_BLOCK,WORKFLOW_PROMPT_BLOCKS,WORKFLOW_TEMPLATE_IDS } from './worker.ts';
import { doctor,init,discoverInstalledPi,loadDefaults,SUPPORTED_NODE_MIN,DEFAULT_PROVIDER,DEFAULT_MODEL,PI_PACKAGE,INSTALL_TIMEOUT_MS } from './setup.ts';
const task=(code=0,extra:any={})=>({id:'smoke',deliverable:'Smoke test',cwd:mkdtempSync(join(tmpdir(),'delivery-')),acceptance:['Check passes'],checks:[{command:process.execPath,args:['-e',`process.exit(${code})`]}],...extra});
const cli=(args:string[])=>spawnSync(process.execPath,['worker.ts',...args],{encoding:'utf8'});
const resultFile=(value:any)=>{const f=join(mkdtempSync(join(tmpdir(),'delivery-')),'result.json');writeFileSync(f,typeof value==='string'?value:JSON.stringify(value));return f;};
const saved=(status:string)=>({id:'smoke',status,checks:[{command:'node',args:['-e',''],exitCode:status==='checks_failed'?1:0}],artifactDir:'/tmp/artifact'});

const U=(input:number,output:number,total:number)=>({input,output,cacheRead:0,cacheWrite:0,totalTokens:total,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}});
const assistant=(over:any={})=>JSON.stringify({type:'message_end',message:{role:'assistant',provider:'openrouter',model:'m',usage:U(1,2,3),stopReason:'stop',...over}});
const stream=(...records:any[])=>records.map((r:any)=>typeof r==='string'?r:JSON.stringify(r)).join('\n')+'\n';

// --- offline Jev classifier mocks: no SDK load, no paid calls ---
const bool=(p:number)=>({type:'bool',probability:p});
const gateUsage={input:5,output:2,totalTokens:7,cost:{total:0.0002}};
const gateClassifier=(pre:any,post:any={AC1:bool(0.95)}):any=>async({questions}:any)=>{
 const isPre=Object.prototype.hasOwnProperty.call(questions,'contract_clear');
 return {stopReason:'stop',provider:'openrouter',model:'typesafe/jev-1.13',answers:isPre?pre:post,usage:gateUsage};
};
const outage:any=async()=>({stopReason:'error',errorMessage:'classifier outage'});
const JEVPASS={contract_clear:bool(0.95),blocking_assumptions:bool(0.05)};

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
 for(const w of ['recon','test_first','checks_first','auto']) assert.doesNotThrow(()=>validate(task(0,{workflow:w})));
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
test('Pi argv passes explicit --session on resume and never --continue',()=>{
 assert.deepEqual(buildPiArgs({provider:'openrouter',model:'m'},'sess'),['--provider','openrouter','--model','m','--mode','json','--session','sess']);
 assert.deepEqual(buildPiArgs({provider:'openrouter',model:'m'}),['--provider','openrouter','--model','m','--mode','json']);
 assert.ok(!buildPiArgs({provider:'openrouter',model:'m'},'sess').includes('--continue'));
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
 const md=readFileSync(join(process.cwd(),'README.md'),'utf8');
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
