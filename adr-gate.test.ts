// Behavioral tests for the ADR conformance gate (ADR 0018 R3-R5, R7, R8).
//
// Every scenario is offline: a temporary project supplies the ADR files and
// ledger, and the Jev classifier is a fake that returns fixed answers. Each
// test drives one public outcome and makes exactly one behavioral assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAdrs, type Adr } from './adr.ts';
import type { AdrConfig } from './adr-config.ts';
import { adrContentHash, appendDecision, readLedger, type AdrDecisionInput } from './adr-ledger.ts';
import type { GateClassifier, GateQuestion } from './worker.ts';
import {
  confirmCarried,
  recordGateDecision,
  renderGateMarkdown,
  runAdrGate,
  type GateSubject,
} from './adr-gate.ts';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function project(t: any): string {
  const root = mkdtempSync(join(tmpdir(), 'junior-adr-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function madr(options: {
  id: string;
  status?: string;
  applies_to?: string;
  rules?: string;
  decision?: string;
}): string {
  return [
    '---',
    `id: ${options.id}`,
    `title: Decision ${options.id}`,
    `status: ${options.status ?? 'accepted'}`,
    'date: 2026-01-01',
    'supersedes: []',
    `applies_to: ${options.applies_to ?? "['src/**']"}`,
    `rules:${options.rules ?? '\n  - id: R1\n    text: Keep the source tree honest.'}`,
    '---',
    '',
    '## Context',
    '',
    'Context.',
    '',
    '## Decision',
    '',
    options.decision ?? 'Decision.',
    '',
    '## Consequences',
    '',
    'Consequences.',
    '',
  ].join('\n');
}

function seed(t: any): {root: string; adrs: Adr[]; config: AdrConfig} {
  const root = project(t);
  const dir = join(root, 'docs', 'adr');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, '0001-src.md'), madr({id: 'ADR-0001', applies_to: "['src/**']"}));
  writeFileSync(join(dir, '0002-docs.md'), madr({id: 'ADR-0002', applies_to: "['docs/**']"}));
  const config: AdrConfig = {dir: 'docs/adr', format: 'junior', gate: 'enforce'};
  return {root, adrs: loadAdrs(dir), config};
}

type Answer = {choice: string; confidence: number};

function fakeClassifier(byItem: Record<string, Answer> = {}, fallback: Answer = {choice: 'conforms', confidence: 0.95}) {
  const calls: GateQuestion[][] = [];
  const classify: GateClassifier = async ({state, questions}) => {
    calls.push(Object.values(questions));
    const items = Array.isArray(state.items) ? (state.items as Array<{id: string}>) : [];
    const criteria = Array.isArray(state.criteria) ? (state.criteria as Array<{id: string}>) : [];
    const answers: Record<string, unknown> = {};
    for (const item of items) {
      for (const criterion of criteria) {
        const answer = byItem[item.id] ?? fallback;
        answers[`cell:${item.id}:${criterion.id}`] = {
          type: 'choice',
          choice: answer.choice,
          confidence: answer.confidence,
        };
      }
    }
    return {answers};
  };
  return {classify, calls};
}

function decision(overrides: Partial<AdrDecisionInput> = {}): AdrDecisionInput {
  return {
    by: 'reviewer',
    stage: 'design',
    adrId: 'ADR-0001',
    ruleId: 'R1',
    target: 'design: checkout',
    verdict: 'contradicts',
    probability: 0.9,
    confidence: 'high',
    decision: 'override',
    rationale: 'the migration has to land first',
    deliverable: 'D1',
    standing: false,
    ...overrides,
  };
}

const SUBJECT: GateSubject = {target: 'design: checkout', text: 'Use two stores.'};

async function run(
  root: string,
  config: AdrConfig,
  classify: GateClassifier,
  overrides: Partial<Parameters<typeof runAdrGate>[0]> = {},
) {
  return runAdrGate({
    root,
    stage: 'design',
    subjects: [SUBJECT],
    config,
    deliverable: 'D1',
    classify,
    now: NOW,
    ...overrides,
  });
}

