// ---------------------------------------------------------------------------
// Read-only `doctor` and idempotent `init` for the delivery worker CLI.
//
// Both commands are offline by default. `doctor` only inspects local state:
// the running Node, the `pi` executable (`pi --version`), Pi's local auth file
// (presence only, never values) and Pi's local model catalog. It never
// installs anything, writes configuration, or makes a paid network call.
//
// `init` writes project-local files only when absent and never touches global
// auth or model configuration. Installing Pi is available only through the
// explicit `init --install` flag, which uses npm argv (no shell) and the exact
// pinned tested package version; inspect the local Pi
// package.json for diagnostics.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectIntegrations, type IntegrationsResult } from './installer.ts';

/** Pi itself requires Node 22.19 or newer; the worker is tested on Node 24+. */
export const SUPPORTED_NODE_MIN = '22.19.0';
export const DEFAULT_PROVIDER = 'openrouter';
export const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash';
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';
export const TESTED_PI_VERSION = '1.0.3';
export const DOCTOR_TIMEOUT_MS = 10000;
export const INSTALL_TIMEOUT_MS = 300000;

/** Packaged delegation skill installed by `init`. The source is resolved from
 * this module's location, never from the caller's working directory. */
export const SKILL_NAME = 'junior';
export const SKILL_FILENAME = 'SKILL.md';
export const SKILL_MANIFEST_FILENAME = '.junior-manifest.json';
export const PACKAGED_SKILL_PATH = join(dirname(fileURLToPath(import.meta.url)), 'skills', SKILL_NAME, SKILL_FILENAME);

/** Resolve the CLI entry that ships beside this module: `dist/junior.js` when
 * compiled, or `junior.ts` in a source checkout. The installed skill records
 * this path so it can invoke the packaged CLI without assuming a checkout. */
export function resolveJuniorCliPath(moduleDir:string = dirname(fileURLToPath(import.meta.url))):string {
 const js=join(moduleDir,'junior.js');
 if (existsSync(js)) return js;
 const ts=join(moduleDir,'junior.ts');
 if (existsSync(ts)) return ts;
 return js;
}

export type ExecResult = { status:number|null; stdout?:string; stderr?:string; error?:string };

export type SetupDeps = {
 cwd?:string;
 env?:NodeJS.ProcessEnv;
 /** Injectable process seams so tests never touch the real environment. */
 execPath?:string;
 nodeVersion?:string;
 exec?:(command:string, args:string[], options?:{timeout?:number; env?:NodeJS.ProcessEnv})=>ExecResult;
 readFile?:(path:string, encoding?:string)=>string;
 exists?:(path:string)=>boolean;
 writeFile?:(path:string, data:string)=>void;
 mkdir?:(path:string)=>void;
 /** Pre-resolved Pi package metadata; tests inject it instead of reading disk. */
 installedPi?:{name:string;version:string}|null;
 /** Packaged skill source path; tests inject a fixture instead of the module copy. */
 skillSource?:string;
 /** Managed prebuilt-tool root; tests inject a fixture instead of the user home. */
 toolsRoot?:string;
};

function readText(deps:SetupDeps, path:string):string {
 return (deps.readFile ?? ((p:string)=>readFileSync(p,'utf8')))(path,'utf8');
}
function exists(deps:SetupDeps, path:string):boolean {
 return (deps.exists ?? existsSync)(path);
}
function agentDir(deps:SetupDeps):string {
 const env=deps.env ?? process.env;
 const home=env.HOME || env.USERPROFILE || '';
 return env.PI_CODING_AGENT_DIR || join(home,'.pi','agent');
}
function parseSemver(v:string):[number,number,number] {
 const m=String(v??'').match(/(\d+)\.(\d+)\.(\d+)/);
 return m ? [Number(m[1]),Number(m[2]),Number(m[3])] : [0,0,0];
}
/** Compare dotted versions; returns -1, 0 or 1. */
export function compareSemver(a:string,b:string):number {
 const x=parseSemver(a), y=parseSemver(b);
 for (let i=0;i<3;i++) { if (x[i]!==y[i]) return x[i]<y[i] ? -1 : 1; }
 return 0;
}
function firstSemver(text:string):string|null {
 const m=String(text??'').match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
 return m ? m[0] : null;
}

