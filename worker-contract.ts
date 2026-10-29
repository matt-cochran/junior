import { readFileSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { validateIsolationSetup } from './isolation.ts';
import { parseCommandPolicy, type CommandPolicy } from './command-policy.ts';
import { validatePricing } from './worker-receipt.ts';
import { validateExecutionSettings } from './runtime.ts';
import { validateBilling } from './billing.ts';
import { validatePiContext } from './pi-isolation.ts';
import { validateJevProvider } from './gateway.ts';
import { readExternalContextConsent, verifyExternalContextConsentToken, externalContextCredentialSource } from './auth.ts';

const msg=(e:unknown)=>e instanceof Error ? e.message : String(e);


/** Every top-level contract field the worker understands. A nested `execution`
 * object is also supported (its keys are validated by
 * resolveExecutionSettings), and its runtime settings may also be given
 * directly at the top level. Unknown fields are rejected so a typo or an
 * unsupported feature fails before any paid call instead of being ignored. */
export const TASK_FIELDS = [
 'id','deliverable','cwd','acceptance','assumptions','checks','constraints','context',
 'provider','model','thinking','pricing','jev',
 'workflow','isolation','billing',
 'resumeFrom','repairFrom','reviewFrom','maxRepairs','lineageDeadlineMs','preparedFrom','checkBack',
 'approveModel','approvedProfiles','modelProfile',
 'plan',
 'hopFrom','hopRevision','hopContext','piContext','clarifiedFrom','scope',
 'externalContextConsent','externalProviderConsent','approveExternalContext','externalContextAuthorization','externalContextApproved','externalConsent','consentExternalContext',
 'readScope','budget','scopeExpansion',
 'execution','deadlineMs','quietMs','toolTimeoutMs','heartbeatMs','checkTimeoutMs','checkReserveMs','maxOutputBytes','continuations','isolationSetup',
 'commandPolicy',
] as const;

/** Every field a single check object may carry. `cwd` is optional and defaults
 * to the execution checkout. */
export const CHECK_FIELDS = ['command','args','cwd'] as const;

/** Resolve the contract's command placement policy for a consumer. A contract
 * without `commandPolicy` returns null, which keeps the prior behavior. */
export function resolveCommandPolicy(t:any, cwd:string):CommandPolicy|null {
 return parseCommandPolicy(t?.commandPolicy, cwd);
}

/** Every field a `plan` object may carry. The plan links a contract to the cpm
 * plan deliverable it executes; `callerId` is the optional cpm caller identity. */
export const PLAN_FIELDS = ['id','deliverable','callerId'] as const;

/** True when `child` is the same path as or lexically inside `parent`. */
export function withinWorkspace(parent:string, child:string):boolean {
 const rel=relative(resolve(parent),resolve(child));
 return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Real-path aware containment. A lexical check alone cannot see a symlink
 * whose target lives outside the workspace, so paths that exist are resolved
 * with `realpath` before the containment check. A path that does not exist yet
 * is governed by the lexical check, since the command cannot run there
 * regardless. */
export function withinRealWorkspace(parent:string, child:string):boolean {
 if (!withinWorkspace(parent, child)) return false;
 let realParent:string;
 try { realParent=realpathSync(parent); } catch { return true; }
 let realChild:string;
 try { realChild=realpathSync(child); } catch { return true; }
 return withinWorkspace(realParent, realChild);
}

/** Resolve a check's `cwd` against the execution checkout.
 *
 * - omitted: the execution checkout itself (existing behavior);
 * - relative: resolved under the execution checkout and rejected if it escapes;
 * - absolute inside the execution checkout: used as-is;
 * - absolute inside the source checkout: remapped to the equivalent path in the
 *   isolated execution checkout, so a monorepo check authored against the
 *   source path runs against the isolated copy;
 * - anything else: rejected. */
export function resolveCheckCwd(cwd:unknown, sourceCwd:string, executionCwd:string):{cwd?:string;error?:string} {
 if (cwd === undefined) return {cwd:executionCwd};
 if (typeof cwd !== 'string' || !cwd.trim()) return {error:'Invalid check.cwd (expected a non-empty string)'};
 const raw=cwd.trim();
 if (!isAbsolute(raw)) {
  const abs=resolve(executionCwd, raw);
  if (!withinRealWorkspace(executionCwd, abs)) return {error:`Invalid check.cwd (outside the workspace): ${raw}`};
  return {cwd:abs};
 }
 const abs=resolve(raw);
 if (withinWorkspace(executionCwd, abs)) {
  if (!withinRealWorkspace(executionCwd, abs)) return {error:`Invalid check.cwd (outside the workspace): ${raw}`};
  return {cwd:abs};
 }
 if (withinWorkspace(sourceCwd, abs)) {
  const rel=relative(resolve(sourceCwd), abs);
  const mapped= rel ? join(executionCwd, rel) : executionCwd;
  if (!withinRealWorkspace(executionCwd, mapped)) return {error:`Invalid check.cwd (outside the workspace): ${raw}`};
  return {cwd:mapped};
 }
 return {error:`Invalid check.cwd (outside the workspace): ${raw}`};
}

export const CONTEXT_MAX_ENTRIES = 20;
export const CONTEXT_MAX_LINES = 200;
export const CONTEXT_MAX_CHARS = 40000;

/** A contract `context` entry: a path relative to the contract cwd, with an
 * optional 1-based inclusive line window. */
export type ContextEntry = { path:string; start?:number; end?:number };
/** A context entry resolved against the contract cwd. `text` holds the bounded
 * excerpt; `error` is set instead when the file cannot be read; `truncated`
 * marks an excerpt cut to the per-entry or total bound. */
export type ResolvedContextEntry = { path:string; start?:number; end?:number; text?:string; error?:string; truncated?:boolean };

/** Known public destinations for the providers Junior can hand off to. An
 * unknown custom provider keeps its configured provider name as the
 * destination rather than inventing a URL. */
export function externalContextDestination(provider:string):string {
 const destinations:Record<string,string>={
  openrouter:'https://openrouter.ai/api/v1',
  typesafe:'https://typesafe.ai/api/v1',
  openai:'https://api.openai.com/v1',
  anthropic:'https://api.anthropic.com/v1',
  google:'https://generativelanguage.googleapis.com/v1beta',
  zai:'https://api.z.ai/api/paas/v4',
  moonshotai:'https://api.moonshot.ai/v1',
  qwen:'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'z-ai':'https://api.z.ai/api/paas/v4',
  litellm:'configured litellm base URL',
 };
 return destinations[provider] ?? `provider:${provider}`;
}

/** Local providers never leave the harness, so they need no external consent. */
export function externalContextRequired(provider:string):boolean {
 return !['local','ollama','lmstudio','llamacpp','llama.cpp'].includes(provider);
}

const EXTERNAL_CONSENT_FIELDS=['granted','consent','token','provider','project','destination','model','scope'] as const;

/** Shape-check an optional contract consent flag/token before any paid call. */
export function validateExternalContextConsent(value:unknown):void {
 if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'string') return;
 if (typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid externalContextConsent (expected a flag, token or object)');
 for (const key of Object.keys(value)) if (!(EXTERNAL_CONSENT_FIELDS as readonly string[]).includes(key)) throw Error(`Unknown externalContextConsent field: ${key}`);
 const v:any=value;
 for (const key of ['granted','consent'] as const) if (v[key] !== undefined && typeof v[key] !== 'boolean') throw Error(`Invalid externalContextConsent.${key} (expected a boolean)`);
 for (const key of ['token','provider','project','destination','model'] as const) if (v[key] !== undefined && typeof v[key] !== 'string') throw Error(`Invalid externalContextConsent.${key} (expected a string)`);
 if (v.scope !== undefined && (!Array.isArray(v.scope) || v.scope.some((p:any)=>typeof p !== 'string'))) throw Error('Invalid externalContextConsent.scope (expected an array of strings)');
}

/** The file/context scope a handoff may disclose. The list is descriptive: it
 * names every contract-selected path without reading or transmitting it here. */
export function externalContextFiles(t:any):string[] {
 const files:string[]=[];
 const add=(value:any):void=>{
  if (typeof value !== 'string' || !value.trim()) return;
  let path=value.trim().replaceAll('\\','/');
  while (path.startsWith('./')) path=path.slice(2);
  if (path && !files.includes(path)) files.push(path);
 };
 for (const entry of Array.isArray(t?.context) ? t.context : []) add(entry?.path);
 for (const path of Array.isArray(t?.readScope?.paths) ? t.readScope.paths : []) add(path);
 for (const entry of Array.isArray(t?.scope?.owned) ? t.scope.owned : []) add(typeof entry === 'string' ? entry : entry?.path);
 for (const path of scopeExpansionPaths(t)) add(path);
 return files.sort();
}

export type ExternalContextAuthorization = {
 required:true;
 granted:boolean;
 source:'run'|'project'|null;
 token:string|null;
 reason:string;
};

/** Resolve explicit run consent or a recorded project/provider decision. A run
 * token must be bound to the same provider and project; a bare `true` is the
 * deliberate flag form. */
function projectConfigConsent(cwd:string, provider:string):{granted:boolean; source:'project'|null; token:string|null; reason:string} {
 let config:any=null;
 try { config=JSON.parse(readFileSync(join(cwd,'delivery.config.json'),'utf8')); } catch { return {granted:false,source:null,token:null,reason:'no project consent config'}; }
 if (!config || typeof config !== 'object' || Array.isArray(config)) return {granted:false,source:null,token:null,reason:'project consent config is malformed'};
 const candidates:any[]=[config.externalContextConsent,config.externalContext,config.privacy?.externalContextConsent,config.privacy?.externalContext];
 for (const value of candidates) {
  if (value === true) return {granted:true,source:'project',token:null,reason:'project consent config grants external context egress'};
  const providers=Array.isArray(value) ? value : (value && typeof value === 'object' ? (value.approved ?? value.approvedProviders ?? value.providers ?? null) : null);
  if (Array.isArray(providers) && providers.includes(provider)) return {granted:true,source:'project',token:typeof value?.token==='string'?value.token:null,reason:'project consent config names this provider'};
  if (value && typeof value === 'object' && value.provider === provider && (value.granted === true || value.consent === true)) return {granted:true,source:'project',token:typeof value.token==='string'?value.token:null,reason:'project consent config grants this provider'};
 }
 return {granted:false,source:null,token:null,reason:'project consent config does not authorize this provider'};
}

export function resolveExternalContextAuthorization(t:any, cwd:string, provider:string):ExternalContextAuthorization {
 const candidates:any[]=[t?.externalContextConsent,t?.externalProviderConsent,t?.approveExternalContext,t?.externalContextAuthorization,t?.externalContextApproved,t?.externalConsent,t?.consentExternalContext];
 for (const value of candidates) {
  if (value === true) return { required:true, granted:true, source:'run', token:null, reason:'explicit run consent flag' };
  if (typeof value === 'string' && value.trim()) {
   const token=value.trim();
   if (verifyExternalContextConsentToken(cwd,provider,token)) return { required:true, granted:true, source:'run', token, reason:'explicit run consent token matched the provider and project' };
   if (token === provider) return { required:true, granted:true, source:'run', token, reason:'explicit run consent names the provider' };
   return { required:true, granted:false, source:null, token:null, reason:'the run consent token is not bound to this provider and project' };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
   const v:any=value;
   if (v.provider && v.provider !== provider) continue;
   if (typeof v.token === 'string' && v.token.trim()) return resolveExternalContextAuthorization({externalContextConsent:v.token},cwd,provider);
   if (v.granted === true || v.consent === true) return { required:true, granted:true, source:'run', token:null, reason:'explicit run consent object' };
   return { required:true, granted:false, source:null, token:null, reason:'the run consent object does not grant consent' };
  }
 }
 const project=readExternalContextConsent(cwd, provider);
 if (project.granted) return { required:true, granted:true, source:'project', token:project.token, reason:'recorded project consent for this provider' };
 const configured=projectConfigConsent(cwd, provider);
 if (configured.granted) return { required:true, granted:true, source:'project', token:configured.token, reason:configured.reason };
 return { required:true, granted:false, source:null, token:null, reason:'no run consent and no recorded project/provider consent' };
}

/** Build the machine-readable preflight shown before source text can egress. */
export function buildExternalContextPreflight(t:any, cwd:string, requested:{provider:string;model:string}, deps:{env?:NodeJS.ProcessEnv}={}):any {
 const files=externalContextFiles(t);
 const credential=externalContextCredentialSource(requested.provider, deps.env ? {env:deps.env} : {});
 const authorization=resolveExternalContextAuthorization(t,cwd,requested.provider);
 const possible=externalContextRequired(requested.provider);
 return {
  schemaVersion:1,
  provider:requested.provider,
  destination:externalContextDestination(requested.provider),
  model:requested.model,
  credential:{ category:credential.category, source:credential.name },
  scope:{ files, context:files.filter((f)=>Array.isArray(t?.context) && t.context.some((e:any)=>e?.path===f)), readScope:Array.isArray(t?.readScope?.paths)?[...t.readScope.paths]:[], owned:Array.isArray(t?.scope?.owned)?t.scope.owned.map((e:any)=>typeof e==='string'?e:e?.path).filter(Boolean):[], entries:Array.isArray(t?.context)?t.context.length:0 },
  egress:{ possible, sourceTextMayTransmit:possible, reason:possible ? `source/context selected by the contract may be sent to ${requested.provider} at ${externalContextDestination(requested.provider)}` : 'the configured provider is local; no external egress is expected' },
  authorization,
 };
}

/** Validate the contract `context` array shape before any paid call. Paths must
 * be relative, stay inside the contract cwd, and use 1-based inclusive line
 * bounds. */
export function validateContext(context:unknown, cwd:string):void {
 if (!Array.isArray(context)) throw Error('Invalid context (expected an array)');
 if (context.length > CONTEXT_MAX_ENTRIES) throw Error(`Invalid context (at most ${CONTEXT_MAX_ENTRIES} context entries)`);
 for (const e of context) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw Error('Invalid context entry (expected an object)');
  for (const k of Object.keys(e)) if (!['path','start','end'].includes(k)) throw Error(`Unknown context field: ${k}`);
  if (typeof e.path !== 'string' || !e.path.trim()) throw Error('Invalid context.path (expected a non-empty string)');
  if (isAbsolute(e.path)) throw Error('Invalid context.path (expected a relative path)');
  const abs=resolve(resolve(cwd), e.path);
  if (!withinWorkspace(resolve(cwd), abs)) throw Error(`Invalid context.path (outside the workspace): ${e.path}`);
  if (e.start !== undefined && (typeof e.start !== 'number' || !Number.isInteger(e.start) || e.start < 1)) throw Error('Invalid context.start (expected a positive integer)');
  if (e.end !== undefined && (typeof e.end !== 'number' || !Number.isInteger(e.end) || e.end < 1)) throw Error('Invalid context.end (expected a positive integer)');
  if (e.start !== undefined && e.end !== undefined && e.start > e.end) throw Error('Invalid context range (context start must not exceed end)');
 }
}

/** Read-scope modes. `context-only` reads only the contract's explicit scope;
 * `context-plus-dependencies` also allows declared dependency paths. */
export const READ_SCOPE_MODES = ['context-only','context-plus-dependencies'] as const;
export type ReadScopeMode = typeof READ_SCOPE_MODES[number];
export const READ_SCOPE_FIELDS = ['mode','paths','maxFiles','maxBytes','allowGraft'] as const;

/** Token, tool-call and retained-output budgets. `warn` records an overrun;
 * `enforce` stops it before it becomes a completed handback. */
export const BUDGET_MODES = ['warn','enforce'] as const;
export const BUDGET_FIELDS = [
 'maxInputTokens','maxFreshInputTokens','maxCacheReadTokens','maxCachedInputTokens',
 'maxOutputTokens','maxTotalTokens','maxToolCalls','maxToolOutputBytes','maxResponseCalls','mode',
] as const;

export const SCOPE_EXPANSION_FIELDS = ['paths','reason'] as const;

/** One relative, workspace-contained path or glob used by a read scope or an
 * explicit scope expansion. Absolute paths and dot-dot escapes are rejected. */
function validateScopedPath(value:unknown, cwd:string, label:string):void {
 if (typeof value !== 'string' || !value.trim()) throw Error(`${label} (expected a non-empty string)`);
 const raw=value.trim();
 if (isAbsolute(raw)) throw Error(`${label} (expected a relative path)`);
 const abs=resolve(resolve(cwd), raw);
 if (!withinWorkspace(resolve(cwd), abs)) throw Error(`${label} (outside the workspace)`);
}

/** Validate the optional contract `readScope`. The mode is required when the
 * block is present; paths are relative and contained by the contract cwd. */
export function validateReadScope(readScope:unknown, cwd:string):void {
 if (!readScope || typeof readScope !== 'object' || Array.isArray(readScope)) throw Error('Invalid readScope (expected an object)');
 const scope:any=readScope;
 for (const k of Object.keys(scope)) if (!(READ_SCOPE_FIELDS as readonly string[]).includes(k)) throw Error(`Unknown readScope field: ${k}`);
 if (typeof scope.mode !== 'string' || !(READ_SCOPE_MODES as readonly string[]).includes(scope.mode)) {
  throw Error(`Invalid readScope.mode (expected ${READ_SCOPE_MODES.join(' or ')})`);
 }
 if (scope.paths !== undefined) {
  if (!Array.isArray(scope.paths)) throw Error('Invalid readScope.paths (expected an array of relative paths)');
  for (const path of scope.paths) validateScopedPath(path, cwd, 'Invalid readScope.paths');
 }
 for (const key of ['maxFiles','maxBytes'] as const) {
  const value=scope[key];
  if (value === undefined) continue;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
   throw Error(`Invalid readScope.${key} (expected a positive integer)`);
  }
 }
 if (scope.allowGraft !== undefined && typeof scope.allowGraft !== 'boolean') throw Error('Invalid readScope.allowGraft (expected a boolean)');
}

