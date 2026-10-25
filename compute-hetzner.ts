// ---------------------------------------------------------------------------
// Fake Hetzner provider adapter (#123).
//
// The adapter consumes recorded provider responses only. It performs no
// network I/O, reads no credential and creates no cloud resource. Capability
// and quota discovery is normalized into the provider-neutral compute contract
// after the observed provider/account identity matches the verified record.
// ---------------------------------------------------------------------------

import {
  COMPUTE_OPERATIONS,
  inspectComputeCapabilities,
  inspectComputeProviderIdentity,
  verifyComputeProviderIdentity,
  type ComputeCapability,
  type ComputeCapabilityStatus,
  type ComputeIssue,
  type ComputeOperation,
  type ComputeOwnershipRecord,
  type ComputeProviderIdentity,
  type ComputeProviderIdentityVerification,
  type ComputeResource,
} from './compute.ts';

export const HETZNER_SCHEMA_VERSION = 1;
export const HETZNER_PROVIDER = 'hetzner';
export const HETZNER_UNKNOWN = 'unknown' as const;

export type HetznerProviderIdentity = ComputeProviderIdentity & {
  provider: typeof HETZNER_PROVIDER;
};

export type HetznerProviderIdentityInspection = {
  valid: boolean;
  verified: boolean;
  issues: ComputeIssue[];
  identity: HetznerProviderIdentity | null;
};

export type HetznerQuota = {
  serverLimit: number | typeof HETZNER_UNKNOWN;
  serversUsed: number | typeof HETZNER_UNKNOWN;
  serversAvailable: number | typeof HETZNER_UNKNOWN;
};

export type HetznerCapabilityDiscoveryInput = {
  /** The verified ownership/account record. */
  expectedIdentity: unknown;
  /** The account identity returned by the fake provider. */
  identity?: unknown;
  capabilities?: unknown;
  quota?: unknown;
  required?: readonly ComputeOperation[];
};

export type HetznerCapabilityDiscovery = {
  schemaVersion: typeof HETZNER_SCHEMA_VERSION;
  provider: typeof HETZNER_PROVIDER;
  account: string | typeof HETZNER_UNKNOWN;
  verified: boolean;
  ready: boolean;
  capabilities: ComputeCapability[];
  quota: HetznerQuota;
  issues: ComputeIssue[];
};

