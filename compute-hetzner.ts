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


type FakeHetznerLeaseEntry = { state: ComputeLeaseState; jobId: string; requestId: string };

type FakeHetznerState = {
  recorded: FakeHetznerProviderRecorded;
  resources: FakeHetznerResource[];
  initialResourceCount: number;
  placements: ReturnType<typeof normalizeHetznerPlacement>;
  requests: Map<string, { fingerprint: string; result: HetznerProvisionResult }>;
  leases: Map<string, FakeHetznerLeaseEntry>;
  jobRoutes: Map<string, { fingerprint: string; result: HetznerJobRouteResult }>;
  jobIndex: Map<string, { resourceId: string; leaseId: string; requestId: string }>;
  lastIdleAt: Map<string, string>;
  serialize: ReturnType<typeof serialQueue>;
  nextResource: number;
  recordedIdentity: ReturnType<typeof inspectHetznerProviderIdentity>;
};

type FakeHetznerStatusOptions = {
  now: string;
  observedState?: ComputeLifecycleState;
  capacityCurrent?: number;
  fallback?: ComputeFallback | null;
};

function createFakeHetznerState(recorded: FakeHetznerProviderRecorded): FakeHetznerState {
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
  const leases = new Map<string, FakeHetznerLeaseEntry>();
  const jobRoutes = new Map<string, { fingerprint: string; result: HetznerJobRouteResult }>();
  const jobIndex = new Map<string, { resourceId: string; leaseId: string; requestId: string }>();
  const lastIdleAt = new Map<string, string>();
  const serialize = serialQueue();
  const nextResource = 1;
  const recordedIdentity = inspectHetznerProviderIdentity(recorded.identity);
  return {
    recorded,
    resources,
    initialResourceCount,
    placements,
    requests,
    leases,
    jobRoutes,
    jobIndex,
    lastIdleAt,
    serialize,
    nextResource,
    recordedIdentity,
  };
}

