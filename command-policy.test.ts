// Behavioral tests for contract command placement (CMD1a).
//
// Each test exercises one observable outcome through the module's public API.
// CMD1a covers policy/manifest parsing, direct argv normalization (env,
// assignments, command/exec/timeout/nice prefixes), chain splitting, rule
// matching, and wrapper identity. Shell -c recursion, package-script/npx
// resolution and eval detection belong to CMD1b.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMMAND_PLACEMENT_ERROR,
  decideCommand,
  parseCommandManifest,
  parseCommandPolicy,
} from './command-policy.ts';

const DEVBOX_FIXTURE = 'tools/test-fixtures/command-policy/command-placement.v1.json';
const DEVBOX_WRAPPER = 'scripts/devbox/run-safe.sh';
const LOCAL_CONTROL_PLANE = 'scripts/devbox/fleet-controller.ts';
const REMOTE_HEAVY = 'scripts/devbox/heavy-suite.ts';

function devboxFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(DEVBOX_FIXTURE, 'utf8')) as Record<string, unknown>;
}

function devboxPolicy(remoteWrapper: string | undefined = DEVBOX_WRAPPER) {
  return parseCommandPolicy(
    {
      enforce: true,
      manifest: DEVBOX_FIXTURE,
      ...(remoteWrapper === undefined ? {} : { remoteWrapper }),
    },
    process.cwd(),
  );
}

const REMOTE_MATCH = [
  'node --test',
  'node --import',
  'npm test',
  'npm run test',
  'npx vitest',
  'cargo test',
];

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'command-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function wrapperFile(dir: string, name = 'npm-safe.sh'): string {
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  return path;
}

function remotePolicy(dir: string, wrapper = wrapperFile(dir)) {
  return parseCommandPolicy(
    { enforce: true, rules: [{ match: REMOTE_MATCH, placement: 'remote', wrapper }] },
    dir,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Acceptance criteria
// ---------------------------------------------------------------------------

test('a remote-only rule refuses an unwrapped node --import test', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'node --import tsx --test x.test.ts').decision, 'refuse');
});

test('a remote refusal names the configured wrapper', (t) => {
  const dir = tempDir(t);
  const wrapper = wrapperFile(dir);
  const policy = remotePolicy(dir, wrapper);
  const result = decideCommand(policy, 'node --import tsx --test x.test.ts');
  assert.match(result.reason ?? '', new RegExp(escapeRegExp(wrapper)));
});

test('the wrapper form of a remote command is allowed', (t) => {
  const dir = tempDir(t);
  const wrapper = wrapperFile(dir);
  const policy = remotePolicy(dir, wrapper);
  assert.equal(decideCommand(policy, `${wrapper} npm test`).decision, 'allow');
});

test('the wrapper form of a remote command reports remote placement', (t) => {
  const dir = tempDir(t);
  const wrapper = wrapperFile(dir);
  const policy = remotePolicy(dir, wrapper);
  assert.equal(decideCommand(policy, `${wrapper} npm test`).placement, 'remote');
});

test('a command without a policy is allowed', () => {
  assert.equal(decideCommand(null, 'echo hello').decision, 'allow');
});

test('a command without a policy reports unknown placement', () => {
  assert.equal(decideCommand(null, 'echo hello').placement, 'unknown');
});

test('enforce refuses a command that matches no rule', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'echo hello').decision, 'refuse');
});

test('enforce reports unknown placement for a command that matches no rule', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'echo hello').placement, 'unknown');
});

// ---------------------------------------------------------------------------
// Direct argv and prefix stripping
// ---------------------------------------------------------------------------

test('a direct argv remote command is refused', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, ['node', '--test', 'x.test.ts']).decision, 'refuse');
});

test('an env assignment does not hide an unwrapped remote command', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'env CI=1 npm test').decision, 'refuse');
});

test('env -i options do not hide an unwrapped remote command', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'env -i PATH=/usr/bin npm test').decision, 'refuse');
});

test('a leading assignment does not hide an unwrapped remote command', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'CI=1 npm test').decision, 'refuse');
});

