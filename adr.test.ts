// Behavioral tests for architecture decision record (ADR) conformance
// (`junior matrix adr <new|lint|sync|check>`).
//
// Every scenario is offline. The Jev classifier is injected as a fake and the
// crossmatrix path is injected as a fake MCP-shaped `callHop`, so no Jev,
// OpenRouter or network call is ever made. Each test is atomic (one behavioral
// assertion) and drives a public interface (`adr.ts` or the CLI). This file is
// written before the implementation: it describes the required behavior and
// must fail until `adr.ts` exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adrCheck,
  adrDimension,
  createAdr,
  lintAdrs,
  loadAdrs,
  parseAdr,
} from './adr.ts';
import type { GateClassifier } from './worker.ts';

const NODE = process.execPath;
const JUNIOR = join(import.meta.dirname, 'junior.ts');
const SEED_DIR = join(import.meta.dirname, 'docs', 'adr');

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-adr-'));
}

function adrDir(prefix = 'junior-adr-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const dir = join(root, 'docs', 'adr');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeAdr(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

/** A minimal valid MADR document with one accepted rule and one applies_to. */
function madr(overrides: {
  id?: string;
  status?: string;
  supersedes?: string;
  applies_to?: string;
  rules?: string;
} = {}): string {
  const id = overrides.id ?? 'ADR-0001';
  const status = overrides.status ?? 'accepted';
  const supersedes = overrides.supersedes ?? '[]';
  const appliesTo = overrides.applies_to ?? "['feature:crossmatrix']";
  const rules = overrides.rules ?? '\n  - id: R1\n    text: Store state exactly once.';
  return [
    '---',
    `id: ${id}`,
    'title: A decision',
    `status: ${status}`,
    'date: 2026-01-01',
    `supersedes: ${supersedes}`,
    `applies_to: ${appliesTo}`,
    `rules:${rules}`,
    '---',
    '',
    '## Context',
    '',
    'Because the store is mirrored.',
    '',
    '## Decision',
    '',
    'We keep one copy.',
    '',
    '## Consequences',
    '',
    'Sync mirrors it.',
    '',
  ].join('\n');
}

/** An injected choice classifier that answers every question the same way. */
function choiceClassifier(choice: string, confidence = 0.9) {
  const calls: number[] = [];
  const classify: GateClassifier = async ({ questions }) => {
    calls.push(Object.keys(questions).length);
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(questions)) answers[id] = { type: 'choice', choice, confidence };
    return { answers };
  };
  return { classify, calls };
}

/** An offline `callHop` that records every crossmatrix command request. */
function fakeDeps(writes: any[]) {
  return {
    callHop: (async (_hop: string, _tool: string, request: any) => {
      if (request?.tool === 'crossmatrix.command') writes.push(request.arguments.request);
      return { ok: true, result: { ok: true } };
    }) as any,
    loadHop: (() => ({ tools: { crossmatrix: { sourceVersion: '0.3.0' } } })) as any,
  };
}

// --- parsing and lint -------------------------------------------------------

test('parseAdr reads the rules from the MADR front matter', () => {
  assert.deepEqual(parseAdr(madr()).rules, [{ id: 'R1', text: 'Store state exactly once.' }]);
});

test('lintAdrs rejects an accepted ADR with no rules', () => {
  const adr = parseAdr(madr({ rules: ' []' }));
  assert.equal(lintAdrs([adr]).some((finding) => finding.code === 'missing-rules'), true);
});

test('lintAdrs rejects a supersedes reference to a missing ADR', () => {
  const adr = parseAdr(madr({ supersedes: '[ADR-0099]' }));
  assert.equal(lintAdrs([adr]).some((finding) => finding.code === 'missing-supersedes'), true);
});

test('lintAdrs rejects an accepted ADR that another record supersedes', () => {
  const superseded = parseAdr(madr({ id: 'ADR-0001', status: 'accepted' }));
  const successor = parseAdr(madr({ id: 'ADR-0002', status: 'accepted', supersedes: '[ADR-0001]' }));
  assert.equal(lintAdrs([superseded, successor]).some((finding) => finding.code === 'superseded-still-accepted'), true);
});

test('lintAdrs reports no error for an accepted ADR with a rule and an applies_to', () => {
  assert.equal(lintAdrs([parseAdr(madr())]).filter((finding) => finding.severity === 'error').length, 0);
});

test('lintAdrs rejects duplicate ADR ids', () => {
  const first = parseAdr(madr({ id: 'ADR-0001' }));
  const second = parseAdr(madr({ id: 'ADR-0001', supersedes: '[]' }));
  assert.equal(lintAdrs([first, second]).some((finding) => finding.code === 'duplicate-id'), true);
});

// --- adr new ----------------------------------------------------------------

test('adr new creates the next numbered file from the template', () => {
  const dir = adrDir();
  writeAdr(dir, '0001-first.md', madr({ id: 'ADR-0001' }));
  const created = createAdr(dir, 'New idea');
  assert.equal(created.path.endsWith('0002-new-idea.md'), true);
});

test('adr new writes a proposed template that parses with the requested title', () => {
  const dir = adrDir();
  const created = createAdr(dir, 'My chosen title');
  assert.equal(readFileSync(created.path, 'utf8').includes('title: My chosen title'), true);
});

// --- adr sync ---------------------------------------------------------------