/** Build the provider-neutral status for one observed fake resource. */
function fakeStatusFor(
  s: FakeHetznerState,
  resource: FakeHetznerResource,
  options: FakeHetznerStatusOptions,
): ComputeStatus {
  const leaseEntry = s.leases.get(resource.id);
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
    ...(s.recordedIdentity.verified && s.recordedIdentity.identity !== null
      ? { providerIdentity: s.recordedIdentity.identity }
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
}

function fakeReconcileResource(
  s: FakeHetznerState,
  resource: FakeHetznerResource,
  options: FakeHetznerStatusOptions,
): ComputeReconciliation {
  return reconcileComputeStatus(fakeStatusFor(s, resource, options), { now: options.now });
}

function fakeCurrentQuota(s: FakeHetznerState): HetznerQuota {
  const base = normalizeHetznerQuota(s.recorded.quota);
  if (base.serverLimit === HETZNER_UNKNOWN || base.serversUsed === HETZNER_UNKNOWN) {
    return base;
  }
  const serversUsed = base.serversUsed + Math.max(0, s.resources.length - s.initialResourceCount);
  return {
    serverLimit: base.serverLimit,
    serversUsed,
    serversAvailable: Math.max(0, base.serverLimit - serversUsed),
  };
}

function fakeRejection(
  s: FakeHetznerState,
  request: Partial<HetznerProvisionRequest>,
  poolId: string,
  issue: ComputeIssue,
): HetznerProvisionResult {
  return {
    ok: false,
    status: 'rejected',
    requestId: typeof request.requestId === 'string' ? request.requestId : '',
    poolId,
    resource: null,
    ownership: null,
    quota: fakeCurrentQuota(s),
    issues: [issue],
    mutated: false,
    reconciliation: null,
  };
}

function provisionPoolId(request: Partial<HetznerProvisionRequest>): string {
  return typeof request.poolId === 'string' && request.poolId.trim() !== ''
    ? request.poolId.trim()
    : typeof request.region === 'string' && typeof request.serverType === 'string'
      ? placementPoolId(request.region.trim(), request.serverType.trim())
      : '';
}

function normalizeProvisionRequest(
  s: FakeHetznerState,
  request: Partial<HetznerProvisionRequest>,
  poolId: string,
): { rejected: HetznerProvisionResult } | { normalized: HetznerProvisionRequest } {
  if (typeof request.requestId !== 'string' || request.requestId.trim() === '') {
    return { rejected: fakeRejection(s, request, poolId, requestIssue('request.id', 'requestId', 'provisioning requires a non-empty request id')) };
  }
  const requestId = request.requestId.trim();
  if (typeof request.owner !== 'string' || request.owner.trim() === '') {
    return { rejected: fakeRejection(s, request, poolId, requestIssue('ownership.owner', 'owner', 'provisioning requires an explicit owner')) };
  }
  if (typeof request.region !== 'string' || request.region.trim() === '' ||
      typeof request.serverType !== 'string' || request.serverType.trim() === '') {
    return { rejected: fakeRejection(s, request, poolId, requestIssue('placement.required', 'region', 'provisioning requires a region and server type')) };
  }
  return {
    normalized: {
      ...request,
      requestId,
      owner: request.owner.trim(),
      project: typeof request.project === 'string' ? request.project : undefined,
      region: request.region.trim(),
      serverType: request.serverType.trim(),
      poolId,
    },
  };
}

function provisionIdentityBlocker(
  s: FakeHetznerState,
  normalized: HetznerProvisionRequest,
  poolId: string,
): HetznerProvisionResult | null {
  const identity = verifyHetznerProviderIdentity(
    normalized.expectedIdentity ?? s.recorded.identity,
    s.recorded.identity,
  );
  if (identity.verified) return null;
  return {
    ...fakeRejection(s, normalized, poolId, requestIssue('ownership.identity', 'identity', 'provider identity is not verified for this account')),
    issues: identity.issues.length > 0
      ? identity.issues
      : [requestIssue('ownership.identity', 'identity', 'provider identity is not verified for this account')],
  };
}

function provisionInventoryBlocker(
  s: FakeHetznerState,
  normalized: HetznerProvisionRequest,
  poolId: string,
  account: string,
): HetznerProvisionResult | null {
  const foreign = s.resources.find((resource) => {
    const resourceAccount = resource.account ?? resource.ownership.account;
    return resourceAccount !== undefined && resourceAccount !== account;
  });
  if (foreign === undefined) return null;
  return fakeRejection(s, normalized, poolId, requestIssue(
    'ownership.inventory-account',
    'resources',
    `recorded inventory ${foreign.id} belongs to another account`,
  ));
}

function provisionCapabilityBlocker(
  s: FakeHetznerState,
  normalized: HetznerProvisionRequest,
  poolId: string,
): HetznerProvisionResult | null {
  const capabilities = normalizeHetznerCapabilities(s.recorded.capabilities);
  const required = [...(normalized.required ?? []), 'inspect', 'create'];
  const capabilityInspection = inspectComputeCapabilities(capabilities, required);
  if (capabilityInspection.ready) return null;
  return fakeRejection(s, normalized, poolId, requestIssue(
    'capability.required',
    'capabilities',
    'the fake provider does not support every required provisioning operation',
  ));
}

function provisionQuotaBlocker(
  s: FakeHetznerState,
  normalized: HetznerProvisionRequest,
  poolId: string,
): HetznerProvisionResult | null {
  const quota = fakeCurrentQuota(s);
  if (quota.serverLimit === HETZNER_UNKNOWN || quota.serversUsed === HETZNER_UNKNOWN || quota.serversAvailable === HETZNER_UNKNOWN) {
    return fakeRejection(s, normalized, poolId, requestIssue(
      'quota.unknown',
      'quota',
      'quota is unknown; provisioning fails closed',
    ));
  }
  if (quota.serversAvailable <= 0) {
    return fakeRejection(s, normalized, poolId, requestIssue(
      'quota.exhausted',
      'quota',
      `no server quota remains (${quota.serversUsed}/${quota.serverLimit} used)`,
    ));
  }
  return null;
}

function provisionPlacementBlocker(
  s: FakeHetznerState,
  normalized: HetznerProvisionRequest,
  poolId: string,
): HetznerProvisionResult | null {
  const inPool = s.resources.filter((resource) =>
    resource.region === normalized.region && resource.serverType === normalized.serverType);
  if (s.placements.length === 0) return null;
  const placement = s.placements.find((entry) =>
    entry.region === normalized.region && entry.serverType === normalized.serverType);
  if (placement === undefined) {
    return fakeRejection(s, normalized, poolId, requestIssue(
      'placement.unavailable',
      'placement',
      `recorded placement does not include ${normalized.region}/${normalized.serverType}`,
    ));
  }
  if (inPool.length >= placement.capacity) {
    return fakeRejection(s, normalized, poolId, requestIssue(
      'placement.capacity',
      'placement',
      `${placementPoolId(placement.region, placement.serverType)} placement is at capacity`,
    ));
  }
  return null;
}

function provisionFakeResource(
  s: FakeHetznerState,
  normalized: HetznerProvisionRequest,
  poolId: string,
  account: string,
): HetznerProvisionResult {
  const requestId = normalized.requestId;
  const id = `hetzner-server-${s.nextResource}`;
  while (s.resources.some((resource) => resource.id === id)) s.nextResource += 1;
  s.nextResource += 1;
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
  s.resources.push(resource);
  return {
    ok: true,
    status: 'provisioned',
    requestId,
    poolId,
    resource: { id: resource.id, generation: resource.generation, tags: { ...resource.tags } },
    ownership: { ...ownership, tags: { ...(ownership.tags ?? {}) } },
    quota: fakeCurrentQuota(s),
    issues: [],
    mutated: true,
    reconciliation: fakeReconcileResource(s, resource, { now: recordedAt }),
  };
}

function fakeProvisionNow(s: FakeHetznerState, input: unknown): HetznerProvisionResult {
  const request = isRecord(input) ? input as Partial<HetznerProvisionRequest> : {};
  const poolId = provisionPoolId(request);
  const checked = normalizeProvisionRequest(s, request, poolId);
  if ('rejected' in checked) return checked.rejected;
  const normalized = checked.normalized;
  const requestId = normalized.requestId;
  const fingerprint = requestFingerprint(normalized);
  const prior = s.requests.get(requestId);
  if (prior !== undefined) {
    if (prior.fingerprint !== fingerprint) {
      return fakeRejection(s, normalized, poolId, requestIssue(
        'request.id-conflict',
        'requestId',
        `request id ${requestId} was already used with different provisioning content`,
      ));
    }
    return { ...prior.result, status: 'replayed', quota: fakeCurrentQuota(s), mutated: false };
  }

  const remember = (result: HetznerProvisionResult): HetznerProvisionResult => {
    s.requests.set(requestId, { fingerprint, result });
    return result;
  };
  const identityBlocked = provisionIdentityBlocker(s, normalized, poolId);
  if (identityBlocked !== null) return remember(identityBlocked);

  const observed = inspectHetznerProviderIdentity(s.recorded.identity);
  const account = observed.identity?.account ?? HETZNER_UNKNOWN;
  const blocked = provisionInventoryBlocker(s, normalized, poolId, account)
    ?? provisionCapabilityBlocker(s, normalized, poolId)
    ?? provisionQuotaBlocker(s, normalized, poolId)
    ?? provisionPlacementBlocker(s, normalized, poolId);
  if (blocked !== null) return remember(blocked);

  return remember(provisionFakeResource(s, normalized, poolId, account));
}

function fakeProvision(s: FakeHetznerState, input: unknown): Promise<HetznerProvisionResult> {
  return s.serialize(() => fakeProvisionNow(s, input));
}

function routeRejection(
  request: Partial<HetznerJobRouteRequest>,
  code: string,
  path: string,
  message: string,
): HetznerJobRouteResult {
  return {
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
  };
}

function routeCandidateMatches(
  s: FakeHetznerState,
  request: Partial<HetznerJobRouteRequest>,
  resource: FakeHetznerResource,
  now: string,
): boolean {
  if (resource.ownership.status !== 'verified') return false;
  if (typeof request.region === 'string' && resource.region !== request.region) return false;
  if (typeof request.serverType === 'string' && resource.serverType !== request.serverType) return false;
  if (request.tags !== undefined) {
    if (!isRecord(request.tags)) return false;
    for (const [key, value] of Object.entries(request.tags)) {
      if (resource.tags?.[key] !== value) return false;
    }
  }
  const lease = s.leases.get(resource.id);
  if (lease === undefined) return true;
  const active = lease.state.leases.some((entry) =>
    entry.releasedAt === undefined && Date.parse(entry.expiresAt) > Date.parse(now));
  const unreclaimed = lease.state.leases.some((entry) =>
    entry.releasedAt === undefined && Date.parse(entry.expiresAt) <= Date.parse(now));
  return !active && !unreclaimed;
}

function routeJobFingerprint(request: Partial<HetznerJobRouteRequest>, jobId: string, holder: string): string {
  return JSON.stringify(stableValue({
    jobId,
    holder,
    region: request.region,
    serverType: request.serverType,
    tags: request.tags,
    leaseExpiresAt: request.leaseExpiresAt,
  }));
}

function routeJobTimes(request: Partial<HetznerJobRouteRequest>): { now: string; expiresAt: string } {
  const now = typeof request.now === 'string' && Number.isFinite(Date.parse(request.now))
    ? request.now
    : '1970-01-01T00:00:00.000Z';
  const expiresAt = typeof request.leaseExpiresAt === 'string' && Date.parse(request.leaseExpiresAt) > Date.parse(now)
    ? request.leaseExpiresAt
    : new Date(Date.parse(now) + 60 * 60_000).toISOString();
  return { now, expiresAt };
}

function leaseRoutedJob(
  s: FakeHetznerState,
  candidate: FakeHetznerResource,
  ids: { requestId: string; jobId: string; holder: string; fingerprint: string },
  times: { now: string; expiresAt: string },
  reject: (code: string, path: string, message: string) => HetznerJobRouteResult,
): HetznerJobRouteResult {
  const { requestId, jobId, holder, fingerprint } = ids;
  const { now, expiresAt } = times;
  const state = s.leases.get(candidate.id)
    ?? createComputeLeaseState({ resourceId: candidate.id, resourceGeneration: candidate.generation, now });
  const leaseId = `lease-${jobId}`;
  const acquired = acquireComputeLease(state, {
    leaseId,
    holder,
    now,
    expiresAt,
  });
  if (!acquired.ok || acquired.lease === undefined) {
    return reject(acquired.code, 'lease', acquired.message);
  }
  s.leases.set(candidate.id, { state: acquired.state, jobId, requestId });
  s.lastIdleAt.delete(candidate.id);
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
    reconciliation: fakeReconcileResource(s, candidate, { now }),
  };
  s.jobRoutes.set(requestId, { fingerprint, result });
  s.jobIndex.set(jobId, { resourceId: candidate.id, leaseId, requestId });
  return result;
}

