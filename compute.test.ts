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
  acquireComputeLease,
  assertComputePolicy,
  authorizeComputeOperation,
  createComputeLeaseState,
  heartbeatComputeLease,
  inspectComputeCapabilities,
  inspectComputeLeaseState,
  inspectComputePolicy,
  inspectComputeStatus,
  modeAllowsOperation,
  reclaimComputeLease,
  reconcileComputeStatus,
  releaseComputeLease,
  releaseComputeLeaseWithAuthority,
  stopComputeResource,
  type ComputePolicy,
  type ComputeStatus,
} from './compute.ts';

const NOW = '2026-10-25T12:00:00.000Z';

const SAFE_POLICY: ComputePolicy = {
  ...DEFAULT_COMPUTE_POLICY,
  mode: 'provision',
  provisionOptIn: true,
  maxCapacity: 4,
  budget: { amount: 100, currency: 'EUR', period: 'month' },
};

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


test('a provision policy without explicit opt-in is unsafe', () => {
  const result = inspectComputePolicy({ ...SAFE_POLICY, provisionOptIn: false });
  assert.equal(result.safe, false);
});

test('a policy whose minimum capacity exceeds its maximum is invalid', () => {
  const result = inspectComputePolicy({ ...SAFE_POLICY, minCapacity: 5, maxCapacity: 4 });
  assert.equal(result.valid, false);
});

test('an unsafe policy is rejected before any mutation can use it', () => {
  assert.throws(() => assertComputePolicy({ ...SAFE_POLICY, provisionOptIn: false }));
});

test('a provision policy with explicit opt-in and finite bounds is safe', () => {
  assert.equal(inspectComputePolicy(SAFE_POLICY).safe, true);
});

test('an advertised capability that is missing is reported as unsupported', () => {
  const result = inspectComputeCapabilities(
    [{ operation: 'inspect', status: 'supported' }],
    ['inspect', 'destroy'],
  );
  assert.deepEqual(result.unsupported, ['destroy']);
});

test('an unknown capability status is not treated as support', () => {
  const result = inspectComputeCapabilities(
    [{ operation: 'inspect', status: 'unknown', reason: 'probe failed' }],
    ['inspect'],
  );
  assert.equal(result.ready, false);
});

test('capability inspection is ready when every required operation is supported', () => {
  const result = inspectComputeCapabilities(
    [{ operation: 'inspect', status: 'supported' }, { operation: 'stop', status: 'supported' }],
    ['inspect', 'stop'],
  );
  assert.equal(result.ready, true);
});

test('a new durable lease state starts without a lease', () => {
  const state = createComputeLeaseState({ resourceId: 'resource-1', resourceGeneration: 3, now: NOW });
  assert.equal(state.leases.length, 0);
});

test('a new durable lease state starts at the first fencing token', () => {
  const state = createComputeLeaseState({ resourceId: 'resource-1', resourceGeneration: 3, now: NOW });
  assert.equal(state.nextFencingToken, 1);
});

test('a lease state with a non-positive next fencing token is invalid', () => {
  const state = createComputeLeaseState({ resourceId: 'resource-1', resourceGeneration: 3, now: NOW });
  assert.equal(inspectComputeLeaseState({ ...state, nextFencingToken: 0 }).valid, false);
});

test('acquiring a lease on a free resource generation succeeds', () => {
  const state = createComputeLeaseState({ resourceId: 'resource-1', resourceGeneration: 3, now: NOW });
  const result = acquireComputeLease(state, {
    leaseId: 'lease-1',
    holder: 'worker-1',
    now: NOW,
    expiresAt: '2026-10-25T13:00:00.000Z',
  });
  assert.equal(result.ok, true);
});

test('a second active lease on one resource generation is rejected', () => {
  const state = createComputeLeaseState({ resourceId: 'resource-1', resourceGeneration: 3, now: NOW });
  const first = acquireComputeLease(state, {
    leaseId: 'lease-1',
    holder: 'worker-1',
    now: NOW,
    expiresAt: '2026-10-25T13:00:00.000Z',
  });
  if (!first.ok) throw new Error(first.message);
  const second = acquireComputeLease(first.state, {
    leaseId: 'lease-2',
    holder: 'worker-2',
    now: NOW,
    expiresAt: '2026-10-25T13:00:00.000Z',
  });
  assert.equal(second.ok, false);
});

