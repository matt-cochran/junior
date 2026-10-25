// ---------------------------------------------------------------------------
// Behavioral tests for applying a reviewed handoff worktree diff.
//
// Every scenario builds disposable real Git repositories with a linked
// worktree, writes a result.json artifact and drives the public applyHandoff
// API. Each test asserts exactly one observable outcome: a source file's
// content or existence, the apply receipt, or the refusal error. No fixture is
// left behind.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyHandoff } from './apply.ts';

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

/** A temporary arena removed when the test finishes. */
const arena = (t: any): string => {
  const dir = mkdtempSync(join(tmpdir(), 'junior-apply-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A committed source checkout at <root>/source. */
const sourceRepo = (root: string): string => {
  const dir = join(root, 'source');
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

/** A handoff artifact under <source>/.delivery/<id>/<stamp> with a detached
 * worktree mutated by `mutate`, plus a result.json the apply API can read. */
const makeRun = (source: string, id: string, stamp: string, mutate: (wt: string) => void, status = 'ready_for_review', extra: Record<string, unknown> = {}) => {
  const art = join(source, '.delivery', id, stamp);
  const wt = join(art, 'worktree');
  mkdirSync(art, { recursive: true });
  const added = git(source, ['worktree', 'add', '-q', '--detach', wt, 'HEAD']);
  if (added.status !== 0) throw Error(added.stderr || `git worktree add exited ${added.status}`);
  mutate(wt);
  writeFileSync(join(art, 'result.json'), JSON.stringify({ id, status, isolation: { mode: 'worktree', worktree: wt }, ...extra }));
  return { art, wt, resultPath: join(art, 'result.json') };
};

/** A primary checkout at commit A with a linked worktree on descendant B. */
const linkedSource = (root: string): { primary: string; lane: string } => {
  const primary = sourceRepo(root);
  const base = git(primary, ['rev-parse', 'HEAD']).stdout.trim();
  writeFileSync(join(primary, 'base.txt'), 'descendant\n');
  git(primary, ['add', 'base.txt']);
  git(primary, ['commit', '-qm', 'descendant']);
  const lane = join(root, 'lane');
  const added = git(primary, ['worktree', 'add', '-q', '-b', 'lane', lane, 'HEAD']);
  if (added.status !== 0) throw Error(added.stderr || `git worktree add exited ${added.status}`);
  git(primary, ['reset', '--hard', '-q', base]);
  return { primary, lane };
};

// --- id resolution -----------------------------------------------------------

test('applyHandoff resolves a deliverable id to the newest run', (t) => {
  const root = arena(t);
  const source = sourceRepo(root);
  const run = (stamp: string, text: string) => makeRun(source, 'handoff-id', stamp, (wt) => writeFileSync(join(wt, 'base.txt'), text));
  run('1000', 'older\n');
  run('2000', 'newest\n');
  applyHandoff('handoff-id', { cwd: source });
  assert.equal(readFileSync(join(source, 'base.txt'), 'utf8'), 'newest\n');
});

// --- untracked file ----------------------------------------------------------

test('applyHandoff applies a new untracked worktree file', (t) => {
  const root = arena(t);
  const source = sourceRepo(root);
  const { resultPath } = makeRun(source, 'handoff-new', '1000', (wt) => writeFileSync(join(wt, 'new.txt'), 'added\n'));
  applyHandoff(resultPath, { cwd: source });
  assert.equal(readFileSync(join(source, 'new.txt'), 'utf8'), 'added\n');
});

// --- status gating -----------------------------------------------------------

test('applyHandoff refuses a run whose status is not ready_for_review', (t) => {
  const root = arena(t);
  const source = sourceRepo(root);
  const { resultPath } = makeRun(source, 'handoff-bad', '1000', () => {}, 'failed');
  const r = applyHandoff(resultPath, { cwd: source });
  assert.match(r.error ?? '', /ready_for_review/);
});

test('applyHandoff force applies a run whose status is not ready_for_review', (t) => {
  const root = arena(t);
  const source = sourceRepo(root);
  const { resultPath } = makeRun(source, 'handoff-force', '1000', (wt) => writeFileSync(join(wt, 'base.txt'), 'forced\n'), 'failed');
  const r = applyHandoff(resultPath, { cwd: source, force: true });
  assert.equal(r.applied, true);
});

// --- isolation gating --------------------------------------------------------

test('applyHandoff refuses a run without worktree isolation', (t) => {
  const root = arena(t);
  const source = sourceRepo(root);
  const art = join(source, '.delivery', 'handoff-plain', '1000');
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, 'result.json'), JSON.stringify({ id: 'handoff-plain', status: 'ready_for_review', isolation: { mode: 'none' } }));
  const r = applyHandoff(join(art, 'result.json'), { cwd: source });
  assert.match(r.error ?? '', /isolation/);
});

// --- ancestry gating ---------------------------------------------------------

test('applyHandoff refuses a worktree whose HEAD is not an ancestor of source HEAD', (t) => {
  const root = arena(t);
  const source = sourceRepo(root);
  const { resultPath, wt } = makeRun(source, 'handoff-moved', '1000', (work) => {
    writeFileSync(join(work, 'base.txt'), 'worktree\n');
    git(work, ['add', 'base.txt']);
    git(work, ['commit', '-qm', 'worktree-only']);
  });
  const r = applyHandoff(resultPath, { cwd: source });
  assert.match(r.error ?? '', /ancestor/);
});

// --- recorded source worktree -------------------------------------------------

test('applyHandoff dry run validates ancestry against the recorded source worktree HEAD', (t) => {
  const root = arena(t);
  const { primary, lane } = linkedSource(root);
  const { resultPath } = makeRun(lane, 'handoff-lane-dry', '1000', (wt) => writeFileSync(join(wt, 'base.txt'), 'worktree\n'), 'ready_for_review', { sourceCwd: lane });
  const r = applyHandoff(resultPath, { cwd: primary, dryRun: true });
  assert.equal(r.error, undefined);
});

test('applyHandoff applies the diff to the recorded source worktree', (t) => {
  const root = arena(t);
  const { primary, lane } = linkedSource(root);
  const { resultPath } = makeRun(lane, 'handoff-lane-apply', '1000', (wt) => writeFileSync(join(wt, 'base.txt'), 'worktree\n'), 'ready_for_review', { sourceCwd: lane });
  applyHandoff(resultPath, { cwd: primary });
  assert.equal(readFileSync(join(lane, 'base.txt'), 'utf8'), 'worktree\n');
});

test('applyHandoff leaves the primary checkout untouched when the recorded source is a linked worktree', (t) => {
  const root = arena(t);
  const { primary, lane } = linkedSource(root);
  git(primary, ['reset', '--hard', '-q', 'lane']);
  writeFileSync(join(primary, 'primary-only.txt'), 'primary\n');
  git(primary, ['add', 'primary-only.txt']);
  git(primary, ['commit', '-qm', 'primary descendant']);
  const { resultPath } = makeRun(lane, 'handoff-lane-primary', '1000', (wt) => writeFileSync(join(wt, 'base.txt'), 'worktree\n'), 'ready_for_review', { sourceCwd: lane });
  applyHandoff(resultPath, { cwd: primary });
  assert.equal(readFileSync(join(primary, 'base.txt'), 'utf8'), 'descendant\n');
});

test('applyHandoff records the resolved source worktree as the apply target', (t) => {
  const root = arena(t);
  const { primary, lane } = linkedSource(root);
  const { art, resultPath } = makeRun(lane, 'handoff-lane-record', '1000', (wt) => writeFileSync(join(wt, 'base.txt'), 'worktree\n'), 'ready_for_review', { sourceCwd: lane });
  applyHandoff(resultPath, { cwd: primary });
  const record = JSON.parse(readFileSync(join(art, 'applied.json'), 'utf8'));
  assert.equal(record.target, lane);
});

// --- dry run -----------------------------------------------------------------

test('applyHandoff dry run leaves the source working tree unchanged', (t) => {
  const root = arena(t);
  const source = sourceRepo(root);
  const { resultPath } = makeRun(source, 'handoff-dry', '1000', (wt) => writeFileSync(join(wt, 'base.txt'), 'worktree\n'));
  applyHandoff(resultPath, { cwd: source, dryRun: true });
  assert.equal(readFileSync(join(source, 'base.txt'), 'utf8'), 'base\n');
});

// --- conflicting source ------------------------------------------------------

test('applyHandoff leaves the source working tree unchanged when the diff conflicts', (t) => {
  const root = arena(t);
  const source = sourceRepo(root);
  const { resultPath } = makeRun(source, 'handoff-conflict', '1000', (wt) => writeFileSync(join(wt, 'base.txt'), 'worktree\n'));
  writeFileSync(join(source, 'base.txt'), 'source\n');
  git(source, ['add', 'base.txt']);
  git(source, ['commit', '-qm', 'source-change']);
  applyHandoff(resultPath, { cwd: source });
  assert.equal(readFileSync(join(source, 'base.txt'), 'utf8'), 'source\n');
});

// --- applied record ----------------------------------------------------------

test('applyHandoff records the hash of the patch it applied', (t) => {
  const root = arena(t);
  const source = sourceRepo(root);
  const { art, wt, resultPath } = makeRun(source, 'handoff-record', '1000', (work) => writeFileSync(join(work, 'base.txt'), 'worktree\n'));
  applyHandoff(resultPath, { cwd: source });
  git(wt, ['add', '-A', '-N']);
  const patch = git(wt, ['diff', '--binary', 'HEAD']).stdout;
  const expected = createHash('sha256').update(patch).digest('hex');
  const record = JSON.parse(readFileSync(join(art, 'applied.json'), 'utf8'));
  assert.equal(record.patchSha256, expected);
});

test('applyHandoff records when it applied', (t) => {
  const root = arena(t);
  const source = sourceRepo(root);
  const { art, resultPath } = makeRun(source, 'handoff-stamp', '1000', (work) => writeFileSync(join(work, 'base.txt'), 'worktree\n'));
  applyHandoff(resultPath, { cwd: source });
  const record = JSON.parse(readFileSync(join(art, 'applied.json'), 'utf8'));
  assert.ok(!Number.isNaN(Date.parse(record.appliedAt)));
});

test('applyHandoff dry run writes no applied record', (t) => {
  const root = arena(t);
  const source = sourceRepo(root);
  const { art, resultPath } = makeRun(source, 'handoff-dry-record', '1000', (work) => writeFileSync(join(work, 'base.txt'), 'worktree\n'));
  applyHandoff(resultPath, { cwd: source, dryRun: true });
  assert.equal(existsSync(join(art, 'applied.json')), false);
});