/** Resolve a bare executable name on the injected PATH. */
export function whichOnPath(name:string, pathEnv:string|undefined, deps:SetupDeps = {}):string|null {
 const dirs=String(pathEnv ?? '').split(delimiter).filter(Boolean);
 for (const d of dirs) {
  const candidate=join(d,name);
  if (exists(deps,candidate)) return candidate;
 }
 return null;
}

/** Read the installed Pi package name/version from the local package.json for diagnostics.
 * This is the authoritative tested version used by `init --install`. */
export function discoverInstalledPi(deps:SetupDeps = {}):{name:string;version:string;packageJsonPath:string}|null {
 const execPath=deps.execPath ?? process.execPath;
 const candidates=[];
 const env=deps.env ?? process.env;
 if (env.PI_PACKAGE_DIR) candidates.push(join(env.PI_PACKAGE_DIR,'package.json'));
 candidates.push(join(dirname(execPath),'..','lib','node_modules','@earendil-works','pi-coding-agent','package.json'));
 for (const p of candidates) {
  try {
   const j=JSON.parse(readText(deps,p));
   if (j?.name === PI_PACKAGE && typeof j.version==='string' && /^\d+\.\d+\.\d+$/.test(j.version)) return {name:j.name,version:j.version,packageJsonPath:p};
  } catch { /* try the next candidate */ }
 }
 return null;
}

export type PiCheck = { found:boolean; executable:string|null; version:string|null; location:string|null; pathMismatch:boolean; note?:string };

/** Resolve `pi`, run a bounded `pi --version`, and detect a PATH/nvm mismatch
 * where `pi` and the running `node` live in different directories. */
export function checkPi(deps:SetupDeps = {}):PiCheck {
 const env=deps.env ?? process.env;
 const executable=whichOnPath('pi',env.PATH,deps);
 if (!executable) return {found:false, executable:null, version:null, location:null, pathMismatch:false};
 let version:string|null=null;
 let note:string|undefined;
 try {
  const r=(deps.exec ?? ((c:string,a:string[],o?:any)=>asSpawn(c,a,o)))('pi',['--offline','--no-approve','--version'],{timeout:DOCTOR_TIMEOUT_MS, env:{...env, PI_OFFLINE:'1', PI_SKIP_VERSION_CHECK:'1'}});
  if (r.error) note=`pi --version failed: ${r.error}`;
  else if (r.status !== 0) note=`pi --version exited ${r.status}`;
  else version=firstSemver(r.stdout || '');
 } catch (e) {
  note=`pi --version failed: ${e instanceof Error ? e.message : String(e)}`;
 }
 const location=dirname(executable);
 const nodeDir=dirname(deps.execPath ?? process.execPath);
 const pathMismatch=location !== nodeDir;
 if (pathMismatch) note=`pi resolves from ${location} but node runs from ${nodeDir}; a different PATH or nvm version may hide the global install`;
 return {found:true, executable, version, location, pathMismatch, ...(note?{note}:{})};
}

function asSpawn(command:string, args:string[], options:any):ExecResult {
 // Kept behind the injectable seam; only `doctor`/`init --install` reach it.
 const r=spawnSync(command,args,{encoding:'utf8', ...options});
 return { status:r.status, stdout:r.stdout || '', stderr:r.stderr || '', error:r.error?.message };
}

export type CredentialCheck = { provider:string; present:boolean; sources:string[]; providers:string[] };

/** Inspect whether the requested provider has a credential, without ever
 * returning a credential value. Only provider names and source labels leave
 * this function. */
