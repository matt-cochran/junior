// Behavioral tests for installing the compact context SessionStart hook.
//
// Every scenario uses a temporary project directory and asserts one observable
// outcome through the public API.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  JUNIOR_CAPTURE_COMMAND,
  JUNIOR_HOOK_COMMAND,
  harnessHooksPath,
  harnessInstructions,
  installContextHooks,
  installHarnessHooks,
  mergeContextHooks,
  mergeHarnessHooks,
  removeContextHooks,
  removeHarnessHooks,
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

test('merge adds PreCompact when only the old SessionStart hook exists', () => {
  const merged = mergeContextHooks({ hooks: { SessionStart: [entry('junior compact')] } });
  assert.deepEqual(merged.settings.hooks.PreCompact, [{ hooks: [{ type: 'command', command: 'junior compact --capture' }] }]);
});

test('merge reports a change when it adds PreCompact beside an existing SessionStart hook', () => {
  const merged = mergeContextHooks({ hooks: { SessionStart: [entry('junior compact')] } });
  assert.equal(merged.changed, true);
});

test('merge recognizes a longer Junior command as installed for SessionStart', () => {
  const merged = mergeContextHooks({ hooks: { SessionStart: [entry('junior compact --verbose')] } });
  assert.deepEqual(merged.settings.hooks.SessionStart, [entry('junior compact --verbose')]);
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

// --- local backup exclusion -------------------------------------------------

function gitRepo(t: any): string {
  const dir = workspace(t);
  const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  return dir;
}

function existingSettings(dir: string): string {
  const path = join(dir, '.claude', 'settings.local.json');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(path, JSON.stringify({ permissions: { allow: ['Read'] } }));
  return path;
}

function gitStatus(dir: string): string {
  const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function excludeLines(dir: string): string[] {
  return readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8').split(/\r?\n/);
}

test('install excludes the backup from Git status in a temporary repository', (t) => {
  const dir = gitRepo(t);
  existingSettings(dir);
  installContextHooks({ projectDir: dir, now: () => new Date('2026-01-02T03:04:05Z') });
  assert.doesNotMatch(gitStatus(dir), /\.bak/);
});

test('install records the exact backup path once in the local exclude file', (t) => {
  const dir = gitRepo(t);
  existingSettings(dir);
  installContextHooks({ projectDir: dir, now: () => new Date('2026-01-02T03:04:05Z') });
  assert.equal(excludeLines(dir).filter((line) => line === '/.claude/settings.local.json.2026-01-02T03-04-05-000Z.bak').length, 1);
});

test('install without an existing settings file adds no backup exclusion', (t) => {
  const dir = gitRepo(t);
  installContextHooks({ projectDir: dir });
  assert.equal(excludeLines(dir).some((line) => line.endsWith('.bak')), false);
});

test('install survives an exclusion write failure and reports excludeError', (t) => {
  const dir = gitRepo(t);
  existingSettings(dir);
  rmSync(join(dir, '.git', 'info', 'exclude'), { force: true });
  mkdirSync(join(dir, '.git', 'info', 'exclude'));
  const result = installContextHooks({ projectDir: dir, now: () => new Date('2026-01-02T03:04:05Z') });
  assert.deepEqual(
    { changed: result.changed, hasError: typeof result.excludeError === 'string' && result.excludeError.length > 0 },
    { changed: true, hasError: true },
  );
});


// --- capture PreCompact hook -------------------------------------------------

test('the exported capture command is junior compact --capture', () => {
  assert.equal(JUNIOR_CAPTURE_COMMAND, 'junior compact --capture');
});

test('merge adds one PreCompact capture entry', () => {
  const merged = mergeContextHooks({});
  assert.deepEqual(merged.settings.hooks.PreCompact, [{ hooks: [{ type: 'command', command: 'junior compact --capture' }] }]);
});

test('merging twice reports no change the second time', () => {
  const once = mergeContextHooks({});
  const twice = mergeContextHooks(once.settings);
  assert.equal(twice.changed, false);
});

test('merge ignores a capture command when looking for the SessionStart hook', () => {
  const merged = mergeContextHooks({ hooks: { SessionStart: [entry('junior compact --capture')] } });
  assert.deepEqual(merged.settings.hooks.SessionStart, [entry('junior compact --capture'), entry('junior compact')]);
});

test('remove keeps a user PreCompact hook and drops the Junior SessionStart array', () => {
  const removed = removeContextHooks({
    hooks: {
      SessionStart: [entry('junior compact')],
      PreCompact: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
    },
  });
  assert.deepEqual(removed.settings.hooks, { PreCompact: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] });
});

test('remove rejects a non-array PreCompact value', () => {
  assert.throws(() => removeContextHooks({ hooks: { PreCompact: {} } }), /PreCompact must be an array/);
});

// --- Codex and Cursor harness hooks ----------------------------------------

test('harness hooks path for codex is .codex/hooks.json', (t) => {
  const dir = workspace(t);
  assert.equal(harnessHooksPath(dir, 'codex'), join(dir, '.codex', 'hooks.json'));
});

test('harness hooks path for cursor is .cursor/hooks.json', (t) => {
  const dir = workspace(t);
  assert.equal(harnessHooksPath(dir, 'cursor'), join(dir, '.cursor', 'hooks.json'));
});

test('codex merge yields the documented nested shape', () => {
  const merged = mergeHarnessHooks('codex', {});
  assert.deepEqual(merged.config, {
    hooks: {
      SessionStart: [{ matcher: 'startup|resume|compact', hooks: [{ type: 'command', command: 'junior compact' }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: 'junior compact --capture' }] }],
    },
  });
});

test('cursor merge yields the documented flat shape with version 1', () => {
  const merged = mergeHarnessHooks('cursor', {});
  assert.deepEqual(merged.config, {
    version: 1,
    hooks: {
      sessionStart: [{ command: 'junior compact --cursor' }],
      preCompact: [{ command: 'junior compact --capture' }],
    },
  });
});

test('codex merge is idempotent', () => {
  const once = mergeHarnessHooks('codex', {});
  const twice = mergeHarnessHooks('codex', once.config);
  assert.equal(twice.changed, false);
});

test('cursor merge keeps an existing version value', () => {
  const merged = mergeHarnessHooks('cursor', { version: 7 });
  assert.equal(merged.config.version, 7);
});

test('codex remove deletes only Junior entries and keeps a user Stop hook', () => {
  const removed = removeHarnessHooks('codex', {
    hooks: {
      SessionStart: [{ matcher: 'startup|resume|compact', hooks: [{ type: 'command', command: 'junior compact' }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: 'junior compact --capture' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }],
    },
  });
  assert.deepEqual(removed.config, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] } });
});