test('heartbeat with a stale fencing token is rejected', () => {
  const state = createComputeLeaseState({ resourceId: 'resource-1', resourceGeneration: 3, now: NOW });
  const acquired = acquireComputeLease(state, {
    leaseId: 'lease-1',
    holder: 'worker-1',
    now: NOW,
    expiresAt: '2026-10-25T13:00:00.000Z',
  });
  if (!acquired.ok) throw new Error(acquired.message);
  const result = heartbeatComputeLease(acquired.state, {
    leaseId: 'lease-1',
    holder: 'worker-1',
    fencingToken: acquired.lease.fencingToken + 1,
    now: '2026-10-25T12:10:00.000Z',
    expiresAt: '2026-10-25T13:10:00.000Z',
  });
  assert.equal(result.ok, false);
});

test('releasing the active lease permits a later acquisition', () => {
  const state = createComputeLeaseState({ resourceId: 'resource-1', resourceGeneration: 3, now: NOW });
  const acquired = acquireComputeLease(state, {
    leaseId: 'lease-1',
    holder: 'worker-1',
    now: NOW,
    expiresAt: '2026-10-25T13:00:00.000Z',
  });
  if (!acquired.ok) throw new Error(acquired.message);
  const released = releaseComputeLease(acquired.state, {
    leaseId: acquired.lease.id,
    holder: acquired.lease.holder,
    fencingToken: acquired.lease.fencingToken,
    now: '2026-10-25T12:30:00.000Z',
  });
  if (!released.ok) throw new Error(released.message);
  const next = acquireComputeLease(released.state, {
    leaseId: 'lease-2',
    holder: 'worker-2',
    now: '2026-10-25T12:30:00.000Z',
    expiresAt: '2026-10-25T13:30:00.000Z',
  });
  assert.equal(next.ok, true);
});

test('an expired lease is not reclaimed before the grace period', () => {
  const state = createComputeLeaseState({ resourceId: 'resource-1', resourceGeneration: 3, now: NOW });
  const acquired = acquireComputeLease(state, {
    leaseId: 'lease-1',
    holder: 'worker-1',
    now: NOW,
    expiresAt: '2026-10-25T13:00:00.000Z',
  });
  if (!acquired.ok) throw new Error(acquired.message);
  const result = reclaimComputeLease(acquired.state, {
    now: '2026-10-25T13:04:00.000Z',
    graceMs: 5 * 60_000,
    quiescent: true,
  });
  assert.equal(result.ok, false);
});

test('an expired lease is reclaimed after grace with quiescent evidence', () => {
  const state = createComputeLeaseState({ resourceId: 'resource-1', resourceGeneration: 3, now: NOW });
  const acquired = acquireComputeLease(state, {
    leaseId: 'lease-1',
    holder: 'worker-1',
    now: NOW,
    expiresAt: '2026-10-25T13:00:00.000Z',
  });
  if (!acquired.ok) throw new Error(acquired.message);
  const result = reclaimComputeLease(acquired.state, {
    now: '2026-10-25T13:06:00.000Z',
    graceMs: 5 * 60_000,
    quiescent: true,
  });
  assert.equal(result.ok, true);
});

test('adopt mode denies resizing a verified host', () => {
  const adopted = status({
    mode: 'adopt',
    ownership: { ...status().ownership, mode: 'adopt' },
  });
  const result = authorizeComputeOperation(adopted, {
    operation: 'resize',
    policy: { ...SAFE_POLICY, mode: 'adopt', provisionOptIn: false },
    now: NOW,
  });
  assert.equal(result.allowed, false);
});

test('adopt mode denies destroying a verified host', () => {
  const adopted = status({
    mode: 'adopt',
    ownership: { ...status().ownership, mode: 'adopt' },
  });
  const result = authorizeComputeOperation(adopted, {
    operation: 'destroy',
    policy: { ...SAFE_POLICY, mode: 'adopt', provisionOptIn: false },
    now: NOW,
  });
  assert.equal(result.allowed, false);
});

test('adopt mode denies creating a replacement host', () => {
  const adopted = status({
    mode: 'adopt',
    ownership: { ...status().ownership, mode: 'adopt' },
  });
  const result = authorizeComputeOperation(adopted, {
    operation: 'create',
    policy: { ...SAFE_POLICY, mode: 'adopt', provisionOptIn: false },
    now: NOW,
  });
  assert.equal(result.allowed, false);
});

