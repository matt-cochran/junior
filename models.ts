// ---------------------------------------------------------------------------
// Model-id lineage parsing and model-catalog reads.
//
// `parseModelId` decomposes a `vendor/name` model id into the parts that make
// releases comparable: a numeric version, an optional snapshot, a tier and the
// derived lineage. `newerInLineage` uses that to surface strictly newer
// releases of the same lineage, skipping aliases, variants and unstable builds.
//
// `readLocalCatalog` reads Pi's local catalog overlay (`models-store.json`)
// with `models.json` as fallback, and `fetchOnlineCatalog` reads the
// OpenRouter catalog online. Both are fully injectable so tests never touch the
// network or the real agent directory, and both fail closed to an empty or null
// result instead of throwing.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type ParsedModelId = {
 raw:string;
 vendor:string;
 name:string;
 family:string;
 version:number[];
 tier:string;
 snapshot:string|null;
 variant:string|null;
 alias:boolean;
 unstable:boolean;
 lineage:string;
};

/** A numeric version segment: optional glued prefix letter, dotted digits, and
 * optional letters glued right after the digits (`glm-5v-turbo`). */
const VERSION_SEGMENT=/^([a-zA-Z]*)(\d[\d.]*)([a-zA-Z]*)$/;
const UNSTABLE_MARKERS=['exp','preview','beta','alpha','vision'];

/** Split a `vendor/name` id into its lineage parts. Returns null when the id
 * has no vendor separator. Ids whose name carries no numeric version still
 * parse, with `version` empty. */
export function parseModelId(id:string):ParsedModelId|null {
 if (typeof id !== 'string' || !id.includes('/')) return null;
 const raw=id;
 let rest=id;
 let alias=false;
 if (rest.startsWith('~')) { alias=true; rest=rest.slice(1); }
 const slash=rest.indexOf('/');
 const vendor=rest.slice(0,slash);
 let name=rest.slice(slash+1);
 if (!vendor || !name) return null;
 let variant:string|null=null;
 const colon=name.indexOf(':');
 if (colon >= 0) { variant=name.slice(colon+1); name=name.slice(0,colon); }
 if (!name) return null;
 let snapshot:string|null=null;
 let base=name;
 let m=base.match(/-(\d{4})-(\d{2})-(\d{2})$/);
 if (m) { snapshot=m[1]+m[2]+m[3]; base=base.slice(0,m.index); }
 else if ((m=base.match(/-(\d{8})$/))) { snapshot=m[1]; base=base.slice(0,m.index); }
 else if ((m=base.match(/-(\d{4})$/))) { snapshot=m[1]; base=base.slice(0,m.index); }
 const segs=base.split('-').filter(s=>s.length>0);
 let vi=-1;
 for (let i=0;i<segs.length;i++) { if (VERSION_SEGMENT.test(segs[i])) { vi=i; break; } }
 let version:number[]=[];
 let family=base;
 let tier='';
 if (vi >= 0) {
  const mm=segs[vi].match(VERSION_SEGMENT) as RegExpMatchArray;
  version=mm[2].split('.').map(d=>Number(d));
  family=[...segs.slice(0,vi),mm[1]].filter(Boolean).join('-') || base;
  tier=[mm[3],...segs.slice(vi+1)].filter(Boolean).join('-');
 }
 const unstable=UNSTABLE_MARKERS.some(marker=>tier.toLowerCase().includes(marker));
 return { raw, vendor, name, family, version, tier, snapshot, variant, alias, unstable, lineage:`${vendor}/${family}|${tier}` };
}

/** Compare two parsed ids: version arrays numerically with missing parts as 0,
 * then snapshots, where no snapshot is older than any snapshot and snapshots
 * compare as normalized digit strings. */
