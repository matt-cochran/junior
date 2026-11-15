// Behavioral tests for scaffolding an ADR collection (ADR 0018 R1, R2).
//
// Each scenario is atomic: one observable outcome per test, driven through
// `initAdrs`. Temporary directories stand in for a project checkout; no
// delivery.config.json is written by the initializer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initAdrs } from './adr-init.ts';
import { parseAdr } from './adr.ts';

function project(t: any): string {
  const root = mkdtempSync(join(tmpdir(), 'junior-adr-init-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function touch(root: string, path: string, content = ''): string {
  const absolute = join(root, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
  return absolute;
}

function readme(root: string, dir = 'docs/adr'): string {
  return readFileSync(join(root, dir, 'README.md'), 'utf8');
}

const EXISTING_ADR = [
  '---',
  'id: ADR-0002',
  'title: Existing decision',
  'status: accepted',
  'date: 2026-01-01',
  'supersedes: []',
  'applies_to: [docs/**]',
  'rules:',
  '  - id: R1',
  '    text: Keep the existing decision.',
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
].join('\n');

test('initAdrs creates the default docs/adr directory', (t) => {
  const root = project(t);
  initAdrs(root);
  assert.equal(existsSync(join(root, 'docs', 'adr')), true);
});

test('initAdrs creates a README index with the expected title', (t) => {
  const root = project(t);
  initAdrs(root);
  assert.match(readme(root), /^# Architecture decision records$/m);
});

test('initAdrs gives the README a one-line description', (t) => {
  const root = project(t);
  initAdrs(root);
  assert.match(readme(root), /Architecture decisions for this project are recorded here\./);
});

test('initAdrs lists existing records in the README', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/0002-existing.md', EXISTING_ADR);
  initAdrs(root);
  assert.match(readme(root), /0002-existing\.md/);
});

test('initAdrs lists only files it created', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/0002-existing.md', EXISTING_ADR);
  assert.deepEqual(initAdrs(root).created, ['docs/adr/README.md']);
});

test('initAdrs creates the record decision as 0001 when the directory is empty', (t) => {
  const root = project(t);
  initAdrs(root, { withRecordDecision: true, date: '2026-11-14' });
  assert.equal(existsSync(join(root, 'docs', 'adr', '0001-record-architecture-decisions.md')), true);
});

test('initAdrs creates an accepted record decision', (t) => {
  const root = project(t);
  const result = initAdrs(root, { withRecordDecision: true, date: '2026-11-14' });
  const adr = parseAdr(readFileSync(join(root, result.dir, '0001-record-architecture-decisions.md'), 'utf8'));
  assert.equal(adr.status, 'accepted');
});

test('initAdrs gives the record decision the docs/adr applies_to glob', (t) => {
  const root = project(t);
  const result = initAdrs(root, { withRecordDecision: true, date: '2026-11-14' });
  const adr = parseAdr(readFileSync(join(root, result.dir, '0001-record-architecture-decisions.md'), 'utf8'));
  assert.deepEqual(adr.appliesTo, ['docs/adr/**']);
});

test('initAdrs gives the record decision one R1 rule naming the directory', (t) => {
  const root = project(t);
  const result = initAdrs(root, { withRecordDecision: true, date: '2026-11-14' });
  const adr = parseAdr(readFileSync(join(root, result.dir, '0001-record-architecture-decisions.md'), 'utf8'));
  assert.deepEqual(adr.rules, [
    { id: 'R1', text: 'Significant architecture decisions are recorded as ADRs in docs/adr' },
  ]);
});

test('initAdrs reports every file it created', (t) => {
  const root = project(t);
  const result = initAdrs(root, { withRecordDecision: true, date: '2026-11-14' });
  assert.deepEqual(result.created, [
    'docs/adr/0001-record-architecture-decisions.md',
    'docs/adr/README.md',
  ]);
});

test('initAdrs returns the gate default from the records it created', (t) => {
  const root = project(t);
  const result = initAdrs(root, { withRecordDecision: true, date: '2026-11-14' });
  assert.equal(result.config.gate, 'enforce');
});

test('initAdrs returns the off gate when it created no accepted record', (t) => {
  const root = project(t);
  assert.equal(initAdrs(root).config.gate, 'off');
});

test('initAdrs returns the detected Junior format for a created record', (t) => {
  const root = project(t);
  const result = initAdrs(root, { withRecordDecision: true, date: '2026-11-14' });
  assert.equal(result.config.format, 'junior');
});

test('initAdrs returns the requested directory in the proposed config', (t) => {
  const root = project(t);
  const result = initAdrs(root, { dir: 'decisions' });
  assert.equal(result.config.dir, 'decisions');
});

test('initAdrs scaffolds a custom directory', (t) => {
  const root = project(t);
  initAdrs(root, { dir: 'engineering/decisions' });
  assert.equal(existsSync(join(root, 'engineering', 'decisions', 'README.md')), true);
});

test('initAdrs never overwrites an existing README', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/README.md', 'keep me\n');
  initAdrs(root);
  assert.equal(readme(root), 'keep me\n');
});

test('initAdrs omits a preserved README from created', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/README.md', 'keep me\n');
  assert.deepEqual(initAdrs(root).created, []);
});

test('initAdrs never overwrites an existing record decision', (t) => {
  const root = project(t);
  const existing = touch(root, 'docs/adr/0001-record-architecture-decisions.md', EXISTING_ADR);
  initAdrs(root, { withRecordDecision: true, date: '2026-11-14' });
  assert.equal(readFileSync(existing, 'utf8'), EXISTING_ADR);
});

test('initAdrs reports the existing record decision filename only once', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/0001-record-architecture-decisions.md', EXISTING_ADR);
  const created = initAdrs(root, { withRecordDecision: true, date: '2026-11-14' }).created;
  assert.equal(created.filter((path) => path === 'docs/adr/0001-record-architecture-decisions.md').length, 0);
});

test('initAdrs writes no delivery.config.json', (t) => {
  const root = project(t);
  initAdrs(root, { withRecordDecision: true, date: '2026-11-14' });
  assert.equal(existsSync(join(root, 'delivery.config.json')), false);
});

test('initAdrs adds no second record decision when one already exists', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/0001-record-architecture-decisions.md', EXISTING_ADR);
  initAdrs(root, { withRecordDecision: true, date: '2026-11-14' });
  assert.equal(existsSync(join(root, 'docs/adr/0002-record-architecture-decisions.md')), false);
});

test('initAdrs scopes the record decision to a custom directory', (t) => {
  const root = project(t);
  initAdrs(root, { dir: 'decisions', withRecordDecision: true, date: '2026-11-14' });
  assert.match(readFileSync(join(root, 'decisions/0001-record-architecture-decisions.md'), 'utf8'), /applies_to: \['decisions\/\*\*'\]/);
});

test('initAdrs proposes the ADR prefix pattern for ADR-named records', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/ADR-001-existing.md', EXISTING_ADR);
  assert.equal(initAdrs(root).config.filePattern, '^ADR-(?<number>\\d+[a-z]?)-(?<slug>.+)\\.md$');
});

test('initAdrs lists ADR-named records using the proposed pattern', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/ADR-001-existing.md', EXISTING_ADR);
  initAdrs(root);
  assert.match(readme(root), /ADR-001-existing\.md/);
});
