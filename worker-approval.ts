import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertCommodity, ModelPolicyError } from './model-policy.ts';
import type { ModelClass } from './model-policy.ts';
import { readLocalCatalog, type ModelPrice } from './models.ts';
import { priceDelta, readCachedCatalog, piAgentDir } from './model-updates.ts';
import { findProfile } from './roster.ts';
import type { ModelConfig, RoutingMode } from './roster.ts';

// ---------------------------------------------------------------------------
// Optional Jev readiness/completion gates
//
// Jev is TypeSafe's classifier family. Gates never call a premium chat model;
// they ask a classifier typed yes/no questions. Gate failures are advisory:
// in `shadow` mode they are recorded only, in `enforce` mode they block
// readiness (worker_failed/checks_failed can never be upgraded by a gate).
// ---------------------------------------------------------------------------

export const DEFAULT_JEV = { provider:'openrouter', id:'typesafe/jev-1.13' };
/** Below this self-reported confidence a gate answer is uncertain. */
export const CONFIDENCE_THRESHOLD = 0.6;
/** Upper bound on questions in one Jev readiness call. When adding one binary
 * question per playbook trait would exceed it, no trait questions are asked at
 * all (fail closed to no traits) so the call stays within the service limit. */
export const MAX_GATE_QUESTIONS = 20;

export type JevMode = 'off'|'shadow'|'enforce';

export function jevMode(t:any):JevMode {
 const m = t?.jev?.mode;
 return m === 'shadow' || m === 'enforce' ? m : 'off';
}

/** The recorded human consent for one non-default target model. */
export type ModelApproval = { source:'run'|'plan'|'project'; key:string };

/** The model actually used for a run and, when routing is eligible, the Jev
 * recommendation that produced it. `applied:false` always means the requested
 * model stayed unchanged. */
export type ModelRoute = {
 mode:RoutingMode;
 eligible:boolean;
 profile:string|null;
 confidence:number|null;
 applied:boolean;
 provider:string;
 model:string;
 reason:string;
 /** The run/plan/project consent that allowed a non-default target. */
 approval?:ModelApproval;
 /** True when a non-default target passed the other checks but lacks consent. */
 needsApproval?:boolean;
 /** True when `models.unapproved` was 'default' and the recommendation was
  * recorded but not applied. */
 declined?:boolean;
};

/** The consent request written before a non-default model would run. */
export type ModelApprovalRequest = {
 profile:string|null;
 provider:string;
 model:string;
 defaultModel:string;
 confidence:number|null;
 strengths:string|null;
 reason:string;
 price:ReturnType<typeof priceDelta>;
 approve:{run:string; project:string};
 /** How to run on the default model instead (declining the recommendation). */
 decline:string;
};

/** The run/plan/project approval for one of `keys`, most specific scope first.
 * A key is either the profile id or the model id. */
function findModelApproval(config:ModelConfig, opts:{approveModel?:unknown; approvedProfiles?:unknown}, keys:string[]):ModelApproval|null {
 const run=typeof opts?.approveModel === 'string' && opts.approveModel.trim() ? opts.approveModel.trim() : null;
 const plan=Array.isArray(opts?.approvedProfiles)
  ? opts.approvedProfiles.filter((k:any):k is string => typeof k === 'string' && !!k.trim()).map((k)=>k.trim())
  : [];
 const project=Array.isArray(config.approved) ? config.approved : [];
 for (const key of keys) if (run === key) return { source:'run', key };
 for (const key of keys) if (plan.includes(key)) return { source:'plan', key };
 for (const key of keys) if (project.includes(key)) return { source:'project', key };
 return null;
}

/** The approval for an explicit task model: run/plan/project consent, else a
 * resume/repair prior result that recorded an approval or ran the same model. */
export function resolveExplicitApproval(config:ModelConfig, t:any, requested:{provider:string;model:string}, prior:any):ModelApproval|null {
 const matchingProfiles=config.roster.filter((p)=>p.model === requested.model).map((p)=>p.id);
 const direct=findModelApproval(config, { approveModel:t?.approveModel, approvedProfiles:t?.approvedProfiles }, [requested.model, ...matchingProfiles]);
 if (direct) return direct;
 const recorded=prior?.modelRouting?.approval;
 if (recorded && typeof recorded === 'object' && (recorded.source === 'run' || recorded.source === 'plan' || recorded.source === 'project') && typeof recorded.key === 'string') {
  return { source:recorded.source, key:recorded.key };
 }
 const priorReq=prior?.receipt?.requested;
 if (priorReq && typeof priorReq.provider === 'string' && typeof priorReq.model === 'string'
     && priorReq.provider === requested.provider && priorReq.model === requested.model) {
  return { source:'run', key:requested.model };
 }
 return null;
}

