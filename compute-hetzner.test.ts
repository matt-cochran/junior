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
