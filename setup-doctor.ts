import { join } from 'node:path';
import { inspectIntegrations, type IntegrationsResult } from './installer.ts';
import { inspectCompanions, inspectCompanionSkills, type CompanionsReport, type CompanionSkillsReport } from './companions.ts';
import { retainedWorktreeSummary, type RetentionSummary } from './retention.ts';
import { inspectReadiness, type ReadinessResult } from './readiness.ts';
import { classifyModel } from './model-policy.ts';
import { inspectStoreDenyRules } from './harness.ts';
import { readLocalCatalog, type ModelPrice } from './models.ts';
import { loadModelConfig, type ModelConfig } from './roster.ts';
import { modelUpdates, readCachedCatalog } from './model-updates.ts';
import { GATEWAY_KINDS, GATEWAYS, validateJevProvider, resolveGatewayKey, resolveJevGateway, type GatewayKind, type JevProvider } from './gateway.ts';
import { agentDir, compareSemver, checkPi, exists, loadDefaults, readText, SUPPORTED_NODE_MIN, DEFAULT_PROVIDER, PI_PACKAGE, TESTED_PI_VERSION, type SetupDeps } from './setup-env.ts';
import { inspectSkill, skillMessageLines, type SkillReadiness } from './setup-skill.ts';
import type { InitResult } from './setup-init.ts';

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

export const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';

/** Minimal HTTP response shape the online credential check depends on. */
export type FetchResponse = { status:number; json:()=>Promise<any> };
/** Injectable fetch seam. The default is the runtime `fetch`; tests inject a stub. */
export type FetchLike = (url:string, init:{ headers:Record<string,string> })=>Promise<FetchResponse>;

export type OnlineCredentialCheck = {
 provider:string;
 /** `true`/`false` only when the provider answered; `null` when the check was inconclusive. */
 valid:boolean|null;
 usage:number|null;
 limit:number|null;
 remaining:number|null;
 ready:boolean;
 error?:string;
};

/** Read the provider's usable credential value for an outbound header. This is
 * the same auth.json/env lookup `checkCredentials` uses, but it is never
 * returned or logged; only its presence reaches the caller. */
function readProviderKey(provider:string, deps:SetupDeps):string|null {
 const authPath=join(agentDir(deps),'auth.json');
 if (exists(deps,authPath)) {
  try {
   const j=JSON.parse(readText(deps,authPath));
   const c:any=j?.[provider];
   if (c && typeof c==='object') {
    if (['api_key','api'].includes(c.type) && typeof c.key==='string' && c.key.trim()) return c.key.trim();
    if (c.type==='oauth' && typeof c.access==='string' && c.access.trim()) return c.access.trim();
   }
  } catch { /* an unreadable auth file is simply no credential */ }
 }
 const env=deps.env ?? process.env;
 const envVar=provider==='openrouter' ? 'OPENROUTER_API_KEY' : provider==='deepseek' ? 'DEEPSEEK_API_KEY' : null;
 if (envVar && typeof env[envVar]==='string' && env[envVar]!.trim()) return env[envVar]!.trim();
 return null;
}

/** Opt-in online check: ask the provider whether the local credential is valid
 * and still has credit. Never returns or prints the credential value. */