export function checkCredentials(provider:string, deps:SetupDeps = {}):CredentialCheck {
 const env=deps.env ?? process.env;
 const sources:string[]=[];
 const providers:string[]=[];
 const authPath=join(agentDir(deps),'auth.json');
 if (exists(deps,authPath)) {
  try {
   const j=JSON.parse(readText(deps,authPath));
   if (j && typeof j==='object' && !Array.isArray(j)) { for (const [name, credential] of Object.entries(j)) { const c:any=credential; if (c && ((['api_key','api'].includes(c.type) && typeof c.key==='string' && c.key.trim()) || (c.type==='oauth' && typeof c.access==='string' && c.access.trim()))) providers.push(name); } if (providers.includes(provider)) sources.push('auth.json'); }
  } catch { /* an unreadable auth file is simply not evidence of presence */ }
 }
 const envVar=provider==='openrouter' ? 'OPENROUTER_API_KEY' : provider==='deepseek' ? 'DEEPSEEK_API_KEY' : null;
 if (envVar && env[envVar]?.trim()) {
  sources.push(envVar);
  if (!providers.includes(provider)) providers.push(provider);
 }
 const present=providers.includes(provider);
 return { provider, present, sources, providers:[...new Set(providers)] };
}

export type ModelCheck = { provider:string; id:string; available:boolean; source:string|null; note?:string };

/** Verify the requested model against Pi's local catalog overlay and the
 * agent `models.json`, with no network access. */
export function checkModel(provider:string, id:string, deps:SetupDeps = {}):ModelCheck {
 const dir=agentDir(deps);
 const storePath=join(dir,'models-store.json');
 if (exists(deps,storePath)) {
  try {
   const j=JSON.parse(readText(deps,storePath));
   const models=j?.[provider]?.models;
   if (Array.isArray(models) && models.some((m:any)=>m && m.id===id)) return {provider,id,available:true,source:'models-store.json'};
  } catch { /* fall through to the custom models file */ }
 }
 const customPath=join(dir,'models.json');
 if (exists(deps,customPath)) {
  try {
   const j=JSON.parse(readText(deps,customPath));
   const models=j?.providers?.[provider]?.models;
   if (Array.isArray(models) && models.some((m:any)=>m && m.id===id)) return {provider,id,available:true,source:'models.json'};
  } catch { /* report missing below */ }
 }
 return { provider, id, available:false, source:null,
  note:`Model ${provider}/${id} was not found in the local Pi catalog. Run \`pi update --models\` to refresh, or start pi and choose a model with /model.` };
}

export type DoctorCheck = { id:string; ok:boolean; detail:string };
export type DoctorResult = {
 command:'doctor';
 ok:boolean;
 node:{ version:string; supported:boolean; minimum:string };
 pi:PiCheck;
 credentials:CredentialCheck;
 model:ModelCheck;
 /** Skill readiness is reported separately; it does not change Pi execution readiness (`ok`). */
 skill:SkillReadiness;
 /** Prebuilt integration readiness is reported separately from Pi execution/auth readiness. */
 integrations:IntegrationsResult;
 integrationsReady:boolean;
 checks:DoctorCheck[];
 remediation:string[];
};

