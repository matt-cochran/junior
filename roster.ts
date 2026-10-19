// ---------------------------------------------------------------------------
// Junior commodity model roster.
//
// Junior executes only on commodity / open-weight models. This module defines
// the built-in roster of OpenRouter commodity profiles, overlays a project's
// delivery.config.json on top of it, and reports every resulting non-default
// profile that the model policy refuses (frontier or unknown) through
// `rejected` so callers can keep them out of execution.
//
// The pinned provider/model is never rewritten: a frontier or unknown pin is
// reported as-is with `pinnedVerdict`, leaving the doctor/run enforcement to
// refuse it later. Loading never throws; a missing or malformed config falls
// back to the built-ins.
// ---------------------------------------------------------------------------

import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyModel, type ModelVerdict } from './model-policy.ts';

export type RoutingMode = 'off'|'shadow'|'auto';

export type RosterProfile = {
  id:string;
  provider:string;
  model:string;
  strengths:string;
  default?:boolean;
};

export type RejectedProfile = {
  id:string;
  provider:string;
  model:string;
  reason:string;
};

export type ModelConfig = {
  provider:string;
  model:string;
  source:'project'|'builtin';
  path:string|null;
  pinnedVerdict:ModelVerdict;
  routing:RoutingMode;
  /** `junior update` adopts newer same-lineage commodity models only when true. */
  autoUpgrade:boolean;
  defaultProfile:string;
  /** Human-approved model keys: profile ids or model ids. Empty by default;
   * the project pin itself never needs an entry. */
  approved:string[];
  /** What to do with an unapproved non-default model: ask for consent or fall
   * back to the default model. */
  unapproved:'ask'|'default';
  /** How much pricier a newer release may be (input and output ratios) before
   * adoption waits for price parity. */
  priceTolerance:number;
  roster:RosterProfile[];
  rejected:RejectedProfile[];
};

export const DEFAULT_ROUTING:RoutingMode = 'auto';
export const DEFAULT_PRICE_TOLERANCE = 1.25;

export const BUILTIN_ROSTER:readonly RosterProfile[] = [
  {
    id:'general',
    provider:'openrouter',
    model:'deepseek/deepseek-v4.1-flash',
    default:true,
    strengths:'Default for bounded implementation: bug fixes, tests, small multi-file changes, docs and setup. Lowest cost; use unless the task clearly needs another profile.',
  },
  {
    id:'deep-reasoning',
    provider:'openrouter',
    model:'deepseek/deepseek-v4-pro-0813',
    strengths:'Harder reasoning inside a bounded task: subtle debugging, concurrency, algorithms, performance work, or refactors whose correctness depends on careful analysis.',
  },
  {
    id:'long-horizon',
    provider:'openrouter',
    model:'moonshotai/kimi-k2.7-code',
    strengths:'Long autonomous coding sessions with many tool calls, navigating a large codebase, and front-end or UI implementation.',
  },
  {
    id:'agentic-tools',
    provider:'openrouter',
    model:'z-ai/glm-5.3',
    strengths:'Tool-heavy work: shell, build, CI and environment setup, scripting, and orchestrating many small command steps.',
  },
  {
    id:'fast-mechanical',
    provider:'openrouter',
    model:'qwen/qwen3.7-flash',
    strengths:'Cheap mechanical edits: renames, formatting, boilerplate, and straightforward summaries over a small scope.',
  },
];

/** Minimal fs seam so configuration loading can be exercised without disk. */
export interface RosterFs {
  existsSync(p:string):boolean;
  readFileSync(p:string,e:'utf8'):string;
}

const DEFAULT_FS:RosterFs = {
  existsSync:(p)=>nodeExistsSync(p),
  readFileSync:(p,e)=>nodeReadFileSync(p,e),
};

function nonEmpty(value:unknown):string|null {
  return typeof value==='string' && value.trim() ? value : null;
}

function isObject(value:unknown):value is Record<string,unknown> {
  return typeof value==='object' && value!==null;
}

function readRouting(value:unknown):RoutingMode {
  return value==='off'||value==='shadow'||value==='auto' ? value : DEFAULT_ROUTING;
}

/** Trimmed, de-duplicated approved keys; non-strings and blanks are dropped. */
function readApproved(value:unknown):string[] {
  if (!Array.isArray(value)) return [];
  const out:string[]=[];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const key=entry.trim();
    if (!key || out.includes(key)) continue;
    out.push(key);
  }
  return out;
}

function readUnapproved(value:unknown):'ask'|'default' {
  return value==='default' ? 'default' : 'ask';
}

/** A finite tolerance of at least 1; anything else falls back to 1.25. */
function readPriceTolerance(value:unknown):number {
  return typeof value==='number' && Number.isFinite(value) && value >= 1 ? value : DEFAULT_PRICE_TOLERANCE;
}

