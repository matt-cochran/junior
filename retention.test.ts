// ---------------------------------------------------------------------------
// Behavioral tests for retained-worktree retention and pruning.
//
// Every scenario builds a disposable real Git fixture and drives the public
// retention API. Each test asserts exactly one observable outcome: a worktree
// is present/absent, a candidate is reported, or a summary count is returned.
// The source checkout and any non-Junior worktree must never be touched.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireLock, createDetachedWorktree } from './isolation.ts';
import {
  directoryUsage,
  juniorWorktreeMeta,
  listJuniorWorktrees,
  parseDuration,
  pruneWorktrees,
  retainedWorktreeSummary,
} from './retention.ts';
import { doctor } from './setup.ts';

const gitRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'junior-retain-'));
  const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'tester']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(['add', 'base.txt']);
  git(['commit', '-qm', 'base']);
  return { dir, git };
};

const artifactDir = (repo: any, id: string, stamp: string) => join(repo.dir, '.delivery', id, stamp);

/** Create a registered Junior-shaped worktree with a saved result artifact. */
const addWorktree = (repo: any, id: string, stamp: string) => {
  const art = artifactDir(repo, id, stamp);
  const worktree = join(art, 'worktree');
  mkdirSync(dirname(worktree), { recursive: true });
  const made = createDetachedWorktree(repo.dir, worktree);
  if (!made.ok) throw Error(made.error);
  writeFileSync(join(art, 'result.json'), '{}');
  writeFileSync(join(art, 'worker.log'), '');
  return { art, worktree };
};

const registeredPaths = (repo: any) =>
  spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo.dir, encoding: 'utf8' }).stdout;

// --- duration parsing -------------------------------------------------------

test('parseDuration reads an hours duration', () => assert.equal(parseDuration('24h'), 86_400_000));
test('parseDuration reads a minutes duration', () => assert.equal(parseDuration('30m'), 1_800_000));
test('parseDuration rejects an unknown unit', () => assert.equal(parseDuration('24w'), null));
test('parseDuration rejects free text', () => assert.equal(parseDuration('later'), null));

// --- path classification ----------------------------------------------------

test('juniorWorktreeMeta rejects a path that escapes the delivery directory', () => {
  const repo = gitRepo();
  assert.equal(juniorWorktreeMeta(repo.dir, join(repo.dir, '..', 'escape', 'worktree')), null);
});

test('juniorWorktreeMeta rejects a delivery path that is not a run worktree', () => {
  const repo = gitRepo();
  assert.equal(juniorWorktreeMeta(repo.dir, join(repo.dir, '.delivery', 'loose-dir')), null);
});

// --- listing ----------------------------------------------------------------

test('listJuniorWorktrees finds a registered Junior worktree', () => {
  const repo = gitRepo();
  const { worktree } = addWorktree(repo, 'd1', '1000');
  assert.deepEqual(listJuniorWorktrees(repo.dir).map((w) => w.path), [worktree]);
});

test('listJuniorWorktrees ignores a worktree outside the delivery directory', () => {
  const repo = gitRepo();
  createDetachedWorktree(repo.dir, join(repo.dir, 'other-wt'));
  assert.equal(listJuniorWorktrees(repo.dir).length, 0);
});

// --- clean prune ------------------------------------------------------------

test('prune removes a clean inactive Junior worktree', () => {
  const repo = gitRepo();
  const { worktree } = addWorktree(repo, 'd1', '1000');
  pruneWorktrees(repo.dir, {});
  assert.equal(existsSync(worktree), false);
});

test('prune deregisters the removed worktree', () => {
  const repo = gitRepo();
  const { worktree } = addWorktree(repo, 'd1', '1000');
  pruneWorktrees(repo.dir, {});
  assert.ok(!registeredPaths(repo).includes(worktree));
});

test('prune preserves the run result artifact', () => {
  const repo = gitRepo();
  const { art } = addWorktree(repo, 'd1', '1000');
  pruneWorktrees(repo.dir, {});
  assert.equal(existsSync(join(art, 'result.json')), true);
});