export async function checkCredentialsOnline(deps:SetupDeps = {}):Promise<OnlineCredentialCheck> {
 const provider=DEFAULT_PROVIDER;
 const base:OnlineCredentialCheck={ provider, valid:null, usage:null, limit:null, remaining:null, ready:false };
 const key=readProviderKey(provider,deps);
 if (!key) return { ...base, error:`no ${provider} credential present` };
 const doFetch=deps.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
 if (typeof doFetch !== 'function') return { ...base, error:'fetch is unavailable in this runtime' };
 let res:FetchResponse;
 try {
  res=await doFetch(OPENROUTER_KEY_URL,{ headers:{ Authorization:`Bearer ${key}` } });
 } catch { return { ...base, error:`could not reach ${provider}` }; }
 if (res?.status===401 || res?.status===403) return { ...base, valid:false, error:`${provider} rejected the credential (HTTP ${res.status})` };
 if (!res || typeof res.status!=='number' || res.status<200 || res.status>=300) return { ...base, error:`${provider} key check failed (HTTP ${res?.status ?? 'unknown'})` };
 let data:any;
 try { data=(await res.json())?.data ?? {}; } catch { return { ...base, error:`${provider} returned an unreadable response` }; }
 const usage=typeof data.usage==='number' ? data.usage : 0;
 const limit=typeof data.limit==='number' ? data.limit : null;
 const remaining=limit===null ? null : limit-usage;
 const ready=limit===null || (remaining as number)>0;
 return { provider, valid:true, usage, limit, remaining, ready };
}

export type ModelStoreStatus = 'missing' | 'empty' | 'populated';
export type ModelCheck = {
 provider:string;
 id:string;
 available:boolean;
 source:string|null;
 /** Whether the local catalog files are absent, present but empty, or hold models. */
 storeStatus:ModelStoreStatus;
 note?:string;
 /** Project/builtin pin Junior would execute, and where it came from. */
 pinned?:{provider:string; id:string; source:'project'|'builtin'; path:string|null};
 /** Offline policy classification of the pinned model. */
 policy?:{class:'commodity'|'frontier'|'unknown'; reason:string};
 routing?:'off'|'shadow'|'auto';
 autoUpgrade?:boolean;
 /** Roster profiles with local-catalog availability and default marking. */
 roster?:{profile:string; provider:string; model:string; available:boolean; default:boolean}[];
 rejected?:{id:string; model:string; reason:string}[];
 /** Roster profiles with newer commodity releases, their price-parity verdict
  * and the current-to-latest ratios when a price is known. */
 newer?:{profile:string; current:string; newer:string[]; comparable:boolean|null; inputRatio:number|null; outputRatio:number|null}[];
};

/** Count model entries for one provider in a parsed catalog object. Other
 * providers never make the selected provider look populated. */
function countProviderModels(parsed:any, shape:'store'|'custom', provider:string):number {
 const container=shape === 'store' ? parsed : parsed?.providers;
 const models=container?.[provider]?.models;
 return Array.isArray(models) ? models.filter(Boolean).length : 0;
}

/** Verify the requested model against Pi's local catalog overlay and the
 * agent `models.json`, with no network access. */
export function checkModel(provider:string, id:string, deps:SetupDeps = {}):ModelCheck {
 const dir=agentDir(deps);
 let storePresent=false, customPresent=false, catalogModels=0;
 const storePath=join(dir,'models-store.json');
 if (exists(deps,storePath)) {
  storePresent=true;
  try {
   const j=JSON.parse(readText(deps,storePath));
   catalogModels+=countProviderModels(j,'store',provider);
   const models=j?.[provider]?.models;
   if (Array.isArray(models) && models.some((m:any)=>m && m.id===id)) return {provider,id,available:true,source:'models-store.json',storeStatus:'populated'};
  } catch { /* fall through to the custom models file */ }
 }
 const customPath=join(dir,'models.json');
 if (exists(deps,customPath)) {
  customPresent=true;
  try {
   const j=JSON.parse(readText(deps,customPath));
   catalogModels+=countProviderModels(j,'custom',provider);
   const models=j?.providers?.[provider]?.models;
   if (Array.isArray(models) && models.some((m:any)=>m && m.id===id)) return {provider,id,available:true,source:'models.json',storeStatus:'populated'};
  } catch { /* report missing below */ }
 }
 const storeStatus:ModelStoreStatus = catalogModels > 0 ? 'populated' : (storePresent || customPresent) ? 'empty' : 'missing';
 // The online catalog cache is OpenRouter-only and read-only here, so doctor
 // stays offline while recognising a pin that Pi's local catalog still lacks.
 if (provider === 'openrouter') {
  const cached=readCachedCatalog(deps.env ?? process.env);
  if (cached?.ids.includes(id)) return { provider, id, available:true, source:'online-cache', storeStatus };
 }
 const note=storeStatus === 'populated'
  ? `Model ${provider}/${id} is not in the local catalog; start \`pi\` and choose a model with \`/model\`.`
  : `The ${provider} model catalog is missing or empty; it fills after a credential is present. Start \`pi\` and run \`/login\` first, then refresh with \`pi update --models\`.`;
 return { provider, id, available:false, source:null, storeStatus, note };
}

