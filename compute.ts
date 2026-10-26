// ---------------------------------------------------------------------------
// Provider-neutral remote-compute contract.
//
// This module is the public domain boundary for issue #123. It names the
// vocabulary shared by the control plane, provider adapters, CLI and receipt
// writer, and it publishes one machine-readable status schema. Provider API
// names, credentials and retry rules stay outside this contract.
//
// The validators are pure and offline. They never call a provider; fixtures
// and tests can therefore prove ownership, lease, capacity and cost invariants
// without cloud credentials or external infrastructure (ADR 0014).
// ---------------------------------------------------------------------------

/** Version of the public status/CLI contract in this module. */
export const COMPUTE_SCHEMA_VERSION = 1;

/** The only resource ownership modes. Mode is a ceiling, not an implicit grant. */
export const COMPUTE_MODES = ['adopt', 'managed-existing', 'provision'] as const;
export type ComputeMode = typeof COMPUTE_MODES[number];

/** Desired and observed lifecycle vocabulary. The two are kept separately. */
export const COMPUTE_LIFECYCLE_STATES = [
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
] as const;
export type ComputeLifecycleState = typeof COMPUTE_LIFECYCLE_STATES[number];

/** Capabilities an adapter may advertise. A missing one is `unsupported`. */
export const COMPUTE_OPERATIONS = [
  'inspect',
  'attach',
  'create',
  'start',
  'stop',
  'resize',
  'destroy',
  'tag',
  'reconcile',
] as const;
export type ComputeOperation = typeof COMPUTE_OPERATIONS[number];

export const COMPUTE_CAPABILITY_STATUSES = ['supported', 'unsupported', 'unknown'] as const;
export type ComputeCapabilityStatus = typeof COMPUTE_CAPABILITY_STATUSES[number];

export const COMPUTE_OWNERSHIP_STATUSES = [
  'verified',
  'missing',
  'ambiguous',
  'unverifiable',
] as const;
export type ComputeOwnershipStatus = typeof COMPUTE_OWNERSHIP_STATUSES[number];

/** Account-level identity observed from a provider control API. */
export const COMPUTE_PROVIDER_IDENTITY_STATUSES = [
  'verified',
  'missing',
  'ambiguous',
  'unverified',
  'mismatch',
] as const;
export type ComputeProviderIdentityStatus = typeof COMPUTE_PROVIDER_IDENTITY_STATUSES[number];

export type ComputeProviderIdentity = {
  status: ComputeProviderIdentityStatus;
  provider: string;
  account: string;
  project?: string;
  endpoint?: string;
  evidence?: string;
  verifiedAt?: string;
};

/** Maximum provider-neutral operations for each ownership mode. Ownership
 * records, leases and generation checks still have to pass before a mutating
 * operation is allowed. */
export const COMPUTE_MODE_OPERATIONS: Readonly<Record<ComputeMode, readonly ComputeOperation[]>> = {
  adopt: ['inspect', 'attach', 'reconcile'],
  'managed-existing': ['inspect', 'attach', 'start', 'stop', 'resize', 'tag', 'reconcile'],
  provision: ['inspect', 'attach', 'create', 'start', 'stop', 'resize', 'destroy', 'tag', 'reconcile'],
};

/** One explicitly advertised adapter capability. */
export type ComputeCapability = {
  operation: ComputeOperation;
  status: ComputeCapabilityStatus;
  /** Why an operation is unsupported or unknown; never a secret. */
  reason?: string;
};

/** Provider-neutral identity of one resource generation. */
export type ComputeResource = {
  id: string;
  generation: number;
  tags: Record<string, string>;
};

/** The recorded ownership of one managed resource (ADR 0014 R3). */
export type ComputeOwnershipRecord = {
  status: ComputeOwnershipStatus;
  provider?: string;
  account?: string;
  project?: string;
  resourceId?: string;
  mode?: ComputeMode;
  owner?: string;
  creator?: 'junior' | 'external';
  generation?: number;
  tags?: Record<string, string>;
  evidence?: string;
  recordedAt?: string;
};

/** A fencing lease for one resource generation (ADR 0014 R5). */
export type ComputeLease = {
  id: string;
  holder: string;
  resourceId: string;
  resourceGeneration: number;
  fencingToken: number;
  issuedAt: string;
  expiresAt: string;
  heartbeatAt: string;
  /** Set when the lease is released or reclaimed; closed leases never authorize work. */
  releasedAt?: string;
};

export type ComputeFindingSeverity = 'info' | 'warning' | 'blocking';

/** A reconciliation finding. A blocking finding makes the status unsafe. */
export type ComputeFinding = {
  code: string;
  severity: ComputeFindingSeverity;
  message: string;
  evidence?: string;
};

/** Explicit local-fallback record; fallback never mutates remote resources. */
export type ComputeFallback = {
  reason: string;
  occurredAt: string;
};

/** One secret-free status snapshot for a managed resource. `unknown` is a
 * first-class cost/capacity value and must never be represented as zero. */
export type ComputeStatus = {
  schemaVersion: typeof COMPUTE_SCHEMA_VERSION;
  provider: string;
  adapterVersion: string;
  mode: ComputeMode;
  /** Observed provider/account identity; when present it must match ownership. */
  providerIdentity?: ComputeProviderIdentity;
  resource: ComputeResource;
  ownership: ComputeOwnershipRecord;
  desiredState: ComputeLifecycleState;
  observedState: ComputeLifecycleState;
  leases: ComputeLease[];
  capacity: {
    min: number;
    max: number;
    current: number | 'unknown';
  };
  cost: {
    currency: string;
    amount: number | 'unknown';
  };
  findings: ComputeFinding[];
  fallback: ComputeFallback | null;
  updatedAt: string;
};

/** Secure, finite defaults from ADR 0014 R10. */
export type ComputePolicy = {
  /** Null disables remote compute until a mode is explicitly selected. */
  mode: ComputeMode | null;
  provisionOptIn: boolean;
  minCapacity: number;
  maxCapacity: number;
  budget: {
    amount: number;
    currency: string;
    period: 'hour' | 'day' | 'month';
  };
  allowLocalFallback: boolean;
  publicIngress: boolean;
  encryptedTransport: boolean;
  encryptedStorage: boolean;
};

