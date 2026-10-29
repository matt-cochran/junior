// ---------------------------------------------------------------------------
// Fake Hetzner provider adapter (#123).
//
// The adapter consumes recorded provider responses only. It performs no
// network I/O, reads no credential and creates no cloud resource. Capability
// and quota discovery is normalized into the provider-neutral compute contract
// after the observed provider/account identity matches the verified record.
// ---------------------------------------------------------------------------
// This file is a facade per ADR 0016; implementation lives in the split modules.

import {
  acquireComputeLease,
  COMPUTE_SCHEMA_VERSION,
  createComputeLeaseState,
  decideComputeFallback,
  evaluateComputeScaleIn,
  inspectComputeCapabilities,
  reconcileComputeStatus,
  releaseComputeLease,
  type ComputeFallback,
  type ComputeIssue,
  type ComputeLease,
  type ComputeLeaseState,
  type ComputeLifecycleState,
  type ComputeOwnershipRecord,
  type ComputePolicy,
  type ComputeReconciliation,
  type ComputeResource,
  type ComputeScaleInDecision,
  type ComputeStatus,
} from './compute.ts';
import {
  HETZNER_ADAPTER_VERSION,
  HETZNER_PROVIDER,
  HETZNER_SCHEMA_VERSION,
  HETZNER_UNKNOWN,
  discoverHetznerCapabilities,
  inspectHetznerProviderIdentity,
  isRecord,
  normalizeHetznerCapabilities,
  normalizeHetznerQuota,
  verifyHetznerProviderIdentity,
  type HetznerCapabilityDiscovery,
  type HetznerQuota,
} from './compute-hetzner-capabilities.ts';
import {
  normalizeHetznerPlacement,
  placementPoolId,
  requestFingerprint,
  requestIssue,
  serialQueue,
  stableValue,
  type FakeHetznerDiscoveryOptions,
  type FakeHetznerProviderRecorded,
  type FakeHetznerResource,
  type HetznerJobCompletionResult,
  type HetznerJobRouteRequest,
  type HetznerJobRouteResult,
  type HetznerLocalFallbackResult,
  type HetznerProvisionRequest,
  type HetznerProvisionResult,
  type HetznerReconcileRequest,
  type HetznerScaleToZeroRequest,
  type HetznerScaleToZeroResult,
} from './compute-hetzner-placement.ts';

export {
  HETZNER_ADAPTER_VERSION, HETZNER_PROVIDER, HETZNER_SCHEMA_VERSION, HETZNER_UNKNOWN,
  discoverHetznerCapabilities, inspectHetznerProviderIdentity,
  normalizeHetznerCapabilities, normalizeHetznerQuota, verifyHetznerProviderIdentity,
} from './compute-hetzner-capabilities.ts';
export type {
  HetznerCapabilityDiscovery, HetznerCapabilityDiscoveryInput, HetznerProviderIdentity,
  HetznerProviderIdentityInspection, HetznerQuota,
} from './compute-hetzner-capabilities.ts';
export { normalizeHetznerPlacement } from './compute-hetzner-placement.ts';
export type {
  FakeHetznerDiscoveryOptions, FakeHetznerProviderRecorded, FakeHetznerRecordedResource,
  HetznerJobCompletionResult, HetznerJobRouteRequest, HetznerJobRouteResult, HetznerJobRouteStatus,
  HetznerLocalFallbackResult, HetznerProvisionRequest, HetznerProvisionResult, HetznerProvisionStatus,
  HetznerReconcileRequest, HetznerScaleToZeroRequest, HetznerScaleToZeroResult,
} from './compute-hetzner-placement.ts';

/**
 * A deterministic fake provider backed only by recorded responses. Mutating
 * provisioning is serialized per provider instance so a concurrent request
 * observes the preceding request's quota and placement effects.
 */
