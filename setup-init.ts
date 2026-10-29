import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { installCompanions, installCompanionSkills, installationDisabled, type CompanionInstallReport, type CompanionSkillReport } from './companions.ts';
import { matrixInit } from './matrix-init.ts';
import { ensureLocalExcludes } from './isolation.ts';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, INSTALL_TIMEOUT_MS, PI_PACKAGE, SKILL_MANIFEST_FILENAME, TESTED_PI_VERSION, MATRIX_COMMIT, MATRIX_REMINDER, MATRIX_UPDATE_SKIP, asSpawn, exists, readText, type SetupDeps } from './setup-env.ts';
import { installSkill, type InitOptions, type SkillResult, type SkillTargetSelection, type SkillScope } from './setup-skill.ts';
import { doctor, summarizeInstall } from './setup-doctor.ts';

export type MatrixOutcome = {
 /** True only when this run created `.crossmatrix/` through `crossmatrix-mcp init`. */
 created:boolean;
 /** True when a `.crossmatrix/` store was already present before this run. */
 existing?:boolean;
 /** Why creation was skipped: explicit opt-out, update rule, or a matrixInit failure. */
 skipped?:string;
};

export type InitResult = {
 command:'init'|'update';
 cwd:string;
 created:string[];
 preserved:string[];
 ready:boolean;
 pi:PiCheck;
 skill:SkillResult;
 /** Exact Junior-owned paths newly added to the repository-local exclude file. */
 excluded:string[];
 /** Outcome of the project Crossmatrix store step, independent of `ready`. */
 matrix:MatrixOutcome;
 install?:{ requested:boolean; attempted:boolean; ok:boolean; command?:string[]; spec?:string; skipped?:string; error?:string };
 /** Distinguishes the Pi attempt from the prebuilt-tools attempt. */
 installSummary:InitInstallSummary;
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

/** Exact repo-relative paths `init` newly created and therefore owns. A
 * pre-existing untracked config, task or skill is never hidden from the user.
 * `.delivery/` is always excluded because it is runtime-owned output. */
function generatedExcludePatterns(skill:SkillResult, created:string[]):string[] {
 const patterns=['/.delivery/'];
 if (created.includes('delivery.config.json')) patterns.push('/delivery.config.json');
 if (created.includes('tasks/example-task.json')) patterns.push('/tasks/example-task.json');
 if (skill.scope === 'project') {
  for (const action of skill.actions) {
   // Junior wrote (or already matches) these copies; outdated or customized ones are the user's.
   if (action.status === 'outdated' || action.status === 'customized') continue;
   const root=action.manager === 'codex' ? '.agents/skills' : '.claude/skills';
   patterns.push(`/${root}/junior/`, `/${root}/${SKILL_MANIFEST_FILENAME}`);
  }
 }
 return [...new Set(patterns)];
}

/** Create the project store through the matrix-init seam. The managed tools
 * manifest is derived from `toolsRoot`/`HOME` so an injected environment never
 * reaches the real user profile. */
function defaultMatrixInit(deps:SetupDeps, dir:string):{created:string[]} {
 const env=deps.env ?? process.env;
 const home=env.HOME || env.USERPROFILE || homedir();
 const statePath=join(deps.toolsRoot ?? join(home,'.junior','tools'),'installed.json');
 return matrixInit({ cwd:dir, env, exists:deps.exists, readFile:deps.readFile, statePath }, { dir });
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
 const excluded=ensureLocalExcludes(cwd, generatedExcludePatterns(skill, created)).added;
 let readiness=doctor(deps);
 let install:InitResult['install'];
 if (opts.install && installationDisabled(deps.env)) {
  install={ requested:true, attempted:false, ok:true, skipped:'JUNIOR_NO_INSTALL' };
 } else if (opts.install && readiness.pi.found && readiness.pi.version) {
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
 const command=opts.command ?? 'init';
 const storePath=join(cwd,'.crossmatrix');
 const hadStore=exists(deps, storePath);
 // `update` only creates committed project state when explicitly opted in;
 // `init --no-matrix` opts out. `init --update` is still an init.
 const shouldCreate=!hadStore && ((command === 'init' && opts.matrix !== false) || (command === 'update' && opts.matrix === true));
 let matrix:MatrixOutcome;
 if (shouldCreate) {
  try {
   const createdNow=(deps.matrixInit ?? ((dir:string)=>defaultMatrixInit(deps,dir)))(cwd).created ?? [];
   matrix={ created: createdNow.includes('.crossmatrix') };
  } catch (e) {
   matrix={ created:false, skipped: e instanceof Error ? e.message : String(e) };
  }
 } else if (hadStore) {
  matrix={ created:false, existing:true };
 } else {
  matrix={ created:false, skipped: command === 'update' ? MATRIX_UPDATE_SKIP : 'matrix store creation disabled with --no-matrix' };
 }
 // Remind only when the store was just created or is still missing after init;
 // a plain update that follows the no-project-state rule stays quiet.
 if (matrix.created) {
  instructions.push(MATRIX_COMMIT);
 } else if (!exists(deps, storePath) && !(command === 'update' && opts.matrix !== true)) {
  instructions.push(MATRIX_REMINDER);
 }
 return { command, cwd, created, preserved, ready:readiness.ok && skill.ok, pi:readiness.pi, skill, excluded, matrix, install,
  installSummary:summarizeInstall(install,null), instructions };
}


const SKILL_TARGETS:SkillTargetSelection[]=['codex','claude','both','none'];
function isSkillTarget(value:string|undefined):value is SkillTargetSelection {
 return !!value && (SKILL_TARGETS as string[]).includes(value);
}

/** Parse the `init` flags shared by the `worker.ts` and `junior.ts` CLIs. */
export function parseInitOptions(argv:string[]):InitOptions {
 // The CLI installs Pi, the managed tools and the companion tools by default.
 const opts:InitOptions={ install:true };
 for (let i=0;i<argv.length;i++) {
  const a=argv[i];
  if (a === '--install') opts.install=true;
  else if (a === '--no-install') opts.install=false;
  else if (a === '--no-companions') opts.companions=false;
  else if (a === '--user') opts.scope='user';
  else if (a === '--project') opts.scope='project';
  else if (a === '--upgrade') opts.upgrade=true;
  else if (a === '--update') opts.update=true;
  else if (a === '--with-triz') opts.withTriz=true;
  else if (a === '--no-matrix') opts.matrix=false;
  else if (a === '--with-matrix') opts.matrix=true;
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

// ---------------------------------------------------------------------------
// Companion tools (fmeca, cpm, jevitate npm packages and their agent skills).
//
// Each companion's own installer writes its skills; Junior only orchestrates.
// Paths that become untracked during the skill install are recorded as exact
// local Git exclusions, exactly like Junior's own generated files, so a fresh
// project stays ready for a `worktree` handoff. A tracked file an installer
// edits (for example a shared AGENTS.md block) is reported, never hidden.
// ---------------------------------------------------------------------------

export type CompanionSetupResult = {
 install:CompanionInstallReport | null;
 skills:CompanionSkillReport;
 excluded:string[];
 modifiedTracked:string[];
 ok:boolean;
};

function gitLines(cwd:string, args:string[]):string[] | null {
 const r=spawnSync('git',args,{cwd,encoding:'utf8'});
 if (r.error || r.status !== 0) return null;
 return String(r.stdout||'').split('\n').map((l)=>l.trim()).filter(Boolean);
}

export function setupCompanions(
 deps:SetupDeps,
 opts:{ target?:SkillTargetSelection; scope?:SkillScope; install?:boolean; update?:boolean },
):CompanionSetupResult {
 const cwd=deps.cwd ?? process.cwd();
 const cdeps={ env:deps.env, exists:deps.exists, exec:deps.exec };
 const untracked=()=>gitLines(cwd,['ls-files','--others','--exclude-standard']);
 const modified=()=>gitLines(cwd,['diff','--name-only']);
 const beforeUntracked=new Set(untracked() ?? []);
 const beforeModified=new Set(modified() ?? []);
 const install=opts.install === false ? null : installCompanions(cdeps,{ update:opts.update });
 const skills=installCompanionSkills(cdeps,{ target:opts.target ?? 'both', scope:opts.scope ?? 'project', cwd });
 const created=(untracked() ?? []).filter((p)=>!beforeUntracked.has(p));
 const excluded=created.length ? ensureLocalExcludes(cwd, created.map((p)=>`/${p}`)).added : [];
 const modifiedTracked=(modified() ?? []).filter((p)=>!beforeModified.has(p));
 return { install, skills, excluded, modifiedTracked, ok:(install ? install.ok : true) && skills.ok };
}
