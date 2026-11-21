// ---------------------------------------------------------------------------
// Behavioral tests for `junior land` (#280, lane E2).
//
// Every scenario builds disposable Git repositories and drives the public
// `land` API. Each test asserts one observable outcome: a file in the
// integration checkout, the land report's verdict, the compile outcome or a
// refusal code. No fixture touches the real home directory or the network.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManualClock } from './clock.ts';
import { land } from './land.ts';
import type { EvidenceIdentity } from './worker-receipt.ts';

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

const arena = (t: any): string => {
  const dir = mkdtempSync(join(tmpdir(), 'junior-land-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const commitBase = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'tester']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', 'base.txt']);
  git(dir, ['commit', '-qm', 'base']);
};

type LaneFixture = { artifactDir: string; resultPath: string; worktree: string };

const lane = (root: string, into: string, id: string, opts: {
  status?: string;
  mutate?: (worktree: string) => void;
  checks?: any[];
} = {}): LaneFixture => {
  const artifactDir = join(root, 'artifacts', id);
  const worktree = join(root, 'worktrees', id);
  mkdirSync(artifactDir, { recursive: true });
  const added = git(into, ['worktree', 'add', '-q', '--detach', worktree, 'HEAD']);
  if (added.status !== 0) throw Error(added.stderr || `git worktree add exited ${added.status}`);
  (opts.mutate ?? ((wt) => writeFileSync(join(wt, 'lane.txt'), `${id}\n`)))(worktree);
  const resultPath = join(artifactDir, 'result.json');
  writeFileSync(resultPath, JSON.stringify({
    id,
    status: opts.status ?? 'ready_for_review',
    isolation: { mode: 'worktree', worktree },
    checks: opts.checks ?? [],
  }));
  return { artifactDir, resultPath, worktree };
};

const config = (cwd: string, value: unknown): void => {
  writeFileSync(join(cwd, 'delivery.config.json'), JSON.stringify(value));
};

const identity = (overrides: Partial<EvidenceIdentity> = {}): EvidenceIdentity => ({
  schema_version: 1,
  tree: 'sha256:tree-a',
  projects: ['.'],
  command: 'node check',
  filter: null,
  dependencyLock: 'sha256:lock-a',
  toolchain: 'node v1',
  ...overrides,
});

// --- applying lanes ---------------------------------------------------------

test('land applies a ready lane into the integration checkout', async (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  const { resultPath } = lane(root, into, 'lane-a');
  await land({ cwd: root, into, lanes: [resultPath] });
  assert.equal(readFileSync(join(into, 'lane.txt'), 'utf8'), 'lane-a\n');
});

test('land refuses a lane whose status is not ready_for_review', async (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  const { resultPath } = lane(root, into, 'lane-draft', { status: 'checks_failed' });
  const report = await land({ cwd: root, into, lanes: [resultPath] });
  assert.equal(report.code, 'E_LAND_NOT_READY');
});

test('land leaves the integration checkout unchanged when a lane is refused', async (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  const { resultPath } = lane(root, into, 'lane-draft', { status: 'checks_failed' });
  await land({ cwd: root, into, lanes: [resultPath] });
  assert.equal(existsSync(join(into, 'lane.txt')), false);
});

test('land stops at the first apply conflict after applying the earlier lane', async (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  const first = lane(root, into, 'lane-first', { mutate: (wt) => writeFileSync(join(wt, 'base.txt'), 'first\n') });
  const second = lane(root, into, 'lane-second', { mutate: (wt) => writeFileSync(join(wt, 'base.txt'), 'second\n') });
  await land({ cwd: root, into, lanes: [first.resultPath, second.resultPath] });
  assert.equal(readFileSync(join(into, 'base.txt'), 'utf8'), 'first\n');
});

test('land reports E_LAND_DIRTY when the integration checkout is not clean', async (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  writeFileSync(join(into, 'untracked.txt'), 'dirty\n');
  const { resultPath } = lane(root, into, 'lane-dirty');
  const report = await land({ cwd: root, into, lanes: [resultPath] });
  assert.equal(report.code, 'E_LAND_DIRTY');
});

test('land reports E_LAND_LANE when a lane target cannot be resolved', async (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  const report = await land({ cwd: root, into, lanes: ['missing-lane'] });
  assert.equal(report.code, 'E_LAND_LANE');
});

test('land reports E_LAND_INTO when --into is not a directory', async (t) => {
  const root = arena(t);
  const into = join(root, 'into-file');
  writeFileSync(into, 'not a directory\n');
  const report = await land({ cwd: root, into, lanes: ['missing-lane'] });
  assert.equal(report.code, 'E_LAND_INTO');
});