/** Build the consent request for a non-default target, pricing it from the
 * local Pi catalog and the cached online catalog (unknown -> null). */
export function buildModelApprovalRequest(opts:{
 target:{ profile:string|null; provider:string; model:string; confidence:number|null; strengths:string|null };
 config:ModelConfig;
 reason:string;
 env?:NodeJS.ProcessEnv;
}):ModelApprovalRequest {
 const local=readLocalCatalog(piAgentDir(opts.env));
 const cached=readCachedCatalog(opts.env);
 const localPrices:Record<string,ModelPrice>=Object.fromEntries(local.entries.filter((e)=>e.price).map((e)=>[e.id, e.price as ModelPrice]));
 // Compare both models from one source: the cached OpenRouter catalog (what a
 // run is billed at) first, then Pi's local catalog, whose cost data can lag.
 const online=cached?.prices ?? {};
 const source=(online[opts.config.model] && online[opts.target.model]) ? online
  : (localPrices[opts.config.model] && localPrices[opts.target.model]) ? localPrices : null;
 const priceOf=(id:string):ModelPrice|null => source ? source[id] : (online[id] ?? localPrices[id] ?? null);
 const key=opts.target.profile ?? opts.target.model;
 return {
  profile:opts.target.profile,
  provider:opts.target.provider,
  model:opts.target.model,
  defaultModel:opts.config.model,
  confidence:opts.target.confidence,
  strengths:opts.target.strengths,
  reason:opts.reason,
  price:priceDelta(priceOf(opts.config.model), priceOf(opts.target.model)),
  approve:{
   run:`junior handoff <task> --approve-model ${key}`,
   project:`junior model approve ${key}`,
  },
  decline:`Run on the default model ${opts.config.model}: set "modelProfile": "${opts.config.defaultProfile}" in the contract (or models.unapproved: "default" for the project).`,
 };
}

/** The refusal record attached to a blocked result when the executor policy
 * rejects the requested (or routed) model. */
export type ModelPolicyRecord = {
 provider:string; model:string; class:ModelClass; reason:string;
 code:'frontier_model_refused'|'unknown_model_refused';
};

/** The per-deliverable model decision recorded after a run finalizes its
 * model. A later non-resume run with the same id reuses it so one deliverable
 * keeps one model. */
export type StickyRoute = {
 profile:string|null;
 provider:string;
 model:string;
 approval:ModelApproval|null;
 decidedAt:string;
};

/** The sticky route file for one task id, above the per-run timestamp dir. */
export function stickyRoutePath(cwd:string, id:string):string {
 return join(cwd,'.delivery',id,'route.json');
}

/** Read and shape-check the sticky route for `id`, or null when it is absent or
 * malformed. Approval is only kept when it is a well-formed consent record. */
export function readStickyRoute(cwd:string, id:string):StickyRoute|null {
 let raw:string;
 try { raw=readFileSync(stickyRoutePath(cwd,id),'utf8'); } catch { return null; }
 let parsed:any;
 try { parsed=JSON.parse(raw); } catch { return null; }
 if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
 if (typeof parsed.provider !== 'string' || !parsed.provider.trim()) return null;
 if (typeof parsed.model !== 'string' || !parsed.model.trim()) return null;
 const approval=parsed.approval && typeof parsed.approval === 'object'
  && (parsed.approval.source === 'run' || parsed.approval.source === 'plan' || parsed.approval.source === 'project')
  && typeof parsed.approval.key === 'string'
  ? { source:parsed.approval.source, key:parsed.approval.key } as ModelApproval
  : null;
 return {
  profile:typeof parsed.profile === 'string' && parsed.profile.trim() ? parsed.profile : null,
  provider:parsed.provider,
  model:parsed.model,
  approval,
  decidedAt:typeof parsed.decidedAt === 'string' ? parsed.decidedAt : '',
 };
}

/** True when a sticky decision may still be applied: the model is the current
 * default, or its recorded approval key is still granted via run, plan or
 * project consent. A revoked approval makes the record inert. */
export function stickyApprovalHolds(config:ModelConfig, t:any, sticky:StickyRoute):boolean {
 if (sticky.model === config.model) return true;
 if (!sticky.approval) return false;
 const key=sticky.approval.key;
 const run=typeof t?.approveModel === 'string' && t.approveModel.trim() ? t.approveModel.trim() : null;
 const plan=Array.isArray(t?.approvedProfiles)
  ? t.approvedProfiles.filter((k:any):k is string => typeof k === 'string' && !!k.trim()).map((k:string)=>k.trim())
  : [];
 const project=Array.isArray(config.approved) ? config.approved : [];
 return run === key || plan.includes(key) || project.includes(key);
}

