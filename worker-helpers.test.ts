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
export const seedSession=(dir:string,id:string='123e4567-e89b-12d3-a456-426614174000')=>{const d=join(dir,'pi-agent','sessions','--prior--');mkdirSync(d,{recursive:true});writeFileSync(join(d,`2026-01-01T00-00-00-000Z_${id}.jsonl`),JSON.stringify({type:'session',id})+'\n');};
// Existing behavioral scenarios exercise non-consent behavior; inject the new
// explicit external-context consent unless the scenario overrides it.
export const run=(t:any,mock?:boolean,deps?:any)=>runWorker('externalContextConsent' in (t ?? {}) ? t : {...t,externalContextConsent:true},mock,deps);
export const task=(code=0,extra:any={})=>({id:'smoke',deliverable:'Smoke test',cwd:mkdtempSync(join(tmpdir(),'delivery-')),acceptance:['Check passes'],checks:[{command:process.execPath,args:['-e',`process.exit(${code})`]}],externalContextConsent:true,...extra});
export const COMMODITY_MODEL='deepseek/deepseek-v4.1-flash';
export const ROUTED_MODEL='moonshotai/kimi-k2.7-code';
export const cli=(args:string[])=>spawnSync(process.execPath,['worker.ts',...args],{encoding:'utf8'});
export const resultFile=(value:any)=>{const f=join(mkdtempSync(join(tmpdir(),'delivery-')),'result.json');writeFileSync(f,typeof value==='string'?value:JSON.stringify(value));return f;};
export const saved=(status:string)=>({id:'smoke',status,checks:[{command:'node',args:['-e',''],exitCode:status==='checks_failed'?1:0}],artifactDir:'/tmp/artifact'});

export const U=(input:number,output:number,total:number)=>({input,output,cacheRead:0,cacheWrite:0,totalTokens:total,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}});
export const assistant=(over:any={})=>JSON.stringify({type:'message_end',message:{role:'assistant',provider:'openrouter',model:'m',usage:U(1,2,3),stopReason:'stop',...over}});
export const stream=(...records:any[])=>records.map((r:any)=>typeof r==='string'?r:JSON.stringify(r)).join('\n')+'\n';

// The README documentation tests assert against the whole public documentation
// set: the README front page plus every file under docs/.
export const documentation=()=>[readFileSync(join(process.cwd(),'README.md'),'utf8'),...readdirSync(join(process.cwd(),'docs')).filter((f)=>f.endsWith('.md')).map((f)=>readFileSync(join(process.cwd(),'docs',f),'utf8'))].join('\n');

export const bool=(p:number)=>({type:'bool',probability:p});
export const gateUsage={input:5,output:2,totalTokens:7,cost:{total:0.0002}};
export const gateClassifier=(pre:any,post:any={AC1:bool(0.95)}):any=>async({questions}:any)=>{
 const isPre=Object.prototype.hasOwnProperty.call(questions,'contract_clear');
 return {stopReason:'stop',provider:'openrouter',model:'typesafe/jev-1.13',answers:isPre?pre:post,usage:gateUsage};
};
export const outage:any=async()=>({stopReason:'error',errorMessage:'classifier outage'});
export const JEVPASS={requires_frontier:bool(0.05),contract_clear:bool(0.95),blocking_assumptions:bool(0.05)};

