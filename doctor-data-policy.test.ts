// ---------------------------------------------------------------------------
// Behavioral tests for the doctor data-destination posture (ADR 0017 R7).
//
// Every scenario is offline and hermetic: the project config is a temp-dir
// fixture and every metadata request goes through an injected fake fetch.
// Each test asserts exactly one observable outcome of the public posture.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectDataPolicy,
  renderDataPolicyPosture,
  type DataPolicyPosture,
} from './doctor-data-policy.ts';

const MODEL = 'vendor/model';
const NO_POLICY_WARNING =
  'No models.dataPolicy is set; OpenRouter may route requests to any provider and fall back between them.';

const endpoints = {
  data: {
    id: MODEL,
    endpoints: [
      { provider_name: 'Alpha Cloud', tag: 'alpha/fp8' },
      { provider_name: 'Beta Hosting', tag: 'beta/us' },
      { provider_name: 'Gamma Hosting', tag: 'gamma/fp8' },
      { provider_name: 'Delta Hosting', tag: 'delta/eu' },
    ],
  },
};

const providers = {
  data: [
    { name: 'Alpha Cloud', slug: 'alpha', headquarters: 'US', datacenters: ['US', 'DE'] },
    { name: 'Beta Hosting', slug: 'beta', headquarters: 'FR', datacenters: ['FR'] },
    { name: 'Gamma Hosting', slug: 'gamma', headquarters: 'US', datacenters: [] },
    { name: 'Delta Hosting', slug: 'delta', headquarters: 'DE', datacenters: ['DE', 'FR'] },
  ],
};

function tempRoot(t: any): string {
  const root = mkdtempSync(join(tmpdir(), 'doctor-data-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function project(t: any, policy?: unknown): string {
  const root = tempRoot(t);
  writeFileSync(
    join(root, 'delivery.config.json'),
    JSON.stringify(policy === undefined ? { models: { routing: 'shadow' } } : { models: { dataPolicy: policy } }),
  );
  return root;
}

function fakeFetch(calls: string[] = []) {
  return async (url: string) => {
    calls.push(url);
    return { ok: true, json: async () => (url.includes('/endpoints') ? endpoints : providers) };
  };
}

async function postureFor(t: any, policy?: unknown, calls: string[] = []): Promise<DataPolicyPosture> {
  return inspectDataPolicy({ cwd: project(t, policy), models: [MODEL], fetch: fakeFetch(calls) });
}

function candidate(posture: DataPolicyPosture, tag: string) {
  return posture.models.find((entry) => entry.model === MODEL)?.candidates.find((entry) => entry.tag === tag);
}

// --- no policy -------------------------------------------------------------

test('inspectDataPolicy warns that an absent policy leaves the destination unconstrained', async (t) => {
  const posture = await postureFor(t);
  assert.ok(posture.warnings.includes(NO_POLICY_WARNING));
});

test('inspectDataPolicy makes no metadata request when no policy is set', async (t) => {
  const calls: string[] = [];
  await postureFor(t, undefined, calls);
  assert.deepEqual(calls, []);
});

test('inspectDataPolicy reports no routing preferences when no policy is set', async (t) => {
  const posture = await postureFor(t);
  assert.equal(posture.routing, null);
});

test('inspectDataPolicy links the data-destination guide when no policy is set', async (t) => {
  const posture = await postureFor(t);
  assert.ok(posture.remediation.some((line) => line.includes('docs/data-destination.md')));
});

// --- candidates and reasons ------------------------------------------------

test('inspectDataPolicy marks an endpoint kept when it satisfies the policy', async (t) => {
  const posture = await postureFor(t, { providers: { only: ['alpha'] } });
  assert.equal(candidate(posture, 'alpha/fp8')?.kept, true);
});

test('inspectDataPolicy reports a provider headquarters for a candidate', async (t) => {
  const posture = await postureFor(t, { zdr: true });
  assert.equal(candidate(posture, 'alpha/fp8')?.headquarters, 'US');
});

test('inspectDataPolicy reports every provider datacenter for a candidate', async (t) => {
  const posture = await postureFor(t, { zdr: true });
  assert.deepEqual(candidate(posture, 'alpha/fp8')?.datacenters, ['US', 'DE']);
});

test('inspectDataPolicy drops an ignored provider with the reason ignored', async (t) => {
  const posture = await postureFor(t, { providers: { ignore: ['beta'] } });
  assert.equal(candidate(posture, 'beta/us')?.reason, 'ignored');
});

test('inspectDataPolicy drops a provider outside providers.only with the reason outside only', async (t) => {
  const posture = await postureFor(t, { providers: { only: ['alpha'] } });
  assert.equal(candidate(posture, 'beta/us')?.reason, 'outside only');
});

test('inspectDataPolicy drops a provider outside the allowed regions with the reason outside regions', async (t) => {
  const posture = await postureFor(t, { regions: ['US', 'DE'] });
  assert.equal(candidate(posture, 'beta/us')?.reason, 'outside regions');
});

test('inspectDataPolicy drops a provider without datacenter data under a regions policy', async (t) => {
  const posture = await postureFor(t, { regions: ['US'] });
  assert.equal(candidate(posture, 'gamma/fp8')?.reason, 'no datacenter data');
});

// --- warnings --------------------------------------------------------------

test('inspectDataPolicy warns that a model with no kept candidate stops with data_policy_unsatisfied', async (t) => {
  const posture = await postureFor(t, { providers: { only: ['nobody'] } });
  assert.match(posture.warnings.join('\n'), /vendor\/model.*data_policy_unsatisfied/);
});

test('inspectDataPolicy warns that allowFallbacks lets requests leave the allowed set', async (t) => {
  const posture = await postureFor(t, { allowFallbacks: true });
  assert.match(posture.warnings.join('\n'), /may leave the allowed set/);
});

// --- routing and account settings ------------------------------------------

test('inspectDataPolicy reports the OpenRouter routing preferences for a policy', async (t) => {
  const posture = await postureFor(t, { dataCollection: 'deny', zdr: true, providers: { ignore: ['beta'] } });
  assert.deepEqual(posture.routing, { data_collection: 'deny', zdr: true, ignore: ['beta'], allow_fallbacks: false });
});

test('inspectDataPolicy sends the region-resolved provider tags as only', async (t) => {
  const posture = await postureFor(t, { regions: ['US', 'DE'] });
  assert.deepEqual(posture.routing?.only, ['alpha/fp8']);
});

test('inspectDataPolicy reports account privacy settings as unverifiable with the settings link', async (t) => {
  const posture = await postureFor(t);
  assert.deepEqual(posture.accountSettings, {
    verifiable: false,
    link: 'https://openrouter.ai/settings/privacy',
  });
});

// --- rendering -------------------------------------------------------------

test('renderDataPolicyPosture includes a dropped candidate and its reason', async (t) => {
  const posture = await postureFor(t, { providers: { only: ['alpha'] } });
  assert.match(renderDataPolicyPosture(posture), /beta\/us.*outside only/);
});

test('renderDataPolicyPosture includes the unverifiable account-settings note', async (t) => {
  const posture = await postureFor(t);
  assert.match(renderDataPolicyPosture(posture), /cannot be verified.*https:\/\/openrouter\.ai\/settings\/privacy/);
});
