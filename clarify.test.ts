// ---------------------------------------------------------------------------
// Public behavioral tests for the clarification loop (`clarify.ts`).
//
// Every scenario is offline: the elicitation hop is an injected fake, the Jev
// readiness gate is a fake classifier, and each test asserts exactly one
// observable outcome through a public interface. No Jev, Pi or network call is
// made and no real tool binary is started.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLARIFY_FILENAME,
  clarificationApplies,
  clarifyPath,
  discoverEvidenceFromReport,
  questionBatch,
  resolveDiscoverReport,
  readLatestClarify,
  startClarification,
  applyAnswers,
} from './clarify.ts';
import { run } from './worker.ts';
import { initHop } from './tools/tools.ts';

const FAKE = join(import.meta.dirname, 'tools', 'test-fixtures', 'fake-mcp.mjs');

// --- fixtures --------------------------------------------------------------

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-clarify-'));
}

function taskFixture(dir: string, extra: Record<string, unknown> = {}): any {
  return {
    id: 'clar',
    deliverable: 'Add a widget',
    cwd: dir,
    isolation: 'none',
    acceptance: ['Widget works'],
    assumptions: ['The widget API is stable'],
    checks: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
    ...extra,
  };
}

const bool = (p: number) => ({ type: 'bool', probability: p });
const JEVPASS = { requires_frontier: bool(0.05), contract_clear: bool(0.95), blocking_assumptions: bool(0.05) };
const unclearClassifier: any = async ({ questions }: any) => {
  const answers: Record<string, unknown> = {};
  for (const id of Object.keys(questions)) {
    answers[id] = id === 'contract_clear' ? bool(0.2) : id === 'blocking_assumptions' ? bool(0.05) : id === 'requires_frontier' ? bool(0.05) : bool(0.9);
  }
  return { stopReason: 'stop', answers };
};

interface FakeOptions {
  signals?: Array<Record<string, unknown>>;
  claims?: Array<Record<string, unknown>>;
  topSignal?: Record<string, unknown>;
  ready?: boolean;
  blockers?: string[];
  spec?: unknown;
}

function fakeHop(options: FakeOptions = {}) {
  const calls: Array<{ tool: string; name: string; args: any }> = [];
  const signals = options.signals ?? [];
  const claims = options.claims ?? [];
  const callHop = async (_hop: string, tool: string, request: any) => {
    calls.push({ tool, name: request.tool, args: request.arguments });
    const ok = (result: unknown) => ({ ok: true, tool, toolName: request.tool, revision: 1, kind: 'command', isError: false, unsupported: false, note: null, result });
    if (request.tool === 'question.next') return ok({ question: options.topSignal ?? signals[0] ?? null });
    if (request.tool === 'state.get') return ok({ signals, claims });
    if (request.tool === 'readiness.assess') return ok({ ready: options.ready ?? false, blockers: options.blockers ?? [] });
    if (request.tool === 'spec.export') return ok({ spec: options.spec ?? { session_id: 'clarify:clar', ready: true, requirements: [] } });
    return ok({ ok: true });
  };
  return { callHop, calls };
}

/** The real `coverage_gap` signal captured from a live elicitation session. */
const COVERAGE_GAP: Record<string, unknown> = {
  claims: [],
  code: 'coverage_gap',
  dimension: 'acceptance',
  kind: 'clarify',
  message: "Coverage dimension 'acceptance' has no withstood hypothesis.",
  suggested_question: "The acceptance hypothesis isn't settled yet — can you confirm or refute it?",
};

/** A real `open_hypothesis` signal for one claim. */
function openHypothesis(claimId: string, dimension = 'acceptance'): Record<string, unknown> {
  return {
    claims: [claimId],
    code: 'open_hypothesis',
    dimension,
    kind: 'clarify',
    message: `Hypothesis '${claimId}' has no evidence yet; seek user assent or refutation.`,
    suggested_question: `Can you confirm: ${claimId}?`,
  };
}

/** A distinct real-shaped signal for cap/dedup/ranking scenarios. */
function coverageSignal(n: number): Record<string, unknown> {
  return {
    claims: [],
    code: 'coverage_gap',
    dimension: `dimension-${n}`,
    kind: 'clarify',
    message: `Coverage dimension ${n} is not settled.`,
    suggested_question: `Question ${n}?`,
  };
}

