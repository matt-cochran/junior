// ---------------------------------------------------------------------------
// Behavioral tests for the provider key setter/remover (`junior auth`).
//
// Every scenario drives the public library or CLI in its own temp agent
// directory and asserts exactly one observable outcome. No test performs a
// network call: `--verify` is exercised only where checkCredentialsOnline
// returns its local "no credential" result.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeProviderKey, setProviderKey, recordExternalContextConsent, removeExternalContextConsent, readExternalContextConsent, verifyExternalContextConsentToken, doctorExternalContextAuthorization } from './auth.ts';

const ROOT = import.meta.dirname;
const JUNIOR = join(ROOT, 'junior.ts');
const NODE = process.execPath;
const WINDOWS = process.platform === 'win32';

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-auth-'));
}

function authPath(dir: string): string {
  return join(dir, 'auth.json');
}

function readAuth(dir: string): any {
  return JSON.parse(readFileSync(authPath(dir), 'utf8'));
}

function writeAuth(dir: string, value: unknown, raw = false): void {
  writeFileSync(authPath(dir), raw ? (value as string) : JSON.stringify(value));
}

function deps(dir: string): { env: NodeJS.ProcessEnv } {
  return { env: { PI_CODING_AGENT_DIR: dir } };
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function runAuth(args: string[], dir: string, input = '') {
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: dir };
  delete env.OPENROUTER_API_KEY;
  return spawnSync(NODE, [JUNIOR, 'auth', ...args], { cwd: dir, encoding: 'utf8', input, env });
}

// --- setProviderKey ---------------------------------------------------------

test('setProviderKey writes an api_key credential for the named provider', () => {
  const dir = workdir();
  setProviderKey('github', 'ghp_test_key', deps(dir));
  assert.deepEqual(readAuth(dir).github, { type: 'api_key', key: 'ghp_test_key' });
});

test('setProviderKey preserves an unrelated provider entry', () => {
  const dir = workdir();
  writeAuth(dir, { openrouter: { type: 'api_key', key: 'existing' } });
  setProviderKey('github', 'ghp_test_key', deps(dir));
  assert.deepEqual(readAuth(dir).openrouter, { type: 'api_key', key: 'existing' });
});

test('setProviderKey throws on malformed existing JSON', () => {
  const dir = workdir();
  writeAuth(dir, '{ not json', true);
  assert.throws(() => setProviderKey('github', 'k', deps(dir)));
});

test('setProviderKey leaves malformed existing JSON byte-identical', () => {
  const dir = workdir();
  writeAuth(dir, '{ not json', true);
  const before = readFileSync(authPath(dir), 'utf8');
  try {
    setProviderKey('github', 'k', deps(dir));
  } catch {
    /* the refusal is asserted in the sibling scenario */
  }
  assert.equal(readFileSync(authPath(dir), 'utf8'), before);
});

test('setProviderKey throws when the existing auth file is not an object', () => {
  const dir = workdir();
  writeAuth(dir, ['not', 'an', 'object']);
  assert.throws(() => setProviderKey('github', 'k', deps(dir)));
});

test('setProviderKey creates the auth file when none exists', () => {
  const dir = workdir();
  setProviderKey('github', 'k', deps(dir));
  assert.deepEqual(readAuth(dir), { github: { type: 'api_key', key: 'k' } });
});

test('setProviderKey writes the auth file with mode 600', { skip: WINDOWS }, () => {
  const dir = workdir();
  setProviderKey('github', 'k', deps(dir));
  assert.equal(fileMode(authPath(dir)), 0o600);
});

test('setProviderKey creates the agent directory with mode 700', { skip: WINDOWS }, () => {
  const base = workdir();
  const dir = join(base, 'agent');
  setProviderKey('github', 'k', deps(dir));
  assert.equal(fileMode(dir), 0o700);
});

test('setProviderKey tightens an existing agent directory to mode 700', { skip: WINDOWS }, () => {
  const dir = workdir();
  chmodSync(dir, 0o755);
  setProviderKey('github', 'k', deps(dir));
  assert.equal(fileMode(dir), 0o700);
});

// --- removeProviderKey ------------------------------------------------------

test('removeProviderKey deletes the named provider', () => {
  const dir = workdir();
  writeAuth(dir, { github: { type: 'api_key', key: 'a' }, openrouter: { type: 'api_key', key: 'b' } });
  removeProviderKey('github', deps(dir));
  assert.equal(readAuth(dir).github, undefined);
});

test('removeProviderKey preserves an unrelated provider entry', () => {
  const dir = workdir();
  writeAuth(dir, { github: { type: 'api_key', key: 'a' }, openrouter: { type: 'api_key', key: 'b' } });
  removeProviderKey('github', deps(dir));
  assert.deepEqual(readAuth(dir).openrouter, { type: 'api_key', key: 'b' });
});

test('removeProviderKey throws on malformed existing JSON', () => {
  const dir = workdir();
  writeAuth(dir, '{ not json', true);
  assert.throws(() => removeProviderKey('github', deps(dir)));
});