test('an off gate reports the off outcome with no checks', async (t) => {
  const {root, adrs} = seed(t);
  const {classify, calls} = fakeClassifier();
  const result = await run(root, {dir: 'docs/adr', format: 'junior', gate: 'off'}, classify, {adrs});
  assert.deepEqual(result, {gate: 'off', blocked: false, findings: [], checked: 0, skipped: []});
});

test('off gate returns no findings', async (t) => {
  const {root, adrs} = seed(t);
  const result = await run(root, {dir: 'docs/adr', format: 'junior', gate: 'off'}, fakeClassifier().classify, {adrs});
  assert.deepEqual(result.findings, []);
});

test('off gate never calls the classifier', async (t) => {
  const {root, adrs} = seed(t);
  const {classify, calls} = fakeClassifier();
  await run(root, {dir: 'docs/adr', format: 'junior', gate: 'off'}, classify, {adrs});
  assert.equal(calls.length, 0);
});

test('an ADR is skipped for a subject whose files match none of its applies_to entries', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(root, config, fakeClassifier().classify, {
    adrs,
    subjects: [{target: 'implementation: change', files: ['src/a.ts']}],
  });
  assert.deepEqual(result.skipped, ['ADR-0002']);
});

test('a diff subject asks the classifier to judge only added or changed lines', async (t) => {
  const {root, config} = seed(t);
  const {classify, calls} = fakeClassifier();
  await run(root, config, classify, {
    subjects: [{target: 'src/a.ts', files: ['src/a.ts'], text: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n', kind: 'diff'}],
  });
  assert.match(calls.flat().map((question) => question.instructions).join('\n'), /Judge only the added or changed lines/);
});

test('a subject without files is checked against every accepted ADR', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(root, config, fakeClassifier().classify, {adrs});
  assert.equal(result.checked, 2);
});

test('a contradiction is reported as a finding', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(
    root,
    config,
    fakeClassifier({'ADR-0001/R1': {choice: 'contradicts', confidence: 0.95}}).classify,
    {adrs},
  );
  assert.deepEqual(
    result.findings.map((finding) => [finding.adrId, finding.ruleId, finding.verdict]),
    [['ADR-0001', 'R1', 'contradicts']],
  );
});

test('an unknown cell is reported as an uncertain finding', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(
    root,
    config,
    fakeClassifier({'ADR-0001/R1': {choice: 'conforms', confidence: 0.5}}).classify,
    {adrs},
  );
  assert.equal(result.findings[0]?.verdict, 'uncertain');
});

test('a probability below minConfidence is reported as an uncertain finding', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(
    root,
    {...config, minConfidence: 0.9},
    fakeClassifier({'ADR-0001/R1': {choice: 'conforms', confidence: 0.8}}).classify,
    {adrs},
  );
  assert.equal(result.findings[0]?.verdict, 'uncertain');
});

test('a conforming cell is not a finding', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(root, config, fakeClassifier().classify, {adrs});
  assert.deepEqual(result.findings, []);
});

test('an override decision clears a finding', async (t) => {
  const {root, adrs, config} = seed(t);
  appendDecision(root, decision(), {clock: () => NOW});
  const result = await run(
    root,
    config,
    fakeClassifier({'ADR-0001/R1': {choice: 'contradicts', confidence: 0.95}}).classify,
    {adrs},
  );
  assert.equal(result.findings[0]?.cleared, true);
});

test('an amend decision naming a proposed ADR does not clear a finding', async (t) => {
  const {root, adrs: original, config} = seed(t);
  writeFileSync(
    join(root, 'docs', 'adr', '0003-amendment.md'),
    madr({id: 'ADR-0003', status: 'proposed'}),
  );
  const adrs = loadAdrs(join(root, 'docs', 'adr'));
  appendDecision(root, decision({decision: 'amend', amendmentAdr: 'ADR-0003'}), {clock: () => NOW});
  const result = await run(
    root,
    config,
    fakeClassifier({'ADR-0001/R1': {choice: 'contradicts', confidence: 0.95}}).classify,
    {adrs},
  );
  assert.equal(result.findings[0]?.cleared, false);
});

