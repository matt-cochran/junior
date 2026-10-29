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

// --- D06 init/doctor (offline; no installs, no paid calls) ---
test('Doctor reports ready from injected pi, credentials and local catalog',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-doc-'));
 const bin=withPiDir(cwd); const agent=writeAgent(cwd);
 const d=doctor(setupDeps(cwd,{env:{PATH:bin,PI_CODING_AGENT_DIR:agent},execPath:join(bin,'node')}));
 assert.equal(d.command,'doctor');
 assert.equal(d.ok,true);
 assert.equal(d.node.supported,true);
 assert.equal(d.pi.found,true);
 assert.equal(d.pi.version,TESTED_PI_VERSION);
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
 const deps=setupDeps(cwd,{installedPi:{name:PI_PACKAGE,version:TESTED_PI_VERSION}});
 const first:any=init(deps);
 assert.equal(first.command,'init');
 assert.ok(first.created.includes('delivery.config.json'));
 assert.ok(first.created.includes('tasks/example-task.json'));
 const cfg=JSON.parse(readFileSync(join(cwd,'delivery.config.json'),'utf8'));
 assert.equal(cfg.provider,DEFAULT_PROVIDER);
 assert.equal(cfg.model,DEFAULT_MODEL);
 assert.equal(cfg.pi.testedVersion,TESTED_PI_VERSION);
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
 const deps=setupDeps(cwd,{installedPi:{name:PI_PACKAGE,version:TESTED_PI_VERSION},exec:(cmd:string,args:string[],opts:any)=>{calls.push({cmd,args,opts});return okExec(cmd,args);}});
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
 const deps=setupDeps(cwd,{installedPi:{name:PI_PACKAGE,version:TESTED_PI_VERSION},exec});
 const r:any=init(deps,{install:true});
 assert.equal(r.install.requested,true);
 assert.equal(r.install.attempted,true);
 assert.equal(r.install.ok,true);
 const npm=calls.find((c)=>c.cmd==='npm');
 assert.deepEqual(npm.args,['install','-g','--ignore-scripts',`${PI_PACKAGE}@${TESTED_PI_VERSION}`]);
 assert.equal(npm.opts.timeout,INSTALL_TIMEOUT_MS);
 assert.equal(npm.opts.shell,undefined);
});
test('Discover installed Pi name/version from the local package.json',()=>{
 const info=discoverInstalledPi({execPath:'/mock/bin/node', readFile:()=>JSON.stringify({name:PI_PACKAGE,version:TESTED_PI_VERSION})});
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
 const r2=await run(task(0,{cwd,provider:'openrouter',model:'moonshotai/kimi-k3',approveModel:'moonshotai/kimi-k3'}),true);
 assert.equal(r2.receipt.requested.provider,'openrouter');
 assert.equal(r2.receipt.requested.model,'moonshotai/kimi-k3');
});

// --- D06b init local exclusions + immediate mock handoff (real Git fixtures) ---
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
test('Changed packaged skill leaves an unchanged installed copy in place when upgrade is disabled',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const src=skillSource('v1\n'); const deps=setupDeps(cwd,{skillSource:src});
 init(deps,{target:'codex'}); writeFileSync(src,'v2\n');
 init(deps,{target:'codex',upgrade:false});
 assert.equal(readFileSync(codexSkill(cwd),'utf8'),'v1\n');
});
test('Changed packaged skill is reported as outdated when upgrade is disabled',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const src=skillSource('v1\n'); const deps=setupDeps(cwd,{skillSource:src});
 init(deps,{target:'codex'}); writeFileSync(src,'v2\n');
 assert.equal(init(deps,{target:'codex',upgrade:false}).skill.actions[0].status,'outdated');
});
test('Default init refreshes an unmodified outdated skill copy',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const src=skillSource('v1\n'); const deps=setupDeps(cwd,{skillSource:src});
 init(deps,{target:'codex'}); writeFileSync(src,'v2\n');
 init(deps,{target:'codex'});
 assert.equal(readFileSync(codexSkill(cwd),'utf8'),'v2\n');
});
test('Default init reports an unmodified outdated skill as upgraded',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-skill-')); const src=skillSource('v1\n'); const deps=setupDeps(cwd,{skillSource:src});
 init(deps,{target:'codex'}); writeFileSync(src,'v2\n');
 assert.equal(init(deps,{target:'codex'}).skill.actions[0].status,'upgraded');
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
test('Doctor warns that the Junior skill is missing with the affected managers',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-doc-'));
 assert.ok(doctor(setupDeps(cwd)).warnings.includes('Junior skill is not installed (claude, codex); run `junior init`'));
});
test('Doctor does not call a user-level Junior skill missing',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-doc-')); const home=mkdtempSync(join(tmpdir(),'delivery-home-'));
 init(setupDeps(cwd),{scope:'user',skillRoot:join(home,'.claude','skills')});
 assert.equal(doctor(setupDeps(cwd,{env:{HOME:home}})).warnings.some((w:string)=>w.startsWith('Junior skill is not installed')),false);
});
test('Doctor warns that the Junior skill is outdated with the affected managers',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-doc-')); const src=skillSource('v1\n'); const deps=setupDeps(cwd,{skillSource:src});
 init(deps); writeFileSync(src,'v2\n');
 assert.ok(doctor(deps).warnings.includes('Junior skill is outdated (claude, codex); run `junior update`'));
});
test('Doctor warns that a customized Junior skill is preserved with the affected managers',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-doc-')); const deps=setupDeps(cwd);
 init(deps); writeFileSync(claudeSkill(cwd),'custom\n');
 assert.ok(doctor(deps).warnings.includes('Junior skill is customized (claude); it is preserved; `junior init --force` replaces it'));
});
test('Doctor remediation repeats the missing Junior skill guidance',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-doc-'));
 assert.ok(doctor(setupDeps(cwd)).remediation.includes('Junior skill is not installed (claude, codex); run `junior init`'));
});
test('Doctor remediation repeats the outdated Junior skill guidance',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-doc-')); const src=skillSource('v1\n'); const deps=setupDeps(cwd,{skillSource:src});
 init(deps); writeFileSync(src,'v2\n');
 assert.ok(doctor(deps).remediation.includes('Junior skill is outdated (claude, codex); run `junior update`'));
});
test('Doctor remediation repeats the customized Junior skill guidance',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-doc-')); const deps=setupDeps(cwd);
 init(deps); writeFileSync(claudeSkill(cwd),'custom\n');
 assert.ok(doctor(deps).remediation.includes('Junior skill is customized (claude); it is preserved; `junior init --force` replaces it'));
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

// --- companion tools and default install (offline; injected seams, temporary Git repos) ---
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

// --- B09 opt-in online credential check (injected fetch; never real network) ---
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
 assert.ok(d.warnings.some((w)=>w.startsWith('Slow Windows-mounted checkout')));
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


