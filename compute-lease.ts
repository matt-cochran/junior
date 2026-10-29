import {
  add,
  isNonEmptyString,
  isPositiveInteger,
  isRecord,
  isTimestamp,
  resolveEpoch,
} from './compute-schema.ts';
import type { ComputeIssue, ComputeLease } from './compute-schema.ts';

export const COMPUTE_LEASE_STATE_VERSION = 1;

/** A durable, JSON-serializable lease store for one resource generation.
 * Keeping closed leases makes the fencing-token history auditable; every new
 * acquisition still gets a strictly larger token. */
export type ComputeLeaseState = {
  schemaVersion: typeof COMPUTE_LEASE_STATE_VERSION;
  resourceId: string;
  resourceGeneration: number;
  nextFencingToken: number;
  leases: ComputeLease[];
  updatedAt: string;
};

export type ComputeLeaseStateInspection = {
  valid: boolean;
  safe: boolean;
  issues: ComputeIssue[];
};

/** Create an empty durable lease state. The caller persists the returned
 * object atomically; this module deliberately performs no file I/O. */
export function createComputeLeaseState(input: {
  resourceId: string;
  resourceGeneration: number;
  now: string;
}): ComputeLeaseState {
  return {
    schemaVersion: COMPUTE_LEASE_STATE_VERSION,
    resourceId: input.resourceId,
    resourceGeneration: input.resourceGeneration,
    nextFencingToken: 1,
    leases: [],
    updatedAt: input.now,
  };
}

export function leaseIsClosed(lease: ComputeLease): boolean {
  return isTimestamp(lease.releasedAt);
}

export function leaseIsActive(lease: ComputeLease, now: number): boolean {
  return !leaseIsClosed(lease) && Date.parse(lease.expiresAt) > now;
}

export function leaseIsExpired(lease: ComputeLease, now: number): boolean {
  return !leaseIsClosed(lease) && Date.parse(lease.expiresAt) <= now;
}

export function inspectComputeLeaseState(
  input: unknown,
  opts: { now?: string | number } = {},
): ComputeLeaseStateInspection {
  const issues: ComputeIssue[] = [];
  if (!isRecord(input)) {
    add(issues, 'lease-state.object', '', 'lease state must be an object');
    return { valid: false, safe: false, issues };
  }
  if (input.schemaVersion !== COMPUTE_LEASE_STATE_VERSION) {
    add(issues, 'lease-state.schema-version', 'schemaVersion', `expected lease state version ${COMPUTE_LEASE_STATE_VERSION}`);
  }
  if (!isNonEmptyString(input.resourceId)) {
    add(issues, 'lease-state.resource', 'resourceId', 'lease state needs a resource id');
  }
  if (!isPositiveInteger(input.resourceGeneration)) {
    add(issues, 'lease-state.generation', 'resourceGeneration', 'lease state needs a positive resource generation');
  }
  if (!isPositiveInteger(input.nextFencingToken)) {
    add(issues, 'lease-state.token', 'nextFencingToken', 'next fencing token must be a positive integer');
  }
  if (!isTimestamp(input.updatedAt)) {
    add(issues, 'lease-state.timestamp', 'updatedAt', 'lease state updatedAt must be a valid timestamp');
  }

  const leases = input.leases;
  if (!Array.isArray(leases)) {
    add(issues, 'lease-state.leases', 'leases', 'lease state leases must be an array');
    return { valid: !issues.some((issue) => issue.severity === 'invalid'), safe: false, issues };
  }

  const now = resolveEpoch(opts.now);
  let active = 0;
  const ids = new Set<string>();
  for (const [index, value] of leases.entries()) {
    const path = `leases[${index}]`;
    if (!isRecord(value)) {
      add(issues, 'lease.object', path, 'lease must be an object');
      continue;
    }
    if (!isNonEmptyString(value.id) || !isNonEmptyString(value.holder)) {
      add(issues, 'lease.id', path, 'lease id and holder must be non-empty');
    } else if (ids.has(value.id)) {
      add(issues, 'lease.duplicate-id', `${path}.id`, 'lease id is stored more than once');
    } else {
      ids.add(value.id);
    }
    if (value.resourceId !== input.resourceId) {
      add(issues, 'lease.resource-match', `${path}.resourceId`, 'lease names another resource');
    }
    if (value.resourceGeneration !== input.resourceGeneration) {
      add(issues, 'lease.generation-match', `${path}.resourceGeneration`, 'lease names another generation');
    }
    if (!isPositiveInteger(value.fencingToken)) {
      add(issues, 'lease.fencing', `${path}.fencingToken`, 'fencing token must be a positive integer');
    } else if (isPositiveInteger(input.nextFencingToken) && value.fencingToken >= input.nextFencingToken) {
      add(issues, 'lease.fencing', `${path}.fencingToken`, 'stored fencing token is not below the next token');
    }
    const issued = Date.parse(String(value.issuedAt));
    const expires = Date.parse(String(value.expiresAt));
    const heartbeat = Date.parse(String(value.heartbeatAt));
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || !Number.isFinite(heartbeat)
      || issued >= expires || heartbeat < issued || heartbeat > expires) {
      add(issues, 'lease.window', path, 'lease times do not form a valid window');
      continue;
    }
    if (value.releasedAt !== undefined && !isTimestamp(value.releasedAt)) {
      add(issues, 'lease.window', `${path}.releasedAt`, 'lease releasedAt must be a valid timestamp');
    }
    if (leaseIsActive(value as ComputeLease, now)) active += 1;
  }
  if (active > 1) {
    add(issues, 'lease.conflict', 'leases', 'more than one active lease uses this resource generation');
  }
  const valid = !issues.some((issue) => issue.severity === 'invalid');
  const safe = valid && active <= 1;
  return { valid, safe, issues };
}

