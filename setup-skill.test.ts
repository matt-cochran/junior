// Behavioral tests for refreshing installed Junior skill copies.
//
// Every scenario is offline and confined to temporary directories: the
// packaged source is a fixture, `HOME` is a temp directory and the injected
// dependencies never touch the real user profile. Each test asserts exactly one
// observable outcome through the public `init`/`inspectSkill` interface.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { init, inspectSkill } from './setup.ts';

const SOURCE_V1 = '---\nname: junior\ndescription: old\n---\n\n# old\n';
const SOURCE_V2 = '---\nname: junior\ndescription: new\n---\n\n# new\n';
const UNRECORDED_JUNIOR = '---\nname: junior\ndescription: unrecorded\n---\n\n# unrecorded\n';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function skillSource(content: string): string {
  const path = join(tempDir('junior-skill-src-'), 'SKILL.md');
  writeFileSync(path, content);
  return path;
}

function deps(cwd: string, home: string, source: string): any {
  return {
    cwd,
    env: { HOME: home, PATH: '' },
    execPath: process.execPath,
    nodeVersion: '24.0.0',
    skillSource: source,
    exec: () => ({ status: 1, stdout: '', stderr: '' }),
    readMounts: () => '',
  };
}

const codexSkill = (home: string): string => join(home, '.agents', 'skills', 'junior', 'SKILL.md');
const claudeSkill = (home: string): string => join(home, '.claude', 'skills', 'junior', 'SKILL.md');
const codexRoot = (home: string): string => join(home, '.agents', 'skills');
const claudeRoot = (home: string): string => join(home, '.claude', 'skills');

function writeUnrecordedJuniorSkill(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, UNRECORDED_JUNIOR);
}

function backupPaths(path: string): string[] {
  return readdirSync(dirname(path)).filter((name) => name.startsWith('SKILL.md.bak-'));
}

// --- user-scope outdated copies are refreshed by update ---------------------

test('Update replaces an outdated user-scope Codex skill copy', () => {
  const cwd = tempDir('junior-skill-update-');
  const home = tempDir('junior-skill-home-');
  const source = skillSource(SOURCE_V1);
  const d = deps(cwd, home, source);
  init(d, { scope: 'user', target: 'codex', install: false });
  writeFileSync(source, SOURCE_V2);

  init(d, { command: 'update', target: 'codex', install: false });

  assert.equal(readFileSync(codexSkill(home), 'utf8'), SOURCE_V2);
});

test('Update leaves a refreshed outdated user-scope skill current for doctor', () => {
  const cwd = tempDir('junior-skill-update-');
  const home = tempDir('junior-skill-home-');
  const source = skillSource(SOURCE_V1);
  const d = deps(cwd, home, source);
  init(d, { scope: 'user', target: 'claude', install: false });
  writeFileSync(source, SOURCE_V2);

  init(d, { command: 'update', target: 'claude', install: false });

  assert.equal(inspectSkill(d, { roots: [claudeRoot(home)] }).targets[0].status, 'current');
});

// --- customized user-scope copies are preserved -----------------------------

test('Update preserves a customized user-scope skill copy', () => {
  const cwd = tempDir('junior-skill-update-');
  const home = tempDir('junior-skill-home-');
  const source = skillSource(SOURCE_V1);
  const d = deps(cwd, home, source);
  init(d, { scope: 'user', target: 'codex', install: false });
  writeFileSync(codexSkill(home), 'custom\n');
  writeFileSync(source, SOURCE_V2);

  init(d, { command: 'update', target: 'codex', install: false });

  assert.equal(readFileSync(codexSkill(home), 'utf8'), 'custom\n');
});

test('Update reports a preserved customized user-scope skill copy', () => {
  const cwd = tempDir('junior-skill-update-');
  const home = tempDir('junior-skill-home-');
  const source = skillSource(SOURCE_V1);
  const d = deps(cwd, home, source);
  init(d, { scope: 'user', target: 'codex', install: false });
  writeFileSync(codexSkill(home), 'custom\n');
  writeFileSync(source, SOURCE_V2);

  const result = init(d, { command: 'update', target: 'codex', install: false });

  assert.ok(result.skill.actions.some((action) => action.status === 'customized' && action.path === codexSkill(home)));
});

// --- manifest-less Junior copies are backed up then refreshed --------------

test('Update replaces a manifest-less user-scope Junior skill copy', () => {
  const cwd = tempDir('junior-skill-update-');
  const home = tempDir('junior-skill-home-');
  const d = deps(cwd, home, skillSource(SOURCE_V2));
  writeUnrecordedJuniorSkill(codexSkill(home));

  init(d, { command: 'update', target: 'codex', install: false });

  assert.equal(readFileSync(codexSkill(home), 'utf8'), SOURCE_V2);
});