/** Validate the optional contract `budget` block before any paid call. Token
 * and byte budgets are positive integers; call budgets may be zero. */
export function validateBudget(budget:unknown):void {
 if (!budget || typeof budget !== 'object' || Array.isArray(budget)) throw Error('Invalid budget (expected an object)');
 const b:any=budget;
 for (const k of Object.keys(b)) if (!(BUDGET_FIELDS as readonly string[]).includes(k)) throw Error(`Unknown budget field: ${k}`);
 if (b.mode !== undefined && (typeof b.mode !== 'string' || !(BUDGET_MODES as readonly string[]).includes(b.mode))) {
  throw Error(`Invalid budget.mode (expected ${BUDGET_MODES.join(' or ')})`);
 }
 for (const key of Object.keys(b)) {
  if (key === 'mode') continue;
  const value=b[key];
  const allowZero=key === 'maxToolCalls' || key === 'maxResponseCalls';
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
   throw Error(`Invalid budget.${key} (expected a ${allowZero ? 'nonnegative' : 'positive'} integer)`);
  }
 }
}

/** Validate an optional explicit scope-expansion request. It carries one or
 * more relative paths and a non-empty reason; there is no implicit broadening. */
export function validateScopeExpansion(expansion:unknown, cwd:string):void {
 if (!expansion || typeof expansion !== 'object' || Array.isArray(expansion)) throw Error('Invalid scopeExpansion (expected an object)');
 const e:any=expansion;
 for (const k of Object.keys(e)) if (!(SCOPE_EXPANSION_FIELDS as readonly string[]).includes(k)) throw Error(`Unknown scopeExpansion field: ${k}`);
 if (!Array.isArray(e.paths) || !e.paths.length) throw Error('Invalid scopeExpansion.paths (expected a non-empty array of relative paths)');
 for (const path of e.paths) validateScopedPath(path, cwd, 'Invalid scopeExpansion.paths');
 if (typeof e.reason !== 'string' || !e.reason.trim()) throw Error('Invalid scopeExpansion.reason (expected a non-empty string)');
}