test('an amend decision naming an accepted ADR clears a finding', async (t) => {
  const {root, config} = seed(t);
  writeFileSync(
    join(root, 'docs', 'adr', '0003-amendment.md'),
    madr({id: 'ADR-0003', status: 'accepted'}),
  );
  const adrs = loadAdrs(join(root, 'docs', 'adr'));
  appendDecision(root, decision({decision: 'amend', amendmentAdr: 'ADR-0003'}), {clock: () => NOW});
  const result = await run(
    root,
    config,
    fakeClassifier({'ADR-0001/R1': {choice: 'contradicts', confidence: 0.95}}).classify,
    {adrs},
  );
  assert.equal(result.findings[0]?.cleared, true);
});

test('a revise decision does not clear a finding', async (t) => {
  const {root, adrs, config} = seed(t);
  appendDecision(root, decision({decision: 'revise'}), {clock: () => NOW});
  const result = await run(
    root,
    config,
    fakeClassifier({'ADR-0001/R1': {choice: 'contradicts', confidence: 0.95}}).classify,
    {adrs},
  );
  assert.equal(result.findings[0]?.cleared, false);
});

test('an advisory gate never blocks even when a finding is unresolved', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(
    root,
    {...config, gate: 'advisory'},
    fakeClassifier({'ADR-0001/R1': {choice: 'contradicts', confidence: 0.95}}).classify,
    {adrs},
  );
  assert.equal(result.blocked, false);
});

test('an enforce gate blocks while a finding is unresolved', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(
    root,
    config,
    fakeClassifier({'ADR-0001/R1': {choice: 'contradicts', confidence: 0.95}}).classify,
    {adrs},
  );
  assert.equal(result.blocked, true);
});

test('an override covers only its own deliverable', async (t) => {
  const {root, adrs, config} = seed(t);
  appendDecision(root, decision({deliverable: 'D1'}), {clock: () => NOW});
  const result = await run(
    root,
    config,
    fakeClassifier({'ADR-0001/R1': {choice: 'contradicts', confidence: 0.95}}).classify,
    {adrs, deliverable: 'D2'},
  );
  assert.equal(result.findings[0]?.cleared, false);
});

test('a standing until-adr-change override clears while the ADR text is unchanged', async (t) => {
  const {root, adrs, config} = seed(t);
  appendDecision(
    root,
    decision({standing: true, expires: 'until-adr-change', adrHash: adrContentHash(readFileSync(adrs[0]!.path, 'utf8'))}),
    {clock: () => NOW},
  );
  const result = await run(
    root,
    config,
    fakeClassifier({'ADR-0001/R1': {choice: 'contradicts', confidence: 0.95}}).classify,
    {adrs},
  );
  assert.equal(result.findings[0]?.cleared, true);
});

test('a standing until-adr-change override lapses after the ADR text changes', async (t) => {
  const {root, adrs, config} = seed(t);
  appendDecision(
    root,
    decision({standing: true, expires: 'until-adr-change', adrHash: adrContentHash(readFileSync(adrs[0]!.path, 'utf8'))}),
    {clock: () => NOW},
  );
  writeFileSync(
    join(root, 'docs', 'adr', '0001-src.md'),
    madr({id: 'ADR-0001', applies_to: "['src/**']", decision: 'Changed decision.'}),
  );
  const changed = loadAdrs(join(root, 'docs', 'adr'));
  const result = await run(
    root,
    config,
    fakeClassifier({'ADR-0001/R1': {choice: 'contradicts', confidence: 0.95}}).classify,
    {adrs: changed},
  );
  assert.equal(result.findings[0]?.lapsed?.standing, true);
});

test('a ticket-stage decision is carried into a design-stage finding', async (t) => {
  const {root, adrs, config} = seed(t);
  const ticket = appendDecision(root, decision({stage: 'ticket'}), {clock: () => NOW});
  const result = await run(
    root,
    config,
    fakeClassifier({'ADR-0001/R1': {choice: 'contradicts', confidence: 0.95}}).classify,
    {adrs},
  );
  assert.equal(result.findings[0]?.carried?.id, ticket.id);
});

