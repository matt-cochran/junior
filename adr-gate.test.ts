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
