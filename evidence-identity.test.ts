// Behavioral tests for governed evidence identity (#280), lane E1.
//
// Every scenario builds a disposable real Git repository under os.tmpdir() and
// drives the public checkIdentity / identityEqual / classifyCheck / checkTiming
// seams. Each test asserts one observable outcome; no test reads the real home
// directory or the network, and every temporary repository is removed.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkIdentity,
  checkTiming,
  classifyCheck,
  identityEqual,
  type CheckIdentityInput,
} from './evidence-identity.ts';

type TestContext = { after: (fn: () => void) => void };

const arena = (t: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), 'junior-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', env });

/** A committed monorepo with two packages and a root lockfile. */
const repo = (t: TestContext): string => {
  const root = arena(t);
  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, '.config'),
    GIT_CONFIG_GLOBAL: join(root, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  mkdirSync(join(root, 'packages', 'alpha', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'beta', 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"root"}\n');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(root, 'packages', 'alpha', 'package.json'), '{"name":"alpha"}\n');
  writeFileSync(join(root, 'packages', 'beta', 'package.json'), '{"name":"beta"}\n');
  writeFileSync(join(root, 'packages', 'alpha', 'src', 'index.ts'), 'export const alpha = 1;\n');
  writeFileSync(join(root, 'packages', 'beta', 'src', 'index.ts'), 'export const beta = 1;\n');
  git(root, ['init', '-q'], env);
  git(root, ['config', 'user.email', 't@example.com'], env);
  git(root, ['config', 'user.name', 'tester'], env);
  git(root, ['config', 'commit.gpgsign', 'false'], env);
  git(root, ['add', '-A'], env);
  git(root, ['commit', '-qm', 'base'], env);
  return root;
};

const version = () => 'v24.18.0';

const identityFor = (
  root: string,
  touchedFiles: string[] | undefined,
  argv: string[] = ['node', '--test', 'packages/alpha/src/index.test.ts'],
) => {
  const input: CheckIdentityInput = {
    cwd: root,
    check: { command: argv[0], args: argv.slice(1) },
    touchedFiles,
    toolVersion: version,
  };
  return checkIdentity(input);
};

// --- tree identity ----------------------------------------------------------

test('editing a file in a touched project changes the tree hash', (t) => {
  const root = repo(t);
  const before = identityFor(root, ['packages/alpha/src/index.ts']);
  writeFileSync(join(root, 'packages', 'alpha', 'src', 'index.ts'), 'export const alpha = 2;\n');
  const after = identityFor(root, ['packages/alpha/src/index.ts']);
  assert.notEqual(after?.tree, before?.tree);
});

test('editing one project leaves another project identity equal', (t) => {
  const root = repo(t);
  const before = identityFor(root, ['packages/beta/src/index.ts']);
  writeFileSync(join(root, 'packages', 'alpha', 'src', 'index.ts'), 'export const alpha = 2;\n');
  const after = identityFor(root, ['packages/beta/src/index.ts']);
  assert.equal(identityEqual(before, after), true);
});

test('an untracked file changes the tree hash', (t) => {
  const root = repo(t);
  const before = identityFor(root, ['packages/alpha/src/index.ts']);
  writeFileSync(join(root, 'packages', 'alpha', 'src', 'extra.ts'), 'export const extra = 1;\n');
  const after = identityFor(root, ['packages/alpha/src/index.ts']);
  assert.notEqual(after?.tree, before?.tree);
});

test('omitted touched files default to the working tree changes', (t) => {
  const root = repo(t);
  const before = identityFor(root, undefined);
  writeFileSync(join(root, 'packages', 'alpha', 'src', 'extra.ts'), 'export const extra = 1;\n');
  const after = identityFor(root, undefined);
  assert.notEqual(after?.tree, before?.tree);
});

test('the touched package directories are named as projects', (t) => {
  const root = repo(t);
  const identity = identityFor(root, [
    'packages/alpha/src/index.ts',
    'packages/beta/src/index.ts',
  ]);
  assert.deepEqual(identity?.projects, ['packages/alpha', 'packages/beta']);
});

test('a new untracked package directory resolves to that package project', (t) => {
  const root = repo(t);
  mkdirSync(join(root, 'packages', 'gamma', 'src'), { recursive: true });
  writeFileSync(join(root, 'packages', 'gamma', 'package.json'), '{"name":"gamma"}\n');
  writeFileSync(join(root, 'packages', 'gamma', 'src', 'index.ts'), 'export const gamma = 1;\n');
  const identity = identityFor(root, undefined);
  assert.deepEqual(identity?.projects, ['packages/gamma']);
});

test('a subdirectory cwd resolves projects relative to the repository root', (t) => {
  const root = repo(t);
  writeFileSync(join(root, 'packages', 'beta', 'src', 'index.ts'), 'export const beta = 2;\n');
  const identity = checkIdentity({
    cwd: join(root, 'packages', 'alpha'),
    check: { command: 'node', args: ['--test', 'packages/beta/src/index.test.ts'] },
    toolVersion: version,
  });
  assert.deepEqual(identity?.projects, ['packages/beta']);
});

test('checkIdentity on a non-git directory returns an unknown tree', (t) => {
  const dir = arena(t);
  const identity = checkIdentity({
    cwd: dir,
    check: { command: 'node', args: ['--test'] },
    toolVersion: version,
  });
  assert.match(identity?.tree ?? '', /^unknown:/);
});

// --- equality ---------------------------------------------------------------

test('two identities of the same tree command and lockfiles are equal', (t) => {
  const root = repo(t);
  const first = identityFor(root, ['packages/alpha/src/index.ts']);
  const second = identityFor(root, ['packages/alpha/src/index.ts']);
  assert.equal(identityEqual(first, second), true);
});

test('a changed lockfile breaks identity equality', (t) => {
  const root = repo(t);
  const before = identityFor(root, ['packages/alpha/src/index.ts']);
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
  const after = identityFor(root, ['packages/alpha/src/index.ts']);
  assert.equal(identityEqual(before, after), false);
});

test('two unknown trees are never equal even with the same reason', () => {
  const base = {
    schema_version: 1 as const,
    tree: 'unknown:not a repository',
    projects: ['.'],
    command: 'node --test',
    filter: null,
    dependencyLock: 'sha256:empty',
    toolchain: 'node v24.18.0',
  };
  assert.equal(identityEqual(base, { ...base }), false);
});

// --- filters ----------------------------------------------------------------

test('-t captures its test-name filter', (t) => {
  const root = repo(t);
  const identity = identityFor(root, [], ['npx', 'jest', '-t', 'adds numbers']);
  assert.equal(identity?.filter, 'adds numbers');
});

test('--filter captures its package filter', (t) => {
  const root = repo(t);
  const identity = identityFor(root, [], ['dotnet', 'test', '--filter', 'Category=Unit']);
  assert.equal(identity?.filter, 'Category=Unit');
});

test('-k captures its pytest expression filter', (t) => {
  const root = repo(t);
  const identity = identityFor(root, [], ['pytest', '-k', 'slow or api']);
  assert.equal(identity?.filter, 'slow or api');
});

test('test file paths in argv are captured as the filter', (t) => {
  const root = repo(t);
  const identity = identityFor(root, [], ['node', '--test', 'packages/alpha/src/index.test.ts']);
  assert.equal(identity?.filter, 'packages/alpha/src/index.test.ts');
});

// --- toolchain --------------------------------------------------------------

test('the injected tool version is recorded in the toolchain', (t) => {
  const root = repo(t);
  const identity = identityFor(root, [], ['npm', 'test']);
  assert.equal(identity?.toolchain, 'node v24.18.0');
});

// --- classification ---------------------------------------------------------

test('classifyCheck labels a build command as build', () => {
  assert.equal(classifyCheck(['cargo', 'check']), 'build');
});

test('classifyCheck labels a test command as test', () => {
  assert.equal(classifyCheck(['go', 'test', './...']), 'test');
});

test('classifyCheck labels an unrelated command as other', () => {
  assert.equal(classifyCheck(['echo', 'hello']), 'other');
});

test('classifyCheck labels tsc --noEmit as build', () => {
  assert.equal(classifyCheck(['tsc', '--noEmit']), 'build');
});

test('classifyCheck labels dotnet build as build', () => {
  assert.equal(classifyCheck(['dotnet', 'build']), 'build');
});

test('classifyCheck labels cargo check as build', () => {
  assert.equal(classifyCheck(['cargo', 'check']), 'build');
});

test('classifyCheck labels node --test as test', () => {
  assert.equal(classifyCheck(['node', '--test']), 'test');
});

test('classifyCheck labels npm test as test', () => {
  assert.equal(classifyCheck(['npm', 'test']), 'test');
});

test('classifyCheck labels npm run test:unit as test', () => {
  assert.equal(classifyCheck(['npm', 'run', 'test:unit']), 'test');
});

test('classifyCheck labels npx jest as test', () => {
  assert.equal(classifyCheck(['npx', 'jest']), 'test');
});

test('classifyCheck labels npx vitest as test', () => {
  assert.equal(classifyCheck(['npx', 'vitest']), 'test');
});

test('classifyCheck labels pytest as test', () => {
  assert.equal(classifyCheck(['pytest']), 'test');
});

test('classifyCheck labels dotnet test as test', () => {
  assert.equal(classifyCheck(['dotnet', 'test']), 'test');
});

test('classifyCheck labels cargo test as test', () => {
  assert.equal(classifyCheck(['cargo', 'test']), 'test');
});

test('classifyCheck labels go test as test', () => {
  assert.equal(classifyCheck(['go', 'test', './...']), 'test');
});

test('classifyCheck labels mvn test as test', () => {
  assert.equal(classifyCheck(['mvn', 'test']), 'test');
});

test('classifyCheck labels gradle test as test', () => {
  assert.equal(classifyCheck(['gradle', 'test']), 'test');
});

test('classifyCheck labels an env and timeout prefixed test command as test', () => {
  assert.equal(classifyCheck(['env', 'CI=1', 'timeout', '60', 'npm', 'test']), 'test');
});

// --- timing -----------------------------------------------------------------

test('checkTiming sums durations by phase and counts a missing phase as other', () => {
  const timing = checkTiming(
    [
      { phase: 'build', durationMs: 5 },
      { phase: 'test', durationMs: 7 },
      { phase: 'other', durationMs: 3 },
      { durationMs: 2 },
    ],
    true,
  );
  assert.deepEqual(timing, { buildMs: 5, testMs: 7, otherMs: 5, warm: true });
});
