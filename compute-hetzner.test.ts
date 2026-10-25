// Behavioral tests for the fake Hetzner provider adapter.
//
// Every scenario uses recorded provider responses. There is no credential, no
// network call and no real cloud resource in this file.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HETZNER_PROVIDER,
  createFakeHetznerProvider,
  discoverHetznerCapabilities,
  inspectHetznerProviderIdentity,
  normalizeHetznerCapabilities,
  normalizeHetznerQuota,
  verifyHetznerProviderIdentity,
  type HetznerProviderIdentity,
} from './compute-hetzner.ts';

const verifiedIdentity: HetznerProviderIdentity = {
  status: 'verified',
  provider: HETZNER_PROVIDER,
  account: 'account-123',
  project: 'project-junior',
  endpoint: 'https://api.hetzner.cloud/v1',
  evidence: 'recorded account ownership scope',
};

function recordedCapabilities() {
  return [
    { operation: 'inspect', status: 'supported' },
    { operation: 'create', status: 'supported' },
    { operation: 'destroy', status: 'supported' },
    { operation: 'resize', status: 'unsupported', reason: 'recorded plan does not permit resize' },
  ];
}

test('a provider identity with a foreign account is rejected', () => {
  const result = verifyHetznerProviderIdentity(verifiedIdentity, {
    ...verifiedIdentity,
    account: 'account-other',
  });
  assert.equal(result.verified, false);
});

test('a provider identity mismatch reports the mismatch code', () => {
  const result = verifyHetznerProviderIdentity(verifiedIdentity, {
    ...verifiedIdentity,
    account: 'account-other',
  });
  assert.equal(result.code, 'provider.mismatch');
});

test('an identity record for another provider is invalid', () => {
  const result = inspectHetznerProviderIdentity({ ...verifiedIdentity, provider: 'other-cloud' });
  assert.equal(result.valid, false);
});

test('identity discovery fails closed before trusting provider capabilities', () => {
  const result = discoverHetznerCapabilities({
    expectedIdentity: verifiedIdentity,
    identity: { ...verifiedIdentity, account: 'account-other' },
    capabilities: recordedCapabilities(),
  });
  assert.equal(result.ready, false);
});

test('a mismatched provider identity exposes no discovered capabilities', () => {
  const result = discoverHetznerCapabilities({
    expectedIdentity: verifiedIdentity,
    identity: { ...verifiedIdentity, account: 'account-other' },
    capabilities: recordedCapabilities(),
  });
  assert.deepEqual(result.capabilities, []);
});

test('recorded capability responses are normalized to supported operations', () => {
  const result = normalizeHetznerCapabilities(recordedCapabilities());
  assert.deepEqual(
    result
      .filter((entry) => ['inspect', 'create', 'destroy', 'resize'].includes(entry.operation))
      .map((entry) => [entry.operation, entry.status]),
    [
      ['inspect', 'supported'],
      ['create', 'supported'],
      ['resize', 'unsupported'],
      ['destroy', 'supported'],
    ],
  );
});

test('a missing capability is normalized to unsupported', () => {
  const result = normalizeHetznerCapabilities([{ operation: 'inspect', status: 'supported' }]);
  assert.equal(result.find((entry) => entry.operation === 'stop')?.status, 'unsupported');
});

test('an unknown capability response remains unknown rather than supported', () => {
  const result = normalizeHetznerCapabilities([
    { operation: 'create', status: 'unknown', reason: 'recorded quota response was unavailable' },
  ]);
  assert.equal(result.find((entry) => entry.operation === 'create')?.status, 'unknown');
});

test('a recorded quota response is normalized without credentials', () => {
  const result = normalizeHetznerQuota({ limits: { servers: 10 }, usage: { servers: 3 } });
  assert.deepEqual(result, {
    serverLimit: 10,
    serversUsed: 3,
    serversAvailable: 7,
  });
});

test('an absent quota is normalized as unknown rather than zero', () => {
  const result = normalizeHetznerQuota({});
  assert.equal(result.serverLimit, 'unknown');
});

test('a verified fake provider discovers its recorded capabilities', () => {
  const provider = createFakeHetznerProvider({
    identity: verifiedIdentity,
    capabilities: recordedCapabilities(),
    quota: { limits: { servers: 10 }, usage: { servers: 3 } },
  });
  const result = provider.discover({
    expectedIdentity: verifiedIdentity,
    required: ['inspect', 'create', 'destroy'],
  });
  assert.equal(result.ready, true);
});

test('a fake provider never requires or emits a credential', () => {
  const provider = createFakeHetznerProvider({
    identity: verifiedIdentity,
    capabilities: recordedCapabilities(),
    quota: { limits: { servers: 10 }, usage: { servers: 3 } },
  });
  assert.equal(JSON.stringify(provider.recorded).includes('token'), false);
});

