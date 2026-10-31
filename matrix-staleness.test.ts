// Behavioral tests for git-anchored link staleness.
//
// Every scenario uses a real temporary git repository and asserts one public
// outcome: how a link is classified by `gitStaleness` after a commit, rename,
// deletion, working-tree edit or entity-source change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitAnchor, gitStaleness, type GitLink } from './matrix-staleness.ts';

function git(dir: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function repo(t: any, contents: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'junior-git-staleness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  for (const [path, content] of Object.entries(contents)) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

function commitAll(dir: string, message: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

function linkFor(dir: string, path: string, overrides: Partial<GitLink> = {}): GitLink {
  const blob = git(dir, ['rev-parse', `HEAD:${path}`]);
  return { feature: 'cpm:d1', path, commit: git(dir, ['rev-parse', 'HEAD']), blob, ...overrides };
}

test('gitAnchor records the HEAD commit and the path blob id', (t) => {
  const dir = repo(t, { 'src/a.ts': 'hello\n' });
  const anchor = gitAnchor({ dir, path: 'src/a.ts' });
  assert.deepEqual(anchor, {
    commit: git(dir, ['rev-parse', 'HEAD']),
    blob: git(dir, ['rev-parse', 'HEAD:src/a.ts']),
  });
});

test('gitStaleness reports an unchanged checkout link as current', (t) => {
  const dir = repo(t, { 'src/a.ts': 'hello\n' });
  const result = gitStaleness({ dir, links: [linkFor(dir, 'src/a.ts')] });
  assert.deepEqual(result.current.map((entry) => entry.path), ['src/a.ts']);
});

test('gitStaleness reports a committed edit as changed', (t) => {
  const dir = repo(t, { 'src/a.ts': 'hello\n' });
  const link = linkFor(dir, 'src/a.ts');
  writeFileSync(join(dir, 'src/a.ts'), 'hello again\n');
  commitAll(dir, 'edit');
  const result = gitStaleness({ dir, links: [link] });
  assert.deepEqual(result.changed.map((entry) => entry.path), ['src/a.ts']);
});

test('gitStaleness reports a committed rename as moved to the new path', (t) => {
  const dir = repo(t, { 'src/a.ts': 'hello\n' });
  const link = linkFor(dir, 'src/a.ts');
  git(dir, ['mv', 'src/a.ts', 'src/b.ts']);
  commitAll(dir, 'rename');
  const result = gitStaleness({ dir, links: [link] });
  assert.deepEqual(result.moved.map((entry) => ({ from: entry.from, to: entry.to })), [
    { from: 'src/a.ts', to: 'src/b.ts' },
  ]);
});

test('gitStaleness reports a committed removal as deleted', (t) => {
  const dir = repo(t, { 'src/a.ts': 'hello\n' });
  const link = linkFor(dir, 'src/a.ts');
  git(dir, ['rm', '-q', 'src/a.ts']);
  commitAll(dir, 'remove');
  const result = gitStaleness({ dir, links: [link] });
  assert.deepEqual(result.deleted.map((entry) => entry.path), ['src/a.ts']);
});

test('gitStaleness reports a link without a git anchor as unanchored', (t) => {
  const dir = repo(t, { 'src/a.ts': 'hello\n' });
  const result = gitStaleness({ dir, links: [{ feature: 'cpm:d1', path: 'src/a.ts' }] });
  assert.deepEqual(result.unanchored.map((entry) => entry.path), ['src/a.ts']);
});

test('gitStaleness reports an entity source changed since the link commit', (t) => {
  const dir = repo(t, { 'src/a.ts': 'hello\n', '.jevitate/journeys/checkout.json': '{"v":1}\n' });
  const link = linkFor(dir, 'src/a.ts', { entityPath: '.jevitate/journeys/checkout.json' });
  writeFileSync(join(dir, '.jevitate/journeys/checkout.json'), '{"v":2}\n');
  commitAll(dir, 'update journey');
  const result = gitStaleness({ dir, links: [link] });
  assert.deepEqual(result.entityChanged.map((entry) => entry.feature), ['cpm:d1']);
});

test('gitStaleness treats an unstaged working-tree edit as current without reading the file', (t) => {
  const dir = repo(t, { 'src/a.ts': 'hello\n' });
  const link = linkFor(dir, 'src/a.ts');
  rmSync(join(dir, 'src/a.ts'));
  const result = gitStaleness({ dir, links: [link] });
  assert.deepEqual(result.current.map((entry) => entry.path), ['src/a.ts']);
});
