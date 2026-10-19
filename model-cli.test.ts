// ---------------------------------------------------------------------------
// Behavioral tests for the `junior model` command and model adoption during
// `junior update`.
//
// Every scenario drives the public module API (planUpgrades, applyUpgrades,
// runModelCommand, adoptModelUpdates) or the public CLI entry point with
// isolated temp directories. Catalog reads are injected through the `fetch`
// seam and Pi's agent directory through PI_CODING_AGENT_DIR, so no test touches
// the network or the real ~/.pi / ~/.junior. Each test asserts exactly one
// observable outcome.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptModelUpdates, applyUpgrades, planUpgrades, runModelCommand } from './model-cli.ts';

const ROOT = import.meta.dirname;
const JUNIOR = join(ROOT, 'junior.ts');

const general = { id: 'general', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', strengths: 's', default: true };
const reasoning = { id: 'deep-reasoning', provider: 'openrouter', model: 'deepseek/deepseek-v4-pro-0813', strengths: 'r' };
const NEWER = 'deepseek/deepseek-v4.1-flash-1017';
const NEWER_REASONING = 'deepseek/deepseek-v4-pro-1017';

function modelConfig(overrides: any = {}): any {
  return {
    provider: 'openrouter',
    model: general.model,
    source: 'project',
    path: null,
    pinnedVerdict: { class: 'commodity' },
    routing: 'auto',
    autoUpgrade: false,
    defaultProfile: 'general',
    roster: [{ ...general }],
    rejected: [],
    ...overrides,
  };
}

function generalUpdate(overrides: any = {}): any {
  return { profile: 'general', provider: 'openrouter', current: general.model, newer: [NEWER], latest: NEWER, isDefault: true, ...overrides };
}

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-model-'));
}

function writeConfig(dir: string, obj: any): string {
  const path = join(dir, 'delivery.config.json');
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
  return path;
}

function readConfig(dir: string): any {
  return JSON.parse(readFileSync(join(dir, 'delivery.config.json'), 'utf8'));
}

function agentHome(models: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'junior-model-agent-'));
  writeFileSync(join(dir, 'models-store.json'), JSON.stringify({ openrouter: { models: models.map((id) => ({ id })) } }));
  return dir;
}

function tempEnv(models: string[] = []): NodeJS.ProcessEnv {
  return { PI_CODING_AGENT_DIR: agentHome(models) };
}

const catalogFetch = (ids: string[]) => (async () => ({ status: 200, json: async () => ({ data: ids.map((id) => ({ id })) }) }));

// --- planUpgrades: default planning ----------------------------------------

test('planUpgrades turns a deepseek update into a default change to its latest id', () => {
  const { changes } = planUpgrades(modelConfig(), [generalUpdate()], {});
  assert.deepEqual(changes, [{ profile: 'general', from: general.model, to: NEWER, isDefault: true, price: { from: null, to: null, inputRatio: null, outputRatio: null, pricier: null } }]);
});

test('planUpgrades marks a change pricier when the target costs more per token', () => {
  const prices = {
    [general.model]: { inputPerM: 0.033, outputPerM: 0.08, cacheReadPerM: null },
    [NEWER]: { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: null },
  };
  const { changes } = planUpgrades(modelConfig(), [generalUpdate()], { prices });
  assert.equal(changes[0].price.pricier, true);
});

test('planUpgrades reports the input ratio for a change when prices are given', () => {
  const prices = {
    [general.model]: { inputPerM: 0.033, outputPerM: 0.08, cacheReadPerM: null },
    [NEWER]: { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: null },
  };
  const { changes } = planUpgrades(modelConfig(), [generalUpdate()], { prices });
  assert.equal(changes[0].price.inputRatio, 4.55);
});

test('planUpgrades reports the update as a plan with no refusals', () => {
  const { refused } = planUpgrades(modelConfig(), [generalUpdate()], {});
  assert.deepEqual(refused, []);
});

