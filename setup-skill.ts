import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { PACKAGED_SKILL_PATH, SKILL_FILENAME, SKILL_MANIFEST_FILENAME, SKILL_NAME, exists, readText, resolveJuniorCliPath, type SetupDeps } from './setup-env.ts';

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
export type SkillInstallOptions = { target?:SkillTargetSelection; scope?:SkillScope; upgrade?:boolean; force?:boolean; skillRoot?:string; roots?:string[] };
export type InitOptions = SkillInstallOptions & { install?:boolean; update?:boolean; withTriz?:boolean; companions?:boolean; matrix?:boolean; command?:'init'|'update' };

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
 * refreshed by default (pass `upgrade:false` to leave it); a customized copy is
 * preserved unless `force`. */
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
   if (opts.upgrade !== false) {
    write(path,source); writeSkillManifest(deps,manifestPath,sourceHash,sourcePath);
    actions.push({manager,path,status:'upgraded',message:`upgraded the ${manager} skill from its recorded version`});
   } else {
    actions.push({manager,path,status:'outdated',message:`the ${manager} skill is outdated; re-run \`junior init\` to replace the unmodified installed copy`});
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

/** Classify one installed skill copy against the packaged source hash: an
 * exact match is current, a copy that still matches its recorded manifest is
 * outdated, and anything else was customized. */
function skillStatusAt(deps:SetupDeps, sourceHash:string, root:string, path:string):SkillReadiness['targets'][number]['status'] {
 if (!exists(deps,path)) return 'missing';
 const currentHash=sha256(readText(deps,path));
 if (currentHash === sourceHash) return 'current';
 if (readManifestHash(deps,join(root,SKILL_MANIFEST_FILENAME)) === currentHash) return 'outdated';
 return 'customized';
}

/** Read-only skill readiness for the selected managers. Never writes. When
 * `roots` is supplied, those explicit harness skill roots are inspected
 * instead of the manager/scope defaults and the skill is ready when any root
 * holds a current copy. */
export function inspectSkill(deps:SetupDeps = {}, opts:SkillInstallOptions = {}):SkillReadiness {
 const target=opts.target ?? 'both';
 const scope=opts.scope ?? 'project';
 const { path:sourcePath, text:source }=readSkillSource(deps);
 const sourceHash=sha256(source);
 const targets:SkillReadiness['targets']=[];
 const roots=opts.roots && opts.roots.length ? opts.roots : null;
 if (roots) {
  for (const root of roots) {
   const path=join(root,SKILL_NAME,SKILL_FILENAME);
   const manager:SkillManager=root.includes('.claude') ? 'claude' : 'codex';
   targets.push({manager,path,status:skillStatusAt(deps,sourceHash,root,path)});
  }
 } else {
  for (const manager of selectedManagers(target)) {
   const root=skillRootFor(deps,scope,manager,opts.skillRoot);
   const path=join(root,SKILL_NAME,SKILL_FILENAME);
   targets.push({manager,path,status:skillStatusAt(deps,sourceHash,root,path)});
  }
 }
 const ready=roots ? targets.some((t)=>t.status === 'current') : targets.every((t)=>t.status === 'current');
 return { ready, source:sourcePath, targets };
}

/** One plain-language doctor line per affected skill state, grouped by status
 * and naming the affected managers (sorted) so the remedy is unambiguous. */
export function skillMessageLines(skill:SkillReadiness):string[] {
 const managers=(status:SkillReadiness['targets'][number]['status'])=>skill.targets.filter((t)=>t.status === status).map((t)=>t.manager).sort().join(', ');
 const states:Array<[SkillReadiness['targets'][number]['status'],(m:string)=>string]>=[
  ['outdated',(m)=>`Junior skill is outdated (${m}); run \`junior update\``],
  ['customized',(m)=>`Junior skill is customized (${m}); it is preserved; \`junior init --force\` replaces it`],
  ['missing',(m)=>`Junior skill is not installed (${m}); run \`junior init\``],
 ];
 const lines:string[]=[];
 for (const [status,format] of states) { const affected=managers(status); if (affected) lines.push(format(affected)); }
 return lines;
}
