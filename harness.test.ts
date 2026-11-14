// Behavioral tests for harness detection and harness-specific skill/MCP
// locations.
//
// Every scenario is pure and read-only: the environment and filesystem
// existence checks are injected. Each test asserts exactly one observable
// outcome through the public API.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import {
  detectHarness,
  harnessMcpConfig,
  harnessSkillRoots,
  installedHarnesses,
  type HarnessFileSystem,
} from './harness.ts';

const CTX = { cwd: '/work', home: '/home/u' };

/** A fake home directory exposing exactly the given dot-directories. */
function homeWith(home: string, dirs: string[]): HarnessFileSystem {
  const present = new Set(dirs.map((dir) => join(home, dir)));
  return { home, exists: (path: string) => present.has(path) };
}

// --- detectHarness ---------------------------------------------------------

test('CLAUDECODE=1 detects claude', () => {
  assert.equal(detectHarness({ CLAUDECODE: '1' }).harness, 'claude');
});

test('CLAUDE_CODE_ENTRYPOINT detects claude', () => {
  assert.equal(detectHarness({ CLAUDE_CODE_ENTRYPOINT: 'cli' }).harness, 'claude');
});

test('CURSOR_AGENT detects cursor', () => {
  assert.equal(detectHarness({ CURSOR_AGENT: '1' }).harness, 'cursor');
});

test('CURSOR_TRACE_ID detects cursor', () => {
  assert.equal(detectHarness({ CURSOR_TRACE_ID: 'trace' }).harness, 'cursor');
});

test('CODEX_SANDBOX detects codex', () => {
  assert.equal(detectHarness({ CODEX_SANDBOX: '1' }).harness, 'codex');
});

test('CODEX_SANDBOX_NETWORK_DISABLED detects codex', () => {
  assert.equal(detectHarness({ CODEX_SANDBOX_NETWORK_DISABLED: '1' }).harness, 'codex');
});

test('CODEX_THREAD_ID detects codex', () => {
  assert.equal(detectHarness({ CODEX_THREAD_ID: 'thread' }).harness, 'codex');
});

test('CLAUDECODE=0 does not detect claude', () => {
  assert.equal(detectHarness({ CLAUDECODE: '0' }).harness, 'unknown');
});

test('an empty environment is unknown', () => {
  assert.equal(detectHarness({}).harness, 'unknown');
});

test('an empty environment carries no evidence', () => {
  assert.deepEqual(detectHarness({}).evidence, []);
});

test('an explicit override beats conflicting environment variables', () => {
  assert.equal(detectHarness({ CLAUDECODE: '1' }, 'cursor').harness, 'cursor');
});

test('an explicit override reports override evidence', () => {
  assert.deepEqual(detectHarness({}, 'codex').evidence, ['override']);
});

test('an unrecognized override falls back to environment detection', () => {
  assert.equal(detectHarness({ CURSOR_AGENT: '1' }, 'emacs').harness, 'cursor');
});

test('claude wins when several harnesses match', () => {
  assert.equal(detectHarness({ CURSOR_AGENT: '1', CODEX_SANDBOX: '1', CLAUDECODE: '1' }).harness, 'claude');
});

test('cursor wins over codex when both match', () => {
  assert.equal(detectHarness({ CURSOR_AGENT: '1', CODEX_SANDBOX: '1' }).harness, 'cursor');
});

test('every matching variable is listed as evidence', () => {
  assert.deepEqual(
    detectHarness({ CLAUDECODE: '1', CURSOR_AGENT: '1', CODEX_SANDBOX: '1' }).evidence,
    ['CLAUDECODE', 'CURSOR_AGENT', 'CODEX_SANDBOX'],
  );
});

test('evidence lists variable names instead of values', () => {
  assert.deepEqual(
    detectHarness({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 's3cret-value' }).evidence,
    ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
  );
});

// --- installedHarnesses ----------------------------------------------------

test('installedHarnesses reports every harness whose home directory exists', () => {
  assert.deepEqual(installedHarnesses(homeWith('/home/u', ['.claude', '.cursor', '.codex'])), ['claude', 'cursor', 'codex']);
});

test('installedHarnesses omits harnesses without a home directory', () => {
  assert.deepEqual(installedHarnesses(homeWith('/home/u', ['.cursor'])), ['cursor']);
});