/** Read-only readiness check. No installation, config writes or paid calls. */
export function doctor(deps:SetupDeps = {}):DoctorResult {
 const env=deps.env ?? process.env;
 const version=deps.nodeVersion ?? process.versions.node;
 const supported=compareSemver(version,SUPPORTED_NODE_MIN) >= 0;
 const pi=checkPi(deps);
 const defaults=loadDefaults(deps.cwd ?? process.cwd(),deps);
 const provider=defaults.provider;
 const credentials=checkCredentials(provider,deps);
 const model=checkModel(provider,defaults.model,deps);

 const remediation:string[]=[];
 if (!supported) remediation.push(`Install Node ${SUPPORTED_NODE_MIN} or newer (for example \`nvm install 24\`) and re-run \`doctor\`.`);
 if (!pi.found) remediation.push(`Install Pi with \`node worker.ts init --install\` (or \`npm install -g --ignore-scripts ${PI_PACKAGE}\`) using the active Node/nvm.`);
 else if (!pi.version) remediation.push('Pi could not run successfully; check its executable and active Node installation.');
 else if (pi.pathMismatch) remediation.push('Install Pi with the active nvm Node so `pi` and `node` resolve from the same bin directory.');
 if (!credentials.present) remediation.push('Authenticate with Pi: start `pi` and run `/login`, then select the model with `/model`.');
 if (!model.available) remediation.push(model.note as string);

 const checks:DoctorCheck[]=[
  { id:'node', ok:supported, detail:`node ${version} (minimum ${SUPPORTED_NODE_MIN})` },
  { id:'pi', ok:pi.found && !!pi.version, detail:pi.found ? `${pi.executable} (${pi.version ?? 'version unknown'})` : 'pi not found on PATH' },
  { id:'credentials', ok:credentials.present, detail:credentials.present ? `${provider} credential present (${credentials.sources.join(', ')})` : `no ${provider} credential` },
  { id:'model', ok:model.available, detail:model.available ? `${provider}/${defaults.model} in ${model.source}` : (model.note as string) },
 ];
 const skill=inspectSkill(deps);
 const integrations=inspectIntegrations({ env, cwd: deps.cwd, installRoot: deps.toolsRoot });
 return { command:'doctor', ok:checks.every((c)=>c.ok), node:{version,supported,minimum:SUPPORTED_NODE_MIN}, pi, credentials, model, skill, integrations, integrationsReady:integrations.ready, checks, remediation };
}

export type InitResult = {
 command:'init';
 cwd:string;
 created:string[];
 preserved:string[];
 ready:boolean;
 pi:PiCheck;
 skill:SkillResult;
 install?:{ requested:boolean; attempted:boolean; ok:boolean; command?:string[]; spec?:string; error?:string };
 instructions:string[];
};

/** Reuse the tested Pi version pinned in an existing project config, so
 * `init --install` can restore the exact version even when Pi is absent. */

function exampleTask(cwd:string, execPath:string):any {
 return {
  id:'example-task',
  deliverable:'Verify the delivery worker setup end to end',
  cwd,
  acceptance:['The delivery worker reports ready for review'],
  checks:[{command:execPath, args:['-e',"console.log('setup check passed')"]}],
 };
}

/** Idempotent project setup. Creates project defaults and an example task only
 * when absent; existing files and all global auth/model configuration are
 * preserved. Installation happens only when `opts.install` is true. */
