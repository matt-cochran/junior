import {
  COMPUTE_OPERATIONS,
  COMPUTE_SCHEMA_VERSION,
  resolveEpoch,
} from './compute-schema.ts';
import type {
  ComputeFinding,
  ComputeFindingSeverity,
  ComputeIssue,
  ComputeLease,
  ComputeLifecycleState,
  ComputeMode,
  ComputeOperation,
  ComputeOwnershipStatus,
  ComputePolicy,
  ComputeStatus,
} from './compute-schema.ts';
import type { ComputeLeaseState } from './compute-lease.ts';
import { inspectComputeStatus, modeAllowsOperation } from './compute-status.ts';
import { inspectComputePolicy } from './compute-policy.ts';
import {
  leaseIsActive,
  leaseIsClosed,
  releaseComputeLease,
} from './compute-lease.ts';

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
  if (mutation.ok === false) {
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
