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
 validateReadScope,validateBudget,validateScopeExpansion,scopeExpansionPaths,resolveContext,readScopePathMatches,contractWarnings,doctor as workerDoctor } from './worker.ts';
import { doctor,init,setupCompanions,installSkill,inspectSkill,parseInitOptions,discoverInstalledPi,loadDefaults,checkCredentialsOnline,detectSlowMount,SUPPORTED_NODE_MIN,DEFAULT_PROVIDER,DEFAULT_MODEL,PI_PACKAGE,INSTALL_TIMEOUT_MS,PACKAGED_SKILL_PATH,TESTED_PI_VERSION } from './setup.ts';
import { compactHandoff } from './handoff.ts';
import { recordExternalContextConsent } from './auth.ts';
import { GatewayError } from './gateway.ts';
import { loadPlaybooks } from './playbooks.ts';
import { seedSession, run, task, COMMODITY_MODEL, ROUTED_MODEL, cli, resultFile, saved, U, assistant, stream, documentation, bool, gateUsage, gateClassifier, outage, JEVPASS, jsonFetch, captureFetch, typesafeGateway, stubClassifier, PRICING, costReceipt, choice, workflowClassifier, CONTINUATION_CAP, until, continuationFixture, firstAssistant, exhaustCap, completeSegment, driveToContinuation, lengthSegment, driveLengthToContinuation, SESSION_A, priorResult, okExec, setupDeps, writeAgent, withPiDir, modelGate, routingCwd, routeConfig, approvalCwd, pricedAgent, approvalFile, initRepo, exampleTaskFrom, skillSource, codexSkill, claudeSkill, gitRepo, commitFile, wtTask, okSpawn, okTask, priorNone, delay, artifactFor, readRuntime, makeFakeChild, waitForPid, aliveAfter, termIgnoringDescendant, handoffResult, addNestedPackage, cwdCheck, makeDirLink, markerCheck, symlinkEscape, tempGitRepo, localExclude, emptyQuestionHop, artifactTask, deliveryPath, onlineAgent, capturePreflight, contextdir, linkRepo, routingClassifier, routingSeam, routingPlan, stickyCwd, stickyFile, isolationCapabilities, bounded } from './worker-helpers.test.ts';

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

