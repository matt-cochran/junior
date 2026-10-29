import {
  COMPUTE_LIFECYCLE_STATES,
  COMPUTE_MODES,
  COMPUTE_MODE_OPERATIONS,
  COMPUTE_OWNERSHIP_STATUSES,
  COMPUTE_PROVIDER_IDENTITY_STATUSES,
  COMPUTE_SCHEMA_VERSION,
  add,
  isNonEmptyString,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  isTimestamp,
  resolveEpoch,
  sameTags,
} from './compute-schema.ts';
import type {
  ComputeIssue,
  ComputeIssueSeverity,
  ComputeInspection,
  ComputeLifecycleState,
  ComputeMode,
  ComputeOperation,
  ComputeOwnershipRecord,
  ComputeOwnershipStatus,
  ComputeProviderIdentity,
  ComputeProviderIdentityStatus,
  ComputeResource,
  ComputeStatus,
} from './compute-schema.ts';

export type ComputeProviderIdentityInspection = {
  valid: boolean;
  verified: boolean;
  issues: ComputeIssue[];
  identity: ComputeProviderIdentity | null;
};

export type ComputeProviderIdentityVerification = {
  verified: boolean;
  code: 'provider.verified' | 'provider.invalid' | 'provider.unverified' | 'provider.mismatch';
  message: string;
  issues: ComputeIssue[];
};

function providerIdentityIssue(
  code: string,
  path: string,
  message: string,
  severity: ComputeIssueSeverity = 'invalid',
): ComputeIssue {
  return { code, severity, path, message };
}

/** Validate a recorded provider/account identity before any provider call. */
export function inspectComputeProviderIdentity(input: unknown): ComputeProviderIdentityInspection {
  const issues: ComputeIssue[] = [];
  if (!isRecord(input)) {
    return {
      valid: false,
      verified: false,
      issues: [providerIdentityIssue('provider.invalid', '', 'provider identity must be an object')],
      identity: null,
    };
  }
  const raw = input as Partial<ComputeProviderIdentity>;
  if (!COMPUTE_PROVIDER_IDENTITY_STATUSES.includes(raw.status as ComputeProviderIdentityStatus)) {
    issues.push(providerIdentityIssue('provider.invalid', 'status', 'provider identity status is invalid'));
  } else if (raw.status !== 'verified') {
    issues.push(providerIdentityIssue(
      'provider.unverified',
      'status',
      `provider identity is ${raw.status}; a verified identity is required`,
      'unsafe',
    ));
  }
  if (!isNonEmptyString(raw.provider)) {
    issues.push(providerIdentityIssue('provider.invalid', 'provider', 'provider identity provider is required'));
  }
  if (!isNonEmptyString(raw.account)) {
    issues.push(providerIdentityIssue('provider.invalid', 'account', 'provider identity account is required'));
  }
  if (raw.project !== undefined && !isNonEmptyString(raw.project)) {
    issues.push(providerIdentityIssue('provider.invalid', 'project', 'provider identity project must be non-empty'));
  }
  if (raw.endpoint !== undefined && !isNonEmptyString(raw.endpoint)) {
    issues.push(providerIdentityIssue('provider.invalid', 'endpoint', 'provider identity endpoint must be non-empty'));
  }
  if (raw.verifiedAt !== undefined && !isTimestamp(raw.verifiedAt)) {
    issues.push(providerIdentityIssue('provider.invalid', 'verifiedAt', 'provider identity verifiedAt is invalid'));
  }
  if (raw.evidence !== undefined && !isNonEmptyString(raw.evidence)) {
    issues.push(providerIdentityIssue('provider.invalid', 'evidence', 'provider identity evidence must be non-empty'));
  }

  const valid = !issues.some((issue) => issue.severity === 'invalid');
  return {
    valid,
    verified: valid && raw.status === 'verified',
    issues,
    identity: valid ? {
      status: raw.status as ComputeProviderIdentityStatus,
      provider: raw.provider as string,
      account: raw.account as string,
      ...(raw.project === undefined ? {} : { project: raw.project }),
      ...(raw.endpoint === undefined ? {} : { endpoint: raw.endpoint }),
      ...(raw.evidence === undefined ? {} : { evidence: raw.evidence }),
      ...(raw.verifiedAt === undefined ? {} : { verifiedAt: raw.verifiedAt }),
    } : null,
  };
}