function fakeRouteJobNow(s: FakeHetznerState, input: unknown): HetznerJobRouteResult {
  const request = isRecord(input) ? input as Partial<HetznerJobRouteRequest> : {};
  const reject = (code: string, path: string, message: string): HetznerJobRouteResult =>
    routeRejection(request, code, path, message);
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
  const fingerprint = routeJobFingerprint(request, jobId, request.holder.trim());
  const prior = s.jobRoutes.get(requestId);
  if (prior !== undefined) {
    if (prior.fingerprint !== fingerprint) {
      return reject('request.id-conflict', 'requestId', `request id ${requestId} was already used with different routing content`);
    }
    return { ...prior.result, status: 'replayed', mutated: false };
  }
  const times = routeJobTimes(request);
  const candidate = s.resources.find((resource) => routeCandidateMatches(s, request, resource, times.now));
  if (candidate === undefined) {
    return reject('route.unavailable', 'resources', 'no managed resource can accept this job');
  }
  return leaseRoutedJob(
    s,
    candidate,
    { requestId, jobId, holder: request.holder.trim(), fingerprint },
    times,
    reject,
  );
}

function fakeRouteJob(s: FakeHetznerState, input: unknown): Promise<HetznerJobRouteResult> {
  return s.serialize(() => fakeRouteJobNow(s, input));
}