test('managed-existing mode denies destroying an owner-supplied host', () => {
  const existing = status({
    mode: 'managed-existing',
    ownership: { ...status().ownership, mode: 'managed-existing' },
  });
  const result = authorizeComputeOperation(existing, {
    operation: 'destroy',
    policy: { ...SAFE_POLICY, mode: 'managed-existing' },
    now: NOW,
  });
  assert.equal(result.allowed, false);
});

test('provision destroy is denied while a lease is still active', () => {
  const result = authorizeComputeOperation(status(), {
    operation: 'destroy',
    policy: SAFE_POLICY,
    now: NOW,
  });
  assert.equal(result.allowed, false);
});

test('provision destroy is allowed for a junior-owned quiescent generation', () => {
  const result = authorizeComputeOperation(status({ observedState: 'ready', leases: [] }), {
    operation: 'destroy',
    policy: SAFE_POLICY,
    now: NOW,
  });
  assert.equal(result.allowed, true);
});

test('a policy mode mismatch denies a lifecycle mutation', () => {
  const result = authorizeComputeOperation(status(), {
    operation: 'resize',
    policy: { ...SAFE_POLICY, mode: 'adopt', provisionOptIn: false },
    now: NOW,
  });
  assert.equal(result.allowed, false);
});

test('unverified ownership denies mutation despite a permissive policy', () => {
  const unowned = status({
    ownership: { status: 'missing' },
    observedState: 'ready',
    leases: [],
  });
  const result = authorizeComputeOperation(unowned, {
    operation: 'resize',
    policy: SAFE_POLICY,
    now: NOW,
  });
  assert.equal(result.allowed, false);
});

test('status inspection is idempotent for one immutable snapshot', () => {
  const document = status();
  assert.deepEqual(inspectComputeStatus(document, { now: NOW }), inspectComputeStatus(document, { now: NOW }));
});

test('reconciliation is idempotent for one immutable snapshot', () => {
  const document = status();
  assert.deepEqual(
    reconcileComputeStatus(document, { now: NOW }),
    reconcileComputeStatus(document, { now: NOW }),
  );
});

test('reconciliation of a verified resource is safe', () => {
  assert.equal(reconcileComputeStatus(status(), { now: NOW }).safe, true);
});

test('reconciliation reports ambiguous ownership as unsafe', () => {
  const result = reconcileComputeStatus(status({ ownership: { status: 'ambiguous' } }), { now: NOW });
  assert.equal(result.safe, false);
});

test('reconciliation of uncertain ownership does not mutate the status snapshot', () => {
  const document = status({ ownership: { status: 'unverifiable' } });
  const before = structuredClone(document);
  reconcileComputeStatus(document, { now: NOW });
  assert.deepEqual(document, before);
});

test('reconciliation reports desired and observed state drift as a finding', () => {
  const result = reconcileComputeStatus(status({ desiredState: 'dormant' }), { now: NOW });
  assert.equal(result.findings.some((finding) => finding.code === 'reconcile.state-drift'), true);
});

test('reconciliation reports an expired lease as a finding', () => {
  const base = status();
  const result = reconcileComputeStatus(status({
    observedState: 'ready',
    leases: [{
      ...base.leases[0],
      issuedAt: '2026-10-25T09:00:00.000Z',
      expiresAt: '2026-10-25T10:00:00.000Z',
      heartbeatAt: '2026-10-25T09:30:00.000Z',
    }],
  }), { now: NOW });
  assert.equal(result.findings.some((finding) => finding.code === 'reconcile.lease-expired'), true);
});

test('reconciliation reports an adopted resource without mutation authority', () => {
  const document = status({
    mode: 'adopt',
    ownership: { ...status().ownership, mode: 'adopt' },
    desiredState: 'ready',
    observedState: 'ready',
    leases: [],
  });
  const result = reconcileComputeStatus(document, { now: NOW });
  assert.equal(result.mutated, false);
});

test('stop reports ambiguous ownership as unsafe', () => {
  const result = stopComputeResource(status({ ownership: { status: 'ambiguous' } }), {
    policy: SAFE_POLICY,
    now: NOW,
  });
  assert.equal(result.safe, false);
});