const REAL_CLAIMS: Array<Record<string, unknown>> = [
  { id: 'clarify:live-clarify/acceptance:0', subject: { id: 'clarify:live-clarify', label: 'Add a widget' }, object: { kind: 'value', value: 'Widget works' }, dimensions: ['acceptance'] },
  { id: 'clarify:live-clarify/acceptance:1', subject: { id: 'clarify:live-clarify', label: 'Add a widget' }, object: { kind: 'value', value: 'Widget is fast' }, dimensions: ['acceptance'] },
  { id: 'clarify:live-clarify/assumption:0', subject: { id: 'clarify:live-clarify', label: 'Add a widget' }, object: { kind: 'value', value: 'The API is stable' }, dimensions: ['assumptions'] },
];

const REAL_SIGNALS: Array<Record<string, unknown>> = [
  COVERAGE_GAP,
  openHypothesis('clarify:live-clarify/acceptance:0'),
  openHypothesis('clarify:live-clarify/acceptance:1'),
  openHypothesis('clarify:live-clarify/assumption:0', 'assumptions'),
];

function writeClarify(dir: string, batch: Record<string, unknown>): void {
  const artifactDir = join(dir, '.delivery', 'clar', '1');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, CLARIFY_FILENAME), JSON.stringify({ sessionId: 'clarify:clar', round: 1, playbooks: [], artifactDir, ...batch }));
}

const READY_SPEC = {
  session_id: 'clarify:clar',
  ready: true,
  requirements: [
    { id: 'r-widget', statement: 'add a widget', capability: 'widget', acceptance_criteria: ['widget works'], priority: 'must' },
  ],
  blockers: [],
};

// --- applicability ---------------------------------------------------------

test('clarificationApplies is true for an unclear contract', () => {
  assert.equal(clarificationApplies({ decision: 'clarify', trigger: 'contract_clear' }, null), true);
});

test('clarificationApplies is true for a blocking assumption', () => {
  assert.equal(clarificationApplies({ decision: 'clarify', trigger: 'blocking_assumptions' }, null), true);
});

test('clarificationApplies is true for a vague-feature routing', () => {
  assert.equal(clarificationApplies(null, { playbooks: [{ id: 'vague-feature' }] } as any), true);
});

test('clarificationApplies is false for a plain-change routing', () => {
  assert.equal(clarificationApplies(null, { playbooks: [{ id: 'plain-change' }] } as any), false);
});

test('clarificationApplies is false without a clarifying signal', () => {
  assert.equal(clarificationApplies({ decision: 'delegate', trigger: 'requires_frontier' }, null), false);
});

// --- startClarification ----------------------------------------------------

test('startClarification reports needs_answers', async () => {
  const { callHop } = fakeHop({ signals: [COVERAGE_GAP] });
  const batch = await startClarification(taskFixture(workdir()), { dir: workdir(), hopPath: 'hop.json', callHop: callHop as any });
  assert.equal(batch.outcome, 'needs_answers');
});

test('startClarification opens the session under clarify:<contract id>', async () => {
  const { callHop, calls } = fakeHop({ signals: [COVERAGE_GAP] });
  await startClarification(taskFixture(workdir()), { dir: workdir(), hopPath: 'hop.json', callHop: callHop as any });
  assert.equal(calls.find((c) => c.name === 'session.open')?.args.session_id, 'clarify:clar');
});

test('startClarification asks at most seven questions', async () => {
  const { callHop } = fakeHop({ signals: Array.from({ length: 10 }, (_v, i) => coverageSignal(i + 1)) });
  const batch = await startClarification(taskFixture(workdir()), { dir: workdir(), hopPath: 'hop.json', callHop: callHop as any });
  assert.equal(batch.questions.length, 7);
});

test('startClarification deduplicates a repeated question', async () => {
  const { callHop } = fakeHop({ signals: [coverageSignal(1), coverageSignal(1), coverageSignal(1)] });
  const batch = await startClarification(taskFixture(workdir()), { dir: workdir(), hopPath: 'hop.json', callHop: callHop as any });
  assert.equal(batch.questions.length, 1);
});

test('each clarification question carries a why signal', async () => {
  const { callHop } = fakeHop({ signals: [COVERAGE_GAP, openHypothesis('clarify:clar/acceptance:0')] });
  const batch = await startClarification(taskFixture(workdir()), { dir: workdir(), hopPath: 'hop.json', callHop: callHop as any });
  assert.ok(batch.questions.every((q) => typeof q.why === 'string' && q.why.length > 0));
});

