// ---------------------------------------------------------------------------
// `junior matrix refresh`: one idempotent pass that keeps the feature-to-code
// map current.
//
// The pass composes the existing write-side commands in dependency order:
// sync the default dimensions, propose links offline, confirm the high-
// confidence proposals, autolink completed plan deliverables, then report what
// went stale. Every step is content-addressed, so running the pass twice with
// an unchanged project replays the same request ids.
//
// Steps are independent enough to keep going after a failure: each failure is
// recorded in `notes` and the remaining steps still run. The only hard
// dependency is autolink, which is skipped with a note when no single plan is
// resolved.
// ---------------------------------------------------------------------------

import path from 'node:path';
import { autolink, bootstrap, confirmProposals, type AutopilotDeps } from './matrix-autopilot.ts';
import { codemapStale, type CodemapStaleResult } from './codemap.ts';
import type { MatrixDimension } from './matrix-adapters.ts';
import { syncDimensions, type SyncDimensionsResult } from './matrix-sync.ts';
import {
  defaultSources,
  resolveMatrixHop,
  resolveMatrixModel,
  resolveMatrixPlan,
  type DefaultSource,
  type PlanResolution,
} from './matrix-defaults.ts';
import { callHop, loadHop } from './tools/tools.ts';

type StepDeps = {
  callHop?: typeof callHop;
  loadHop?: typeof loadHop;
  files?: AutopilotDeps['files'];
  planGraph?: unknown;
};

export interface RefreshDeps extends StepDeps {
  resolveMatrixHop?: typeof resolveMatrixHop;
  resolveMatrixModel?: typeof resolveMatrixModel;
  resolveMatrixPlan?: typeof resolveMatrixPlan;
  defaultSources?: typeof defaultSources;
  dimensionsForSource?: (source: string, options: SourceDimensionOptions) => Promise<MatrixDimension[]>;
  syncDimensions?: typeof syncDimensions;
  bootstrap?: typeof bootstrap;
  confirmProposals?: typeof confirmProposals;
  autolink?: typeof autolink;
  codemapStale?: typeof codemapStale;
  /** Aliases kept small and explicit so callers can inject a single step. */
  resolveHop?: typeof resolveMatrixHop;
  resolveModel?: typeof resolveMatrixModel;
  resolvePlan?: typeof resolveMatrixPlan;
  sync?: typeof syncDimensions;
  confirm?: typeof confirmProposals;
  link?: typeof autolink;
  stale?: typeof codemapStale;
}

export interface SourceDimensionOptions {
  dir: string;
  hop?: string;
  plan?: string;
  planFile?: string;
  session?: string;
}

export interface RefreshOptions {
  dir?: string;
  hop?: string;
  hopPath?: string;
  model?: string;
  modelId?: string;
  plan?: string;
  planId?: string;
  planFile?: string;
  sources?: string[];
  deps?: RefreshDeps;
}

export interface RefreshResult {
  synced: SyncDimensionsResult['synced'];
  confirmed: string[];
  autolinked: string[];
  stale: { changed: number; affectedCells: number };
  notes: string[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { path?: unknown }).path === 'string') {
    return (value as { path: string }).path;
  }
  return undefined;
}

function sourceOf(value: unknown): DefaultSource | undefined {
  if (value && typeof value === 'object' && typeof (value as { source?: unknown }).source === 'string') {
    return (value as { source: DefaultSource }).source;
  }
  return undefined;
}

function modelOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const entry = value as { id?: unknown; modelId?: unknown };
    if (typeof entry.id === 'string') return entry.id;
    if (typeof entry.modelId === 'string') return entry.modelId;
  }
  return undefined;
}

function planOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { planId?: unknown }).planId === 'string') {
    return (value as { planId: string }).planId;
  }
  return undefined;
}

function candidatesOf(value: unknown): string[] | undefined {
  if (value && typeof value === 'object' && Array.isArray((value as PlanResolution).candidates)) {
    return (value as PlanResolution).candidates;
  }
  return undefined;
}

/**
 * Keep the feature-to-code map current in one idempotent pass. Defaults are
 * resolved from the project exactly as the other `matrix` subcommands do;
 * `deps` lets tests inject each step and pass their shared fake transport.
 */