/** Attach the offline pin, policy, roster and update context to a model check.
 * `catalogIds` are the local Pi catalog ids only; nothing here touches the
 * network and nothing writes. */
function describeModel(config:ModelConfig, catalogIds:string[], prices:Record<string,ModelPrice> = {}):Required<Pick<ModelCheck,'pinned'|'policy'|'routing'|'autoUpgrade'|'roster'|'rejected'|'newer'>> {
 const policy=classifyModel(config.provider,config.model);
 return {
  pinned:{ provider:config.provider, id:config.model, source:config.source, path:config.path },
  policy:{ class:policy.class, reason:policy.reason },
  routing:config.routing,
  autoUpgrade:config.autoUpgrade,
  roster:config.roster.map((p)=>({ profile:p.id, provider:p.provider, model:p.model, available:catalogIds.includes(p.model), default:p.id===config.defaultProfile })),
  rejected:config.rejected.map((r)=>({ id:r.id, model:r.model, reason:r.reason })),
  newer:modelUpdates(config,catalogIds,{ prices }).filter((u)=>u.newer.length>0).map((u)=>({ profile:u.profile, current:u.current, newer:u.newer, comparable:u.comparable, inputRatio:u.price.inputRatio, outputRatio:u.price.outputRatio })),
 };
}

export type TestedPi = { name:string; version:string; source:'project'|'builtin' };

/** Resolve the tested Pi version pinned in the project config, falling back to
 * the built-in pin. Used only for doctor pairing/diagnosis; it never installs. */
export function loadTestedPi(cwd:string, deps:SetupDeps = {}):TestedPi {
 const path=join(cwd,'delivery.config.json');
 if (exists(deps,path)) {
  try {
   const j=JSON.parse(readText(deps,path));
   const name=typeof j?.pi?.name==='string' && j.pi.name.trim() ? j.pi.name : PI_PACKAGE;
   const version=typeof j?.pi?.testedVersion==='string' && /^\d+\.\d+\.\d+/.test(j.pi.testedVersion) ? j.pi.testedVersion : null;
   if (version) return {name, version, source:'project'};
  } catch { /* a malformed config falls back to the built-in pin */ }
 }
 return {name:PI_PACKAGE, version:TESTED_PI_VERSION, source:'builtin'};
}

export type GatewayKindStatus = {
 kind:GatewayKind;
 keyEnv:string;
 configured:boolean;
 source:'env'|'auth'|null;
};
export type JevGatewayStatus = {
 provider:JevProvider;
 resolved:GatewayKind|null;
 /** Present only when an explicit provider lacks its key or the configured
  * value is invalid. The message never contains a key value (ADR-0006 R5). */
 error?:string;
};
export type LitellmStatus = {
 defined:boolean;
 keySource:'env'|'models.json'|'command'|null;
 keyEnv?:string;
 keyConfigured:boolean|null;
 models:number;
};
export type GatewaysResult = { kinds:GatewayKindStatus[]; jev:JevGatewayStatus; litellm:LitellmStatus };

/** Inspect the `litellm` provider entry in Pi's `models.json` without touching
 * the network or executing any command. Reports only whether it is defined,
 * how its apiKey is sourced, whether that source resolves, and its model
 * count. The apiKey value is never copied into the result; a `!command` key
 * is reported as `command` and is never run. Never throws. */