test('each clarification question carries a suggestedAnswer or null', async () => {
  const { callHop } = fakeHop({ signals: [COVERAGE_GAP, openHypothesis('clarify:clar/acceptance:0')] });
  const batch = await startClarification(taskFixture(workdir()), { dir: workdir(), hopPath: 'hop.json', callHop: callHop as any });
  assert.ok(batch.questions.every((q) => q.suggestedAnswer === null || typeof q.suggestedAnswer === 'string'));
});

test('startClarification seeds one claim per acceptance criterion', async () => {
  const { callHop, calls } = fakeHop({});
  await startClarification(taskFixture(workdir()), { dir: workdir(), hopPath: 'hop.json', callHop: callHop as any });
  const acceptanceClaims = calls.filter((c) => c.name === 'append' && c.args?.claim?.category === 'requirement');
  assert.equal(acceptanceClaims.length, 1);
});

test('startClarification seeds one claim per stated assumption', async () => {
  const { callHop, calls } = fakeHop({});
  await startClarification(taskFixture(workdir()), { dir: workdir(), hopPath: 'hop.json', callHop: callHop as any });
  const assumptionClaims = calls.filter((c) => c.name === 'append' && c.args?.claim?.modality === 'assumption');
  assert.equal(assumptionClaims.length, 1);
});

test('startClarification seeds from the named job when the contract carries one', async () => {
  const { callHop, calls } = fakeHop({});
  const task = taskFixture(workdir(), { job: { id: 'j1', trigger: 't', motivation: 'm', outcome: 'o', desiredOutcomes: [] } });
  await startClarification(task, { dir: workdir(), hopPath: 'hop.json', callHop: callHop as any });
  assert.ok(calls.some((c) => c.name === 'append' && c.args?.claim?.id === 'job:j1/story'));
});

test('startClarification writes clarify.json to the artifact directory', async () => {
  const dir = workdir();
  const { callHop } = fakeHop({ signals: [COVERAGE_GAP] });
  await startClarification(taskFixture(dir), { dir, hopPath: 'hop.json', callHop: callHop as any });
  assert.equal(existsSync(clarifyPath(dir)), true);
});

test('startClarification writes a clarify.md with the ranked questions', async () => {
  const dir = workdir();
  const { callHop } = fakeHop({ signals: [COVERAGE_GAP, openHypothesis('clarify:clar/acceptance:0')] });
  await startClarification(taskFixture(dir), { dir, hopPath: 'hop.json', callHop: callHop as any });
  const markdown = readFileSync(join(dir, 'clarify.md'), 'utf8');
  assert.ok(markdown.includes('Q1') && markdown.includes('Q2'));
});

/** A hop whose elicitation tool is the fake MCP fixture serving real shapes. */
function elicitationHop(dir: string): string {
  const hop = join(dir, 'hop.json');
  initHop(hop, {
    managedStatePath: join(dir, 'no-managed-tools.json'),
    tools: {
      elicitation: { command: process.execPath, args: [FAKE], env: { FAKE_MCP_MODE: 'elicitation' }, sourceVersion: '1.0.0', sourceSha: '0'.repeat(64) },
    },
  });
  return hop;
}

/** The contract that seeds the two acceptance claims and one assumption the
 * captured real signals reference. */
function realTask(dir: string): any {
  return taskFixture(dir, { id: 'live-clarify', acceptance: ['Widget works', 'Widget is fast'], assumptions: ['The API is stable'] });
}

test('startClarification records the session through the fake MCP elicitation fixture', async () => {
  const dir = workdir();
  const hop = elicitationHop(dir);
  await startClarification(taskFixture(dir), { dir, hopPath: hop });
  const evidence = JSON.parse(readFileSync(hop, 'utf8')).evidence ?? [];
  assert.ok(evidence.some((entry: any) => entry.toolName === 'session.open'));
});

test('the real elicitation signals produce one coverage gap and three open hypotheses', async () => {
  const dir = workdir();
  const batch = await startClarification(realTask(dir), { dir, hopPath: elicitationHop(dir) });
  assert.deepEqual(batch.questions.map((q) => (q.why.includes('coverage_gap') ? 'gap' : 'hypothesis')), ['gap', 'hypothesis', 'hypothesis', 'hypothesis']);
});

test('the coverage gap question uses the signal suggested question', async () => {
  const dir = workdir();
  const batch = await startClarification(realTask(dir), { dir, hopPath: elicitationHop(dir) });
  assert.equal(batch.questions[0].question, COVERAGE_GAP.suggested_question);
});