export type ComputeLeaseMutation =
  | { ok: true; state: ComputeLeaseState; lease?: ComputeLease }
  | { ok: false; code: string; message: string; state: ComputeLeaseState };

function leaseStateFailure(
  state: ComputeLeaseState,
  code: string,
  message: string,
): ComputeLeaseMutation {
  return { ok: false, code, message, state };
}

/** Acquire the single active lease for a resource generation. Expired leases
 * remain unreclaimed until `reclaimComputeLease` proves quiescence. */
export function acquireComputeLease(
  state: ComputeLeaseState,
  input: {
    leaseId: string;
    holder: string;
    now: string;
    expiresAt: string;
  },
): ComputeLeaseMutation {
  const inspection = inspectComputeLeaseState(state, { now: input.now });
  if (!inspection.valid) {
    return leaseStateFailure(state, 'lease.state-invalid', 'lease state is invalid');
  }
  if (!isNonEmptyString(input.leaseId) || !isNonEmptyString(input.holder)) {
    return leaseStateFailure(state, 'lease.id', 'lease id and holder must be non-empty');
  }
  const now = Date.parse(input.now);
  const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expires) || now >= expires) {
    return leaseStateFailure(state, 'lease.window', 'lease expiry must be after its issue time');
  }
  if (state.leases.some((lease) => lease.id === input.leaseId)) {
    return leaseStateFailure(state, 'lease.duplicate-id', 'lease id already exists');
  }
  if (state.leases.some((lease) => leaseIsActive(lease, now))) {
    return leaseStateFailure(state, 'lease.conflict', 'an active lease already owns this resource generation');
  }
  if (state.leases.some((lease) => leaseIsExpired(lease, now))) {
    return leaseStateFailure(state, 'lease.unreclaimed', 'an expired lease must be reclaimed before a new lease');
  }

  const lease: ComputeLease = {
    id: input.leaseId,
    holder: input.holder,
    resourceId: state.resourceId,
    resourceGeneration: state.resourceGeneration,
    fencingToken: state.nextFencingToken,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(expires).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
  };
  const next: ComputeLeaseState = {
    ...state,
    nextFencingToken: state.nextFencingToken + 1,
    leases: [...state.leases, lease],
    updatedAt: new Date(now).toISOString(),
  };
  return { ok: true, state: next, lease };
}