// --- planUpgrades: policy refusals -----------------------------------------

test('planUpgrades refuses an explicit frontier target', () => {
  const { refused } = planUpgrades(modelConfig(), [generalUpdate()], { to: 'anthropic/claude-sonnet-4' });
  assert.equal(refused.length, 1);
});

test('planUpgrades reports the policy reason for a refused target', () => {
  const { refused } = planUpgrades(modelConfig(), [generalUpdate()], { to: 'anthropic/claude-sonnet-4' });
  assert.match(refused[0].reason, /frontier/i);
});

test('planUpgrades produces no change for a refused explicit target', () => {
  const { changes } = planUpgrades(modelConfig(), [generalUpdate()], { to: 'anthropic/claude-sonnet-4' });
  assert.equal(changes.length, 0);
});

// --- applyUpgrades: default profile ----------------------------------------

test('applyUpgrades sets the top-level model for a default-profile change', () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: 'old/model-1', pi: { name: 'p' }, models: { routing: 'auto' } });
  applyUpgrades(dir, [{ profile: 'general', from: 'old/model-1', to: NEWER, isDefault: true }]);
  assert.equal(readConfig(dir).model, NEWER);
});

test('applyUpgrades preserves the provider key for a default-profile change', () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: 'old/model-1', models: { routing: 'auto' } });
  applyUpgrades(dir, [{ profile: 'general', from: 'old/model-1', to: NEWER, isDefault: true }]);
  assert.equal(readConfig(dir).provider, 'openrouter');
});

test('applyUpgrades preserves the pi key for a default-profile change', () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: 'old/model-1', pi: { name: 'pi-coding-agent' }, models: { routing: 'auto' } });
  applyUpgrades(dir, [{ profile: 'general', from: 'old/model-1', to: NEWER, isDefault: true }]);
  assert.equal(readConfig(dir).pi.name, 'pi-coding-agent');
});

test('applyUpgrades preserves models.routing for a default-profile change', () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: 'old/model-1', models: { routing: 'shadow' } });
  applyUpgrades(dir, [{ profile: 'general', from: 'old/model-1', to: NEWER, isDefault: true }]);
  assert.equal(readConfig(dir).models.routing, 'shadow');
});

// --- applyUpgrades: non-default roster -------------------------------------

test('applyUpgrades merges a non-default change into models.roster by profile id', () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto', roster: [{ id: 'deep-reasoning', model: reasoning.model, strengths: 'r' }] } });
  applyUpgrades(dir, [{ profile: 'deep-reasoning', from: reasoning.model, to: NEWER_REASONING, isDefault: false }]);
  assert.equal(readConfig(dir).models.roster.find((e: any) => e.id === 'deep-reasoning').model, NEWER_REASONING);
});

test('applyUpgrades adds a new roster entry for an unseen non-default profile', () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto' } });
  applyUpgrades(dir, [{ profile: 'fast-mechanical', from: 'qwen/qwen3.7-flash', to: 'qwen/qwen3.7-flash-1017', isDefault: false }]);
  assert.equal(readConfig(dir).models.roster.find((e: any) => e.id === 'fast-mechanical').model, 'qwen/qwen3.7-flash-1017');
});

test('applyUpgrades reports not written when there are no changes', () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto' } });
  assert.equal(applyUpgrades(dir, []).written, false);
});

// --- runModelCommand: upgrade ----------------------------------------------

const upgradeDeps = (dir: string, overrides: any = {}) => ({
  cwd: dir,
  env: tempEnv(),
  fetch: catalogFetch([NEWER]),
  isTTY: false,
  ...overrides,
});

