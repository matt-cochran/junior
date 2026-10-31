import {existsSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,statSync,writeFileSync} from 'node:fs';
import {dirname,resolve,relative,isAbsolute,join,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {inspectHop} from './tools/tools.ts';

export interface HopCandidate {
 path:string;
 relativePath:string;
 projectId:string|null;
 revision:number|null;
 selectCommand:string;
}

export type HopResolution =
 | {status:'selected';source:'explicit'|'active'|'config'|'discovered';path:string;candidates:HopCandidate[]}
 | {status:'ambiguous';candidates:HopCandidate[];command:string;message:string}
 | {status:'none';source:'default';path:string;candidates:[];message:string};

function canonical(path:string):string {
 try { return realpathSync(path); } catch { return resolve(path); }
}

export function projectRoot(start:string):string {
 const origin=resolve(start);
 let dir=origin;
 while (true) {
  const hasDelivery=existsSync(join(dir,'.delivery'))||existsSync(join(dir,'delivery.config.json'));
  // The starting directory may itself be a checkout. Above it, only a project
  // marker (not an unrelated parent's .git) may claim the tree.
  if (hasDelivery||(dir===origin&&existsSync(join(dir,'.git')))) return dir;
  const parent=dirname(dir);
  if (parent===dir) return origin;
  dir=parent;
 }
}

function readJson(path:string):unknown {
 try { return JSON.parse(readFileSync(path,'utf8')); } catch { return null; }
}

function selectionValue(value:unknown):string|null {
 if (typeof value==='string'&&value.trim()) return value.trim();
 if (!value||typeof value!=='object'||Array.isArray(value)) return null;
 const entry=value as Record<string,unknown>;
 for (const key of ['hop','path','hopPath']) {
  if (typeof entry[key]==='string'&&(entry[key] as string).trim()) return (entry[key] as string).trim();
 }
 return null;
}

function configuredHop(root:string):string|null {
 const config=readJson(join(root,'delivery.config.json'));
 if (!config||typeof config!=='object'||Array.isArray(config)) return null;
 const tools=(config as Record<string,unknown>).tools;
 if (!tools||typeof tools!=='object'||Array.isArray(tools)) return null;
 return selectionValue((tools as Record<string,unknown>).hop);
}

function activeHop(root:string):string|null {
 return selectionValue(readJson(join(root,'.delivery','active-hop.json')));
}

function selectionCommand(path:string):string {
 return `junior compact --hop ${JSON.stringify(path)}`;
}

function candidate(root:string,path:string):HopCandidate {
 const manifest=readJson(path);
 const projectId=manifest&&typeof manifest==='object'&&typeof (manifest as any).projectId==='string'?(manifest as any).projectId:null;
 const revision=manifest&&typeof manifest==='object'&&typeof (manifest as any).revision==='number'?(manifest as any).revision:null;
 const full=canonical(path);
 return {path:full,relativePath:relative(root,full).split(sep).join('/'),projectId,revision,selectCommand:selectionCommand(full)};
}

function nestedManifests(root:string):string[] {
 const found:string[]=[];
 const ignored=new Set(['.git','node_modules','worktrees','worktree']);
 const walk=(dir:string):void=>{
  let entries;
  try { entries=readdirSync(dir,{withFileTypes:true}); } catch { return; }
  entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  for (const entry of entries) {
   if (entry.isSymbolicLink()) continue;
   const path=join(dir,entry.name);
   if (entry.isDirectory()) {
    if (!ignored.has(entry.name)) walk(path);
   } else if (entry.isFile()&&entry.name==='hop.json') found.push(path);
  }
 };
 walk(join(root,'.delivery'));
 return found;
}

/** Enumerate every hop.json below `.delivery`, never following
 * symlinks or entering dependency/worktree directories. Results are canonical
 * and sorted by project-relative path. */
export function discoverHops(cwd:string):HopCandidate[] {
 const root=projectRoot(cwd);
 return nestedManifests(root).map(path=>candidate(root,path)).sort((a,b)=>
  a.relativePath<b.relativePath?-1:a.relativePath>b.relativePath?1:0);
}

/**
 * Resolve the Hop for a project. An explicit path always wins. Otherwise a
 * remembered `.delivery/active-hop.json` selection wins over `delivery.config.json`
 * `tools.hop`, which wins over discovery. Discovery selects only a sole
 * candidate; several candidates are reported as ambiguous with an actionable
 * `--hop` command, never guessed.
 */
export function resolveHop(cwd:string,options:{explicit?:string}={}):HopResolution {
 const root=projectRoot(cwd);
 const candidates=discoverHops(root);
 if (options.explicit) {
  return {status:'selected',source:'explicit',path:canonical(resolve(cwd,options.explicit)),candidates};
 }
 const active=activeHop(root);
 if (active) return {status:'selected',source:'active',path:canonical(resolve(root,active)),candidates};
 const configured=configuredHop(root);
 if (configured) return {status:'selected',source:'config',path:canonical(resolve(root,configured)),candidates};
 if (candidates.length===0) {
  return {status:'none',source:'default',path:join(root,'.delivery','setup','hop.json'),candidates:[],
   message:'No nested Hop was found; the project default Hop path is being used.'};
 }
 if (candidates.length===1) return {status:'selected',source:'discovered',path:candidates[0].path,candidates};
 return {status:'ambiguous',candidates,command:'junior compact --hop <path>',
  message:`Multiple nested Hops were found: ${candidates.map(hop=>hop.path).join(', ')}. Select one explicitly with: junior compact --hop <path>.`};
}

/** Persist an explicit project-level Hop selection in `.delivery/active-hop.json`.
 * A selected path inside the project is stored relative so moving the checkout
 * does not stale the selection. Returns the canonical path. */
export function selectActiveHop(cwd:string,hopPath:string):string {
 const root=projectRoot(cwd);
 const full=canonical(resolve(root,hopPath));
 inspectHop(full);
 const relativePath=relative(root,full);
 const stored=isAbsolute(relativePath)||relativePath==='..'||relativePath.startsWith(`..${sep}`)
  ? full
  : relativePath.split(sep).join('/');
 const directory=join(root,'.delivery');
 mkdirSync(directory,{recursive:true});
 const target=join(directory,'active-hop.json'), temporary=`${target}.${process.pid}.${randomUUID()}.tmp`;
 writeFileSync(temporary,`${JSON.stringify({hop:stored},null,2)}\n`);
 renameSync(temporary,target);
 return full;
}

/** One compact, integrity-checked context shared by manager, Jev and executor. */
export function loadHopContext(path:string) {
 const full=resolve(path), root=dirname(full), report=inspectHop(full);
 const latest=new Map<string,any>();
 for(const snapshot of report.snapshots) latest.set(snapshot.tool,snapshot);
 const snapshots=[...latest.values()].map(snapshot=>{
  const location=resolve(root,snapshot.path), rel=relative(root,location);
  if(isAbsolute(rel)||rel==='..'||rel.startsWith('../')) throw Error('HOP snapshot escapes its state directory');
  const actual=realpathSync(location), actualRelative=relative(realpathSync(root),actual);
  if(isAbsolute(actualRelative)||actualRelative==='..'||actualRelative.startsWith('../')) throw Error('HOP snapshot symlink escapes its state directory');
  if(statSync(actual).size>8*1024*1024) throw Error('HOP snapshot exceeds the 8 MiB limit');
  const bytes=readFileSync(actual);
  const digest=createHash('sha256').update(bytes).digest('hex');
  if(snapshot.sha256.replace(/^sha256:/,'')!==digest) throw Error(`HOP snapshot integrity failed: ${snapshot.id}`);
  const text=bytes.toString('utf8');
  return {...snapshot,path:location,content:text.slice(0,8192),truncated:text.length>8192};
 });
 return {schemaVersion:1,from:full,projectId:report.projectId,revision:report.revision,
  managerAcceptance:report.managerAcceptance,acceptedRevision:report.acceptedRevision,
  toolSourceVersions:report.toolSourceVersions,toolSourceShas:report.toolSourceShas,
  snapshotCount:report.snapshotCount,snapshots,unresolved:report.unresolved.slice(-10),
  unresolvedCount:report.unresolved.length,note:report.note};
}