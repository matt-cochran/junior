// Behavioral tests for ADR retrieval (#276).
//
// `mustJudge` decides which ADRs the gate must judge even when the relevance
// pre-filter or `applies_to` scope would drop them. Gate scenarios use a fake
// classifier and a temporary project: the relevance question answers "no" so
// only retrieval can keep an ADR in front of the conformance judge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAdrs, type Adr } from './adr.ts';
import type { AdrConfig } from './adr-config.ts';
import type { GateClassifier } from './worker.ts';
import { lexicallyRelevant, mustJudge } from './adr-retrieval.ts';
import { runAdrGate, type GateSubject } from './adr-gate.ts';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function adr(overrides: Partial<Adr> = {}): Adr {
  return {
    id: 'ADR-0007',
    number: 7,
    title: 'Tool independence',
    status: 'accepted',
    date: '2026-01-01',
    supersedes: [],
    appliesTo: ['src/**'],
    rules: [{ id: 'R1', text: 'Keep the tools independent.' }],
    context: '',
    decision: '',
    consequences: '',
    path: '/tmp/docs/adr/0007-tool-independence.md',
    ...overrides,
  };
}

function design(text: string, files?: string[]): GateSubject {
  return { target: 'design: input', text, ...(files !== undefined ? { files } : {}) };
}

// --- cited ------------------------------------------------------------------

test('mustJudge cites an ADR named by its prefixed id', () => {
  assert.equal(mustJudge(adr(), design('This design follows ADR-0007.')), 'cited');
});

test('mustJudge cites an ADR named by its zero-padded number', () => {
  assert.equal(mustJudge(adr(), design('See 0007 before changing the tools.')), 'cited');
});

test('mustJudge cites an ADR named by its spaced id and unpadded number', () => {
  assert.equal(mustJudge(adr(), design('Per ADR 7 the tools stay independent.')), 'cited');
});

test('mustJudge cites an ADR named by its file name', () => {
  assert.equal(mustJudge(adr(), design('See 0007-tool-independence.md for the rationale.')), 'cited');
});

test('mustJudge does not cite ADR 0007 when the text names 0071', () => {
  assert.equal(mustJudge(adr(), design('Follow ADR-0071 instead.')), null);
});

// --- scope ------------------------------------------------------------------

test('mustJudge scopes an ADR whose double-star glob covers a changed file', () => {
  const scoped = adr({ appliesTo: ['tools/_shared/**'] });
  assert.equal(mustJudge(scoped, { target: 'change', files: ['tools/_shared/a.ts'] }), 'scope');
});

test('mustJudge scopes an ADR whose double-star glob covers a nested changed file', () => {
  const scoped = adr({ appliesTo: ['tools/_shared/**'] });
  assert.equal(mustJudge(scoped, { target: 'change', files: ['tools/_shared/x/y.ts'] }), 'scope');
});

test('mustJudge scopes an ADR whose directory entry covers a nested changed file', () => {
  const scoped = adr({ appliesTo: ['tools/_shared/'] });
  assert.equal(mustJudge(scoped, { target: 'change', files: ['tools/_shared/x/y.ts'] }), 'scope');
});

test('mustJudge normalizes a dot-slash glob and a backslash path before scoping', () => {
  const scoped = adr({ appliesTo: ['./tools/_shared/**'] });
  assert.equal(mustJudge(scoped, { target: 'change', files: ['tools\\_shared\\a.ts'] }), 'scope');
});

test('mustJudge leaves an ADR out of scope when the changed file is outside applies_to', () => {
  const scoped = adr({ appliesTo: ['tools/_shared/**'] });
  assert.equal(mustJudge(scoped, { target: 'change', files: ['src/a.ts'] }), null);
});

// --- topic ------------------------------------------------------------------

test('mustJudge matches an ADR topic sharing two significant title words', () => {
  const topical = adr({ title: 'Claim-check messaging for bulk jobs' });
  assert.equal(mustJudge(topical, design('The bulk import messaging design.')), 'topic');
});

test('mustJudge matches a design topic through a significant title phrase', () => {
  const topical = adr({ title: 'Claim-check messaging for bulk jobs' });
  const subject = design('We add a claim check in front of the importer.');
  assert.equal(mustJudge(topical, subject), 'topic');
});

test('mustJudge does not match a topic when the subject has files', () => {
  const topical = adr({ title: 'Claim-check messaging for bulk jobs', appliesTo: [] });
  assert.equal(
    mustJudge(topical, design('The bulk import messaging design.', ['src/import.ts'])),
    null,
  );
});

test('mustJudge does not match a topic sharing a single significant word', () => {
  const topical = adr({ title: 'Claim-check messaging for bulk jobs' });
  assert.equal(mustJudge(topical, design('The bulk importer changed.')), null);
});