/** Compare the recorded provider/account identity with the one just observed. */
export function verifyComputeProviderIdentity(
  expectedInput: unknown,
  observedInput: unknown,
): ComputeProviderIdentityVerification {
  const expected = inspectComputeProviderIdentity(expectedInput);
  if (!expected.valid) {
    return {
      verified: false,
      code: 'provider.invalid',
      message: 'the recorded provider identity is invalid',
      issues: expected.issues,
    };
  }
  if (!expected.verified) {
    return {
      verified: false,
      code: 'provider.unverified',
      message: 'the recorded provider identity is not verified',
      issues: expected.issues,
    };
  }
  const observed = inspectComputeProviderIdentity(observedInput);
  if (!observed.valid || !observed.verified) {
    return {
      verified: false,
      code: 'provider.invalid',
      message: 'the observed provider identity is invalid or unverified',
      issues: observed.issues,
    };
  }
  const expectedIdentity = expected.identity as ComputeProviderIdentity;
  const observedIdentity = observed.identity as ComputeProviderIdentity;
  const fields: Array<keyof Pick<ComputeProviderIdentity, 'provider' | 'account' | 'project' | 'endpoint'>> = [
    'provider',
    'account',
    'project',
    'endpoint',
  ];
  const mismatches = fields
    .filter((field) => expectedIdentity[field] !== undefined && observedIdentity[field] !== expectedIdentity[field])
    .map((field) => providerIdentityIssue(
      'provider.mismatch',
      field,
      `observed provider ${field} does not match the verified record`,
      'unsafe',
    ));
  if (mismatches.length > 0) {
    return {
      verified: false,
      code: 'provider.mismatch',
      message: 'the observed provider account does not match the verified identity; provider calls are refused',
      issues: mismatches,
    };
  }
  return {
    verified: true,
    code: 'provider.verified',
    message: 'the observed provider identity matches the verified account',
    issues: [],
  };
}

export function assertVerifiedComputeProviderIdentity(input: unknown): ComputeProviderIdentity {
  const inspection = inspectComputeProviderIdentity(input);
  if (!inspection.valid || !inspection.verified || inspection.identity === null) {
    const detail = inspection.issues.map((issue) => `${issue.path || 'identity'}: ${issue.message}`).join('; ');
    throw new TypeError(`unverified compute provider identity: ${detail}`);
  }
  return inspection.identity;
}

function validateProviderIdentity(
  status: Record<string, unknown>,
  ownership: ComputeOwnershipRecord,
  issues: ComputeIssue[],
): void {
  if (status.providerIdentity === undefined) return;
  const inspection = inspectComputeProviderIdentity(status.providerIdentity);
  issues.push(...inspection.issues);
  const identity = inspection.identity;
  if (identity === null) return;
  if (identity.provider !== status.provider) {
    issues.push(providerIdentityIssue(
      'provider.identity-mismatch',
      'providerIdentity.provider',
      'observed provider identity does not match the status provider',
      'unsafe',
    ));
  }
  if (ownership.account !== identity.account) {
    issues.push(providerIdentityIssue(
      'provider.identity-mismatch',
      'providerIdentity.account',
      'observed provider account does not match the ownership account',
      'unsafe',
    ));
  }
  if (ownership.project !== undefined && ownership.project !== identity.project) {
    issues.push(providerIdentityIssue(
      'provider.identity-mismatch',
      'providerIdentity.project',
      'observed provider project does not match the ownership project',
      'unsafe',
    ));
  }
  if (identity.status !== 'verified') {
    issues.push(providerIdentityIssue(
      'provider.identity-mismatch',
      'providerIdentity.status',
      'the observed provider identity is not verified',
      'unsafe',
    ));
  }
}


