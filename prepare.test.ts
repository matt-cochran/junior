// ---------------------------------------------------------------------------
// Public behavioral tests for the `prepare` workflow and the prepare brief.
//
// Every scenario drives a public interface (prepare.ts exports, `run` from
// worker.ts, or the cpm-free contract builder) with fake classifiers and temp
// directories. No Jev, Pi or network call is made. Each test asserts exactly one
// observable outcome.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateBrief,
  renderBrief,
  scoreOptions,
  shouldCheckBack,
  buildImplementationContract,
  chooseBrief,
  loadPrepareHistory,
  prepareHistoryPath,
  briefPath,
  type Brief,
} from './prepare.ts';
import { run, validate } from './worker.ts';

// --- fixtures --------------------------------------------------------------

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-prepare-'));
}

function briefFixture(overrides: Partial<Brief> = {}): Brief {
  return {
    understanding: {
      scope: [{ id: 'U1', text: 'Ship the widget' }],
      outOfScope: [{ id: 'U2', text: 'No billing work' }],
      assumptions: [{ id: 'A1', text: 'The API is stable', status: 'guess' }],
      acceptanceProof: [{ acceptance: 'Check passes', proof: 'npm test' }],
    },
    options: [
      {
        id: 'A',
        title: 'Minimal change',
        approach: 'Patch the existing function',
        files: ['widget.ts'],
        effort: { optimistic: 1, likely: 2, pessimistic: 4 },
        risks: ['Regression risk'],
        tradeoffs: 'Fast but shallow',
      },
      {
        id: 'B',
        title: 'Rework the boundary',
        approach: 'Extract a widget module and route callers through it',
        files: ['widget.ts', 'widget-boundary.ts'],
        effort: { optimistic: 3, likely: 5, pessimistic: 9 },
        risks: ['Larger diff'],
        tradeoffs: 'Slower but cleaner',
      },
    ],
    recommendation: { option: 'B', why: 'Cleaner boundary' },
    ...overrides,
  };
}

function taskFixture(dir: string, extra: Record<string, unknown> = {}): any {
  return {
    id: 'prep',
    deliverable: 'Add a widget',
    cwd: dir,
    isolation: 'none',
    acceptance: ['Widget works'],
    checks: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
    externalContextConsent: true,
    ...extra,
  };
}

const bool = (p: number) => ({ type: 'bool', probability: p });
const JEVPASS = { requires_frontier: bool(0.05), contract_clear: bool(0.95), blocking_assumptions: bool(0.05) };
const routingClassifier = (traits: Record<string, number>): any => async () => ({
  stopReason: 'stop',
  provider: 'openrouter',
  model: 'typesafe/jev-1.13',
  answers: { ...JEVPASS, ...Object.fromEntries(Object.entries(traits).map(([k, v]) => [`trait_${k}`, bool(v)])) },
});

// --- worker wiring ---------------------------------------------------------

test('validate accepts workflow prepare', () => {
  assert.doesNotThrow(() => validate(taskFixture(workdir(), { workflow: 'prepare' })));
});

// --- brief validator -------------------------------------------------------

test('the brief validator rejects an assumption without a verified or guess status', () => {
  const brief: any = briefFixture();
  brief.understanding.assumptions[0].status = 'maybe';
  assert.throws(() => validateBrief(brief), /verified or guess/);
});

test('the brief validator accepts a well-formed brief', () => {
  assert.doesNotThrow(() => validateBrief(briefFixture()));
});

// --- renderBrief -----------------------------------------------------------

test('renderBrief lists the U items before the options section', () => {
  const markdown = renderBrief(briefFixture());
  assert.ok(markdown.indexOf('U1') < markdown.indexOf('Options'));
});

test('renderBrief lists the A items before the options section', () => {
  const markdown = renderBrief(briefFixture());
  assert.ok(markdown.indexOf('A1') < markdown.indexOf('Options'));
});

// --- scoreOptions ----------------------------------------------------------

test('scoreOptions attaches the ranked option scoring to the brief', async () => {
  const brief = briefFixture();
  const classify: any = async ({ questions }: any) => ({
    stopReason: 'stop',
    answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'choice', choice: 'full', confidence: 0.9 }])),
  });
  await scoreOptions(brief, classify);
  assert.ok(brief.scoring && Array.isArray(brief.scoring.ranking));
});

// --- shouldCheckBack -------------------------------------------------------

test('shouldCheckBack is false for a plain-change routing', () => {
  const plan: any = { playbooks: [{ id: 'plain-change', score: 1, explanation: '' }], traits: {}, tools: [], managerSetup: [], workerDirections: [] };
  assert.equal(shouldCheckBack(null, plan, []), false);
});

test('shouldCheckBack is false for a playbook with 0 corrections in 12 recorded briefs', () => {
  const plan: any = { playbooks: [{ id: 'decision-evaluate', score: 1, explanation: '' }], traits: {}, tools: [], managerSetup: [], workerDirections: [] };
  const history = Array.from({ length: 12 }, () => ({ playbooks: ['decision-evaluate'], corrected: false }));
  assert.equal(shouldCheckBack(null, plan, history), false);
});

test('shouldCheckBack is true for a decision-evaluate routing with no history', () => {
  const plan: any = { playbooks: [{ id: 'decision-evaluate', score: 1, explanation: '' }], traits: {}, tools: [], managerSetup: [], workerDirections: [] };
  assert.equal(shouldCheckBack(null, plan, []), true);
});

