// ---------------------------------------------------------------------------
// Automatic matrix context for a handoff contract.
//
// A contract can name a `feature` (or a `plan.deliverable`). When the project
// has a `.crossmatrix/` store, `matrixContextFor` resolves the same hop/model
// defaults as the matrix CLI and asks `codemapContext` for the files that
// feature serves. Any failure is advisory: the run proceeds with no matrix
// entries and a note, because missing traceability must never block a handoff.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { codemapContext, type CodemapDeps } from './codemap.ts';
import {
  normalizeFeature,
  projectRoot,
  resolveMatrixHop,
  resolveMatrixModel,
} from './matrix-defaults.ts';

export interface MatrixContextEntry {
  path: string;
}

export interface MatrixContext {
  feature?: string;
  entries: MatrixContextEntry[];
  note?: string;
}

export interface MatrixContextOptions {
  deps?: CodemapDeps;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The contract feature, preferring an explicit `feature` over the plan's deliverable. */
export function contractFeature(t: any): string | undefined {
  if (typeof t?.feature === 'string' && t.feature.trim()) return t.feature.trim();
  if (typeof t?.plan?.deliverable === 'string' && t.plan.deliverable.trim()) return t.plan.deliverable.trim();
  return undefined;
}

/** Resolve the contract's matrix context without ever failing the run. */
export async function matrixContextFor(
  t: any,
  options: MatrixContextOptions = {},
): Promise<MatrixContext> {
  const feature = contractFeature(t);
  if (!feature) return { entries: [] };
  const root = projectRoot(String(t?.cwd ?? '.'));
  if (!existsSync(join(root, '.crossmatrix'))) {
    return { feature, entries: [], note: `no .crossmatrix store in ${root}` };
  }
  try {
    const hop = resolveMatrixHop(root, typeof t?.hopFrom === 'string' && t.hopFrom ? t.hopFrom : undefined);
    const model = resolveMatrixModel(root);
    const entries = await codemapContext({
      hopPath: hop.path,
      modelId: model.id,
      feature: normalizeFeature(feature),
      max: Number.isInteger(t?.matrixContextMax) && t.matrixContextMax > 0 ? t.matrixContextMax : 20,
      deps: options.deps,
    });
    return { feature, entries };
  } catch (err) {
    return { feature, entries: [], note: message(err) };
  }
}