function validateOwnership(
  status: Record<string, unknown>,
  resource: ComputeResource | null,
  issues: ComputeIssue[],
): void {
  const ownership = status.ownership;
  if (!isRecord(ownership) || !COMPUTE_OWNERSHIP_STATUSES.includes(ownership.status as ComputeOwnershipStatus)) {
    add(issues, 'ownership.record', 'ownership.status', 'ownership status is missing or unknown');
    return;
  }
  if (ownership.status !== 'verified') {
    add(
      issues,
      'ownership.record',
      'ownership.status',
      `ownership is ${String(ownership.status)}; no lease or mutation may proceed`,
    );
    return;
  }
  if (ownership.provider !== status.provider) {
    add(issues, 'ownership.provider-match', 'ownership.provider', 'ownership provider does not match the observed provider');
  }
  if (!isNonEmptyString(ownership.account)) {
    add(issues, 'ownership.account', 'ownership.account', 'ownership account/project is missing');
  }
  if (!isNonEmptyString(ownership.resourceId) || !resource || ownership.resourceId !== resource.id) {
    add(issues, 'ownership.resource-match', 'ownership.resourceId', 'ownership resource id does not match the observed resource');
  }
  if (!COMPUTE_MODES.includes(ownership.mode as ComputeMode) || ownership.mode !== status.mode) {
    add(issues, 'ownership.mode-match', 'ownership.mode', 'ownership mode does not match the active mode');
  }
  if (!isNonEmptyString(ownership.owner)) {
    add(issues, 'ownership.owner', 'ownership.owner', 'ownership does not name the owning party');
  }
  if (ownership.creator !== 'junior' && ownership.creator !== 'external') {
    add(issues, 'ownership.creator', 'ownership.creator', 'ownership creator must be junior or external');
  }
  if (!isPositiveInteger(ownership.generation) || !resource || ownership.generation !== resource.generation) {
    add(issues, 'ownership.generation-match', 'ownership.generation', 'ownership generation does not match the observed generation');
  }
  if (!sameTags(ownership.tags, resource?.tags)) {
    add(issues, 'ownership.tags-match', 'ownership.tags', 'ownership tags do not match the observed tags');
  }
  if (!isNonEmptyString(ownership.evidence) || !isTimestamp(ownership.recordedAt)) {
    add(issues, 'ownership.evidence', 'ownership.evidence', 'ownership evidence or recorded time is missing');
  }
}

function validateLeases(
  status: Record<string, unknown>,
  resource: ComputeResource | null,
  now: number,
  issues: ComputeIssue[],
): void {
  const leases = status.leases;
  if (!Array.isArray(leases)) {
    add(issues, 'lease.object', 'leases', 'leases must be an array');
    return;
  }

  let activeLeases = 0;
  for (const [index, value] of leases.entries()) {
    const path = `leases[${index}]`;
    if (!isRecord(value)) {
      add(issues, 'lease.object', path, 'lease must be an object');
      continue;
    }
    if (!isNonEmptyString(value.id) || !isNonEmptyString(value.holder)) {
      add(issues, 'lease.id', path, 'lease id and holder must be non-empty');
    }
    if (!isNonEmptyString(value.resourceId) || !resource || value.resourceId !== resource.id) {
      add(issues, 'lease.resource-match', `${path}.resourceId`, 'lease resource id does not match the observed resource');
    }
    if (!isPositiveInteger(value.resourceGeneration)
      || !resource
      || value.resourceGeneration !== resource.generation) {
      add(
        issues,
        'lease.generation-match',
        `${path}.resourceGeneration`,
        'lease generation does not match the observed generation',
      );
    }
    if (!isPositiveInteger(value.fencingToken)) {
      add(issues, 'lease.fencing', `${path}.fencingToken`, 'fencing token must be a positive integer');
    }

    const issued = Date.parse(String(value.issuedAt));
    const expires = Date.parse(String(value.expiresAt));
    const heartbeat = Date.parse(String(value.heartbeatAt));
    const validWindow = Number.isFinite(issued)
      && Number.isFinite(expires)
      && Number.isFinite(heartbeat)
      && issued < expires
      && heartbeat >= issued
      && heartbeat <= expires;
    if (!validWindow) {
      add(issues, 'lease.window', path, 'lease issue, heartbeat and expiry times are not a valid window');
      continue;
    }
    if (isTimestamp(value.releasedAt)) {
      // A released or reclaimed lease is historical, not active.
    } else if (expires <= now) {
      add(issues, 'lease.expired', path, 'lease has expired and cannot authorize work');
    } else {
      activeLeases += 1;
    }
  }

  if (activeLeases > 1) {
    add(issues, 'lease.conflict', 'leases', 'more than one active lease uses this resource generation');
  }
  if ((status.observedState === 'leased' || status.observedState === 'active') && activeLeases === 0) {
    add(issues, 'lease.observed-active', 'observedState', 'observed leased/active state has no active lease');
  }
}

