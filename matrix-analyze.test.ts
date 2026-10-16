// Behavioral tests for the generic categorical analysis engine
// (`junior matrix analyze`).
//
// Every scenario is offline. The Jev classifier is injected as a fake and the
// crossmatrix write path is either injected as a fake MCP-shaped callHop or run
// against the repo's fake MCP fixture, so no Jev, OpenRouter or network call is
// ever made. Each test asserts exactly one observable outcome through a public
// interface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHop } from './tools/tools.ts';
import { MAX_GATE_QUESTIONS, type GateClassifier, type GateQuestion } from './worker.ts';
import {
  analyze,
  cellQuestionId,
  renderMarkdown,
  resolveInput,
  type AnalysisInput,
} from './matrix-analyze.ts';

const NODE = process.execPath;
const JUNIOR = join(import.meta.dirname, 'junior.ts');
const FAKE = join(import.meta.dirname, 'tools', 'test-fixtures', 'fake-mcp.mjs');

/** A hop whose crossmatrix writes land in `log` through the fake MCP fixture. */
function writeHop(dir: string, log: string): string {
  const hop = join(dir, 'hop.json');
  initHop(hop, {
    managedStatePath: join(dir, 'no-managed-tools.json'),
    tools: {
      crossmatrix: {
        command: NODE,
        args: [FAKE],
        env: { FAKE_MCP_MODE: 'crossmatrix', FAKE_CROSSMATRIX_WRITES: log },
        sourceVersion: '0.3.0',
        sourceSha: '0'.repeat(64),
      },
    },
  });
  return hop;
}

interface FakeCall {
  questions: Record<string, GateQuestion>;
  state: Record<string, unknown>;
}

interface AnswerSpec {
  choice: string;
  confidence: number;
}

function fakeClassifier(answers: Record<string, AnswerSpec> = {}) {
  const calls: FakeCall[] = [];
  const classify: GateClassifier = async ({ state, questions }) => {
    calls.push({ questions, state });
    const out: Record<string, unknown> = {};
    for (const id of Object.keys(questions)) {
      const spec = answers[id];
      if (spec) out[id] = { type: 'choice', choice: spec.choice, confidence: spec.confidence };
    }
    return { answers: out };
  };
  return { classify, calls };
}

const HOP_STUB = {
  tools: { crossmatrix: { sourceVersion: '0.3.0' } },
  revision: 1,
  lockTimeoutMs: 1000,
} as any;

function fakeDeps(calls: any[]) {
  return {
    callHop: (async (hopPath: string, tool: string, request: any) => {
      calls.push(request?.arguments?.request ?? request);
      void hopPath;
      void tool;
      return { ok: true, result: { ok: true } };
    }) as any,
    loadHop: (() => HOP_STUB) as any,
  };
}

const INPUT: AnalysisInput = {
  items: [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: 'Gamma' },
  ],
  criteria: [
    {
      id: 'c1',
      question: 'Does c1 hold?',
      weight: 1,
      scale: [
        { id: 'low', label: 'Low', score: 0 },
        { id: 'high', label: 'High', score: 3 },
      ],
    },
    {
      id: 'c2',
      question: 'Does c2 hold?',
      weight: 2,
      scale: [
        { id: 'no', label: 'No', score: 0 },
        { id: 'yes', label: 'Yes', score: 3 },
      ],
    },
  ],
};

function highAnswers(): Record<string, AnswerSpec> {
  return {
    [cellQuestionId('a', 'c1')]: { choice: 'high', confidence: 0.9 },
    [cellQuestionId('a', 'c2')]: { choice: 'yes', confidence: 0.9 },
    [cellQuestionId('b', 'c1')]: { choice: 'low', confidence: 0.9 },
    [cellQuestionId('b', 'c2')]: { choice: 'yes', confidence: 0.9 },
    [cellQuestionId('c', 'c1')]: { choice: 'high', confidence: 0.9 },
    [cellQuestionId('c', 'c2')]: { choice: 'no', confidence: 0.9 },
  };
}

// --- presets ----------------------------------------------------------------

test('the house-of-quality preset supplies default criteria', () => {
  const resolved = resolveInput({ preset: 'house-of-quality', items: [{ id: 'a' }] });
  assert.equal(resolved.criteria.length > 0, true);
});

test('the decision-matrix preset supplies default criteria', () => {
  const resolved = resolveInput({ preset: 'decision-matrix', items: [{ id: 'a' }] });
  assert.equal(resolved.criteria.length > 0, true);
});

test('the traceability preset supplies default criteria', () => {
  const resolved = resolveInput({ preset: 'traceability', items: [{ id: 'a' }] });
  assert.equal(resolved.criteria.length > 0, true);
});

test('the risk-matrix preset supplies default criteria', () => {
  const resolved = resolveInput({ preset: 'risk-matrix', items: [{ id: 'a' }] });
  assert.equal(resolved.criteria.length > 0, true);
});

// --- scoring and ranking ----------------------------------------------------

test('three items scored on two criteria rank by weighted score', async () => {
  const { classify } = fakeClassifier(highAnswers());
  const result = await analyze({ input: INPUT, classify });
  assert.deepEqual(result.ranking.map((entry) => entry.itemId), ['a', 'b', 'c']);
});

