// Behavioral tests for plan-contract quality scoring.
//
// Every scenario is offline: an injected `GateClassifier` stands in for Jev.
// Each test is atomic (one behavioral assertion) and drives the public
// `scorePlanContracts` interface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIDENCE_THRESHOLD, MAX_GATE_QUESTIONS, type GateClassifier, type GateClassifierResult } from './worker.ts';
import { scorePlanContracts } from './plan-quality.ts';

const bool = (probability: number) => ({ type: 'bool', probability });

function contract(id: string, deliverable: string): { id: string; contract: any } {
  return {
    id,
    contract: {
      id,
      deliverable,
      acceptance: ['The observable outcome is correct'],
      constraints: ['Stay inside the checkout'],
      checks: [{ command: 'node', args: ['--test', 'example.test.ts'] }],
    },
  };
}

/** A classifier that picks answers by the contract deliverable, so one run can
 * exercise several statuses without relying on call order. */
function classifierFor(table: Record<string, Record<string, unknown>>): GateClassifier {
  return async ({ state }): Promise<GateClassifierResult> => {
    const answers = table[String(state.deliverable)];
    if (!answers) throw new Error(`no fake answers for ${String(state.deliverable)}`);
    return { answers, provider: 'fake', model: 'fake' };
  };
}

const CLEAR = {
  requires_frontier: bool(0.05),
  contract_clear: bool(0.95),
  blocking_assumptions: bool(0.05),
  contract_part: { type: 'choice', choice: 'acceptance', confidence: 0.9 },
};

const UNCLEAR = {
  requires_frontier: bool(0.05),
  contract_clear: bool(0.2),
  blocking_assumptions: bool(0.05),
  contract_part: { type: 'choice', choice: 'acceptance', confidence: 0.8 },
};

const ASSUMPTION = {
  requires_frontier: bool(0.05),
  contract_clear: bool(0.95),
  blocking_assumptions: bool(0.9),
  contract_part: { type: 'choice', choice: 'constraints', confidence: 0.85 },
};

test('a clear preflight produces a clear contract score', async () => {
  const report = await scorePlanContracts([contract('c1', 'clear')], classifierFor({ clear: CLEAR }));
  assert.equal(report.scores[0].status, 'clear');
});

test('an unclear contract is flagged under the contract_clear trigger', async () => {
  const report = await scorePlanContracts([contract('c1', 'unclear')], classifierFor({ unclear: UNCLEAR }));
  assert.equal(report.scores[0].trigger, 'contract_clear');
});

test('a flagged contract carries the least-clear contract part', async () => {
  const report = await scorePlanContracts([contract('c1', 'unclear')], classifierFor({ unclear: UNCLEAR }));
  assert.equal(report.scores[0].part?.name, 'acceptance');
});

test('a flagged contract carries at least one clarify question', async () => {
  const report = await scorePlanContracts([contract('c1', 'unclear')], classifierFor({ unclear: UNCLEAR }));
  assert.equal(report.scores[0].questions.length > 0, true);
});

test('a flagged contract carries the preflight reason', async () => {
  const report = await scorePlanContracts([contract('c1', 'unclear')], classifierFor({ unclear: UNCLEAR }));
  assert.match(String(report.scores[0].reason), /contract not judged clear/);
});

test('a blocking assumption alone is not flagged', async () => {
  const report = await scorePlanContracts([contract('c1', 'assumption')], classifierFor({ assumption: ASSUMPTION }));
  assert.equal(report.scores[0].status, 'clear');
});

test('a classifier outage yields unscored with the error as its reason', async () => {
  const outage: GateClassifier = async () => ({ stopReason: 'error', errorMessage: 'classifier outage' });
  const report = await scorePlanContracts([contract('c1', 'clear')], outage);
  assert.equal(report.scores[0].reason, 'classifier outage');
});

test('a classifier outage is unscored rather than clear', async () => {
  const outage: GateClassifier = async () => ({ stopReason: 'error', errorMessage: 'classifier outage' });
  const report = await scorePlanContracts([contract('c1', 'clear')], outage);
  assert.equal(report.scores[0].status, 'unscored');
});

test('reported scores keep the input contract order', async () => {
  const contracts = [contract('slow', 'slow'), contract('fast', 'fast')];
  const classify: GateClassifier = async ({ state }) => {
    if (state.deliverable === 'slow') await new Promise((resolve) => setTimeout(resolve, 30));
    return { answers: CLEAR };
  };
  const report = await scorePlanContracts(contracts, classify);
  assert.deepEqual(report.scores.map((score) => score.id), ['slow', 'fast']);
});