test('installedHarnesses is empty when no harness directory exists', () => {
  assert.deepEqual(installedHarnesses(homeWith('/home/u', [])), []);
});

// --- harnessSkillRoots -----------------------------------------------------

test('claude skill roots are project then user .claude/skills', () => {
  assert.deepEqual(harnessSkillRoots('claude', CTX), [
    join('/work', '.claude', 'skills'),
    join('/home/u', '.claude', 'skills'),
  ]);
});

test('codex skill roots are project .agents/skills then user codex and agents skills', () => {
  assert.deepEqual(harnessSkillRoots('codex', CTX), [
    join('/work', '.agents', 'skills'),
    join('/home/u', '.codex', 'skills'),
    join('/home/u', '.agents', 'skills'),
  ]);
});

test('cursor skill roots include .agents/skills', () => {
  assert.ok(harnessSkillRoots('cursor', CTX).includes(join('/work', '.agents', 'skills')));
});

test('cursor skill roots include .claude/skills', () => {
  assert.ok(harnessSkillRoots('cursor', CTX).includes(join('/work', '.claude', 'skills')));
});

test('cursor skill roots mirror the four project roots under home', () => {
  assert.deepEqual(harnessSkillRoots('cursor', CTX), [
    join('/work', '.cursor', 'skills'),
    join('/work', '.agents', 'skills'),
    join('/work', '.claude', 'skills'),
    join('/work', '.codex', 'skills'),
    join('/home/u', '.cursor', 'skills'),
    join('/home/u', '.agents', 'skills'),
    join('/home/u', '.claude', 'skills'),
    join('/home/u', '.codex', 'skills'),
  ]);
});

test('unknown skill roots are the deduplicated union of every harness', () => {
  assert.deepEqual(harnessSkillRoots('unknown', CTX), [
    join('/work', '.claude', 'skills'),
    join('/work', '.cursor', 'skills'),
    join('/work', '.agents', 'skills'),
    join('/work', '.codex', 'skills'),
    join('/home/u', '.claude', 'skills'),
    join('/home/u', '.cursor', 'skills'),
    join('/home/u', '.agents', 'skills'),
    join('/home/u', '.codex', 'skills'),
  ]);
});

// --- harnessMcpConfig ------------------------------------------------------

test('claude MCP config includes the project .mcp.json', () => {
  assert.ok(harnessMcpConfig('claude', CTX).locations.some((location) => location.path === join('/work', '.mcp.json')));
});

test('claude MCP config includes user .claude.json under mcpServers', () => {
  const user = harnessMcpConfig('claude', CTX).locations.find((location) => location.path === join('/home/u', '.claude.json'));
  assert.equal(user?.key, 'mcpServers');
});

test('claude MCP CLI is claude mcp', () => {
  assert.equal(harnessMcpConfig('claude', CTX).cli, 'claude mcp');
});

test('cursor MCP config includes the project .cursor/mcp.json', () => {
  assert.ok(harnessMcpConfig('cursor', CTX).locations.some((location) => location.path === join('/work', '.cursor', 'mcp.json')));
});

test('cursor MCP config includes the user .cursor/mcp.json', () => {
  assert.ok(harnessMcpConfig('cursor', CTX).locations.some((location) => location.path === join('/home/u', '.cursor', 'mcp.json')));
});

test('cursor MCP config has no CLI', () => {
  assert.equal(harnessMcpConfig('cursor', CTX).cli, null);
});

test('codex MCP config location is ~/.codex/config.toml', () => {
  assert.ok(harnessMcpConfig('codex', CTX).locations.some((location) => location.path === join('/home/u', '.codex', 'config.toml')));
});

test('codex MCP config CLI is codex mcp', () => {
  assert.equal(harnessMcpConfig('codex', CTX).cli, 'codex mcp');
});

test('codex MCP config reads the mcp_servers table', () => {
  const codex = harnessMcpConfig('codex', CTX).locations.find((location) => location.path === join('/home/u', '.codex', 'config.toml'));
  assert.equal(codex?.key, 'mcp_servers');
});

