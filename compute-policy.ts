import {
  COMPUTE_CAPABILITY_STATUSES,
  COMPUTE_MODES,
  COMPUTE_OPERATIONS,
  add,
  isNonEmptyString,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  isTimestamp,
} from './compute-schema.ts';
import type {
  ComputeCapability,
  ComputeCapabilityStatus,
  ComputeFallback,
  ComputeIssue,
  ComputeMode,
  ComputeOperation,
  ComputePolicy,
} from './compute-schema.ts';

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