/** Canonical expansion paths: trimmed, slash-normalized, deduplicated and
 * sorted, so the same request always grants the same paths in the same order. */
export function scopeExpansionPaths(t:any):string[] {
 const expansion=t?.scopeExpansion;
 if (!expansion || typeof expansion !== 'object' || Array.isArray(expansion) || !Array.isArray(expansion.paths)) return [];
 return [...new Set(expansion.paths.filter((p:any)=>typeof p === 'string' && p.trim()).map((p:string)=>p.trim().replaceAll('\\','/').replace(/^\.\//,'').replace(/\/+$/,'')).filter(Boolean))].sort();
}

/** Deterministic scope-expansion request, or null when the contract has none. */
export function scopeExpansionRequest(t:any):{paths:string[];reason:string}|null {
 const paths=scopeExpansionPaths(t);
 const reason=t?.scopeExpansion?.reason;
 if (!paths.length || typeof reason !== 'string' || !reason.trim()) return null;
 return {paths,reason:reason.trim()};
}

function normalizeScopedPath(path:string):string {
 return path.trim().replaceAll('\\','/').replace(/^\.\//,'').replace(/\/+$/,'');
}

/** Match one declared read path (exact path, directory prefix or simple glob). */
export function readScopePathMatches(pattern:string, candidate:string):boolean {
 const p=normalizeScopedPath(pattern);
 const c=normalizeScopedPath(candidate);
 if (!p || !c) return false;
 if (p === c) return true;
 if (!/[*?]/.test(p)) return c.startsWith(`${p}/`);
 let re='^';
 for (let i=0;i<p.length;i++) {
  const ch=p[i];
  if (ch === '*') {
   if (p[i+1] === '*') { re+='.*'; i++; }
   else re+='[^/]*';
  } else if (ch === '?') re+='[^/]';
  else if (/[\\^$.*+?()[\]{}|]/.test(ch)) re+='\\'+ch;
  else re+=ch;
 }
 re+='$';
 try { return new RegExp(re).test(c); } catch { return false; }
}

/** Resolved allowed read paths, or null when the contract sets no read scope. */
export function readScopeAllowedPaths(t:any):string[]|null {
 const scope=t?.readScope;
 if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return null;
 const declared=Array.isArray(scope.paths) ? scope.paths : [];
 const context=(Array.isArray(t?.context) ? t.context : []).map((e:any)=>e?.path).filter((p:any)=>typeof p === 'string' && p.trim());
 const base=scope.mode === 'context-only'
  ? (declared.length ? declared : context)
  : [...declared, ...context];
 return [...new Set([...base, ...scopeExpansionPaths(t)].map(normalizeScopedPath).filter(Boolean))].sort();
}

/** True when a read is inside the contract's configured scope. A contract
 * without `readScope` keeps the previous unrestricted behavior. */
export function isReadAllowed(t:any, path:string):boolean {
 const allowed=readScopeAllowedPaths(t);
 if (!allowed) return true;
 return allowed.some((pattern)=>readScopePathMatches(pattern,path));
}

/** Throw before reading a file outside the configured scope, so no content can
 * leak into the prompt or a paid call. */
export function assertReadAllowed(t:any, path:string):void {
 if (!isReadAllowed(t,path)) throw Error(`read outside contract scope: ${path}`);
}

/** Read one file only after the scope check, returning an error entry instead
 * of content when it is outside the contract's read scope. */
export function readScopedFile(t:any, path:string):{path:string;text?:string;error?:string} {
 const abs=resolve(resolve(String(t?.cwd ?? '.')), path);
 if (!withinWorkspace(resolve(String(t?.cwd ?? '.')), abs)) return {path,error:'outside the workspace'};
 if (!isReadAllowed(t,path)) return {path,error:'read outside contract scope'};
 try { return {path,text:readFileSync(abs,'utf8')}; }
 catch(err) { return {path,error:msg(err)}; }
}

/** One deterministic prompt block naming the read scope, budgets and any
 * explicitly approved expansion. */
export function boundedContextBlock(t:any):string|null {
 const lines:string[]=[];
 const scope=t?.readScope;
 if (scope && typeof scope === 'object' && !Array.isArray(scope)) {
  const paths=Array.isArray(scope.paths) ? scope.paths.map((p:any)=>String(p)) : [];
  lines.push(`Read scope: ${scope.mode}${paths.length ? `; allowed paths: ${paths.join(', ')}` : ''}.`);
  if (scope.maxFiles !== undefined) lines.push(`Read scope max files: ${scope.maxFiles}.`);
  if (scope.maxBytes !== undefined) lines.push(`Read scope max bytes: ${scope.maxBytes}.`);
  if (scope.allowGraft === true) lines.push('A repository index such as graft may be used for bounded discovery; do not dump raw file trees.');
  lines.push(scope.mode === 'context-only'
   ? 'Read only paths inside this explicit scope; an out-of-scope read stops the run and must not be replaced by a broad search.'
   : 'Read declared paths and their graph-derived dependencies only; do not broaden into unrelated files.');
 }
 const budget=t?.budget;
 if (budget && typeof budget === 'object' && !Array.isArray(budget)) {
  const parts:any=Object.entries(budget).filter(([k])=>k !== 'mode').map(([k,v])=>`${k}=${v}`);
  if (parts.length) lines.push(`Budgets${budget.mode ? ` (${budget.mode})` : ''}: ${parts.join(', ')}.`);
 }
 const expansion=scopeExpansionRequest(t);
 if (expansion) lines.push(`Scope expansion approved: ${expansion.paths.join(', ')} (${expansion.reason})`);
 return lines.length ? lines.join('\n') : null;
}

/** Validate the optional `plan` link to a cpm plan deliverable. `id` and
 * `deliverable` identify the deliverable; `callerId` is an optional identity.
 * Unknown keys are rejected so a typo fails before the worker starts. */
export function validatePlan(plan:any):void {
 if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw Error('Invalid plan (expected an object)');
 if (typeof plan.id !== 'string' || !plan.id.trim()) throw Error('Invalid plan.id (expected a non-empty string)');
 if (typeof plan.deliverable !== 'string' || !plan.deliverable.trim()) throw Error('Invalid plan.deliverable (expected a non-empty string)');
 if (plan.callerId !== undefined && (typeof plan.callerId !== 'string' || !plan.callerId.trim())) throw Error('Invalid plan.callerId (expected a non-empty string)');
 for (const k of Object.keys(plan)) if (!(PLAN_FIELDS as readonly string[]).includes(k)) throw Error(`Unknown plan field: ${k}`);
}

/** Resolve the contract `context` entries from the contract cwd into bounded
 * excerpts. Never throws: an unreadable file yields an `error` entry, an
 * out-of-range end is clamped to the file length, at most 200 lines per entry
 * and 40000 characters in total are kept, and truncated entries are marked. */
export function resolveContext(t:any):ResolvedContextEntry[] {
 if (!Array.isArray(t?.context) || !t.context.length) return [];
 const cwd=resolve(String(t.cwd ?? '.'));
 const entries=t.context.slice(0, CONTEXT_MAX_ENTRIES);
 let totalChars=0;
 return entries.map((e:any):ResolvedContextEntry=>{
  const rel=typeof e?.path==='string' ? e.path : '';
  const abs=resolve(cwd, rel);
  if (!rel || !withinWorkspace(cwd, abs)) return {path:rel,error:'outside the workspace'};
  if (!isReadAllowed(t, rel)) return {path:rel,error:'read outside contract scope'};
  let raw:string;
  try { raw=readFileSync(abs,'utf8'); }
  catch(err) { return {path:rel,error:msg(err)}; }
  const allLines=raw.split('\n');
  if (allLines.length>1 && allLines[allLines.length-1]==='') allLines.pop();
  const fileLength=allLines.length;
  const start=Number.isInteger(e.start) && e.start>=1 ? e.start : 1;
  let end=Number.isInteger(e.end) && e.end>=1 ? e.end : fileLength;
  end=Math.min(end, fileLength);
  let truncated=false;
  const lineCap=start+CONTEXT_MAX_LINES-1;
  if (end>lineCap) { end=lineCap; truncated=true; }
  let text=end>=start ? allLines.slice(start-1,end).join('\n') : '';
  if (totalChars+text.length>CONTEXT_MAX_CHARS) {
   text=text.slice(0, Math.max(0, CONTEXT_MAX_CHARS-totalChars));
   truncated=true;
  }
  totalChars+=text.length;
  const out:ResolvedContextEntry={path:rel,start,end,text};
  if (truncated) out.truncated=true;
  return out;
 });
}

/** Render resolved context entries as the worker prompt's `Code context`
 * block, or null when there is no readable excerpt. */
export function codeContextBlock(entries:ResolvedContextEntry[]):string|null {
 const usable=(entries||[]).filter(e=>e && typeof e.text==='string');
 if (!usable.length) return null;
 const lines=['Code context (excerpts resolved from the contract cwd; not the full files):'];
 for (const e of usable) {
  const range=e.start!==undefined && e.end!==undefined ? ` lines ${e.start}-${e.end}` : '';
  lines.push(`--- ${e.path}${range}${e.truncated?' (truncated)':''} ---`);
  lines.push(e.text as string);
 }
 return lines.join('\n');
}

/** The human-readable text of an acceptance entry: a plain string, or the
 * `text` field of an object. */
export function acceptanceText(item:any):string {
 if (typeof item === 'string') return item;
 if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.text === 'string') return item.text;
 return '';
}

/** The optional condition under which an acceptance entry applies. */
export function acceptanceWhen(item:any):string|undefined {
 if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.when === 'string' && item.when.trim()) return item.when;
 return undefined;
}

/** Acceptance texts for gate state and prompts; the text is used wherever a
 * criterion is rendered, never the raw `{text, when}` object. */
export function acceptanceTexts(acceptance:any):string[] {
 return (Array.isArray(acceptance) ? acceptance : []).map(acceptanceText);
}

export function validate(t: any) {
 for (const k of ['id','deliverable','cwd']) if (typeof t[k] !== 'string' || !t[k].trim()) throw Error(`Missing ${k}`);
 if (!/^[a-zA-Z0-9_-]+$/.test(t.id)) throw Error('Invalid id');
 if (t.thinking !== undefined && !['off','minimal','low','medium','high','xhigh','max'].includes(t.thinking)) throw Error('Invalid thinking level');
 if (!Array.isArray(t.acceptance) || !t.acceptance.length) throw Error('Missing acceptance');
 const acceptanceIds = new Set<string>();
 for (const a of t.acceptance) {
  if (typeof a === 'string') { if (!a.trim()) throw Error('Missing acceptance'); continue; }
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw Error('Invalid acceptance (expected a string or { text, when })');
  if (typeof a.text !== 'string' || !a.text.trim()) throw Error('Missing acceptance');
  if (a.id !== undefined) {
   if (typeof a.id !== 'string' || !/^[A-Za-z0-9:._\/-]{1,128}$/.test(a.id)) throw Error('Invalid acceptance.id');
   if (acceptanceIds.has(a.id)) throw Error(`Duplicate acceptance.id: ${a.id}`);
   acceptanceIds.add(a.id);
  }
  if (a.mitigates !== undefined) {
   if (!Array.isArray(a.mitigates) || a.mitigates.some((m:any)=>typeof m !== 'string' || !m.trim())) throw Error('Invalid acceptance.mitigates');
  }
  if (a.when !== undefined && (typeof a.when !== 'string' || !a.when.trim())) throw Error('Invalid acceptance.when (expected a non-empty string)');
 }
 if (t.assumptions !== undefined) {
  if (!Array.isArray(t.assumptions)) throw Error('Invalid assumptions (expected an array)');
  for (const a of t.assumptions) {
   if (typeof a === 'string') { if (!a.trim()) throw Error('Invalid assumptions (expected non-empty strings or { text })'); continue; }
   if (!a || typeof a !== 'object' || Array.isArray(a) || typeof a.text !== 'string' || !a.text.trim()) throw Error('Invalid assumptions (expected non-empty strings or { text })');
  }
 }
 if (!Array.isArray(t.checks) || !t.checks.length) throw Error('Missing checks');
 for (const c of t.checks) {
  if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.command !== 'string' || !Array.isArray(c.args) || c.args.some((x:any)=>typeof x !== 'string')) throw Error('Invalid check');
  for (const k of Object.keys(c)) if (!(CHECK_FIELDS as readonly string[]).includes(k)) throw Error(`Unknown check field: ${k}`);
  if (c.cwd !== undefined) {
   if (typeof c.cwd !== 'string' || !c.cwd.trim()) throw Error('Invalid check.cwd (expected a non-empty string)');
   const abs=isAbsolute(c.cwd) ? resolve(c.cwd) : resolve(resolve(t.cwd), c.cwd);
   if (!withinWorkspace(resolve(t.cwd), abs)) throw Error(`Invalid check.cwd (outside the workspace): ${c.cwd}`);
  }
 }
 // acceptance.checks names indexes into the checks array, so it is validated
 // only once t.checks is known valid.
 for (const a of t.acceptance) {
  if (a && typeof a === 'object' && !Array.isArray(a) && a.checks !== undefined) {
   if (!Array.isArray(a.checks) || a.checks.some((x:any)=>!Number.isInteger(x) || x < 0 || x >= t.checks.length)) throw Error('Invalid acceptance.checks');
  }
 }
 if (t.pricing !== undefined && t.pricing !== null) validatePricing(t.pricing);
 if (t.billing !== undefined && t.billing !== null) validateBilling(t.billing);
 if (t.checkBack !== undefined && !['auto','always','off'].includes(t.checkBack)) throw Error('Invalid checkBack (expected auto, always or off)');
 if (t.workflow !== undefined && !['recon','test_first','checks_first','fmeca','evaluate','discover','investigate','prepare','qa','auto'].includes(t.workflow)) throw Error('Invalid workflow (expected recon, test_first, checks_first, fmeca, evaluate, discover, investigate, prepare, qa or auto)');
 if (t.isolation !== undefined && t.isolation !== 'none' && t.isolation !== 'worktree') throw Error('Invalid isolation (expected none or worktree)');
 if (t.isolationSetup !== undefined) validateIsolationSetup(t.isolationSetup);
 if (t.commandPolicy !== undefined) parseCommandPolicy(t.commandPolicy, t.cwd);
 if (t.resumeFrom !== undefined && (typeof t.resumeFrom !== 'string' || !t.resumeFrom.trim())) throw Error('Invalid resumeFrom (expected path to a prior result.json)');
 if (t.repairFrom !== undefined && (typeof t.repairFrom !== 'string' || !t.repairFrom.trim())) throw Error('Invalid repairFrom (expected path to a prior result.json)');
 if (t.reviewFrom !== undefined && (typeof t.reviewFrom !== 'string' || !t.reviewFrom.trim())) throw Error('Invalid reviewFrom (expected path to a prior result.json)');
 if (t.maxRepairs !== undefined && (typeof t.maxRepairs !== 'number' || !Number.isInteger(t.maxRepairs) || t.maxRepairs < 0)) throw Error('Invalid maxRepairs (expected a nonnegative integer)');
 if (t.lineageDeadlineMs !== undefined && (typeof t.lineageDeadlineMs !== 'number' || !Number.isFinite(t.lineageDeadlineMs) || t.lineageDeadlineMs <= 0)) throw Error('Invalid lineageDeadlineMs (expected a finite positive number)');
 if (t.preparedFrom !== undefined && (typeof t.preparedFrom !== 'string' || !t.preparedFrom.trim())) throw Error('Invalid preparedFrom (expected the contract id of the prepare brief)');
 if (t.approveModel !== undefined && (typeof t.approveModel !== 'string' || !t.approveModel.trim())) throw Error('Invalid approveModel (expected a profile id or model id)');
 if (t.approvedProfiles !== undefined) {
  if (!Array.isArray(t.approvedProfiles) || t.approvedProfiles.some((k:any)=>typeof k !== 'string' || !k.trim())) throw Error('Invalid approvedProfiles (expected an array of profile ids or model ids)');
 }
 if (t.modelProfile !== undefined && (typeof t.modelProfile !== 'string' || !t.modelProfile.trim())) throw Error('Invalid modelProfile (expected a roster profile id)');
 if (t.plan !== undefined) {
  validatePlan(t.plan);
  if (typeof t.hopFrom !== 'string' || !t.hopFrom.trim()) throw Error('Invalid plan (requires a non-blank hopFrom)');
 }
 if (t.context !== undefined) validateContext(t.context, t.cwd);
 for (const key of ['externalContextConsent','externalProviderConsent','approveExternalContext','externalContextAuthorization','externalContextApproved','externalConsent','consentExternalContext']) validateExternalContextConsent(t[key]);
 if (t.readScope !== undefined) validateReadScope(t.readScope, t.cwd);
 if (t.budget !== undefined) validateBudget(t.budget);
 if (t.scopeExpansion !== undefined) validateScopeExpansion(t.scopeExpansion, t.cwd);
 if (t.piContext !== undefined) {
  const problem = validatePiContext(t.piContext);
  if (problem) throw Error(problem);
 }
 if (t.clarifiedFrom !== undefined && (typeof t.clarifiedFrom !== 'string' || !t.clarifiedFrom.trim())) throw Error('Invalid clarifiedFrom (expected a path to a clarify.json)');
 if (t.scope !== undefined) {
  if (!t.scope || typeof t.scope !== 'object' || Array.isArray(t.scope)) throw Error('Invalid scope.owned (expected a non-empty array of paths)');
  const owned = t.scope.owned;
  const validOwned = Array.isArray(owned) && owned.length > 0 && owned.every((entry:any)=>
   (typeof entry === 'string' && entry.trim()) ||
   (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.path === 'string' && entry.path.trim()));
  if (!validOwned) throw Error('Invalid scope.owned (expected a non-empty array of non-empty strings or { path } objects)');
  if (t.scope.incidental !== undefined) {
   const incidental = t.scope.incidental;
   if (!Array.isArray(incidental) || incidental.some((glob:any)=>typeof glob !== 'string' || !glob.trim())) throw Error('Invalid scope.incidental (expected an array of non-empty strings)');
  }
  for (const key of Object.keys(t.scope)) if (!['owned','incidental'].includes(key)) throw Error(`Unknown scope field: ${key}`);
 }
 validateExecutionSettings(t);
 if (t.jev !== undefined) {
  if (!t.jev || typeof t.jev !== 'object' || Array.isArray(t.jev)) throw Error('Invalid jev config');
  if (t.jev.mode !== undefined && !['off','shadow','enforce'].includes(t.jev.mode)) throw Error('Invalid jev.mode (expected off, shadow or enforce)');
  if (t.jev.provider !== undefined) validateJevProvider(t.jev.provider);
 }
 for (const k of Object.keys(t)) if (!(TASK_FIELDS as readonly string[]).includes(k)) throw Error(`Unknown contract field: ${k}`);
 return t;
}

/** Number of distinct context paths above which a contract is suggested for
 * splitting into chained contracts. */
export const SPLIT_WARNING_CONTEXT_PATHS = 6;
/** Number of acceptance criteria above which a contract is suggested for
 * splitting into chained contracts. */
export const SPLIT_WARNING_ACCEPTANCE = 10;

/** Non-blocking suggestions for a valid contract. Warnings never make a
 * contract invalid; they only point out a contract large enough to benefit
 * from being split into chained contracts. */
export function contractWarnings(t:any):string[] {
 const warnings:string[] = [];
 const context = Array.isArray(t?.context) ? t.context : [];
 const distinctPaths = new Set(context.map((e:any)=>e && typeof e.path === 'string' && e.path.trim() ? e.path : '').filter(Boolean));
 if (distinctPaths.size > SPLIT_WARNING_CONTEXT_PATHS) warnings.push(`Contract names ${distinctPaths.size} distinct context paths; consider splitting it into chained contracts so each stays focused.`);
 const acceptance = Array.isArray(t?.acceptance) ? t.acceptance : [];
 if (acceptance.length > SPLIT_WARNING_ACCEPTANCE) warnings.push(`Contract has ${acceptance.length} acceptance criteria; consider splitting it into chained contracts so each stays focused.`);
 return warnings;
}


export type Usage = {
 input:number; output:number; cacheRead:number; cacheWrite:number;
 cacheWrite1h:number; reasoning:number; totalTokens:number;
 /** True only when at least one authoritative message_end reported usage. */
 available:boolean;
 cost:{
  input:number;output:number;cacheRead:number;cacheWrite:number;total:number;
  /** True only when a message_end reported a numeric cost. `available:false`
   * means cost is unknown, not that it was free. */
  available:boolean;
 };
};

export type ObservedPair = { provider:string; model:string };

export type ReceiptModelSource = 'task'|'project'|'builtin'|'routed';

export type Receipt = {
 /** Where the metadata came from. Pi-reported, never independent upstream attestation. */
 source:'pi_message_end' | 'mock';
 requested:{ provider:string; model:string; source?:ReceiptModelSource };
 sessionId:string | null;
 observed:ObservedPair[];
 observedUnknown:boolean;
 /** Provider response IDs Pi preserved on assistant `message_end` records
  * (for OpenRouter these are `gen-...` generation IDs). They are the handle for
  * obtaining authoritative provider billing. Deduped for display; the full
  * per-generation list (including a null id) is in `generations`. */
 responseIds:string[];
 /** Every assistant `message_end` in stream order with its provider, model and
  * preserved response id (null when Pi reported none). Used to decide whether
  * an opt-in OpenRouter billing lookup can account for the whole run. */
 generations:{ provider:string; model:string; responseId:string|null }[];
 usage:Usage;
 assistantMessages:number;
 messageEnds:number;
 stopReasons:string[];
 /** Stop reason of the last assistant message (null when the stream held none). */
 finalStopReason:string|null;
 /** Count of error/length assistant messages that a later assistant message followed. */
 recoveredErrors:number;
 /** True when the final assistant message stopped at the per-message output limit. */
 outputLimited:boolean;
 /** True only when the final assistant message stopped with a genuine error. */
 errored:boolean;
 aborted:boolean;
 settled:boolean;
 malformed:boolean;
 /** At most MALFORMED_LINE_LIMIT line numbers; `malformedCount` is the total. */
 malformedLines:number[];
 /** Total malformed lines seen, even when `malformedLines` is capped. */
 malformedCount:number;
 /** True when a non-blank final line was cut by the output cap rather than malformed. */
 truncatedTail?:boolean;
 /** True when the captured output hit the accumulation cap; the receipt cannot be complete. */
 outputTruncated?:boolean;
};