test('land creates no missing --into directory', async (t) => {
  const root = arena(t);
  const into = join(root, 'missing-into');
  await land({ cwd: root, into, lanes: ['missing-lane'] });
  assert.equal(existsSync(into), false);
});

// --- evidence reuse ---------------------------------------------------------

test('land reports a check without a stored identity as stale', async (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  const { resultPath } = lane(root, into, 'lane-no-identity', { checks: [{ command: process.execPath, args: ['-e', ''], exitCode: 0 }] });
  const report = await land({ cwd: root, into, lanes: [resultPath] });
  assert.equal(report.lanes[0].checks[0].reason, 'no identity');
});

test('land reports a check whose recomputed identity is equal as reused', async (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  const stored = identity();
  const { resultPath } = lane(root, into, 'lane-reused', { checks: [{ command: process.execPath, args: ['-e', ''], exitCode: 0, identity: stored }] });
  const report = await land({ cwd: root, into, lanes: [resultPath] }, {
    checkIdentity: () => ({ ...stored }),
    identityEqual: () => true,
  });
  assert.equal(report.lanes[0].checks[0].verdict, 'reused');
});

test('land recomputes a lane check after a later lane changes the same project', async (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  const stored = identity({ tree: 'sha256:without-b' });
  const first = lane(root, into, 'lane-project-first', {
    mutate: (wt) => writeFileSync(join(wt, 'a.txt'), 'a\n'),
    checks: [{ command: process.execPath, args: ['-e', ''], exitCode: 0, identity: stored }],
  });
  const second = lane(root, into, 'lane-project-second', { mutate: (wt) => writeFileSync(join(wt, 'b.txt'), 'b\n') });
  const report = await land({ cwd: root, into, lanes: [first.resultPath, second.resultPath] }, {
    checkIdentity: ({ cwd }) => identity({ tree: existsSync(join(cwd, 'b.txt')) ? 'sha256:with-b' : 'sha256:without-b' }),
    identityEqual: (a, b) => a?.tree === b?.tree,
  });
  assert.equal(report.lanes[0].checks[0].verdict, 'stale');
});

test('land marks checks stale when the batch stops at an apply conflict', async (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  const first = lane(root, into, 'lane-incomplete-first', {
    mutate: (wt) => writeFileSync(join(wt, 'base.txt'), 'first\n'),
    checks: [{ command: process.execPath, args: ['-e', ''], exitCode: 0, identity: identity() }],
  });
  const second = lane(root, into, 'lane-incomplete-second', { mutate: (wt) => writeFileSync(join(wt, 'base.txt'), 'second\n') });
  const report = await land({ cwd: root, into, lanes: [first.resultPath, second.resultPath] });
  assert.equal(report.lanes[0].checks[0].reason, 'batch incomplete');
});

test('land names the identity fields that changed when a check is stale', async (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  const stored = identity();
  const { resultPath } = lane(root, into, 'lane-stale', { checks: [{ command: process.execPath, args: ['-e', ''], exitCode: 0, identity: stored }] });
  const report = await land({ cwd: root, into, lanes: [resultPath] }, {
    checkIdentity: () => identity({ tree: 'sha256:tree-b', toolchain: 'node v2' }),
    identityEqual: () => false,
  });
  assert.deepEqual(report.lanes[0].checks[0].changed, ['tree', 'toolchain']);
});

// --- compile ----------------------------------------------------------------

test('land reports compile:null when no compile check is configured', async (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  const { resultPath } = lane(root, into, 'lane-no-compile');
  const report = await land({ cwd: root, into, lanes: [resultPath] });
  assert.equal(report.compile, null);
});

test('land warns when no compile check is configured', async (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  const { resultPath } = lane(root, into, 'lane-no-compile-warning');
  const report = await land({ cwd: root, into, lanes: [resultPath] });
  assert.deepEqual(report.warnings, ['no compile check configured; the batch was not compiled']);
});


test('land runs the compile command from delivery.config.json', async (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  config(root, { land: { compile: [process.execPath, '-e', "require('fs').writeFileSync('compiled.txt','1')"] } });
  const { resultPath } = lane(root, into, 'lane-compile');
  await land({ cwd: root, into, lanes: [resultPath] });
  assert.equal(existsSync(join(into, 'compiled.txt')), true);
});

test('land uses the first build check from the landed contracts when no compile is configured', async (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  const build = { command: process.execPath, args: ['-e', "require('fs').writeFileSync('build-check.txt','1')"], phase: 'build', exitCode: 0 };
  const { resultPath } = lane(root, into, 'lane-build-check', { checks: [build] });
  await land({ cwd: root, into, lanes: [resultPath] });
  assert.equal(existsSync(join(into, 'build-check.txt')), true);
});

