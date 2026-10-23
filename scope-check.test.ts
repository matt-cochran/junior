// Behavioral tests for scoping a run's changed files against an owned list.
//
// Every scenario is offline and deterministic. Each test drives the public
// `scope-check.ts` interface and asserts exactly one observable outcome. This
// file is written before the implementation and must fail until the module
// exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_INCIDENTAL_GLOBS,
  classifyScope,
  incidentalGlobsFromConfig,
} from './scope-check.ts';
import type { GitFileChange } from './evidence.ts';

function change(path: string, status = 'M'): GitFileChange {
  return { path, status };
}

test('classifyScope puts a modified owned file in scope', () => {
  const result = classifyScope([change('src/a.ts', 'M')], ['src/a.ts']);
  assert.deepEqual(result.inScope, ['src/a.ts']);
});

test('classifyScope puts an added owned file in scope', () => {
  const result = classifyScope([change('src/new.ts', 'A')], ['src/**']);
  assert.deepEqual(result.inScope, ['src/new.ts']);
});

test('classifyScope classifies a deleted owned path in scope', () => {
  const result = classifyScope([change('src/gone.ts', 'D')], ['src/gone.ts']);
  assert.deepEqual(result.inScope, ['src/gone.ts']);
});

test('classifyScope classifies a rename by its new path', () => {
  const result = classifyScope(
    [{ path: 'src/new.ts', oldPath: 'src/old.ts', status: 'R' }],
    ['src/new.ts'],
  );
  assert.deepEqual(result.inScope, ['src/new.ts']);
});

test('classifyScope puts an untracked owned file in scope', () => {
  const result = classifyScope(
    [{ path: 'src/new.ts', status: '??', untracked: true }],
    ['src/new.ts'],
  );
  assert.deepEqual(result.inScope, ['src/new.ts']);
});

test('classifyScope reports a non-owned change as out of scope', () => {
  const result = classifyScope([change('src/a.ts')], ['docs/**']);
  assert.deepEqual(result.outOfScope, ['src/a.ts']);
});

test('classifyScope lists an incidental lockfile without reporting it out of scope', () => {
  const result = classifyScope([change('package-lock.json')], ['src/**']);
  assert.deepEqual(result.incidental, ['package-lock.json']);
});

test('classifyScope uses the default snapshot glob as incidental', () => {
  const result = classifyScope([change('test/__snapshots__/view.snap')], ['src/**']);
  assert.deepEqual(result.incidental, ['test/__snapshots__/view.snap']);
});

test('classifyScope prefers an owned match over an incidental match', () => {
  const result = classifyScope([change('package-lock.json')], ['package-lock.json']);
  assert.deepEqual(result.inScope, ['package-lock.json']);
});

test('classifyScope accepts an owned entry object with a path and ignores its mode', () => {
  const entry = { path: 'src/a.ts', mode: 'write' };
  const result = classifyScope([change('src/a.ts')], [entry]);
  assert.deepEqual(result.inScope, ['src/a.ts']);
});

test('classifyScope matches an owned glob through matchesAppliesTo semantics', () => {
  const result = classifyScope([change('src/deep/a.ts')], ['src/**']);
  assert.deepEqual(result.inScope, ['src/deep/a.ts']);
});

test('classifyScope matches an owned loc member through matchesAppliesTo semantics', () => {
  const result = classifyScope([change('src/a.ts')], ['loc:src/a.ts']);
  assert.deepEqual(result.inScope, ['src/a.ts']);
});

test('classifyScope applies a repo-prefixed owned entry when the repo matches', () => {
  const result = classifyScope([change('src/a.ts')], ['api:src/a.ts'], { repo: 'api' });
  assert.deepEqual(result.inScope, ['src/a.ts']);
});

test('classifyScope ignores a repo-prefixed owned entry when the repo differs', () => {
  const result = classifyScope([change('src/a.ts')], ['web:src/a.ts'], { repo: 'api' });
  assert.equal(result.checked, false);
});

test('classifyScope leaves outOfScope empty when no owned entry applies', () => {
  const result = classifyScope([change('src/a.ts')], ['web:src/a.ts'], { repo: 'api' });
  assert.deepEqual(result.outOfScope, []);
});

test('classifyScope leaves a non-incidental change unclassified when owned is empty', () => {
  const result = classifyScope([change('src/a.ts')], []);
  assert.deepEqual([...result.inScope, ...result.outOfScope], []);
});

test('classifyScope still lists incidental changes when owned is empty', () => {
  const result = classifyScope([change('package-lock.json')], []);
  assert.deepEqual(result.incidental, ['package-lock.json']);
});

test('classifyScope uses configured incidental globs in place of the defaults', () => {
  const result = classifyScope([change('dist/bundle.js')], ['src/**'], {
    incidental: ['dist/**'],
  });
  assert.deepEqual(result.incidental, ['dist/bundle.js']);
});

test('classifyScope normalises a leading dot-slash on the change path', () => {
  const result = classifyScope([change('./src/a.ts')], ['src/a.ts']);
  assert.deepEqual(result.inScope, ['src/a.ts']);
});

test('classifyScope sorts and de-duplicates in-scope paths', () => {
  const result = classifyScope(
    [change('src/b.ts'), change('src/a.ts'), change('src/a.ts')],
    ['src/**'],
  );
  assert.deepEqual(result.inScope, ['src/a.ts', 'src/b.ts']);
});

test('classifyScope throws a specific error for an invalid owned entry', () => {
  assert.throws(
    () => classifyScope([change('src/a.ts')], [42 as unknown as string]),
    /owned entry/,
  );
});

test('incidentalGlobsFromConfig returns the configured incidental globs', () => {
  const globs = incidentalGlobsFromConfig({ scope: { incidental: ['dist/**'] } });
  assert.deepEqual(globs, ['dist/**']);
});

test('incidentalGlobsFromConfig returns the defaults when scope is absent', () => {
  const globs = incidentalGlobsFromConfig({});
  assert.deepEqual(globs, [...DEFAULT_INCIDENTAL_GLOBS]);
});

test('incidentalGlobsFromConfig returns the defaults for a non-object config', () => {
  const globs = incidentalGlobsFromConfig(null);
  assert.deepEqual(globs, [...DEFAULT_INCIDENTAL_GLOBS]);
});

test('incidentalGlobsFromConfig rejects a non-array scope.incidental value', () => {
  assert.throws(
    () => incidentalGlobsFromConfig({ scope: { incidental: 'dist/**' } }),
    /scope\.incidental/,
  );
});

test('incidentalGlobsFromConfig rejects an empty string in scope.incidental', () => {
  assert.throws(
    () => incidentalGlobsFromConfig({ scope: { incidental: ['dist/**', ''] } }),
    /scope\.incidental/,
  );
});

test('DEFAULT_INCIDENTAL_GLOBS covers lockfiles and snapshots', () => {
  assert.deepEqual(DEFAULT_INCIDENTAL_GLOBS, [
    'package-lock.json',
    '**/package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'Cargo.lock',
    '**/Cargo.lock',
    '**/*.snap',
    '**/__snapshots__/**',
  ]);
});
