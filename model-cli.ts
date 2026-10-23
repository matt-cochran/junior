// ---------------------------------------------------------------------------
// `junior model` command and model adoption during `junior update`.
//
// The command is a thin surface over the existing model policy, roster and
// update modules: `status` reports the pin, roster and catalog, `list` shows
// commodity releases, and `upgrade` plans and (with consent) applies
// same-lineage upgrades to `delivery.config.json`. `list` and `upgrade` consult
// the online OpenRouter catalog by default and fall back to Pi's local catalog;
// `--offline` skips the network, and `--online` remains accepted for
// compatibility. A frontier or unknown target is never written: `planUpgrades`
// routes it to `refused` with the policy verdict, and `applyUpgrades` only ever
// receives commodity changes.
//
// The OpenRouter catalog is reached through the injectable `fetch` seam and
// Pi's local catalog through PI_CODING_AGENT_DIR, so tests never touch the
// network or the real agent directory. `applyUpgrades` rewrites the config
// sparingly: it preserves every other key, keeps 2-space JSON with a trailing
// newline, and leaves the file untouched when there is nothing to change.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyModel } from './model-policy.ts';
import { loadModelConfig, type ModelConfig } from './roster.ts';
import { catalogIds, modelUpdates, priceComparable, priceDelta, type ModelUpdate, type PriceDelta, type PriceProvenance } from './model-updates.ts';
import type { CatalogFetch, ModelPrice } from './models.ts';

export type ModelChange = { profile: string; from: string; to: string; isDefault: boolean; price: PriceDelta };
export type ModelRefusal = { profile: string; to: string; reason: string };
export type ModelWaiting = { profile: string; to: string; inputRatio: number | null; outputRatio: number | null; reason: 'waiting for price parity' };
export type UpgradePlan = { changes: ModelChange[]; refused: ModelRefusal[]; waiting: ModelWaiting[] };

/** Minimal fs seam so `applyUpgrades` can be exercised without disk. */
export interface ConfigFs {
  existsSync(p: string): boolean;
  readFileSync(p: string, e: 'utf8'): string;
  writeFileSync(p: string, data: string): void;
}

const DEFAULT_CONFIG_FS: ConfigFs = {
  existsSync: (p) => existsSync(p),
  readFileSync: (p, e) => readFileSync(p, e),
  writeFileSync: (p, data) => writeFileSync(p, data),
};

/**
 * Plan same-lineage commodity upgrades for the roster. By default every update
 * contributes its newest release. `--profile` limits the plan to one profile,
 * and `--to` names an explicit target for the selected profile (the default
 * profile when no profile is given). An explicit target must pass the model
 * policy, so a frontier or unknown target is refused with the verdict reason
 * and never appears in `changes`.
 */
