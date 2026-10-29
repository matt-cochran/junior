// ---------------------------------------------------------------------------
// Provider-neutral remote-compute contract.
//
// This module is the public domain boundary for issue #123. The implementation
// is split into cohesive modules behind this re-export facade (ADR 0016), so
// importers keep using compute.ts as the single entry point.
// ---------------------------------------------------------------------------

export {
  COMPUTE_CAPABILITY_STATUSES,
  COMPUTE_CLI_SCHEMA,
  COMPUTE_LIFECYCLE_STATES,
  COMPUTE_MODES,
  COMPUTE_MODE_OPERATIONS,
  COMPUTE_OPERATIONS,
  COMPUTE_OWNERSHIP_STATUSES,
  COMPUTE_PROVIDER_IDENTITY_STATUSES,
  COMPUTE_SCHEMA_VERSION,
  COMPUTE_STATUS_INVARIANTS,
  COMPUTE_STATUS_SCHEMA,
  DEFAULT_COMPUTE_POLICY,
} from './compute-schema.ts';
export type {
  ComputeCapability,
  ComputeCapabilityStatus,
  ComputeCliOption,
  ComputeCommand,
  ComputeFallback,
  ComputeFinding,
  ComputeFindingSeverity,
  ComputeInspection,
  ComputeIssue,
  ComputeIssueSeverity,
  ComputeLease,
  ComputeLifecycleState,
  ComputeMode,
  ComputeOperation,
  ComputeOwnershipRecord,
  ComputeOwnershipStatus,
  ComputePolicy,
  ComputeProviderIdentity,
  ComputeProviderIdentityStatus,
  ComputeResource,
  ComputeStatus,
} from './compute-schema.ts';

export {
  assertComputeStatus,
  assertVerifiedComputeProviderIdentity,
  inspectComputeProviderIdentity,
  inspectComputeStatus,
  modeAllowsOperation,
  verifyComputeProviderIdentity,
} from './compute-status.ts';
export type {
  ComputeProviderIdentityInspection,
  ComputeProviderIdentityVerification,
} from './compute-status.ts';

export {
  COMPUTE_POLICY_INVARIANTS,
  assertComputePolicy,
  decideComputeFallback,
  inspectComputeCapabilities,
  inspectComputePolicy,
} from './compute-policy.ts';
export type {
  ComputeCapabilityInspection,
  ComputeFallbackDecision,
  ComputePolicyInspection,
  ComputePolicyIssue,
  ComputePolicyIssueSeverity,
} from './compute-policy.ts';

export {
  COMPUTE_LEASE_STATE_VERSION,
  acquireComputeLease,
  createComputeLeaseState,
  heartbeatComputeLease,
  inspectComputeLeaseState,
  reclaimComputeLease,
  releaseComputeLease,
} from './compute-lease.ts';
export type {
  ComputeLeaseMutation,
  ComputeLeaseState,
  ComputeLeaseStateInspection,
} from './compute-lease.ts';

export {
  authorizeComputeOperation,
  reconcileComputeResource,
  reconcileComputeStatus,
  releaseComputeLeaseWithAuthority,
  stopCompute,
  stopComputeResource,
} from './compute-authority.ts';
export type {
  ComputeAuthorizedLeaseRelease,
  ComputeOperationAuthorization,
  ComputeReconciliation,
  ComputeStopResult,
} from './compute-authority.ts';

export {
  evaluateComputeScaleDown,
  evaluateComputeScaleIn,
} from './compute-scale.ts';
export type {
  ComputeScaleInDecision,
  ComputeScaleInEvidence,
} from './compute-scale.ts';