export function init(deps:SetupDeps = {}, opts:InitOptions = {}):InitResult {
 const cwd=deps.cwd ?? process.cwd();
 const write=(deps.writeFile ?? ((p:string,d:string)=>writeFileSync(p,d)));
 const mkdir=(deps.mkdir ?? ((p:string)=>mkdirSync(p,{recursive:true})));
 const created:string[]=[];
 const preserved:string[]=[];

 const tested={name:PI_PACKAGE,version:TESTED_PI_VERSION};
 const defaultsPath=join(cwd,'delivery.config.json');
 if (exists(deps,defaultsPath)) preserved.push('delivery.config.json');
 else {
  const config:any={ provider:DEFAULT_PROVIDER, model:DEFAULT_MODEL };
  if (tested) config.pi={ name:tested.name, testedVersion:tested.version };
  write(defaultsPath, JSON.stringify(config,null,2)+'\n');
  created.push('delivery.config.json');
 }

 const examplePath=join(cwd,'tasks','example-task.json');
 if (exists(deps,examplePath)) preserved.push('tasks/example-task.json');
 else {
  mkdir(join(cwd,'tasks'));
  write(examplePath, JSON.stringify(exampleTask(cwd, deps.execPath ?? process.execPath),null,2)+'\n');
  created.push('tasks/example-task.json');
 }

 const skill=installSkill(deps, opts);
 let readiness=doctor(deps);
 let install:InitResult['install'];
 if (opts.install && readiness.pi.found && readiness.pi.version) {
  install={requested:true,attempted:false,ok:true};
 } else if (opts.install) {
  if (!tested) {
   install={ requested:true, attempted:false, ok:false,
    error:`Cannot determine the exact tested Pi version from a local package.json; install with \`npm install -g --ignore-scripts ${PI_PACKAGE}\` using the active Node/nvm.` };
  } else {
   const spec=`${tested.name}@${tested.version}`;
   const args=['install','-g','--ignore-scripts',spec];
   const r=(deps.exec ?? ((c:string,a:string[],o?:any)=>asSpawn(c,a,o)))('npm',args,{timeout:INSTALL_TIMEOUT_MS, env:deps.env ?? process.env});
   install={ requested:true, attempted:true, ok:r.status===0, command:['npm',...args], spec,
    ...(r.status===0 ? {} : { error: r.error || (r.stderr || `npm install exited ${r.status}`) }) };
  }
 }
 if (install?.attempted && install.ok) readiness=doctor(deps);
 const skillAdvice=skill.actions.filter((a)=>a.status === 'outdated' || a.status === 'customized').map((a)=>a.message);
 const instructions=readiness.ok && skill.ok ? [] : [...(readiness.ok ? [] : readiness.remediation), ...skillAdvice];
 return { command:'init', cwd, created, preserved, ready:readiness.ok && skill.ok, pi:readiness.pi, skill, install, instructions };
}

export type Defaults = { provider:string; model:string; source:'builtin'|'project'; path:string|null };

/** Load project defaults for `run`. An explicit task provider/model always
 * takes precedence; the built-in defaults apply when no project config exists. */
export function loadDefaults(cwd:string, deps:SetupDeps = {}):Defaults {
 const path=join(cwd,'delivery.config.json');
 if (exists(deps,path)) {
  try {
   const j=JSON.parse(readText(deps,path));
   const provider=typeof j?.provider==='string' && j.provider.trim() ? j.provider : DEFAULT_PROVIDER;
   const model=typeof j?.model==='string' && j.model.trim() ? j.model : DEFAULT_MODEL;
   return {provider, model, source:'project', path};
  } catch { /* a malformed config falls back to built-ins */ }
 }
 return {provider:DEFAULT_PROVIDER, model:DEFAULT_MODEL, source:'builtin', path:null};
}

// ---------------------------------------------------------------------------
// Packaged delegation skill install.
//
// `init` copies the canonical `skills/junior/SKILL.md` (resolved relative to
// this module) into the Codex project root `.agents/skills/junior` and the
// Claude Code project root `.claude/skills/junior`. User-wide installs require
// the explicit `scope: "user"` option and write under `HOME` (or an explicit
// skill root), never implicitly. A small `.junior-manifest.json` beside each
// installed skill records the last hash this command wrote, so an outdated but
// unmodified copy can be upgraded explicitly while a customization is only
// ever replaced with an explicit `force`.
// ---------------------------------------------------------------------------

export type SkillManager = 'codex' | 'claude';
export type SkillTargetSelection = SkillManager | 'both' | 'none';
export type SkillScope = 'project' | 'user';

export type SkillActionStatus = 'created' | 'identical' | 'outdated' | 'customized' | 'upgraded' | 'forced';
export type SkillAction = { manager:SkillManager; path:string; status:SkillActionStatus; message:string };
export type SkillResult = { target:SkillTargetSelection; scope:SkillScope; source:string; actions:SkillAction[]; ok:boolean };
export type SkillReadiness = {
 ready:boolean;
 source:string;
 targets:Array<{ manager:SkillManager; path:string; status:'current'|'outdated'|'customized'|'missing' }>;
};
export type SkillInstallOptions = { target?:SkillTargetSelection; scope?:SkillScope; upgrade?:boolean; force?:boolean; skillRoot?:string };
export type InitOptions = SkillInstallOptions & { install?:boolean; update?:boolean; withTriz?:boolean };

