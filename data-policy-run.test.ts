// ---------------------------------------------------------------------------
// Behavioral tests for the run-level data-destination policy (ADR 0017 R4, R5).
//
// Every region-resolution test injects a fake fetch; no test touches the
// network and no test reads a credential. Each scenario asserts one observable
// outcome through the public preflight, verification, worker or handoff surface.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataPolicyPreflight, verifyServedProviders } from './data-policy-run.ts';
import { compactHandoff } from './handoff.ts';
import {
  run,
  COMMODITY_MODEL,
  gitRepo,
  commitFile,
  okTask,
  assistant,
  stream,
} from './worker-helpers.test.ts';

function projectWith(policy: unknown, t: any): string {
  const root = mkdtempSync(join(tmpdir(), 'data-policy-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'delivery.config.json'), JSON.stringify({ models: { dataPolicy: policy } }));
  return root;
}

function tempRoot(t: any): string {
  const root = mkdtempSync(join(tmpdir(), 'data-policy-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function response(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

function directoryFetch(endpoints: unknown[], providers: unknown[], calls: string[] = []) {
  return async (url: string) => {
    calls.push(url);
    return response(url.includes('/endpoints') ? { data: { endpoints } } : { data: providers });
  };
}

const alphaEndpoints = [{ provider_name: 'Alpha Cloud', tag: 'alpha/fp8' }];
const alphaProviders = [{ name: 'Alpha Cloud', slug: 'alpha', datacenters: ['US', 'DE'] }];

// --- dataPolicyPreflight (R1-R4) ---

test('No policy returns a null routing without making a metadata request', async (t) => {
  const calls: string[] = [];
  const result = await dataPolicyPreflight({
    cwd: tempRoot(t), provider: 'openrouter', model: COMMODITY_MODEL,
    fetch: directoryFetch(alphaEndpoints, alphaProviders, calls),
  });
  assert.equal(calls.length, 0);
});

test('A non-OpenRouter provider returns a null routing without making a metadata request', async (t) => {
  const calls: string[] = [];
  const cwd = projectWith({ regions: ['US'] }, t);
  const result = await dataPolicyPreflight({
    cwd, provider: 'anthropic', model: COMMODITY_MODEL,
    fetch: directoryFetch(alphaEndpoints, alphaProviders, calls),
  });
  assert.equal(calls.length, 0);
});

test('A policy without regions maps directly to OpenRouter routing preferences', async (t) => {
  const result = await dataPolicyPreflight({
    cwd: projectWith({ dataCollection: 'deny' }, t),
    provider: 'openrouter', model: COMMODITY_MODEL,
  });
  assert.deepEqual(result.routing, { data_collection: 'deny', allow_fallbacks: false });
});

test('Regions resolve to the endpoint tags whose providers lie in the allowed regions', async (t) => {
  const result = await dataPolicyPreflight({
    cwd: projectWith({ regions: ['US', 'DE'] }, t),
    provider: 'openrouter', model: COMMODITY_MODEL,
    fetch: directoryFetch(alphaEndpoints, alphaProviders),
  });
  assert.deepEqual(result.routing?.only, ['alpha/fp8']);
});

test('A region-matched provider listed in ignore leaves no allowed provider', async (t) => {
  const result = await dataPolicyPreflight({
    cwd: projectWith({ regions: ['US', 'DE'], providers: { ignore: ['alpha'] } }, t),
    provider: 'openrouter', model: COMMODITY_MODEL,
    fetch: directoryFetch(alphaEndpoints, alphaProviders),
  });
  assert.match(result.reason ?? '', /data_policy_unsatisfied:.*ignored/i);
});

test('A metadata request failure fails closed naming the requested URL', async (t) => {
  const result = await dataPolicyPreflight({
    cwd: projectWith({ regions: ['US'] }, t),
    provider: 'openrouter', model: COMMODITY_MODEL,
    fetch: async () => response({}, false),
  });
  assert.match(result.reason ?? '', /data_policy_unsatisfied:.*https:\/\/openrouter\.ai\/api\/v1\//);
});

test('No endpoint in the allowed regions fails closed naming the regions', async (t) => {
  const result = await dataPolicyPreflight({
    cwd: projectWith({ regions: ['US'] }, t),
    provider: 'openrouter', model: COMMODITY_MODEL,
    fetch: directoryFetch(
      [{ provider_name: 'Beta Hosting', tag: 'beta/fp8' }],
      [{ name: 'Beta Hosting', slug: 'beta', datacenters: ['FR'] }],
    ),
  });
  assert.match(result.reason ?? '', /data_policy_unsatisfied: model .* no endpoint in the allowed regions US/);
});

test('A provider without datacenter data is named when it empties the allowed set', async (t) => {
  const result = await dataPolicyPreflight({
    cwd: projectWith({ regions: ['US'] }, t),
    provider: 'openrouter', model: COMMODITY_MODEL,
    fetch: directoryFetch(
      [{ provider_name: 'Gamma', tag: 'gamma/fp8' }],
      [{ name: 'Gamma', slug: 'gamma', datacenters: [] }],
    ),
  });
  assert.match(result.reason ?? '', /Gamma/);
});

// --- verifyServedProviders (R5) ---

const directory = [
  { name: 'Alpha Cloud', slug: 'alpha', headquarters: 'United States', datacenters: ['US'] },
  { name: 'Beta Hosting', slug: 'beta', headquarters: 'France', datacenters: ['FR'] },
];

test('A served provider inside the provider list is allowed', () => {
  const result = verifyServedProviders({ providers: { only: ['alpha'] } }, [{ provider: 'Alpha Cloud' }], directory);
  assert.equal(result.providers[0].allowed, true);
});

test('A served provider listed in ignore is not allowed', () => {
  const result = verifyServedProviders({ providers: { ignore: ['Beta Hosting'] } }, [{ provider: 'Beta Hosting' }], directory);
  assert.equal(result.providers[0].allowed, false);
});

test('A served provider outside an explicit only list is not allowed', () => {
  const result = verifyServedProviders({ providers: { only: ['alpha'] } }, [{ provider: 'Beta Hosting' }], directory);
  assert.equal(result.providers[0].allowed, false);
});

test('A served provider outside the region-resolved only list is not allowed', () => {
  const result = verifyServedProviders({ regions: ['US', 'FR'] }, [{ provider: 'Beta Hosting' }], directory, ['alpha/fp8']);
  assert.equal(result.providers[0].allowed, false);
});

test('A served provider with a datacenter outside the regions is not allowed', () => {
  const result = verifyServedProviders({ regions: ['US'] }, [{ provider: 'Beta Hosting' }], directory);
  assert.equal(result.providers[0].allowed, false);
});

test('A served provider with no datacenter data under a regions policy is not allowed', () => {
  const result = verifyServedProviders(
    { regions: ['US'] },
    [{ provider: 'Gamma' }],
    [{ name: 'Gamma', slug: 'gamma', datacenters: [] }],
  );
  assert.equal(result.providers[0].allowed, false);
});

test('A served provider carries its headquarters and datacenters on the verification record', () => {
  const result = verifyServedProviders({}, [{ provider: 'Alpha Cloud' }], directory);
  assert.equal(result.providers[0].headquarters, 'United States');
});

// --- worker preflight and outcome integration (R4, R5) ---

test('A data_policy_unsatisfied run never spawns Pi', async () => {
  const repo = gitRepo();
  commitFile(repo, 'a.txt', 'base\n');
  writeFileSync(join(repo.dir, 'delivery.config.json'), JSON.stringify({
    models: { dataPolicy: { regions: ['US'] } },
  }));
  let spawned = false;
  const result = await run(okTask(repo, { id: 'dp-block', provider: 'openrouter', model: COMMODITY_MODEL }), false, {
    spawnPi: () => {
      spawned = true;
      return { status: 0, stdout: stream({ type: 'session', id: 's' }, assistant(), { type: 'agent_settled' }), stderr: '' };
    },
    dataPolicyFetch: async (url: string) => response(url.includes('/endpoints') ? { data: { endpoints: [] } } : { data: [] }),
  });
  assert.equal(spawned, false);
});

test('A data_policy_unsatisfied run reports the policy reason as its worker error', async () => {
  const repo = gitRepo();
  commitFile(repo, 'a.txt', 'base\n');
  writeFileSync(join(repo.dir, 'delivery.config.json'), JSON.stringify({
    models: { dataPolicy: { regions: ['US'] } },
  }));
  const result = await run(okTask(repo, { id: 'dp-block-reason', provider: 'openrouter', model: COMMODITY_MODEL }), false, {
    spawnPi: () => ({ status: 0, stdout: '', stderr: '' }),
    dataPolicyFetch: async (url: string) => response(url.includes('/endpoints') ? { data: { endpoints: [] } } : { data: [] }),
  });
  assert.match(result.workerError ?? '', /^data_policy_unsatisfied:/);
});

test('The worker receives the region-resolved only list in its routing environment', async () => {
  const repo = gitRepo();
  commitFile(repo, 'a.txt', 'base\n');
  writeFileSync(join(repo.dir, 'delivery.config.json'), JSON.stringify({
    models: { dataPolicy: { regions: ['US', 'DE'] } },
  }));
  let seen: any;
  await run(okTask(repo, { id: 'dp-region-env', provider: 'openrouter', model: COMMODITY_MODEL }), false, {
    spawnPi: (_c: string, _a: string[], opts: any) => {
      seen = opts;
      return { status: 0, stdout: stream({ type: 'session', id: 's' }, assistant(), { type: 'agent_settled' }), stderr: '' };
    },
    dataPolicyFetch: directoryFetch(alphaEndpoints, alphaProviders),
  });
  assert.deepEqual(JSON.parse(seen.env.JUNIOR_PI_OPENROUTER_ROUTING).only, ['alpha/fp8']);
});

test('A served provider outside the data policy fails the run even when checks pass', async () => {
  const repo = gitRepo();
  commitFile(repo, 'a.txt', 'base\n');
  writeFileSync(join(repo.dir, 'delivery.config.json'), JSON.stringify({
    models: { dataPolicy: { providers: { ignore: ['Beta Hosting'] } } },
  }));
  const result = await run(okTask(repo, {
    id: 'dp-violated', provider: 'openrouter', model: COMMODITY_MODEL,
    billing: { mode: 'openrouter' },
  }), false, {
    spawnPi: () => ({
      status: 0,
      stdout: stream({ type: 'session', id: 's' }, assistant({ responseId: 'gen-1' }), { type: 'agent_settled' }),
      stderr: '',
    }),
    billingResolveApiKey: () => 'sk-test',
    billingFetch: async () => ({
      ok: true, status: 200,
      json: async () => ({ data: { id: 'gen-1', model: 'm', total_cost: 0.01, provider_name: 'Beta Hosting' } }),
    }),
  });
  assert.equal(result.status, 'data_policy_violated');
});

test('A data policy with no captured providers records that verification did not run', async () => {
  const repo = gitRepo();
  commitFile(repo, 'a.txt', 'base\n');
  writeFileSync(join(repo.dir, 'delivery.config.json'), JSON.stringify({
    models: { dataPolicy: { dataCollection: 'deny' } },
  }));
  const result = await run(okTask(repo, { id: 'dp-unverified', provider: 'openrouter', model: COMMODITY_MODEL }), false, {
    spawnPi: () => ({
      status: 0,
      stdout: stream({ type: 'session', id: 's' }, assistant(), { type: 'agent_settled' }),
      stderr: '',
    }),
  });
  assert.equal(result.dataPolicy?.verified, false);
});

// --- compact handoff exposure ---

test('Compact handoff exposes the recorded data policy routing and providers', () => {
  const dataPolicy = {
    routing: { only: ['alpha/fp8'], allow_fallbacks: false },
    providers: [{ provider: 'Alpha Cloud', headquarters: 'United States', datacenters: ['US'], allowed: true }],
  };
  assert.deepEqual(compactHandoff({ id: 'h', status: 'ready_for_review', dataPolicy }).dataPolicy, dataPolicy);
});

test('Region resolution reads each real metadata response body only once', async (t) => {
  // A real Response throws when its body is read twice; model that here.
  const singleRead = async (url: string) => {
    const body = url.includes('/endpoints') ? { data: { endpoints: alphaEndpoints } } : { data: alphaProviders };
    let read = false;
    return { ok: true, json: async () => { if (read) throw new TypeError('Body is unusable: Body has already been read'); read = true; return body; } };
  };
  const result = await dataPolicyPreflight({
    cwd: projectWith({ regions: ['US', 'DE'] }, t),
    provider: 'openrouter', model: COMMODITY_MODEL,
    fetch: singleRead,
  });
  assert.deepEqual(result.ok ? result.routing?.only : result.reason, ['alpha/fp8']);
});