function validateCapacity(
  status: Record<string, unknown>,
  activeLeaseCount: number,
  issues: ComputeIssue[],
): void {
  const capacity = status.capacity;
  if (!isRecord(capacity)) {
    add(issues, 'capacity.bounds', 'capacity', 'capacity must be an object');
    return;
  }
  const { min, max } = capacity;
  if (!isNonNegativeInteger(min) || !isPositiveInteger(max) || min > max) {
    add(issues, 'capacity.bounds', 'capacity', 'capacity minimum must be zero or greater and no larger than the finite maximum');
  }
  const current = capacity.current;
  if (current !== 'unknown' && !isNonNegativeInteger(current)) {
    add(issues, 'capacity.current', 'capacity.current', 'current capacity must be a nonnegative integer or unknown');
  } else if (typeof current === 'number' && typeof max === 'number' && current > max) {
    add(issues, 'capacity.current', 'capacity.current', 'current capacity exceeds the finite maximum');
  }
  if (current === 0 && activeLeaseCount > 0) {
    add(issues, 'capacity.scale-to-zero', 'capacity.current', 'capacity reached zero while a lease is active');
  }
}

function validateCost(status: Record<string, unknown>, issues: ComputeIssue[]): void {
  const cost = status.cost;
  if (!isRecord(cost)) {
    add(issues, 'cost.amount', 'cost', 'cost must be an object');
    return;
  }
  const amount = cost.amount;
  if (amount !== 'unknown' && !(typeof amount === 'number' && Number.isFinite(amount) && amount >= 0)) {
    add(issues, 'cost.amount', 'cost.amount', 'cost must be nonnegative or explicitly unknown');
  }
  if (!isNonEmptyString(cost.currency)) {
    add(issues, 'cost.currency', 'cost.currency', 'cost currency must be non-empty');
  }
}

function validateFindings(status: Record<string, unknown>, issues: ComputeIssue[]): void {
  const findings = status.findings;
  if (!Array.isArray(findings)) {
    add(issues, 'findings.object', 'findings', 'findings must be an array');
    return;
  }
  for (const [index, finding] of findings.entries()) {
    const path = `findings[${index}]`;
    if (!isRecord(finding)
      || !isNonEmptyString(finding.code)
      || !['info', 'warning', 'blocking'].includes(String(finding.severity))
      || !isNonEmptyString(finding.message)) {
      add(issues, 'findings.object', path, 'finding must have a code, severity and message');
      continue;
    }
    if (finding.severity === 'blocking') {
      add(issues, 'findings.blocking', path, 'a blocking finding makes the resource unsafe');
    }
  }
}

function validateFallback(status: Record<string, unknown>, issues: ComputeIssue[]): void {
  const fallback = status.fallback;
  if (fallback === null || fallback === undefined) return;
  if (!isRecord(fallback)
    || !isNonEmptyString(fallback.reason)
    || !isTimestamp(fallback.occurredAt)) {
    add(issues, 'fallback.reason', 'fallback', 'fallback must record a reason and time');
  }
}

/**
 * Inspect a status snapshot against the published invariants.
 *
 * `valid` covers document shape and vocabulary. `safe` adds ownership, lease,
 * capacity, cost and blocking-finding invariants. Unsafe snapshots remain
 * valid documents: the control plane must be able to report a conflict or a
 * drift finding instead of failing to serialize it.
 */