function sha256(text:string):string {
 return createHash('sha256').update(text).digest('hex');
}

function selectedManagers(target:SkillTargetSelection):SkillManager[] {
 if (target === 'both') return ['codex','claude'];
 if (target === 'none') return [];
 return [target];
}

/** Resolve the directory that will contain the `junior/` skill folder. */
function skillRootFor(deps:SetupDeps, scope:SkillScope, manager:SkillManager, explicitRoot?:string):string {
 if (explicitRoot) return explicitRoot;
 if (scope === 'user') {
  const env=deps.env ?? process.env;
  const home=env.HOME || env.USERPROFILE || '';
  return manager === 'codex' ? join(home,'.agents','skills') : join(home,'.claude','skills');
 }
 const cwd=deps.cwd ?? process.cwd();
 return manager === 'codex' ? join(cwd,'.agents','skills') : join(cwd,'.claude','skills');
}

function readManifestHash(deps:SetupDeps, manifestPath:string):string|null {
 if (!exists(deps,manifestPath)) return null;
 try {
  const parsed=JSON.parse(readText(deps,manifestPath));
  const hash=parsed?.skills?.[SKILL_NAME]?.hash;
  return typeof hash === 'string' && hash ? hash : null;
 } catch { return null; }
}

function writeSkillManifest(deps:SetupDeps, manifestPath:string, hash:string, source:string):void {
 const write=(deps.writeFile ?? ((p:string,d:string)=>writeFileSync(p,d)));
 const mkdir=(deps.mkdir ?? ((p:string)=>mkdirSync(p,{recursive:true})));
 mkdir(dirname(manifestPath));
 const cli=resolveJuniorCliPath();
 write(manifestPath, JSON.stringify({ skill:SKILL_NAME, skills:{ [SKILL_NAME]:{ hash, source, cli } } },null,2)+'\n');
}

function readSkillSource(deps:SetupDeps):{ path:string; text:string } {
 const path=deps.skillSource ?? PACKAGED_SKILL_PATH;
 return { path, text:readText(deps,path) };
}

/** Install the packaged skill for the selected managers. Missing copies are
 * created; identical copies are left alone; an unmodified but outdated copy is
 * only replaced with `upgrade`; a customized copy is preserved unless `force`. */
export function installSkill(deps:SetupDeps = {}, opts:SkillInstallOptions = {}):SkillResult {
 const target=opts.target ?? 'both';
 const scope=opts.scope ?? 'project';
 const { path:sourcePath, text:source }=readSkillSource(deps);
 const sourceHash=sha256(source);
 const write=(deps.writeFile ?? ((p:string,d:string)=>writeFileSync(p,d)));
 const mkdir=(deps.mkdir ?? ((p:string)=>mkdirSync(p,{recursive:true})));
 const actions:SkillAction[]=[];
 for (const manager of selectedManagers(target)) {
  const root=skillRootFor(deps,scope,manager,opts.skillRoot);
  const dir=join(root,SKILL_NAME);
  const path=join(dir,SKILL_FILENAME);
  const manifestPath=join(root,SKILL_MANIFEST_FILENAME);
  if (!exists(deps,path)) {
   mkdir(dir); write(path,source); writeSkillManifest(deps,manifestPath,sourceHash,sourcePath);
   actions.push({manager,path,status:'created',message:`installed the ${manager} skill at ${path}`});
   continue;
  }
  const currentHash=sha256(readText(deps,path));
  if (currentHash === sourceHash) {
   if (readManifestHash(deps,manifestPath) !== sourceHash) writeSkillManifest(deps,manifestPath,sourceHash,sourcePath);
   actions.push({manager,path,status:'identical',message:`the ${manager} skill is already current`});
   continue;
  }
  const recorded=readManifestHash(deps,manifestPath);
  if (recorded && currentHash === recorded) {
   if (opts.upgrade) {
    write(path,source); writeSkillManifest(deps,manifestPath,sourceHash,sourcePath);
    actions.push({manager,path,status:'upgraded',message:`upgraded the ${manager} skill from its recorded version`});
   } else {
    actions.push({manager,path,status:'outdated',message:`the ${manager} skill is outdated; re-run with --upgrade to replace the unmodified installed copy`});
   }
   continue;
  }
  if (opts.force) {
   write(path,source); writeSkillManifest(deps,manifestPath,sourceHash,sourcePath);
   actions.push({manager,path,status:'forced',message:`replaced the customized ${manager} skill because --force was given`});
  } else {
   actions.push({manager,path,status:'customized',message:`the ${manager} skill was customized; it was preserved unchanged (use --force to replace)`});
  }
 }
 const ok=actions.every((a)=>a.status !== 'outdated' && a.status !== 'customized');
 return { target, scope, source:sourcePath, actions, ok };
}

