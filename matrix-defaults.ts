// ---------------------------------------------------------------------------
// Defaults for `junior matrix` commands.
//
// Every value a matrix command needs is resolved from the project when the
// caller omits it, so flags are overrides rather than a required spec:
//
//   hop     resolveHop (active selection, `tools.hop`, sole discovered hop,
//           `.delivery/setup/hop.json`)
//   model   `matrix.model` in delivery.config.json, the sole
//           `.crossmatrix/state/<id>.json`, else the project name
//   sources `matrix.sources`, else code + tests (+ jevitate, + cpm)
//   plan    `matrix.plan`, else the sole unfinished, unarchived plan line
//   result  the newest `.delivery/<id>/<stamp>/result.json`
//   feature the result's plan deliverable; bare ids mean cpm deliverables
//
// Ambiguity is never guessed: it fails with the candidates and the flag or
// config key that pins the value.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { projectRoot, resolveHop } from './hop-context.ts';
import { callHop } from './tools/tools.ts';

export type DefaultSource = 'explicit' | 'config' | 'store' | 'project' | 'discovered' | 'active' | 'default' | 'plan.list';

export interface MatrixConfig {
  model?: string;
  sources?: string[];
  plan?: string;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `matrix` block of `<root>/delivery.config.json`, keeping only well-typed keys. */
export function matrixConfig(root: string): MatrixConfig {
  const config = readJson(join(root, 'delivery.config.json'));
  const block = isRecord(config) ? config.matrix : undefined;
  if (!isRecord(block)) return {};
  const out: MatrixConfig = {};
  if (typeof block.model === 'string' && block.model.trim()) out.model = block.model.trim();
  if (typeof block.plan === 'string' && block.plan.trim()) out.plan = block.plan.trim();
  if (Array.isArray(block.sources) && block.sources.every((s) => typeof s === 'string') && block.sources.length > 0) {
    out.sources = block.sources as string[];
  }
  return out;
}

export function resolveMatrixHop(cwd: string, explicit?: string): { path: string; source: DefaultSource } {
  const resolution = resolveHop(cwd, { explicit });
  if (resolution.status === 'ambiguous') {
    const paths = resolution.candidates.map((hop) => hop.path).join(', ');
    throw new Error(`Several Hops were found (${paths}); pass --hop <hop.json> or select one with junior compact --hop <path>.`);
  }
  return { path: resolution.path, source: resolution.source };
}

/** A Crossmatrix-safe model id from a project name: lowercase, `[a-z0-9-]`. */
function modelIdFromName(name: string): string {
  return name
    .replace(/^@[^/]+\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function projectName(root: string): string {
  const pkg = readJson(join(root, 'package.json'));
  const name = isRecord(pkg) && typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name : basename(root);
  return modelIdFromName(name) || 'project';
}

export function resolveMatrixModel(root: string, explicit?: string): { id: string; source: DefaultSource } {
  if (explicit) return { id: explicit, source: 'explicit' };
  const configured = matrixConfig(root).model;
  if (configured) return { id: configured, source: 'config' };
  const name = projectName(root);
  const stateDir = join(root, '.crossmatrix', 'state');
  let models: string[] = [];
  try {
    models = readdirSync(stateDir)
      .filter((file) => file.endsWith('.json') && !file.startsWith('.'))
      .map((file) => file.slice(0, -'.json'.length))
      .sort();
  } catch {
    // No store yet: the project name becomes the model.
  }
  if (models.length === 1) return { id: models[0], source: 'store' };
  if (models.length > 1) {
    if (models.includes(name)) return { id: name, source: 'store' };
    throw new Error(
      `Several Crossmatrix models exist (${models.join(', ')}); pass --model <id> or set matrix.model in delivery.config.json.`,
    );
  }
  return { id: name, source: 'project' };
}

/** Sources synced when `--source` is omitted. */
export function defaultSources(root: string, planResolved: boolean): string[] {
  const configured = matrixConfig(root).sources;
  if (configured) return configured;
  const sources = ['code', 'tests'];
  if (existsSync(join(root, '.jevitate'))) sources.push('jevitate');
  if (planResolved) sources.push('cpm');
  return sources;
}

export interface PlanResolution {
  planId?: string;
  source?: DefaultSource;
  /** `plan_id (name)` for each unfinished line when several are live. */
  candidates?: string[];
}

/** The plan id from the flag, `matrix.plan`, or the sole unfinished plan line in `plan.list`. */
export async function resolveMatrixPlan(
  root: string,
  hopPath: string,
  explicit?: string,
  call: typeof callHop = callHop,
): Promise<PlanResolution> {
  if (explicit) return { planId: explicit, source: 'explicit' };
  const configured = matrixConfig(root).plan;
  if (configured) return { planId: configured, source: 'config' };
  let result: unknown;
  try {
    const outcome = await call(hopPath, 'cpm', { tool: 'plan.list', arguments: {} });
    if (!outcome.ok || outcome.isError) return {};
    result = outcome.result;
  } catch {
    return {};
  }
  const lines = Array.isArray(result) ? result : isRecord(result) && Array.isArray(result.plans) ? result.plans : [];
  const live: string[] = [];
  const labels: string[] = [];
  for (const line of lines) {
    if (!isRecord(line) || line.archived === true || !Array.isArray(line.variants)) continue;
    const selected = line.variants.find((v) => isRecord(v) && v.selected === true && v.archived !== true);
    if (!isRecord(selected) || selected.plan_complete === true || typeof selected.plan_id !== 'string') continue;
    live.push(selected.plan_id);
    labels.push(`${selected.plan_id} (${String(line.name ?? '')})`);
  }
  if (live.length === 1) return { planId: live[0], source: 'plan.list' };
  if (live.length > 1) return { candidates: labels };
  return {};
}

/** The newest `.delivery/<id>/<numeric stamp>/result.json`, by stamp. */
export function newestResult(root: string): string | undefined {
  const base = join(root, '.delivery');
  let best: { stamp: number; path: string } | undefined;
  let ids: string[];
  try {
    ids = readdirSync(base);
  } catch {
    return undefined;
  }
  for (const id of ids) {
    let stamps: string[];
    try {
      stamps = readdirSync(join(base, id));
    } catch {
      continue;
    }
    for (const stamp of stamps) {
      if (!/^\d+$/.test(stamp)) continue;
      const path = join(base, id, stamp, 'result.json');
      if (!existsSync(path)) continue;
      if (!best || Number(stamp) > best.stamp) best = { stamp: Number(stamp), path };
    }
  }
  return best?.path;
}

/** The cpm feature a plan-leased result was run for. */
export function featureFromResult(resultPath: string): string | undefined {
  const result = readJson(resultPath);
  const plan = isRecord(result) ? result.plan : undefined;
  if (!isRecord(plan) || typeof plan.deliverable !== 'string' || !plan.deliverable) return undefined;
  return normalizeFeature(plan.deliverable);
}

/** `d-1` and `cpm:d-1` mean the cpm member `cpm:cpm:d-1`; anything else is unchanged. */
export function normalizeFeature(feature: string): string {
  const separator = feature.indexOf(':');
  if (separator === -1) return `cpm:cpm:${feature}`;
  const dimension = feature.slice(0, separator);
  const member = feature.slice(separator + 1);
  if (dimension === 'cpm' && !member.startsWith('cpm:')) return `cpm:cpm:${member}`;
  return feature;
}

export { projectRoot };
