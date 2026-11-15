// Behavioral tests for ADR collections without Junior front matter
// (ADR 0018 R9).
//
// Every scenario is offline and drives the public functions of
// `adr-foreign.ts`. Temporary directories stand in for a project checkout;
// no Jev, OpenRouter or network call is made.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseAdr } from './adr.ts';
import {
  draftFrontMatter,
  loadAllAdrs,
  loadForeignAdrs,
  parseForeignAdr,
  scopeCandidates,
  scopeRequest,
  writeProposal,
} from './adr-foreign.ts';

function project(t: any): string {
  const root = mkdtempSync(join(tmpdir(), 'junior-adr-foreign-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function foreignFile(root: string, name: string, content: string): string {
  const path = join(root, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

const MADR = [
  '---',
  'status: accepted',
  'date: 2024-02-03',
  'deciders: The architecture group',
  '---',
  '',
  '# 1. Use the public API',
  '',
  '## Context and Problem Statement',
  '',
  'Callers need one supported entry point.',
  '',
  '## Decision Outcome',
  '',
  'Chosen option: "Use the public API", because duplicate entry points drift.',
  '',
  '## Consequences',
  '',
  'Callers depend on one stable surface.',
  '',
].join('\n');

const NYGARD = [
  '# 2. Use a queue',
  '',
  'Date: 2024-03-04',
  '',
  '## Status',
  '',
  'Accepted',
  '',
  '## Context',
  '',
  'Work arrives in bursts.',
  '',
  '## Decision',
  '',
  'We will put work on one durable queue.',
  '',
  '## Consequences',
  '',
  'Consumers can retry independently.',
  '',
].join('\n');

const JUNIOR = [
  '---',
  'id: ADR-0009',
  'title: A Junior decision',
  'status: accepted',
  'date: 2026-01-01',
  'supersedes: []',
  'applies_to: [src/**]',
  'rules:',
  '  - id: R1',
  '    text: Keep one entry point.',
  '---',
  '',
  '## Decision',
  '',
  'Use the supported entry point.',
  '',
].join('\n');

// --- parsing ---------------------------------------------------------------

test('parseForeignAdr reads the id from the NNNN filename prefix', () => {
  assert.equal(parseForeignAdr(NYGARD, 'docs/adr/0002-use-a-queue.md').id, 'ADR-0002');
});

test('parseForeignAdr strips a single-digit number from the first heading', () => {
  assert.equal(parseForeignAdr(NYGARD, 'docs/adr/0002-use-a-queue.md').title, 'Use a queue');
});

test('parseForeignAdr strips a four-digit number from the first heading', () => {
  const markdown = NYGARD.replace('# 2. Use a queue', '# 0042. Use a queue');
  assert.equal(parseForeignAdr(markdown, 'docs/adr/0042-use-a-queue.md').title, 'Use a queue');
});

test('parseForeignAdr reads a MADR Decision Outcome section as the decision', () => {
  const adr = parseForeignAdr(MADR, 'docs/adr/0001-use-the-public-api.md');
  assert.equal(adr.decision, 'Chosen option: "Use the public API", because duplicate entry points drift.');
});

test('parseForeignAdr reads a MADR Context and Problem Statement section as context', () => {
  const adr = parseForeignAdr(MADR, 'docs/adr/0001-use-the-public-api.md');
  assert.equal(adr.context, 'Callers need one supported entry point.');
});

test('parseForeignAdr reads a Date line', () => {
  assert.equal(parseForeignAdr(NYGARD, 'docs/adr/0002-use-a-queue.md').date, '2024-03-04');
});

test('parseForeignAdr reads a Date from MADR front matter', () => {
  assert.equal(parseForeignAdr(MADR, 'docs/adr/0001-use-the-public-api.md').date, '2024-02-03');
});

test('parseForeignAdr reads a Status line', () => {
  const markdown = NYGARD.replace('## Status\n\nAccepted', 'Status: Accepted');
  assert.equal(parseForeignAdr(markdown, 'docs/adr/0002-use-a-queue.md').status, 'accepted');
});

test('parseForeignAdr reads the first non-empty line of a Status section', () => {
  assert.equal(parseForeignAdr(NYGARD, 'docs/adr/0002-use-a-queue.md').status, 'accepted');
});

test('parseForeignAdr reads a MADR front matter status', () => {
  assert.equal(parseForeignAdr(MADR, 'docs/adr/0001-use-the-public-api.md').status, 'accepted');
});

for (const status of ['proposed', 'accepted', 'superseded', 'deprecated']) {
  test(`parseForeignAdr maps the status ${status} case-insensitively`, () => {
    const markdown = `# 3. A status\n\nStatus: ${status.toUpperCase()}\n\n## Decision\n\nChoose it.\n`;
    assert.equal(parseForeignAdr(markdown, 'docs/adr/0003-a-status.md').status, status);
  });
}

test('parseForeignAdr maps Rejected to deprecated', () => {
  const markdown = '# 3. A status\n\nStatus: Rejected\n\n## Decision\n\nChoose it.\n';
  assert.equal(parseForeignAdr(markdown, 'docs/adr/0003-a-status.md').status, 'deprecated');
});

test('parseForeignAdr maps an unknown status to proposed', () => {
  const markdown = '# 3. A status\n\nStatus: Needs discussion\n\n## Decision\n\nChoose it.\n';
  assert.equal(parseForeignAdr(markdown, 'docs/adr/0003-a-status.md').status, 'proposed');
});

test('parseForeignAdr applies no repository paths to a foreign ADR', () => {
  assert.deepEqual(parseForeignAdr(NYGARD, 'docs/adr/0002-use-a-queue.md').appliesTo, []);
});

test('parseForeignAdr turns a non-empty decision into one D rule', () => {
  assert.deepEqual(parseForeignAdr(NYGARD, 'docs/adr/0002-use-a-queue.md').rules, [
    { id: 'D', text: 'We will put work on one durable queue.' },
  ]);
});

test('parseForeignAdr collapses the D rule to one line', () => {
  const markdown = '# 3. A decision\n\n## Decision\n\nFirst line.\nSecond line.\n';
  assert.equal(parseForeignAdr(markdown, 'docs/adr/0003-a-decision.md').rules[0].text, 'First line. Second line.');
});

test('parseForeignAdr caps the D rule at 600 characters', () => {
  const markdown = `# 3. A decision\n\n## Decision\n\n${'x'.repeat(700)}\n`;
  assert.equal(parseForeignAdr(markdown, 'docs/adr/0003-a-decision.md').rules[0].text.length, 600);
});

test('parseForeignAdr returns no rules when the decision is empty', () => {
  const markdown = '# 3. A decision\n\n## Context\n\nOnly context.\n';
  assert.deepEqual(parseForeignAdr(markdown, 'docs/adr/0003-a-decision.md').rules, []);
});

// --- loading ---------------------------------------------------------------

test('loadForeignAdrs skips files that start with Junior front matter', (t) => {
  const root = project(t);
  foreignFile(root, '0001-junior.md', JUNIOR);
  foreignFile(root, '0002-nygard.md', NYGARD);
  assert.deepEqual(loadForeignAdrs(root).map((adr) => adr.id), ['ADR-0002']);
});

test('loadForeignAdrs sorts records by number', (t) => {
  const root = project(t);
  foreignFile(root, '0002-nygard.md', NYGARD);
  foreignFile(root, '0001-madr.md', MADR);
  assert.deepEqual(loadForeignAdrs(root).map((adr) => adr.id), ['ADR-0001', 'ADR-0002']);
});

test('loadAllAdrs merges Junior and foreign records in number order', (t) => {
  const root = project(t);
  foreignFile(root, '0009-junior.md', JUNIOR);
  foreignFile(root, '0002-nygard.md', NYGARD);
  assert.deepEqual(loadAllAdrs(root).map((adr) => adr.id), ['ADR-0002', 'ADR-0009']);
});

const ADR_PREFIX_CONFIG = { filePattern: '^ADR-(?<number>\\d+[a-z]?)-(?<slug>.+)\\.md$' };

test('parseForeignAdr reads the id through a configured filePattern', () => {
  assert.equal(parseForeignAdr(NYGARD, 'docs/adr/ADR-008a-use-a-queue.md', ADR_PREFIX_CONFIG).id, 'ADR-008a');
});

test('loadAllAdrs selects records with a configured filePattern', (t) => {
  const root = project(t);
  foreignFile(root, 'ADR-001-madr.md', MADR);
  assert.deepEqual(loadAllAdrs(root, ADR_PREFIX_CONFIG).map((adr) => adr.id), ['ADR-001']);
});

test('draftFrontMatter keeps an ADR id number text in the proposal path', (t) => {
  const root = project(t);
  const path = foreignFile(root, 'ADR-008a-madr.md', MADR);
  const adr = parseForeignAdr(MADR, path, ADR_PREFIX_CONFIG);
  assert.equal(draftFrontMatter(adr, { rules: [] }).path, '.delivery/adr-proposals/008a-front-matter.md');
});

// --- scope candidates and judgments ----------------------------------------

function git(root: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function trackedProject(t: any, files: string[]): string {
  const root = project(t);
  git(root, ['init', '-q']);
  for (const name of files) foreignFile(root, name, 'tracked\n');
  git(root, ['add', '.']);
  return root;
}

test('scopeCandidates lists globs for tracked directories only', (t) => {
  const root = trackedProject(t, ['src/tracked.ts']);
  foreignFile(root, 'other/untracked.ts', 'untracked\n');
  assert.deepEqual(scopeCandidates(root), ['src/**']);
});

test('scopeCandidates lists tracked directories only down to depth three', (t) => {
  const root = trackedProject(t, ['a/b/c/d/file.ts']);
  assert.deepEqual(scopeCandidates(root), ['a/**', 'a/b/**', 'a/b/c/**']);
});

test('scopeCandidates orders equal-depth directories by descending tracked-file count', (t) => {
  const root = trackedProject(t, ['a/one.ts', 'b/one.ts', 'b/two.ts']);
  assert.deepEqual(scopeCandidates(root), ['b/**', 'a/**']);
});

test('scopeCandidates excludes node_modules and the ADR folder', (t) => {
  const root = trackedProject(t, ['src/app.ts', 'node_modules/pkg/index.js', 'docs/adr/0001-decision.md']);
  writeFileSync(
    join(root, 'delivery.config.json'),
    JSON.stringify({adr: {dir: 'docs/adr', format: 'nygard', gate: 'enforce'}}, null, 2) + '\n',
  );
  git(root, ['add', 'delivery.config.json']);
  assert.deepEqual(scopeCandidates(root), ['src/**']);
});

test('scopeCandidates caps the candidate list at maxCandidates', (t) => {
  const root = trackedProject(t, ['a/file.ts', 'b/file.ts']);
  assert.deepEqual(scopeCandidates(root, { maxCandidates: 1 }), ['a/**']);
});

test('scopeCandidates returns no candidates outside a git repository', (t) => {
  const root = project(t);
  foreignFile(root, 'src/app.ts', 'tracked\n');
  assert.deepEqual(scopeCandidates(root), []);
});

test('scopeRequest carries the ADR decision as untrusted context', () => {
  const adr = parseForeignAdr(NYGARD, 'docs/adr/0002-use-a-queue.md');
  assert.match(scopeRequest(adr, ['src/**']).context ?? '', /untrusted[\s\S]*We will put work on one durable queue\./);
});

test('scopeRequest asks one yes-or-no governs criterion', () => {
  const adr = parseForeignAdr(NYGARD, 'docs/adr/0002-use-a-queue.md');
  const criteria = scopeRequest(adr, ['src/**']).criteria ?? [];
  assert.deepEqual(
    criteria.map((criterion) => ({
      id: criterion.id,
      scale: criterion.scale.map((option) => [option.id, option.score]),
    })),
    [{ id: 'governs', scale: [['yes', 1], ['no', 0]] }],
  );
});

test('scopeRequest lists every candidate as an item description', () => {
  const adr = parseForeignAdr(NYGARD, 'docs/adr/0002-use-a-queue.md');
  assert.deepEqual(scopeRequest(adr, ['src/**', 'docs/**']).items.map((item) => item.description), ['src/**', 'docs/**']);
});

// --- drafting a proposal ---------------------------------------------------

test('draftFrontMatter keeps the original status', (t) => {
  const root = project(t);
  const path = foreignFile(root, '0002-nygard.md', NYGARD);
  const adr = parseForeignAdr(NYGARD, path);
  const draft = draftFrontMatter(adr, { appliesTo: ['src/**'], rules: [{ id: 'R1', text: 'Use one queue.' }] });
  assert.equal(parseAdr(draft.markdown).status, 'accepted');
});

test('draftFrontMatter takes applies_to from the answer', (t) => {
  const root = project(t);
  const path = foreignFile(root, '0002-nygard.md', NYGARD);
  const adr = parseForeignAdr(NYGARD, path);
  const draft = draftFrontMatter(adr, { appliesTo: ['src/**'], rules: [{ id: 'R1', text: 'Use one queue.' }] });
  assert.deepEqual(parseAdr(draft.markdown).appliesTo, ['src/**']);
});

test('draftFrontMatter takes rules from the answer', (t) => {
  const root = project(t);
  const path = foreignFile(root, '0002-nygard.md', NYGARD);
  const adr = parseForeignAdr(NYGARD, path);
  const draft = draftFrontMatter(adr, { appliesTo: ['src/**'], rules: [{ id: 'R1', text: 'Use one queue.' }] });
  assert.deepEqual(parseAdr(draft.markdown).rules, [{ id: 'R1', text: 'Use one queue.' }]);
});

test('draftFrontMatter proposes a path under .delivery/adr-proposals', (t) => {
  const root = project(t);
  const path = foreignFile(root, '0002-nygard.md', NYGARD);
  const adr = parseForeignAdr(NYGARD, path);
  const draft = draftFrontMatter(adr, { appliesTo: ['src/**'], rules: [] });
  assert.equal(draft.path, '.delivery/adr-proposals/0002-front-matter.md');
});

test('draftFrontMatter keeps the original document after its new front matter', (t) => {
  const root = project(t);
  const path = foreignFile(root, '0002-nygard.md', NYGARD);
  const adr = parseForeignAdr(NYGARD, path);
  const draft = draftFrontMatter(adr, { appliesTo: ['src/**'], rules: [] });
  assert.equal(draft.markdown.endsWith(NYGARD), true);
});

// --- writing the proposal --------------------------------------------------

test('writeProposal writes the draft under .delivery/adr-proposals', (t) => {
  const root = project(t);
  const path = foreignFile(root, '0002-nygard.md', NYGARD);
  const adr = parseForeignAdr(NYGARD, path);
  const draft = draftFrontMatter(adr, { appliesTo: ['src/**'], rules: [] });
  writeProposal(root, draft);
  assert.equal(readFileSync(join(root, draft.path), 'utf8'), draft.markdown);
});

test('writeProposal leaves the original ADR byte-identical', (t) => {
  const root = project(t);
  const path = foreignFile(root, '0002-nygard.md', NYGARD);
  const adr = parseForeignAdr(NYGARD, path);
  const draft = draftFrontMatter(adr, { appliesTo: ['src/**'], rules: [] });
  writeProposal(root, draft);
  assert.equal(readFileSync(path, 'utf8'), NYGARD);
});

test('writeProposal rejects a path outside the proposals directory', (t) => {
  const root = project(t);
  assert.throws(() => writeProposal(root, { path: 'docs/adr/0002-nygard.md', markdown: 'changed' }));
});

test('writeProposal creates the proposals directory when it is absent', (t) => {
  const root = project(t);
  const path = foreignFile(root, '0002-nygard.md', NYGARD);
  const adr = parseForeignAdr(NYGARD, path);
  const draft = draftFrontMatter(adr, { appliesTo: ['src/**'], rules: [] });
  writeProposal(root, draft);
  assert.equal(existsSync(join(root, '.delivery', 'adr-proposals')), true);
});