test('recordGateDecision appends the finding to the ledger', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(
    root,
    config,
    fakeClassifier({'ADR-0001/R1': {choice: 'contradicts', confidence: 0.95}}).classify,
    {adrs},
  );
  recordGateDecision(root, result.findings[0]!, {
    by: 'reviewer',
    decision: 'override',
    rationale: 'the migration has to land first',
    stage: 'design',
    deliverable: 'D1',
    standing: false,
  });
  assert.equal(readLedger(root).length, 1);
});

test('confirmCarried appends the carried decision at the current stage', async (t) => {
  const {root, adrs, config} = seed(t);
  appendDecision(root, decision({stage: 'ticket'}), {clock: () => NOW});
  const result = await run(
    root,
    config,
    fakeClassifier({'ADR-0001/R1': {choice: 'contradicts', confidence: 0.95}}).classify,
    {adrs},
  );
  const stored = confirmCarried(root, result.findings[0]!, 'reviewer');
  assert.equal(stored.stage, 'design');
});

test('confirmCarried references the ticket decision in its rationale', async (t) => {
  const {root, adrs, config} = seed(t);
  const ticket = appendDecision(root, decision({stage: 'ticket'}), {clock: () => NOW});
  const result = await run(
    root,
    config,
    fakeClassifier({'ADR-0001/R1': {choice: 'contradicts', confidence: 0.95}}).classify,
    {adrs},
  );
  const stored = confirmCarried(root, result.findings[0]!, 'reviewer');
  assert.equal(stored.rationale, `confirmed ticket-stage decision ${ticket.id}: ${ticket.rationale}`);
});

test('confirmCarried throws when there is no carried decision', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(
    root,
    config,
    fakeClassifier({'ADR-0001/R1': {choice: 'contradicts', confidence: 0.95}}).classify,
    {adrs},
  );
  assert.throws(() => confirmCarried(root, result.findings[0]!, 'reviewer'), /carried/);
});

test('renderGateMarkdown ends with PASS when the gate is not blocked', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(root, config, fakeClassifier().classify, {adrs});
  assert.match(renderGateMarkdown(result), /PASS\s*$/);
});

test('renderGateMarkdown ends with BLOCKED when a finding is unresolved', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(
    root,
    config,
    fakeClassifier({'ADR-0001/R1': {choice: 'contradicts', confidence: 0.95}}).classify,
    {adrs},
  );
  assert.match(renderGateMarkdown(result), /BLOCKED\s*$/);
});


test('A file-less subject skips an ADR the relevance pass rules out', async (t) => {
  const {root, config} = seed(t);
  const {classify} = fakeClassifier({
    'ADR-0002': {choice: 'no', confidence: 0.95},
    'ADR-0002/R1': {choice: 'contradicts', confidence: 0.95},
  });
  const result = await run(root, config, classify);
  assert.equal(result.findings.some((finding) => finding.adrId === 'ADR-0002'), false);
});

test('A low-confidence contradiction is reported as uncertain', async (t) => {
  const {root, config} = seed(t);
  const {classify} = fakeClassifier({'ADR-0001/R1': {choice: 'contradicts', confidence: 0.02}});
  const result = await run(root, config, classify);
  assert.deepEqual(result.findings.filter((f) => f.adrId === 'ADR-0001').map((f) => f.verdict), ['uncertain']);
});

test('An uncertain finding does not block enforce by default', async (t) => {
  const {root, config} = seed(t);
  const {classify} = fakeClassifier({'ADR-0001/R1': {choice: 'contradicts', confidence: 0.02}});
  const result = await run(root, config, classify);
  assert.equal(result.blocked, false);
});

test('An uncertain finding blocks enforce when flagUncertain is true', async (t) => {
  const {root, config} = seed(t);
  const {classify} = fakeClassifier({'ADR-0001/R1': {choice: 'contradicts', confidence: 0.02}});
  const result = await run(root, {...config, flagUncertain: true}, classify);
  assert.equal(result.blocked, true);
});