test('model upgrade --dry-run never writes delivery.config.json', async () => {
  const dir = workdir();
  const path = writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto' } });
  const before = readFileSync(path, 'utf8');
  await runModelCommand(['upgrade', '--dry-run', '--online'], upgradeDeps(dir));
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('model upgrade without --yes on a non-TTY exits 1', async () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto' } });
  const { exitCode } = await runModelCommand(['upgrade', '--online'], upgradeDeps(dir));
  assert.equal(exitCode, 1);
});

test('model upgrade without --yes on a non-TTY does not write delivery.config.json', async () => {
  const dir = workdir();
  const path = writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto' } });
  const before = readFileSync(path, 'utf8');
  await runModelCommand(['upgrade', '--online'], upgradeDeps(dir));
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('model upgrade --yes writes the planned changes', async () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto' } });
  await runModelCommand(['upgrade', '--yes', '--online'], upgradeDeps(dir));
  assert.equal(readConfig(dir).model, NEWER);
});

test('model upgrade --dry-run reports the planned changes', async () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto' } });
  const { result } = await runModelCommand(['upgrade', '--dry-run', '--online'], upgradeDeps(dir));
  assert.equal(result.applied, false);
});

const pricedCatalogFetch = (pricing: Record<string, { prompt: string; completion: string }>) =>
  (async () => ({
    status: 200,
    json: async () => ({ data: Object.entries(pricing).map(([id, p]) => ({ id, pricing: p })) }),
  }));

test('model upgrade confirmation mentions when a change is pricier', async () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto' } });
  let question = '';
  const confirm = async (q: string) => { question = q; return false; };
  const fetch = pricedCatalogFetch({
    [general.model]: { prompt: '0.000000033', completion: '0.00000008' },
    [NEWER]: { prompt: '0.00000015', completion: '0.0000006' },
  });
  await runModelCommand(['upgrade', '--online'], { cwd: dir, env: tempEnv(), fetch, isTTY: true, confirm });
  assert.match(question, /1 is pricier than the current model/);
});

// --- model status -----------------------------------------------------------

test('model status reports the price of each roster profile', async () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto' } });
  const fetch = pricedCatalogFetch({ [general.model]: { prompt: '0.000000033', completion: '0.00000008' } });
  const { result } = await runModelCommand(['status', '--online'], { cwd: dir, env: tempEnv(), fetch, isTTY: false });
  assert.deepEqual(result.roster[0].price, { inputPerM: 0.033, outputPerM: 0.08, cacheReadPerM: null });
});

// --- model approve / revoke -------------------------------------------------

test('model approve writes a profile key into models.approved', async () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto' } });
  await runModelCommand(['approve', 'long-horizon'], { cwd: dir, env: tempEnv(), isTTY: false });
  assert.deepEqual(readConfig(dir).models.approved, ['long-horizon']);
});

test('model approve preserves existing approved keys', async () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto', approved: ['deep-reasoning'] } });
  await runModelCommand(['approve', 'long-horizon'], { cwd: dir, env: tempEnv(), isTTY: false });
  assert.deepEqual(readConfig(dir).models.approved, ['deep-reasoning', 'long-horizon']);
});

test('model approve preserves unrelated config keys', async () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, pi: { name: 'p' }, models: { routing: 'auto' } });
  await runModelCommand(['approve', 'long-horizon'], { cwd: dir, env: tempEnv(), isTTY: false });
  assert.equal(readConfig(dir).pi.name, 'p');
});

test('model revoke removes an approved key', async () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto', approved: ['long-horizon'] } });
  await runModelCommand(['revoke', 'long-horizon'], { cwd: dir, env: tempEnv(), isTTY: false });
  assert.deepEqual(readConfig(dir).models.approved, []);
});

test('model approve refuses a frontier model id with exit code 1', async () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto' } });
  const { exitCode } = await runModelCommand(['approve', 'anthropic/claude-sonnet-4'], { cwd: dir, env: tempEnv(), isTTY: false });
  assert.equal(exitCode, 1);
});

test('model approve reports a policy reason for a refused frontier model', async () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto' } });
  const { result } = await runModelCommand(['approve', 'anthropic/claude-sonnet-4'], { cwd: dir, env: tempEnv(), isTTY: false });
  assert.match(result.error, /frontier/i);
});