test('land reports not ok when the compile fails', async (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  config(root, { land: { compile: [process.execPath, '-e', 'process.exit(1)'] } });
  const { resultPath } = lane(root, into, 'lane-compile-fail');
  const report = await land({ cwd: root, into, lanes: [resultPath] });
  assert.equal(report.ok, false);
});

test('land reports the compile command when machine config resolution fails', async (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  config(root, { land: { compile: [process.execPath, '-e', '0'] } });
  const { resultPath } = lane(root, into, 'lane-machine-config-fail');
  const report = await land({ cwd: root, into, lanes: [resultPath] }, {
    resolveMachineConfig: () => { throw Error('machine config unavailable'); },
  });
  assert.equal(report.compile?.command, `${process.execPath} -e 0`);
});

test('land fails the compile when it exceeds land.compileTimeoutMs', async (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  config(root, { land: { compile: [process.execPath, '-e', 'setTimeout(() => {}, 2000)'], compileTimeoutMs: 100 } });
  const { resultPath } = lane(root, into, 'lane-compile-timeout');
  const report = await land({ cwd: root, into, lanes: [resultPath] });
  assert.equal(report.compile?.error, 'compile timed out');
});

test('land writes land-report.json into the integration checkout', async (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  const { resultPath } = lane(root, into, 'lane-report');
  const report = await land({ cwd: root, into, lanes: [resultPath], clock: createManualClock('2026-05-06T07:08:09.000Z') });
  assert.equal(JSON.parse(readFileSync(report.reportPath!, 'utf8')).ok, true);
});


// --- CLI wiring -------------------------------------------------------------

test('junior land applies a lane through the public CLI', (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  const { resultPath } = lane(root, into, 'lane-cli');
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'junior.ts'), 'land', resultPath, '--into', into], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, JUNIOR_NO_UPDATE_CHECK: '1' },
  });
  assert.equal(result.status, 0);
});

test('junior land exits 1 when the land report is not ok', (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  const { resultPath } = lane(root, into, 'lane-cli-fail');
  const result = spawnSync(process.execPath, [
    join(import.meta.dirname, 'junior.ts'),
    'land', resultPath, '--into', into, '--compile', process.execPath, '-e', 'process.exit(1)',
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, JUNIOR_NO_UPDATE_CHECK: '1' } });
  assert.equal(result.status, 1);
});

test('junior land lets --compile override land.compile', (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  config(root, { land: { compile: [process.execPath, '-e', "require('fs').writeFileSync('config-compiled.txt','1')"] } });
  const { resultPath } = lane(root, into, 'lane-cli-override');
  spawnSync(process.execPath, [
    join(import.meta.dirname, 'junior.ts'),
    'land', resultPath, '--into', into,
    '--compile', process.execPath, '-e', "require('fs').writeFileSync('cli-override.txt','1')",
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, JUNIOR_NO_UPDATE_CHECK: '1' } });
  assert.equal(existsSync(join(into, 'cli-override.txt')), true);
});

test('junior land treats a lane id after -- as a lane', (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  const { resultPath } = lane(root, into, 'lane-after-terminator');
  spawnSync(process.execPath, [
    join(import.meta.dirname, 'junior.ts'),
    'land', '--into', into,
    '--compile', process.execPath, '-e', "require('fs').writeFileSync('terminator-compiled.txt','1')",
    '--', resultPath,
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, JUNIOR_NO_UPDATE_CHECK: '1' } });
  assert.equal(existsSync(join(into, 'lane.txt')), true);
});

test('junior land passes compile command flags to the compile argv', (t) => {
  const root = arena(t);
  const into = join(root, 'into');
  commitBase(into);
  const { resultPath } = lane(root, into, 'lane-cli-compile');
  spawnSync(process.execPath, [
    join(import.meta.dirname, 'junior.ts'),
    'land', resultPath, '--into', into,
    '--compile', process.execPath, '-e', "require('fs').writeFileSync('cli-compiled.txt','1')",
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, JUNIOR_NO_UPDATE_CHECK: '1' } });
  assert.equal(existsSync(join(into, 'cli-compiled.txt')), true);
});


test('junior land without --into prints an E_LAND_INTO report', (t) => {
  const root = arena(t);
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'junior.ts'), 'land', 'missing-lane'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, JUNIOR_NO_UPDATE_CHECK: '1' },
  });
  assert.equal(JSON.parse(result.stdout).code, 'E_LAND_INTO');
});