test('cursor remove deletes only Junior flat entries', () => {
  const removed = removeHarnessHooks('cursor', {
    version: 1,
    hooks: {
      sessionStart: [{ command: 'junior compact --cursor' }, { command: 'other' }],
      preCompact: [{ command: 'junior compact --capture' }],
    },
  });
  assert.deepEqual(removed.config, { version: 1, hooks: { sessionStart: [{ command: 'other' }] } });
});

test('installHarnessHooks creates the cursor file with the documented shape', (t) => {
  const dir = workspace(t);
  installHarnessHooks({ projectDir: dir, harness: 'cursor' });
  const stored = JSON.parse(readFileSync(join(dir, '.cursor', 'hooks.json'), 'utf8'));
  assert.deepEqual(stored, {
    version: 1,
    hooks: {
      sessionStart: [{ command: 'junior compact --cursor' }],
      preCompact: [{ command: 'junior compact --capture' }],
    },
  });
});

test('a fresh cursor install leaves git status clean', (t) => {
  const dir = gitRepo(t);
  installHarnessHooks({ projectDir: dir, harness: 'cursor' });
  assert.equal(gitStatus(dir), '');
});

test('a fresh codex install leaves git status clean', (t) => {
  const dir = gitRepo(t);
  installHarnessHooks({ projectDir: dir, harness: 'codex' });
  assert.equal(gitStatus(dir), '');
});

test('installHarnessHooks reports created for a new file', (t) => {
  const dir = workspace(t);
  const result = installHarnessHooks({ projectDir: dir, harness: 'cursor' });
  assert.equal(result.created, true);
});

test('installHarnessHooks keeps a user Stop hook when augmenting codex', (t) => {
  const dir = workspace(t);
  const path = join(dir, '.codex', 'hooks.json');
  mkdirSync(join(dir, '.codex'), { recursive: true });
  writeFileSync(path, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] } }));
  installHarnessHooks({ projectDir: dir, harness: 'codex', now: () => new Date('2026-01-02T03:04:05Z') });
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(stored.hooks.Stop, [{ hooks: [{ type: 'command', command: 'notify' }] }]);
});

test('installHarnessHooks writes a backup when an existing codex file changes', (t) => {
  const dir = workspace(t);
  const path = join(dir, '.codex', 'hooks.json');
  mkdirSync(join(dir, '.codex'), { recursive: true });
  writeFileSync(path, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] } }));
  const result = installHarnessHooks({ projectDir: dir, harness: 'codex', now: () => new Date('2026-01-02T03:04:05Z') });
  assert.ok(result.backup !== null && existsSync(result.backup));
});

test('installHarnessHooks remove deletes only Junior codex entries', (t) => {
  const dir = workspace(t);
  const path = join(dir, '.codex', 'hooks.json');
  mkdirSync(join(dir, '.codex'), { recursive: true });
  writeFileSync(path, JSON.stringify({
    hooks: {
      SessionStart: [{ matcher: 'startup|resume|compact', hooks: [{ type: 'command', command: 'junior compact' }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: 'junior compact --capture' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }],
    },
  }));
  installHarnessHooks({ projectDir: dir, harness: 'codex', remove: true, now: () => new Date('2026-01-02T03:04:05Z') });
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(stored, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] } });
});

test('installHarnessHooks refuses a harness file that is not a JSON object', (t) => {
  const dir = workspace(t);
  mkdirSync(join(dir, '.cursor'), { recursive: true });
  writeFileSync(join(dir, '.cursor', 'hooks.json'), '[]');
  assert.throws(() => installHarnessHooks({ projectDir: dir, harness: 'cursor' }), /JSON object/);
});

test('codex notes tell the user to trust the Junior hooks', (t) => {
  const dir = workspace(t);
  const result = installHarnessHooks({ projectDir: dir, harness: 'codex' });
  assert.ok(result.notes.includes('Codex runs project hooks only after you trust them: open /hooks in Codex and trust the Junior entries.'));
});

test('cursor notes are empty', (t) => {
  const dir = workspace(t);
  const result = installHarnessHooks({ projectDir: dir, harness: 'cursor' });
  assert.deepEqual(result.notes, []);
});