test('a command prefix does not hide an unwrapped remote command', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'command npm test').decision, 'refuse');
});

test('an exec prefix does not hide an unwrapped remote command', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'exec npm test').decision, 'refuse');
});

test('a timeout prefix does not hide an unwrapped remote command', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'timeout 30 npm test').decision, 'refuse');
});

test('a nice prefix does not hide an unwrapped remote command', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'nice -n 10 npm test').decision, 'refuse');
});

test('a wrapper reached through env is allowed', (t) => {
  const dir = tempDir(t);
  const wrapper = wrapperFile(dir);
  const policy = remotePolicy(dir, wrapper);
  assert.equal(decideCommand(policy, `env CI=1 ${wrapper} npm test`).decision, 'allow');
});

test('a wrapper reached through timeout is allowed', (t) => {
  const dir = tempDir(t);
  const wrapper = wrapperFile(dir);
  const policy = remotePolicy(dir, wrapper);
  assert.equal(decideCommand(policy, `timeout 30 ${wrapper} npm test`).decision, 'allow');
});

test('a tilde wrapper is expanded against the child HOME', (t) => {
  const dir = tempDir(t);
  const previous = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  });
  writeFileSync(join(dir, 'npm-safe.sh'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  const policy = parseCommandPolicy(
    { enforce: true, rules: [{ match: ['npm test'], placement: 'remote', wrapper: '~/npm-safe.sh' }] },
    dir,
  );
  assert.equal(decideCommand(policy, '~/npm-safe.sh npm test').decision, 'allow');
});

test('a relative wrapper inside the contract cwd is allowed', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'npm-safe.sh'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  const policy = parseCommandPolicy(
    { enforce: true, rules: [{ match: ['npm test'], placement: 'remote', wrapper: './npm-safe.sh' }] },
    dir,
  );
  assert.equal(decideCommand(policy, './npm-safe.sh npm test').decision, 'allow');
});

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------

test('an && chain is refused when one segment is an unwrapped remote command', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'echo ok && npm test').decision, 'refuse');
});

test('an && chain reports the remote placement of its refused segment', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'echo ok && npm test').placement, 'remote');
});

test('a semicolon chain is refused when one segment is an unwrapped remote command', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'npm test; echo done').decision, 'refuse');
});

test('a pipeline is refused when one segment is an unwrapped remote command', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'npm test | tee out').decision, 'refuse');
});

// ---------------------------------------------------------------------------
// Local rules
// ---------------------------------------------------------------------------

test('a local rule allows its command', (t) => {
  const policy = parseCommandPolicy(
    { enforce: true, rules: [{ match: ['git'], placement: 'local' }] },
    tempDir(t),
  );
  assert.equal(decideCommand(policy, 'git status').decision, 'allow');
});

test('a local rule reports local placement', (t) => {
  const policy = parseCommandPolicy(
    { enforce: true, rules: [{ match: ['git'], placement: 'local' }] },
    tempDir(t),
  );
  assert.equal(decideCommand(policy, 'git status').placement, 'local');
});

test('a local command reached through env is allowed', (t) => {
  const policy = parseCommandPolicy(
    { enforce: true, rules: [{ match: ['git'], placement: 'local' }] },
    tempDir(t),
  );
  assert.equal(decideCommand(policy, 'env FOO=bar git status').decision, 'allow');
});

// ---------------------------------------------------------------------------
// Manifest adapter
// ---------------------------------------------------------------------------

test('a manifest-backed remote rule refuses an unwrapped remote command', (t) => {
  const dir = tempDir(t);
  const wrapper = wrapperFile(dir);
  mkdirSync(join(dir, 'scripts', 'devbox'), { recursive: true });
  writeFileSync(
    join(dir, 'scripts', 'devbox', 'command-placement.json'),
    JSON.stringify({ version: 1, rules: [{ match: REMOTE_MATCH, placement: 'remote', wrapper }] }),
  );
  const policy = parseCommandPolicy(
    { enforce: true, manifest: 'scripts/devbox/command-placement.json' },
    dir,
  );
  assert.equal(decideCommand(policy, 'npm test').decision, 'refuse');
});