function providerIssue(
  code: string,
  path: string,
  message: string,
  severity: ComputeIssue['severity'] = 'invalid',
): ComputeIssue {
  return { code, severity, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a Hetzner provider/account identity without calling the provider. */
export function inspectHetznerProviderIdentity(input: unknown): HetznerProviderIdentityInspection {
  const inspection = inspectComputeProviderIdentity(input);
  if (!inspection.valid || inspection.identity === null) {
    return {
      valid: false,
      verified: false,
      issues: inspection.issues,
      identity: null,
    };
  }
  if (inspection.identity.provider !== HETZNER_PROVIDER) {
    return {
      valid: false,
      verified: false,
      issues: [
        ...inspection.issues,
        providerIssue(
          'provider.identity-mismatch',
          'provider',
          `provider identity must name ${HETZNER_PROVIDER}`,
          'unsafe',
        ),
      ],
      identity: null,
    };
  }
  return {
    valid: true,
    verified: inspection.verified,
    issues: inspection.issues,
    identity: inspection.identity as HetznerProviderIdentity,
  };
}

/** Compare the verified Hetzner account with the account just observed. */
export function verifyHetznerProviderIdentity(
  expectedInput: unknown,
  observedInput: unknown,
): ComputeProviderIdentityVerification {
  const expected = inspectHetznerProviderIdentity(expectedInput);
  if (!expected.valid || expected.identity === null) {
    return {
      verified: false,
      code: 'provider.invalid',
      message: 'the recorded Hetzner provider identity is invalid',
      issues: expected.issues,
    };
  }
  const observed = inspectHetznerProviderIdentity(observedInput);
  if (!observed.valid || observed.identity === null) {
    return {
      verified: false,
      code: 'provider.invalid',
      message: 'the observed Hetzner provider identity is invalid',
      issues: observed.issues,
    };
  }
  return verifyComputeProviderIdentity(expected.identity, observed.identity);
}

function capabilityStatus(value: unknown): ComputeCapabilityStatus | null {
  if (value === 'supported' || value === 'unsupported' || value === 'unknown') return value;
  if (value === true) return 'supported';
  if (value === false) return 'unsupported';
  return null;
}

function capabilityEntries(raw: Record<string, unknown>): { operation: string; status: unknown; reason?: unknown }[] {
  if (typeof raw.operation === 'string') {
    return [{ operation: raw.operation, status: raw.status, reason: raw.reason }];
  }
  return Object.entries(raw).map(([operation, value]) => {
    if (isRecord(value)) {
      return { operation, status: value.status, reason: value.reason };
    }
    return { operation, status: value };
  });
}

/**
 * Normalize a recorded capability response to the provider-neutral vocabulary.
 * Missing operations are explicitly `unsupported`; malformed advertisements
 * are `unknown` and never silently treated as supported.
 */
export function normalizeHetznerCapabilities(input: unknown): ComputeCapability[] {
  const advertised = new Map<ComputeOperation, ComputeCapability>();
  const entries: { operation: string; status: unknown; reason?: unknown }[] = [];

  if (Array.isArray(input)) {
    for (const value of input) {
      if (isRecord(value)) entries.push(...capabilityEntries(value));
    }
  } else if (isRecord(input)) {
    entries.push(...capabilityEntries(input));
  }

  for (const entry of entries) {
    const operation = entry.operation as ComputeOperation;
    if (!COMPUTE_OPERATIONS.includes(operation) || advertised.has(operation)) continue;
    const status = capabilityStatus(entry.status);
    if (status === null) {
      advertised.set(operation, {
        operation,
        status: 'unknown',
        reason: 'provider capability response was not recognized',
      });
      continue;
    }
    advertised.set(operation, {
      operation,
      status,
      ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
    });
  }

  return COMPUTE_OPERATIONS.map((operation) => advertised.get(operation) ?? {
    operation,
    status: 'unsupported' as const,
    reason: 'operation was not advertised by the provider',
  });
}

function quotaNumber(...values: unknown[]): number | typeof HETZNER_UNKNOWN {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isInteger(value)) {
      return value;
    }
  }
  return HETZNER_UNKNOWN;
}

/**
 * Normalize a recorded Hetzner quota response. An absent value stays explicit
 * `unknown`; it is never reported as zero capacity.
 */
export function normalizeHetznerQuota(input: unknown): HetznerQuota {
  const raw = isRecord(input) ? input : {};
  const limits = isRecord(raw.limits) ? raw.limits : {};
  const usage = isRecord(raw.usage) ? raw.usage : {};
  const serverLimit = quotaNumber(
    limits.servers,
    raw.serverLimit,
    raw.limit,
    raw.serversLimit,
    raw.servers,
  );
  const serversUsed = quotaNumber(
    usage.servers,
    raw.serversUsed,
    raw.used,
    raw.usage,
  );
  const serversAvailable = serverLimit === HETZNER_UNKNOWN || serversUsed === HETZNER_UNKNOWN
    ? HETZNER_UNKNOWN
    : Math.max(0, serverLimit - serversUsed);
  return { serverLimit, serversUsed, serversAvailable };
}

function discoveryFailure(
  account: string | typeof HETZNER_UNKNOWN,
  quota: HetznerQuota,
  issues: ComputeIssue[],
): HetznerCapabilityDiscovery {
  return {
    schemaVersion: HETZNER_SCHEMA_VERSION,
    provider: HETZNER_PROVIDER,
    account,
    verified: false,
    ready: false,
    capabilities: [],
    quota,
    issues,
  };
}

/**
 * Discover capabilities and quota from a recorded/fake response. A missing,
 * unverified or mismatched provider/account identity fails closed: no provider
 * capabilities are exposed and no operation becomes ready.
 */
export function discoverHetznerCapabilities(
  input: HetznerCapabilityDiscoveryInput,
): HetznerCapabilityDiscovery {
  const observed = input.identity ?? input.expectedIdentity;
  const identity = verifyHetznerProviderIdentity(input.expectedIdentity, observed);
  if (!identity.verified) {
    return discoveryFailure(HETZNER_UNKNOWN, normalizeHetznerQuota(input.quota), identity.issues);
  }

  const observedInspection = inspectHetznerProviderIdentity(observed);
  const account = observedInspection.identity?.account ?? HETZNER_UNKNOWN;
  const capabilities = normalizeHetznerCapabilities(input.capabilities);
  const required = [...(input.required ?? COMPUTE_OPERATIONS)];
  const inspection = inspectComputeCapabilities(capabilities, required);
  return {
    schemaVersion: HETZNER_SCHEMA_VERSION,
    provider: HETZNER_PROVIDER,
    account,
    verified: true,
    ready: inspection.ready,
    capabilities,
    quota: normalizeHetznerQuota(input.quota),
    issues: [...identity.issues, ...inspection.issues],
  };
}