export function planUpgrades(config: ModelConfig, updates: ModelUpdate[], opts: { profile?: string; to?: string; prices?: Record<string, ModelPrice>; sources?: Record<string, PriceProvenance> } = {}): UpgradePlan {
  const changes: ModelChange[] = [];
  const refused: ModelRefusal[] = [];
  const waiting: ModelWaiting[] = [];
  const byProfile = new Map(updates.map((u) => [u.profile, u]));
  const prices = opts.prices ?? {};
  const sources = opts.sources ?? {};
  const tolerance = config.priceTolerance ?? 1.25;
  const delta = (from: string, to: string): PriceDelta => {
    const base = priceDelta(prices[from] ?? null, prices[to] ?? null);
    const provenance = sources[to] ?? sources[from];
    return provenance ? { ...base, priceSource: provenance.priceSource, provider: provenance.provider } : base;
  };

  if (opts.to !== undefined) {
    const profile = opts.profile ?? config.defaultProfile;
    const update = byProfile.get(profile);
    if (!update) {
      refused.push({ profile, to: opts.to, reason: `unknown profile '${profile}'` });
      return { changes, refused, waiting };
    }
    const verdict = classifyModel(update.provider, opts.to);
    if (verdict.class !== 'commodity') {
      refused.push({ profile, to: opts.to, reason: verdict.reason });
      return { changes, refused, waiting };
    }
    changes.push({ profile, from: update.current, to: opts.to, isDefault: profile === config.defaultProfile || update.isDefault, price: delta(update.current, opts.to) });
    return { changes, refused, waiting };
  }

  let selected = updates;
  if (opts.profile !== undefined) {
    const update = byProfile.get(opts.profile);
    if (!update) {
      refused.push({ profile: opts.profile, to: '', reason: `unknown profile '${opts.profile}'` });
      return { changes, refused, waiting };
    }
    selected = [update];
  }
  for (const update of selected) {
    if (!update.latest) continue;
    const price = delta(update.current, update.latest);
    if (priceComparable(price, tolerance) === false) {
      waiting.push({ profile: update.profile, to: update.latest, inputRatio: price.inputRatio, outputRatio: price.outputRatio, reason: 'waiting for price parity' });
      continue;
    }
    changes.push({ profile: update.profile, from: update.current, to: update.latest, isDefault: update.isDefault, price });
  }
  return { changes, refused, waiting };
}

/**
 * Rewrite `<cwd>/delivery.config.json` with the planned changes, preserving
 * every other key and the 2-space JSON formatting with a trailing newline. A
 * default-profile change sets the top-level `model`; a non-default change
 * updates (or adds) the matching `models.roster` entry by profile id. A missing
 * file is created from the minimal `{provider, model, models:{routing:'auto'}}`
 * shape. With no changes the file is left untouched.
 */