// --- WIRE10: Pi isolation, scope handoff and the explicit-workflow clarity gate ---
test('Validation rejects a piContext skill entry that is not a non-empty string',()=>{
 assert.throws(()=>validate(task(0,{piContext:{skills:['']}})),/Invalid piContext\.skills/);
});
test('Validation rejects a blank clarifiedFrom path',()=>{
 assert.throws(()=>validate(task(0,{clarifiedFrom:' '})),/Invalid clarifiedFrom/);
});
test('Validation rejects a scope owned entry that is not a path',()=>{
 assert.throws(()=>validate(task(0,{scope:{owned:[{path:''}]}})),/Invalid scope\.owned/);
});
test('Validation rejects a non-string scope incidental glob',()=>{
 assert.throws(()=>validate(task(0,{scope:{owned:['a.ts'],incidental:[1]}})),/Invalid scope\.incidental/);
});
test('Pi argv appends the run isolation arguments after the guard extension',()=>{
 assert.deepEqual(buildPiArgs({provider:'openrouter',model:'m'},null,undefined,undefined,['--no-extensions','--no-mcp']),['--provider','openrouter','--model','m','--mode','json','-e',piGuardModulePath(),'--no-extensions','--no-mcp']);
});
test('A live run passes its supported isolation flags to Pi',async()=>{
 let seen:string[]=[];
 const spawnPi=(_c:string,args:string[])=>{seen=args;return {status:0,stdout:stream({type:'session',id:'s'},assistant(),{type:'agent_settled'}),stderr:''};};
 await run(task(0),false,{spawnPi,piCapabilities:isolationCapabilities});
 assert.ok(seen.includes('--no-extensions'));
});
test('A live run records the probed Pi isolation plan on the result',async()=>{
 const spawnPi=()=>({status:0,stdout:stream({type:'session',id:'s'},assistant(),{type:'agent_settled'}),stderr:''});
 const r=await run(task(0),false,{spawnPi,piCapabilities:isolationCapabilities});
 assert.deepEqual(r.piIsolation,{applied:['--no-extensions','--no-skills','--no-context-files','--no-prompt-templates','--no-approve','--no-mcp','--tools'],missing:[],ambient:false,probed:true,verification:{checked:false,honored:true,problems:[]}});
});
test('A live run whose Pi system message still lists ambient skills reports isolation not honored',async()=>{
 const system={type:'message_start',message:{role:'system',content:'',sections:{skills:'<skills><name>wrangler</name></skills>',tools:'<tools>\n- read: Read\n</tools>'}}};
 const spawnPi=()=>({status:0,stdout:stream({type:'session',id:'s'},system,assistant(),{type:'agent_settled'}),stderr:''});
 const r=await run(task(0),false,{spawnPi,piCapabilities:isolationCapabilities});
 assert.ok(compactHandoff(r).unresolved.includes('isolation not honored: ambient skills present despite --no-skills'));
});
test('A run with a scope records the scope classification on the result',async()=>{
 const r=await run(task(0,{scope:{owned:['src/*.ts']}}),true);
 assert.equal(r.scope.checked,true);
});
test('An explicit-workflow contract with a clarify readiness decision stops at needs_answers',async()=>{
 const classifier=gateClassifier({requires_frontier:bool(0.05),contract_clear:bool(0.2),blocking_assumptions:bool(0.05),contract_part:choice('acceptance',0.9)});
 const r=await run(task(0,{workflow:'test_first',jev:{mode:'shadow'}}),true,{classify:classifier,clarify:{callHop:emptyQuestionHop}});
 assert.equal(r.status,'needs_answers');
});
test('An explicit-workflow contract with a clarify readiness decision keeps its workflow',async()=>{
 const classifier=gateClassifier({requires_frontier:bool(0.05),contract_clear:bool(0.2),blocking_assumptions:bool(0.05),contract_part:choice('acceptance',0.9)});
 const r=await run(task(0,{workflow:'test_first',jev:{mode:'shadow'}}),true,{classify:classifier,clarify:{callHop:emptyQuestionHop}});
 assert.equal(r.workflow.selected,'test_first');
});
test('The compact handoff carries the run scope classification',()=>{
 const scope={checked:true,inScope:['src/a.ts'],incidental:[],outOfScope:['src/b.ts']};
 assert.deepEqual(compactHandoff(handoffResult({scope})).scope,scope);
});
test('The compact handoff lists out-of-scope changes as unresolved',()=>{
 const scope={checked:true,inScope:[],incidental:[],outOfScope:['src/a.ts','src/b.ts']};
 assert.ok(compactHandoff(handoffResult({scope})).unresolved.includes('out of scope: src/a.ts, src/b.ts'));
});