export const jsonFetch=(body:any,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
export const captureFetch=(response:any)=>{const calls:any[]=[];const impl:any=async(url:string,init:any)=>{calls.push({url,init});return response;};return {calls,impl};};
export const typesafeGateway:any={kind:'typesafe',baseUrl:'https://api.typesafe.ai',model:'jev-latest',transport:'http',key:'ts-secret-key'};
export const stubClassifier=(modelDef:any):any=>async({questions}:any)=>{
 const isPre=Object.prototype.hasOwnProperty.call(questions,'contract_clear');
 return {stopReason:'stop',provider:'openrouter',model:modelDef.id,answers:isPre?JEVPASS:{AC1:bool(0.95)},usage:gateUsage};
};

export const PRICING={input:1,output:2,cacheRead:0.5,cacheWrite:0.25,source:'test-fixture',date:'2025-01-01'};
// 1M input, 2M output, 1M cacheRead, 1M cacheWrite, raw Pi cost reported as 0.
export const costReceipt=(over:any={})=>parseReceipt(stream(
 JSON.stringify({type:'message_end',message:{role:'assistant',provider:'openrouter',model:'m',usage:{input:1_000_000,output:2_000_000,cacheRead:1_000_000,cacheWrite:1_000_000,totalTokens:5_000_000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0},...over},stopReason:'stop'}}),
 {type:'agent_settled'}));

export const choice=(c:string,confidence=0.9)=>({type:'choice',choice:c,probabilities:{[c]:confidence},confidence});
export const workflowClassifier=(pre:any,post:any={AC1:bool(0.95)}):any=>{
 let sawWorkflow=false;
 const classify:any=async({questions}:any)=>{
  const isPre=Object.prototype.hasOwnProperty.call(questions,'contract_clear');
  if(isPre) sawWorkflow=Object.prototype.hasOwnProperty.call(questions,'workflow');
  return {stopReason:'stop',provider:'openrouter',model:'typesafe/jev-1.13',answers:isPre?pre:post,usage:gateUsage};
 };
 classify.sawWorkflow=()=>sawWorkflow;
 return classify;
};

export const CONTINUATION_CAP=1024;
export const until=async(fn:()=>boolean,ms=8000)=>{const start=Date.now();while(!fn()){if(Date.now()-start>ms)throw Error('timed out waiting for condition');await delay(20);}};
export const continuationFixture=(repo:any,continuations=1,extra:any={})=>{
 const fakes:any[]=[];const argvs:string[][]=[];
 const spawnChild=(_c:string,args:string[])=>{argvs.push(args);const f=makeFakeChild();fakes.push(f);return f.child;};
 const t=okTask(repo,{id:'cont',acceptance:['distinctive acceptance phrase'],execution:{continuations,quietMs:100000,heartbeatMs:20,toolTimeoutMs:5000,checkTimeoutMs:5000},...extra});
 const p=run(t,false,{spawnChild,maxOutputBytes:CONTINUATION_CAP});
 return {t,p,fakes,argvs};
};
export const firstAssistant=(f:any,text:string,usage:any=U(1,2,3))=>f.emit({type:'message_end',message:{role:'assistant',provider:'openrouter',model:'m',usage,stopReason:'stop',content:[{type:'text',text}]}});
export const exhaustCap=(f:any)=>f.emit({type:'tool_execution_start',toolCallId:'c1',toolName:'bash',args:{command:'z'.repeat(4000)}});
export const completeSegment=(f:any,usage:any=U(1,1,2))=>{f.emit({type:'session',id:'seg-session'});f.emit({type:'message_end',message:{role:'assistant',provider:'openrouter',model:'m',usage,stopReason:'stop'}});f.emit({type:'agent_settled'});f.end(0);};
export const driveToContinuation=async(fakes:any[],argvs:string[][],firstUsage:any=U(1,2,3))=>{
 await until(()=>fakes.length>=1);
 fakes[0].emit({type:'session',id:'seg-one'});
 firstAssistant(fakes[0],'work done in the first segment',firstUsage);
 exhaustCap(fakes[0]);
 await until(()=>fakes.length>=2);
};
// A segment that ends at the model's per-message output limit (no accumulation cap).
export const lengthSegment=(f:any,usage:any=U(1,1,2))=>{f.emit({type:'session',id:'seg-session'});f.emit({type:'message_end',message:{role:'assistant',provider:'openrouter',model:'m',usage,stopReason:'length'}});f.emit({type:'agent_settled'});f.end(0);};
export const driveLengthToContinuation=async(fakes:any[])=>{
 await until(()=>fakes.length>=1);
 firstAssistant(fakes[0],'partial work in the first segment');
 lengthSegment(fakes[0]);
 await until(()=>fakes.length>=2);
};
export const SESSION_A='123e4567-e89b-12d3-a456-426614174000';
export const priorResult=(cwd:string,over:any={}):any=>({id:'prior',status:'ready_for_review',cwd,artifactDir:join(cwd,'.delivery','prior','1'),workflow:{selected:'recon'},receipt:{source:'pi_message_end',requested:{provider:'openrouter',model:COMMODITY_MODEL},sessionId:SESSION_A},...over});
export const okExec=(_cmd:string,args:string[])=>({status:0,stdout:args.includes('--version')?`pi ${TESTED_PI_VERSION}\n`:'',stderr:''});
export const setupDeps=(cwd:string,over:any={})=>({cwd,env:{PATH:'',HOME:cwd,...(over.env||{})},execPath:join(cwd,'node'),nodeVersion:'26.5.0',exec:okExec,...over});
export const writeAgent=(cwd:string,over:any={})=>{
 const agent=join(cwd,'agent'); mkdirSync(agent,{recursive:true});
 writeFileSync(join(agent,'auth.json'),JSON.stringify(over.auth ?? {openrouter:{type:'api',key:'SUPER-SECRET-VALUE'}}));
 writeFileSync(join(agent,'models-store.json'),JSON.stringify(over.catalog ?? {openrouter:{models:[{id:DEFAULT_MODEL,type:'chat'}]}}));
 return agent;
};
export const withPiDir=(cwd:string)=>{const bin=join(cwd,'bin');mkdirSync(bin,{recursive:true});writeFileSync(join(bin,'pi'),'#!/bin/sh\n');return bin;};