test('unknown MCP config is the deduplicated union of every harness', () => {
  assert.deepEqual(harnessMcpConfig('unknown', CTX).locations, [
    { path: join('/work', '.mcp.json') },
    { path: join('/home/u', '.claude.json'), key: 'mcpServers' },
    { path: join('/work', '.cursor', 'mcp.json') },
    { path: join('/home/u', '.cursor', 'mcp.json') },
    { path: join('/home/u', '.codex', 'config.toml'), key: 'mcp_servers' },
  ]);
});

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CLAUDE_STORE_DENY_RULES, RETIRED_STORE_DENY_RULES, inspectStoreDenyRules, mergeStoreDenyRules, installStoreDenyRules } from './harness.ts';

test('mergeStoreDenyRules on empty settings writes the current Claude deny list', () => {
 const deny = (mergeStoreDenyRules({}).settings.permissions as any).deny;
 assert.deepEqual(deny, [
  'Read(./.crossmatrix/**)',
  'Edit(./.crossmatrix/**)',
  'Bash(cat .crossmatrix*)',
  'Bash(grep * .crossmatrix*)',
  'Bash(jq * .crossmatrix*)',
 ]);
});

test('inspectStoreDenyRules reports the current Claude deny list as present', () => {
 const settings = JSON.stringify({
  permissions: {
   deny: [
    'Read(./.crossmatrix/**)',
    'Edit(./.crossmatrix/**)',
    'Bash(cat .crossmatrix*)',
    'Bash(grep * .crossmatrix*)',
    'Bash(jq * .crossmatrix*)',
   ],
  },
 });
 const present = inspectStoreDenyRules('/project', {
  existsSync: () => true,
  readFileSync: () => settings,
 }).present;
 assert.equal(present, true);
});

test('inspectStoreDenyRules reports the 0.16.0 Claude deny list as absent', () => {
 const settings = JSON.stringify({
  permissions: {
   deny: [
    'Read(./.crossmatrix/**)',
    'Edit(./.crossmatrix/**)',
    'Write(./.crossmatrix/**)',
    'Bash(cat .crossmatrix:*)',
    'Bash(grep * .crossmatrix:*)',
    'Bash(jq * .crossmatrix:*)',
   ],
  },
 });
 const present = inspectStoreDenyRules('/project', {
  existsSync: () => true,
  readFileSync: () => settings,
 }).present;
 assert.equal(present, false);
});

test('installStoreDenyRules writes the Claude deny rules when a store exists', () => {
 const cwd = join(tmpdir(), `junior-store-${process.pid}-${Date.now()}`);
 mkdirSync(join(cwd, '.crossmatrix'), { recursive: true });
 installStoreDenyRules({ projectDir: cwd });
 const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'));
 assert.equal(settings.permissions.deny.includes('Read(./.crossmatrix/**)'), true);
});