// --- #125: bounded read scope, budgets and explicit scope expansion ---
test('validate accepts a complete bounded-context contract',()=>{
 assert.doesNotThrow(()=>validate(bounded()));
});
test('validate rejects an unknown readScope mode',()=>{
 assert.throws(()=>validate(bounded({readScope:{mode:'everything'}})),/Invalid readScope\.mode/);
});
test('validate rejects a readScope path that escapes cwd',()=>{
 assert.throws(()=>validate(bounded({readScope:{mode:'context-only',paths:['../secret.ts']}})),/Invalid readScope\.paths/);
});
test('validate rejects a non-positive readScope maxFiles',()=>{
 assert.throws(()=>validate(bounded({readScope:{mode:'context-only',paths:[],maxFiles:0}})),/Invalid readScope\.maxFiles/);
});
test('validate rejects a non-boolean readScope allowGraft',()=>{
 assert.throws(()=>validate(bounded({readScope:{mode:'context-only',paths:[],allowGraft:'yes'}})),/Invalid readScope\.allowGraft/);
});
test('validate rejects a negative budget maxToolCalls',()=>{
 assert.throws(()=>validate(bounded({budget:{maxToolCalls:-1}})),/Invalid budget\.maxToolCalls/);
});
test('validate rejects a fractional budget maxInputTokens',()=>{
 assert.throws(()=>validate(bounded({budget:{maxInputTokens:1.5}})),/Invalid budget\.maxInputTokens/);
});
test('validate rejects an unknown budget field',()=>{
 assert.throws(()=>validate(bounded({budget:{maxSpend:1}})),/Unknown budget field/);
});
test('contract warnings explain that maxToolOutputBytes is a cumulative per-run cap',()=>{
 assert.match(contractWarnings(bounded({budget:{maxToolOutputBytes:1000}})).join(' '),/maxToolOutputBytes.*cumulative per-run.*at least 200000/i);
});
test('validate rejects a scope expansion without a reason',()=>{
 assert.throws(()=>validate(bounded({scopeExpansion:{paths:['src/b.ts']}})),/Invalid scopeExpansion\.reason/);
});
test('validate rejects a scope expansion with an absolute path',()=>{
 assert.throws(()=>validate(bounded({scopeExpansion:{paths:[join(tmpdir(),'b.ts')],reason:'need it'}})),/Invalid scopeExpansion\.paths/);
});
test('context-only refuses an undeclared context read without returning its text',()=>{
 const dir=contextdir('secret.ts','TOP SECRET\n');
 const t=task(0,{cwd:dir,readScope:{mode:'context-only',paths:['allowed.ts']},context:[{path:'secret.ts'}]});
 const [entry]=resolveContext(t);
 assert.equal(entry.text,undefined);
});
test('context-only permits a context path named in its read scope',()=>{
 const dir=contextdir('allowed.ts','ALLOWED\n');
 const t=task(0,{cwd:dir,readScope:{mode:'context-only',paths:['allowed.ts']},context:[{path:'allowed.ts'}]});
 const [entry]=resolveContext(t);
 assert.equal(entry.text,'ALLOWED');
});
test('scope expansion paths are returned in deterministic sorted order',()=>{
 const t=bounded({scopeExpansion:{paths:['src/z.ts','src/a.ts','src/z.ts'],reason:'needed'}});
 assert.deepEqual(scopeExpansionPaths(t),['src/a.ts','src/z.ts']);
});
test('an absent scope expansion grants no paths',()=>{
 assert.deepEqual(scopeExpansionPaths(bounded()),[]);
});
test('a read-scope path treats dots literally',()=>{
 assert.equal(readScopePathMatches('src/a.ts','src/aXts'),false);
});
test('the worker prompt states the context-only read boundary',()=>{
 const prompt=buildPrompt(bounded({readScope:{mode:'context-only',paths:['src/a.ts']}}),'test_first');
 assert.match(prompt,/Read scope: context-only/);
});
test('the worker prompt names an approved scope expansion',()=>{
 const prompt=buildPrompt(bounded({scopeExpansion:{paths:['src/b.ts'],reason:'needed for the fix'}}),'test_first');
 assert.match(prompt,/Scope expansion approved: src\/b\.ts \(needed for the fix\)/);
});

// --- external-context consent before provider work -------------------------

test('a run without external-context consent needs consent before provider work', async () => {
 const r=await run(task(0,{externalContextConsent:false}),true);
 assert.equal(r.status,'needs_external_context_consent');
});

test('external-context preflight names the destination and egress possibility', async () => {
 const r=await run(task(0,{externalContextConsent:false}),true);
 assert.equal(r.externalContext.preflight.destination,'https://openrouter.ai/api/v1');
});

test('external-context preflight discloses the model and context file scope', async () => {
 const cwd=mkdtempSync(join(tmpdir(),'delivery-'));
 writeFileSync(join(cwd,'source.ts'),'secret source text\n');
 const r=await run(task(0,{cwd,context:[{path:'source.ts'}],externalContextConsent:false}),true);
 assert.deepEqual(r.externalContext.preflight.scope.files,['source.ts']);
});

test('a recorded project consent authorizes the provider handoff', async () => {
 const cwd=mkdtempSync(join(tmpdir(),'delivery-'));
 recordExternalContextConsent(cwd,'openrouter');
 const r=await run(task(0,{cwd,externalContextConsent:false}),true);
 assert.equal(r.status,'simulation_passed');
});

test('a consented run receipt records the external-context authorization source', async () => {
 const r=await run(task(0,{externalContextConsent:true}),true);
 assert.equal(r.externalContext.authorization.source,'run');
});

test('compact handoff exposes external-context egress and authorization', () => {
 const h=compactHandoff({id:'x',status:'simulation_passed',checks:[],artifactDir:'/tmp/a',externalContext:{preflight:{provider:'openrouter',destination:'https://openrouter.ai/api/v1',model:'m',egress:{possible:true}},authorization:{granted:true,source:'run'}}});
 assert.equal(h.externalContext.authorization.source,'run');
});

test('doctor separates runtime readiness from external-context authorization', () => {
 const d=workerDoctor({cwd:mkdtempSync(join(tmpdir(),'delivery-'))});
 assert.equal(d.externalContextAuthorization.readyForDelegation,false);
});