test('adrDimension publishes accepted ADR rules as adr: members', () => {
  const dimension = adrDimension([parseAdr(madr())]);
  assert.deepEqual(dimension.members.map((member) => member.id), ['adr:ADR-0001/R1']);
});

// --- adr check scoping ------------------------------------------------------

test('adr check scopes a rule with applies_to tools/** only to changed files under tools/', async () => {
  const dir = adrDir();
  writeAdr(dir, '0001-tools.md', madr({ applies_to: "['tools/**']" }));
  const { classify } = choiceClassifier('conforms');
  const result = await adrCheck({
    dir,
    changedFiles: ['tools/tools.ts', 'src/other.ts'],
    classify,
    deps: fakeDeps([]),
  });
  assert.deepEqual(result.pairs.map((pair) => pair.target), ['tools/tools.ts']);
});

test('adr check without changed files scopes to code members linked by the code map', async () => {
  const dir = adrDir();
  writeAdr(dir, '0001-all.md', madr({ applies_to: "['**/*.ts']" }));
  const callHop = async (_hop: string, _tool: string, request: any) => {
    const q = request?.arguments?.request?.query ?? {};
    if (q.kind === 'describe') return { ok: true, result: { describe: { relations: [{ id: 'codemap', from: 'feature', to: 'code' }] } } };
    if (q.kind === 'slice') return { ok: true, result: { cells: [{ from: 'feature:x', to: 'loc:src/a.ts' }], nextCursor: null } };
    return { ok: true, result: {} };
  };
  const { classify } = choiceClassifier('conforms');
  const result = await adrCheck({
    dir,
    hopPath: 'hop.json',
    modelId: 'm1',
    classify,
    deps: { callHop: callHop as any, loadHop: (() => ({ tools: { crossmatrix: { sourceVersion: '0.3.0' } } })) as any },
  });
  assert.deepEqual(result.pairs.map((pair) => pair.target), ['src/a.ts']);
});

test('adr check skips a rule whose applies_to matches no changed file', async () => {
  const dir = adrDir();
  writeAdr(dir, '0001-docs.md', madr({ applies_to: "['docs/**']" }));
  const { classify } = choiceClassifier('conforms');
  const result = await adrCheck({
    dir,
    changedFiles: ['tools/tools.ts'],
    classify,
    deps: fakeDeps([]),
  });
  assert.equal(result.pairs.length, 0);
});

// --- adr check findings -----------------------------------------------------

test('a fake classifier answering contradicts yields a review-queue finding', async () => {
  const dir = adrDir();
  writeAdr(dir, '0001-tools.md', madr({ applies_to: "['tools/**']" }));
  const { classify } = choiceClassifier('contradicts');
  const result = await adrCheck({ dir, changedFiles: ['tools/tools.ts'], classify, deps: fakeDeps([]) });
  assert.equal(result.findings.some((finding) => finding.kind === 'contradiction'), true);
});

test('a low-confidence cell yields an uncertain review-queue finding', async () => {
  const dir = adrDir();
  writeAdr(dir, '0001-tools.md', madr({ applies_to: "['tools/**']" }));
  const { classify } = choiceClassifier('conforms', 0.5);
  const result = await adrCheck({ dir, changedFiles: ['tools/tools.ts'], classify, deps: fakeDeps([]) });
  assert.equal(result.findings.some((finding) => finding.kind === 'uncertain'), true);
});

test('adr check without --record sends no crossmatrix write', async () => {
  const dir = adrDir();
  writeAdr(dir, '0001-tools.md', madr({ applies_to: "['tools/**']" }));
  const writes: any[] = [];
  const { classify } = choiceClassifier('conforms');
  await adrCheck({ dir, changedFiles: ['tools/tools.ts'], classify, deps: fakeDeps(writes) });
  assert.equal(writes.length, 0);
});

test('adr check --record writes a proposed conformance observation', async () => {
  const dir = adrDir();
  writeAdr(dir, '0001-tools.md', madr({ applies_to: "['tools/**']" }));
  const writes: any[] = [];
  const { classify } = choiceClassifier('conforms');
  await adrCheck({
    dir,
    changedFiles: ['tools/tools.ts'],
    record: true,
    hopPath: 'hop.json',
    modelId: 'm1',
    classify,
    deps: fakeDeps(writes),
  });
  assert.equal(writes.some((request) => request.op?.kind === 'observe'), true);
});

// --- seed ADRs --------------------------------------------------------------

test('Junior ships six seed ADRs', () => {
  assert.equal(loadAdrs(SEED_DIR).length, 6);
});

test('Junior seed ADRs lint clean', () => {
  assert.equal(lintAdrs(loadAdrs(SEED_DIR)).filter((finding) => finding.severity === 'error').length, 0);
});

// --- CLI --------------------------------------------------------------------

test('junior matrix adr new creates the next numbered file', () => {
  const dir = adrDir();
  const cli = spawnSync(NODE, [JUNIOR, 'matrix', 'adr', 'new', 'Cli decision', '--dir', dir], {
    encoding: 'utf8',
  });
  assert.equal(existsSync(join(dir, '0001-cli-decision.md')), true);
});

test('junior matrix adr lint exits non-zero when an accepted ADR has no rules', () => {
  const dir = adrDir();
  writeAdr(dir, '0001-bad.md', madr({ rules: ' []' }));
  const cli = spawnSync(NODE, [JUNIOR, 'matrix', 'adr', 'lint', '--dir', dir], { encoding: 'utf8' });
  assert.notEqual(cli.status, 0);
});
