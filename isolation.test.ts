// ---------------------------------------------------------------------------
// Behavioral tests for Git-applied local exclusions in isolation.ts.
//
// Every scenario builds a disposable real Git fixture under os.tmpdir() and
// drives the public ensureLocalExcludes API. Each test asserts exactly one
// observable outcome: a checkout stays clean, the shared exclude file is
// reused, existing bytes survive, or an unapplied pattern is reported. No
// temporary repository is left behind.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLocalExcludes, provisionIsolationSetup, validateIsolationSetup } from './isolation.ts';

const GENERATED = ['/.delivery/', '/delivery.config.json', '/tasks/example-task.json'];

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const status = (cwd: string) => (git(cwd, ['status', '--porcelain']).stdout ?? '').trim();

/** A temporary arena removed when the test finishes. */
const arena = (t: any): string => {
  const dir = mkdtempSync(join(tmpdir(), 'junior-exclude-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A committed repository at <root>/main. */
const repoIn = (root: string): string => {
  const dir = join(root, 'main');
  mkdirSync(dir);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'tester']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', 'base.txt']);
  git(dir, ['commit', '-qm', 'base']);
  return dir;
};

/** A detached linked worktree of `repo` at <root>/<name>. */
const worktreeIn = (repo: string, root: string, name: string): string => {
  const path = join(root, name);
  const r = git(repo, ['worktree', 'add', '-q', '--detach', path, 'HEAD']);
  if (r.status !== 0) throw Error(r.stderr || `git worktree add exited ${r.status}`);
  return path;
};

/** Create the generated files that the requested patterns are meant to hide. */
const createGeneratedFiles = (cwd: string): void => {
  mkdirSync(join(cwd, '.delivery', 'run'), { recursive: true });
  writeFileSync(join(cwd, '.delivery', 'run', 'result.json'), '{}\n');
  writeFileSync(join(cwd, 'delivery.config.json'), '{}\n');
  mkdirSync(join(cwd, 'tasks'), { recursive: true });
  writeFileSync(join(cwd, 'tasks', 'example-task.json'), '{}\n');
};

const excludeFile = (repo: string): string => join(repo, '.git', 'info', 'exclude');
const occurrences = (text: string, line: string) => text.split('\n').filter((l) => l.trim() === line).length;

// --- main checkout -----------------------------------------------------------

test('ensureLocalExcludes keeps a main checkout clean when generated paths exist', (t) => {
  const repo = repoIn(arena(t));
  createGeneratedFiles(repo);
  ensureLocalExcludes(repo, GENERATED);
  assert.equal(status(repo), '');
});

// --- linked worktree ---------------------------------------------------------

test('ensureLocalExcludes keeps a linked worktree clean when generated paths exist', (t) => {
  const root = arena(t);
  const repo = repoIn(root);
  const wt = worktreeIn(repo, root, 'wt1');
  createGeneratedFiles(wt);
  ensureLocalExcludes(wt, GENERATED);
  assert.equal(status(wt), '');
});

// --- idempotence -------------------------------------------------------------

test('a repeated ensureLocalExcludes reports no newly added patterns', (t) => {
  const repo = repoIn(arena(t));
  createGeneratedFiles(repo);
  ensureLocalExcludes(repo, GENERATED);
  const second = ensureLocalExcludes(repo, GENERATED);
  assert.deepEqual(second.added, []);
});

test('a repeated ensureLocalExcludes stores one copy of each pattern', (t) => {
  const repo = repoIn(arena(t));
  ensureLocalExcludes(repo, ['/.delivery/']);
  ensureLocalExcludes(repo, ['/.delivery/']);
  assert.equal(occurrences(readFileSync(excludeFile(repo), 'utf8'), '/.delivery/'), 1);
});

// --- two linked worktrees ----------------------------------------------------

test('two linked worktrees share one exclude file', (t) => {
  const root = arena(t);
  const repo = repoIn(root);
  const first = ensureLocalExcludes(worktreeIn(repo, root, 'wt1'), GENERATED);
  const second = ensureLocalExcludes(worktreeIn(repo, root, 'wt2'), GENERATED);
  assert.equal(first.path, second.path);
});

test('two linked worktrees store one copy of each shared pattern', (t) => {
  const root = arena(t);
  const repo = repoIn(root);
  ensureLocalExcludes(worktreeIn(repo, root, 'wt1'), GENERATED);
  ensureLocalExcludes(worktreeIn(repo, root, 'wt2'), GENERATED);
  assert.equal(occurrences(readFileSync(excludeFile(repo), 'utf8'), '/.delivery/'), 1);
});

// --- preservation ------------------------------------------------------------

test('ensureLocalExcludes preserves pre-existing exclude content byte for byte', (t) => {
  const repo = repoIn(arena(t));
  const before = 'custom pattern\n# a comment\n';
  writeFileSync(excludeFile(repo), before);
  ensureLocalExcludes(repo, ['/.delivery/']);
  assert.equal(readFileSync(excludeFile(repo), 'utf8').slice(0, before.length), before);
});

// --- unapplied patterns ------------------------------------------------------

test('ensureLocalExcludes reports a pattern Git does not ignore as unapplied', (t) => {
  const repo = repoIn(arena(t));
  assert.deepEqual(ensureLocalExcludes(repo, ['!keep']).unapplied, ['!keep']);
});

test('ensureLocalExcludes omits an unapplied pattern from added', (t) => {
  const repo = repoIn(arena(t));
  assert.deepEqual(ensureLocalExcludes(repo, ['!keep']).added, []);
});

test('ensureLocalExcludes names an unapplied pattern in its error', (t) => {
  const repo = repoIn(arena(t));
  assert.match(ensureLocalExcludes(repo, ['!keep']).error ?? '', /!keep/);
});

// ---------------------------------------------------------------------------
// isolationSetup validation names the expected entry shapes before any paid
// call, so a malformed contract can be corrected without guessing.
// ---------------------------------------------------------------------------

test('a string links entry names the from and to fields', () => {
  assert.throws(() => validateIsolationSetup({ links: ['node_modules'] }), /from.*to/);
});

test('a non-string copy entry names the expected relative path string', () => {
  assert.throws(() => validateIsolationSetup({ copy: [{ path: 'deps' }] }), /copy entry.*string/);
});

test('a non-object commands entry names the command and args fields', () => {
  assert.throws(() => validateIsolationSetup({ commands: ['npm ci'] }), /command.*args/);
});

// ---------------------------------------------------------------------------
// Idempotent isolation setup provisioning (links and copies).
//
// The resume path reuses a prior worktree where isolationSetup already ran, so
// provisioning must treat an identical existing symlink as satisfied while
// still reporting a conflicting destination (different symlink, file, dir).
// Every fixture lives under os.tmpdir() and is removed by the arena helper.
// ---------------------------------------------------------------------------

const SETUP_OPTS = { deadlineAt: Date.now() + 60_000, checkTimeoutMs: 5_000 };

/** Source and worktree directories plus a node_modules link source. */
const setupFixture = (t: any) => {
  const root = arena(t);
  const source = join(root, 'source');
  const worktree = join(root, 'worktree');
  mkdirSync(join(source, 'node_modules'), { recursive: true });
  writeFileSync(join(source, 'node_modules', 'pkg.txt'), 'pkg\n');
  mkdirSync(worktree);
  return { root, source, worktree };
};

const NODE_MODULES_LINK = { links: [{ from: 'node_modules', to: 'node_modules' }] };

// --- links -------------------------------------------------------------------

test('provisioning a link twice into the same worktree succeeds the second time', (t) => {
  const { source, worktree } = setupFixture(t);
  provisionIsolationSetup(NODE_MODULES_LINK, source, worktree, '', SETUP_OPTS);
  const second = provisionIsolationSetup(NODE_MODULES_LINK, source, worktree, '', SETUP_OPTS);
  assert.equal(second.ok, true);
});

test('a repeated link provisioning logs that the link is already present', (t) => {
  const { root, source, worktree } = setupFixture(t);
  const artifacts = join(root, 'artifacts');
  mkdirSync(artifacts);
  provisionIsolationSetup(NODE_MODULES_LINK, source, worktree, artifacts, SETUP_OPTS);
  provisionIsolationSetup(NODE_MODULES_LINK, source, worktree, artifacts, SETUP_OPTS);
  assert.match(readFileSync(join(artifacts, 'isolation-setup.log'), 'utf8'), /link node_modules already present/);
});

test('a link destination symlink pointing at a different target fails', (t) => {
  const { source, worktree } = setupFixture(t);
  mkdirSync(join(source, 'other'));
  symlinkSync(join(source, 'other'), join(worktree, 'node_modules'), 'dir');
  const result = provisionIsolationSetup(NODE_MODULES_LINK, source, worktree, '', SETUP_OPTS);
  assert.equal(result.ok, false);
});

test('a conflicting link failure names the destination path', (t) => {
  const { source, worktree } = setupFixture(t);
  mkdirSync(join(source, 'other'));
  symlinkSync(join(source, 'other'), join(worktree, 'node_modules'), 'dir');
  const result = provisionIsolationSetup(NODE_MODULES_LINK, source, worktree, '', SETUP_OPTS);
  assert.match(result.error ?? '', /node_modules/);
});

test('a regular file at the link destination still fails', (t) => {
  const { source, worktree } = setupFixture(t);
  writeFileSync(join(worktree, 'node_modules'), 'occupied\n');
  const result = provisionIsolationSetup(NODE_MODULES_LINK, source, worktree, '', SETUP_OPTS);
  assert.equal(result.ok, false);
});

// --- copies ------------------------------------------------------------------

test('provisioning a copied symlink twice succeeds the second time', (t) => {
  const { source, worktree } = setupFixture(t);
  symlinkSync(join(source, 'node_modules'), join(source, 'deps'), 'dir');
  const setup = { copy: ['deps'] };
  provisionIsolationSetup(setup, source, worktree, '', SETUP_OPTS);
  const second = provisionIsolationSetup(setup, source, worktree, '', SETUP_OPTS);
  assert.equal(second.ok, true);
});

test('a copied symlink destination pointing elsewhere fails', (t) => {
  const { source, worktree } = setupFixture(t);
  mkdirSync(join(source, 'other'));
  symlinkSync(join(source, 'node_modules'), join(source, 'deps'), 'dir');
  symlinkSync(join(source, 'other'), join(worktree, 'deps'), 'dir');
  const result = provisionIsolationSetup({ copy: ['deps'] }, source, worktree, '', SETUP_OPTS);
  assert.equal(result.ok, false);
});
