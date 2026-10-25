// Behavioral tests for the provider-neutral compute contract.
//
// Every scenario is offline and deterministic. The tests drive only the public
// `compute.ts` interface: the published CLI/status schema, the compute domain
// constants, and the status/operation invariants. No provider SDK, credential
// or external infrastructure is involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPUTE_CLI_SCHEMA,
  COMPUTE_LIFECYCLE_STATES,
  COMPUTE_MODES,
  COMPUTE_OPERATIONS,
  COMPUTE_STATUS_INVARIANTS,
  COMPUTE_STATUS_SCHEMA,
  DEFAULT_COMPUTE_POLICY,
  inspectComputeStatus,
  modeAllowsOperation,
  type ComputeStatus,
} from './compute.ts';

const NOW = '2026-10-25T12:00:00.000Z';

function status(overrides: Partial<ComputeStatus> = {}): ComputeStatus {
  const base: ComputeStatus = {
    schemaVersion: 1,
    provider: 'fake',
    adapterVersion: '1.0.0',
    mode: 'provision',
    resource: {
      id: 'resource-1',
      generation: 3,
      tags: { role: 'worker' },
    },
    ownership: {
      status: 'verified',
      provider: 'fake',
      account: 'account-1',
      resourceId: 'resource-1',
      mode: 'provision',
      owner: 'project-1',
      creator: 'junior',
      generation: 3,
      tags: { role: 'worker' },
      evidence: 'creation receipt',
      recordedAt: '2026-10-25T09:00:00.000Z',
    },
    desiredState: 'active',
    observedState: 'leased',
    leases: [{
      id: 'lease-1',
      holder: 'worker-1',
      resourceId: 'resource-1',
      resourceGeneration: 3,
      fencingToken: 7,
      issuedAt: '2026-10-25T11:00:00.000Z',
      expiresAt: '2026-10-25T13:00:00.000Z',
      heartbeatAt: '2026-10-25T11:30:00.000Z',
    }],
    capacity: { min: 0, max: 1, current: 1 },
    cost: { currency: 'EUR', amount: 'unknown' },
    findings: [],
    fallback: null,
    updatedAt: '2026-10-25T11:30:00.000Z',
  };
  return { ...base, ...overrides };
}

function inspect(value: ComputeStatus) {
  return inspectComputeStatus(value, { now: NOW });
}

test('compute schema publishes the three ownership modes', () => {
  assert.deepEqual([...COMPUTE_MODES], ['adopt', 'managed-existing', 'provision']);
});

test('compute schema publishes the documented lifecycle states', () => {
  assert.deepEqual([...COMPUTE_LIFECYCLE_STATES], [
    'requested',
    'provisioning',
    'ready',
    'leased',
    'active',
    'draining',
    'released',
    'dormant',
    'destroying',
    'destroyed',
    'failed',
  ]);
});

test('compute schema publishes the provider-neutral adapter operations', () => {
  assert.deepEqual([...COMPUTE_OPERATIONS], [
    'inspect',
    'attach',
    'create',
    'start',
    'stop',
    'resize',
    'destroy',
    'tag',
    'reconcile',
  ]);
});

test('the public CLI schema exposes the documented compute commands', () => {
  assert.deepEqual(COMPUTE_CLI_SCHEMA.commands.map((command) => command.name), [
    'init',
    'doctor',
    'status',
    'reconcile',
    'stop',
  ]);
});

test('the public CLI schema points at the versioned status document', () => {
  assert.deepEqual(COMPUTE_CLI_SCHEMA.output, {
    format: 'compute-status',
    schemaVersion: 1,
  });
});

test('the status schema advertises every machine-readable invariant', () => {
  assert.deepEqual(
    [...COMPUTE_STATUS_SCHEMA['x-status-invariants']],
    COMPUTE_STATUS_INVARIANTS.map((invariant) => invariant.id),
  );
});

test('the status schema is JSON-serializable', () => {
  assert.equal(JSON.parse(JSON.stringify(COMPUTE_STATUS_SCHEMA)).schemaVersion, 1);
});

test('a verified owned resource with one active lease is safe', () => {
  assert.equal(inspect(status()).safe, true);
});

test('a missing ownership record fails closed', () => {
  const result = inspect(status({ ownership: { status: 'missing' } }));
  assert.equal(result.safe, false);
});

test('an ambiguous ownership record fails closed', () => {
  const result = inspect(status({ ownership: { ...status().ownership, status: 'ambiguous' } }));
  assert.equal(result.safe, false);
});

test('an ownership provider mismatch is reported', () => {
  const result = inspect(status({
    ownership: { ...status().ownership, provider: 'other-provider' },
  }));
  assert.deepEqual(result.issues.map((issue) => issue.code), ['ownership.provider-match']);
});

