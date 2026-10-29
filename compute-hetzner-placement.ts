import type {
  ComputeFallback,
  ComputeFallbackDecision,
  ComputeIssue,
  ComputeOperation,
  ComputeOwnershipRecord,
  ComputeReconciliation,
  ComputeResource,
  ComputeScaleInDecision,
} from './compute.ts';
import {
  isRecord,
  providerIssue,
  type HetznerQuota,
} from './compute-hetzner-capabilities.ts';

export type FakeHetznerRecordedResource = {
  id: string;
  account?: string;
  project?: string;
  region?: string;
  serverType?: string;
  generation?: number;
  tags?: Record<string, string>;
  ownership?: ComputeOwnershipRecord;
  /** Resource creation time; the scale-in lifetime guardrail uses it. */
  createdAt?: string;
  /** Recorded disk observation for scale-in guardrails. */
  disk?: { usedPercent?: number; limitPercent?: number };
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
  /** True only when this call created a fake-provider resource. */
  mutated: boolean;
  /** Post-mutation reconciliation evidence; null when nothing was created. */
  reconciliation: ComputeReconciliation | null;
};

/** One job routed to a managed resource under a fencing lease. */
export type HetznerJobRouteRequest = {
  requestId: string;
  jobId: string;
  holder: string;
  region?: string;
  serverType?: string;
  now?: string;
  leaseExpiresAt?: string;
  tags?: Record<string, string>;
};

export type HetznerJobRouteStatus = 'routed' | 'replayed' | 'rejected';

export type HetznerJobRouteResult = {
  ok: boolean;
  status: HetznerJobRouteStatus;
  requestId: string;
  jobId: string;
  resourceId: string | null;
  leaseId: string | null;
  fencingToken: number | null;
  expiresAt: string | null;
  issues: ComputeIssue[];
  /** True only when this call acquired a fake-provider lease. */
  mutated: boolean;
  /** Post-mutation reconciliation evidence; null when nothing was routed. */
  reconciliation: ComputeReconciliation | null;
};

export type HetznerJobCompletionResult = {
  ok: boolean;
  jobId: string;
  issues: ComputeIssue[];
  /** True only when this call released a fake-provider lease. */
  mutated: boolean;
  /** Post-mutation reconciliation evidence; null when nothing was released. */
  reconciliation: ComputeReconciliation | null;
};

/** Evidence supplied by the caller when asking to scale one resource to zero. */
export type HetznerScaleToZeroRequest = {
  resourceId: string;
  now?: string;
  idleSince?: string;
  idleTimeoutMs: number;
  busy?: boolean | number | 'unknown';
  queuedWork?: number | 'unknown';
  diskUsedPercent?: number | 'unknown';
  diskLimitPercent?: number;
  minimumLifetimeMs?: number;
  minCapacity?: number;
};

export type HetznerScaleToZeroResult = {
  ok: boolean;
  action: 'retain' | 'scale-to-zero';
  resourceId: string;
  capacity: number;
  decision: ComputeScaleInDecision;
  issues: ComputeIssue[];
  /** True only when this call removed a fake-provider resource. */
  mutated: boolean;
  /** Post-mutation reconciliation evidence; null when capacity was retained. */
  reconciliation: ComputeReconciliation | null;
};

export type HetznerLocalFallbackResult = ComputeFallbackDecision & {
  /** Local fallback is never a remote mutation. */
  mutated: false;
};

export type HetznerReconcileRequest = {
  resourceId: string;
  now?: string;
  /** Optional fallback record included in the reconciliation receipt. */
  fallback?: ComputeFallback | null;
};

type HetznerPlacement = {
  region: string;
  serverType: string;
  capacity: number;
};

export type FakeHetznerResource = ComputeResource & {
  account: string;
  project?: string;
  region: string;
  serverType: string;
  ownership: ComputeOwnershipRecord;
  createdAt: string;
  disk?: { usedPercent?: number; limitPercent?: number };
};

export function placementPoolId(region: string, serverType: string): string {
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

export function requestIssue(code: string, path: string, message: string): ComputeIssue {
  return { code, severity: 'unsafe', path, message };
}

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function requestFingerprint(request: HetznerProvisionRequest): string {
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

export function serialQueue(): <T>(work: () => Promise<T> | T) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T> | T): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}