export const modelGate=(profile:string|null,confidence:number):any=>async({questions}:any)=>{
 const isPre=Object.prototype.hasOwnProperty.call(questions,'contract_clear');
 const answers:any={...(isPre?JEVPASS:{AC1:bool(0.95)})};
 if(isPre && profile && Object.prototype.hasOwnProperty.call(questions,'model_profile')) answers.model_profile={type:'choice',value:profile,confidence};
 return {stopReason:'stop',provider:'openrouter',model:'typesafe/jev-1.13',answers,usage:gateUsage};
};
export const routingCwd=(routing:string)=>{const cwd=mkdtempSync(join(tmpdir(),'delivery-routing-'));writeFileSync(join(cwd,'delivery.config.json'),JSON.stringify({models:{routing}}));return cwd;};
export const routeConfig=(routing:string='auto'):any=>({provider:'openrouter',model:COMMODITY_MODEL,source:'builtin',path:null,pinnedVerdict:{},routing,autoUpgrade:false,defaultProfile:'general',approved:[],unapproved:'ask',rejected:[],roster:[
 {id:'general',provider:'openrouter',model:COMMODITY_MODEL,default:true,strengths:'default'},
 {id:'long-horizon',provider:'openrouter',model:ROUTED_MODEL,strengths:'long autonomous sessions'},
]});

export const approvalCwd=(models:any={})=>{const cwd=mkdtempSync(join(tmpdir(),'delivery-approval-'));writeFileSync(join(cwd,'delivery.config.json'),JSON.stringify({models:{routing:'auto',...models}}));return cwd;};
export const pricedAgent=(prices:Record<string,{input:number;output:number}>)=>{const dir=mkdtempSync(join(tmpdir(),'delivery-agent-'));writeFileSync(join(dir,'models-store.json'),JSON.stringify({openrouter:{models:Object.entries(prices).map(([id,cost])=>({id,cost}))}}));return dir;};
export const approvalFile=(r:any)=>JSON.parse(readFileSync(join(r.artifactDir,'model-approval.json'),'utf8'));

