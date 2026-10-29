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

// --- estimated execution cost (offline; no pricing is fetched) ---
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
test('buildPrompt shows the execution checkout as the contract cwd',()=>{
 const source='/source/repo';
 const execution='/source/repo/.delivery/wt';
 const prompt=buildPrompt(task(0,{cwd:source,workflow:'test_first'}),'test_first',null,null,null,null,null,execution);
 const contract=JSON.parse(prompt.slice(prompt.indexOf('Task contract (JSON):\n')+'Task contract (JSON):\n'.length));
 assert.equal(contract.cwd,execution);
});
test('buildPrompt never embeds the source checkout as the contract cwd',()=>{
 const source='/source/repo';
 const execution='/source/repo/.delivery/wt';
 const prompt=buildPrompt(task(0,{cwd:source,workflow:'test_first'}),'test_first',null,null,null,null,null,execution);
 assert.ok(!prompt.includes(`"cwd":${JSON.stringify(source)}`));
});
test('buildPrompt names the execution checkout and the off-limits source',()=>{
 const t=task(0,{workflow:'test_first'});
 assert.ok(buildPrompt(t,'test_first').includes(`Execution checkout: ${t.cwd}. Read and write files only inside it (use relative paths); the source checkout is off limits.`));
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
 assert.deepEqual([...ANALYSIS_WORKFLOWS],['recon','fmeca','evaluate','discover','investigate','prepare']);
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
 const r=await run(task(0,{workflow:'evaluate',provider:'openrouter',model:COMMODITY_MODEL}),false,{spawnPi});
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
test('reportEvidence lists markdown headings in order',()=>{
 const r=reportEvidence('# Report\nintro\n## Risk\nbody\n### Detail\nend\n','/tmp/report.md');
 assert.deepEqual(r.outline,['# Report','## Risk','### Detail']);
});
test('reportEvidence truncates the excerpt at a line boundary',()=>{
 const r=reportEvidence('# R\nline-1\nline-2\nline-3\n','/tmp/report.md',{maxExcerptBytes:12});
 assert.deepEqual({excerpt:r.excerpt,truncated:r.truncated},{excerpt:'# R\nline-1\n',truncated:true});
});
test('assessPostflight puts a supplied analysis report in the classifier state',async()=>{
 let seen:any;
 const classify:any=async({state}:any)=>{seen=state;return {answers:{AC1:bool(0.95)}};};
 const report={path:'/tmp/report.md',outline:['# Report'],excerpt:'# Report\n',bytes:9,truncated:false};
 await assessPostflight({deliverable:'Review',acceptance:['Report exists']},classify,[],{stat:'',diff:'',truncated:false,changedFiles:[],limits:{}},undefined,undefined,{report});
 assert.deepEqual(seen.report,report);
});
test('assessPostflight instructions name the analysis report when supplied',async()=>{
 let questions:any;
 const classify:any=async({questions:q}:any)=>{questions=q;return {answers:{AC1:bool(0.95)}};};
 const report={path:'/tmp/report.md',outline:['# Report'],excerpt:'# Report\n',bytes:9,truncated:false};
 await assessPostflight({deliverable:'Review',acceptance:['Report exists']},classify,[],{stat:'',diff:'',truncated:false,changedFiles:[],limits:{}},undefined,undefined,{report});
 assert.match(questions.AC1.instructions,/analysis report outline and excerpt/);
});
test('deterministicCriterion marks an unchanged report-only change set met',()=>{
 assert.equal(deterministicCriterion('No file other than the report is changed',{changedFiles:[],allowed:[]}),'met');
});
test('deterministicCriterion marks a non-allowed changed file as a gap',()=>{
 assert.equal(deterministicCriterion('no other files are changed',{changedFiles:['src/worker.ts'],allowed:[]}),'gap');
});
test('deterministicCriterion ignores an unrelated acceptance criterion',()=>{
 assert.equal(deterministicCriterion('The report explains every risk',{changedFiles:['src/worker.ts'],allowed:[]}),null);
});
test('assessPostflight does not send a deterministic criterion to the classifier',async()=>{
 let calls=0;
 const classify:any=async()=>{calls++;return {answers:{}};};
 await assessPostflight({deliverable:'Review',acceptance:['changes no files']},classify,[],{stat:'',diff:'',truncated:false,changedFiles:[],limits:{}});
 assert.equal(calls,0);
});
test('validate rejects an acceptance.id with a space',()=>{
 assert.throws(()=>validate(task(0,{acceptance:[{id:'a b',text:'x'}]})),/Invalid acceptance\.id/);
});
test('validate rejects duplicate acceptance ids',()=>{
 assert.throws(()=>validate(task(0,{acceptance:[{id:'x',text:'a'},{id:'x',text:'b'}]})),/Duplicate acceptance\.id/);
});
test('validate rejects an acceptance.checks index beyond the checks array',()=>{
 const checks=[{command:process.execPath,args:['-e','process.exit(0)']},{command:process.execPath,args:['-e','process.exit(0)']}];
 assert.throws(()=>validate(task(0,{acceptance:[{text:'t',checks:[5]}],checks})),/Invalid acceptance\.checks/);
});
test('assessPostflight reports a supplied acceptance id',async()=>{
 const classify:any=async()=>({answers:{AC1:bool(0.95)}});
 const r=await assessPostflight({deliverable:'Review',acceptance:[{id:'req:c1/ac1',text:'t'}]},classify,[],{stat:'',diff:'',truncated:false,changedFiles:[],limits:{}});
 assert.equal(r.criteria[0].id,'req:c1/ac1');
});
test('assessPostflight infers no id for string acceptance entries by position',async()=>{
 const classify:any=async()=>({answers:{AC1:bool(0.95),AC2:bool(0.95)}});
 const r=await assessPostflight({deliverable:'Review',acceptance:['a','b']},classify,[],{stat:'',diff:'',truncated:false,changedFiles:[],limits:{}});
 assert.deepEqual(r.criteria.map((c)=>c.id),['AC1','AC2']);
});
test('assessPostflight copies mitigates from the contract entry',async()=>{
 const classify:any=async()=>({answers:{AC1:bool(0.95)}});
 const r=await assessPostflight({deliverable:'Review',acceptance:[{id:'req:c1/ac1',text:'t',mitigates:['s1/m1']}]},classify,[],{stat:'',diff:'',truncated:false,changedFiles:[],limits:{}});
 assert.deepEqual(r.criteria[0].mitigates,['s1/m1']);
});
test('assessPostflight tiers a met criterion whose named check passed as check_passed',async()=>{
 const classify:any=async()=>({answers:{AC1:bool(0.95)}});
 const r=await assessPostflight({deliverable:'Review',acceptance:[{text:'t',checks:[0]}]},classify,[{exitCode:0}],{stat:'',diff:'',truncated:false,changedFiles:[],limits:{}});
 assert.equal(r.criteria[0].tier,'check_passed');
});
test('assessPostflight tiers a met criterion whose named check failed as not check_passed',async()=>{
 const classify:any=async()=>({answers:{AC1:bool(0.95)}});
 const r=await assessPostflight({deliverable:'Review',acceptance:[{text:'t',checks:[0]}]},classify,[{exitCode:1}],{stat:'',diff:'',truncated:false,changedFiles:[],limits:{}});
 assert.notEqual(r.criteria[0].tier,'check_passed');
});
test('assessPostflight tiers an uncertain criterion whose named check passed as check_passed',async()=>{
 const classify:any=async()=>({answers:{AC1:bool(0.5)}});
 const r=await assessPostflight({deliverable:'Review',acceptance:[{text:'t',checks:[0]}]},classify,[{exitCode:0}],{stat:'',diff:'',truncated:false,changedFiles:[],limits:{}});
 assert.equal(r.criteria[0].tier,'check_passed');
});
test('An fmeca run passes its written report to the postflight classifier',async()=>{
 let postState:any;
 const classifier:any=async({state,questions}:any)=>{
  const isPre=Object.prototype.hasOwnProperty.call(questions,'contract_clear');
  if(!isPre) postState=state;
  return {stopReason:'stop',provider:'openrouter',model:'typesafe/jev-1.13',answers:isPre?JEVPASS:{AC1:bool(0.95)},usage:gateUsage};
 };
 const spawnPi=(_c:string,args:string[])=>{
  const prompt=args[args.length-1];
  const m=/exact artifact path: ([^\n]+)/.exec(prompt);
  if(m) writeFileSync(m[1],'# Analysis report\n## Risks\n');
  return {status:0,stdout:stream({type:'session',id:SESSION_A},assistant(),{type:'agent_settled'}),stderr:''};
 };
 await run(task(0,{workflow:'fmeca',provider:'openrouter',model:COMMODITY_MODEL,jev:{mode:'shadow'}}),false,{spawnPi,classify:classifier});
 assert.deepEqual(postState.report.outline,['# Analysis report','## Risks']);
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
 writeFileSync(join(parentDir,'result.json'),JSON.stringify(priorResult(cwd,{workflow:{selected:'fmeca'}})));seedSession(parentDir);
 const classifier:any=workflowClassifier({...JEVPASS, workflow:choice('test_first',0.95)});
 const t=task(0,{cwd,provider:'openrouter',model:COMMODITY_MODEL,workflow:'auto',jev:{mode:'shadow'},resumeFrom:join(parentDir,'result.json')});
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
test('A live run reports the streaming output breakdown',async()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const fake=makeFakeChild();
 const t=okTask(repo,{id:'breakdown',execution:{quietMs:100000,heartbeatMs:20,toolTimeoutMs:5000,checkTimeoutMs:5000,deadlineMs:30000}});
 const p=run(t,false,{spawnChild:()=>fake.child});
 fake.emit({type:'session',id:'s'});
 fake.emit({type:'message_end',message:{role:'assistant',provider:'openrouter',model:'m',usage:U(1,1,2),stopReason:'stop'}});
 fake.emit({type:'agent_settled'});
 fake.end(0);
 const r=await p;
 assert.ok(r.outputBreakdown && r.outputBreakdown.retainedBytes>0);
});
test('A mock run reports a null output breakdown',async()=>{
 const r=await run(task(),true);
 assert.equal(r.outputBreakdown,null);
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
// --- Issue #13/#16: compact labelled cost and token receipt (offline) ---
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
test('Compact receipt reports a 0.75 cache hit rate for 100 input and 300 cache reads',()=>{
 const h=compactHandoff({id:'c',status:'ready_for_review',receipt:{usage:{input:100,cacheRead:300,cacheWrite:0,totalTokens:400,available:true}}});
 assert.equal(h.model.cache.hitRate,0.75);
});
test('Compact receipt reports a null cache hit rate when input and cache reads are both zero',()=>{
 const h=compactHandoff({id:'c',status:'ready_for_review',receipt:{usage:{input:0,cacheRead:0,cacheWrite:0,totalTokens:0,available:true}}});
 assert.equal(h.model.cache.hitRate,null);
});
test('Compact receipt exposes the input token count in the cache projection',()=>{
 const h=compactHandoff({id:'c',status:'ready_for_review',receipt:{usage:{input:100,cacheRead:300,cacheWrite:0,totalTokens:400,available:true}}});
 assert.equal(h.model.cache.input,100);
});
test('Compact receipt exposes the cache-read token count in the cache projection',()=>{
 const h=compactHandoff({id:'c',status:'ready_for_review',receipt:{usage:{input:100,cacheRead:300,cacheWrite:4,totalTokens:400,available:true}}});
 assert.equal(h.model.cache.cacheRead,300);
});
test('Compact receipt exposes the cache-write token count in the cache projection',()=>{
 const h=compactHandoff({id:'c',status:'ready_for_review',receipt:{usage:{input:100,cacheRead:300,cacheWrite:4,totalTokens:400,available:true}}});
 assert.equal(h.model.cache.cacheWrite,4);
});
test('Compact handoff exposes the upstream provider aggregate from billing',()=>{
 const providers=[{provider:'DeepInfra',generations:2,cachedTokens:10}];
 assert.deepEqual(compactHandoff({id:'c',status:'ready_for_review',billing:{providers}}).model.upstream,providers);
});
test('Compact handoff reports a null upstream when billing captured no providers',()=>{
 assert.equal(compactHandoff({id:'c',status:'ready_for_review'}).model.upstream,null);
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


