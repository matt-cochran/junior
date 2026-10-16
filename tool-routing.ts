// ---------------------------------------------------------------------------
// Deterministic tool routing.
//
// `routeTools` is the second step after the single Jev readiness call: it maps
// the returned per-trait probabilities onto the declarative playbooks catalog
// (`selectPlaybooks` + `toolPlan` from playbooks.ts) and produces a small,
// explainable plan for the manager and the worker.
//
// It is pure and offline. Unknown trait names and out-of-range values are
// ignored rather than thrown, so a partial classifier answer still routes. A
// missing or failed classification is handled by the caller (`worker.ts`),
// which sets the plan to null rather than crashing.
// ---------------------------------------------------------------------------

import {
  TRAITS,
  loadPlaybooks,
  selectPlaybooks,
  toolPlan,
  type PlaybookCatalog,
  type Relevance,
  type ScoredPlaybook,
} from './playbooks.ts';

export interface RoutedPlaybook {
  id: string;
  score: number;
  explanation: string;
}

export interface RoutedTool {
  tool: string;
  application: string;
  relevance: Relevance;
}

export interface ToolRoute {
  /** The recognized trait probabilities actually routed on. */
  traits: Record<string, number>;
  playbooks: RoutedPlaybook[];
  tools: RoutedTool[];
  managerSetup: string[];
  /** One line per selected tool application, naming the command to run and what
   * it is for. `<hop>` is a placeholder for the contract's hop handoff path. */
  workerDirections: string[];
}

/** The fixed command for a tool application, with `<hop>` and `<modelId>` as
 * placeholders the worker substitutes from the contract. */
const APPLICATION_COMMANDS: Readonly<Record<string, string>> = {
  'crossmatrix:codemap-context': 'junior matrix codemap init --hop <hop> --model <modelId>',
  'crossmatrix:house-of-quality': 'junior matrix sync --source playbooks --hop <hop> --model <modelId>',
  'crossmatrix:multidimensional-matrix': 'junior matrix sync --source playbooks --hop <hop> --model <modelId>',
  'crossmatrix:test-coverage': 'junior matrix sync --source tests --hop <hop> --model <modelId>',
  'crossmatrix:stale-relink': 'junior matrix stale --hop <hop> --model <modelId>',
};

function commandFor(tool: string, application: string): string {
  return APPLICATION_COMMANDS[application] ?? `junior tools call <hop> ${tool} <request.json>`;
}

/** The first `produces` summary per application across the ranked playbooks. */
function purposesByApplication(selected: ScoredPlaybook[]): Map<string, string> {
  const purposes = new Map<string, string>();
  for (const playbook of selected) {
    for (const step of playbook.steps) {
      if (!purposes.has(step.application)) purposes.set(step.application, step.produces.join('; '));
    }
  }
  return purposes;
}

function workerDirections(selected: ScoredPlaybook[], tools: RoutedTool[]): string[] {
  const purposes = purposesByApplication(selected);
  return tools.map((entry) => {
    const purpose = purposes.get(entry.application);
    const command = commandFor(entry.tool, entry.application);
    return purpose ? `${command} — ${purpose}` : command;
  });
}

/** Keep only catalog traits with a finite probability in [0, 1]. */
function recognizedTraits(traitProbabilities: Record<string, number>): Record<string, number> {
  const traits: Record<string, number> = {};
  for (const trait of TRAITS) {
    const value = traitProbabilities[trait];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) traits[trait] = value;
  }
  return traits;
}

/** Route a trait-probability vector to a ranked, explainable tool plan. */
export function routeTools(
  traitProbabilities: Record<string, number>,
  catalog: PlaybookCatalog = loadPlaybooks(),
): ToolRoute {
  const traits = recognizedTraits(traitProbabilities ?? {});
  const selected = selectPlaybooks(traits, catalog);
  const plan = toolPlan(selected);
  const playbooks: RoutedPlaybook[] = selected.map((p) => ({ id: p.id, score: p.score, explanation: p.explanation }));
  const tools: RoutedTool[] = plan.tools.map((t) => ({ tool: t.tool, application: t.application, relevance: t.relevance }));
  return {
    traits,
    playbooks,
    tools,
    managerSetup: plan.managerSetup,
    workerDirections: workerDirections(selected, tools),
  };
}