// --- inconclusive implementation checks (ADR 0018 R9) ----------------------

function unscopedAdr(): Adr {
  return {
    id: 'ADR-0003',
    number: 3,
    title: 'A foreign record',
    status: 'accepted',
    date: '2024-03-04',
    supersedes: [],
    appliesTo: [],
    rules: [{id: 'D', text: 'Use one durable queue.'}],
    context: 'Work arrives in bursts.',
    decision: 'Use one durable queue.',
    consequences: '',
    path: '',
  };
}

test('a gate that checked nothing while skipping accepted ADRs is inconclusive', async (t) => {
  const {root, config} = seed(t);
  const result = await run(root, config, fakeClassifier().classify, {
    adrs: [unscopedAdr()],
    subjects: [{target: 'implementation: change', files: ['src/a.ts']}],
  });
  assert.equal(result.inconclusive, true);
});

test('an inconclusive gate reason points at junior adr scope', async (t) => {
  const {root, config} = seed(t);
  const result = await run(root, config, fakeClassifier().classify, {
    adrs: [unscopedAdr()],
    subjects: [{target: 'implementation: change', files: ['src/a.ts']}],
  });
  assert.match(result.inconclusiveReason ?? '', /junior adr scope/);
});

test('a gate that checked a rule is not inconclusive', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(root, config, fakeClassifier().classify, {adrs});
  assert.equal(result.inconclusive, false);
});

// --- NO_DISCRIMINATION (issue #276) ----------------------------------------

const ALL_UNCERTAIN_ROWS = 6153;

function fileRows(count: number): GateSubject[] {
  return Array.from({ length: count }, (_, index) => {
    const path = `src/file-${index}.ts`;
    return { target: path, files: [path] };
  });
}

test('a gate where nearly every checked row is uncertain reports NO_DISCRIMINATION', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(root, config, fakeClassifier({}, {choice: 'conforms', confidence: 0.2}).classify, {
    adrs,
    subjects: fileRows(ALL_UNCERTAIN_ROWS),
  });
  assert.match(result.inconclusiveReason ?? '', /^NO_DISCRIMINATION: 6153 of 6153 checked cells were uncertain/);
});

test('renderGateMarkdown shows a NO_DISCRIMINATION banner for a gate with nearly every row uncertain', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(root, config, fakeClassifier({}, {choice: 'conforms', confidence: 0.2}).classify, {
    adrs,
    subjects: fileRows(ALL_UNCERTAIN_ROWS),
  });
  assert.match(renderGateMarkdown(result), /^NO_DISCRIMINATION:/m);
});

test('a gate below the minimum checked rows does not report NO_DISCRIMINATION', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(root, config, fakeClassifier({}, {choice: 'conforms', confidence: 0.2}).classify, {
    adrs,
    subjects: fileRows(2),
  });
  assert.equal(result.discrimination?.noDiscrimination, false);
});

test('a contradiction keeps a mostly uncertain gate decisive', async (t) => {
  const {root, adrs, config} = seed(t);
  const classify: GateClassifier = async ({state}) => {
    const items = Array.isArray(state.items) ? (state.items as Array<{id: string}>) : [];
    const criteria = Array.isArray(state.criteria) ? (state.criteria as Array<{id: string}>) : [];
    const answers: Record<string, unknown> = {};
    for (const item of items) {
      for (const criterion of criteria) {
        const decisive = criterion.id === 'src/file-0.ts';
        answers[`cell:${item.id}:${criterion.id}`] = {
          type: 'choice',
          choice: decisive ? 'contradicts' : 'conforms',
          confidence: decisive ? 0.95 : 0.2,
        };
      }
    }
    return {answers};
  };
  const result = await run(root, config, classify, {adrs, subjects: fileRows(11)});
  assert.equal(result.discrimination?.noDiscrimination, false);
});