// --- gate integration -------------------------------------------------------

function madr(options: {id: string; title: string; applies_to?: string}): string {
  return [
    '---',
    `id: ${options.id}`,
    `title: ${options.title}`,
    'status: accepted',
    'date: 2026-01-01',
    'supersedes: []',
    `applies_to: ${options.applies_to ?? "['src/**']"}`,
    'rules:',
    '  - id: R1',
    '    text: Keep the tools independent.',
    '---',
    '',
    '## Context',
    '',
    'Context.',
    '',
    '## Decision',
    '',
    'Decision.',
    '',
    '## Consequences',
    '',
    'Consequences.',
    '',
  ].join('\n');
}

function project(t: any): string {
  const root = mkdtempSync(join(tmpdir(), 'junior-adr-retrieval-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function seed(t: any, files: Record<string, string>): {root: string; adrs: Adr[]; config: AdrConfig} {
  const root = project(t);
  const dir = join(root, 'docs', 'adr');
  mkdirSync(dir, {recursive: true});
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return {root, adrs: loadAdrs(dir), config: {dir: 'docs/adr', format: 'junior', gate: 'enforce'}};
}

/** Relevance says "no"; every conformance cell contradicts. */
function gateClassifier(): GateClassifier {
  return async ({state}) => {
    const items = Array.isArray(state.items) ? (state.items as Array<{id: string}>) : [];
    const criteria = Array.isArray(state.criteria) ? (state.criteria as Array<{id: string}>) : [];
    const relevant = criteria.some((criterion) => criterion.id === 'relevant');
    const answers: Record<string, unknown> = {};
    for (const item of items) {
      for (const criterion of criteria) {
        answers[`cell:${item.id}:${criterion.id}`] = {
          type: 'choice',
          choice: relevant ? 'no' : 'contradicts',
          confidence: 0.95,
        };
      }
    }
    return {answers};
  };
}

async function runGate(
  root: string,
  config: AdrConfig,
  adrs: Adr[],
  subject: GateSubject,
  stage: 'design' | 'implementation' = 'design',
) {
  return runAdrGate({
    root,
    stage,
    subjects: [subject],
    config,
    deliverable: 'D1',
    adrs,
    classify: gateClassifier(),
    now: NOW,
  });
}

test('a design that cites two ADR ids gets both judged despite the relevance filter', async (t) => {
  const {root, adrs, config} = seed(t, {
    '0001-first.md': madr({id: 'ADR-0001', title: 'First decision'}),
    '0002-second.md': madr({id: 'ADR-0002', title: 'Second decision'}),
  });
  const result = await runGate(
    root,
    config,
    adrs,
    {target: 'design: input', text: 'This design follows ADR-0001 and ADR-0002.'},
  );
  assert.deepEqual(result.findings.map((finding) => finding.adrId).sort(), ['ADR-0001', 'ADR-0002']);
});

test('a design about bulk import messaging retrieves the claim-check messaging ADR', async (t) => {
  const {root, adrs, config} = seed(t, {
    '0001-claim-check.md': madr({
      id: 'ADR-0001',
      title: 'Claim-check messaging for bulk jobs',
    }),
  });
  const result = await runGate(
    root,
    config,
    adrs,
    {target: 'design: input', text: 'The bulk import messaging design.'},
  );
  assert.equal(result.findings[0]?.adrId, 'ADR-0001');
});

test('a changed file under a double-star applies_to glob is always judged', async (t) => {
  const {root, adrs, config} = seed(t, {
    '0001-shared.md': madr({
      id: 'ADR-0001',
      title: 'Tool independence',
      applies_to: "['tools/_shared/**']",
    }),
  });
  const result = await runGate(
    root,
    config,
    adrs,
    {target: 'change', files: ['tools/_shared/x/y.ts']},
    'implementation',
  );
  assert.equal(result.findings[0]?.target, 'change');
});

// --- Lexical pre-filter (issue #291) ----------------------------------------

test('lexicallyRelevant keeps a diff that shares an identifier word with the ADR', () => {
  const record = adr({title: 'Structured logging', rules: [{id: 'R1', text: 'Log through ILogger, never Console.WriteLine.'}]});
  assert.equal(lexicallyRelevant(record, {target: 'src/a.cs', files: ['src/a.cs'], text: '+ Console.WriteLine("hi");'}), true);
});

test('lexicallyRelevant drops a diff that shares no significant word with the ADR', () => {
  const record = adr({title: 'Structured logging', decision: 'Use structured logging.', rules: [{id: 'R1', text: 'Log through ILogger.'}]});
  assert.equal(lexicallyRelevant(record, {target: 'src/math.ts', files: ['src/math.ts'], text: '+ export const sum = (a, b) => a + b;'}), false);
});