test('no classifier call exceeds the worker gate question limit', async () => {
  const sizes: number[] = [];
  const classify: GateClassifier = async ({ questions }) => {
    sizes.push(Object.keys(questions).length);
    return { answers: CLEAR };
  };
  await scorePlanContracts([contract('c1', 'clear')], classify);
  assert.equal(Math.max(...sizes) <= MAX_GATE_QUESTIONS, true);
});

test('concurrency limits the number of classifier calls in flight', async () => {
  let active = 0;
  let peak = 0;
  const classify: GateClassifier = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return { answers: CLEAR };
  };
  const contracts = Array.from({ length: 6 }, (_, i) => contract(`c${i}`, `d${i}`));
  await scorePlanContracts(contracts, classify, { concurrency: 2 });
  assert.equal(peak, 2);
});

test('the report threshold is the worker confidence threshold', async () => {
  const report = await scorePlanContracts([contract('c1', 'clear')], classifierFor({ clear: CLEAR }));
  assert.equal(report.threshold, CONFIDENCE_THRESHOLD);
});

test('the report counts flagged and unscored contracts', async () => {
  const classify = classifierFor({ unclear: UNCLEAR, frontier: FRONTIER, assumption: ASSUMPTION });
  const contracts = [contract('c1', 'unclear'), contract('c2', 'frontier'), contract('c3', 'assumption')];
  const report = await scorePlanContracts(contracts, classify);
  assert.equal(report.flagged, 2);
});

test('scorePlanContracts rejects a non-integer concurrency', async () => {
  await assert.rejects(
    scorePlanContracts([contract('c1', 'clear')], classifierFor({ clear: CLEAR }), { concurrency: 1.5 }),
    /integer/,
  );
});

test('scorePlanContracts rejects a concurrency below one', async () => {
  await assert.rejects(
    scorePlanContracts([contract('c1', 'clear')], classifierFor({ clear: CLEAR }), { concurrency: 0 }),
    /1\.\.16/,
  );
});

test('scorePlanContracts rejects a concurrency above sixteen', async () => {
  await assert.rejects(
    scorePlanContracts([contract('c1', 'clear')], classifierFor({ clear: CLEAR }), { concurrency: 17 }),
    /1\.\.16/,
  );
});

const FRONTIER = {
  requires_frontier: bool(0.95),
  contract_clear: bool(0.95),
  blocking_assumptions: bool(0.05),
  contract_part: { type: 'choice', choice: 'deliverable', confidence: 0.8 },
};

test('a frontier-required contract is flagged rather than reported clear', async () => {
  const report = await scorePlanContracts([contract('c1', 'frontier')], classifierFor({ frontier: FRONTIER }));
  assert.equal(report.scores[0].status, 'flagged');
});

test('a frontier-required contract carries the requires_frontier trigger', async () => {
  const report = await scorePlanContracts([contract('c1', 'frontier')], classifierFor({ frontier: FRONTIER }));
  assert.equal(report.scores[0].trigger, 'requires_frontier');
});

// --- P5 context resolution before scoring ----------------------------------

test('scorePlanContracts sends the resolved context excerpt to the classifier', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'junior-quality-'));
  writeFileSync(join(dir, 'a.ts'), 'excerpt-marker');
  let sent = '';
  const classify: GateClassifier = async ({ state }) => {
    sent = JSON.stringify(state);
    return { answers: CLEAR };
  };
  const entry = contract('c1', 'context');
  entry.contract.cwd = dir;
  entry.contract.context = [{ path: 'a.ts', start: 1, end: 1 }];
  await scorePlanContracts([entry], classify);
  assert.equal(sent.includes('excerpt-marker'), true);
});

// --- dependency-edge vetting (#122) ---------------------------------------

import { vetPlanEdges, vetPlanEdgesWithClassifier } from './plan-quality.ts';

function vetAgent(id: string, opts: any = {}): any {
  return {
    id,
    owned_files: opts.owned_files ?? [],
    prerequisites: opts.prerequisites ?? [],
    metadata: {
      artifact: opts.artifact ?? `produce ${id}`,
      owner: opts.owner ?? 'agent',
      ...(opts.metadata ?? {}),
      ...(opts.junior === undefined ? {} : { junior: opts.junior }),
    },
  };
}