function completionFailure(jobId: string, code: string, path: string, message: string): HetznerJobCompletionResult {
  return {
    ok: false,
    jobId,
    issues: [requestIssue(code, path, message)],
    mutated: false,
    reconciliation: null,
  };
}

function fakeCompleteJob(s: FakeHetznerState, input: unknown): HetznerJobCompletionResult {
  const request = isRecord(input) ? input : {};
  const jobId = typeof request.jobId === 'string' ? request.jobId : '';
  const routed = s.jobIndex.get(jobId);
  if (routed === undefined) {
    return completionFailure(jobId, 'route.not-found', 'jobId', 'job has no routed lease');
  }
  const leaseEntry = s.leases.get(routed.resourceId);
  const lease = leaseEntry?.state.leases.find((entry) => entry.id === routed.leaseId);
  const now = typeof request.now === 'string' && Number.isFinite(Date.parse(request.now))
    ? request.now
    : (leaseEntry?.state.updatedAt ?? '1970-01-01T00:00:00.000Z');
  if (lease === undefined || leaseEntry === undefined) {
    return completionFailure(jobId, 'lease.not-found', 'leaseId', 'routed lease does not exist');
  }
  const released = releaseComputeLease(leaseEntry.state, {
    leaseId: lease.id,
    holder: lease.holder,
    fencingToken: lease.fencingToken,
    now,
  });
  if (!released.ok) {
    return completionFailure(jobId, released.code, 'lease', released.message);
  }
  s.leases.set(routed.resourceId, { ...leaseEntry, state: released.state });
  s.lastIdleAt.set(routed.resourceId, now);
  s.jobIndex.delete(jobId);
  const resource = s.resources.find((entry) => entry.id === routed.resourceId);
  return {
    ok: true,
    jobId,
    issues: [],
    mutated: true,
    reconciliation: resource === undefined ? null : fakeReconcileResource(s, resource, { now }),
  };
}