function provisioningProvider(overrides: {
  quota?: unknown;
  placement?: unknown;
  resources?: unknown[];
} = {}) {
  return createFakeHetznerProvider({
    identity: verifiedIdentity,
    capabilities: recordedCapabilities(),
    quota: overrides.quota ?? { limits: { servers: 2 }, usage: { servers: 0 } },
    placement: overrides.placement ?? [
      { region: 'fsn1', serverType: 'cx22', capacity: 2 },
    ],
    resources: overrides.resources,
  });
}

function provisionRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'request-1',
    owner: 'project-junior',
    project: 'project-junior',
    region: 'fsn1',
    serverType: 'cx22',
    ...overrides,
  };
}

test('concurrent provisioning requests cannot over-provision a pool', async () => {
  const provider = provisioningProvider({
    quota: { limits: { servers: 1 }, usage: { servers: 0 } },
  });
  const results = await Promise.all([
    provider.provision(provisionRequest({ requestId: 'request-1' })),
    provider.provision(provisionRequest({ requestId: 'request-2' })),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
});

test('an over-provisioned pool contains exactly one created resource', async () => {
  const provider = provisioningProvider({
    quota: { limits: { servers: 1 }, usage: { servers: 0 } },
  });
  await Promise.all([
    provider.provision(provisionRequest({ requestId: 'request-1' })),
    provider.provision(provisionRequest({ requestId: 'request-2' })),
  ]);
  assert.equal(provider.listResources().length, 1);
});

test('a quota failure creates no resource', async () => {
  const provider = provisioningProvider({
    quota: { limits: { servers: 0 }, usage: { servers: 0 } },
  });
  const result = await provider.provision(provisionRequest());
  assert.equal(result.resource, null);
});

test('a quota failure leaves the provider without an unowned resource', async () => {
  const provider = provisioningProvider({
    quota: { limits: { servers: 0 }, usage: { servers: 0 } },
  });
  await provider.provision(provisionRequest());
  assert.deepEqual(provider.listResources(), []);
});

test('an unknown quota fails closed before creating a resource', async () => {
  const provider = provisioningProvider({ quota: {} });
  const result = await provider.provision(provisionRequest());
  assert.equal(result.ok, false);
});

test('a placement outside the recorded pool creates no resource', async () => {
  const provider = provisioningProvider();
  const result = await provider.provision(provisionRequest({ region: 'nbg1' }));
  assert.equal(result.resource, null);
});

test('a placement failure leaves the provider without an unowned resource', async () => {
  const provider = provisioningProvider();
  await provider.provision(provisionRequest({ region: 'nbg1' }));
  assert.deepEqual(provider.listResources(), []);
});

test('a pool at its recorded placement capacity rejects another resource', async () => {
  const provider = provisioningProvider({
    placement: [{ region: 'fsn1', serverType: 'cx22', capacity: 0 }],
  });
  const result = await provider.provision(provisionRequest());
  assert.equal(result.ok, false);
});

test('replaying one request id returns the original resource', async () => {
  const provider = provisioningProvider();
  const first = await provider.provision(provisionRequest());
  const replay = await provider.provision(provisionRequest());
  assert.equal(replay.resource?.id, first.resource?.id);
});

test('replaying one request id creates no second resource', async () => {
  const provider = provisioningProvider();
  await provider.provision(provisionRequest());
  await provider.provision(provisionRequest());
  assert.equal(provider.listResources().length, 1);
});

test('a reused request id with different content is rejected', async () => {
  const provider = provisioningProvider();
  await provider.provision(provisionRequest());
  const conflict = await provider.provision(provisionRequest({ owner: 'project-other' }));
  assert.equal(conflict.ok, false);
});

test('a provisioning request without a request id is rejected', async () => {
  const provider = provisioningProvider();
  const result = await provider.provision(provisionRequest({ requestId: '' }));
  assert.equal(result.ok, false);
});

test('a provisioning request without an owner is rejected', async () => {
  const provider = provisioningProvider();
  const result = await provider.provision(provisionRequest({ owner: '' }));
  assert.equal(result.ok, false);
});

test('a created resource has a verified ownership record', async () => {
  const provider = provisioningProvider();
  const result = await provider.provision(provisionRequest());
  assert.equal(result.ownership?.status, 'verified');
});

test('a created resource records the requesting owner', async () => {
  const provider = provisioningProvider();
  const result = await provider.provision(provisionRequest());
  assert.equal(result.ownership?.owner, 'project-junior');
});

test('a created resource is recorded as junior-created', async () => {
  const provider = provisioningProvider();
  const result = await provider.provision(provisionRequest());
  assert.equal(result.ownership?.creator, 'junior');
});

test('a created resource records its request id as evidence', async () => {
  const provider = provisioningProvider();
  const result = await provider.provision(provisionRequest());
  assert.equal(result.ownership?.evidence?.includes('request-1'), true);
});

test('an inventory resource from another account blocks provisioning', async () => {
  const provider = provisioningProvider({
    resources: [{
      id: 'server-foreign',
      account: 'account-other',
      region: 'fsn1',
      serverType: 'cx22',
    }],
  });
  const result = await provider.provision(provisionRequest());
  assert.equal(result.ok, false);
});