test('installStoreDenyRules does not duplicate rules on a second run', () => {
 const cwd = join(tmpdir(), `junior-store-${process.pid}-${Date.now()}-twice`);
 mkdirSync(join(cwd, '.crossmatrix'), { recursive: true });
 writeFileSync(join(cwd, '.claude-settings-seed'), '');
 mkdirSync(join(cwd, '.claude'), { recursive: true });
 writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read(./.crossmatrix/**)'] } }));
 installStoreDenyRules({ projectDir: cwd });
 const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'));
 assert.equal(settings.permissions.deny.filter((rule: string) => rule === 'Read(./.crossmatrix/**)').length, 1);
});

test('installStoreDenyRules leaves settings untouched when no store exists', () => {
 const cwd = join(tmpdir(), `junior-store-${process.pid}-${Date.now()}-none`);
 const result = installStoreDenyRules({ projectDir: cwd });
 assert.equal(result.changed, false);
});
test('RETIRED_STORE_DENY_RULES lists the four retired rule spellings', () => {
 assert.deepEqual([...RETIRED_STORE_DENY_RULES], [
  'Write(./.crossmatrix/**)',
  'Bash(cat .crossmatrix:*)',
  'Bash(grep * .crossmatrix:*)',
  'Bash(jq * .crossmatrix:*)',
 ]);
});

test('mergeStoreDenyRules replaces retired rules with the current list after user rules', () => {
 const settings = { permissions: { deny: [...RETIRED_STORE_DENY_RULES, 'Read(./secrets/**)'] } };
 assert.deepEqual((mergeStoreDenyRules(settings).settings.permissions as any).deny, [
  'Read(./secrets/**)',
  ...CLAUDE_STORE_DENY_RULES,
 ]);
});

test('mergeStoreDenyRules migrates the 0.16.0 list while preserving a user rule', () => {
 const settings = { permissions: { deny: [
  'Read(./.crossmatrix/**)',
  'Edit(./.crossmatrix/**)',
  'Write(./.crossmatrix/**)',
  'Bash(cat .crossmatrix:*)',
  'Bash(grep * .crossmatrix*)',
  'Bash(jq * .crossmatrix*)',
  'Read(./secrets/**)',
 ] } };
 assert.deepEqual((mergeStoreDenyRules(settings).settings.permissions as any).deny, [
  'Read(./.crossmatrix/**)',
  'Edit(./.crossmatrix/**)',
  'Bash(grep * .crossmatrix*)',
  'Bash(jq * .crossmatrix*)',
  'Read(./secrets/**)',
  'Bash(cat .crossmatrix*)',
 ]);
});

test('mergeStoreDenyRules leaves an already migrated deny list identical', () => {
 const first = mergeStoreDenyRules({ permissions: { deny: [...RETIRED_STORE_DENY_RULES, 'Read(./secrets/**)'] } });
 const second = mergeStoreDenyRules(first.settings);
 assert.deepEqual((second.settings.permissions as any).deny, (first.settings.permissions as any).deny);
});

test('mergeStoreDenyRules reports no change for an already migrated deny list', () => {
 const first = mergeStoreDenyRules({ permissions: { deny: [...RETIRED_STORE_DENY_RULES, 'Read(./secrets/**)'] } });
 assert.equal(mergeStoreDenyRules(first.settings).changed, false);
});

test('inspectStoreDenyRules reports a hand-fixed current list with user rules as current', () => {
 const settings = JSON.stringify({ permissions: { deny: [...CLAUDE_STORE_DENY_RULES, 'Read(./secrets/**)'] } });
 const state = inspectStoreDenyRules('/project', {
  existsSync: () => true,
  readFileSync: () => settings,
 }).state;
 assert.equal(state, 'current');
});

test('inspectStoreDenyRules reports a retired rule alongside the current list as outdated', () => {
 const settings = JSON.stringify({ permissions: { deny: [...CLAUDE_STORE_DENY_RULES, RETIRED_STORE_DENY_RULES[0]] } });
 const state = inspectStoreDenyRules('/project', {
  existsSync: () => true,
  readFileSync: () => settings,
 }).state;
 assert.equal(state, 'outdated');
});

test('inspectStoreDenyRules reports a partial current list as outdated', () => {
 const settings = JSON.stringify({ permissions: { deny: [CLAUDE_STORE_DENY_RULES[0]] } });
 const state = inspectStoreDenyRules('/project', {
  existsSync: () => true,
  readFileSync: () => settings,
 }).state;
 assert.equal(state, 'outdated');
});

test('inspectStoreDenyRules reports settings with no Junior rules as missing', () => {
 const settings = JSON.stringify({ permissions: { deny: ['Read(./secrets/**)'] } });
 const state = inspectStoreDenyRules('/project', {
  existsSync: () => true,
  readFileSync: () => settings,
 }).state;
 assert.equal(state, 'missing');
});

test('inspectStoreDenyRules reports a missing settings file as missing', () => {
 const state = inspectStoreDenyRules('/project', {
  existsSync: (path) => path.endsWith('.crossmatrix'),
 }).state;
 assert.equal(state, 'missing');
});

test('installStoreDenyRules leaves a hand-fixed current settings file unchanged', () => {
 const cwd = join(tmpdir(), `junior-store-${process.pid}-${Date.now()}-current`);
 mkdirSync(join(cwd, '.crossmatrix'), { recursive: true });
 mkdirSync(join(cwd, '.claude'), { recursive: true });
 const original = { permissions: { deny: [...CLAUDE_STORE_DENY_RULES, 'Read(./secrets/**)'] } };
 writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify(original));
 installStoreDenyRules({ projectDir: cwd });
 assert.deepEqual(JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8')), original);
});