test('contract rules are evaluated before manifest rules', (t) => {
  const dir = tempDir(t);
  const wrapper = wrapperFile(dir);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(
    join(dir, 'scripts', 'command-placement.json'),
    JSON.stringify({
      version: 1,
      rules: [{ match: ['npm test'], placement: 'remote', wrapper }],
    }),
  );
  const policy = parseCommandPolicy(
    {
      enforce: true,
      rules: [{ match: ['npm test'], placement: 'local' }],
      manifest: 'scripts/command-placement.json',
    },
    dir,
  );
  assert.equal(decideCommand(policy, 'npm test').decision, 'allow');
});

test('manifest rules are appended after contract rules', (t) => {
  const dir = tempDir(t);
  const wrapper = wrapperFile(dir);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(
    join(dir, 'scripts', 'command-placement.json'),
    JSON.stringify({
      version: 1,
      rules: [{ match: ['npm test'], placement: 'remote', wrapper }],
    }),
  );
  const policy = parseCommandPolicy(
    {
      enforce: true,
      rules: [{ match: ['git'], placement: 'local' }],
      manifest: 'scripts/command-placement.json',
    },
    dir,
  );
  assert.equal(policy?.rules[1].match[0], 'npm test');
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('parseCommandPolicy rejects a manifest path that escapes the contract cwd', (t) => {
  const dir = tempDir(t);
  assert.throws(
    () => parseCommandPolicy({ enforce: true, manifest: '../command-placement.json' }, dir),
    /manifest/i,
  );
});

test('parseCommandPolicy rejects an unknown contract policy field', (t) => {
  const dir = tempDir(t);
  assert.throws(
    () => parseCommandPolicy({ enforce: true, rulez: [] }, dir),
    /unknown/i,
  );
});

test('parseCommandPolicy rejects a remote rule without a wrapper', (t) => {
  const dir = tempDir(t);
  assert.throws(
    () => parseCommandPolicy(
      { enforce: true, rules: [{ match: ['npm test'], placement: 'remote' }] },
      dir,
    ),
    /wrapper/i,
  );
});

test('parseCommandPolicy rejects an unknown rule field', (t) => {
  const dir = tempDir(t);
  assert.throws(
    () => parseCommandPolicy(
      { enforce: true, rules: [{ match: ['git'], placement: 'local', note: 'x' }] },
      dir,
    ),
    /unknown/i,
  );
});

test('parseCommandPolicy rejects a non-boolean enforce', (t) => {
  const dir = tempDir(t);
  assert.throws(
    () => parseCommandPolicy({ enforce: 'yes', rules: [{ match: ['git'], placement: 'local' }] }, dir),
    /enforce/i,
  );
});

test('parseCommandPolicy rejects a policy with neither rules nor manifest', (t) => {
  const dir = tempDir(t);
  assert.throws(() => parseCommandPolicy({ enforce: true }, dir), /rules|manifest/i);
});

test('parseCommandPolicy rejects an unknown manifest field', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'command-placement.json'), JSON.stringify({ version: 1, rules: [], extra: true }));
  assert.throws(
    () => parseCommandPolicy({ enforce: true, manifest: 'command-placement.json' }, dir),
    /unknown/i,
  );
});

test('parseCommandPolicy rejects a manifest version other than 1', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'command-placement.json'), JSON.stringify({ version: 2, rules: [] }));
  assert.throws(
    () => parseCommandPolicy({ enforce: true, manifest: 'command-placement.json' }, dir),
    /version/i,
  );
});

test('parseCommandPolicy rejects a manifest wrapper that escapes the contract cwd', (t) => {
  const dir = tempDir(t);
  writeFileSync(
    join(dir, 'command-placement.json'),
    JSON.stringify({
      version: 1,
      rules: [{ match: ['npm test'], placement: 'remote', wrapper: '../npm-safe.sh' }],
    }),
  );
  assert.throws(
    () => parseCommandPolicy({ enforce: true, manifest: 'command-placement.json' }, dir),
    /wrapper/i,
  );
});

