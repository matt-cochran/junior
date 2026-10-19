// ---------------------------------------------------------------------------
// Newer commodity models for the configured roster.
//
// `modelUpdates` pairs every roster profile with the strictly newer releases in
// its lineage, keeping only commodity models, so doctor, the startup update
// check and `junior model upgrade` all report the same thing. `catalogIds`
// reads the OpenRouter catalog when asked (and reachable) and otherwise falls
// back to Pi's local catalog; neither ever throws.
// ---------------------------------------------------------------------------

import { homedir } from 'node:os';
import { join } from 'node:path';
import { isCommodity } from './model-policy.ts';
import { fetchOnlineCatalog, newerInLineage, readLocalCatalog, type CatalogFetch } from './models.ts';
import type { ModelConfig } from './roster.ts';

export type ModelUpdate = { profile:string; provider:string; current:string; newer:string[]; latest:string|null; isDefault:boolean };
export type CatalogIds = { ids:string[]; catalog:'online'|'local'|null };

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
export async function catalogIds(opts:{ online?:boolean; fetch?:CatalogFetch; timeoutMs?:number; env?:NodeJS.ProcessEnv } = {}):Promise<CatalogIds> {
 if (opts.online) {
  const entries=await fetchOnlineCatalog({ fetch:opts.fetch, timeoutMs:opts.timeoutMs });
  if (entries) return { ids:entries.map((e)=>e.id), catalog:'online' };
 }
 const local=readLocalCatalog(piAgentDir(opts.env));
 if (local.source) return { ids:local.entries.map((e)=>e.id), catalog:'local' };
 return { ids:[], catalog:null };
}