test('model approve of the default profile is a no-op', async () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto' } });
  const { exitCode } = await runModelCommand(['approve', 'general'], { cwd: dir, env: tempEnv(), isTTY: false });
  assert.equal(exitCode, 0);
});

test('model approve of the default profile leaves the config unchanged', async () => {
  const dir = workdir();
  const path = writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto' } });
  const before = readFileSync(path, 'utf8');
  await runModelCommand(['approve', 'general'], { cwd: dir, env: tempEnv(), isTTY: false });
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('model status reports the approved keys', async () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto', approved: ['long-horizon'] } });
  const { result } = await runModelCommand(['status'], { cwd: dir, env: tempEnv(), isTTY: false });
  assert.deepEqual(result.approved, ['long-horizon']);
});

test('model status reports the unapproved setting', async () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto', unapproved: 'default' } });
  const { result } = await runModelCommand(['status'], { cwd: dir, env: tempEnv(), isTTY: false });
  assert.equal(result.unapproved, 'default');
});

// --- adoptModelUpdates ------------------------------------------------------

test('adoptModelUpdates applies newer commodity models when autoUpgrade is true', async () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto', autoUpgrade: true } });
  const result = await adoptModelUpdates(dir, { fetch: catalogFetch([NEWER]), env: tempEnv() });
  assert.equal(result.applied, true);
});

test('adoptModelUpdates reports changes unapplied when autoUpgrade is false', async () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto' } });
  const result = await adoptModelUpdates(dir, { fetch: catalogFetch([NEWER]), env: tempEnv() });
  assert.equal(result.applied, false);
});

test('adoptModelUpdates lists the would-be changes when autoUpgrade is false', async () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto' } });
  const result = await adoptModelUpdates(dir, { fetch: catalogFetch([NEWER]), env: tempEnv() });
  assert.equal(result.changes.length, 1);
});

// --- model list -------------------------------------------------------------

test('model list contains no frontier ids even when the catalog has frontier entries', async () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto' } });
  const fetch = catalogFetch([NEWER, 'anthropic/claude-sonnet-4', 'openai/gpt-4o', 'google/gemini-2.5-pro']);
  const { result } = await runModelCommand(['list', '--online'], { cwd: dir, env: tempEnv(), fetch, isTTY: false });
  assert.deepEqual(result.models.filter((id: string) => /^(anthropic|openai|google)\//.test(id)), []);
});

test('model list still reports the commodity ids in the catalog', async () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto' } });
  const fetch = catalogFetch([NEWER, 'anthropic/claude-sonnet-4']);
  const { result } = await runModelCommand(['list', '--online'], { cwd: dir, env: tempEnv(), fetch, isTTY: false });
  assert.ok(result.models.includes(NEWER));
});

// --- CLI smoke --------------------------------------------------------------

test('junior model status prints JSON with the pinned model', () => {
  const dir = workdir();
  writeConfig(dir, { provider: 'openrouter', model: general.model, models: { routing: 'auto' } });
  const res = spawnSync(process.execPath, [JUNIOR, 'model', 'status'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, JUNIOR_NO_UPDATE_CHECK: '1', PI_CODING_AGENT_DIR: agentHome() },
  });
  assert.equal(JSON.parse(res.stdout).pinned.model, general.model);
});

test('junior handoff accepts --approve-model', () => {
  const dir = workdir();
  const taskPath = join(dir, 'task.json');
  writeFileSync(taskPath, JSON.stringify({ id: 'approve-cli', deliverable: 'd', cwd: dir, acceptance: ['a'], checks: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }], isolation: 'none' }));
  const res = spawnSync(process.execPath, [JUNIOR, 'handoff', taskPath, '--mock', '--quiet', '--approve-model', 'long-horizon'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, JUNIOR_NO_UPDATE_CHECK: '1' },
  });
  assert.equal(JSON.parse(res.stdout).outcome, 'simulation_passed');
});