export async function refresh(options: RefreshOptions = {}): Promise<RefreshResult> {
  const deps = options.deps ?? {};
  const root = path.resolve(options.dir ?? process.cwd());
  const notes: string[] = [];
  const stepDeps: StepDeps = {
    ...(deps.callHop === undefined ? {} : { callHop: deps.callHop }),
    ...(deps.loadHop === undefined ? {} : { loadHop: deps.loadHop }),
    ...(deps.files === undefined ? {} : { files: deps.files }),
    ...(deps.planGraph === undefined ? {} : { planGraph: deps.planGraph }),
  };

  const resolveHop = deps.resolveMatrixHop ?? deps.resolveHop ?? resolveMatrixHop;
  const resolveModel = deps.resolveMatrixModel ?? deps.resolveModel ?? resolveMatrixModel;
  const resolvePlan = deps.resolveMatrixPlan ?? deps.resolvePlan ?? resolveMatrixPlan;
  const sourceList = deps.defaultSources ?? defaultSources;

  const hopResolution = resolveHop(root, options.hop ?? options.hopPath);
  const hopPath = pathOf(hopResolution) ?? options.hop ?? options.hopPath ?? path.join(root, '.delivery', 'setup', 'hop.json');
  if (sourceOf(hopResolution) && sourceOf(hopResolution) !== 'explicit') {
    notes.push(`hop ${hopPath} (${sourceOf(hopResolution)})`);
  }

  const modelResolution = resolveModel(root, options.model ?? options.modelId);
  const modelId = modelOf(modelResolution) ?? options.model ?? options.modelId ?? 'project';
  if (sourceOf(modelResolution) && sourceOf(modelResolution) !== 'explicit') {
    notes.push(`model ${modelId} (${sourceOf(modelResolution)})`);
  }

  const explicitPlan = options.plan ?? options.planId;
  let plan = explicitPlan;
  let planCandidates: string[] | undefined;
  if (!plan) {
    try {
      const resolved = await resolvePlan(root, hopPath, undefined, deps.callHop ?? callHop);
      plan = planOf(resolved);
      planCandidates = candidatesOf(resolved);
      if (plan && sourceOf(resolved) && sourceOf(resolved) !== 'explicit') {
        notes.push(`plan ${plan} (${sourceOf(resolved)})`);
      }
    } catch (error) {
      notes.push(`plan not resolved: ${message(error)}`);
    }
  }

  const sources = options.sources && options.sources.length > 0 ? options.sources : sourceList(root, plan !== undefined);
  const customSync = deps.syncDimensions ?? deps.sync;
  const customDimensions = deps.dimensionsForSource;
  let synced: SyncDimensionsResult['synced'] = [];

  if (!customSync || customDimensions) {
    const dimensions: MatrixDimension[] = [];
    for (const source of sources) {
      try {
        const build = customDimensions
          ?? (async (name: string, sourceOptions: SourceDimensionOptions) =>
            (await import('./matrix-cli.ts')).dimensionsForSource(sourceOptions as any, name));
        dimensions.push(...(await build(source, {
          dir: root,
          hop: hopPath,
          plan,
          planFile: options.planFile,
        })));
      } catch (error) {
        notes.push(`sync ${source} failed: ${message(error)}`);
      }
    }
    try {
      const result = await (customSync ?? syncDimensions)({ hopPath, modelId, dimensions, deps: stepDeps });
      synced = result.synced;
    } catch (error) {
      notes.push(`sync failed: ${message(error)}`);
    }
  } else {
    try {
      const result = await customSync({ hopPath, modelId, dimensions: [], deps: stepDeps });
      synced = result.synced;
    } catch (error) {
      notes.push(`sync failed: ${message(error)}`);
    }
  }

  const proposalsPath = path.join(root, '.delivery', 'matrix', 'proposals.json');
  try {
    await (deps.bootstrap ?? bootstrap)({
      hopPath,
      modelId,
      dir: root,
      out: proposalsPath,
      deps: stepDeps,
    });
  } catch (error) {
    notes.push(`bootstrap failed: ${message(error)}`);
  }

  let confirmed: string[] = [];
  try {
    const result = await (deps.confirmProposals ?? deps.confirm ?? confirmProposals)({
      hopPath,
      modelId,
      proposalsPath,
      min: 'high',
      deps: stepDeps,
    });
    confirmed = result.requestIds;
  } catch (error) {
    notes.push(`confirm failed: ${message(error)}`);
  }

  let autolinked: string[] = [];
  if (!plan) {
    const suffix = planCandidates && planCandidates.length > 0
      ? `several unfinished plans (${planCandidates.join(', ')}); pass --plan <plan_id>`
      : 'no single plan resolved; pass --plan <plan_id>';
    notes.push(`autolink skipped: ${suffix}`);
  } else {
    try {
      const result = await (deps.autolink ?? deps.link ?? autolink)({
        hopPath,
        modelId,
        planId: plan,
        dir: root,
        deps: stepDeps,
      });
      autolinked = result.requestIds;
    } catch (error) {
      notes.push(`autolink failed: ${message(error)}`);
    }
  }

  let stale: CodemapStaleResult = { changed: [], affectedCells: [] };
  try {
    stale = await (deps.codemapStale ?? deps.stale ?? codemapStale)({
      hopPath,
      modelId,
      dir: root,
      deps: stepDeps,
    });
  } catch (error) {
    notes.push(`stale failed: ${message(error)}`);
  }

  return {
    synced,
    confirmed,
    autolinked,
    stale: {
      changed: Array.isArray(stale.changed) ? stale.changed.length : 0,
      affectedCells: Array.isArray(stale.affectedCells) ? stale.affectedCells.length : 0,
    },
    notes,
  };
}