export function inspectComputeStatus(
  input: unknown,
  opts: { now?: string | number } = {},
): ComputeInspection {
  const issues: ComputeIssue[] = [];
  if (!isRecord(input)) {
    add(issues, 'status.object', '', 'status must be an object');
    return { valid: false, safe: false, issues };
  }

  if (input.schemaVersion !== COMPUTE_SCHEMA_VERSION) {
    add(issues, 'status.schema-version', 'schemaVersion', `expected schema version ${COMPUTE_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(input.provider)) {
    add(issues, 'status.provider', 'provider', 'provider must be a non-empty string');
  }
  if (!isNonEmptyString(input.adapterVersion)) {
    add(issues, 'status.adapter-version', 'adapterVersion', 'adapter version must be a non-empty string');
  }
  if (!COMPUTE_MODES.includes(input.mode as ComputeMode)) {
    add(issues, 'status.mode', 'mode', 'mode must be adopt, managed-existing or provision');
  }
  if (!COMPUTE_LIFECYCLE_STATES.includes(input.desiredState as ComputeLifecycleState)) {
    add(issues, 'state.desired', 'desiredState', 'desired state is not a documented lifecycle state');
  }
  if (!COMPUTE_LIFECYCLE_STATES.includes(input.observedState as ComputeLifecycleState)) {
    add(issues, 'state.observed', 'observedState', 'observed state is not a documented lifecycle state');
  }

  let resource: ComputeResource | null = null;
  if (!isRecord(input.resource)
    || !isNonEmptyString(input.resource.id)
    || !isPositiveInteger(input.resource.generation)
    || !isRecord(input.resource.tags)
    || Object.values(input.resource.tags).some((tag) => typeof tag !== 'string')) {
    add(issues, 'status.resource', 'resource', 'resource must have an id, positive generation and string tags');
  } else {
    resource = input.resource as ComputeResource;
  }

  if (!isTimestamp(input.updatedAt)) {
    add(issues, 'status.timestamps', 'updatedAt', 'updatedAt must be a valid timestamp');
  }

  validateOwnership(input, resource, issues);
  validateProviderIdentity(
    input,
    (isRecord(input.ownership) ? input.ownership : {}) as ComputeOwnershipRecord,
    issues,
  );
  validateLeases(input, resource, resolveEpoch(opts.now), issues);

  const leases = Array.isArray(input.leases) ? input.leases : [];
  const now = resolveEpoch(opts.now);
  const activeLeaseCount = leases.filter((lease) => {
    if (!isRecord(lease) || isTimestamp(lease.releasedAt)) return false;
    const expires = Date.parse(String(lease.expiresAt));
    return Number.isFinite(expires) && expires > now;
  }).length;

  validateCapacity(input, activeLeaseCount, issues);
  validateCost(input, issues);
  validateFindings(input, issues);
  validateFallback(input, issues);

  const valid = !issues.some((issue) => issue.severity === 'invalid');
  const safe = valid && !issues.some((issue) => issue.severity === 'unsafe');
  return { valid, safe, issues };
}

/** Throw for an invalid status document; unsafe status is still a document and
 * remains inspectable through `inspectComputeStatus`. */
export function assertComputeStatus(input: unknown, opts: { now?: string | number } = {}): ComputeStatus {
  const result = inspectComputeStatus(input, opts);
  if (!result.valid) {
    const detail = result.issues.map((issue) => `${issue.path || 'status'}: ${issue.message}`).join('; ');
    throw new TypeError(`invalid compute status: ${detail}`);
  }
  return input as ComputeStatus;
}

/** Whether the mode ceiling permits an operation. Ownership, generation and
 * lease checks remain mandatory for every mutating operation. */
export function modeAllowsOperation(mode: ComputeMode, operation: ComputeOperation): boolean {
  const operations = COMPUTE_MODE_OPERATIONS[mode];
  return Array.isArray(operations) && operations.includes(operation);
}