test('stop denies a mutation when ownership is unverifiable', () => {
  const result = stopComputeResource(status({ ownership: { status: 'unverifiable' } }), {
    policy: SAFE_POLICY,
    now: NOW,
  });
  assert.equal(result.allowed, false);
});

test('stop of an unverifiable resource leaves the lease state unchanged', () => {
  const state = createComputeLeaseState({ resourceId: 'resource-1', resourceGeneration: 3, now: NOW });
  const before = structuredClone(state);
  stopComputeResource(status({ ownership: { status: 'unverifiable' } }), {
    policy: SAFE_POLICY,
    now: NOW,
    leaseState: state,
  });
  assert.deepEqual(state, before);
});

test('stop of an adopted resource is denied without delegated authority', () => {
  const adopted = status({
    mode: 'adopt',
    ownership: { ...status().ownership, mode: 'adopt' },
  });
  const result = stopComputeResource(adopted, {
    policy: { ...SAFE_POLICY, mode: 'adopt', provisionOptIn: false },
    now: NOW,
  });
  assert.equal(result.allowed, false);
});

test('stop is allowed for a verified leased resource under policy authority', () => {
  const result = stopComputeResource(status(), {
    policy: SAFE_POLICY,
    leaseId: 'lease-1',
    fencingToken: 7,
    now: NOW,
  });
  assert.equal(result.allowed, true);
});

test('an authorized stop releases the matching local lease', () => {
  const state = createComputeLeaseState({ resourceId: 'resource-1', resourceGeneration: 3, now: NOW });
  const acquired = acquireComputeLease(state, {
    leaseId: 'lease-1',
    holder: 'worker-1',
    now: NOW,
    expiresAt: '2026-10-25T13:00:00.000Z',
  });
  if (!acquired.ok) throw new Error(acquired.message);
  const result = stopComputeResource(status({ leases: [acquired.lease] }), {
    policy: SAFE_POLICY,
    now: NOW,
    leaseState: acquired.state,
  });
  assert.equal(result.leaseState?.leases[0]?.releasedAt, NOW);
});

test('release with ambiguous ownership is unsafe and does not mutate lease state', () => {
  const state = createComputeLeaseState({ resourceId: 'resource-1', resourceGeneration: 3, now: NOW });
  const acquired = acquireComputeLease(state, {
    leaseId: 'lease-1',
    holder: 'worker-1',
    now: NOW,
    expiresAt: '2026-10-25T13:00:00.000Z',
  });
  if (!acquired.ok) throw new Error(acquired.message);
  const before = structuredClone(acquired.state);
  const result = releaseComputeLeaseWithAuthority(
    status({ ownership: { status: 'ambiguous' } }),
    acquired.state,
    {
      leaseId: acquired.lease.id,
      holder: acquired.lease.holder,
      fencingToken: acquired.lease.fencingToken,
      now: NOW,
    },
  );
  assert.deepEqual(result.state, before);
});

test('release with verified ownership closes the matching lease', () => {
  const state = createComputeLeaseState({ resourceId: 'resource-1', resourceGeneration: 3, now: NOW });
  const acquired = acquireComputeLease(state, {
    leaseId: 'lease-1',
    holder: 'worker-1',
    now: NOW,
    expiresAt: '2026-10-25T13:00:00.000Z',
  });
  if (!acquired.ok) throw new Error(acquired.message);
  const result = releaseComputeLeaseWithAuthority(status(), acquired.state, {
    leaseId: acquired.lease.id,
    holder: acquired.lease.holder,
    fencingToken: acquired.lease.fencingToken,
    now: NOW,
  });
  assert.equal(result.ok, true);
});

test('release with a stale fencing token leaves lease state unchanged', () => {
  const state = createComputeLeaseState({ resourceId: 'resource-1', resourceGeneration: 3, now: NOW });
  const acquired = acquireComputeLease(state, {
    leaseId: 'lease-1',
    holder: 'worker-1',
    now: NOW,
    expiresAt: '2026-10-25T13:00:00.000Z',
  });
  if (!acquired.ok) throw new Error(acquired.message);
  const before = structuredClone(acquired.state);
  const result = releaseComputeLeaseWithAuthority(status(), acquired.state, {
    leaseId: acquired.lease.id,
    holder: acquired.lease.holder,
    fencingToken: acquired.lease.fencingToken + 1,
    now: NOW,
  });
  assert.deepEqual(result.state, before);
});
