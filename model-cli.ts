// ---------------------------------------------------------------------------
// `junior model` command and model adoption during `junior update`.
//
// The command is a thin, offline-by-default surface over the existing model
// policy, roster and update modules: `status` reports the pin, roster and
// catalog, `list` shows commodity releases, and `upgrade` plans and (with
// consent) applies same-lineage upgrades to `delivery.config.json`. A frontier
// or unknown target is never written: `planUpgrades` routes it to `refused`
// with the policy verdict, and `applyUpgrades` only ever receives commodity
// changes.
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
import { catalogIds, modelUpdates, type ModelUpdate } from './model-updates.ts';
import type { CatalogFetch } from './models.ts';

export type ModelChange = { profile: string; from: string; to: string; isDefault: boolean };
export type ModelRefusal = { profile: string; to: string; reason: string };
export type UpgradePlan = { changes: ModelChange[]; refused: ModelRefusal[] };

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
export function planUpgrades(config: ModelConfig, updates: ModelUpdate[], opts: { profile?: string; to?: string } = {}): UpgradePlan {
  const changes: ModelChange[] = [];
  const refused: ModelRefusal[] = [];
  const byProfile = new Map(updates.map((u) => [u.profile, u]));

  if (opts.to !== undefined) {
    const profile = opts.profile ?? config.defaultProfile;
    const update = byProfile.get(profile);
    if (!update) {
      refused.push({ profile, to: opts.to, reason: `unknown profile '${profile}'` });
      return { changes, refused };
    }
    const verdict = classifyModel(update.provider, opts.to);
    if (verdict.class !== 'commodity') {
      refused.push({ profile, to: opts.to, reason: verdict.reason });
      return { changes, refused };
    }
    changes.push({ profile, from: update.current, to: opts.to, isDefault: profile === config.defaultProfile || update.isDefault });
    return { changes, refused };
  }

  let selected = updates;
  if (opts.profile !== undefined) {
    const update = byProfile.get(opts.profile);
    if (!update) {
      refused.push({ profile: opts.profile, to: '', reason: `unknown profile '${opts.profile}'` });
      return { changes, refused };
    }
    selected = [update];
  }
  for (const update of selected) {
    if (!update.latest) continue;
    changes.push({ profile: update.profile, from: update.current, to: update.latest, isDefault: update.isDefault });
  }
  return { changes, refused };
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
}

/** Strict parser for `status|list|upgrade` options. */
function parseModel(argv: string[]): ParsedModel {
  const sub = argv[0] ?? '';
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const valueFlags = new Set(['--vendor', '--profile', '--to']);
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
      flags.add(name);
      continue;
    }
    throw Error(`Unknown option for model: ${arg}`);
  }
  return { sub, flags, values };
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
    const catalog = await catalogIds({ online: parsed.flags.has('--online'), fetch: deps.fetch, env });
    const updates = modelUpdates(config, catalog.ids);
    const result = {
      pinned: { provider: config.provider, model: config.model, source: config.source, path: config.path },
      policy: config.pinnedVerdict,
      routing: config.routing,
      autoUpgrade: config.autoUpgrade,
      roster: config.roster.map((p) => ({ profile: p.id, provider: p.provider, model: p.model, default: p.id === config.defaultProfile })),
      rejected: config.rejected,
      catalog: catalog.catalog,
      updates,
    };
    return { exitCode: 0, result };
  }

  if (parsed.sub === 'list') {
    const catalog = await catalogIds({ online: parsed.flags.has('--online'), fetch: deps.fetch, env });
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

  if (parsed.sub === 'upgrade') {
    const config = loadModelConfig(cwd);
    const catalog = await catalogIds({ online: parsed.flags.has('--online'), fetch: deps.fetch, env });
    const updates = modelUpdates(config, catalog.ids);
    const plan = planUpgrades(config, updates, { profile: parsed.values['--profile'], to: parsed.values['--to'] });
    const dryRun = parsed.flags.has('--dry-run');
    const result: any = { changes: plan.changes, refused: plan.refused, applied: false };

    let refusedToWrite = false;
    if (plan.changes.length > 0 && !dryRun) {
      if (parsed.flags.has('--yes')) {
        applyUpgrades(cwd, plan.changes);
        result.applied = true;
      } else if (isTTY) {
        const confirm = deps.confirm ?? defaultConfirm;
        const ok = await confirm(`Apply ${plan.changes.length} model change(s) to delivery.config.json?`);
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
  applied: boolean;
  catalog: 'online' | 'local' | null;
}> {
  const config = loadModelConfig(cwd);
  const catalog = await catalogIds({ online: true, fetch: deps.fetch, env: deps.env });
  const updates = modelUpdates(config, catalog.ids);
  const { changes, refused } = planUpgrades(config, updates, {});
  const enabled = config.autoUpgrade;
  let applied = false;
  if (enabled && changes.length > 0) {
    applyUpgrades(cwd, changes);
    applied = true;
  }
  return { enabled, changes, refused, applied, catalog: catalog.catalog };
}