test('an item weighted score sums score times weight over known cells', async () => {
  const { classify } = fakeClassifier(highAnswers());
  const result = await analyze({ input: INPUT, classify });
  assert.equal(result.ranking.find((entry) => entry.itemId === 'a')?.score, 9);
});

test('a choice answer maps to the matching scale option score', async () => {
  const { classify } = fakeClassifier(highAnswers());
  const result = await analyze({ input: INPUT, classify });
  const cell = result.cells.find((entry) => entry.itemId === 'a' && entry.criterionId === 'c1');
  assert.equal(cell?.score, 3);
});

test('ranking breaks a score tie by ascending item id', async () => {
  const input: AnalysisInput = {
    items: [{ id: 'y' }, { id: 'x' }],
    criteria: [
      {
        id: 'only',
        question: 'Only?',
        weight: 1,
        scale: [{ id: 'yes', label: 'Yes', score: 1 }],
      },
    ],
  };
  const { classify } = fakeClassifier({
    [cellQuestionId('x', 'only')]: { choice: 'yes', confidence: 0.9 },
    [cellQuestionId('y', 'only')]: { choice: 'yes', confidence: 0.9 },
  });
  const result = await analyze({ input, classify });
  assert.deepEqual(result.ranking.map((entry) => entry.itemId), ['x', 'y']);
});

// --- low confidence ---------------------------------------------------------

test('a cell below the confidence threshold is listed for review', async () => {
  const { classify } = fakeClassifier({ ...highAnswers(), [cellQuestionId('b', 'c1')]: { choice: 'high', confidence: 0.5 } });
  const result = await analyze({ input: INPUT, classify });
  assert.deepEqual(result.review.map((cell) => `${cell.itemId}/${cell.criterionId}`), ['b/c1']);
});

test('a cell below the confidence threshold is excluded from the ranking score', async () => {
  const { classify } = fakeClassifier({ ...highAnswers(), [cellQuestionId('b', 'c1')]: { choice: 'high', confidence: 0.5 } });
  const result = await analyze({ input: INPUT, classify });
  assert.equal(result.ranking.find((entry) => entry.itemId === 'b')?.score, 6);
});

test('an item with no confident positive cell is reported as an orphan', async () => {
  const { classify } = fakeClassifier({ ...highAnswers(), [cellQuestionId('c', 'c1')]: { choice: 'high', confidence: 0.5 } });
  const result = await analyze({ input: INPUT, classify });
  assert.deepEqual(result.orphans, ['c']);
});

// --- coverage ---------------------------------------------------------------

test('per-criterion coverage counts items with a confident cell', async () => {
  const { classify } = fakeClassifier({ ...highAnswers(), [cellQuestionId('c', 'c1')]: { choice: 'high', confidence: 0.5 } });
  const result = await analyze({ input: INPUT, classify });
  assert.equal(result.coverage.find((entry) => entry.criterionId === 'c1')?.coverage, 2 / 3);
});

// --- sensitivity ------------------------------------------------------------

const SENSITIVITY: AnalysisInput = {
  items: [{ id: 'a' }, { id: 'b' }],
  criteria: [
    {
      id: 'c1',
      question: 'C1?',
      weight: 1,
      scale: [{ id: 'zero', label: 'Zero', score: 0 }, { id: 'ten', label: 'Ten', score: 10 }],
    },
    {
      id: 'c2',
      question: 'C2?',
      weight: 2,
      scale: [{ id: 'zero', label: 'Zero', score: 0 }, { id: 'four', label: 'Four', score: 4 }],
    },
  ],
};

function sensitivityAnswers(): Record<string, AnswerSpec> {
  return {
    [cellQuestionId('a', 'c1')]: { choice: 'ten', confidence: 0.9 },
    [cellQuestionId('a', 'c2')]: { choice: 'zero', confidence: 0.9 },
    [cellQuestionId('b', 'c1')]: { choice: 'zero', confidence: 0.9 },
    [cellQuestionId('b', 'c2')]: { choice: 'four', confidence: 0.9 },
  };
}

test('sensitivity reports a criterion whose doubled weight flips the top item', async () => {
  const { classify } = fakeClassifier(sensitivityAnswers());
  const result = await analyze({ input: SENSITIVITY, classify });
  assert.equal(result.sensitivity.find((entry) => entry.criterionId === 'c2')?.doubleFlipsTop, true);
});

test('sensitivity reports no flip when halving a weight keeps the top item', async () => {
  const { classify } = fakeClassifier(sensitivityAnswers());
  const result = await analyze({ input: SENSITIVITY, classify });
  assert.equal(result.sensitivity.find((entry) => entry.criterionId === 'c2')?.halfFlipsTop, false);
});

// --- batching ---------------------------------------------------------------