// --- skip reasons -----------------------------------------------------------

test('prune skips a worktree with unreviewed changes', () => {
  const repo = gitRepo();
  const { worktree } = addWorktree(repo, 'd1', '1000');
  writeFileSync(join(worktree, 'unreviewed.txt'), 'x');
  pruneWorktrees(repo.dir, {});
  assert.equal(existsSync(worktree), true);
});

test('prune reports a worktree with unreviewed changes as skipped', () => {
  const repo = gitRepo();
  const { worktree } = addWorktree(repo, 'd1', '1000');
  writeFileSync(join(worktree, 'unreviewed.txt'), 'x');
  const result = pruneWorktrees(repo.dir, {});
  assert.ok(result.skipped.some((s) => s.path === worktree && /unreviewed|dirty/i.test(s.reason)));
});

test('prune preserves a clean detached worktree with an unreviewed commit', () => {
  const repo = gitRepo();
  const { worktree } = addWorktree(repo, 'd1', '1000');
  const git = (args: string[]) => spawnSync('git', args, { cwd: worktree, encoding: 'utf8' });
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'tester']);
  writeFileSync(join(worktree, 'unreviewed.txt'), 'x');
  git(['add', 'unreviewed.txt']);
  git(['commit', '-qm', 'unreviewed work']);
  pruneWorktrees(repo.dir, {});
  assert.equal(existsSync(worktree), true);
});

test('prune reports a clean detached unreviewed commit as skipped', () => {
  const repo = gitRepo();
  const { worktree } = addWorktree(repo, 'd1', '1000');
  const git = (args: string[]) => spawnSync('git', args, { cwd: worktree, encoding: 'utf8' });
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'tester']);
  writeFileSync(join(worktree, 'unreviewed.txt'), 'x');
  git(['add', 'unreviewed.txt']);
  git(['commit', '-qm', 'unreviewed work']);
  const result = pruneWorktrees(repo.dir, {});
  assert.ok(result.skipped.some((s) => s.path === worktree && /unreachable|unreviewed|commit/i.test(s.reason)));
});

test('prune skips an actively locked worktree', () => {
  const repo = gitRepo();
  const { worktree } = addWorktree(repo, 'd1', '1000');
  const held = acquireLock(join(repo.dir, '.delivery', 'locks'), `checkout:${worktree}`, {});
  try {
    pruneWorktrees(repo.dir, {});
    assert.equal(existsSync(worktree), true);
  } finally {
    held.handle?.release();
  }
});

test('prune leaves an existing active checkout lock in place', () => {
  const repo = gitRepo();
  const { worktree } = addWorktree(repo, 'd1', '1000');
  const held = acquireLock(join(repo.dir, '.delivery', 'locks'), `checkout:${worktree}`, {});
  try {
    pruneWorktrees(repo.dir, {});
    assert.equal(existsSync(held.lockPath), true);
  } finally {
    held.handle?.release();
  }
});

test('prune skips a symlinked worktree path', () => {
  const repo = gitRepo();
  const { worktree } = addWorktree(repo, 'd1', '1000');
  rmSync(worktree, { recursive: true, force: true });
  const outside = join(repo.dir, 'outside');
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, worktree);
  pruneWorktrees(repo.dir, {});
  assert.equal(lstatSync(worktree).isSymbolicLink(), true);
});

test('prune leaves a foreign worktree outside the delivery directory untouched', () => {
  const repo = gitRepo();
  const foreign = join(repo.dir, 'other-wt');
  createDetachedWorktree(repo.dir, foreign);
  pruneWorktrees(repo.dir, {});
  assert.equal(existsSync(foreign), true);
});

test('prune never removes the source checkout', () => {
  const repo = gitRepo();
  addWorktree(repo, 'd1', '1000');
  pruneWorktrees(repo.dir, {});
  assert.equal(existsSync(join(repo.dir, 'base.txt')), true);
});

// --- age and count selection ------------------------------------------------

test('prune --keep-last retains the newest worktree', () => {
  const repo = gitRepo();
  addWorktree(repo, 'd1', '1000');
  const { worktree: newest } = addWorktree(repo, 'd2', '2000');
  pruneWorktrees(repo.dir, { keepLast: 1 });
  assert.equal(existsSync(newest), true);
});