export function applyUpgrades(cwd: string, changes: ModelChange[], fs: ConfigFs = DEFAULT_CONFIG_FS): { path: string; written: boolean } {
  const path = join(cwd, 'delivery.config.json');
  if (!changes || changes.length === 0) return { path, written: false };

  let obj: any;
  try {
    obj = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : null;
  } catch {
    obj = null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
  if (!obj.provider) obj.provider = 'openrouter';
  if (!obj.models || typeof obj.models !== 'object' || Array.isArray(obj.models)) obj.models = {};
  if (obj.models.routing === undefined) obj.models.routing = 'auto';

  for (const change of changes) {
    if (change.isDefault) {
      obj.model = change.to;
      continue;
    }
    if (!Array.isArray(obj.models.roster)) obj.models.roster = [];
    const existing = obj.models.roster.find((entry: any) => entry && typeof entry === 'object' && entry.id === change.profile);
    if (existing) existing.model = change.to;
    else obj.models.roster.push({ id: change.profile, model: change.to });
  }
  if (obj.model === undefined) obj.model = changes[0].from;

  fs.writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
  return { path, written: true };
}

/** Write `models.approved` back to delivery.config.json, preserving every other
 * top-level and `models` key. Returns false when the list did not change. */
function writeApproved(cwd: string, approved: string[], fs: ConfigFs = DEFAULT_CONFIG_FS): boolean {
  const path = join(cwd, 'delivery.config.json');
  let obj: any;
  try {
    obj = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : null;
  } catch {
    obj = null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
  if (!obj.models || typeof obj.models !== 'object' || Array.isArray(obj.models)) obj.models = {};
  const before = JSON.stringify(Array.isArray(obj.models.approved) ? obj.models.approved : []);
  obj.models.approved = approved;
  if (before === JSON.stringify(approved)) return false;
  fs.writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
  return true;
}

export interface ModelCommandDeps {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  confirm?: (q: string) => Promise<boolean>;
  fetch?: CatalogFetch;
  out?: (s: string) => void;
}

/** Ask a yes/no question on the real terminal; only used by the default path. */
async function defaultConfirm(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

interface ParsedModel {
  sub: string;
  flags: Set<string>;
  values: Record<string, string>;
  /** The single positional argument (the approve/revoke key), or null. */
  positional: string | null;
}

/** Strict parser for `status|list|upgrade|approve|revoke` options. */
function parseModel(argv: string[]): ParsedModel {
  const sub = argv[0] ?? '';
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  let positional: string | null = null;
  const valueFlags = new Set(['--vendor', '--profile', '--to']);
  const allowedFlags = new Set<string>([
    ...(sub === 'status' || sub === 'list' ? ['--online', '--offline'] : []),
    ...(sub === 'upgrade' ? ['--online', '--offline', '--dry-run', '--yes'] : []),
  ]);
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (valueFlags.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value === '' || value.startsWith('-')) throw Error(`Option ${name} requires a value`);
      values[name] = value;
      continue;
    }
    if (name.startsWith('--')) {
      if (!allowedFlags.has(name)) throw Error(`Unknown option for model ${sub}: ${name}`);
      flags.add(name);
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') throw Error(`Unknown option for model: ${arg}`);
    if (positional !== null) throw Error(`Unexpected argument for model ${sub}: ${arg}`);
    positional = arg;
  }
  if (positional !== null && sub !== 'approve' && sub !== 'revoke') throw Error(`Unexpected argument for model ${sub}: ${positional}`);
  return { sub, flags, values, positional };
}

/**
 * Run one `junior model` subcommand. Returns the JSON result for the caller to
 * print and the process exit code. `status` and `list` are read-only; `upgrade`
 * writes only with `--yes` or an interactive confirmation, and never writes on
 * a non-TTY without consent.
 */
export async function runModelCommand(argv: string[], deps: ModelCommandDeps = {}): Promise<{ exitCode: number; result: any }> {
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
  const out = deps.out ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const parsed = parseModel(argv);

  if (parsed.sub === 'status') {
    const config = loadModelConfig(cwd);
    const catalog = await catalogIds({ online: parsed.flags.has('--online') && !parsed.flags.has('--offline'), fetch: deps.fetch, env, config });
    const updates = modelUpdates(config, catalog.ids, { prices: catalog.prices, sources: catalog.sources });
    const result = {
      pinned: { provider: config.provider, model: config.model, source: config.source, path: config.path },
      policy: config.pinnedVerdict,
      routing: config.routing,
      autoUpgrade: config.autoUpgrade,
      approved: config.approved,
      unapproved: config.unapproved,
      priceTolerance: config.priceTolerance,
      roster: config.roster.map((p) => ({ profile: p.id, provider: p.provider, model: p.model, default: p.id === config.defaultProfile, price: catalog.prices[p.model] ?? null })),
      rejected: config.rejected,
      catalog: catalog.catalog,
      updates,
    };
    return { exitCode: 0, result };
  }

  if (parsed.sub === 'list') {
    const catalog = await catalogIds({ online: !parsed.flags.has('--offline'), fetch: deps.fetch, env });
    const vendorFilter = parsed.values['--vendor'];
    const models: string[] = [];
    const vendors: Record<string, string[]> = {};
    for (const id of catalog.ids) {
      const verdict = classifyModel('openrouter', id);
      if (verdict.class !== 'commodity') continue;
      const vendor = verdict.vendor ?? 'unknown';
      if (vendorFilter !== undefined && vendor !== vendorFilter) continue;
      if (models.includes(id)) continue;
      models.push(id);
      (vendors[vendor] ??= []).push(id);
    }
    return { exitCode: 0, result: { catalog: catalog.catalog, models, vendors } };
  }

  if (parsed.sub === 'approve' || parsed.sub === 'revoke') {
    const key = parsed.positional;
    if (!key) {
      return { exitCode: 1, result: { error: `Usage: junior model ${parsed.sub} <profile|model>` } };
    }
    const config = loadModelConfig(cwd);
    const profile = config.roster.find((p) => p.id === key) ?? null;
    if (parsed.sub === 'approve' && profile && profile.id === config.defaultProfile) {
      return { exitCode: 0, result: { approved: config.approved, key, changed: false, reason: `profile '${key}' is the default and needs no approval` } };
    }
    if (!profile) {
      const verdict = classifyModel(config.provider, key);
      if (verdict.class !== 'commodity') {
        return { exitCode: 1, result: { error: `Refusing to approve '${key}': ${verdict.reason}`, verdict } };
      }
    }
    const approved = parsed.sub === 'approve'
      ? [...config.approved.filter((k) => k !== key), key]
      : config.approved.filter((k) => k !== key);
    const changed = writeApproved(cwd, approved);
    return { exitCode: 0, result: { approved, key, changed } };
  }

  if (parsed.sub === 'upgrade') {
    const config = loadModelConfig(cwd);
    const catalog = await catalogIds({ online: !parsed.flags.has('--offline'), fetch: deps.fetch, env, config });
    const updates = modelUpdates(config, catalog.ids, { prices: catalog.prices, sources: catalog.sources });
    const plan = planUpgrades(config, updates, { profile: parsed.values['--profile'], to: parsed.values['--to'], prices: catalog.prices, sources: catalog.sources });
    const dryRun = parsed.flags.has('--dry-run');
    const pricier = plan.changes.filter((change) => change.price.pricier === true);
    const result: any = { changes: plan.changes, refused: plan.refused, waiting: plan.waiting, applied: false, pricier, catalog: catalog.catalog };

    let refusedToWrite = false;
    if (plan.changes.length > 0 && !dryRun) {
      if (parsed.flags.has('--yes')) {
        applyUpgrades(cwd, plan.changes);
        result.applied = true;
      } else if (isTTY) {
        const confirm = deps.confirm ?? defaultConfirm;
        const suffix = pricier.length > 0 ? ` ${pricier.length} ${pricier.length === 1 ? 'is' : 'are'} pricier than the current model.` : '';
        const ok = await confirm(`Apply ${plan.changes.length} model change(s) to delivery.config.json?${suffix}`);
        if (ok) {
          applyUpgrades(cwd, plan.changes);
          result.applied = true;
        }
      } else {
        refusedToWrite = true;
        result.message = 'Refusing to write delivery.config.json without --yes; rerun with --yes to apply the planned changes.';
        out(result.message);
      }
    }

    let exitCode = 0;
    if (refusedToWrite) exitCode = 1;
    else if (plan.refused.length > 0 && plan.changes.length === 0) exitCode = 1;
    return { exitCode, result };
  }

  return { exitCode: 1, result: { error: `Unknown model subcommand: ${parsed.sub || '(none)'}` } };
}

/**
 * Adopt newer same-lineage commodity models during `junior update`. Upgrades
 * are planned for every profile from the online catalog (with the local Pi
 * catalog as fallback). They are applied without a prompt only when the project
 * opted in with `models.autoUpgrade`; otherwise the would-be changes are
 * reported unapplied.
 */
export async function adoptModelUpdates(cwd: string, deps: { fetch?: CatalogFetch; env?: NodeJS.ProcessEnv } = {}): Promise<{
  enabled: boolean;
  changes: ModelChange[];
  refused: ModelRefusal[];
  waiting: ModelWaiting[];
  applied: boolean;
  catalog: 'online' | 'local' | null;
}> {
  const config = loadModelConfig(cwd);
  const catalog = await catalogIds({ online: true, fetch: deps.fetch, env: deps.env, config });
  const updates = modelUpdates(config, catalog.ids, { prices: catalog.prices, sources: catalog.sources });
  const { changes, refused, waiting } = planUpgrades(config, updates, { prices: catalog.prices, sources: catalog.sources });
  const enabled = config.autoUpgrade;
  let applied = false;
  if (enabled && changes.length > 0) {
    applyUpgrades(cwd, changes);
    applied = true;
  }
  return { enabled, changes, refused, waiting, applied, catalog: catalog.catalog };
}
