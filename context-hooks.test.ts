// Behavioral tests for installing the compact context SessionStart hook.
//
// Every scenario uses a temporary project directory and asserts one observable
// outcome through the public API.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JUNIOR_HOOK_COMMAND,
  harnessInstructions,
  installContextHooks,
  mergeContextHooks,
  removeContextHooks,
} from './context-hooks.ts';

function workspace(t: any): string {
  const dir = mkdtempSync(join(tmpdir(), 'junior-hooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function entry(command: string) {
  return { matcher: 'compact|resume', hooks: [{ type: 'command', command }] };
}

test('the exported Junior command is junior compact', () => {
  assert.equal(JUNIOR_HOOK_COMMAND, 'junior compact');
});

test('merge adds one SessionStart entry', () => {
  const merged = mergeContextHooks({});
  assert.equal((merged.settings.hooks.SessionStart as unknown[]).length, 1);
});

test('merge uses the Junior command by default', () => {
  const merged = mergeContextHooks({});
  assert.deepEqual(merged.settings.hooks.SessionStart[0], entry('junior compact'));
});

test('merge reports a change when it adds the hook', () => {
  assert.equal(mergeContextHooks({}).changed, true);
});

test('merge preserves unrelated settings keys', () => {
  const merged = mergeContextHooks({ permissions: { allow: ['Read'] } });
  assert.deepEqual(merged.settings.permissions, { allow: ['Read'] });
});

test('merge preserves unrelated hook events', () => {
  const merged = mergeContextHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] } });
  assert.deepEqual(merged.settings.hooks.Stop, [{ hooks: [{ type: 'command', command: 'notify' }] }]);
});

test('merge is idempotent for an existing Junior hook', () => {
  const merged = mergeContextHooks({ hooks: { SessionStart: [entry('junior compact')] } });
  assert.equal(merged.changed, false);
});

test('merge recognizes a longer Junior command as installed', () => {
  const merged = mergeContextHooks({ hooks: { SessionStart: [entry('junior compact --verbose')] } });
  assert.equal(merged.changed, false);
});

test('merge preserves another SessionStart entry beside the Junior hook', () => {
  const existing = entry('other-tool context');
  const merged = mergeContextHooks({ hooks: { SessionStart: [existing] } });
  assert.deepEqual(merged.settings.hooks.SessionStart[0], existing);
});

test('merge accepts an explicit command', () => {
  const merged = mergeContextHooks({}, 'junior compact --scope project');
  assert.equal(merged.settings.hooks.SessionStart[0].hooks[0].command, 'junior compact --scope project');
});

test('merge rejects a non-object settings value', () => {
  assert.throws(() => mergeContextHooks([]), /JSON object/);
});

test('remove deletes only the Junior SessionStart entry', () => {
  const removed = removeContextHooks({ hooks: { SessionStart: [entry('junior compact'), entry('other-tool context')] } });
  assert.deepEqual(removed.settings.hooks.SessionStart, [entry('other-tool context')]);
});

test('remove reports no change when no Junior hook exists', () => {
  const removed = removeContextHooks({ hooks: { SessionStart: [entry('other-tool context')] } });
  assert.equal(removed.changed, false);
});

test('remove keeps unrelated hook events', () => {
  const removed = removeContextHooks({
    hooks: { SessionStart: [entry('junior compact')], Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] },
  });
  assert.deepEqual(removed.settings.hooks.Stop, [{ hooks: [{ type: 'command', command: 'notify' }] }]);
});

test('install writes local settings by default', (t) => {
  const dir = workspace(t);
  const result = installContextHooks({ projectDir: dir });
  assert.equal(result.path, join(dir, '.claude', 'settings.local.json'));
});

test('install writes the merged hook into the local settings file', (t) => {
  const dir = workspace(t);
  installContextHooks({ projectDir: dir });
  const stored = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(stored.hooks.SessionStart[0].hooks[0].command, 'junior compact');
});

test('install targets project settings when scope is project', (t) => {
  const dir = workspace(t);
  const result = installContextHooks({ projectDir: dir, scope: 'project' });
  assert.equal(result.path, join(dir, '.claude', 'settings.json'));
});

test('install does not create a backup for a new settings file', (t) => {
  const dir = workspace(t);
  const result = installContextHooks({ projectDir: dir });
  assert.equal(result.backup, null);
});

test('install creates a timestamped backup when an existing file changes', (t) => {
  const dir = workspace(t);
  const settingsPath = join(dir, '.claude', 'settings.local.json');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Read'] } }));
  const result = installContextHooks({ projectDir: dir, now: () => new Date('2026-01-02T03:04:05Z') });
  assert.ok(result.backup !== null && existsSync(result.backup));
});

test('the backup keeps the previous settings content', (t) => {
  const dir = workspace(t);
  const settingsPath = join(dir, '.claude', 'settings.local.json');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Read'] } }));
  const result = installContextHooks({ projectDir: dir, now: () => new Date('2026-01-02T03:04:05Z') });
  const backup = JSON.parse(readFileSync(result.backup as string, 'utf8'));
  assert.deepEqual(backup, { permissions: { allow: ['Read'] } });
});

test('a second install is a no-op with no new backup', (t) => {
  const dir = workspace(t);
  installContextHooks({ projectDir: dir });
  const second = installContextHooks({ projectDir: dir });
  assert.deepEqual({ changed: second.changed, backup: second.backup }, { changed: false, backup: null });
});

test('a second install leaves exactly one settings file', (t) => {
  const dir = workspace(t);
  installContextHooks({ projectDir: dir });
  installContextHooks({ projectDir: dir });
  assert.equal(readdirSync(join(dir, '.claude')).filter((name) => name.includes('settings')).length, 1);
});

test('install refuses a settings file that is not a JSON object', (t) => {
  const dir = workspace(t);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.local.json'), '[]');
  assert.throws(() => installContextHooks({ projectDir: dir }), /JSON object/);
});

test('install with remove deletes the Junior entry from an existing file', (t) => {
  const dir = workspace(t);
  const settingsPath = join(dir, '.claude', 'settings.local.json');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [entry('junior compact')] } }));
  installContextHooks({ projectDir: dir, remove: true });
  const stored = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(stored.hooks?.SessionStart, undefined);
});

test('install with remove on a missing file does not create it', (t) => {
  const dir = workspace(t);
  const result = installContextHooks({ projectDir: dir, remove: true });
  assert.equal(existsSync(result.path), false);
});

test('codex instructions point at AGENTS.md and the junior compact command', () => {
  assert.match(harnessInstructions('codex'), /AGENTS\.md[\s\S]*junior compact/);
});

test('cursor instructions name the Cursor harness', () => {
  assert.match(harnessInstructions('cursor'), /Cursor/);
});
