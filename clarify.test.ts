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
  clarityGateApplies,
  MAX_QUESTION_CONTEXT_CHARS,
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
const fixturesRoot = join(import.meta.dirname, 'tools', 'test-fixtures', 'companions');
function elicitFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesRoot, 'elicitation@0.1.0', `${name}.json`), 'utf8'));
}

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

/** A hop serving recorded elicitation results verbatim for `question.next`/`state.get`. */
function fixtureHop(question: unknown, state: unknown) {
  const callHop = async (_hop: string, tool: string, request: any) => {
    const ok = (result: unknown) => ({ ok: true, tool, toolName: request.tool, result });
    if (request.tool === 'question.next') return ok(question);
    if (request.tool === 'state.get') return ok(state);
    return ok({ ok: true });
  };
  return { callHop };
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

// --- clarityGateApplies ----------------------------------------------------

test('clarityGateApplies is true for an explicit workflow with an unclear contract', () => {
  assert.equal(clarityGateApplies({ attention: { decision: 'clarify', trigger: 'contract_clear' }, workflow: 'test_first' }), true);
});

test('clarityGateApplies is true for an explicit workflow with a blocking assumption', () => {
  assert.equal(clarityGateApplies({ attention: { decision: 'clarify', trigger: 'blocking_assumptions' }, workflow: 'test_first' }), true);
});

test('clarityGateApplies is false when check-back is off', () => {
  assert.equal(clarityGateApplies({ attention: { decision: 'clarify', trigger: 'contract_clear' }, workflow: 'auto', checkBack: 'off' }), false);
});

test('clarityGateApplies is false for a task prepared from a brief', () => {
  assert.equal(clarityGateApplies({ attention: { decision: 'clarify', trigger: 'contract_clear' }, workflow: 'auto', preparedFrom: 'brief.json' }), false);
});

test('clarityGateApplies is false for a task already clarified', () => {
  assert.equal(clarityGateApplies({ attention: { decision: 'clarify', trigger: 'contract_clear' }, workflow: 'test_first', clarifiedFrom: 'clarified-contract.json' }), false);
});

test('clarityGateApplies keeps the auto vague-feature routing', () => {
  assert.equal(clarityGateApplies({ attention: null, workflow: 'auto', playbooks: [{ id: 'vague-feature' }] }), true);
});

test('clarityGateApplies ignores the vague-feature routing for an explicit workflow', () => {
  assert.equal(clarityGateApplies({ attention: null, workflow: 'test_first', playbooks: [{ id: 'vague-feature' }] }), false);
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

// --- recorded elicitation fixtures ------------------------------------------

test('questionBatch ranks the signal from the elicitation question.next fixture first', async () => {
  const { callHop } = fixtureHop(elicitFixture('question.next'), elicitFixture('state.get'));
  const batch = await questionBatch('fixture-elicit-20261020b', { callHop: callHop as any });
  assert.match(batch.questions[0].why, /resolve_intra_spec_contradiction/);
});

test('questionBatch includes the clarify signal from the elicitation state.get fixture', async () => {
  const { callHop } = fixtureHop(elicitFixture('question.next'), elicitFixture('state.get'));
  const batch = await questionBatch('fixture-elicit-20261020b', { callHop: callHop as any });
  assert.ok(batch.questions.some((question) => question.why.includes('coverage_gap')));
});

test('questionBatch resolves an open hypothesis to the claim value from the elicitation state.get fixture', async () => {
  const top = { question: { claims: ['c1'], code: 'open_hypothesis', kind: 'clarify', message: 'open', suggested_question: 'Confirm?' } };
  const { callHop } = fixtureHop(top, elicitFixture('state.get'));
  const batch = await questionBatch('fixture-elicit-20261020b', { callHop: callHop as any });
  assert.equal(batch.questions[0].question, 'Confirm or refute: csv (context: export)');
});

test('questionBatch rejects an unrecognized elicitation state.get response', async () => {
  const { callHop } = fixtureHop({ question: null }, { unexpected: [] });
  await assert.rejects(
    () => questionBatch('fixture-elicit-20261020b', { callHop: callHop as any }),
    /Unrecognized elicitation\.state\.get response; top-level keys: unexpected/,
  );
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

async function answerExplicitWorkflow(workflow: string) {
  const dir = workdir();
  const { callHop } = fakeHop({ ready: true, spec: READY_SPEC });
  const batch = {
    sessionId: 'clarify:clar',
    round: 1,
    playbooks: ['planned-change'],
    artifactDir: join(dir, '.delivery', 'clar', '1'),
    questions: [{ id: 'Q1', question: 'Q?', why: 'signal', suggestedAnswer: null, claimIds: ['clarify:clar/acceptance:0'] }],
  };
  const outcome = await applyAnswers({
    cwd: dir,
    task: taskFixture(dir, { workflow, constraints: ['Existing limit'] }),
    answers: { Q1: { answer: 'go', stance: 'assent' } },
    batch: batch as any,
    deps: { hopPath: 'hop.json', callHop: callHop as any },
  });
  return { outcome, dir, batch };
}

test('a ready explicit-workflow session returns a clarified contract', async () => {
  const { outcome } = await answerExplicitWorkflow('test_first');
  assert.equal(outcome.outcome, 'contract');
});

test('the clarified contract preserves the explicit workflow', async () => {
  const { outcome } = await answerExplicitWorkflow('test_first');
  assert.equal((outcome as any).contract.workflow, 'test_first');
});

test('the clarified contract records each answer as a constraint', async () => {
  const { outcome } = await answerExplicitWorkflow('test_first');
  assert.deepEqual((outcome as any).contract.constraints, ['Existing limit', 'Clarified Q1: Q? -> assent: go']);
});

test('the clarified contract points at the batch clarify.json', async () => {
  const { outcome, batch } = await answerExplicitWorkflow('test_first');
  assert.equal((outcome as any).contract.clarifiedFrom, clarifyPath(batch.artifactDir));
});

test('the clarified contract is written to clarified-contract.json', async () => {
  const { outcome } = await answerExplicitWorkflow('test_first');
  assert.deepEqual(JSON.parse(readFileSync((outcome as any).contractPath, 'utf8')), (outcome as any).contract);
});

test('an auto-workflow plan-sized session still produces a draft plan', async () => {
  const { outcome } = await answerOnce(workdir(), { Q1: { answer: 'go', stance: 'assent' } }, { ready: true, spec: READY_SPEC }, ['planned-change']);
  assert.equal(outcome.outcome, 'plan_drafted');
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

test('an explicit-workflow contract judged unclear stops at needs_answers (ADR 0009)', async () => {
  const dir = workdir();
  const { callHop } = fakeHop({ signals: [COVERAGE_GAP] });
  const result = await run(taskFixture(dir, { jev: { mode: 'shadow' }, workflow: 'test_first' }), true, { classify: unclearClassifier, clarify: { hopPath: 'hop.json', callHop: callHop as any } });
  assert.equal(result.status, 'needs_answers');
});

test('checkBack off disables the clarification gate for an explicit workflow', async () => {
  const dir = workdir();
  const { callHop } = fakeHop({ signals: [COVERAGE_GAP] });
  const result = await run(taskFixture(dir, { jev: { mode: 'shadow' }, workflow: 'test_first', checkBack: 'off' }), true, { classify: unclearClassifier, clarify: { hopPath: 'hop.json', callHop: callHop as any } });
  assert.notEqual(result.status, 'needs_answers');
});

test('a clarified explicit-workflow contract does not re-enter the gate', async () => {
  const dir = workdir();
  const { callHop } = fakeHop({ signals: [COVERAGE_GAP] });
  const result = await run(taskFixture(dir, { jev: { mode: 'shadow' }, workflow: 'test_first', clarifiedFrom: join(dir, 'clarify.json') }), true, { classify: unclearClassifier, clarify: { hopPath: 'hop.json', callHop: callHop as any } });
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

test('a multi-round clarified contract keeps answers from every round', async () => {
  const dir = workdir();
  const artifactDir = join(dir, '.delivery', 'clar', '1');
  const task = taskFixture(dir, { workflow: 'test_first', constraints: ['Existing limit'] });
  const question = (id: string, text: string) => ({ id, question: text, why: 'signal', suggestedAnswer: null, claimIds: ['clarify:clar/acceptance:0'] });
  const unready = fakeHop({ ready: false });
  await applyAnswers({
    cwd: dir, task,
    answers: { Q1: { answer: 'first', stance: 'amend' } },
    batch: { sessionId: 'clarify:clar', round: 1, playbooks: [], artifactDir, questions: [question('Q1', 'Round one?')] } as any,
    deps: { hopPath: 'hop.json', callHop: unready.callHop as any, maxRounds: 1 },
  });
  const ready = fakeHop({ ready: true, spec: READY_SPEC });
  const outcome = await applyAnswers({
    cwd: dir, task,
    answers: { Q1: { answer: 'second', stance: 'assent' } },
    batch: { sessionId: 'clarify:clar', round: 2, playbooks: [], artifactDir, questions: [question('Q1', 'Round two?')] } as any,
    deps: { hopPath: 'hop.json', callHop: ready.callHop as any },
  });
  assert.deepEqual((outcome as any).contract.constraints, ['Existing limit', 'Clarified Q1: Round one? -> amend: first', 'Clarified Q1: Round two? -> assent: second']);
});

test('an open-hypothesis question quotes a long claim label as a bounded excerpt', async () => {
  const top = { question: { claims: ['c1'], code: 'open_hypothesis', kind: 'clarify', message: 'open', suggested_question: 'Confirm?' } };
  const state: any = structuredClone(elicitFixture('state.get'));
  const long = `Document the release. ${'Every field and flag must be described precisely. '.repeat(20)}`;
  const visit = (node: any): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node && typeof node === 'object') {
      if (node.id === 'c1' && node.subject && typeof node.subject === 'object') node.subject.label = long;
      Object.values(node).forEach(visit);
    }
  };
  visit(state);
  const { callHop } = fixtureHop(top, state);
  const batch = await questionBatch('fixture-elicit-20261020b', { callHop: callHop as any });
  assert.ok(batch.questions[0].question.length <= 'Confirm or refute: csv (context: )'.length + MAX_QUESTION_CONTEXT_CHARS);
});
