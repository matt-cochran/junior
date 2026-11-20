// Behavioral tests for the default command guards (#281).
//
// Every test drives the public `guardCommand` seam and asserts one observable
// outcome: a decision, its typed event, or the absence of a decision.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  guardCommand,
  isBuildCommand,
  type GuardContext,
  type ResolvedGuards,
} from './command-guards.ts';

const guards = (overrides: Partial<ResolvedGuards> = {}): ResolvedGuards => ({
  noBuild: 'refuse',
  hookBypass: 'refuse',
  ...overrides,
});

const context = (overrides: Partial<GuardContext> = {}): GuardContext => ({
  source: 'check',
  lastBuild: 'failed',
  guards: guards(),
  ...overrides,
});

// --- no-build ---------------------------------------------------------------

test('a dotnet test with --no-build after a failed build is refused', () => {
  const decision = guardCommand(['dotnet', 'test', '--no-build'], context());
  assert.equal(decision?.action, 'refuse');
});

test('a --no-build refusal after a failed build records no_build_after_failed_build', () => {
  const decision = guardCommand(['dotnet', 'test', '--no-build'], context());
  assert.equal(decision?.event.kind, 'no_build_after_failed_build');
});

test('a --no-build test without any build in the run records no_build_without_build', () => {
  const decision = guardCommand(['dotnet', 'test', '--no-build'], context({ lastBuild: 'none' }));
  assert.equal(decision?.event.kind, 'no_build_without_build');
});

test('a dotnet test with --no-restore --no-build after a failed build is refused', () => {
  const decision = guardCommand(['dotnet', 'test', '--no-restore', '--no-build'], context());
  assert.equal(decision?.action, 'refuse');
});

test('a maven test with -Dmaven.main.skip after a failed build is refused', () => {
  const decision = guardCommand(['mvn', 'test', '-Dmaven.main.skip'], context());
  assert.equal(decision?.action, 'refuse');
});

test('a --no-build test after a successful build is allowed', () => {
  const decision = guardCommand(['dotnet', 'test', '--no-build'], context({ lastBuild: 'ok' }));
  assert.equal(decision, null);
});

test('noBuild off allows a --no-build test after a failed build', () => {
  const decision = guardCommand(
    ['dotnet', 'test', '--no-build'],
    context({ guards: guards({ noBuild: 'off' }) }),
  );
  assert.equal(decision, null);
});

test('noBuild stale marks a --no-build test as stale evidence', () => {
  const decision = guardCommand(
    ['dotnet', 'test', '--no-build'],
    context({ guards: guards({ noBuild: 'stale' }) }),
  );
  assert.equal(decision?.action, 'flag_stale');
});

test('a stale no-build decision records the no_build_after_failed_build kind', () => {
  const decision = guardCommand(
    ['dotnet', 'test', '--no-build'],
    context({ guards: guards({ noBuild: 'stale' }) }),
  );
  assert.equal(decision?.event.kind, 'no_build_after_failed_build');
});

test('a guard decision keeps the source it was given', () => {
  const decision = guardCommand(
    ['dotnet', 'test', '--no-build'],
    context({ source: 'worker_bash' }),
  );
  assert.equal(decision?.event.source, 'worker_bash');
});

// --- hook bypass ------------------------------------------------------------

test('git commit --no-verify is refused by default', () => {
  const decision = guardCommand(['git', 'commit', '--no-verify'], context());
  assert.equal(decision?.action, 'refuse');
});

test('a hook-bypass refusal records the hook_bypass kind', () => {
  const decision = guardCommand(['git', 'commit', '--no-verify'], context());
  assert.equal(decision?.event.kind, 'hook_bypass');
});

test('git -c core.hooksPath=... is refused by default', () => {
  const decision = guardCommand(
    ['git', '-c', 'core.hooksPath=/tmp/hooks', 'commit'],
    context(),
  );
  assert.equal(decision?.action, 'refuse');
});

test('git config core.hooksPath is refused by default', () => {
  const decision = guardCommand(['git', 'config', 'core.hooksPath', '/tmp/hooks'], context());
  assert.equal(decision?.action, 'refuse');
});

test('HUSKY=0 before git is refused by default', () => {
  const decision = guardCommand(['HUSKY=0', 'git', 'commit'], context());
  assert.equal(decision?.action, 'refuse');
});

test('HUSKY_SKIP_HOOKS=1 is refused by default', () => {
  const decision = guardCommand(['HUSKY_SKIP_HOOKS=1', 'git', 'commit'], context());
  assert.equal(decision?.action, 'refuse');
});

test('SKIP_HOOKS=1 is refused by default', () => {
  const decision = guardCommand(['SKIP_HOOKS=1', 'git', 'commit'], context());
  assert.equal(decision?.action, 'refuse');
});

test('LEFTHOOK=0 is refused by default', () => {
  const decision = guardCommand(['LEFTHOOK=0', 'git', 'commit'], context());
  assert.equal(decision?.action, 'refuse');
});

test('an env prefix cannot hide HUSKY=0', () => {
  const decision = guardCommand(['env', 'HUSKY=0', 'git', 'commit'], context());
  assert.equal(decision?.action, 'refuse');
});

test('a timeout prefix cannot hide --no-verify', () => {
  const decision = guardCommand(['timeout', '30', 'git', 'commit', '--no-verify'], context());
  assert.equal(decision?.action, 'refuse');
});

test('a nice prefix cannot hide core.hooksPath', () => {
  const decision = guardCommand(
    ['nice', '-n', '5', 'git', '-c', 'core.hooksPath=/tmp/hooks', 'commit'],
    context(),
  );
  assert.equal(decision?.action, 'refuse');
});

test('hookBypass off allows --no-verify', () => {
  const decision = guardCommand(
    ['git', 'commit', '--no-verify'],
    context({ guards: guards({ hookBypass: 'off' }) }),
  );
  assert.equal(decision, null);
});

test('a normal git commit is allowed by default', () => {
  const decision = guardCommand(['git', 'commit', '-m', 'message'], context());
  assert.equal(decision, null);
});

test('an unrelated command is allowed by default', () => {
  const decision = guardCommand(['node', '--test', 'x.test.ts'], context());
  assert.equal(decision, null);
});

// --- build classification ---------------------------------------------------

test('tsc is classified as a build command', () => {
  assert.equal(isBuildCommand(['tsc', '--noEmit']), true);
});

test('dotnet build is classified as a build command', () => {
  assert.equal(isBuildCommand(['dotnet', 'build']), true);
});

test('npm run build is classified as a build command', () => {
  assert.equal(isBuildCommand(['npm', 'run', 'build']), true);
});

test('dotnet test is not classified as a build command', () => {
  assert.equal(isBuildCommand(['dotnet', 'test']), false);
});