/** Read-only skill readiness for the selected managers. Never writes. */
export function inspectSkill(deps:SetupDeps = {}, opts:SkillInstallOptions = {}):SkillReadiness {
 const target=opts.target ?? 'both';
 const scope=opts.scope ?? 'project';
 const { path:sourcePath, text:source }=readSkillSource(deps);
 const sourceHash=sha256(source);
 const targets:SkillReadiness['targets']=[];
 for (const manager of selectedManagers(target)) {
  const root=skillRootFor(deps,scope,manager,opts.skillRoot);
  const path=join(root,SKILL_NAME,SKILL_FILENAME);
  let status:SkillReadiness['targets'][number]['status'];
  if (!exists(deps,path)) status='missing';
  else {
   const currentHash=sha256(readText(deps,path));
   if (currentHash === sourceHash) status='current';
   else if (readManifestHash(deps,join(root,SKILL_MANIFEST_FILENAME)) === currentHash) status='outdated';
   else status='customized';
  }
  targets.push({manager,path,status});
 }
 return { ready:targets.every((t)=>t.status === 'current'), source:sourcePath, targets };
}

const SKILL_TARGETS:SkillTargetSelection[]=['codex','claude','both','none'];
function isSkillTarget(value:string|undefined):value is SkillTargetSelection {
 return !!value && (SKILL_TARGETS as string[]).includes(value);
}

/** Parse the `init` flags shared by the `worker.ts` and `junior.ts` CLIs. */
export function parseInitOptions(argv:string[]):InitOptions {
 const opts:InitOptions={};
 for (let i=0;i<argv.length;i++) {
  const a=argv[i];
  if (a === '--install') opts.install=true;
  else if (a === '--user') opts.scope='user';
  else if (a === '--project') opts.scope='project';
  else if (a === '--upgrade') opts.upgrade=true;
  else if (a === '--update') opts.update=true;
  else if (a === '--with-triz') opts.withTriz=true;
  else if (a === '--force') opts.force=true;
  else if (a === '--no-skill') opts.target='none';
  else if (a === '--scope') opts.scope = argv[++i] === 'user' ? 'user' : 'project';
  else if (a.startsWith('--scope=')) opts.scope = a.slice('--scope='.length) === 'user' ? 'user' : 'project';
  else if (a === '--target') { const v=argv[++i]; opts.target=isSkillTarget(v) ? v : 'both'; }
  else if (a.startsWith('--target=')) { const v=a.slice('--target='.length); opts.target=isSkillTarget(v) ? v : 'both'; }
  else if (a === '--skill-root') opts.skillRoot=argv[++i];
  else if (a.startsWith('--skill-root=')) opts.skillRoot=a.slice('--skill-root='.length);
 }
 return opts;
}