test('batches never exceed MAX_GATE_QUESTIONS questions per classifier call', async () => {
  const items = Array.from({ length: 5 }, (_v, i) => ({ id: `i${i}` }));
  const criteria = Array.from({ length: 5 }, (_v, i) => ({
    id: `k${i}`,
    question: `K${i}?`,
    weight: 1,
    scale: [{ id: 'yes', label: 'Yes', score: 1 }],
  }));
  const answers: Record<string, AnswerSpec> = {};
  for (const item of items) for (const criterion of criteria) answers[cellQuestionId(item.id, criterion.id)] = { choice: 'yes', confidence: 0.9 };
  const { classify, calls } = fakeClassifier(answers);
  await analyze({ input: { items, criteria }, classify });
  assert.equal(calls.every((call) => Object.keys(call.questions).length <= MAX_GATE_QUESTIONS), true);
});

// --- dry run ----------------------------------------------------------------

test('dry-run makes no classifier call', async () => {
  const { classify, calls } = fakeClassifier(highAnswers());
  await analyze({ input: INPUT, classify, dryRun: true });
  assert.equal(calls.length, 0);
});

test('dry-run reports the planned question count', async () => {
  const result = await analyze({ input: INPUT, dryRun: true });
  assert.equal(result.plan?.questionCount, 6);
});

test('dry-run lists the planned Jev questions with their scale options', async () => {
  const result = await analyze({ input: INPUT, dryRun: true });
  assert.deepEqual(result.questions.find((entry) => entry.questionId === cellQuestionId('a', 'c1'))?.options, ['low', 'high']);
});

// --- record -----------------------------------------------------------------

test('without --record nothing is written to crossmatrix', async () => {
  const calls: any[] = [];
  const { classify } = fakeClassifier(highAnswers());
  await analyze({ input: INPUT, classify, deps: fakeDeps(calls) });
  assert.equal(calls.length, 0);
});

test('--record writes one proposed jev observation per mapped cell', async () => {
  const calls: any[] = [];
  const { classify } = fakeClassifier(highAnswers());
  await analyze({ input: INPUT, classify, record: true, hopPath: 'hop.json', modelId: 'm1', deps: fakeDeps(calls) });
  assert.equal(calls.filter((request) => request.op.kind === 'observe').length, 6);
});

test('--record marks scored observations with jev provenance', async () => {
  const calls: any[] = [];
  const { classify } = fakeClassifier(highAnswers());
  await analyze({ input: INPUT, classify, record: true, hopPath: 'hop.json', modelId: 'm1', deps: fakeDeps(calls) });
  assert.equal(calls.find((request) => request.op.kind === 'observe').op.provenanceClass, 'jev');
});

test('--record stores items and criteria as crossmatrix dimensions', async () => {
  const calls: any[] = [];
  const { classify } = fakeClassifier(highAnswers());
  await analyze({ input: INPUT, classify, record: true, hopPath: 'hop.json', modelId: 'm1', deps: fakeDeps(calls) });
  const registered = calls
    .filter((request) => request.op.kind === 'dimension.register')
    .map((request) => request.op.dimensionId)
    .sort();
  assert.deepEqual(registered, ['analysis-criteria', 'analysis-items']);
});

test('--record writes observations through the fake MCP fixture', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'junior-matrix-analyze-'));
  const log = join(dir, 'writes.jsonl');
  const hop = writeHop(dir, log);
  const { classify } = fakeClassifier(highAnswers());
  await analyze({ input: INPUT, classify, record: true, hopPath: hop, modelId: 'm1' });
  const observes = existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((request) => request.op.kind === 'observe')
    : [];
  assert.equal(observes.length, 6);
});

test('--record repeats content-addressed observation request ids', async () => {
  const first: any[] = [];
  const second: any[] = [];
  const { classify } = fakeClassifier(highAnswers());
  await analyze({ input: INPUT, classify, record: true, hopPath: 'hop.json', modelId: 'm1', deps: fakeDeps(first) });
  await analyze({ input: INPUT, classify, record: true, hopPath: 'hop.json', modelId: 'm1', deps: fakeDeps(second) });
  const ids = (calls: any[]) => calls.filter((request) => request.op.kind === 'observe').map((request) => request.requestId);
  assert.deepEqual(ids(second), ids(first));
});

// --- markdown ---------------------------------------------------------------

test('renderMarkdown includes the ranked table with item labels', async () => {
  const { classify } = fakeClassifier(highAnswers());
  const result = await analyze({ input: INPUT, classify });
  assert.equal(renderMarkdown(result).includes('Alpha'), true);
});

test('renderMarkdown lists low-confidence cells for review', async () => {
  const { classify } = fakeClassifier({ ...highAnswers(), [cellQuestionId('b', 'c1')]: { choice: 'high', confidence: 0.5 } });
  const result = await analyze({ input: INPUT, classify });
  assert.equal(renderMarkdown(result).includes('b/c1'), true);
});

// --- CLI --------------------------------------------------------------------

test('junior matrix analyze --dry-run prints the planned question count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'junior-matrix-analyze-'));
  const input = join(dir, 'analysis.json');
  writeFileSync(input, JSON.stringify(INPUT));
  const cli = spawnSync(NODE, [JUNIOR, 'matrix', 'analyze', '--input', input, '--dry-run'], { encoding: 'utf8' });
  assert.equal(JSON.parse(cli.stdout).plan.questionCount, 6);
});