export const initRepo=()=>{
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
export const exampleTaskFrom=(dir:string)=>JSON.parse(readFileSync(join(dir,'tasks','example-task.json'),'utf8'));

export const skillSource=(content:string)=>{const d=mkdtempSync(join(tmpdir(),'delivery-skill-src-'));const f=join(d,'SKILL.md');writeFileSync(f,content);return f;};
export const codexSkill=(root:string)=>join(root,'.agents','skills','junior','SKILL.md');
export const claudeSkill=(root:string)=>join(root,'.claude','skills','junior','SKILL.md');

export const gitRepo=()=>{
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
export const commitFile=(repo:any,name:string,content:string)=>{writeFileSync(join(repo.dir,name),content);repo.git(['add',name]);repo.git(['commit','-qm',`add ${name}`]);};
export const wtTask=(repo:any,extra:any={})=>({id:'wt',deliverable:'isolated work',cwd:repo.dir,acceptance:['checks pass'],checks:[{command:process.execPath,args:['-e',"require('fs').writeFileSync('check-marker.txt','1')"]}],isolation:'worktree',...extra});
export const okSpawn=(onSpawn?:any)=>(command:string,args:string[],opts:any)=>{if(onSpawn)onSpawn(command,args,opts);return {status:0,stdout:stream({type:'session',id:'sess-wt'},assistant(),{type:'agent_settled'}),stderr:''};};
export const okTask=(repo:any,extra:any={})=>({id:'ev',deliverable:'evidence',cwd:repo.dir,acceptance:['ok'],checks:[{command:process.execPath,args:['-e','process.exit(0)']}],...extra});

export const priorNone=(repo:any,slot:string)=>{const priorDir=join(repo.dir,'.delivery','prior',slot);mkdirSync(priorDir,{recursive:true});const prior={id:'prior',status:'ready_for_review',artifactDir:priorDir,sourceCwd:repo.dir,executionCwd:repo.dir,isolation:{mode:'none'},receipt:{source:'pi_message_end',requested:{provider:'openrouter',model:COMMODITY_MODEL},sessionId:SESSION_A}};writeFileSync(join(priorDir,'result.json'),JSON.stringify(prior));seedSession(priorDir);return join(priorDir,'result.json');};

export const delay=(ms:number)=>new Promise((r)=>setTimeout(r,ms));
export const artifactFor=(repo:any,id:string)=>{const base=join(repo.dir,'.delivery',id);const stamps=readdirSync(base,{withFileTypes:true}).filter((e)=>e.isDirectory()).map((e)=>e.name).sort();return join(base,stamps[stamps.length-1]);};
export const readRuntime=(art:string)=>JSON.parse(readFileSync(join(art,'runtime.json'),'utf8'));

export const makeFakeChild=()=>{
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

export const waitForPid=async(path:string,tries=100)=>{for(let i=0;i<tries;i++){try{const p=Number(readFileSync(path,'utf8'));if(p>0)return p;}catch{}await delay(25);}return 0;};
export const aliveAfter=async(pid:number,tries=80)=>{for(let i=0;i<tries;i++){try{process.kill(pid,0);await delay(50);}catch{return false;}}return true;};
export const termIgnoringDescendant=()=>"process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000)";

export const handoffResult=(over:any={}):any=>({id:'c',status:'ready_for_review',artifactDir:'/a',
 receipt:{requested:{provider:'openrouter',model:'m'},observed:[{provider:'openrouter',model:'m'}],observedUnknown:false,
  usage:{input:11,output:22,cacheRead:3,cacheWrite:4,totalTokens:40,available:true},responseIds:['gen-abc']},
 cost:{estimatedUsd:null,piReported:{total:null,available:false}},...over});

export const addNestedPackage=(repo:any)=>{mkdirSync(join(repo.dir,'packages','app'),{recursive:true});writeFileSync(join(repo.dir,'packages','app','package.json'),'{"name":"app"}\n');repo.git(['add','packages']);repo.git(['commit','-qm','add package']);};
export const cwdCheck=(cwd?:any)=>({command:process.execPath,args:['-e',"require('fs').writeFileSync('marker.txt','1')"],...(cwd!==undefined?{cwd}:{})});
export const makeDirLink=(target:string,link:string)=>{try{symlinkSync(target,link,process.platform==='win32'?'junction':'dir');return true;}catch{return false;}};
export const markerCheck=(cwd:string)=>({command:process.execPath,args:['-e',"require('fs').writeFileSync('marker.txt','1')"],cwd});
export const symlinkEscape=()=>{
 const repo=gitRepo(); commitFile(repo,'a.txt','base\n');
 const outside=mkdtempSync(join(tmpdir(),'delivery-outside-'));
 const link=join(repo.dir,'linkout');
 if(!makeDirLink(outside,link)) return null;
 return {repo,outside,link,check:markerCheck(link)};
};

export const tempGitRepo=()=>{
 const dir=mkdtempSync(join(tmpdir(),'delivery-init-git-'));
 spawnSync('git',['init','-q'],{cwd:dir});
 return dir;
};
export const localExclude=(dir:string)=>{try{return readFileSync(join(dir,'.git','info','exclude'),'utf8');}catch{return '';}};

export const emptyQuestionHop:any=async(_hop:string,tool:string,request:any)=>{
 const ok=(result:any)=>({ok:true,tool,toolName:request.tool,result});
 if(request.tool==='question.next')return ok({question:null});
 if(request.tool==='state.get')return ok({signals:[],claims:[]});
 return ok({});
};
export const artifactTask=(repo:any,extra:any={})=>({id:'b01',deliverable:'artifact isolation',cwd:repo.dir,acceptance:['checks pass'],checks:[{command:process.execPath,args:['-e','process.exit(0)']}],...extra});
export const deliveryPath=(p:string)=>p==='.delivery'||p.startsWith('.delivery/');

export const onlineAgent=(cwd:string,key:string)=>{const agent=writeAgent(cwd,{auth:{openrouter:{type:'api',key}}});return {agent};};

export const capturePreflight=async(t:any)=>{ let seen:any; const classifier:any=async({state}:any)=>{seen=state;return {stopReason:'stop',answers:JEVPASS};}; await assessPreflight(t,classifier); return seen; };
export const contextdir=(name:string,body:string)=>{const dir=mkdtempSync(join(tmpdir(),'delivery-ctx-'));writeFileSync(join(dir,name),body);return dir;};

export const linkRepo=()=>{
 const repo=gitRepo();
 commitFile(repo,'.gitignore','.delivery/\ndeps/\n');
 mkdirSync(join(repo.dir,'deps'),{recursive:true});
 writeFileSync(join(repo.dir,'deps','secret.txt'),'s\n');
 return repo;
};

export const routingClassifier=(traits:Record<string,number>)=>({
 stopReason:'stop',provider:'openrouter',model:'typesafe/jev-1.13',
 answers:{...JEVPASS,...Object.fromEntries(Object.entries(traits).map(([k,v])=>[`trait_${k}`,bool(v)]))},usage:gateUsage,
});
export const routingSeam=(traits:Record<string,number>):any=>async()=>routingClassifier(traits);
export const routingPlan={traits:{},playbooks:[],tools:[],managerSetup:[],workerDirections:['junior tools call <hop> fmeca <request.json> — scored failure modes']};

export const stickyCwd=()=>mkdtempSync(join(tmpdir(),'delivery-sticky-'));
export const stickyFile=(cwd:string)=>JSON.parse(readFileSync(join(cwd,'.delivery','smoke','route.json'),'utf8'));

export const isolationCapabilities={flags:new Set(['--no-extensions','--no-skills','--no-context-files','--no-prompt-templates','--no-approve','--no-mcp','--tools'])};

export const bounded=(extra:any={})=>task(0,{
 readScope:{mode:'context-plus-dependencies',paths:['src/a.ts'],maxFiles:30,maxBytes:500000,allowGraft:true},
 budget:{maxInputTokens:150000,maxOutputTokens:20000,maxToolCalls:60,maxToolOutputBytes:1000000},
 ...extra,
});