export const DEFAULT_COMPUTE_POLICY: Readonly<ComputePolicy> = Object.freeze({
  mode: null,
  provisionOptIn: false,
  minCapacity: 0,
  maxCapacity: 1,
  budget: Object.freeze({ amount: 0, currency: 'EUR', period: 'month' as const }),
  allowLocalFallback: false,
  publicIngress: false,
  encryptedTransport: true,
  encryptedStorage: true,
});

/** One public CLI option. `value` names the metavariable, if any. */
export type ComputeCliOption = {
  name: string;
  value?: string;
  required?: boolean;
  description: string;
};

/** The public CLI surface consumed by the local control plane. The status
 * command is always machine-readable; text rendering is a presentation choice. */
export const COMPUTE_CLI_SCHEMA = {
  schemaVersion: COMPUTE_SCHEMA_VERSION,
  command: 'junior compute',
  output: {
    format: 'compute-status',
    schemaVersion: COMPUTE_SCHEMA_VERSION,
  },
  exitCodes: {
    ok: 0,
    unsafe: 1,
    usage: 2,
    error: 3,
  },
  commands: [
    {
      name: 'init',
      summary: 'Validate and record an explicit local compute policy.',
      mutates: true,
      options: [
        { name: '--config', value: 'path', description: 'Policy file to validate and record.' },
        { name: '--mode', value: 'mode', description: 'Explicit adopt, managed-existing or provision mode.' },
        { name: '--dry-run', description: 'Validate without writing the policy.' },
        { name: '--json', description: 'Emit the machine-readable result.' },
      ],
    },
    {
      name: 'doctor',
      summary: 'Report adapter capabilities, policy and ownership readiness.',
      mutates: false,
      options: [
        { name: '--json', description: 'Emit the machine-readable result.' },
      ],
    },
    {
      name: 'status',
      summary: 'Print the machine-readable status for a managed resource.',
      mutates: false,
      options: [
        { name: '--resource', value: 'id', required: true, description: 'Provider-neutral resource id.' },
        { name: '--json', description: 'Emit the versioned compute-status document.' },
      ],
    },
    {
      name: 'reconcile',
      summary: 'Compare desired, observed and owned state without forcing it.',
      mutates: false,
      options: [
        { name: '--resource', value: 'id', description: 'Limit reconciliation to one resource.' },
        { name: '--dry-run', description: 'Report findings without any mutation.' },
        { name: '--json', description: 'Emit the machine-readable result.' },
      ],
    },
    {
      name: 'stop',
      summary: 'Release a lease or stop a resource within policy authority.',
      mutates: true,
      options: [
        { name: '--resource', value: 'id', required: true, description: 'Provider-neutral resource id.' },
        { name: '--lease', value: 'id', description: 'Release only this lease before stopping.' },
        { name: '--json', description: 'Emit the machine-readable result.' },
      ],
    },
  ],
} as const satisfies {
  schemaVersion: typeof COMPUTE_SCHEMA_VERSION;
  command: string;
  output: { format: string; schemaVersion: typeof COMPUTE_SCHEMA_VERSION };
  exitCodes: { ok: number; unsafe: number; usage: number; error: number };
  commands: ReadonlyArray<{
    name: string;
    summary: string;
    mutates: boolean;
    options: ReadonlyArray<ComputeCliOption>;
  }>;
};

export type ComputeCommand = typeof COMPUTE_CLI_SCHEMA.commands[number]['name'];

/** Machine-readable status invariant catalogue. Validator issues reuse these
 * stable ids so callers can key on them without parsing prose. */
export const COMPUTE_STATUS_INVARIANTS = [
  { id: 'status.object', severity: 'invalid', description: 'Status is an object.' },
  { id: 'status.schema-version', severity: 'invalid', description: 'Status uses the supported schema version.' },
  { id: 'status.provider', severity: 'invalid', description: 'Provider is a non-empty string.' },
  { id: 'status.adapter-version', severity: 'invalid', description: 'Adapter version is a non-empty string.' },
  { id: 'status.mode', severity: 'invalid', description: 'Mode is adopt, managed-existing or provision.' },
  { id: 'status.resource', severity: 'invalid', description: 'Resource identity has an id, a positive generation and string tags.' },
  { id: 'status.timestamps', severity: 'invalid', description: 'Status and ownership timestamps are valid ISO times.' },
  { id: 'state.desired', severity: 'invalid', description: 'Desired state is a documented lifecycle state.' },
  { id: 'state.observed', severity: 'invalid', description: 'Observed state is a documented lifecycle state.' },
  { id: 'ownership.record', severity: 'unsafe', description: 'Ownership is verified and complete before work or mutation.' },
  { id: 'ownership.provider-match', severity: 'unsafe', description: 'Ownership provider matches the observed provider.' },
  { id: 'ownership.account', severity: 'unsafe', description: 'Ownership account/project is recorded.' },
  { id: 'ownership.resource-match', severity: 'unsafe', description: 'Ownership resource id matches the observed resource.' },
  { id: 'ownership.mode-match', severity: 'unsafe', description: 'Ownership mode matches the active mode.' },
  { id: 'ownership.owner', severity: 'unsafe', description: 'Ownership names the owning party.' },
  { id: 'ownership.creator', severity: 'unsafe', description: 'Ownership records whether Junior or an external party created the resource.' },
  { id: 'ownership.generation-match', severity: 'unsafe', description: 'Ownership generation matches the observed generation.' },
  { id: 'ownership.tags-match', severity: 'unsafe', description: 'Ownership tags match the observed tags.' },
  { id: 'ownership.evidence', severity: 'unsafe', description: 'Ownership has creation evidence and a recorded time.' },
  { id: 'lease.object', severity: 'invalid', description: 'Every lease is an object with the required fields.' },
  { id: 'lease.id', severity: 'invalid', description: 'Lease id and holder are non-empty strings.' },
  { id: 'lease.resource-match', severity: 'unsafe', description: 'Lease names the observed resource.' },
  { id: 'lease.generation-match', severity: 'unsafe', description: 'Lease names the observed resource generation.' },
  { id: 'lease.fencing', severity: 'invalid', description: 'Fencing token is a positive integer.' },
  { id: 'lease.window', severity: 'invalid', description: 'Issue, heartbeat and expiry times form a valid lease window.' },
  { id: 'lease.expired', severity: 'unsafe', description: 'An expired lease is reported and cannot authorize work.' },
  { id: 'lease.conflict', severity: 'unsafe', description: 'At most one active lease may use a resource generation.' },
  { id: 'lease.observed-active', severity: 'unsafe', description: 'Observed leased/active state has an active lease.' },
  { id: 'capacity.bounds', severity: 'invalid', description: 'Capacity is zero-minimum by default and bounded by a finite maximum.' },
  { id: 'capacity.current', severity: 'invalid', description: 'Current capacity is a nonnegative integer or unknown.' },
  { id: 'capacity.scale-to-zero', severity: 'unsafe', description: 'Zero capacity is only reported with no lease or queued work.' },
  { id: 'cost.amount', severity: 'invalid', description: 'Observed cost is nonnegative or explicitly unknown.' },
  { id: 'cost.currency', severity: 'invalid', description: 'Known cost names a currency.' },
  { id: 'findings.object', severity: 'invalid', description: 'Findings are well-formed records.' },
  { id: 'findings.blocking', severity: 'unsafe', description: 'A blocking reconciliation finding makes status unsafe.' },
  { id: 'fallback.reason', severity: 'invalid', description: 'Any local fallback records a reason and time.' },
] as const;

