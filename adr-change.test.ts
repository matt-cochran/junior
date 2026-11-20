// Behavioural tests for whole-change ADR judging (issues #276, #279).
//
// Each scenario is offline and drives the public functions of adr-change.ts:
// one whole-change subject and the static relationship graph used as gate
// evidence. Each test asserts exactly one observable outcome.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildWholeChangeSubject, changeGraph } from './adr-change.ts';

function project(t: {after(fn: () => void): void}): string {
  const root = mkdtempSync(join(tmpdir(), 'junior-adr-change-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, '..'), {recursive: true});
  writeFileSync(join(root, path), text);
}

function gitProject(t: {after(fn: () => void): void}): {root: string; base: string} {
  const root = project(t);
  const git = (args: string[]) => spawnSync('git', args, {cwd: root, encoding: 'utf8'});
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.test']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  write(root, 'tools/app-a/src/index.ts', 'export const base = true;\n');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  return {root, base: git(['rev-parse', 'HEAD']).stdout.trim()};
}

/** Three micro-apps import one hook from tools/_shared; app-a's spec $refs app-b's. */
function crossToolFixture(t: {after(fn: () => void): void}): {root: string; files: string[]} {
  const root = project(t);
  write(root, 'tools/_shared/hook.ts', 'export function useHook(): boolean {\n  return true;\n}\n');
  for (const app of ['app-a', 'app-b', 'app-c']) {
    write(root, `tools/${app}/src/index.ts`, `import {useHook} from '../../_shared/hook.ts';\n\nexport const ${app.replace('-', '_')} = useHook();\n`);
  }
  write(root, 'tools/app-a/openapi.yaml', 'components:\n  schemas:\n    User:\n      $ref: "../app-b/openapi.yaml#/components/schemas/User"\n');
  write(root, 'tools/app-b/openapi.yaml', 'components:\n  schemas:\n    User:\n      type: object\n');
  return {
    root,
    files: [
      'tools/_shared/hook.ts',
      'tools/app-a/src/index.ts',
      'tools/app-b/src/index.ts',
      'tools/app-c/src/index.ts',
      'tools/app-a/openapi.yaml',
    ],
  };
}

test('a whole-change subject judges the one change target', (t) => {
  const {root, base} = gitProject(t);
  assert.equal(buildWholeChangeSubject({root, base}).target, 'change');
});

test('a whole-change subject is judged as a diff', (t) => {
  const {root, base} = gitProject(t);
  assert.equal(buildWholeChangeSubject({root, base}).kind, 'diff');
});

test('a whole-change subject lists every changed path', (t) => {
  const {root, base} = gitProject(t);
  write(root, 'tools/app-a/src/index.ts', 'export const changed = true;\n');
  write(root, 'tools/app-a/src/extra.ts', 'export const extra = true;\n');
  assert.deepEqual(buildWholeChangeSubject({root, base}).files, [
    'tools/app-a/src/extra.ts',
    'tools/app-a/src/index.ts',
  ]);
});

test('a whole-change subject contains the unified diff of the change', (t) => {
  const {root, base} = gitProject(t);
  write(root, 'tools/app-a/src/index.ts', 'export const wholeChangeMarker = true;\n');
  assert.match(buildWholeChangeSubject({root, base}).text ?? '', /\+export const wholeChangeMarker = true;/);
});

test('a whole-change subject includes untracked new files as new-file diffs', (t) => {
  const {root, base} = gitProject(t);
  write(root, 'tools/app-a/src/new.ts', 'export const untrackedMarker = true;\n');
  assert.match(buildWholeChangeSubject({root, base}).text ?? '', /new file tools\/app-a\/src\/new\.ts[\s\S]*untrackedMarker/);
});

test('a whole-change subject bounds a large diff at the 60,000 character limit', (t) => {
  const {root, base} = gitProject(t);
  const lines = Array.from({length: 5000}, (_, index) => `export const line${index} = ${index};`);
  write(root, 'tools/app-a/src/index.ts', `${lines.join('\n')}\n`);
  assert.ok((buildWholeChangeSubject({root, base}).text ?? '').length <= 60_000);
});

test('a bounded whole-change diff says how many hunks it left out', (t) => {
  const {root, base} = gitProject(t);
  const lines = Array.from({length: 5000}, (_, index) => `export const line${index} = ${index};`);
  write(root, 'tools/app-a/src/index.ts', `${lines.join('\n')}\n`);
  assert.match(buildWholeChangeSubject({root, base}).text ?? '', /\[truncated: \d+ more hunks\]/);
});

test('the relationship graph names each of the three shared-hook imports', (t) => {
  const {root, files} = crossToolFixture(t);
  const lines = changeGraph({root, files})
    .split('\n')
    .filter((line) => line.includes('tools/_shared/hook.ts') && line.includes(' imports '));
  assert.deepEqual(lines.sort(), [
    'tools/app-a/src/index.ts imports tools/_shared/hook.ts (cross-tool: app-a -> _shared)',
    'tools/app-b/src/index.ts imports tools/_shared/hook.ts (cross-tool: app-b -> _shared)',
    'tools/app-c/src/index.ts imports tools/_shared/hook.ts (cross-tool: app-c -> _shared)',
  ]);
});

test('the relationship graph names a cross-spec $ref', (t) => {
  const {root, files} = crossToolFixture(t);
  assert.match(changeGraph({root, files}), /tools\/app-a\/openapi\.yaml references tools\/app-b\/openapi\.yaml \(\$ref: app-a -> app-b\)/);
});

test('the relationship graph names the shared module imported by three tools', (t) => {
  const {root, files} = crossToolFixture(t);
  assert.match(changeGraph({root, files}), /tools\/_shared\/hook\.ts is imported by 3 tools: app-a, app-b, app-c/);
});

test('the relationship graph names any module imported by two tools', (t) => {
  const root = project(t);
  write(root, 'lib/shared.ts', 'export const shared = true;\n');
  write(root, 'tools/app-a/src/index.ts', "import {shared} from '../../../lib/shared.ts';\n");
  write(root, 'tools/app-b/src/index.ts', "import {shared} from '../../../lib/shared.ts';\n");
  assert.match(changeGraph({root, files: ['tools/app-a/src/index.ts', 'tools/app-b/src/index.ts']}), /lib\/shared\.ts is imported by 2 tools: app-a, app-b/);
});

test('the relationship graph ignores an import that stays inside one tool', (t) => {
  const root = project(t);
  write(root, 'tools/app-a/src/index.ts', "import {helper} from './helper.ts';\n");
  write(root, 'tools/app-a/src/helper.ts', 'export const helper = true;\n');
  assert.doesNotMatch(changeGraph({root, files: ['tools/app-a/src/index.ts']}), /cross-tool/);
});

test('the relationship graph ignores a $ref that stays inside one tool', (t) => {
  const root = project(t);
  write(root, 'tools/app-a/openapi.yaml', '$ref: "./schemas.yaml#/User"\n');
  write(root, 'tools/app-a/schemas.yaml', 'User:\n  type: object\n');
  assert.doesNotMatch(changeGraph({root, files: ['tools/app-a/openapi.yaml']}), /\$ref/);
});