export type FakeHetznerRecordedResource = {
  id: string;
  account?: string;
  project?: string;
  region?: string;
  serverType?: string;
  generation?: number;
  tags?: Record<string, string>;
  ownership?: ComputeOwnershipRecord;
};

export type FakeHetznerProviderRecorded = {
  identity: unknown;
  capabilities?: unknown;
  quota?: unknown;
  /** Recorded placement catalogue; absent means quota-only provisioning. */
  placement?: unknown;
  /** Recorded inventory already present in the fake provider. */
  resources?: readonly FakeHetznerRecordedResource[];
};

export type FakeHetznerDiscoveryOptions = {
  expectedIdentity?: unknown;
  required?: readonly ComputeOperation[];
};

/** One provider-neutral provisioning request. The request id is the idempotency key. */
export type HetznerProvisionRequest = {
  requestId: string;
  owner: string;
  project?: string;
  region: string;
  serverType: string;
  poolId?: string;
  tags?: Record<string, string>;
  expectedIdentity?: unknown;
  required?: readonly ComputeOperation[];
  now?: string;
};

export type HetznerProvisionStatus = 'provisioned' | 'replayed' | 'rejected';

export type HetznerProvisionResult = {
  ok: boolean;
  status: HetznerProvisionStatus;
  requestId: string;
  poolId: string;
  resource: ComputeResource | null;
  ownership: ComputeOwnershipRecord | null;
  quota: HetznerQuota;
  issues: ComputeIssue[];
};

type HetznerPlacement = {
  region: string;
  serverType: string;
  capacity: number;
};

type FakeHetznerResource = ComputeResource & {
  account: string;
  project?: string;
  region: string;
  serverType: string;
  ownership: ComputeOwnershipRecord;
};

function placementPoolId(region: string, serverType: string): string {
  return `${region}:${serverType}`;
}

/** Normalize an explicit recorded placement catalogue. No catalogue means the
 * fake provider is quota-only; a malformed entry never widens capacity. */
export function normalizeHetznerPlacement(input: unknown): HetznerPlacement[] {
  const raw = isRecord(input) && Array.isArray(input.placements)
    ? input.placements
    : isRecord(input) && Array.isArray(input.pools)
      ? input.pools
      : isRecord(input) && Array.isArray(input.allowed)
        ? input.allowed
        : Array.isArray(input)
          ? input
          : isRecord(input)
            ? [input]
            : [];
  const result: HetznerPlacement[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const region = typeof entry.region === 'string' ? entry.region.trim() : '';
    const serverType = typeof entry.serverType === 'string' ? entry.serverType.trim() : '';
    if (region === '' || serverType === '') continue;
    const capacity = typeof entry.capacity === 'number' && Number.isInteger(entry.capacity) && entry.capacity >= 0
      ? entry.capacity
      : Number.POSITIVE_INFINITY;
    result.push({ region, serverType, capacity });
  }
  return result;
}

function requestIssue(code: string, path: string, message: string): ComputeIssue {
  return { code, severity: 'unsafe', path, message };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function requestFingerprint(request: HetznerProvisionRequest): string {
  return JSON.stringify(stableValue({
    owner: request.owner,
    project: request.project,
    region: request.region,
    serverType: request.serverType,
    poolId: request.poolId,
    tags: request.tags,
    required: request.required,
    expectedIdentity: request.expectedIdentity,
  }));
}

function serialQueue(): <T>(work: () => Promise<T> | T) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T> | T): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

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
  }));
  const initialResourceCount = resources.length;
  const placements = normalizeHetznerPlacement(recorded.placement);
  const requests = new Map<string, { fingerprint: string; result: HetznerProvisionResult }>();
  const serialize = serialQueue();
  let nextResource = 1;

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
      return { ...prior.result, status: 'replayed', quota: currentQuota() };
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
    };
    requests.set(requestId, { fingerprint, result });
    return result;
  });

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