test('an ownership generation mismatch is reported', () => {
  const result = inspect(status({
    ownership: { ...status().ownership, generation: 2 },
  }));
  assert.deepEqual(result.issues.map((issue) => issue.code), ['ownership.generation-match']);
});

test('an ownership tag mismatch is reported', () => {
  const result = inspect(status({
    ownership: { ...status().ownership, tags: { role: 'database' } },
  }));
  assert.deepEqual(result.issues.map((issue) => issue.code), ['ownership.tags-match']);
});

test('a lease for another resource generation is reported', () => {
  const base = status();
  const result = inspect(status({
    leases: [{ ...base.leases[0], resourceGeneration: 2 }],
  }));
  assert.deepEqual(result.issues.map((issue) => issue.code), ['lease.generation-match']);
});

test('two active leases on one resource generation are reported as a conflict', () => {
  const base = status();
  const result = inspect(status({
    leases: [base.leases[0], { ...base.leases[0], id: 'lease-2', fencingToken: 8 }],
  }));
  assert.deepEqual(result.issues.map((issue) => issue.code), ['lease.conflict']);
});

test('an expired lease is reported', () => {
  const base = status();
  const result = inspect(status({
    observedState: 'ready',
    leases: [{
      ...base.leases[0],
      issuedAt: '2026-10-25T09:00:00.000Z',
      expiresAt: '2026-10-25T10:00:00.000Z',
      heartbeatAt: '2026-10-25T09:30:00.000Z',
    }],
  }));
  assert.deepEqual(result.issues.map((issue) => issue.code), ['lease.expired']);
});

test('an observed active state without a lease is reported', () => {
  const result = inspect(status({ observedState: 'active', leases: [] }));
  assert.deepEqual(result.issues.map((issue) => issue.code), ['lease.observed-active']);
});

test('capacity minimum above maximum is reported', () => {
  const result = inspect(status({ capacity: { min: 2, max: 1, current: 1 } }));
  assert.deepEqual(result.issues.map((issue) => issue.code), ['capacity.bounds']);
});

test('scale-to-zero with an active lease is reported', () => {
  const result = inspect(status({ capacity: { min: 0, max: 1, current: 0 } }));
  assert.deepEqual(result.issues.map((issue) => issue.code), ['capacity.scale-to-zero']);
});

test('unknown capacity is a safe, explicit value', () => {
  const result = inspect(status({
    observedState: 'ready',
    leases: [],
    capacity: { min: 0, max: 1, current: 'unknown' },
  }));
  assert.equal(result.safe, true);
});

test('unknown cost is a safe, explicit value', () => {
  const result = inspect(status({ cost: { currency: 'EUR', amount: 'unknown' } }));
  assert.equal(result.safe, true);
});

test('a negative observed cost is reported', () => {
  const result = inspect(status({ cost: { currency: 'EUR', amount: -1 } }));
  assert.deepEqual(result.issues.map((issue) => issue.code), ['cost.amount']);
});

test('a blocking reconciliation finding makes the status unsafe', () => {
  const result = inspect(status({
    findings: [{
      code: 'generation-mismatch',
      severity: 'blocking',
      message: 'observed generation changed',
    }],
  }));
  assert.equal(result.safe, false);
});

test('adopt mode cannot create a resource', () => {
  assert.equal(modeAllowsOperation('adopt', 'create'), false);
});

test('adopt mode cannot destroy a resource', () => {
  assert.equal(modeAllowsOperation('adopt', 'destroy'), false);
});

test('managed-existing mode can resize under delegation', () => {
  assert.equal(modeAllowsOperation('managed-existing', 'resize'), true);
});

test('provision mode can destroy a resource it owns', () => {
  assert.equal(modeAllowsOperation('provision', 'destroy'), true);
});

test('remote compute is disabled by default', () => {
  assert.equal(DEFAULT_COMPUTE_POLICY.mode, null);
});

test('minimum capacity defaults to zero', () => {
  assert.equal(DEFAULT_COMPUTE_POLICY.minCapacity, 0);
});

test('maximum capacity defaults to a finite value', () => {
  assert.equal(Number.isFinite(DEFAULT_COMPUTE_POLICY.maxCapacity), true);
});

test('the cost budget defaults to a finite value', () => {
  assert.equal(Number.isFinite(DEFAULT_COMPUTE_POLICY.budget.amount), true);
});

test('the status command declares its resource and JSON options', () => {
  const command = COMPUTE_CLI_SCHEMA.commands.find((entry) => entry.name === 'status');
  assert.deepEqual(command?.options.map((option) => option.name), ['--resource', '--json']);
});

test('the init command declares explicit mode and config options', () => {
  const command = COMPUTE_CLI_SCHEMA.commands.find((entry) => entry.name === 'init');
  assert.deepEqual(command?.options.map((option) => option.name), ['--config', '--mode', '--dry-run', '--json']);
});