test('shouldCheckBack is true when Jev flags an unclear contract', () => {
  const attention: any = { decision: 'clarify', trigger: 'contract_clear' };
  assert.equal(shouldCheckBack(attention, null, []), true);
});

test('shouldCheckBack is true when Jev detects a blocking assumption', () => {
  const attention: any = { decision: 'clarify', trigger: 'blocking_assumptions' };
  assert.equal(shouldCheckBack(attention, null, []), true);
});

// --- check-back handoff (mock mode) ---------------------------------------

test('a handoff whose routing selects decision-evaluate returns needs_choice', async () => {
  const dir = workdir();
  const result = await run(taskFixture(dir, { jev: { mode: 'shadow' } }), true, { classify: routingClassifier({ decision_needed: 0.95 }) });
  assert.equal(result.status, 'needs_choice');
});

test('a needs_choice prepare handoff carries a brief', async () => {
  const dir = workdir();
  const result = await run(taskFixture(dir, { jev: { mode: 'shadow' } }), true, { classify: routingClassifier({ decision_needed: 0.95 }) });
  assert.ok(result.brief && Array.isArray(result.brief.understanding.scope));
});

test('a needs_choice prepare handoff writes brief.json to the artifact directory', async () => {
  const dir = workdir();
  const result = await run(taskFixture(dir, { jev: { mode: 'shadow' } }), true, { classify: routingClassifier({ decision_needed: 0.95 }) });
  assert.ok(existsSync(briefPath(result.artifactDir)));
});

test('a prepared contract does not check back again', async () => {
  const dir = workdir();
  const result = await run(taskFixture(dir, { jev: { mode: 'shadow' }, preparedFrom: 'prep' }), true, { classify: routingClassifier({ decision_needed: 0.95 }) });
  assert.notEqual(result.status, 'needs_choice');
});

// --- choose / build implementation contract --------------------------------

test("buildImplementationContract includes option B's approach in the deliverable", () => {
  const contract = buildImplementationContract(taskFixture(workdir()), briefFixture(), { option: 'B' });
  assert.match(contract.deliverable, /Extract a widget module/);
});

test('buildImplementationContract records the corrected assumption as a constraint', () => {
  const contract = buildImplementationContract(taskFixture(workdir()), briefFixture(), { option: 'B', corrections: { A2: 'The API is versioned' } });
  assert.ok(contract.constraints.some((c: string) => c.includes('The API is versioned')));
});

test("buildImplementationContract replaces the matching understanding item's text", () => {
  const contract = buildImplementationContract(taskFixture(workdir()), briefFixture(), { option: 'B', corrections: { U1: 'Ship the larger widget' } });
  assert.match(contract.deliverable + JSON.stringify(contract.constraints), /Ship the larger widget/);
});

// --- choose records history ------------------------------------------------

test('choosing records a history line with corrected true', () => {
  const dir = workdir();
  chooseBrief({ cwd: dir, task: taskFixture(dir), brief: briefFixture(), choice: { option: 'B', corrections: { A2: 'x' } } });
  assert.equal(loadPrepareHistory(dir)[0].corrected, true);
});

test('choosing without corrections records a history line with corrected false', () => {
  const dir = workdir();
  chooseBrief({ cwd: dir, task: taskFixture(dir), brief: briefFixture(), choice: { option: 'B' } });
  assert.equal(loadPrepareHistory(dir)[0].corrected, false);
});

test('choosing records the routed playbooks in the history line', () => {
  const dir = workdir();
  chooseBrief({ cwd: dir, task: taskFixture(dir), brief: briefFixture(), choice: { option: 'B' }, playbooks: ['decision-evaluate'] });
  assert.deepEqual(loadPrepareHistory(dir)[0].playbooks, ['decision-evaluate']);
});

test('the prepare history file is written under .delivery', () => {
  const dir = workdir();
  chooseBrief({ cwd: dir, task: taskFixture(dir), brief: briefFixture(), choice: { option: 'B' } });
  assert.ok(existsSync(prepareHistoryPath(dir)));
});

test('an explicitly chosen workflow is not replaced by the check-back', async () => {
  const dir = workdir();
  const result = await run(taskFixture(dir, { jev: { mode: 'shadow' }, workflow: 'test_first' }), true, { classify: routingClassifier({ decision_needed: 0.95 }) });
  assert.notEqual(result.status, 'needs_choice');
});

test('checkBack always forces the check-back for an explicit workflow', async () => {
  const dir = workdir();
  const result = await run(taskFixture(dir, { jev: { mode: 'shadow' }, workflow: 'test_first', checkBack: 'always' }), true, { classify: routingClassifier({ decision_needed: 0.95 }) });
  assert.equal(result.status, 'needs_choice');
});

test('checkBack off disables the check-back for an auto workflow', async () => {
  const dir = workdir();
  const result = await run(taskFixture(dir, { jev: { mode: 'shadow' }, checkBack: 'off' }), true, { classify: routingClassifier({ decision_needed: 0.95 }) });
  assert.notEqual(result.status, 'needs_choice');
});

test('validate rejects an unknown checkBack value', () => {
  assert.throws(() => validate({ id: 'x', deliverable: 'd', cwd: '/tmp', checkBack: 'sometimes' }));
});