// ---------------------------------------------------------------------------
// Opaque constructs fail closed under enforce
// ---------------------------------------------------------------------------

test('enforce refuses a command substitution it cannot parse', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'echo "$(npm test)"').decision, 'refuse');
});

test('a command substitution is refused even when the outer command is local', (t) => {
  const policy = parseCommandPolicy(
    { enforce: true, rules: [{ match: ['echo'], placement: 'local' }] },
    tempDir(t),
  );
  assert.equal(decideCommand(policy, 'echo "$(npm test)"').decision, 'refuse');
});

test('a backtick substitution is refused even when the outer command is local', (t) => {
  const policy = parseCommandPolicy(
    { enforce: true, rules: [{ match: ['echo'], placement: 'local' }] },
    tempDir(t),
  );
  assert.equal(decideCommand(policy, 'echo "`npm test`"').decision, 'refuse');
});

test('a command substitution is allowed without a policy', () => {
  assert.equal(decideCommand(null, 'echo "$(npm test)"').decision, 'allow');
});

test('a remote refusal carries the placement error code', (t) => {
  const policy = remotePolicy(tempDir(t));
  const result = decideCommand(policy, 'npm test');
  assert.match(result.reason ?? '', new RegExp(COMMAND_PLACEMENT_ERROR));
});

// ---------------------------------------------------------------------------
// Indirection resolution (CMD1b)
// ---------------------------------------------------------------------------

test('bash -c recursion refuses an unwrapped remote command', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, "bash -c 'npm test'").decision, 'refuse');
});

test('sh -lc recursion reports the remote placement of its inner command', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, "sh -lc 'node --test'").placement, 'remote');
});

test('bash -c allows an inner local command', (t) => {
  const policy = parseCommandPolicy(
    { enforce: true, rules: [{ match: ['git'], placement: 'local' }] },
    tempDir(t),
  );
  assert.equal(decideCommand(policy, "bash -c 'git status'").decision, 'allow');
});

test('bash -c allows an inner local rg command', (t) => {
  const policy = parseCommandPolicy(
    { enforce: true, rules: [{ match: ['rg'], placement: 'local' }] },
    tempDir(t),
  );
  assert.equal(decideCommand(policy, "bash -c 'rg foo src'").decision, 'allow');
});

test('bash -c allows the configured wrapper for an inner remote command', (t) => {
  const dir = tempDir(t);
  const wrapper = wrapperFile(dir);
  const policy = remotePolicy(dir, wrapper);
  assert.equal(decideCommand(policy, `bash -c '${wrapper} npm test'`).decision, 'allow');
});

test('bash -c refuses a command substitution it cannot parse', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, `bash -c "$(printf 'npm test')"`).decision, 'refuse');
});

test('a file-based shell invocation is refused as opaque', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'bash scripts/test.sh').decision, 'refuse');
});

test('npx resolves an unwrapped binary to a remote refusal', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'npx vitest run').decision, 'refuse');
});

test('npx options do not hide the remote binary', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'npx --yes --no-install vitest').decision, 'refuse');
});

test('an npx remote refusal reports remote placement', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'npx vitest run').placement, 'remote');
});

test('npm run resolves the nearest package script', (t) => {
  const dir = tempDir(t);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { 'test:unit': 'node --test' } }),
  );
  const policy = remotePolicy(dir);
  assert.equal(decideCommand(policy, 'npm run test:unit').decision, 'refuse');
});

test('npm run resolves a package script to its local placement', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'git status' } }));
  const policy = parseCommandPolicy(
    { enforce: true, rules: [{ match: ['git'], placement: 'local' }] },
    dir,
  );
  assert.equal(decideCommand(policy, 'npm run lint').placement, 'local');
});

test('npm test resolves the package test script', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const policy = remotePolicy(dir);
  assert.equal(decideCommand(policy, 'npm test').placement, 'remote');
});