test('an open hypothesis question names the claim value', async () => {
  const dir = workdir();
  const batch = await startClarification(realTask(dir), { dir, hopPath: elicitationHop(dir) });
  assert.ok(batch.questions[1].question.includes('Widget works'));
});

test("question.next's signal is ranked before the other signals", async () => {
  const top = coverageSignal(9);
  const other = coverageSignal(1);
  const { callHop } = fakeHop({ topSignal: top, signals: [other, top] });
  const batch = await startClarification(taskFixture(workdir()), { dir: workdir(), hopPath: 'hop.json', callHop: callHop as any });
  assert.equal(batch.questions[0].question, 'Question 9?');
});

// --- discover report evidence ---------------------------------------------

test('discoverEvidenceFromReport records a file:line excerpt as app_research evidence', () => {
  const evidence = discoverEvidenceFromReport('The widget API is stable (src/widget.ts:12).', ['claim-1']);
  assert.equal(evidence[0]?.evidence?.source_type, 'app_research_support');
});

test('resolveDiscoverReport finds the analysis report written for the contract', () => {
  const dir = workdir();
  const reportDir = join(dir, '.delivery', 'clar', '1');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'analysis-report.md'), 'The widget API is stable (src/widget.ts:12).');
  assert.equal(resolveDiscoverReport(taskFixture(dir), dir), join(reportDir, 'analysis-report.md'));
});

test('discoverEvidenceFromReport never invents evidence without an excerpt', () => {
  const evidence = discoverEvidenceFromReport('No code references here.', ['claim-1']);
  assert.equal(evidence.length, 0);
});

// --- applyAnswers ----------------------------------------------------------

async function answerOnce(dir: string, answers: Record<string, unknown>, options: FakeOptions, playbooks: string[] = []) {
  const { callHop, calls } = fakeHop(options);
  const batch = { sessionId: 'clarify:clar', round: 1, playbooks, artifactDir: join(dir, '.delivery', 'clar', '1'), questions: [{ id: 'Q1', question: 'Q?', why: 'signal', suggestedAnswer: null, claimIds: ['clarify:clar/acceptance:0'] }] };
  const outcome = await applyAnswers({ cwd: dir, task: taskFixture(dir), answers, batch: batch as any, deps: { hopPath: 'hop.json', callHop: callHop as any } });
  return { outcome, calls };
}

test('a refute answer appends user_refutation evidence', async () => {
  const { calls } = await answerOnce(workdir(), { Q1: { answer: 'Not stable', stance: 'refute' } }, { ready: false });
  const evidence = calls.find((c) => c.name === 'append' && c.args?.evidence)?.args.evidence;
  assert.equal(evidence?.source_type, 'user_refutation');
});

test('an assent answer appends user_assent evidence', async () => {
  const { calls } = await answerOnce(workdir(), { Q1: { answer: 'Stable', stance: 'assent' } }, { ready: false });
  const evidence = calls.find((c) => c.name === 'append' && c.args?.evidence)?.args.evidence;
  assert.equal(evidence?.source_type, 'user_assent');
});

test('an amend answer appends an amendment claim', async () => {
  const { calls } = await answerOnce(workdir(), { Q1: { answer: 'Use a versioned API', stance: 'amend' } }, { ready: false });
  const claim = calls.find((c) => c.name === 'append' && c.args?.claim)?.args.claim;
  assert.match(String(claim?.id), /amendment/);
});

test('a ready plan-sized session produces a draft plan', async () => {
  const dir = workdir();
  const { outcome } = await answerOnce(dir, { Q1: { answer: 'go', stance: 'assent' } }, { ready: true, spec: READY_SPEC }, ['planned-change']);
  assert.equal(outcome.outcome, 'plan_drafted');
});

test('a ready session with a non-plan routing produces a prepare brief', async () => {
  const dir = workdir();
  const { outcome } = await answerOnce(dir, { Q1: { answer: 'go', stance: 'assent' } }, { ready: true, spec: READY_SPEC }, ['decision-evaluate']);
  assert.equal(outcome.outcome, 'brief');
});

test('a ready session exports the spec through the hop', async () => {
  const { calls } = await answerOnce(workdir(), { Q1: { answer: 'go', stance: 'assent' } }, { ready: true, spec: READY_SPEC });
  assert.ok(calls.some((c) => c.name === 'spec.export'));
});