test('removeProviderKey leaves malformed existing JSON byte-identical', () => {
  const dir = workdir();
  writeAuth(dir, '{ not json', true);
  const before = readFileSync(authPath(dir), 'utf8');
  try {
    removeProviderKey('github', deps(dir));
  } catch {
    /* the refusal is asserted in the sibling scenario */
  }
  assert.equal(readFileSync(authPath(dir), 'utf8'), before);
});

// --- CLI --------------------------------------------------------------------

test('junior auth --help exits successfully', () => {
  assert.equal(runAuth(['--help'], workdir()).status, 0);
});

test('junior auth consent grant records consent for the named provider and project', () => {
  const dir = workdir();
  const project = workdir();
  runAuth(['consent', 'grant', 'openrouter', '--project', project], dir);
  assert.equal(readExternalContextConsent(project, 'openrouter').granted, true);
});

test('junior auth set stores a key read from piped stdin', () => {
  const dir = workdir();
  runAuth(['set', 'github'], dir, 'ghp_piped_key\n');
  assert.equal(readAuth(dir).github.key, 'ghp_piped_key');
});

test('junior auth set rejects a key passed as a command argument', () => {
  const dir = workdir();
  assert.notEqual(runAuth(['set', 'github', 'argv_leaked_key'], dir, 'piped_key\n').status, 0);
});

test('junior auth set rejects an unknown --key option', () => {
  const dir = workdir();
  assert.notEqual(runAuth(['set', 'github', '--key=argv_leaked_key'], dir, 'piped_key\n').status, 0);
});

test('junior auth set never prints a piped key', () => {
  const dir = workdir();
  const key = 'sk-CANARY-piped-9f3a2b';
  const result = runAuth(['set', 'github'], dir, `${key}\n`);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(key));
});

test('junior auth set --verify never prints a piped key', () => {
  const dir = workdir();
  const key = 'sk-CANARY-verify-4c1d';
  const result = runAuth(['set', 'github', '--verify'], dir, `${key}\n`);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(key));
});

test('junior auth remove deletes the named provider', () => {
  const dir = workdir();
  writeAuth(dir, { github: { type: 'api_key', key: 'a' }, openrouter: { type: 'api_key', key: 'b' } });
  runAuth(['remove', 'github'], dir);
  assert.equal(readAuth(dir).github, undefined);
});

test('junior auth remove preserves an unrelated provider entry', () => {
  const dir = workdir();
  writeAuth(dir, { github: { type: 'api_key', key: 'a' }, openrouter: { type: 'api_key', key: 'b' } });
  runAuth(['remove', 'github'], dir);
  assert.deepEqual(readAuth(dir).openrouter, { type: 'api_key', key: 'b' });
});

test('junior --help lists the auth command', () => {
  const result = spawnSync(NODE, [JUNIOR, '--help'], { encoding: 'utf8' });
  assert.match(result.stdout, /\bauth\b/);
});

test('junior --help documents auth consent grant, status and remove', () => {
  const result = spawnSync(NODE, [JUNIOR, '--help'], { encoding: 'utf8' });
  assert.match(result.stdout, /auth consent \[grant\|remove\|status\] <provider> \[--project <dir>\]/);
});

test('junior auth --help documents consent grant with an optional --project', () => {
  assert.match(runAuth(['--help'], workdir()).stdout, /auth consent \[grant\] <provider> \[--project <dir>\]/);
});

test('junior --help stays at twelve lines or fewer', () => {
  const lines = spawnSync(NODE, [JUNIOR, '--help'], { encoding: 'utf8' }).stdout.trim().split('\n');
  assert.ok(lines.length <= 12);
});
test('junior auth set --verify reports that a non-openrouter provider cannot be verified online', () => {
  const dir = workdir();
  assert.match(runAuth(['set', 'github', '--verify'], dir, 'ghp_piped_key\n').stdout, /online verification is only available for openrouter/);
});

// --- external-context consent ----------------------------------------------

test('recording external-context consent authorizes that provider for the project', () => {
  const dir = workdir();
  recordExternalContextConsent(dir, 'openrouter');
  assert.equal(readExternalContextConsent(dir, 'openrouter').granted, true);
});

test('removing external-context consent revokes that provider for the project', () => {
  const dir = workdir();
  recordExternalContextConsent(dir, 'openrouter');
  removeExternalContextConsent(dir, 'openrouter');
  assert.equal(readExternalContextConsent(dir, 'openrouter').granted, false);
});

test('a consent token is bound to its provider and project', () => {
  const dir = workdir();
  const token = recordExternalContextConsent(dir, 'openrouter').token;
  assert.equal(verifyExternalContextConsentToken(join(dir, 'other-project'), 'openrouter', token), false);
});

test('external-context authorization stays separate from runtime readiness', () => {
  const dir = workdir();
  const readiness = doctorExternalContextAuthorization(dir, 'openrouter', true);
  assert.equal(readiness.readyForDelegation, false);
});