test('Update writes a backup before replacing a manifest-less user-scope Junior skill copy', () => {
  const cwd = tempDir('junior-skill-update-');
  const home = tempDir('junior-skill-home-');
  const d = deps(cwd, home, skillSource(SOURCE_V2));
  writeUnrecordedJuniorSkill(codexSkill(home));

  init(d, { command: 'update', target: 'codex', install: false });

  assert.equal(backupPaths(codexSkill(home)).length, 1);
});

test('Update preserves the previous content in the manifest-less backup', () => {
  const cwd = tempDir('junior-skill-update-');
  const home = tempDir('junior-skill-home-');
  const d = deps(cwd, home, skillSource(SOURCE_V2));
  writeUnrecordedJuniorSkill(codexSkill(home));

  init(d, { command: 'update', target: 'codex', install: false });

  const backup = join(dirname(codexSkill(home)), backupPaths(codexSkill(home))[0]);
  assert.equal(readFileSync(backup, 'utf8'), UNRECORDED_JUNIOR);
});

test('Update reports a manifest-less user-scope replacement as upgraded', () => {
  const cwd = tempDir('junior-skill-update-');
  const home = tempDir('junior-skill-home-');
  const d = deps(cwd, home, skillSource(SOURCE_V2));
  writeUnrecordedJuniorSkill(codexSkill(home));

  const result = init(d, { command: 'update', target: 'codex', install: false });

  assert.equal(result.skill.actions.find((action) => action.path === codexSkill(home))?.status, 'upgraded');
});

test('Update names the backup path in the upgraded action', () => {
  const cwd = tempDir('junior-skill-update-');
  const home = tempDir('junior-skill-home-');
  const d = deps(cwd, home, skillSource(SOURCE_V2));
  writeUnrecordedJuniorSkill(codexSkill(home));

  const result = init(d, { command: 'update', target: 'codex', install: false });
  const backup = join(dirname(codexSkill(home)), backupPaths(codexSkill(home))[0]);

  assert.ok(result.skill.actions.find((action) => action.path === codexSkill(home))?.message.includes(backup));
});

test('Update leaves a refreshed manifest-less user-scope skill current for doctor', () => {
  const cwd = tempDir('junior-skill-update-');
  const home = tempDir('junior-skill-home-');
  const d = deps(cwd, home, skillSource(SOURCE_V2));
  writeUnrecordedJuniorSkill(codexSkill(home));

  init(d, { command: 'update', target: 'codex', install: false });

  assert.equal(inspectSkill(d, { roots: [codexRoot(home)] }).targets[0].status, 'current');
});

test('Doctor classifies a manifest-less Junior skill copy as outdated before update', () => {
  const cwd = tempDir('junior-skill-update-');
  const home = tempDir('junior-skill-home-');
  const d = deps(cwd, home, skillSource(SOURCE_V2));
  writeUnrecordedJuniorSkill(codexSkill(home));

  assert.equal(inspectSkill(d, { roots: [codexRoot(home)] }).targets[0].status, 'outdated');
});

// --- update never creates user-scope copies ---------------------------------

test('Update does not create a missing user-scope Codex skill', () => {
  const cwd = tempDir('junior-skill-update-');
  const home = tempDir('junior-skill-home-');
  const d = deps(cwd, home, skillSource(SOURCE_V2));

  init(d, { command: 'update', target: 'codex', install: false });

  assert.equal(existsSync(codexSkill(home)), false);
});

test('Update does not create a missing user-scope Claude skill', () => {
  const cwd = tempDir('junior-skill-update-');
  const home = tempDir('junior-skill-home-');
  const d = deps(cwd, home, skillSource(SOURCE_V2));

  init(d, { command: 'update', target: 'claude', install: false });

  assert.equal(existsSync(claudeSkill(home)), false);
});

// --- plain init keeps its project-only behaviour ----------------------------

test('Plain init does not refresh an outdated user-scope skill copy', () => {
  const cwd = tempDir('junior-skill-init-');
  const home = tempDir('junior-skill-home-');
  const source = skillSource(SOURCE_V1);
  const d = deps(cwd, home, source);
  init(d, { scope: 'user', target: 'codex', install: false });
  writeFileSync(source, SOURCE_V2);

  init(d, { target: 'codex', install: false });

  assert.equal(readFileSync(codexSkill(home), 'utf8'), SOURCE_V1);
});