export type ComputeIssueSeverity = 'invalid' | 'unsafe';
export type ComputeIssue = {
  code: string;
  severity: ComputeIssueSeverity;
  path: string;
  message: string;
};

export type ComputeInspection = {
  /** The document has the required shape and vocabulary. */
  valid: boolean;
  /** No ownership, lease, capacity or cost invariant blocks work or mutation. */
  safe: boolean;
  issues: ComputeIssue[];
};

/** Published JSON-Schema-shaped status contract plus Junior's invariant ids. */
export const COMPUTE_STATUS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://junior.dev/schemas/compute-status-v1.json',
  title: 'Junior remote compute status',
  schemaVersion: COMPUTE_SCHEMA_VERSION,
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'provider',
    'adapterVersion',
    'mode',
    'resource',
    'ownership',
    'desiredState',
    'observedState',
    'leases',
    'capacity',
    'cost',
    'findings',
    'fallback',
    'updatedAt',
  ],
  properties: {
    schemaVersion: { const: COMPUTE_SCHEMA_VERSION },
    provider: { type: 'string', minLength: 1 },
    adapterVersion: { type: 'string', minLength: 1 },
    mode: { enum: COMPUTE_MODES },
    providerIdentity: {
      type: 'object',
      required: ['status', 'provider', 'account'],
      properties: {
        status: { enum: COMPUTE_PROVIDER_IDENTITY_STATUSES },
        provider: { type: 'string', minLength: 1 },
        account: { type: 'string', minLength: 1 },
      },
    },
    resource: {
      type: 'object',
      required: ['id', 'generation', 'tags'],
      properties: {
        id: { type: 'string', minLength: 1 },
        generation: { type: 'integer', minimum: 1 },
        tags: { type: 'object', additionalProperties: { type: 'string' } },
      },
    },
    ownership: {
      type: 'object',
      required: ['status'],
      properties: {
        status: { enum: COMPUTE_OWNERSHIP_STATUSES },
      },
    },
    desiredState: { enum: COMPUTE_LIFECYCLE_STATES },
    observedState: { enum: COMPUTE_LIFECYCLE_STATES },
    leases: { type: 'array' },
    capacity: {
      type: 'object',
      required: ['min', 'max', 'current'],
      properties: {
        min: { type: 'integer', minimum: 0 },
        max: { type: 'integer', minimum: 1 },
        current: { oneOf: [{ type: 'integer', minimum: 0 }, { const: 'unknown' }] },
      },
    },
    cost: {
      type: 'object',
      required: ['currency', 'amount'],
      properties: {
        currency: { type: 'string', minLength: 1 },
        amount: { oneOf: [{ type: 'number', minimum: 0 }, { const: 'unknown' }] },
      },
    },
    findings: { type: 'array' },
    fallback: { oneOf: [{ type: 'null' }, { type: 'object' }] },
    updatedAt: { type: 'string', minLength: 1 },
  },
  'x-status-invariants': COMPUTE_STATUS_INVARIANTS.map((invariant) => invariant.id),
} as const;

const ISSUE_SEVERITY = new Map<string, ComputeIssueSeverity>(
  COMPUTE_STATUS_INVARIANTS.map(
    (invariant): [string, ComputeIssueSeverity] => [invariant.id, invariant.severity],
  ),
);

