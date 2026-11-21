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
import { removeProviderKey, setProviderKey, recordExternalContextConsent, removeExternalContextConsent, readExternalContextConsent, verifyExternalContextConsentToken, doctorExternalContextAuthorization, policyWidens, main as authMain } from './auth.ts';

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

const AGENT_ENV_KEYS = ['CLAUDECODE', 'PI_CODING_AGENT', 'JUNIOR_WORKER', 'CODEX_SANDBOX', 'CURSOR_AGENT'];

function humanEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: dir };
  delete env.OPENROUTER_API_KEY;
  for (const key of AGENT_ENV_KEYS) delete env[key];
  return env;
}

function runAuth(args: string[], dir: string, input = '') {
  return spawnSync(NODE, [JUNIOR, 'auth', ...args], { cwd: dir, encoding: 'utf8', input, env: humanEnv(dir) });
}

function runAuthAsAgent(args: string[], dir: string, marker = 'CLAUDECODE', input = '') {
  const env = humanEnv(dir);
  env[marker] = '1';
  return spawnSync(NODE, [JUNIOR, 'auth', ...args], { cwd: dir, encoding: 'utf8', input, env });
}

function budgetApprovals(dir: string): any[] {
  try {
    return JSON.parse(readFileSync(join(dir, '.junior', 'budget-approvals.json'), 'utf8'));
  } catch {
    return [];
  }
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

test('junior auth budget approve records the approved contract amount', () => {
  const dir = workdir();
  const project = workdir();
  runAuth(['budget', 'approve', 'G2', '--tokens', '17000000', '--project', project], dir);
  assert.equal(budgetApprovals(project)[0].maxTotalTokens, 17000000);
});

test('junior auth budget approve refuses an agent without a human terminal', () => {
  const dir = workdir();
  const project = workdir();
  assert.notEqual(runAuthAsAgent(['budget', 'approve', 'G2', '--tokens', '17000000', '--project', project], dir).status, 0);
});

test('junior auth budget approve records nothing when an agent is refused', () => {
  const dir = workdir();
  const project = workdir();
  runAuthAsAgent(['budget', 'approve', 'G2', '--tokens', '17000000', '--project', project], dir);
  assert.deepEqual(budgetApprovals(project), []);
});

test('junior auth consent grant refuses an agent without a human terminal', () => {
  const dir = workdir();
  const project = workdir();
  assert.notEqual(runAuthAsAgent(['consent', 'grant', 'openrouter', '--project', project], dir).status, 0);
});

test('junior auth consent grant records nothing when an agent is refused', () => {
  const dir = workdir();
  const project = workdir();
  runAuthAsAgent(['consent', 'grant', 'openrouter', '--project', project], dir);
  assert.equal(readExternalContextConsent(project, 'openrouter').granted, false);
});

test('a human typing the shown budget code lets auth budget approve record it', async () => {
  const dir = workdir();
  const project = workdir();
  let shown = '';
  await authMain(['budget', 'approve', 'G2', '--tokens', '17000000', '--project', project], {
    env: { PI_CODING_AGENT_DIR: dir },
    humanApproval: { isTTY: true, prompt: (question: string) => { shown = /Enter code ([A-Z0-9]{6})/.exec(question)?.[1] ?? ''; return shown; } },
    clock: { iso: () => '2026-01-01T00:00:00.000Z' },
  } as any);
  assert.equal(budgetApprovals(project)[0].token, shown);
});

test('a human typing the shown consent code lets auth consent grant record it', async () => {
  const dir = workdir();
  const project = workdir();
  await authMain(['consent', 'grant', 'openrouter', '--project', project], {
    env: { PI_CODING_AGENT_DIR: dir },
    humanApproval: { isTTY: true, prompt: (question: string) => /Enter code ([A-Z0-9]{6})/.exec(question)?.[1] ?? '' },
  } as any);
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

// --- data-destination policy consent (ADR 0017 R6) -------------------------

function writeProjectPolicy(project: string, dataPolicy: unknown): void {
  writeFileSync(join(project, 'delivery.config.json'), JSON.stringify({ models: { dataPolicy } }));
}

test('consent policy hash is stable across object key and array element order', () => {
  const first = recordExternalContextConsent(workdir(), 'openrouter', { dataPolicy: { regions: ['US', 'DE'], providers: { only: ['b', 'a'] }, zdr: true } });
  const second = recordExternalContextConsent(workdir(), 'openrouter', { dataPolicy: { zdr: true, providers: { only: ['a', 'b'] }, regions: ['DE', 'US'] } });
  assert.equal(first.dataPolicyHash, second.dataPolicyHash);
});

test('consent records a one-line policy summary', () => {
  const record = recordExternalContextConsent(workdir(), 'openrouter', { dataPolicy: { dataCollection: 'deny', zdr: true, regions: ['US'], allowFallbacks: false } });
  assert.equal(record.dataPolicySummary, 'dataCollection deny; zdr; regions US; fallbacks off');
});

test('consent without a policy records a null policy hash', () => {
  assert.equal(recordExternalContextConsent(workdir(), 'openrouter').dataPolicyHash, null);
});

test('widening dataCollection from deny to allow widens the policy', () => {
  assert.equal(policyWidens({ dataCollection: 'deny' }, { dataCollection: 'allow' }), true);
});

test('removing dataCollection deny widens the policy', () => {
  assert.equal(policyWidens({ dataCollection: 'deny' }, {}), true);
});

test('disabling zdr widens the policy', () => {
  assert.equal(policyWidens({ zdr: true }, { zdr: false }), true);
});

test('removing zdr widens the policy', () => {
  assert.equal(policyWidens({ zdr: true }, {}), true);
});

test('adding a region widens the policy', () => {
  assert.equal(policyWidens({ regions: ['US'] }, { regions: ['US', 'DE'] }), true);
});

test('removing regions widens the policy', () => {
  assert.equal(policyWidens({ regions: ['US'] }, {}), true);
});

test('adding a provider to only widens the policy', () => {
  assert.equal(policyWidens({ providers: { only: ['a'] } }, { providers: { only: ['a', 'b'] } }), true);
});

test('removing only widens the policy', () => {
  assert.equal(policyWidens({ providers: { only: ['a'] } }, {}), true);
});

test('removing a provider from ignore widens the policy', () => {
  assert.equal(policyWidens({ providers: { ignore: ['a'] } }, {}), true);
});

test('enabling fallbacks from an absent setting widens the policy', () => {
  assert.equal(policyWidens({ dataCollection: 'deny' }, { dataCollection: 'deny', allowFallbacks: true }), true);
});

test('removing a policy widens the policy', () => {
  assert.equal(policyWidens({ dataCollection: 'deny' }, null), true);
});

test('tightening a policy does not widen it', () => {
  assert.equal(policyWidens({ dataCollection: 'allow' }, { dataCollection: 'deny', zdr: true, regions: ['US'], providers: { ignore: ['a'] } }), false);
});

test('moving from no policy to a policy does not widen it', () => {
  assert.equal(policyWidens(null, { dataCollection: 'deny', regions: ['US'] }), false);
});

test('a policy opened after policy-free consent keeps consent', () => {
  const project = workdir();
  recordExternalContextConsent(project, 'openrouter');
  assert.equal(readExternalContextConsent(project, 'openrouter', { dataPolicy: { dataCollection: 'deny' } }).granted, true);
});

test('a tightened policy keeps consent', () => {
  const project = workdir();
  recordExternalContextConsent(project, 'openrouter', { dataPolicy: { dataCollection: 'allow' } });
  assert.equal(readExternalContextConsent(project, 'openrouter', { dataPolicy: { dataCollection: 'deny' } }).granted, true);
});

test('an unchanged policy keeps consent', () => {
  const project = workdir();
  recordExternalContextConsent(project, 'openrouter', { dataPolicy: { regions: ['US'] } });
  assert.equal(readExternalContextConsent(project, 'openrouter', { dataPolicy: { regions: ['US'] } }).granted, true);
});

test('a widened dataCollection policy invalidates consent', () => {
  const project = workdir();
  recordExternalContextConsent(project, 'openrouter', { dataPolicy: { dataCollection: 'deny' } });
  assert.equal(readExternalContextConsent(project, 'openrouter', { dataPolicy: { dataCollection: 'allow' } }).granted, false);
});

test('a widened policy invalidates consent with a re-grant instruction', () => {
  const project = workdir();
  recordExternalContextConsent(project, 'openrouter', { dataPolicy: { regions: ['US'] } });
  assert.equal(readExternalContextConsent(project, 'openrouter', { dataPolicy: { regions: ['US', 'DE'] } }).reason, 'data policy widened since consent; run junior auth consent grant <provider> again');
});

test('removing the policy after consent invalidates consent', () => {
  const project = workdir();
  recordExternalContextConsent(project, 'openrouter', { dataPolicy: { dataCollection: 'deny' } });
  assert.equal(readExternalContextConsent(project, 'openrouter', { dataPolicy: null }).granted, false);
});

test('junior auth consent grant prints the effective policy summary', () => {
  const dir = workdir();
  const project = workdir();
  writeProjectPolicy(project, { dataCollection: 'deny', regions: ['US'] });
  const result = runAuth(['consent', 'grant', 'openrouter', '--project', project], dir);
  assert.equal(JSON.parse(result.stdout).dataPolicySummary, 'dataCollection deny; regions US; fallbacks off');
});

test('junior auth consent grant records the effective policy summary', () => {
  const dir = workdir();
  const project = workdir();
  writeProjectPolicy(project, { dataCollection: 'deny', regions: ['US'] });
  runAuth(['consent', 'grant', 'openrouter', '--project', project], dir);
  assert.equal(readExternalContextConsent(project, 'openrouter').record?.dataPolicySummary, 'dataCollection deny; regions US; fallbacks off');
});

test('policyWidens counts a newly allowed uncovered path as widening', () => {
  assert.equal(policyWidens({ dataCollection: 'deny' }, { dataCollection: 'deny', allowUncovered: ['typesafe'] }), true);
});
