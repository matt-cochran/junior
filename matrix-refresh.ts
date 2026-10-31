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
  projectRoot,
  resolveMatrixHop,
  resolveMatrixModel,
  resolveMatrixPlan,
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
  model?: string;
  plan?: string;
  planFile?: string;
  sources?: string[];
  deps?: RefreshDeps;
}

export interface RefreshResult {
  synced: SyncDimensionsResult['synced'];
  confirmed: string[];
  autolinked: string[];
  stale: {
    changed: number;
    moved: number;
    deleted: number;
    entityChanged: number;
    unanchored: number;
    affectedCells: number;
  };
  notes: string[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keep the feature-to-code map current in one idempotent pass. Defaults are
 * resolved from the project exactly as the other `matrix` subcommands do;
 * `deps` lets tests inject each step and pass their shared fake transport.
 */
export async function refresh(options: RefreshOptions = {}): Promise<RefreshResult> {
  const deps = options.deps ?? {};
  const root = projectRoot(options.dir ?? process.cwd());
  const notes: string[] = [];
  const stepDeps: StepDeps = {
    ...(deps.callHop === undefined ? {} : { callHop: deps.callHop }),
    ...(deps.loadHop === undefined ? {} : { loadHop: deps.loadHop }),
    ...(deps.files === undefined ? {} : { files: deps.files }),
    ...(deps.planGraph === undefined ? {} : { planGraph: deps.planGraph }),
  };

  const hop = (deps.resolveMatrixHop ?? resolveMatrixHop)(root, options.hop);
  const hopPath = hop.path;
  if (hop.source !== 'explicit') notes.push(`hop ${hopPath} (${hop.source})`);
  const model = (deps.resolveMatrixModel ?? resolveMatrixModel)(root, options.model);
  const modelId = model.id;
  if (model.source !== 'explicit') notes.push(`model ${modelId} (${model.source})`);

  let plan = options.plan;
  let planCandidates: string[] | undefined;
  if (!plan && options.planFile === undefined) {
    try {
      const resolved = await (deps.resolveMatrixPlan ?? resolveMatrixPlan)(root, hopPath, undefined, deps.callHop ?? callHop);
      plan = resolved.planId;
      planCandidates = resolved.candidates;
      if (plan) notes.push(`plan ${plan} (${resolved.source})`);
    } catch (error) {
      notes.push(`plan not resolved: ${message(error)}`);
    }
  }

  const sources = options.sources && options.sources.length > 0
    ? options.sources
    : (deps.defaultSources ?? defaultSources)(root, plan !== undefined || options.planFile !== undefined);
  const build = deps.dimensionsForSource
    ?? (async (name: string, sourceOptions: SourceDimensionOptions) =>
      (await import('./matrix-cli.ts')).dimensionsForSource({ sources: [], ...sourceOptions }, name));
  const dimensions: MatrixDimension[] = [];
  for (const source of sources) {
    try {
      dimensions.push(...(await build(source, { dir: root, hop: hopPath, plan, planFile: options.planFile })));
    } catch (error) {
      notes.push(`sync ${source} failed: ${message(error)}`);
    }
  }
  let synced: SyncDimensionsResult['synced'] = [];
  try {
    synced = (await (deps.syncDimensions ?? syncDimensions)({ hopPath, modelId, dimensions, deps: stepDeps })).synced;
  } catch (error) {
    notes.push(`sync failed: ${message(error)}`);
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
    const result = await (deps.confirmProposals ?? confirmProposals)({
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
      const result = await (deps.autolink ?? autolink)({
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

  let stale: CodemapStaleResult = {
    changed: [],
    moved: [],
    deleted: [],
    entityChanged: [],
    unanchored: [],
    affectedCells: [],
  };
  try {
    stale = await (deps.codemapStale ?? codemapStale)({
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
      moved: Array.isArray(stale.moved) ? stale.moved.length : 0,
      deleted: Array.isArray(stale.deleted) ? stale.deleted.length : 0,
      entityChanged: Array.isArray(stale.entityChanged) ? stale.entityChanged.length : 0,
      unanchored: Array.isArray(stale.unanchored) ? stale.unanchored.length : 0,
      affectedCells: Array.isArray(stale.affectedCells) ? stale.affectedCells.length : 0,
    },
    notes,
  };
}