function scaleRejected(resourceId: string, decision: ComputeScaleInDecision): HetznerScaleToZeroResult {
  return {
    ok: false,
    action: 'retain',
    resourceId,
    capacity: decision.targetCapacity,
    decision,
    issues: decision.reasons.map((reason) =>
      requestIssue(`scale.${reason}`, reason, decision.message)),
    mutated: false,
    reconciliation: null,
  };
}

function evaluateFakeScaleIn(
  s: FakeHetznerState,
  request: Partial<HetznerScaleToZeroRequest>,
  resource: FakeHetznerResource,
  now: string,
): ComputeScaleInDecision {
  const lease = s.leases.get(resource.id);
  const leaseActive = lease !== undefined && lease.state.leases.some((entry) => entry.releasedAt === undefined);
  const idleSince = typeof request.idleSince === 'string'
    ? request.idleSince
    : (s.lastIdleAt.get(resource.id) ?? resource.createdAt);
  return evaluateComputeScaleIn({
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
}

function fakeScaleToZero(s: FakeHetznerState, input: unknown): HetznerScaleToZeroResult {
  const request = isRecord(input) ? input as Partial<HetznerScaleToZeroRequest> : {};
  const resourceId = typeof request.resourceId === 'string' ? request.resourceId : '';
  const resource = s.resources.find((entry) => entry.id === resourceId);
  if (resource === undefined) {
    return scaleRejected(resourceId, {
      allowed: false,
      action: 'retain',
      targetCapacity: 0,
      code: 'scale.not-found',
      message: 'managed resource does not exist',
      reasons: ['resource'],
    });
  }
  if (resource.ownership.status !== 'verified') {
    return scaleRejected(resourceId, {
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
  const decision = evaluateFakeScaleIn(s, request, resource, now);
  if (!decision.allowed || decision.targetCapacity > 0) {
    return scaleRejected(resourceId, decision);
  }
  const index = s.resources.findIndex((entry) => entry.id === resource.id);
  if (index >= 0) s.resources.splice(index, 1);
  s.leases.delete(resource.id);
  s.lastIdleAt.delete(resource.id);
  return {
    ok: true,
    action: 'scale-to-zero',
    resourceId,
    capacity: 0,
    decision,
    issues: [],
    mutated: true,
    reconciliation: fakeReconcileResource(s, resource, {
      now,
      observedState: 'destroyed',
      capacityCurrent: 0,
    }),
  };
}

function fakeLocalFallback(input: unknown): HetznerLocalFallbackResult {
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
}

function fakeReconcile(s: FakeHetznerState, input: unknown): ComputeReconciliation {
  const request = isRecord(input) ? input as Partial<HetznerReconcileRequest> : {};
  const resourceId = typeof request.resourceId === 'string' ? request.resourceId : '';
  const now = typeof request.now === 'string' && Number.isFinite(Date.parse(request.now))
    ? request.now
    : '1970-01-01T00:00:00.000Z';
  const resource = s.resources.find((entry) => entry.id === resourceId);
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
  return fakeReconcileResource(s, resource, {
    now,
    ...(request.fallback === undefined ? {} : { fallback: request.fallback }),
  });
}

/**
 * A deterministic fake provider backed only by recorded responses. Mutating
 * provisioning is serialized per provider instance so a concurrent request
 * observes the preceding request's quota and placement effects.
 */
export function createFakeHetznerProvider(recorded: FakeHetznerProviderRecorded) {
  const s = createFakeHetznerState(recorded);
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
      return fakeProvision(s, input);
    },
    routeJob(input: unknown): Promise<HetznerJobRouteResult> {
      return fakeRouteJob(s, input);
    },
    completeJob(input: unknown): HetznerJobCompletionResult {
      return fakeCompleteJob(s, input);
    },
    scaleToZero(input: unknown): HetznerScaleToZeroResult {
      return fakeScaleToZero(s, input);
    },
    localFallback(input: unknown): HetznerLocalFallbackResult {
      return fakeLocalFallback(input);
    },
    reconcile(input: unknown): ComputeReconciliation {
      return fakeReconcile(s, input);
    },
    listResources(): ComputeResource[] {
      return s.resources.map((resource) => ({
        id: resource.id,
        generation: resource.generation,
        tags: { ...resource.tags },
      }));
    },
  };
}

export const createHetznerAdapter = createFakeHetznerProvider;
