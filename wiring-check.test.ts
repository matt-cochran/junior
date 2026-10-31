import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { findUnwiredExports } from './wiring-check.ts';
import { finish } from './worker-outcome.ts';
import { mockReceipt } from './worker-receipt.ts';
import { collectGitEvidence } from './evidence.ts';
import { compactHandoff } from './handoff.ts';

function repo(t: any): string {
  const dir = mkdtempSync(join(tmpdir(), 'junior-wiring-'));
  t.after(() => spawnSync('rm', ['-rf', dir]));
  git(dir, ['init', '--quiet']);
  git(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'baseline', '--quiet']);
  return dir;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function commit(cwd: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture', '--quiet']);
}

function outcomeState(cwd: string): any {
  const dir = join(cwd, '.delivery', 'task', 'stamp');
  mkdirSync(dir, { recursive: true });
  return {
    mock: true,
    deps: {},
    settings: { checkTimeoutMs: 120000 },
    sourceCwd: cwd,
    executionCwd: cwd,
    isolation: 'worktree',
    dir,
    heartbeat: { update() {}, setState() {}, snapshot() { return {}; } },
    emit() {},
    requested: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' },
    requestedSource: 'project',
    resume: undefined,
    prior: undefined,
    review: undefined,
    signal: undefined,
    mode: 'off',
    jev: undefined,
    decision: { selected: 'evaluate' },
    lineage: {},
    modelRoute: {},
    providerRouting: {},
    externalContext: undefined,
    piIsolation: undefined,
    worktreePath: undefined,
    reportWorkflow: false,
    reportPath: null,
    prepareRun: false,
    preparePlan: undefined,
    prepareHistory: [],
    isQa: false,
    isRepair: false,
    templates: {},
    classify: undefined,
    before: collectGitEvidence(cwd),
    streamResult: undefined,
    workerStatus: 0,
    receipt: mockReceipt({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' }),
    receiptOk: true,
    legacyError: undefined,
    segments: [],
    checks: [],
    workerRan: true,
    stopped: false,
    deadlineAt: Date.now() + 60_000,
    deadlineDuringChecks: false,
    runStartedAt: Date.now(),
    stderr: '',
    t: { id: 'task', cwd },
  };
}

test('an export referenced only by its test is unwired', (t) => {
  const cwd = repo(t);
  commit(cwd, { 'feature.test.ts': "import { onlyTested } from './feature.ts';\nonlyTested();\n" });
  const unwired = findUnwiredExports(cwd, [{ path: 'feature.ts', addedLines: ['export function onlyTested() {}'] }]);
  assert.deepEqual(unwired, [{ symbol: 'onlyTested', file: 'feature.ts' }]);
});

test('an export imported by another production file is wired', (t) => {
  const cwd = repo(t);
  commit(cwd, { 'consumer.ts': "import { used } from './feature.ts';\nused();\n" });
  const unwired = findUnwiredExports(cwd, [{ path: 'feature.ts', addedLines: ['export function used() {}'] }]);
  assert.deepEqual(unwired, []);
});

test('an export called elsewhere in its own production file is wired', (t) => {
  const cwd = repo(t);
  const unwired = findUnwiredExports(cwd, [{
    path: 'feature.ts',
    addedLines: ['export function usedHere() {}', 'usedHere();'],
  }]);
  assert.deepEqual(unwired, []);
});

test('an export added to a test file is never unwired', (t) => {
  const cwd = repo(t);
  const unwired = findUnwiredExports(cwd, [{
    path: 'feature.test.ts',
    addedLines: ['export const testOnly = 1;'],
  }]);
  assert.deepEqual(unwired, []);
});

test('the result records newly exported symbols with no production reference', async (t) => {
  const cwd = repo(t);
  commit(cwd, { 'feature.test.ts': "import { onlyTested } from './feature.ts';\nonlyTested();\n" });
  const state = outcomeState(cwd);
  writeFileSync(join(cwd, 'feature.ts'), 'export function onlyTested() {}\n');
  const result = await finish(state);
  assert.deepEqual(result.unwired, [{ symbol: 'onlyTested', file: 'feature.ts' }]);
});

test('the compact receipt carries the unwired warning', async (t) => {
  const cwd = repo(t);
  commit(cwd, { 'feature.test.ts': "import { onlyTested } from './feature.ts';\nonlyTested();\n" });
  const state = outcomeState(cwd);
  writeFileSync(join(cwd, 'feature.ts'), 'export function onlyTested() {}\n');
  const result = await finish(state);
  assert.deepEqual(compactHandoff(result).unwired, [{ symbol: 'onlyTested', file: 'feature.ts' }]);
});