function add(
  issues: ComputeIssue[],
  code: string,
  path: string,
  message: string,
): void {
  issues.push({ code, severity: ISSUE_SEVERITY.get(code) ?? 'invalid', path, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

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

function resolveEpoch(value: string | number | undefined): number {
  if (value === undefined) return Date.now();
  return typeof value === 'number' ? value : Date.parse(value);
}

function sameTags(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) =>
    key === rightKeys[index]
    && typeof left[key] === 'string'
    && left[key] === right[key]);
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

// ---------------------------------------------------------------------------
// Local control-plane foundation.
//
// The pieces below keep policy, lease state, capability advertising and
// operation authorization local and deterministic. They never talk to a
// provider: a caller validates a policy before writing it, persists the
// returned lease state as ordinary JSON, and asks the same pure domain helpers
// whether an operation is authorized.
// ---------------------------------------------------------------------------

export const COMPUTE_POLICY_INVARIANTS = [
  { id: 'policy.object', severity: 'invalid', description: 'Policy is an object.' },
  { id: 'policy.mode', severity: 'invalid', description: 'Policy mode is null or a documented ownership mode.' },
  { id: 'policy.flags', severity: 'invalid', description: 'Policy switches are booleans.' },
  { id: 'policy.capacity', severity: 'invalid', description: 'Capacity bounds are finite, ordered and nonnegative.' },
  { id: 'policy.budget', severity: 'invalid', description: 'Budget amount, currency and period are finite and documented.' },
  { id: 'policy.provision-opt-in', severity: 'unsafe', description: 'Provision mode requires explicit opt-in.' },
  { id: 'policy.encryption', severity: 'unsafe', description: 'Remote modes require encrypted transport and storage.' },
  { id: 'policy.public-ingress', severity: 'unsafe', description: 'Public ingress requires encrypted transport.' },
] as const;

export type ComputePolicyIssueSeverity = 'invalid' | 'unsafe';
export type ComputePolicyIssue = {
  code: string;
  severity: ComputePolicyIssueSeverity;
  path: string;
  message: string;
};

export type ComputePolicyInspection = {
  valid: boolean;
  safe: boolean;
  issues: ComputePolicyIssue[];
};

const POLICY_SEVERITY = new Map<string, ComputePolicyIssueSeverity>(
  COMPUTE_POLICY_INVARIANTS.map(
    (invariant): [string, ComputePolicyIssueSeverity] => [invariant.id, invariant.severity],
  ),
);

function addPolicyIssue(
  issues: ComputePolicyIssue[],
  code: string,
  path: string,
  message: string,
): void {
  issues.push({ code, severity: POLICY_SEVERITY.get(code) ?? 'invalid', path, message });
}

/** Validate a policy without touching disk or a provider. A policy can be a
 * well-formed but unsafe document (for example provision without opt-in);
 * `safe` is the gate a mutating command must pass. */
export function inspectComputePolicy(input: unknown): ComputePolicyInspection {
  const issues: ComputePolicyIssue[] = [];
  if (!isRecord(input)) {
    addPolicyIssue(issues, 'policy.object', '', 'policy must be an object');
    return { valid: false, safe: false, issues };
  }

  const mode = input.mode;
  if (mode !== null && !COMPUTE_MODES.includes(mode as ComputeMode)) {
    addPolicyIssue(issues, 'policy.mode', 'mode', 'mode must be null, adopt, managed-existing or provision');
  }

  const flags = [
    'provisionOptIn',
    'allowLocalFallback',
    'publicIngress',
    'encryptedTransport',
    'encryptedStorage',
  ] as const;
  for (const flag of flags) {
    if (typeof input[flag] !== 'boolean') {
      addPolicyIssue(issues, 'policy.flags', flag, `${flag} must be a boolean`);
    }
  }

  const min = input.minCapacity;
  const max = input.maxCapacity;
  if (!isNonNegativeInteger(min) || !isPositiveInteger(max) || min > max) {
    addPolicyIssue(
      issues,
      'policy.capacity',
      'capacity',
      'minCapacity must be zero or greater and no larger than a finite maxCapacity',
    );
  }

  const budget = input.budget;
  if (!isRecord(budget)
    || !(typeof budget.amount === 'number' && Number.isFinite(budget.amount) && budget.amount >= 0)
    || !isNonEmptyString(budget.currency)
    || !['hour', 'day', 'month'].includes(String(budget.period))) {
    addPolicyIssue(
      issues,
      'policy.budget',
      'budget',
      'budget needs a finite nonnegative amount, currency and hour/day/month period',
    );
  }

  if (mode === 'provision' && input.provisionOptIn !== true) {
    addPolicyIssue(
      issues,
      'policy.provision-opt-in',
      'provisionOptIn',
      'provision mode requires explicit opt-in',
    );
  }
  if (mode !== null && (input.encryptedTransport !== true || input.encryptedStorage !== true)) {
    addPolicyIssue(
      issues,
      'policy.encryption',
      'encryption',
      'a remote mode requires encrypted transport and storage',
    );
  }
  if (input.publicIngress === true && input.encryptedTransport !== true) {
    addPolicyIssue(
      issues,
      'policy.public-ingress',
      'publicIngress',
      'public ingress requires encrypted transport',
    );
  }

  const valid = !issues.some((issue) => issue.severity === 'invalid');
  const safe = valid && !issues.some((issue) => issue.severity === 'unsafe');
  return { valid, safe, issues };
}

/** Assert that a policy is valid and safe enough to authorize a mutation. */
export function assertComputePolicy(input: unknown): ComputePolicy {
  const result = inspectComputePolicy(input);
  if (!result.safe) {
    const detail = result.issues.map((issue) => `${issue.path || 'policy'}: ${issue.message}`).join('; ');
    throw new TypeError(`unsafe compute policy: ${detail}`);
  }
  return input as ComputePolicy;
}

// ---------------------------------------------------------------------------
// Explicit local fallback (ADR 0014 R9).
//
// Fallback is a policy decision with a recorded reason, never a silent retry
// and never a remote mutation. When the policy disables it the caller fails
// with an actionable reason instead of quietly changing where work runs.
// ---------------------------------------------------------------------------

export type ComputeFallbackDecision = {
  allowed: boolean;
  fallback: ComputeFallback | null;
  code: 'fallback.allowed' | 'fallback.disabled' | 'fallback.invalid';
  message: string;
  issues: ComputeIssue[];
};

/** Decide whether local execution may replace unavailable remote compute. */
export function decideComputeFallback(input: {
  reason: unknown;
  occurredAt: unknown;
  policy?: ComputePolicy | null;
  allowLocalFallback?: unknown;
}): ComputeFallbackDecision {
  const issues: ComputeIssue[] = [];
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason === '') {
    issues.push({
      code: 'fallback.reason',
      severity: 'invalid',
      path: 'reason',
      message: 'a local fallback must record why remote execution was not used',
    });
  }
  if (!isTimestamp(input.occurredAt)) {
    issues.push({
      code: 'fallback.time',
      severity: 'invalid',
      path: 'occurredAt',
      message: 'a local fallback must record when it occurred',
    });
  }
  if (issues.length > 0) {
    return {
      allowed: false,
      fallback: null,
      code: 'fallback.invalid',
      message: 'the local fallback record is incomplete; no fallback is reported',
      issues,
    };
  }

  const enabled = input.policy != null
    ? input.policy.allowLocalFallback === true
    : input.allowLocalFallback === true;
  if (!enabled) {
    return {
      allowed: false,
      fallback: null,
      code: 'fallback.disabled',
      message: 'local fallback is disabled; enable allowLocalFallback in the project policy or fail the run',
      issues: [{
        code: 'fallback.disabled',
        severity: 'unsafe',
        path: 'allowLocalFallback',
        message: 'project policy does not allow local execution',
      }],
    };
  }

  return {
    allowed: true,
    fallback: { reason, occurredAt: input.occurredAt as string },
    code: 'fallback.allowed',
    message: 'local fallback is allowed and records its reason',
    issues: [],
  };
}

export type ComputeCapabilityInspection = {
  valid: boolean;
  ready: boolean;
  operations: ComputeCapability[];
  unsupported: ComputeOperation[];
  unknown: ComputeOperation[];
  issues: ComputeIssue[];
};

/** Compare explicit adapter advertisements with the operations a caller
 * requires. A missing operation is `unsupported`, never an implicit fallback. */
export function inspectComputeCapabilities(
  input: unknown,
  required: readonly ComputeOperation[] = COMPUTE_OPERATIONS,
): ComputeCapabilityInspection {
  const issues: ComputeIssue[] = [];
  const operations: ComputeCapability[] = [];
  if (!Array.isArray(input)) {
    add(issues, 'capability.object', '', 'capabilities must be an array');
    return {
      valid: false,
      ready: false,
      operations,
      unsupported: [...required],
      unknown: [],
      issues,
    };
  }

  const seen = new Set<ComputeOperation>();
  for (const [index, value] of input.entries()) {
    const path = `capabilities[${index}]`;
    if (!isRecord(value)) {
      add(issues, 'capability.object', path, 'capability must be an object');
      continue;
    }
    if (!COMPUTE_OPERATIONS.includes(value.operation as ComputeOperation)) {
      add(issues, 'capability.operation', `${path}.operation`, 'capability operation is not documented');
      continue;
    }
    if (!COMPUTE_CAPABILITY_STATUSES.includes(value.status as ComputeCapabilityStatus)) {
      add(issues, 'capability.status', `${path}.status`, 'capability status must be supported, unsupported or unknown');
      continue;
    }
    if (value.reason !== undefined && typeof value.reason !== 'string') {
      add(issues, 'capability.status', `${path}.reason`, 'capability reason must be a string');
      continue;
    }
    const operation = value.operation as ComputeOperation;
    if (seen.has(operation)) {
      add(issues, 'capability.duplicate', path, 'capability operation is advertised more than once');
      continue;
    }
    seen.add(operation);
    operations.push({
      operation,
      status: value.status as ComputeCapabilityStatus,
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    });
  }

  const requiredOperations = [...new Set(required)];
  for (const operation of requiredOperations) {
    if (!COMPUTE_OPERATIONS.includes(operation)) {
      add(issues, 'capability.required', 'required', `required operation ${String(operation)} is not documented`);
    }
  }

  const unsupported = requiredOperations.filter(
    (operation) => !seen.has(operation) || operations.find((entry) => entry.operation === operation)?.status === 'unsupported',
  );
  const unknown = requiredOperations.filter(
    (operation) => operations.find((entry) => entry.operation === operation)?.status === 'unknown',
  );
  for (const operation of unsupported) {
    add(issues, 'capability.unsupported', operation, `adapter does not support ${operation}`);
  }
  for (const operation of unknown) {
    add(issues, 'capability.unknown', operation, `adapter could not determine support for ${operation}`);
  }

  const valid = !issues.some((issue) => issue.severity === 'invalid');
  return {
    valid,
    ready: valid && unsupported.length === 0 && unknown.length === 0,
    operations,
    unsupported,
    unknown,
    issues,
  };
}

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

function leaseIsClosed(lease: ComputeLease): boolean {
  return isTimestamp(lease.releasedAt);
}

function leaseIsActive(lease: ComputeLease, now: number): boolean {
  return !leaseIsClosed(lease) && Date.parse(lease.expiresAt) > now;
}

function leaseIsExpired(lease: ComputeLease, now: number): boolean {
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

const COMPUTE_MUTATING_OPERATIONS: readonly ComputeOperation[] = [
  'create',
  'start',
  'stop',
  'resize',
  'destroy',
  'tag',
];

export type ComputeOperationAuthorization = {
  allowed: boolean;
  operation: ComputeOperation;
  code: string;
  message: string;
  issues: ComputeIssue[];
};

function operationDecision(
  operation: ComputeOperation,
  allowed: boolean,
  code: string,
  message: string,
  issues: ComputeIssue[] = [],
): ComputeOperationAuthorization {
  return { allowed, operation, code, message, issues };
}

/**
 * Authorize one provider-neutral operation against the local policy, ownership
 * record, mode ceiling and active lease. This is the last local gate before an
 * adapter call; an unsafe or uncertain resource never reaches the adapter.
 */
export function authorizeComputeOperation(
  status: ComputeStatus,
  input: {
    operation: ComputeOperation;
    policy?: ComputePolicy;
    leaseId?: string;
    fencingToken?: number;
    now?: string | number;
  },
): ComputeOperationAuthorization {
  const operation = input.operation;
  if (!COMPUTE_OPERATIONS.includes(operation)) {
    return operationDecision(operation, false, 'operation.unknown', 'operation is not documented');
  }
  const inspection = inspectComputeStatus(status, { now: input.now });
  if (!inspection.valid) {
    return operationDecision(operation, false, 'status.invalid', 'status document is invalid', inspection.issues);
  }

  if (input.policy !== undefined) {
    const policy = inspectComputePolicy(input.policy);
    if (!policy.safe) {
      const issues = policy.issues.map((issue) => ({
        code: issue.code,
        severity: 'unsafe' as const,
        path: issue.path,
        message: issue.message,
      }));
      return operationDecision(operation, false, 'policy.unsafe', 'policy is invalid or unsafe', issues);
    }
    if (input.policy.mode === null || input.policy.mode !== status.mode) {
      return operationDecision(operation, false, 'policy.mode', 'policy does not authorize this resource mode');
    }
    if (!modeAllowsOperation(input.policy.mode, operation)) {
      return operationDecision(operation, false, 'operation.mode', 'policy mode does not allow this operation');
    }
  }

  if (!modeAllowsOperation(status.mode, operation)) {
    return operationDecision(operation, false, 'operation.mode', 'resource mode does not allow this operation');
  }

  if (operation === 'inspect') {
    return operationDecision(operation, true, 'allowed', 'inspection is always available');
  }
  if (operation === 'reconcile') {
    return operationDecision(operation, true, 'allowed', 'reconciliation is read-only and reports uncertainty');
  }

  if (!inspection.safe) {
    return operationDecision(operation, false, 'ownership.unsafe', 'ownership or resource state is unsafe', inspection.issues);
  }
  if (status.ownership.status !== 'verified') {
    return operationDecision(operation, false, 'ownership.record', 'ownership is not verified');
  }

  const now = resolveEpoch(input.now);
  const activeLeases = status.leases.filter((lease) => leaseIsActive(lease, now));

  if (operation === 'destroy') {
    if (activeLeases.length > 0) {
      return operationDecision(operation, false, 'operation.lease-active', 'destroy requires a quiescent lease');
    }
    if (status.ownership.creator !== 'junior') {
      return operationDecision(operation, false, 'operation.creator', 'only a junior-created resource may be destroyed');
    }
    return operationDecision(operation, true, 'allowed', 'ownership and generation authorize destroy');
  }

  if (operation === 'create') {
    if (activeLeases.length > 0) {
      return operationDecision(operation, false, 'operation.lease-active', 'create requires a quiescent resource generation');
    }
    if (status.ownership.creator !== 'junior') {
      return operationDecision(operation, false, 'operation.creator', 'only a junior-created resource may be created');
    }
    return operationDecision(operation, true, 'allowed', 'policy mode authorizes creation');
  }

  if (COMPUTE_MUTATING_OPERATIONS.includes(operation)) {
    if (activeLeases.length === 0) {
      return operationDecision(operation, false, 'lease.required', 'a lifecycle mutation requires an active lease');
    }
    const lease = input.leaseId === undefined && input.fencingToken === undefined
      ? activeLeases[0]
      : activeLeases.find((entry) =>
        entry.id === input.leaseId && entry.fencingToken === input.fencingToken);
    if (!lease) {
      return operationDecision(operation, false, 'lease.fencing', 'lease id or fencing token does not match an active lease');
    }
    return operationDecision(operation, true, 'allowed', 'lease and ownership authorize the mutation');
  }

  return operationDecision(operation, true, 'allowed', 'operation is authorized');
}

// ---------------------------------------------------------------------------
// Reconciliation and authority-checked stop/release.
//
// Reconciliation is a pure comparison: it never changes the recorded status,
// the lease history or a provider resource. Repeating it with the same
// observation produces the same findings. Stop and lease release are expressed
// as local decisions; only release may change the durable lease state, and only
// after ownership and fencing checks succeed.
// ---------------------------------------------------------------------------

export type ComputeReconciliation = {
  schemaVersion: typeof COMPUTE_SCHEMA_VERSION;
  operation: 'reconcile';
  provider: string;
  adapterVersion: string;
  mode: ComputeMode;
  resourceId: string;
  resourceGeneration: number;
  ownership: ComputeOwnershipStatus;
  desiredState: ComputeLifecycleState;
  observedState: ComputeLifecycleState;
  valid: boolean;
  safe: boolean;
  mutated: false;
  requiresOperator: boolean;
  findings: ComputeFinding[];
  issues: ComputeIssue[];
};

function finding(
  code: string,
  severity: ComputeFindingSeverity,
  message: string,
  evidence?: string,
): ComputeFinding {
  return { code, severity, message, ...(evidence === undefined ? {} : { evidence }) };
}

function issueFinding(issue: ComputeIssue): ComputeFinding {
  if (issue.severity === 'invalid') {
    return finding('reconcile.status-invalid', 'blocking', issue.message, issue.path);
  }
  if (issue.code.startsWith('ownership.')) {
    return finding('reconcile.ownership-uncertain', 'blocking', issue.message, issue.path);
  }
  if (issue.code.startsWith('lease.') || issue.code.startsWith('state.')) {
    return finding('reconcile.lease-uncertain', 'blocking', issue.message, issue.path);
  }
  return finding('reconcile.unsafe', 'blocking', issue.message, issue.path);
}

/**
 * Compare desired state, observed state and ownership without forcing either
 * side. The result is deterministic for one observation and never mutates the
 * supplied status. Uncertain ownership is reported as unsafe; drift and lease
 * anomalies become findings with stable codes.
 */
export function reconcileComputeStatus(
  input: ComputeStatus,
  opts: { now?: string | number } = {},
): ComputeReconciliation {
  const now = resolveEpoch(opts.now);
  const inspection = inspectComputeStatus(input, { now });
  const findings: ComputeFinding[] = Array.isArray(input.findings)
    ? input.findings.map((entry) => ({ ...entry }))
    : [];

  const seen = new Set(findings.map((entry) => `${entry.code}:${entry.evidence ?? ''}`));
  const append = (entry: ComputeFinding): void => {
    const key = `${entry.code}:${entry.evidence ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push(entry);
    }
  };

  for (const issue of inspection.issues) {
    append(issueFinding(issue));
  }

  if (input.desiredState !== input.observedState) {
    append(finding(
      'reconcile.state-drift',
      'warning',
      `desired state ${input.desiredState} differs from observed state ${input.observedState}`,
      `desired=${input.desiredState};observed=${input.observedState}`,
    ));
  }

  const leases = Array.isArray(input.leases) ? input.leases : [];
  const expired = leases.filter((lease) => {
    if (leaseIsClosed(lease)) return false;
    const expires = Date.parse(String(lease.expiresAt));
    return Number.isFinite(expires) && expires <= now;
  });
  if (expired.length > 0) {
    append(finding(
      'reconcile.lease-expired',
      'warning',
      `${expired.length} lease(s) have expired and await reclaim`,
      expired.map((lease) => lease.id).sort().join(','),
    ));
  }

  const active = leases.filter((lease) => leaseIsActive(lease, now));
  if (active.length > 0 && input.observedState !== 'leased' && input.observedState !== 'active') {
    append(finding(
      'reconcile.lease-observed-idle',
      'warning',
      'an active lease exists but the observed state is not leased or active',
      active.map((lease) => lease.id).sort().join(','),
    ));
  }

  if (input.cost && input.cost.amount === 'unknown') {
    append(finding('reconcile.cost-unknown', 'info', 'observed cost is explicitly unknown'));
  }

  const safe = inspection.safe;
  return {
    schemaVersion: COMPUTE_SCHEMA_VERSION,
    operation: 'reconcile',
    provider: input.provider,
    adapterVersion: input.adapterVersion,
    mode: input.mode,
    resourceId: input.resource.id,
    resourceGeneration: input.resource.generation,
    ownership: input.ownership.status,
    desiredState: input.desiredState,
    observedState: input.observedState,
    valid: inspection.valid,
    safe,
    mutated: false,
    requiresOperator: !safe,
    findings,
    issues: inspection.issues,
  };
}

/** Alias that names the resource being reconciled rather than its status. */
export const reconcileComputeResource = reconcileComputeStatus;

export type ComputeStopResult = {
  schemaVersion: typeof COMPUTE_SCHEMA_VERSION;
  operation: 'stop';
  resourceId: string;
  resourceGeneration: number;
  valid: boolean;
  safe: boolean;
  allowed: boolean;
  mutated: boolean;
  code: string;
  message: string;
  authorization: ComputeOperationAuthorization;
  reconciliation: ComputeReconciliation;
  findings: ComputeFinding[];
  issues: ComputeIssue[];
  leaseState?: ComputeLeaseState;
  lease?: ComputeLease;
};

/**
 * Decide whether a stop may be attempted and optionally release the matching
 * local lease when the caller supplies lease state. Ownership, policy mode and
 * fencing are checked before anything changes. An unsafe or uncertain resource
 * returns the original lease state with `mutated: false`.
 */
export function stopComputeResource(
  status: ComputeStatus,
  input: {
    policy?: ComputePolicy;
    leaseId?: string;
    fencingToken?: number;
    now?: string | number;
    leaseState?: ComputeLeaseState;
  } = {},
): ComputeStopResult {
  const now = resolveEpoch(input.now);
  const reconciliation = reconcileComputeStatus(status, { now });
  const authorization = authorizeComputeOperation(status, {
    operation: 'stop',
    ...(input.policy === undefined ? {} : { policy: input.policy }),
    ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
    ...(input.fencingToken === undefined ? {} : { fencingToken: input.fencingToken }),
    now,
  });

  const base = {
    schemaVersion: COMPUTE_SCHEMA_VERSION,
    operation: 'stop' as const,
    resourceId: status.resource.id,
    resourceGeneration: status.resource.generation,
    valid: reconciliation.valid,
    safe: reconciliation.safe,
    allowed: authorization.allowed,
    mutated: false,
    code: authorization.code,
    message: authorization.message,
    authorization,
    reconciliation,
    findings: reconciliation.findings,
    issues: authorization.issues.length > 0 ? authorization.issues : reconciliation.issues,
    ...(input.leaseState === undefined ? {} : { leaseState: input.leaseState }),
  };

  if (!authorization.allowed || input.leaseState === undefined) {
    return base;
  }

  const matching = status.leases.find((lease) =>
    leaseIsActive(lease, now)
    && (input.leaseId === undefined || lease.id === input.leaseId)
    && (input.fencingToken === undefined || lease.fencingToken === input.fencingToken));
  if (!matching) return base;

  const released = releaseComputeLeaseWithAuthority(status, input.leaseState, {
    leaseId: matching.id,
    holder: matching.holder,
    fencingToken: matching.fencingToken,
    now: new Date(now).toISOString(),
  });
  if (!released.ok) {
    return { ...base, code: released.code, message: released.message, issues: released.issues };
  }
  return {
    ...base,
    mutated: true,
    code: 'stop.authorized',
    message: 'stop is authorized and the matching local lease is released',
    leaseState: released.state,
    lease: released.lease,
  };
}

/** Alias for callers that name the operation rather than the resource. */
export const stopCompute = stopComputeResource;

export type ComputeAuthorizedLeaseRelease =
  | {
    ok: true;
    mutated: true;
    safe: boolean;
    state: ComputeLeaseState;
    lease: ComputeLease;
    code: string;
    message: string;
    issues: ComputeIssue[];
    findings: ComputeFinding[];
  }
  | {
    ok: false;
    mutated: false;
    safe: boolean;
    state: ComputeLeaseState;
    code: string;
    message: string;
    issues: ComputeIssue[];
    findings: ComputeFinding[];
  };

/**
 * Release one lease only after the ownership record and the lease fencing
 * checks pass. Uncertain ownership is unsafe and leaves the lease state
 * untouched; a stale holder or token is likewise rejected without mutation.
 */
export function releaseComputeLeaseWithAuthority(
  status: ComputeStatus,
  state: ComputeLeaseState,
  input: {
    leaseId: string;
    holder: string;
    fencingToken: number;
    now: string;
  },
): ComputeAuthorizedLeaseRelease {
  const now = Date.parse(input.now);
  const inspection = inspectComputeStatus(status, { now });
  if (!inspection.valid) {
    return {
      ok: false,
      mutated: false,
      safe: false,
      state,
      code: 'status.invalid',
      message: 'status document is invalid',
      issues: inspection.issues,
      findings: inspection.issues.map(issueFinding),
    };
  }
  if (!inspection.safe || status.ownership.status !== 'verified') {
    return {
      ok: false,
      mutated: false,
      safe: false,
      state,
      code: 'ownership.unsafe',
      message: 'ownership or resource state is unsafe; the lease is retained',
      issues: inspection.issues,
      findings: inspection.issues.map(issueFinding),
    };
  }
  if (state.resourceId !== status.resource.id
    || state.resourceGeneration !== status.resource.generation) {
    return {
      ok: false,
      mutated: false,
      safe: true,
      state,
      code: 'lease.generation-match',
      message: 'lease state does not describe the observed resource generation',
      issues: [{
        code: 'lease.generation-match',
        severity: 'unsafe',
        path: 'leaseState',
        message: 'lease state does not describe the observed resource generation',
      }],
      findings: [],
    };
  }

  const mutation = releaseComputeLease(state, input);
  if (!mutation.ok) {
    return {
      ok: false,
      mutated: false,
      safe: true,
      state: mutation.state,
      code: mutation.code,
      message: mutation.message,
      issues: [],
      findings: [],
    };
  }
  return {
    ok: true,
    mutated: true,
    safe: true,
    state: mutation.state,
    lease: mutation.lease as ComputeLease,
    code: 'lease.released',
    message: 'ownership and fencing authorize the release',
    issues: [],
    findings: [],
  };
}

// ---------------------------------------------------------------------------
// Leased job routing and scale-in guardrails.
//
// Scale-in is only safe after idle expiry and only when every activity signal
// is known to be quiescent. A busy signal, an active or unreclaimed lease,
// queued work, an unexpired minimum lifetime, or missing/over-limit disk
// evidence retains capacity rather than guessing.
// ---------------------------------------------------------------------------

export type ComputeScaleInEvidence = {
  capacity: {
    min: number;
    max: number;
    current: number | 'unknown';
  };
  /** Idle expiry start; must be a known timestamp. */
  idleSince: string | 'unknown';
  idleTimeoutMs: number;
  /** Any nonzero or unknown busy evidence retains capacity. */
  busy: boolean | number | 'unknown';
  leaseActive?: boolean | 'unknown';
  queuedWork?: number | 'unknown';
  diskUsedPercent?: number | 'unknown';
  diskLimitPercent?: number;
  /** Resource creation/lifetime start; unknown retains capacity. */
  startedAt?: string | 'unknown';
  minimumLifetimeMs?: number;
  now?: string | number;
};

export type ComputeScaleInDecision = {
  allowed: boolean;
  action: 'retain' | 'scale-in' | 'scale-to-zero';
  targetCapacity: number;
  code: string;
  message: string;
  reasons: string[];
};

/**
 * Decide whether an idle managed resource may scale in. Every guardrail fails
 * closed: unknown activity, lifetime or disk evidence retains capacity. A
 * nonzero minimum capacity is an explicit opt-in and scales in only to that
 * floor.
 */
export function evaluateComputeScaleIn(input: ComputeScaleInEvidence): ComputeScaleInDecision {
  const now = resolveEpoch(input.now);
  const current = input.capacity.current;
  const retain = (code: string, message: string, reasons: string[]): ComputeScaleInDecision => ({
    allowed: false,
    action: 'retain',
    targetCapacity: typeof current === 'number' ? current : 0,
    code,
    message,
    reasons,
  });

  if (typeof current !== 'number' || !Number.isInteger(current) || current < 0) {
    return retain('scale.capacity-unknown', 'current capacity is unknown; retain capacity', ['capacity']);
  }
  if (current === 0) {
    return {
      allowed: true,
      action: 'scale-to-zero',
      targetCapacity: 0,
      code: 'scale.zero',
      message: 'capacity is already zero',
      reasons: [],
    };
  }
  if (input.busy !== false && input.busy !== 0) {
    return retain('scale.busy', 'busy evidence prevents scale-in', ['busy']);
  }
  if (input.leaseActive !== false) {
    return retain('scale.lease-active', 'lease state is active or unknown; retain capacity', ['lease']);
  }
  if (input.queuedWork !== 0) {
    return retain('scale.queued-work', 'queued work is present or unknown; retain capacity', ['queuedWork']);
  }
  if (!isTimestamp(input.idleSince)
    || !(typeof input.idleTimeoutMs === 'number' && Number.isFinite(input.idleTimeoutMs) && input.idleTimeoutMs >= 0)) {
    return retain('scale.idle-unknown', 'idle expiry evidence is invalid or unknown; retain capacity', ['idle']);
  }
  if (now - Date.parse(input.idleSince) < input.idleTimeoutMs) {
    return retain('scale.idle-not-expired', 'idle expiry has not elapsed', ['idle']);
  }
  if (!isTimestamp(input.startedAt)
    || !(typeof input.minimumLifetimeMs === 'number'
      && Number.isFinite(input.minimumLifetimeMs)
      && input.minimumLifetimeMs >= 0)) {
    return retain('scale.lifetime-unknown', 'lifetime evidence is invalid or unknown; retain capacity', ['lifetime']);
  }
  if (now - Date.parse(input.startedAt) < input.minimumLifetimeMs) {
    return retain('scale.lifetime', 'minimum lifetime has not elapsed', ['lifetime']);
  }
  if (!(typeof input.diskUsedPercent === 'number' && Number.isFinite(input.diskUsedPercent))
    || !(typeof input.diskLimitPercent === 'number' && Number.isFinite(input.diskLimitPercent) && input.diskLimitPercent >= 0)) {
    return retain('scale.disk-unknown', 'disk evidence is invalid or unknown; retain capacity', ['disk']);
  }
  if (input.diskUsedPercent > input.diskLimitPercent) {
    return retain('scale.disk', 'disk usage exceeds the scale-in guardrail', ['disk']);
  }

  const targetCapacity = input.capacity.min > 0 ? input.capacity.min : 0;
  if (targetCapacity > 0) {
    return {
      allowed: true,
      action: 'scale-in',
      targetCapacity,
      code: 'scale.minimum',
      message: 'idle resource scales in to its explicit minimum capacity',
      reasons: [],
    };
  }
  return {
    allowed: true,
    action: 'scale-to-zero',
    targetCapacity: 0,
    code: 'scale.zero',
    message: 'idle resource scales to zero',
    reasons: [],
  };
}

/** Alias naming the downward direction rather than the operation. */
export const evaluateComputeScaleDown = evaluateComputeScaleIn;