/** Overlay one `models.roster` entry, reporting a rejection when a brand-new
 * profile is incomplete. Built-in overrides only replace provided fields. */
function applyOverride(candidates:RosterProfile[], entry:Record<string,unknown>, rejected:RejectedProfile[]):void {
  const id = nonEmpty(entry.id);
  if (!id) return;
  const existing = candidates.find((c)=>c.id===id);
  if (existing) {
    if (entry.disabled===true) {
      if (!existing.default) candidates.splice(candidates.indexOf(existing),1);
      return;
    }
    const provider = nonEmpty(entry.provider);
    const model = nonEmpty(entry.model);
    const strengths = nonEmpty(entry.strengths);
    if (provider) existing.provider=provider;
    if (model) existing.model=model;
    if (strengths) existing.strengths=strengths;
    return;
  }
  const provider = nonEmpty(entry.provider) ?? '';
  const model = nonEmpty(entry.model) ?? '';
  const strengths = nonEmpty(entry.strengths) ?? '';
  if (!provider || !model || !strengths) {
    rejected.push({ id, provider, model, reason:`new profile '${id}' needs provider, model and strengths` });
    return;
  }
  candidates.push({ id, provider, model, strengths });
}

/**
 * Load the project's model configuration from `<cwd>/delivery.config.json`,
 * falling back to the built-in roster when the file is missing or malformed.
 */
export function loadModelConfig(cwd:string, fs:RosterFs = DEFAULT_FS):ModelConfig {
  const path=join(cwd,'delivery.config.json');
  let raw:Record<string,unknown>|null=null;
  try {
    if (fs.existsSync(path)) {
      const parsed:unknown=JSON.parse(fs.readFileSync(path,'utf8'));
      if (isObject(parsed)) raw=parsed;
    }
  } catch { raw=null; }

  const source:ModelConfig['source'] = raw ? 'project' : 'builtin';
  const configPath = raw ? path : null;
  const obj = raw ?? {};

  const builtinGeneral = BUILTIN_ROSTER.find((p)=>p.default) ?? BUILTIN_ROSTER[0];
  const models = isObject(obj.models) ? obj.models : null;

  const candidates:RosterProfile[] = BUILTIN_ROSTER.map((p)=>({...p}));
  const rejected:RejectedProfile[] = [];
  if (models && Array.isArray(models.roster)) {
    for (const entry of models.roster) {
      if (!isObject(entry)) continue;
      applyOverride(candidates, entry, rejected);
    }
  }

  // The pinned default follows an explicit top-level pin, otherwise the
  // (possibly overridden) default profile. It is written back so the pin and
  // the default profile always agree, even when the pin is frontier/unknown.
  const defaultEntry = candidates.find((c)=>c.default) ?? candidates[0];
  const pinnedProvider = nonEmpty(obj.provider) ?? 'openrouter';
  const pinnedModel = nonEmpty(obj.model) ?? defaultEntry?.model ?? builtinGeneral.model;
  if (defaultEntry) {
    defaultEntry.provider=pinnedProvider;
    defaultEntry.model=pinnedModel;
  }
  const defaultProfile = defaultEntry ? defaultEntry.id : builtinGeneral.id;

  const roster:RosterProfile[]=[];
  for (const candidate of candidates) {
    if (candidate===defaultEntry) { roster.push(candidate); continue; }
    const verdict=classifyModel(candidate.provider,candidate.model);
    if (verdict.class==='commodity') roster.push(candidate);
    else rejected.push({ id:candidate.id, provider:candidate.provider, model:candidate.model, reason:verdict.reason });
  }

  return {
    provider:pinnedProvider,
    model:pinnedModel,
    source,
    path:configPath,
    pinnedVerdict:classifyModel(pinnedProvider,pinnedModel),
    routing:models ? readRouting(models.routing) : DEFAULT_ROUTING,
    autoUpgrade:models?.autoUpgrade===true,
    defaultProfile,
    approved:readApproved(models?.approved),
    unapproved:readUnapproved(models?.unapproved),
    priceTolerance:readPriceTolerance(models?.priceTolerance),
    roster,
    rejected,
  };
}

/** Map each profile id to its strengths for a Jev choice question. */
export function rosterChoiceCriteria(roster:readonly RosterProfile[]):Record<string,string> {
  const criteria:Record<string,string>={};
  for (const profile of roster) criteria[profile.id]=profile.strengths;
  return criteria;
}

/** Find a roster profile by id, or null when it is absent. */
export function findProfile(config:ModelConfig, id:string):RosterProfile|null {
  return config.roster.find((profile)=>profile.id===id) ?? null;
}