function vetPlan(...deliverables: any[]): any {
  return { deliverables };
}

const namedEdge = (id: string, consumes: string, extra: any = {}) => ({ id, consumes, ...extra });

test('vetPlanEdges records supporting evidence for a named dependency edge', () => {
  const report = vetPlanEdges(vetPlan(
    vetAgent('a', { owned_files: ['schema.ts'] }),
    vetAgent('b', {
      owned_files: ['b.ts'],
      prerequisites: [namedEdge('a', 'schema')],
      junior: { acceptance: ['uses schema.ts from a'], checks: [{ command: 'true' }], context: [{ path: 'schema.ts' }] },
    }),
  ));
  assert.equal(report.findings[0].supporting.length > 0, true);
});

test('vetPlanEdges records counterfactual evidence for every reviewed edge', () => {
  const report = vetPlanEdges(vetPlan(
    vetAgent('a', { owned_files: ['schema.ts'] }),
    vetAgent('b', { owned_files: ['b.ts'], prerequisites: [namedEdge('a', 'schema')] }),
  ));
  assert.equal(report.findings.every((finding) => finding.counterfactual.length > 0), true);
});

test('vetPlanEdges refutes an edge that names nothing consumed', () => {
  const report = vetPlanEdges(vetPlan(
    vetAgent('a', { owned_files: ['a.ts'] }),
    vetAgent('b', { owned_files: ['b.ts'], prerequisites: ['a'] }),
  ));
  assert.equal(report.findings[0].verdict, 'refuted');
});

test('vetPlanEdges proposes removing a refuted edge instead of applying it', () => {
  const report = vetPlanEdges(vetPlan(
    vetAgent('a', { owned_files: ['a.ts'] }),
    vetAgent('b', { owned_files: ['b.ts'], prerequisites: ['a'] }),
  ));
  assert.deepEqual(report.findings[0].proposals, [{ op: 'remove_edge', from: 'a', to: 'b' }]);
});

test('vetPlanEdges reviews every prerequisite edge', () => {
  const report = vetPlanEdges(vetPlan(
    vetAgent('a', { owned_files: ['a.ts'] }),
    vetAgent('b', { owned_files: ['b.ts'], prerequisites: [namedEdge('a', 'schema')] }),
    vetAgent('c', { owned_files: ['c.ts'], prerequisites: [namedEdge('b', 'api')] }),
  ));
  assert.equal(report.findings.length, 2);
});

test('vetPlanEdges leaves the plan unchanged', () => {
  const value = vetPlan(
    vetAgent('a', { owned_files: ['a.ts'] }),
    vetAgent('b', { owned_files: ['b.ts'], prerequisites: ['a'] }),
  );
  vetPlanEdges(value);
  assert.deepEqual(value.deliverables[1].prerequisites, ['a']);
});

test('vetPlanEdgesWithClassifier records the positive and negative answers as evidence', async () => {
  const classify = async () => ({ positive: 0.9, negative: 0.1 });
  const report = await vetPlanEdgesWithClassifier(
    vetPlan(vetAgent('a', { owned_files: ['a.ts'] }), vetAgent('b', { owned_files: ['b.ts'], prerequisites: [namedEdge('a', 'schema')] })),
    classify,
  );
  assert.equal(report.findings[0].supporting.some((item) => item.kind === 'two-sided'), true);
});

test('vetPlanEdgesWithClassifier marks contradictory two-sided answers uncertain', async () => {
  const classify = async () => ({ positive: 0.9, negative: 0.9 });
  const report = await vetPlanEdgesWithClassifier(
    vetPlan(vetAgent('a', { owned_files: ['a.ts'] }), vetAgent('b', { owned_files: ['b.ts'], prerequisites: [namedEdge('a', 'schema')] })),
    classify,
  );
  assert.equal(report.findings[0].verdict, 'uncertain');
});

test('vetPlanEdges records supporting evidence for every reviewed edge', () => {
  const report = vetPlanEdges(vetPlan(
    vetAgent('a', { owned_files: ['a.ts'] }),
    vetAgent('b', { owned_files: ['b.ts'], prerequisites: ['a'] }),
  ));
  assert.equal(report.findings.every((finding) => finding.supporting.length > 0), true);
});