export function compareModelIds(a:ParsedModelId, b:ParsedModelId):number {
 const len=Math.max(a.version.length,b.version.length);
 for (let i=0;i<len;i++) {
  const av=a.version[i] ?? 0, bv=b.version[i] ?? 0;
  if (av !== bv) return av < bv ? -1 : 1;
 }
 const as=a.snapshot, bs=b.snapshot;
 if (as === bs) return 0;
 if (as === null) return -1;
 if (bs === null) return 1;
 return as < bs ? -1 : 1;
}

/** Ids strictly newer than `pinned` in the same lineage, newest first and
 * de-duplicated. Alias, variant and unstable ids are never returned, as are
 * ids without a numeric version. An unparsable pin returns []. */
export function newerInLineage(pinned:string, ids:Iterable<string>):string[] {
 const p=parseModelId(pinned);
 if (!p) return [];
 const out:ParsedModelId[]=[];
 const seen=new Set<string>();
 for (const id of ids) {
  const c=parseModelId(id);
  if (!c || c.alias || c.variant !== null || c.unstable) continue;
  if (c.version.length === 0) continue;
  if (c.lineage !== p.lineage) continue;
  if (compareModelIds(p,c) >= 0) continue;
  if (seen.has(c.raw)) continue;
  seen.add(c.raw);
  out.push(c);
 }
 out.sort((x,y)=>compareModelIds(y,x));
 return out.map(c=>c.raw);
}

export type CatalogEntry = { id:string; provider:string; name?:string; created?:number|null; price?:ModelPrice };
export type ModelPrice = { inputPerM:number; outputPerM:number; cacheReadPerM:number|null };
export type LocalCatalog = { entries:CatalogEntry[]; source:'models-store.json'|'models.json'|null; mtimeMs:number|null };

/** Coerce a pricing field that OpenRouter may send as a string or a number. */
function priceNumber(value:unknown):number|null {
 if (typeof value === 'number') return Number.isFinite(value) ? value : null;
 if (typeof value === 'string' && value.trim() !== '') { const n=Number(value); return Number.isFinite(n) ? n : null; }
 return null;
}

function roundPrice(n:number):number { return Math.round(n * 1e6) / 1e6; }

/** Build a `ModelPrice` from USD-per-token `pricing` (OpenRouter), scaling to
 * per-million tokens. A missing or invalid prompt/completion drops the price;
 * a missing cache read becomes null. */
function onlinePrice(pricing:any):ModelPrice|undefined {
 if (!pricing || typeof pricing !== 'object') return undefined;
 const input=priceNumber(pricing.prompt);
 const output=priceNumber(pricing.completion);
 if (input === null || output === null) return undefined;
 const cacheRead=priceNumber(pricing.input_cache_read);
 return { inputPerM:roundPrice(input * 1e6), outputPerM:roundPrice(output * 1e6), cacheReadPerM:cacheRead === null ? null : roundPrice(cacheRead * 1e6) };
}

/** Build a `ModelPrice` from Pi's `cost` fields, which are already USD per
 * million tokens. A missing or invalid input/output drops the price; a missing
 * cache read becomes null. */
function localPrice(cost:any):ModelPrice|undefined {
 if (!cost || typeof cost !== 'object') return undefined;
 const input=priceNumber(cost.input);
 const output=priceNumber(cost.output);
 if (input === null || output === null) return undefined;
 const cacheRead=priceNumber(cost.cacheRead);
 return { inputPerM:roundPrice(input), outputPerM:roundPrice(output), cacheReadPerM:cacheRead === null ? null : roundPrice(cacheRead) };
}

type LocalCatalogFs = {
 existsSync(p:string):boolean;
 readFileSync(p:string,e:'utf8'):string;
 statSync(p:string):{mtimeMs:number};
};

/** Parse one catalog file for a provider. `store` uses Pi's overlay shape
 * (`{provider:{models:[...]}}`); `custom` uses `models.json`
 * (`{providers:{provider:{models:[...]}}}`). Returns null when the file is
 * malformed or has no models array for the provider. */