test('a gate with mostly conforming rows still passes', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(root, config, fakeClassifier().classify, {adrs, subjects: fileRows(12)});
  assert.match(renderGateMarkdown(result), /PASS\s*$/);
});

// --- Scaling a large check (issue #291) -------------------------------------

test('a subject whose every file is generated is not judged', async (t) => {
  const {root, adrs, config} = seed(t);
  const {classify} = fakeClassifier({}, {choice: 'contradicts', confidence: 0.95});
  const result = await run(root, config, classify, {
    adrs,
    subjects: [{target: 'src/generated/api.ts', files: ['src/generated/api.ts']}, {target: 'src/real.ts', files: ['src/real.ts']}],
  });
  assert.deepEqual(result.findings.map((finding) => finding.target), ['src/real.ts']);
});

test('the gate result lists the subjects it excluded', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(root, config, fakeClassifier().classify, {
    adrs,
    subjects: [{target: 'src/Api.Generated.cs', files: ['src/Api.Generated.cs']}],
  });
  assert.deepEqual(result.excluded, ['src/Api.Generated.cs']);
});

test('an empty exclude list judges a generated file', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(root, config, fakeClassifier().classify, {
    adrs,
    exclude: [],
    subjects: [{target: 'src/generated/api.ts', files: ['src/generated/api.ts']}],
  });
  assert.equal(result.checked, 1);
});

const UNRELATED: GateSubject = {target: 'src/math.ts', files: ['src/math.ts'], text: '+ export const sum = (a, b) => a + b;'};
const RELATED: GateSubject = {target: 'src/tree.ts', files: ['src/tree.ts'], text: '+ // keep the source tree honest'};

test('above adr.prefilterCells a path-scoped file sharing no word with the ADR is not judged', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(root, {...config, prefilterCells: 0}, fakeClassifier().classify, {adrs, subjects: [UNRELATED, RELATED]});
  assert.equal(result.checked, 1);
});

test('the gate result counts the pairs the pre-filter dropped', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(root, {...config, prefilterCells: 0}, fakeClassifier().classify, {adrs, subjects: [UNRELATED, RELATED]});
  assert.deepEqual(result.prefiltered, {pairs: 1, cells: 1, threshold: 0});
});

test('below adr.prefilterCells every path-scoped file is judged', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(root, config, fakeClassifier().classify, {adrs, subjects: [UNRELATED, RELATED]});
  assert.equal(result.checked, 2);
});

test('prefilter false judges every pair above adr.prefilterCells', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(root, {...config, prefilterCells: 0}, fakeClassifier().classify, {adrs, subjects: [UNRELATED, RELATED], prefilter: false});
  assert.equal(result.checked, 2);
});

test('the pre-filter never drops a file that cites the ADR', async (t) => {
  const {root, adrs, config} = seed(t);
  const cited: GateSubject = {target: 'src/math.ts', files: ['src/math.ts'], text: '+ // see ADR-0001\n+ export const sum = 1;'};
  const result = await run(root, {...config, prefilterCells: 0}, fakeClassifier().classify, {adrs, subjects: [cited]});
  assert.equal(result.checked, 1);
});

test('renderGateMarkdown names the pre-filtered pairs and --no-prefilter', async (t) => {
  const {root, adrs, config} = seed(t);
  const result = await run(root, {...config, prefilterCells: 0}, fakeClassifier().classify, {adrs, subjects: [UNRELATED, RELATED]});
  assert.match(renderGateMarkdown(result), /Pre-filtered: 1 ADR\/file pair .*--no-prefilter/);
});

test('the gate reports its plan and then each judged rule to progress', async (t) => {
  const {root, adrs, config} = seed(t);
  const events: unknown[] = [];
  await run(root, config, fakeClassifier().classify, {adrs, subjects: fileRows(3), progress: (event) => events.push(event)});
  assert.deepEqual(events, [
    {phase: 'plan', adrs: 1, subjects: 3, cells: 3, excluded: 0, prefiltered: 0},
    {phase: 'judge', adrIndex: 1, adrs: 1, adrId: 'ADR-0001', cellsDone: 3, cells: 3},
  ]);
});
