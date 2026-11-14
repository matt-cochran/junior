// ---------------------------------------------------------------------------
// Behavioral tests for the data-destination policy (ADR 0017 R1-R3).
//
// Every region-resolution test injects a fake fetch; no test touches the
// network and no test reads a credential.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyRoutingToModelsJson,
  readDataPolicy,
  resolveRegionProviders,
  toRoutingPreferences,
  type DataPolicy,
} from './data-policy.ts';

function tempRoot(t: any): string {
  const root = mkdtempSync(join(tmpdir(), 'data-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function projectWith(policy: unknown, t: any): string {
  const root = tempRoot(t);
  writeFileSync(join(root, 'delivery.config.json'), JSON.stringify({ models: { dataPolicy: policy } }));
  return root;
}

const policy = (over: Partial<DataPolicy> = {}): DataPolicy => ({ ...over });

function fakeFetch(endpoints: unknown, providers: unknown, calls: string[] = []) {
  return async (url: string) => {
    calls.push(url);
    const body = url.includes('/endpoints') ? endpoints : providers;
    return { ok: true, json: async () => body };
  };
}

// --- readDataPolicy (R1) ---

test('readDataPolicy returns null when models.dataPolicy is absent', (t) => {
  const root = tempRoot(t);
  writeFileSync(join(root, 'delivery.config.json'), JSON.stringify({ models: { routing: 'auto' } }));
  assert.equal(readDataPolicy(root), null);
});

test('readDataPolicy returns every declared policy field', (t) => {
  const expected = {
    dataCollection: 'deny',
    zdr: true,
    providers: { only: ['alpha'], ignore: ['beta'] },
    regions: ['US', 'DE'],
    allowFallbacks: false,
    allowUncovered: ['typesafe'],
  };
  assert.deepEqual(readDataPolicy(projectWith(expected, t)), expected);
});

test('readDataPolicy rejects an unknown dataPolicy field naming it', (t) => {
  const root = projectWith({ retention: 'forever' }, t);
  assert.throws(() => readDataPolicy(root), /models\.dataPolicy\.retention/);
});

test('readDataPolicy rejects an unknown providers field naming it', (t) => {
  const root = projectWith({ providers: { order: ['alpha'] } }, t);
  assert.throws(() => readDataPolicy(root), /models\.dataPolicy\.providers\.order/);
});

test('readDataPolicy rejects a dataCollection other than allow or deny', (t) => {
  const root = projectWith({ dataCollection: 'sometimes' }, t);
  assert.throws(() => readDataPolicy(root), /models\.dataPolicy\.dataCollection/);
});

test('readDataPolicy rejects a non-boolean zdr naming it', (t) => {
  const root = projectWith({ zdr: 'yes' }, t);
  assert.throws(() => readDataPolicy(root), /models\.dataPolicy\.zdr/);
});

test('readDataPolicy rejects a non-boolean allowFallbacks naming it', (t) => {
  const root = projectWith({ allowFallbacks: 1 }, t);
  assert.throws(() => readDataPolicy(root), /models\.dataPolicy\.allowFallbacks/);
});

test('readDataPolicy rejects a non-array providers.only naming it', (t) => {
  const root = projectWith({ providers: { only: 'alpha' } }, t);
  assert.throws(() => readDataPolicy(root), /models\.dataPolicy\.providers\.only/);
});

test('readDataPolicy rejects a non-string providers.only entry naming it', (t) => {
  const root = projectWith({ providers: { only: ['alpha', 7] } }, t);
  assert.throws(() => readDataPolicy(root), /models\.dataPolicy\.providers\.only/);
});

test('readDataPolicy rejects a non-array providers.ignore naming it', (t) => {
  const root = projectWith({ providers: { ignore: 'beta' } }, t);
  assert.throws(() => readDataPolicy(root), /models\.dataPolicy\.providers\.ignore/);
});

test('readDataPolicy rejects a non-string providers.ignore entry naming it', (t) => {
  const root = projectWith({ providers: { ignore: ['beta', null] } }, t);
  assert.throws(() => readDataPolicy(root), /models\.dataPolicy\.providers\.ignore/);
});

test('readDataPolicy rejects a region that is not two upper-case letters', (t) => {
  const root = projectWith({ regions: ['us'] }, t);
  assert.throws(() => readDataPolicy(root), /models\.dataPolicy\.regions/);
});

test('readDataPolicy rejects a non-array regions value naming it', (t) => {
  const root = projectWith({ regions: 'US' }, t);
  assert.throws(() => readDataPolicy(root), /models\.dataPolicy\.regions/);
});

test('readDataPolicy rejects an unknown allowUncovered entry naming it', (t) => {
  const root = projectWith({ allowUncovered: ['matrix'] }, t);
  assert.throws(() => readDataPolicy(root), /models\.dataPolicy\.allowUncovered/);
});

// --- toRoutingPreferences (R2) ---

test('toRoutingPreferences maps the OpenRouter provider fields', () => {
  const routing = toRoutingPreferences(policy({
    dataCollection: 'deny',
    zdr: true,
    providers: { only: ['alpha'], ignore: ['beta'] },
    allowFallbacks: true,
  }));
  assert.deepEqual(routing, {
    data_collection: 'deny',
    zdr: true,
    only: ['alpha'],
    ignore: ['beta'],
    allow_fallbacks: true,
  });
});

test('toRoutingPreferences defaults allow_fallbacks to false whenever a policy exists', () => {
  assert.deepEqual(toRoutingPreferences(policy()), { allow_fallbacks: false });
});

test('toRoutingPreferences omits data_collection when unset', () => {
  assert.equal('data_collection' in toRoutingPreferences(policy({ zdr: true })), false);
});

test('toRoutingPreferences omits zdr when it is false', () => {
  assert.equal('zdr' in toRoutingPreferences(policy({ zdr: false })), false);
});

test('toRoutingPreferences prefers the resolved region allow-list', () => {
  const routing = toRoutingPreferences(policy({ providers: { only: ['alpha'] } }), ['beta/fp8']);
  assert.deepEqual(routing.only, ['beta/fp8']);
});

test('toRoutingPreferences preserves an empty resolved allow-list', () => {
  const routing = toRoutingPreferences(policy({ providers: { only: ['alpha'] } }), []);
  assert.deepEqual(routing.only, []);
});

test('toRoutingPreferences omits only when neither policy nor resolution sets it', () => {
  assert.equal('only' in toRoutingPreferences(policy()), false);
});

test('toRoutingPreferences omits ignore when unset', () => {
  assert.equal('ignore' in toRoutingPreferences(policy({ zdr: true })), false);
});

// --- resolveRegionProviders (R2/R4) ---

const endpoints = {
  data: [
    { provider_name: 'Alpha Cloud', tag: 'alpha/fp8' },
    { provider_name: 'Beta Hosting', tag: 'beta/us' },
  ],
};
const providers = {
  data: [
    { name: 'Alpha Cloud', slug: 'alpha', datacenters: ['US', 'DE'] },
    { name: 'Beta Hosting', slug: 'beta', datacenters: ['FR'] },
  ],
};

test('resolveRegionProviders keeps endpoint tags whose datacenters all lie in the regions', async () => {
  const result = await resolveRegionProviders('vendor/model', ['US', 'DE'], { fetch: fakeFetch(endpoints, providers) });
  assert.deepEqual(result.only, ['alpha/fp8']);
});

test('resolveRegionProviders reads the endpoints nested under the data envelope', async () => {
  const endpointData = { data: { id: 'vendor/model', endpoints: [{ provider_name: 'Alpha Cloud', tag: 'alpha/fp8' }] } };
  const result = await resolveRegionProviders('vendor/model', ['US', 'DE'], { fetch: fakeFetch(endpointData, providers) });
  assert.deepEqual(result.only, ['alpha/fp8']);
});

test('resolveRegionProviders matches an endpoint tag prefix to its provider slug', async () => {
  const endpointData = { data: [{ provider_name: 'Alpha Retail', tag: 'alpha/fp8' }] };
  const providerData = { data: [{ name: 'Alpha Cloud', slug: 'alpha', datacenters: ['US'] }] };
  const result = await resolveRegionProviders('vendor/model', ['US'], { fetch: fakeFetch(endpointData, providerData) });
  assert.deepEqual(result.only, ['alpha/fp8']);
});

test('resolveRegionProviders excludes a provider with a datacenter outside the regions', async () => {
  const result = await resolveRegionProviders('vendor/model', ['FR'], { fetch: fakeFetch(endpoints, providers) });
  assert.deepEqual(result.only, ['beta/us']);
});

test('resolveRegionProviders lists a matched provider without datacenter data as unresolved', async () => {
  const endpointData = { data: [{ provider_name: 'Gamma', tag: 'gamma/fp8' }] };
  const providerData = { data: [{ name: 'Gamma', slug: 'gamma', datacenters: [] }] };
  const result = await resolveRegionProviders('vendor/model', ['US'], { fetch: fakeFetch(endpointData, providerData) });
  assert.deepEqual(result.unresolved, ['Gamma']);
});

test('resolveRegionProviders ignores an endpoint with no matching provider', async () => {
  const endpointData = { data: [{ provider_name: 'Unknown', tag: 'unknown/fp8' }] };
  const result = await resolveRegionProviders('vendor/model', ['US'], { fetch: fakeFetch(endpointData, providers) });
  assert.deepEqual(result.only, []);
});

test('resolveRegionProviders caches both metadata responses per deps object', async () => {
  const calls: string[] = [];
  const deps = { fetch: fakeFetch(endpoints, providers, calls) };
  await resolveRegionProviders('vendor/model', ['US'], deps);
  await resolveRegionProviders('vendor/model', ['US'], deps);
  assert.deepEqual(calls, [
    'https://openrouter.ai/api/v1/models/vendor/model/endpoints',
    'https://openrouter.ai/api/v1/providers',
  ]);
});

// --- applyRoutingToModelsJson (R3) ---

test('applyRoutingToModelsJson builds a document when models.json is absent', () => {
  const routing = { data_collection: 'deny', allow_fallbacks: false };
  assert.deepEqual(applyRoutingToModelsJson(undefined, routing), {
    providers: { openrouter: { compat: { openRouterRouting: routing } } },
  });
});

test('applyRoutingToModelsJson preserves every other models.json field', () => {
  const doc = {
    version: 2,
    providers: {
      openrouter: { compat: { other: true }, timeout: 30 },
      anthropic: { models: ['claude'] },
    },
  };
  const routing = { zdr: true, allow_fallbacks: false };
  assert.deepEqual(applyRoutingToModelsJson(doc, routing), {
    version: 2,
    providers: {
      openrouter: { compat: { other: true, openRouterRouting: routing }, timeout: 30 },
      anthropic: { models: ['claude'] },
    },
  });
});

test('applyRoutingToModelsJson does not mutate the supplied document', () => {
  const doc = { providers: { openrouter: { compat: { other: true } } } };
  applyRoutingToModelsJson(doc, { zdr: true });
  assert.deepEqual(doc, { providers: { openrouter: { compat: { other: true } } } });
});

test('applyRoutingToModelsJson replaces a previous openRouterRouting value', () => {
  const doc = { providers: { openrouter: { compat: { openRouterRouting: { order: ['old'] } } } } };
  const result = applyRoutingToModelsJson(doc, { zdr: true });
  assert.deepEqual(result.providers.openrouter.compat.openRouterRouting, { zdr: true });
});