export function inspectLitellm(deps:SetupDeps = {}):LitellmStatus {
 const path=join(agentDir(deps),'models.json');
 let provider:any=null;
 if (exists(deps,path)) {
  try {
   const j=JSON.parse(readText(deps,path));
   provider=j?.providers?.litellm;
  } catch { /* an unreadable or malformed file is reported as undefined */ }
 }
 if (!provider || typeof provider!=='object') return {defined:false, keySource:null, keyConfigured:false, models:0};
 const models=Array.isArray(provider.models) ? provider.models.filter(Boolean).length : 0;
 const apiKey=typeof provider.apiKey==='string' ? provider.apiKey.trim() : '';
 if (!apiKey) return {defined:true, keySource:null, keyConfigured:false, models};
 if (apiKey.startsWith('!')) return {defined:true, keySource:'command', keyConfigured:null, models};
 const ref=apiKey.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
 if (ref) {
  const env=deps.env ?? process.env;
  const value=env[ref[1]];
  const configured=typeof value==='string' && value.trim().length>0;
  return {defined:true, keySource:'env', keyEnv:ref[1], keyConfigured:configured, models};
 }
 return {defined:true, keySource:'models.json', keyConfigured:true, models};
}

/** Read `jev.provider` from the project config in `cwd`; a missing file, a
 * malformed document or a missing key yields `auto`. Never throws. */
function readJevProvider(cwd:string, deps:SetupDeps):unknown {
 const path=join(cwd,'delivery.config.json');
 try {
  if (!exists(deps,path)) return 'auto';
  const j=JSON.parse(readText(deps,path));
  return j?.jev?.provider ?? 'auto';
 } catch { return 'auto'; }
}

/** Report each gateway kind's configuration and source, plus the resolved Jev
 * provider. Key values are never copied into the report (ADR-0006 R5). Every
 * gateway is advisory: this never changes Pi execution readiness. */
export function inspectGateways(cwd:string, deps:SetupDeps = {}):GatewaysResult {
 const env=deps.env ?? process.env;
 const gatewayDeps={ env, readAuthFile: deps.readFile ? (p:string)=>readText(deps,p) : undefined };
 const kinds=GATEWAY_KINDS.map((kind):GatewayKindStatus => {
  const gateway=GATEWAYS[kind];
  const fromEnv=env[gateway.keyEnv];
  if (typeof fromEnv==='string' && fromEnv.trim()) return { kind, keyEnv:gateway.keyEnv, configured:true, source:'env' };
  const key=resolveGatewayKey(kind, gatewayDeps);
  return { kind, keyEnv:gateway.keyEnv, configured:!!key, source:key ? 'auth' : null };
 });
 const litellm=inspectLitellm(deps);
 const raw=readJevProvider(cwd, deps);
 let provider:JevProvider='auto';
 try {
  provider=validateJevProvider(raw);
  const resolved=resolveJevGateway(provider, gatewayDeps);
  return { kinds, jev:{ provider, resolved:resolved?.kind ?? null }, litellm };
 } catch (err) {
  return { kinds, jev:{ provider, resolved:null, error:err instanceof Error ? err.message : String(err) }, litellm };
 }
}