/** Extend one active lease. A stale holder or fencing token is rejected. */
export function heartbeatComputeLease(
  state: ComputeLeaseState,
  input: {
    leaseId: string;
    holder: string;
    fencingToken: number;
    now: string;
    expiresAt: string;
  },
): ComputeLeaseMutation {
  const inspection = inspectComputeLeaseState(state, { now: input.now });
  if (!inspection.valid) {
    return leaseStateFailure(state, 'lease.state-invalid', 'lease state is invalid');
  }
  const index = state.leases.findIndex((lease) => lease.id === input.leaseId);
  if (index < 0) return leaseStateFailure(state, 'lease.not-found', 'lease does not exist');
  const current = state.leases[index];
  if (current.holder !== input.holder || current.fencingToken !== input.fencingToken) {
    return leaseStateFailure(state, 'lease.fencing', 'holder or fencing token is stale');
  }
  if (leaseIsClosed(current)) {
    return leaseStateFailure(state, 'lease.released', 'lease is already released');
  }
  const now = Date.parse(input.now);
  const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expires) || now >= expires) {
    return leaseStateFailure(state, 'lease.window', 'heartbeat expiry must be after the heartbeat time');
  }
  if (Date.parse(current.expiresAt) <= now) {
    return leaseStateFailure(state, 'lease.expired', 'expired lease cannot be heartbeated');
  }
  const lease: ComputeLease = {
    ...current,
    heartbeatAt: new Date(now).toISOString(),
    expiresAt: new Date(expires).toISOString(),
  };
  const next: ComputeLeaseState = {
    ...state,
    leases: state.leases.map((entry, entryIndex) => entryIndex === index ? lease : entry),
    updatedAt: new Date(now).toISOString(),
  };
  return { ok: true, state: next, lease };
}

/** Release a lease on every success, failure, cancellation and timeout path. */
export function releaseComputeLease(
  state: ComputeLeaseState,
  input: {
    leaseId: string;
    holder: string;
    fencingToken: number;
    now: string;
  },
): ComputeLeaseMutation {
  const inspection = inspectComputeLeaseState(state, { now: input.now });
  if (!inspection.valid) {
    return leaseStateFailure(state, 'lease.state-invalid', 'lease state is invalid');
  }
  const index = state.leases.findIndex((lease) => lease.id === input.leaseId);
  if (index < 0) return leaseStateFailure(state, 'lease.not-found', 'lease does not exist');
  const current = state.leases[index];
  if (current.holder !== input.holder || current.fencingToken !== input.fencingToken) {
    return leaseStateFailure(state, 'lease.fencing', 'holder or fencing token is stale');
  }
  if (leaseIsClosed(current)) {
    return leaseStateFailure(state, 'lease.released', 'lease is already released');
  }
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) {
    return leaseStateFailure(state, 'lease.window', 'release time must be a valid timestamp');
  }
  const lease: ComputeLease = { ...current, releasedAt: new Date(now).toISOString() };
  const next: ComputeLeaseState = {
    ...state,
    leases: state.leases.map((entry, entryIndex) => entryIndex === index ? lease : entry),
    updatedAt: new Date(now).toISOString(),
  };
  return { ok: true, state: next, lease };
}

/** Reclaim expired leases only after the bounded grace period and a successful
 * observation that no work is still active. */
export function reclaimComputeLease(
  state: ComputeLeaseState,
  input: {
    now: string;
    graceMs: number;
    quiescent: boolean;
  },
): ComputeLeaseMutation {
  const inspection = inspectComputeLeaseState(state, { now: input.now });
  if (!inspection.valid) {
    return leaseStateFailure(state, 'lease.state-invalid', 'lease state is invalid');
  }
  const now = Date.parse(input.now);
  if (!Number.isFinite(now) || !Number.isFinite(input.graceMs) || input.graceMs < 0) {
    return leaseStateFailure(state, 'lease.window', 'reclaim needs a valid time and nonnegative grace period');
  }
  const expired = state.leases.filter(
    (lease) => leaseIsExpired(lease, now) && Date.parse(lease.expiresAt) + input.graceMs <= now,
  );
  if (expired.length === 0) {
    return leaseStateFailure(state, 'lease.grace', 'no expired lease has completed the grace period');
  }
  if (input.quiescent !== true) {
    return leaseStateFailure(state, 'lease.active-work', 'work is not observed quiescent; retain the lease');
  }
  const expiredIds = new Set(expired.map((lease) => lease.id));
  const next: ComputeLeaseState = {
    ...state,
    leases: state.leases.map((lease) => expiredIds.has(lease.id)
      ? { ...lease, releasedAt: new Date(now).toISOString() }
      : lease),
    updatedAt: new Date(now).toISOString(),
  };
  return { ok: true, state: next };
}