test('prune --keep-last removes the older worktree', () => {
  const repo = gitRepo();
  const { worktree: oldest } = addWorktree(repo, 'd1', '1000');
  addWorktree(repo, 'd2', '2000');
  pruneWorktrees(repo.dir, { keepLast: 1 });
  assert.equal(existsSync(oldest), false);
});

test('prune --older-than retains a newer worktree', () => {
  const repo = gitRepo();
  const { worktree: newer } = addWorktree(repo, 'd1', String(Date.now()));
  pruneWorktrees(repo.dir, { olderThanMs: 3_600_000 });
  assert.equal(existsSync(newer), true);
});

test('prune --older-than removes an older worktree', () => {
  const repo = gitRepo();
  const { worktree: older } = addWorktree(repo, 'd1', String(Date.now() - 7_200_000));
  pruneWorktrees(repo.dir, { olderThanMs: 3_600_000 });
  assert.equal(existsSync(older), false);
});

// --- dry run ----------------------------------------------------------------

test('prune --dry-run reports the candidate it would remove', () => {
  const repo = gitRepo();
  const { worktree } = addWorktree(repo, 'd1', '1000');
  assert.deepEqual(pruneWorktrees(repo.dir, { dryRun: true }).removed, [worktree]);
});

test('prune --dry-run leaves the worktree on disk', () => {
  const repo = gitRepo();
  const { worktree } = addWorktree(repo, 'd1', '1000');
  pruneWorktrees(repo.dir, { dryRun: true });
  assert.equal(existsSync(worktree), true);
});

// --- summary and doctor -----------------------------------------------------

test('retainedWorktreeSummary counts retained Junior worktrees', () => {
  const repo = gitRepo();
  addWorktree(repo, 'd1', '1000');
  assert.equal(retainedWorktreeSummary(repo.dir).count, 1);
});

test('retainedWorktreeSummary reports a positive disk usage', () => {
  const repo = gitRepo();
  addWorktree(repo, 'd1', '1000');
  assert.ok(retainedWorktreeSummary(repo.dir).bytes > 0);
});

test('directoryUsage reports truncation when an entry limit stops the walk', () => {
  const repo = gitRepo();
  const { worktree } = addWorktree(repo, 'd1', '1000');
  assert.equal(directoryUsage(worktree, { maxEntries: 0 }).truncated, true);
});

test('retainedWorktreeSummary does not follow a symlinked worktree root outside the delivery directory', () => {
  const repo = gitRepo();
  const { worktree } = addWorktree(repo, 'd1', '1000');
  rmSync(worktree, { recursive: true, force: true });
  const outside = join(repo.dir, 'outside-large');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'blob.bin'), Buffer.alloc(4096));
  symlinkSync(outside, worktree);
  assert.equal(retainedWorktreeSummary(repo.dir).bytes, 0);
});

test('doctor exposes the retained worktree count', () => {
  const repo = gitRepo();
  addWorktree(repo, 'd1', '1000');
  const result = doctor({ cwd: repo.dir, env: { PATH: '' }, execPath: join(repo.dir, 'node'), nodeVersion: '26.5.0' });
  assert.equal(result.retention.count, 1);
});

test('doctor leaves retained worktrees on disk during a read-only check', () => {
  const repo = gitRepo();
  const { worktree } = addWorktree(repo, 'd1', '1000');
  doctor({ cwd: repo.dir, env: { PATH: '' }, execPath: join(repo.dir, 'node'), nodeVersion: '26.5.0' });
  assert.equal(existsSync(worktree), true);
});

test('retention inventory does not measure a symlinked delivery directory', () => {
  const repo = gitRepo();
  const outside = mkdtempSync(join(tmpdir(), 'junior-retain-external-'));
  symlinkSync(outside, join(repo.dir, '.delivery'));
  addWorktree(repo, 'd1', '1000');
  assert.equal(retainedWorktreeSummary(repo.dir).bytes, 0);
});