function parseCatalogFile(text:string, shape:'store'|'custom', provider:string):CatalogEntry[]|null {
 let parsed:any;
 try { parsed=JSON.parse(text); } catch { return null; }
 if (!parsed || typeof parsed !== 'object') return null;
 const container=shape === 'store' ? parsed : parsed.providers;
 const models=container?.[provider]?.models;
 if (!Array.isArray(models)) return null;
 const out:CatalogEntry[]=[];
 for (const m of models) {
  if (!m || typeof m.id !== 'string') continue;
  const entry:CatalogEntry={ id:m.id, provider };
  if (typeof m.name === 'string') entry.name=m.name;
  if (typeof m.created === 'number' || m.created === null) entry.created=m.created ?? null;
  const price=localPrice(m.cost);
  if (price) entry.price=price;
  out.push(entry);
 }
 return out;
}

/** Read Pi's local catalog for one provider. `models-store.json` wins over
 * `models.json`. A missing or malformed catalog yields empty entries and a
 * null source. The filesystem is injectable for offline tests. */
export function readLocalCatalog(agentDir:string, provider='openrouter', fs?:LocalCatalogFs):LocalCatalog {
 const io:LocalCatalogFs=fs ?? { existsSync, readFileSync:readFileSync as any, statSync };
 const attempts:[LocalCatalog['source'], string, 'store'|'custom'][]=[
  ['models-store.json', join(agentDir,'models-store.json'), 'store'],
  ['models.json', join(agentDir,'models.json'), 'custom'],
 ];
 for (const [source,path,shape] of attempts) {
  if (!io.existsSync(path)) continue;
  let text:string;
  try { text=io.readFileSync(path,'utf8'); } catch { continue; }
  const entries=parseCatalogFile(text,shape,provider);
  if (!entries) continue;
  let mtimeMs:number|null=null;
  try { mtimeMs=io.statSync(path).mtimeMs; } catch { mtimeMs=null; }
  return { entries, source, mtimeMs };
 }
 return { entries:[], source:null, mtimeMs:null };
}

export const OPENROUTER_MODELS_URL='https://openrouter.ai/api/v1/models';
export type CatalogFetch=(url:string, init:{ signal?:AbortSignal; headers?:Record<string,string> })=>Promise<{ status:number; json():Promise<any> }>;

/** GET the OpenRouter catalog without credentials. Any network error, timeout
 * (default 3000 ms), non-200 response or unexpected shape resolves to null, so
 * this never throws. */
export async function fetchOnlineCatalog(opts:{ fetch?:CatalogFetch; timeoutMs?:number; url?:string }={}):Promise<CatalogEntry[]|null> {
 const doFetch=opts.fetch ?? (globalThis.fetch as unknown as CatalogFetch);
 const timeoutMs=opts.timeoutMs ?? 3000;
 const url=opts.url ?? OPENROUTER_MODELS_URL;
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeoutMs);
 if (typeof (timer as any).unref === 'function') (timer as any).unref();
 // The race bounds a fetch that ignores the abort signal, so startup never stalls.
 const expired=new Promise<null>(res=>controller.signal.addEventListener('abort',()=>res(null)));
 try {
  const res=await Promise.race([doFetch(url,{ signal:controller.signal }),expired]);
  if (!res || res.status !== 200) return null;
  const body=await res.json();
  const data=body?.data;
  if (!Array.isArray(data)) return null;
  const out:CatalogEntry[]=[];
  for (const m of data) {
   if (!m || typeof m.id !== 'string') continue;
   const entry:CatalogEntry={ id:m.id, provider:'openrouter' };
   if (typeof m.name === 'string') entry.name=m.name;
   if (typeof m.created === 'number' || m.created === null) entry.created=m.created ?? null;
   const price=onlinePrice(m.pricing);
   if (price) entry.price=price;
   out.push(entry);
  }
  return out;
 } catch {
  return null;
 } finally {
  clearTimeout(timer);
 }
}
