import {
  COMPUTE_OPERATIONS,
  COMPUTE_SCHEMA_VERSION,
  inspectComputeCapabilities,
  inspectComputeProviderIdentity,
  verifyComputeProviderIdentity,
  type ComputeCapability,
  type ComputeCapabilityStatus,
  type ComputeIssue,
  type ComputeOperation,
  type ComputeProviderIdentity,
  type ComputeProviderIdentityVerification,
} from './compute.ts';

export const HETZNER_SCHEMA_VERSION = 1;
export const HETZNER_ADAPTER_VERSION = '1.0.0';
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

export function providerIssue(
  code: string,
  path: string,
  message: string,
  severity: ComputeIssue['severity'] = 'invalid',
): ComputeIssue {
  return { code, severity, path, message };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
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