test('after three unready rounds the loop escalates with blockers', async () => {
  const dir = workdir();
  const { callHop } = fakeHop({ ready: false, blockers: ['missing owner'] });
  const batch: any = { sessionId: 'clarify:clar', round: 1, playbooks: [], artifactDir: join(dir, '.delivery', 'clar', '1'), questions: [{ id: 'Q1', question: 'Q?', why: 's', suggestedAnswer: null, claimIds: ['clarify:clar/acceptance:0'] }] };
  const options = { cwd: dir, task: taskFixture(dir), answers: { Q1: { answer: 'x', stance: 'assent' } }, deps: { hopPath: 'hop.json', callHop: callHop as any } };
  await applyAnswers({ ...options, batch });
  await applyAnswers({ ...options, batch: readLatestClarify(dir, 'clar')!.batch });
  const third = await applyAnswers({ ...options, batch: readLatestClarify(dir, 'clar')!.batch });
  assert.equal(third.outcome, 'escalated');
});

// --- worker wiring ---------------------------------------------------------

test('run returns needs_answers for an unclear contract', async () => {
  const dir = workdir();
  const { callHop } = fakeHop({ signals: [COVERAGE_GAP] });
  const result = await run(taskFixture(dir, { jev: { mode: 'shadow' } }), true, { classify: unclearClassifier, clarify: { hopPath: 'hop.json', callHop: callHop as any } });
  assert.equal(result.status, 'needs_answers');
});

test('the needs_answers result carries the question batch summary', async () => {
  const dir = workdir();
  const { callHop } = fakeHop({ signals: [COVERAGE_GAP] });
  const result = await run(taskFixture(dir, { jev: { mode: 'shadow' } }), true, { classify: unclearClassifier, clarify: { hopPath: 'hop.json', callHop: callHop as any } });
  assert.equal(result.clarification?.questions?.[0]?.id, 'Q1');
});

test('an explicit workflow is not replaced by the clarification loop', async () => {
  const dir = workdir();
  const { callHop } = fakeHop({ signals: [COVERAGE_GAP] });
  const result = await run(taskFixture(dir, { jev: { mode: 'shadow' }, workflow: 'test_first' }), true, { classify: unclearClassifier, clarify: { hopPath: 'hop.json', callHop: callHop as any } });
  assert.notEqual(result.status, 'needs_answers');
});

test('checkBack off disables the clarification loop for an auto workflow', async () => {
  const dir = workdir();
  const { callHop } = fakeHop({ signals: [COVERAGE_GAP] });
  const result = await run(taskFixture(dir, { jev: { mode: 'shadow' }, checkBack: 'off' }), true, { classify: unclearClassifier, clarify: { hopPath: 'hop.json', callHop: callHop as any } });
  assert.notEqual(result.status, 'needs_answers');
});
test('an assent to a question with no claim appends no evidence', async () => {
  const dir = workdir();
  const { callHop, calls } = fakeHop({ ready: false });
  const batch = { sessionId: 'clarify:clar', round: 1, playbooks: [], artifactDir: join(dir, '.delivery', 'clar', '1'), questions: [{ id: 'Q1', question: 'Q?', why: 'coverage gap', suggestedAnswer: null, claimIds: [], dimension: 'acceptance' }] };
  await applyAnswers({ cwd: dir, task: taskFixture(dir), answers: { Q1: { answer: 'yes', stance: 'assent' } }, batch: batch as any, deps: { hopPath: 'hop.json', callHop: callHop as any } });
  assert.equal(calls.filter((c) => c.name === 'append').length, 0);
});

test('an amendment to a coverage-gap question adds a claim in its dimension', async () => {
  const dir = workdir();
  const { callHop, calls } = fakeHop({ ready: false });
  const batch = { sessionId: 'clarify:clar', round: 1, playbooks: [], artifactDir: join(dir, '.delivery', 'clar', '1'), questions: [{ id: 'Q1', question: 'Q?', why: 'coverage gap', suggestedAnswer: null, claimIds: [], dimension: 'acceptance' }] };
  await applyAnswers({ cwd: dir, task: taskFixture(dir), answers: { Q1: { answer: 'Exports are JSON', stance: 'amend' } }, batch: batch as any, deps: { hopPath: 'hop.json', callHop: callHop as any } });
  assert.deepEqual(calls.find((c) => c.name === 'append')?.args?.claim?.dimensions, ['acceptance']);
});