export function createFakeHetznerProvider(recorded: FakeHetznerProviderRecorded) {
  const resources: FakeHetznerResource[] = (recorded.resources ?? []).map((resource) => ({
    ...resource,
    generation: resource.generation ?? 1,
    tags: { ...(resource.tags ?? {}) },
    ownership: resource.ownership ?? { status: 'unverifiable', resourceId: resource.id },
    createdAt: resource.createdAt ?? resource.ownership?.recordedAt ?? '1970-01-01T00:00:00.000Z',
  }));
  const initialResourceCount = resources.length;
  const placements = normalizeHetznerPlacement(recorded.placement);
  const requests = new Map<string, { fingerprint: string; result: HetznerProvisionResult }>();
  const leases = new Map<string, { state: ComputeLeaseState; jobId: string; requestId: string }>();
  const jobRoutes = new Map<string, { fingerprint: string; result: HetznerJobRouteResult }>();
  const jobIndex = new Map<string, { resourceId: string; leaseId: string; requestId: string }>();
  const lastIdleAt = new Map<string, string>();
  const serialize = serialQueue();
  let nextResource = 1;
  const recordedIdentity = inspectHetznerProviderIdentity(recorded.identity);

  /** Build the provider-neutral status for one observed fake resource. */
  const statusFor = (
    resource: FakeHetznerResource,
    options: {
      now: string;
      observedState?: ComputeLifecycleState;
      capacityCurrent?: number;
      fallback?: ComputeFallback | null;
    },
  ): ComputeStatus => {
    const leaseEntry = leases.get(resource.id);
    const resourceLeases: ComputeLease[] = leaseEntry === undefined
      ? []
      : leaseEntry.state.leases.map((lease) => ({ ...lease }));
    const active = resourceLeases.some((lease) =>
      lease.releasedAt === undefined && Date.parse(lease.expiresAt) > Date.parse(options.now));
    return {
      schemaVersion: COMPUTE_SCHEMA_VERSION,
      provider: HETZNER_PROVIDER,
      adapterVersion: HETZNER_ADAPTER_VERSION,
      mode: 'provision',
      ...(recordedIdentity.verified && recordedIdentity.identity !== null
        ? { providerIdentity: recordedIdentity.identity }
        : {}),
      resource: { id: resource.id, generation: resource.generation, tags: { ...resource.tags } },
      ownership: { ...resource.ownership, tags: { ...(resource.ownership.tags ?? {}) } },
      desiredState: 'active',
      observedState: options.observedState ?? (active ? 'leased' : 'ready'),
      leases: resourceLeases,
      capacity: { min: 0, max: 1, current: options.capacityCurrent ?? 1 },
      cost: { currency: 'EUR', amount: 'unknown' },
      findings: [],
      fallback: options.fallback ?? null,
      updatedAt: options.now,
    };
  };

  const reconcileResource = (
    resource: FakeHetznerResource,
    options: {
      now: string;
      observedState?: ComputeLifecycleState;
      capacityCurrent?: number;
      fallback?: ComputeFallback | null;
    },
  ): ComputeReconciliation => reconcileComputeStatus(statusFor(resource, options), { now: options.now });

  const currentQuota = (): HetznerQuota => {
    const base = normalizeHetznerQuota(recorded.quota);
    if (base.serverLimit === HETZNER_UNKNOWN || base.serversUsed === HETZNER_UNKNOWN) {
      return base;
    }
    const serversUsed = base.serversUsed + Math.max(0, resources.length - initialResourceCount);
    return {
      serverLimit: base.serverLimit,
      serversUsed,
      serversAvailable: Math.max(0, base.serverLimit - serversUsed),
    };
  };

  const rejection = (
    request: Partial<HetznerProvisionRequest>,
    poolId: string,
    issue: ComputeIssue,
  ): HetznerProvisionResult => ({
    ok: false,
    status: 'rejected',
    requestId: typeof request.requestId === 'string' ? request.requestId : '',
    poolId,
    resource: null,
    ownership: null,
    quota: currentQuota(),
    issues: [issue],
    mutated: false,
    reconciliation: null,
  });

  const provision = (input: unknown): Promise<HetznerProvisionResult> => serialize(() => {
    const request = isRecord(input) ? input as Partial<HetznerProvisionRequest> : {};
    const poolId = typeof request.poolId === 'string' && request.poolId.trim() !== ''
      ? request.poolId.trim()
      : typeof request.region === 'string' && typeof request.serverType === 'string'
        ? placementPoolId(request.region.trim(), request.serverType.trim())
        : '';
    if (typeof request.requestId !== 'string' || request.requestId.trim() === '') {
      return rejection(request, poolId, requestIssue('request.id', 'requestId', 'provisioning requires a non-empty request id'));
    }
    const requestId = request.requestId.trim();
    if (typeof request.owner !== 'string' || request.owner.trim() === '') {
      return rejection(request, poolId, requestIssue('ownership.owner', 'owner', 'provisioning requires an explicit owner'));
    }
    if (typeof request.region !== 'string' || request.region.trim() === '' ||
        typeof request.serverType !== 'string' || request.serverType.trim() === '') {
      return rejection(request, poolId, requestIssue('placement.required', 'region', 'provisioning requires a region and server type'));
    }
    const normalized: HetznerProvisionRequest = {
      ...request,
      requestId,
      owner: request.owner.trim(),
      project: typeof request.project === 'string' ? request.project : undefined,
      region: request.region.trim(),
      serverType: request.serverType.trim(),
      poolId,
    };
    const fingerprint = requestFingerprint(normalized);
    const prior = requests.get(requestId);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) {
        return rejection(normalized, poolId, requestIssue(
          'request.id-conflict',
          'requestId',
          `request id ${requestId} was already used with different provisioning content`,
        ));
      }
      return { ...prior.result, status: 'replayed', quota: currentQuota(), mutated: false };
    }

    const identity = verifyHetznerProviderIdentity(
      normalized.expectedIdentity ?? recorded.identity,
      recorded.identity,
    );
    if (!identity.verified) {
      const result = {
        ...rejection(normalized, poolId, requestIssue('ownership.identity', 'identity', 'provider identity is not verified for this account')),
        issues: identity.issues.length > 0
          ? identity.issues
          : [requestIssue('ownership.identity', 'identity', 'provider identity is not verified for this account')],
      };
      requests.set(requestId, { fingerprint, result });
      return result;
    }

    const observed = inspectHetznerProviderIdentity(recorded.identity);
    const account = observed.identity?.account ?? HETZNER_UNKNOWN;
    const foreign = resources.find((resource) => {
      const resourceAccount = resource.account ?? resource.ownership.account;
      return resourceAccount !== undefined && resourceAccount !== account;
    });
    if (foreign !== undefined) {
      const result = rejection(normalized, poolId, requestIssue(
        'ownership.inventory-account',
        'resources',
        `recorded inventory ${foreign.id} belongs to another account`,
      ));
      requests.set(requestId, { fingerprint, result });
      return result;
    }

    const capabilities = normalizeHetznerCapabilities(recorded.capabilities);
    const required = [...(normalized.required ?? []), 'inspect', 'create'];
    const capabilityInspection = inspectComputeCapabilities(capabilities, required);
    if (!capabilityInspection.ready) {
      const result = rejection(normalized, poolId, requestIssue(
        'capability.required',
        'capabilities',
        'the fake provider does not support every required provisioning operation',
      ));
      requests.set(requestId, { fingerprint, result });
      return result;
    }

    const quota = currentQuota();
    if (quota.serverLimit === HETZNER_UNKNOWN || quota.serversUsed === HETZNER_UNKNOWN || quota.serversAvailable === HETZNER_UNKNOWN) {
      const result = rejection(normalized, poolId, requestIssue(
        'quota.unknown',
        'quota',
        'quota is unknown; provisioning fails closed',
      ));
      requests.set(requestId, { fingerprint, result });
      return result;
    }
    if (quota.serversAvailable <= 0) {
      const result = rejection(normalized, poolId, requestIssue(
        'quota.exhausted',
        'quota',
        `no server quota remains (${quota.serversUsed}/${quota.serverLimit} used)`,
      ));
      requests.set(requestId, { fingerprint, result });
      return result;
    }

    const inPool = resources.filter((resource) =>
      resource.region === normalized.region && resource.serverType === normalized.serverType);
    if (placements.length > 0) {
      const placement = placements.find((entry) =>
        entry.region === normalized.region && entry.serverType === normalized.serverType);
      if (placement === undefined) {
        const result = rejection(normalized, poolId, requestIssue(
          'placement.unavailable',
          'placement',
          `recorded placement does not include ${normalized.region}/${normalized.serverType}`,
        ));
        requests.set(requestId, { fingerprint, result });
        return result;
      }
      if (inPool.length >= placement.capacity) {
        const result = rejection(normalized, poolId, requestIssue(
          'placement.capacity',
          'placement',
          `${placementPoolId(placement.region, placement.serverType)} placement is at capacity`,
        ));
        requests.set(requestId, { fingerprint, result });
        return result;
      }
    }

    const id = `hetzner-server-${nextResource}`;
    while (resources.some((resource) => resource.id === id)) nextResource += 1;
    nextResource += 1;
    const recordedAt = normalized.now ?? '1970-01-01T00:00:00.000Z';
    const tags = {
      ...(normalized.tags ?? {}),
      owner: normalized.owner,
      'junior-request-id': requestId,
    };
    const ownership: ComputeOwnershipRecord = {
      status: 'verified',
      provider: HETZNER_PROVIDER,
      account,
      ...(normalized.project === undefined ? {} : { project: normalized.project }),
      resourceId: id,
      mode: 'provision',
      owner: normalized.owner,
      creator: 'junior',
      generation: 1,
      tags: { ...tags },
      evidence: `request:${requestId}`,
      recordedAt,
    };
    const resource: FakeHetznerResource = {
      id,
      generation: 1,
      tags: { ...tags },
      account,
      ...(normalized.project === undefined ? {} : { project: normalized.project }),
      region: normalized.region,
      serverType: normalized.serverType,
      ownership,
      createdAt: recordedAt,
    };
    resources.push(resource);
    const result: HetznerProvisionResult = {
      ok: true,
      status: 'provisioned',
      requestId,
      poolId,
      resource: { id: resource.id, generation: resource.generation, tags: { ...resource.tags } },
      ownership: { ...ownership, tags: { ...(ownership.tags ?? {}) } },
      quota: currentQuota(),
      issues: [],
      mutated: true,
      reconciliation: reconcileResource(resource, { now: recordedAt }),
    };
    requests.set(requestId, { fingerprint, result });
    return result;
  });

  const routeJob = (input: unknown): Promise<HetznerJobRouteResult> => serialize(() => {
    const request = isRecord(input) ? input as Partial<HetznerJobRouteRequest> : {};
    const reject = (code: string, path: string, message: string): HetznerJobRouteResult => ({
      ok: false,
      status: 'rejected',
      requestId: typeof request.requestId === 'string' ? request.requestId : '',
      jobId: typeof request.jobId === 'string' ? request.jobId : '',
      resourceId: null,
      leaseId: null,
      fencingToken: null,
      expiresAt: null,
      issues: [requestIssue(code, path, message)],
      mutated: false,
      reconciliation: null,
    });
    if (typeof request.requestId !== 'string' || request.requestId.trim() === '') {
      return reject('request.id', 'requestId', 'job routing requires a non-empty request id');
    }
    if (typeof request.jobId !== 'string' || request.jobId.trim() === '') {
      return reject('job.id', 'jobId', 'job routing requires a non-empty job id');
    }
    if (typeof request.holder !== 'string' || request.holder.trim() === '') {
      return reject('job.holder', 'holder', 'job routing requires an explicit holder');
    }
    const requestId = request.requestId.trim();
    const jobId = request.jobId.trim();
    const fingerprint = JSON.stringify(stableValue({
      jobId,
      holder: request.holder.trim(),
      region: request.region,
      serverType: request.serverType,
      tags: request.tags,
      leaseExpiresAt: request.leaseExpiresAt,
    }));
    const prior = jobRoutes.get(requestId);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) {
        return reject('request.id-conflict', 'requestId', `request id ${requestId} was already used with different routing content`);
      }
      return { ...prior.result, status: 'replayed', mutated: false };
    }
    const now = typeof request.now === 'string' && Number.isFinite(Date.parse(request.now))
      ? request.now
      : '1970-01-01T00:00:00.000Z';
    const expiresAt = typeof request.leaseExpiresAt === 'string' && Date.parse(request.leaseExpiresAt) > Date.parse(now)
      ? request.leaseExpiresAt
      : new Date(Date.parse(now) + 60 * 60_000).toISOString();
    const candidate = resources.find((resource) => {
      if (resource.ownership.status !== 'verified') return false;
      if (typeof request.region === 'string' && resource.region !== request.region) return false;
      if (typeof request.serverType === 'string' && resource.serverType !== request.serverType) return false;
      if (request.tags !== undefined) {
        if (!isRecord(request.tags)) return false;
        for (const [key, value] of Object.entries(request.tags)) {
          if (resource.tags?.[key] !== value) return false;
        }
      }
      const lease = leases.get(resource.id);
      if (lease === undefined) return true;
      const active = lease.state.leases.some((entry) =>
        entry.releasedAt === undefined && Date.parse(entry.expiresAt) > Date.parse(now));
      const unreclaimed = lease.state.leases.some((entry) =>
        entry.releasedAt === undefined && Date.parse(entry.expiresAt) <= Date.parse(now));
      return !active && !unreclaimed;
    });
    if (candidate === undefined) {
      return reject('route.unavailable', 'resources', 'no managed resource can accept this job');
    }
    const state = leases.get(candidate.id)
      ?? createComputeLeaseState({ resourceId: candidate.id, resourceGeneration: candidate.generation, now });
    const leaseId = `lease-${jobId}`;
    const acquired = acquireComputeLease(state, {
      leaseId,
      holder: request.holder.trim(),
      now,
      expiresAt,
    });
    if (!acquired.ok || acquired.lease === undefined) {
      return reject(acquired.code, 'lease', acquired.message);
    }
    leases.set(candidate.id, { state: acquired.state, jobId, requestId });
    lastIdleAt.delete(candidate.id);
    const result: HetznerJobRouteResult = {
      ok: true,
      status: 'routed',
      requestId,
      jobId,
      resourceId: candidate.id,
      leaseId,
      fencingToken: acquired.lease.fencingToken,
      expiresAt,
      issues: [],
      mutated: true,
      reconciliation: reconcileResource(candidate, { now }),
    };
    jobRoutes.set(requestId, { fingerprint, result });
    jobIndex.set(jobId, { resourceId: candidate.id, leaseId, requestId });
    return result;
  });

  const completeJob = (input: unknown): HetznerJobCompletionResult => {
    const request = isRecord(input) ? input : {};
    const jobId = typeof request.jobId === 'string' ? request.jobId : '';
    const routed = jobIndex.get(jobId);
    if (routed === undefined) {
      return {
        ok: false,
        jobId,
        issues: [requestIssue('route.not-found', 'jobId', 'job has no routed lease')],
        mutated: false,
        reconciliation: null,
      };
    }
    const leaseEntry = leases.get(routed.resourceId);
    const lease = leaseEntry?.state.leases.find((entry) => entry.id === routed.leaseId);
    const now = typeof request.now === 'string' && Number.isFinite(Date.parse(request.now))
      ? request.now
      : (leaseEntry?.state.updatedAt ?? '1970-01-01T00:00:00.000Z');
    if (lease === undefined || leaseEntry === undefined) {
      return {
        ok: false,
        jobId,
        issues: [requestIssue('lease.not-found', 'leaseId', 'routed lease does not exist')],
        mutated: false,
        reconciliation: null,
      };
    }
    const released = releaseComputeLease(leaseEntry.state, {
      leaseId: lease.id,
      holder: lease.holder,
      fencingToken: lease.fencingToken,
      now,
    });
    if (!released.ok) {
      return {
        ok: false,
        jobId,
        issues: [requestIssue(released.code, 'lease', released.message)],
        mutated: false,
        reconciliation: null,
      };
    }
    leases.set(routed.resourceId, { ...leaseEntry, state: released.state });
    lastIdleAt.set(routed.resourceId, now);
    jobIndex.delete(jobId);
    const resource = resources.find((entry) => entry.id === routed.resourceId);
    return {
      ok: true,
      jobId,
      issues: [],
      mutated: true,
      reconciliation: resource === undefined ? null : reconcileResource(resource, { now }),
    };
  };

  const scaleToZero = (input: unknown): HetznerScaleToZeroResult => {
    const request = isRecord(input) ? input as Partial<HetznerScaleToZeroRequest> : {};
    const resourceId = typeof request.resourceId === 'string' ? request.resourceId : '';
    const rejected = (decision: ComputeScaleInDecision): HetznerScaleToZeroResult => ({
      ok: false,
      action: 'retain',
      resourceId,
      capacity: decision.targetCapacity,
      decision,
      issues: decision.reasons.map((reason) =>
        requestIssue(`scale.${reason}`, reason, decision.message)),
      mutated: false,
      reconciliation: null,
    });
    const resource = resources.find((entry) => entry.id === resourceId);
    if (resource === undefined) {
      return rejected({
        allowed: false,
        action: 'retain',
        targetCapacity: 0,
        code: 'scale.not-found',
        message: 'managed resource does not exist',
        reasons: ['resource'],
      });
    }
    if (resource.ownership.status !== 'verified') {
      return rejected({
        allowed: false,
        action: 'retain',
        targetCapacity: 1,
        code: 'scale.ownership',
        message: 'resource ownership is not verified; retain capacity',
        reasons: ['ownership'],
      });
    }
    const now = typeof request.now === 'string' && Number.isFinite(Date.parse(request.now))
      ? request.now
      : resource.createdAt;
    const lease = leases.get(resource.id);
    const leaseActive = lease !== undefined && lease.state.leases.some((entry) => entry.releasedAt === undefined);
    const idleSince = typeof request.idleSince === 'string'
      ? request.idleSince
      : (lastIdleAt.get(resource.id) ?? resource.createdAt);
    const decision = evaluateComputeScaleIn({
      capacity: { min: request.minCapacity ?? 0, max: 1, current: 1 },
      idleSince,
      idleTimeoutMs: request.idleTimeoutMs,
      busy: request.busy ?? false,
      leaseActive,
      queuedWork: request.queuedWork ?? 0,
      diskUsedPercent: request.diskUsedPercent ?? resource.disk?.usedPercent ?? HETZNER_UNKNOWN,
      diskLimitPercent: request.diskLimitPercent ?? resource.disk?.limitPercent ?? 80,
      startedAt: resource.createdAt,
      minimumLifetimeMs: request.minimumLifetimeMs ?? 0,
      now,
    });
    if (!decision.allowed || decision.targetCapacity > 0) {
      return rejected(decision);
    }
    const index = resources.findIndex((entry) => entry.id === resource.id);
    if (index >= 0) resources.splice(index, 1);
    leases.delete(resource.id);
    lastIdleAt.delete(resource.id);
    return {
      ok: true,
      action: 'scale-to-zero',
      resourceId,
      capacity: 0,
      decision,
      issues: [],
      mutated: true,
      reconciliation: reconcileResource(resource, {
        now,
        observedState: 'destroyed',
        capacityCurrent: 0,
      }),
    };
  };

  const localFallback = (input: unknown): HetznerLocalFallbackResult => {
    const request = isRecord(input) ? input : {};
    const decision = decideComputeFallback({
      reason: request.reason,
      occurredAt: request.occurredAt,
      ...(isRecord(request.policy) ? { policy: request.policy as ComputePolicy } : {}),
      ...(request.allowLocalFallback === undefined
        ? {}
        : { allowLocalFallback: request.allowLocalFallback }),
    });
    return { ...decision, mutated: false };
  };

  const reconcile = (input: unknown): ComputeReconciliation => {
    const request = isRecord(input) ? input as Partial<HetznerReconcileRequest> : {};
    const resourceId = typeof request.resourceId === 'string' ? request.resourceId : '';
    const now = typeof request.now === 'string' && Number.isFinite(Date.parse(request.now))
      ? request.now
      : '1970-01-01T00:00:00.000Z';
    const resource = resources.find((entry) => entry.id === resourceId);
    if (resource === undefined) {
      return {
        schemaVersion: COMPUTE_SCHEMA_VERSION,
        operation: 'reconcile',
        provider: HETZNER_PROVIDER,
        adapterVersion: HETZNER_ADAPTER_VERSION,
        mode: 'provision',
        resourceId,
        resourceGeneration: 0,
        ownership: 'unverifiable',
        desiredState: 'active',
        observedState: 'destroyed',
        valid: true,
        safe: false,
        mutated: false,
        requiresOperator: true,
        findings: [{
          code: 'reconcile.resource-missing',
          severity: 'blocking',
          message: 'managed resource does not exist in the fake provider',
          evidence: resourceId,
        }],
        issues: [],
      };
    }
    return reconcileResource(resource, {
      now,
      ...(request.fallback === undefined ? {} : { fallback: request.fallback }),
    });
  };

  return {
    recorded: {
      identity: recorded.identity,
      capabilities: recorded.capabilities,
      quota: recorded.quota,
      placement: recorded.placement,
      resources: recorded.resources,
    },
    discover(options: FakeHetznerDiscoveryOptions = {}): HetznerCapabilityDiscovery {
      return discoverHetznerCapabilities({
        expectedIdentity: options.expectedIdentity ?? recorded.identity,
        identity: recorded.identity,
        capabilities: recorded.capabilities,
        quota: recorded.quota,
        ...(options.required === undefined ? {} : { required: options.required }),
      });
    },
    provision(input: unknown): Promise<HetznerProvisionResult> {
      return provision(input);
    },
    routeJob(input: unknown): Promise<HetznerJobRouteResult> {
      return routeJob(input);
    },
    completeJob(input: unknown): HetznerJobCompletionResult {
      return completeJob(input);
    },
    scaleToZero(input: unknown): HetznerScaleToZeroResult {
      return scaleToZero(input);
    },
    localFallback(input: unknown): HetznerLocalFallbackResult {
      return localFallback(input);
    },
    reconcile(input: unknown): ComputeReconciliation {
      return reconcile(input);
    },
    listResources(): ComputeResource[] {
      return resources.map((resource) => ({
        id: resource.id,
        generation: resource.generation,
        tags: { ...resource.tags },
      }));
    },
  };
}

export const createHetznerAdapter = createFakeHetznerProvider;
