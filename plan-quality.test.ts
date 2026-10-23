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

test('blocking assumptions are flagged under their own trigger', async () => {
  const report = await scorePlanContracts([contract('c1', 'assumption')], classifierFor({ assumption: ASSUMPTION }));
  assert.equal(report.scores[0].trigger, 'blocking_assumptions');
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
  const classify = classifierFor({ unclear: UNCLEAR, assumption: ASSUMPTION });
  const contracts = [contract('c1', 'unclear'), contract('c2', 'assumption')];
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