export type DoctorCheck = { id:string; ok:boolean; detail:string };
export type DoctorVerdict = 'ready' | 'degraded' | 'failed';
export type DoctorResult = {
 command:'doctor';
 ok:boolean;
 /** Machine-readable summary: ready, non-fatally degraded, or failed. */
 verdict:DoctorVerdict;
 /** Process exit code that agrees with `verdict` (failed is the only non-zero). */
 exitCode:0 | 1;
 degraded:boolean;
 /** Non-blocking advisories, such as running on a slow Windows-mounted
  * checkout. They never change Pi execution readiness (`ok`). */
 warnings:string[];
 node:{ version:string; supported:boolean; minimum:string };
 pi:PiCheck;
 credentials:CredentialCheck;
 model:ModelCheck;
 /** Skill readiness is reported separately; it does not change Pi execution readiness (`ok`). */
 skill:SkillReadiness;
 /** npm companion tools (fmeca, cpm, jevitate); reported separately, never gating Pi readiness. */
 companions:CompanionsReport;
 /** Companion agent-skill readiness; reported separately, never gating Pi readiness. */
 companionSkills:CompanionSkillsReport;
 /** Prebuilt integration readiness is reported separately from Pi execution/auth readiness. */
 integrations:IntegrationsResult;
 integrationsReady:boolean;
 /** Read-only retained-worktree count and disk usage; never blocks readiness. */
 retention:RetentionSummary;
 /** Per-harness readiness for Junior and its companions; never changes the `ok` rule. */
 readiness:ReadinessResult;
 /** Named Jev gateways and the resolved provider; advisory and never gating. */
 gateways:GatewaysResult;
 checks:DoctorCheck[];
 remediation:string[];
};

const BLOCKED_PROBE_WARNING='Pi version probe was blocked by the host (EPERM); Pi execution readiness is unverified and doctor is degraded.';

const slowMountWarning=(cwd:string,fstype:string,mountPoint:string):string=>
 `Slow Windows-mounted checkout: ${cwd} is on a ${fstype} filesystem mounted at ${mountPoint}. Use a Linux-native path (for example under your home directory) for a worktree handoff to avoid slow file operations.`;

/** Detect a checkout on a slow Windows-mounted filesystem. Returns a warning
 * string when `cwd` is under `/mnt/<letter>/`, or when the deepest `/proc/mounts`
 * mount point covering it reports a `9p` or `drvfs` filesystem; otherwise null.
 * Mount parsing is injectable so tests never read the host mount table. */
export function detectSlowMount(cwd:string, deps:SetupDeps = {}):string|null {
 const normalized=String(cwd??'').replace(/\\/g,'/');
 const drive=normalized.match(/^\/mnt\/([a-zA-Z])(?:\/|$)/);
 if (drive) return slowMountWarning(cwd,'drvfs',`/mnt/${drive[1]}`);
 let mounts='';
 try { mounts=deps.readMounts ? deps.readMounts() : readText(deps,'/proc/mounts'); }
 catch { return null; }
 let best:string|null=null;
 let bestType='';
 for (const line of mounts.split('\n')) {
  const parts=line.trim().split(/\s+/);
  if (parts.length<3) continue;
  const mountPoint=parts[1].replace(/\\040/g,' ');
  const fstype=parts[2];
  if (fstype!=='9p' && fstype!=='drvfs') continue;
  const prefix=mountPoint.endsWith('/')?mountPoint:mountPoint+'/';
  if (normalized!==mountPoint && !normalized.startsWith(prefix)) continue;
  if (best===null || mountPoint.length>best.length) { best=mountPoint; bestType=fstype; }
 }
 return best===null ? null : slowMountWarning(cwd,bestType,best);
}

