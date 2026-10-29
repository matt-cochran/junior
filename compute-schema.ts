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
export const COMPUTE_SCHEMA_VERSION = 1 as const;

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

export function add(
  issues: ComputeIssue[],
  code: string,
  path: string,
  message: string,
): void {
  issues.push({ code, severity: ISSUE_SEVERITY.get(code) ?? 'invalid', path, message });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function resolveEpoch(value: string | number | undefined): number {
  if (value === undefined) return Date.now();
  return typeof value === 'number' ? value : Date.parse(value);
}

export function sameTags(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) =>
    key === rightKeys[index]
    && typeof left[key] === 'string'
    && left[key] === right[key]);
}