test('a package script cycle is refused at the depth cap', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'npm test' } }));
  const policy = remotePolicy(dir);
  assert.equal(decideCommand(policy, 'npm test').decision, 'refuse');
});

test('node --import with eval is refused as dynamic evaluation', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(
    decideCommand(policy, `node --import tsx -e "execSync('npm test')"`).placement,
    'unknown',
  );
});

test('xargs is refused as an opaque executor', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, 'xargs npm test').decision, 'refuse');
});

test('find -exec is refused as an opaque executor', (t) => {
  const policy = remotePolicy(tempDir(t));
  assert.equal(decideCommand(policy, `find . -name '*.test.ts' -exec node --test {} +`).decision, 'refuse');
});

// ---------------------------------------------------------------------------
// Devbox placement manifest schema (schemaVersion 1)
// ---------------------------------------------------------------------------

test('parseCommandManifest accepts a Junior version 1 rules manifest', () => {
  const rules = parseCommandManifest(
    { version: 1, rules: [{ match: ['git'], placement: 'local' }] },
    'junior manifest',
  );
  assert.deepEqual(rules, [{ match: ['git'], placement: 'local' }]);
});

test('parseCommandManifest accepts the repository devbox placement fixture', () => {
  const rules = parseCommandManifest(
    devboxFixture(),
    'devbox fixture',
    process.cwd(),
    DEVBOX_WRAPPER,
  );
  assert.equal(rules.length, 2);
});

test('a devbox local-control-plane entry allows a direct run', () => {
  const policy = devboxPolicy();
  assert.equal(
    decideCommand(policy, ['node', LOCAL_CONTROL_PLANE, 'status']).decision,
    'allow',
  );
});

test('a devbox local-control-plane entry reports local placement', () => {
  const policy = devboxPolicy();
  assert.equal(decideCommand(policy, ['node', LOCAL_CONTROL_PLANE]).placement, 'local');
});

test('a dot-slash devbox path token matches', () => {
  const policy = devboxPolicy();
  assert.equal(decideCommand(policy, ['node', `./${LOCAL_CONTROL_PLANE}`]).decision, 'allow');
});

test('a nested devbox path token matches by suffix', () => {
  const policy = devboxPolicy();
  assert.equal(decideCommand(policy, ['node', `a/b/${LOCAL_CONTROL_PLANE}`]).decision, 'allow');
});

test('a backslash devbox path token matches after normalization', () => {
  const policy = devboxPolicy();
  assert.equal(
    decideCommand(policy, ['node', LOCAL_CONTROL_PLANE.replaceAll('/', '\\')]).decision,
    'allow',
  );
});

test('a devbox local-control-plane entry is refused through the configured wrapper', () => {
  const policy = devboxPolicy();
  assert.equal(
    decideCommand(policy, [DEVBOX_WRAPPER, 'node', LOCAL_CONTROL_PLANE]).decision,
    'refuse',
  );
});

test('a devbox local-control-plane entry is refused through an unconfigured safe wrapper', () => {
  const policy = devboxPolicy();
  assert.equal(
    decideCommand(policy, ['tools/local-safe.sh', 'node', LOCAL_CONTROL_PLANE]).decision,
    'refuse',
  );
});

test('a devbox local-control-plane refusal names the path and local command', () => {
  const policy = devboxPolicy();
  const result = decideCommand(policy, [DEVBOX_WRAPPER, 'node', LOCAL_CONTROL_PLANE]);
  assert.match(
    result.reason ?? '',
    new RegExp(`${escapeRegExp(LOCAL_CONTROL_PLANE)} is a local SSH control-plane command; run locally: node ${escapeRegExp(LOCAL_CONTROL_PLANE)}`),
  );
});

test('a devbox remote-heavy entry is allowed through the contract remote wrapper', () => {
  const policy = devboxPolicy();
  assert.equal(
    decideCommand(policy, [DEVBOX_WRAPPER, 'node', REMOTE_HEAVY]).decision,
    'allow',
  );
});