/** Read-only readiness check. No installation, config writes or paid calls. */
export function doctor(deps:SetupDeps = {}, opts:{harness?:string} = {}):DoctorResult {
 const env=deps.env ?? process.env;
 const version=deps.nodeVersion ?? process.versions.node;
 const cwd=deps.cwd ?? process.cwd();
 const supported=compareSemver(version,SUPPORTED_NODE_MIN) >= 0;
 const testedPi=loadTestedPi(cwd,deps);
 const pi=checkPi(deps,testedPi.version);
 const defaults=loadDefaults(cwd,deps);
 const provider=defaults.provider;
 const credentials=checkCredentials(provider,deps);
 const config=loadModelConfig(cwd);
 const catalog=readLocalCatalog(agentDir(deps));
 const cached=readCachedCatalog(env);
 const catalogIdList=[...new Set([...catalog.entries.map((e)=>e.id), ...(cached?.ids ?? [])])];
 const localPrices=Object.fromEntries(catalog.entries.filter((e)=>e.price).map((e)=>[e.id, e.price as ModelPrice]));
 const priceTable={ ...localPrices, ...(cached?.prices ?? {}) };
 const model:ModelCheck={ ...checkModel(provider,defaults.model,deps), ...describeModel(config,catalogIdList,priceTable) };
 const policyOk=model.policy ? model.policy.class === 'commodity' : true;

 const remediation:string[]=[];
 if (!supported) remediation.push(`Install Node ${SUPPORTED_NODE_MIN} or newer (for example \`nvm install 24\`) and re-run \`doctor\`.`);
 if (!pi.found) remediation.push(`Install Pi with \`node worker.ts init --install\` (or \`npm install -g --ignore-scripts ${PI_PACKAGE}\`) using the active Node/nvm.`);
 else if (pi.probeBlocked) { /* degraded warning below; the executable is not known to be unusable */ }
 else if (!pi.version) remediation.push('Pi could not run successfully; check its executable and active Node installation.');
 else if (pi.pathMismatch) remediation.push('Install Pi with the active nvm Node so `pi` and `node` resolve from the same bin directory.');
 if (pi.found && pi.isolation.missing.length > 0) remediation.push(`Pi is missing isolation flags (${pi.isolation.missing.join(', ')}); install Pi with \`node worker.ts init --install\` (or \`npm install -g --ignore-scripts ${PI_PACKAGE}\`) using the active Node/nvm to update it.`);
 if (pi.versionWarning && pi.versionNote) remediation.push(pi.versionNote);
 if (!credentials.present) remediation.push('Authenticate with Pi: start `pi` and run `/login`, then select the model with `/model`.');
 if (!model.available) {
  if (model.storeStatus === 'populated') remediation.push(`Model ${provider}/${defaults.model} is not in the local catalog; start \`pi\` and choose a model with \`/model\`.`);
  else remediation.push(`The ${provider} model catalog is missing or empty; run \`pi update --models\` to refresh it after \`/login\`.`);
 }
 if (model.policy && !policyOk) remediation.push(`Junior executes only commodity/open-weight models: ${model.policy.reason}. Pin a commodity model in delivery.config.json (see \`junior model status\`).`);

 const warnings:string[]=[];
 if (pi.probeBlocked) warnings.push(BLOCKED_PROBE_WARNING);
 const storeLockdown=inspectStoreDenyRules(cwd,{ existsSync:deps.exists, readFileSync:deps.readFile ? (path:string)=>readText(deps,path) : undefined });
 if (storeLockdown.storeExists && !storeLockdown.present) {
  warnings.push('The .crossmatrix/ store has no Claude Code deny rules; agents can read it directly.');
  remediation.push('Lock down the .crossmatrix/ store with `junior init` (idempotent; adds the Claude Code deny rules).');
 }
 const slowMount=detectSlowMount(cwd,deps);
 if (slowMount) warnings.push(slowMount);
 for (const update of model.newer ?? []) {
  const parity=update.comparable === false
   ? `; waiting for price parity (${update.inputRatio ?? '?'}x/${update.outputRatio ?? '?'}x)`
   : update.comparable === true ? '; price-comparable; run `junior model upgrade`.' : '; run `junior model upgrade`.';
  warnings.push(`Newer commodity models available: ${update.profile} ${update.current} -> ${update.newer[0]}${parity}`);
 }
 for (const rejected of model.rejected ?? []) warnings.push(`Roster profile '${rejected.id}' rejected: ${rejected.reason}`);

 const checks:DoctorCheck[]=[
  { id:'node', ok:supported, detail:`node ${version} (minimum ${SUPPORTED_NODE_MIN})` },
  { id:'pi', ok:pi.found && (!!pi.version || pi.probeBlocked), detail:pi.found ? `${pi.executable} (${pi.version ?? (pi.probeBlocked ? 'version probe blocked by EPERM' : 'version unknown')}, tested ${pi.testedVersion})` : 'pi not found on PATH' },
  { id:'credentials', ok:credentials.present, detail:credentials.present ? `${provider} credential present (${credentials.sources.join(', ')})` : `no ${provider} credential` },
  { id:'model', ok:model.available, detail:model.available ? `${provider}/${defaults.model} in ${model.source}` : (model.note as string) },
 ];
 const skill=inspectSkill(deps);
 const integrations=inspectIntegrations({ env, cwd: deps.cwd, installRoot: deps.toolsRoot });
 const retention=retainedWorktreeSummary(cwd);
 const companions=inspectCompanions({ env, exists:deps.exists, exec:deps.exec });
 const companionSkills=inspectCompanionSkills({ env, exists:deps.exists, readFile:deps.readFile }, { target:'both', scope:'project', cwd });
 if (companionSkills.remediation.length) remediation.push(...companionSkills.remediation);
 const gateways=inspectGateways(deps.cwd ?? cwd, deps);
 if (gateways.jev.error) remediation.push(gateways.jev.error);
 if (gateways.litellm.defined && gateways.litellm.keyEnv && gateways.litellm.keyConfigured === false) remediation.push(`Set ${gateways.litellm.keyEnv} for the litellm provider in Pi models.json`);
 const readiness=inspectReadiness({
  env,
  home: env.HOME || env.USERPROFILE,
  exists: deps.exists,
  readFile: deps.readFile,
  skillSource: deps.skillSource,
  toolsRoot: deps.toolsRoot,
  exec: deps.exec,
  integrations,
 }, { cwd, harness: opts.harness });
 // A skill installed at user level is absent from the project roots; report it
 // missing only when the harness-aware readiness check cannot find it either.
 const juniorSkillFound=readiness.items.some((i)=>i.id === 'skill:junior' && i.status !== 'missing');
 const skillLines=skillMessageLines(skill).filter((line)=>!(juniorSkillFound && line.startsWith('Junior skill is not installed')));
 warnings.push(...skillLines);
 remediation.push(...skillLines);
 const ok=checks.every((c)=>c.ok) && policyOk;
 const verdict:DoctorVerdict=ok ? (pi.probeBlocked ? 'degraded' : 'ready') : 'failed';
 return { command:'doctor', ok, verdict, exitCode:verdict === 'failed' ? 1 : 0, degraded:verdict === 'degraded', warnings, node:{version,supported,minimum:SUPPORTED_NODE_MIN}, pi, credentials, model, skill, companions, companionSkills, integrations, integrationsReady:integrations.ready, retention, readiness, gateways, checks, remediation };
}

export type InitInstallAttempt = { attempted:boolean; ok:boolean };
/** Truthful combination of the Pi and prebuilt-tools install attempts. The
 * legacy `install` field stays Pi-only; `installSummary` distinguishes both. */
export type InitInstallSummary = {
 pi:InitInstallAttempt;
 tools:InitInstallAttempt | null;
 attempted:boolean;
 ok:boolean;
};

/** Combine the Pi install result and an optional prebuilt-tools report. A
 * component that was not attempted is treated as ok and contributes no attempt. */
export function summarizeInstall(install:InitResult['install'] | undefined, tools:{ ok:boolean } | null = null):InitInstallSummary {
 const pi:InitInstallAttempt = { attempted: !!install?.attempted, ok: install ? install.ok : true };
 const toolsAttempt:InitInstallAttempt | null = tools ? { attempted:true, ok:tools.ok } : null;
 return {
  pi,
  tools:toolsAttempt,
  attempted:pi.attempted || !!toolsAttempt,
  ok:pi.ok && (toolsAttempt ? toolsAttempt.ok : true),
 };
}

