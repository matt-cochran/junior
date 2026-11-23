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
import { buildWholeChangeSubject, changeGraph, excludeDiffSections } from './adr-change.ts';

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

function gitRoot(t: {after(fn: () => void): void}): {root: string; git: (args: string[]) => any} {
  const root = project(t);
  const git = (args: string[]) => spawnSync('git', args, {cwd: root, encoding: 'utf8'});
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.test']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  return {root, git};
}

/** Only tools/_shared/useThing.ts changes; three nested, unchanged tools import it. */
function nestedSharedFixture(t: {after(fn: () => void): void}): {root: string; base: string} {
  const {root, git} = gitRoot(t);
  write(root, 'tools/_shared/useThing.ts', 'export const useThing = true;\n');
  write(root, 'src/_components/tools/A/index.ts', "import {useThing} from '../../../../tools/_shared/useThing.ts';\nexport const a = useThing;\n");
  write(root, 'src/_components/tools/B/index.ts', "import {useThing} from '../../../../tools/_shared/useThing.ts';\nexport const b = useThing;\n");
  write(root, 'src/_components/tools/C/index.ts', "import {useThing} from '@/tools/_shared/useThing';\nexport const c = useThing;\n");
  git(['add', '.']);
  git(['commit', '-qm', 'nested tools']);
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

test('the relationship graph reads a tool name from any path depth', (t) => {
  const root = project(t);
  write(root, 'PresentationTier/ui/src/_components/tools/Billing/x.tsx', "import {y} from '../Inventory/y';\n");
  write(root, 'PresentationTier/ui/src/_components/tools/Inventory/y.tsx', 'export const y = true;\n');
  assert.match(changeGraph({root, files: ['PresentationTier/ui/src/_components/tools/Billing/x.tsx']}), /cross-tool: Billing -> Inventory/);
});

test('the relationship graph attributes an alias import to its tools segment', (t) => {
  const root = project(t);
  write(root, 'src/_components/tools/A/index.ts', "import {hooks} from '@/_components/tools/Billing/hooks';\n");
  assert.match(changeGraph({root, files: ['src/_components/tools/A/index.ts']}), /cross-tool: A -> Billing/);
});

test('the relationship graph finds unchanged importers of a changed shared module', (t) => {
  const {root} = nestedSharedFixture(t);
  assert.match(changeGraph({root, files: ['tools/_shared/useThing.ts']}), /tools\/_shared\/useThing\.ts is imported by 3 tools: A, B, C/);
});

test('a whole-change subject names all three unchanged tools that import a changed shared module', (t) => {
  const {root, base} = nestedSharedFixture(t);
  write(root, 'tools/_shared/useThing.ts', 'export const useThing = false;\n');
  assert.match(buildWholeChangeSubject({root, base}).text ?? '', /Relationships[\s\S]*tools\/_shared\/useThing\.ts is imported by 3 tools: A, B, C/);
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

test('an alias importer of a nested _shared module counts toward the tools that use it', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'adr-change-nested-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  spawnSync('git', ['init', '-q'], {cwd: root});
  write(root, 'src/_components/tools/_shared/useThing.ts', 'export const useThing = 1;\n');
  write(root, 'src/_components/tools/A/index.ts', "import {useThing} from '../_shared/useThing.ts';\n");
  write(root, 'src/_components/tools/B/index.ts', "import {useThing} from '../_shared/useThing';\n");
  write(root, 'src/_components/tools/C/index.ts', "import {useThing} from '@/_components/tools/_shared/useThing';\n");
  spawnSync('git', ['add', '-A'], {cwd: root});
  assert.match(changeGraph({root, files: ['src/_components/tools/_shared/useThing.ts']}), /src\/_components\/tools\/_shared\/useThing\.ts is imported by 3 tools: A, B, C/);
});

test('excludeDiffSections drops the diff of an excluded path and keeps the rest', () => {
  const diff = [
    'diff --git a/src/generated/api.ts b/src/generated/api.ts',
    '@@ -1 +1 @@',
    '+generated',
    'diff --git a/src/real.ts b/src/real.ts',
    '@@ -1 +1 @@',
    '+real',
    '',
  ].join('\n');
  assert.equal(excludeDiffSections(diff, (path) => path.includes('/generated/')), 'diff --git a/src/real.ts b/src/real.ts\n@@ -1 +1 @@\n+real\n');
});