test('a devbox remote-heavy entry reports remote placement through the contract wrapper', () => {
  const policy = devboxPolicy();
  assert.equal(
    decideCommand(policy, [DEVBOX_WRAPPER, 'node', REMOTE_HEAVY]).placement,
    'remote',
  );
});

test('a devbox remote-heavy entry is refused without the contract wrapper', () => {
  const policy = devboxPolicy();
  assert.equal(decideCommand(policy, ['node', REMOTE_HEAVY]).decision, 'refuse');
});

test('a devbox remote-heavy entry without contract remoteWrapper is rejected', () => {
  assert.throws(
    () => parseCommandPolicy({ enforce: true, manifest: DEVBOX_FIXTURE }, process.cwd()),
    new RegExp(`${escapeRegExp(REMOTE_HEAVY)}.*remoteWrapper|remoteWrapper.*${escapeRegExp(REMOTE_HEAVY)}`, 'i'),
  );
});

test('parseCommandManifest rejects a devbox schemaVersion other than 1 with supported versions', () => {
  assert.throws(
    () => parseCommandManifest({ schemaVersion: 2, commands: [] }, 'devbox manifest'),
    /schemaVersion.*supported/i,
  );
});

test('parseCommandManifest rejects a manifest with both rules and commands', () => {
  assert.throws(
    () => parseCommandManifest(
      { schemaVersion: 1, rules: [{ match: ['git'], placement: 'local' }], commands: [] },
      'mixed manifest',
    ),
    /rules.*commands.*supported|commands.*rules.*supported/i,
  );
});

test('parseCommandManifest rejects an unknown devbox entry field', () => {
  assert.throws(
    () => parseCommandManifest(
      {
        schemaVersion: 1,
        commands: [{
          path: LOCAL_CONTROL_PLANE,
          placement: 'local-control-plane',
          reason: 'local',
          remoteWrapperPolicy: 'refuse',
          localCommand: `node ${LOCAL_CONTROL_PLANE}`,
          note: 'typo',
        }],
      },
      'devbox manifest',
    ),
    /unknown field "note"/i,
  );
});

test('an unknown devbox entry field reports the supported schema versions', () => {
  assert.throws(
    () => parseCommandManifest(
      {
        schemaVersion: 1,
        commands: [{
          path: LOCAL_CONTROL_PLANE,
          placement: 'local-control-plane',
          reason: 'local',
          remoteWrapperPolicy: 'refuse',
          localCommand: `node ${LOCAL_CONTROL_PLANE}`,
          note: 'typo',
        }],
      },
      'devbox manifest',
    ),
    /supported schema versions/i,
  );
});

test('parseCommandManifest rejects a devbox path with unsafe characters', () => {
  assert.throws(
    () => parseCommandManifest(
      {
        schemaVersion: 1,
        commands: [{
          path: 'scripts/devbox/bad name.ts',
          placement: 'local-control-plane',
          reason: 'local',
          remoteWrapperPolicy: 'refuse',
          localCommand: 'node bad',
        }],
      },
      'devbox manifest',
    ),
    /path.*unsafe/i,
  );
});

test('an unsafe devbox path reports the supported schema versions', () => {
  assert.throws(
    () => parseCommandManifest(
      {
        schemaVersion: 1,
        commands: [{
          path: 'scripts/devbox/bad path.ts',
          placement: 'local-control-plane',
          reason: 'local',
          remoteWrapperPolicy: 'refuse',
          localCommand: 'node bad',
        }],
      },
      'devbox manifest',
    ),
    /supported schema versions/i,
  );
});

test('parseCommandManifest rejects a devbox path without a slash', () => {
  assert.throws(
    () => parseCommandManifest(
      {
        schemaVersion: 1,
        commands: [{
          path: 'fleet-controller.ts',
          placement: 'local-control-plane',
          reason: 'local',
          remoteWrapperPolicy: 'refuse',
          localCommand: 'node fleet-controller.ts',
        }],
      },
      'devbox manifest',
    ),
    /path.*contain/i,
  );
});
