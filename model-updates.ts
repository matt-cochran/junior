// ---------------------------------------------------------------------------
// Newer commodity models for the configured roster.
//
// `modelUpdates` pairs every roster profile with the strictly newer releases in
// its lineage, keeping only commodity models, so doctor, the startup update
// check and `junior model upgrade` all report the same thing. `catalogIds`
// reads the OpenRouter catalog when asked (and reachable) and otherwise falls
// back to Pi's local catalog; neither ever throws.
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { isCommodity } from './model-policy.ts';
import { fetchOnlineCatalog, newerInLineage, readLocalCatalog, type CatalogFetch } from './models.ts';
import type { ModelConfig } from './roster.ts';

export type ModelUpdate = { profile:string; provider:string; current:string; newer:string[]; latest:string|null; isDefault:boolean };
export type CatalogIds = { ids:string[]; catalog:'online'|'local'|null };

/** How long a cached online catalog may back offline update detection. */
export const MODEL_CATALOG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Resolve `~/.junior/model-catalog.json`, honouring JUNIOR_HOME and the parent
 * of JUNIOR_TOOLS_ROOT (`<home>/.junior/tools` -> `<home>/.junior`). Mirrors
 * `updateCheckCachePath` but keeps this module free of an update-check import
 * cycle. */
export function modelCatalogCachePath(env:NodeJS.ProcessEnv = process.env):string {
 if (env.JUNIOR_HOME) return join(env.JUNIOR_HOME, 'model-catalog.json');
 if (env.JUNIOR_TOOLS_ROOT) return join(dirname(env.JUNIOR_TOOLS_ROOT), 'model-catalog.json');
 const base=env.HOME ?? env.USERPROFILE ?? '.';
 return join(base,'.junior','model-catalog.json');
}

/** Best-effort atomic write of the online catalog; a failure never breaks the
 * caller, which already has the ids in hand. */
function writeCatalogCache(path:string, ids:string[]):void {
 if (!isAbsolute(path)) return; // no resolvable home: never cache into the cwd
 try {
  mkdirSync(dirname(path),{ recursive:true });
  const tmp=`${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ checkedAt:Date.now(), ids }));
  renameSync(tmp, path);
 } catch { /* the online catalog still serves this run */ }
}

/** Read the cached online catalog when it is present, well-formed and no older
 * than `maxAgeMs` (default seven days). Missing, malformed and stale caches
 * all read as null. */
export function readCachedCatalog(env:NodeJS.ProcessEnv = process.env, opts:{ now?:()=>number; maxAgeMs?:number; cachePath?:string } = {}):{ ids:string[]; checkedAt:number }|null {
 const path=opts.cachePath ?? modelCatalogCachePath(env);
 let text:string;
 try { text=readFileSync(path,'utf8'); } catch { return null; }
 let parsed:any;
 try { parsed=JSON.parse(text); } catch { return null; }
 if (!parsed || typeof parsed !== 'object') return null;
 if (typeof parsed.checkedAt !== 'number' || !Array.isArray(parsed.ids) || !parsed.ids.every((id:any)=>typeof id==='string')) return null;
 const now=(opts.now ?? Date.now)();
 const maxAgeMs=opts.maxAgeMs ?? MODEL_CATALOG_CACHE_TTL_MS;
 if (now - parsed.checkedAt > maxAgeMs) return null;
 return { ids:parsed.ids, checkedAt:parsed.checkedAt };
}

/** Pi's agent directory, honouring PI_CODING_AGENT_DIR like Pi itself. */
export function piAgentDir(env:NodeJS.ProcessEnv = process.env):string {
 if (env.PI_CODING_AGENT_DIR) return env.PI_CODING_AGENT_DIR;
 const home=env.HOME || env.USERPROFILE || homedir();
 return join(home,'.pi','agent');
}

/** One entry per roster profile with the newer commodity releases in its
 * lineage, newest first. Only OpenRouter catalog ids are compared, so a
 * profile on another provider reports no newer releases. */
export function modelUpdates(config:ModelConfig, ids:Iterable<string>):ModelUpdate[] {
 const all=[...ids];
 return config.roster.map((p)=>{
  const newer=p.provider === 'openrouter' ? newerInLineage(p.model, all).filter((id)=>isCommodity(p.provider, id)) : [];
  return { profile:p.id, provider:p.provider, current:p.model, newer, latest:newer[0] ?? null, isDefault:p.id === config.defaultProfile };
 });
}

/** Catalog ids for update detection: online when requested and reachable,
 * else the local Pi catalog, else none. */
export async function catalogIds(opts:{ online?:boolean; fetch?:CatalogFetch; timeoutMs?:number; env?:NodeJS.ProcessEnv; cachePath?:string } = {}):Promise<CatalogIds> {
 if (opts.online) {
  const entries=await fetchOnlineCatalog({ fetch:opts.fetch, timeoutMs:opts.timeoutMs });
  if (entries) {
   const ids=entries.map((e)=>e.id);
   writeCatalogCache(opts.cachePath ?? modelCatalogCachePath(opts.env), ids);
   return { ids, catalog:'online' };
  }
 }
 const local=readLocalCatalog(piAgentDir(opts.env));
 if (local.source) return { ids:local.entries.map((e)=>e.id), catalog:'local' };
 return { ids:[], catalog:null };
}