/** Write the finalized model decision for a deliverable. */
export function writeStickyRoute(cwd:string, id:string, route:{ profile:string|null; provider:string; model:string; approval:ModelApproval|null }):void {
 const record:StickyRoute={ profile:route.profile, provider:route.provider, model:route.model, approval:route.approval, decidedAt:new Date().toISOString() };
 mkdirSync(join(cwd,'.delivery',id),{recursive:true});
 writeFileSync(stickyRoutePath(cwd,id),JSON.stringify(record,null,2));
}

/** The confidence of one classifier answer: bool probability distance from 0.5,
 * else the reported confidence. */
export function answerConfidence(a:any):number|null {
 if (!a || typeof a !== 'object') return null;
 if (a.type === 'bool' && typeof a.probability === 'number' && Number.isFinite(a.probability)) return Math.max(a.probability, 1-a.probability);
 if (typeof a.confidence === 'number' && Number.isFinite(a.confidence)) return a.confidence;
 return null;
}

function modelProfileChoice(answer:any):{ profile:string|null; confidence:number|null } {
 if (!answer || typeof answer !== 'object') return { profile:null, confidence:null };
 const picked=[answer.value, answer.choice, answer.label]
  .find((v:any)=>typeof v === 'string' && v.trim()) as string | undefined;
 return { profile: picked ? picked.trim() : null, confidence: answerConfidence(answer) };
}

/** Resolve the final model from the project roster and one Jev choice answer.
 * Routing only changes the requested model in `auto` mode, for a known
 * non-default profile, above the confidence threshold, whose model passes the
 * commodity policy. `shadow` records the recommendation without applying it. */
export function decideModelRoute(config:ModelConfig, answer:GateAnswer, opts:{eligible:boolean; skipped?:string; approveModel?:string; approvedProfiles?:string[]}):ModelRoute {
 const held={ provider:config.provider, model:config.model };
 const mode=config.routing;
 if (!opts.eligible || mode === 'off') {
  return { mode, eligible:false, profile:null, confidence:null, applied:false, ...held,
   reason: opts.skipped ?? (mode === 'off' ? 'routing off' : 'routing not eligible') };
 }
 const picked=modelProfileChoice(answer);
 const confidence=picked.confidence;
 if (!picked.profile) {
  return { mode, eligible:true, profile:null, confidence, applied:false, ...held,
   reason:'classifier returned no model profile choice' };
 }
 const profile=findProfile(config, picked.profile);
 if (!profile) {
  return { mode, eligible:true, profile:picked.profile, confidence, applied:false, ...held,
   reason:`model profile '${picked.profile}' is not in the roster` };
 }
 if (profile.id === config.defaultProfile) {
  return { mode, eligible:true, profile:profile.id, confidence, applied:false, ...held,
   reason:`model profile '${profile.id}' is the default` };
 }
 if (confidence === null || confidence < CONFIDENCE_THRESHOLD) {
  return { mode, eligible:true, profile:profile.id, confidence, applied:false, ...held,
   reason:`model profile confidence ${confidence === null ? 'missing' : confidence} is below the ${CONFIDENCE_THRESHOLD} threshold` };
 }
 try {
  assertCommodity(profile.provider, profile.model);
 } catch (e) {
  const detail=e instanceof ModelPolicyError ? `${e.code}: ${e.verdict.reason}` : msg(e);
  return { mode, eligible:true, profile:profile.id, confidence, applied:false, ...held,
   reason:`model profile '${profile.id}' is refused by the commodity policy (${detail})` };
 }
 if (mode === 'shadow') {
  return { mode, eligible:true, profile:profile.id, confidence, applied:false, ...held,
   reason:`shadow mode records model profile '${profile.id}' without applying it` };
 }
 // A target that is the same model as the pin changes nothing and needs no consent.
 const approval=profile.model === config.model ? null : findModelApproval(config, opts, [profile.id, profile.model]);
 if (profile.model !== config.model && !approval) {
  return { mode, eligible:true, profile:profile.id, confidence, applied:false, needsApproval:true, ...held,
   reason:`model profile '${profile.id}' needs human approval: no run, plan or project approval for '${profile.id}' or '${profile.model}'` };
 }
 return { mode, eligible:true, profile:profile.id, confidence, applied:true,
  provider:profile.provider, model:profile.model, ...(approval?{approval}:{}), reason:`auto-routed to model profile '${profile.id}'` };
}

