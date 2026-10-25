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
    if (expires <= now) {
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
  validateLeases(input, resource, opts.now === undefined ? Date.now() : Date.parse(String(opts.now)), issues);

  const leases = Array.isArray(input.leases) ? input.leases : [];
  const now = opts.now === undefined ? Date.now() : Date.parse(String(opts.now));
  const activeLeaseCount = leases.filter((lease) => {
    if (!isRecord(lease)) return false;
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
