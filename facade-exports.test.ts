// ---------------------------------------------------------------------------
// Facade export guard for the large-file decomposition (ADR 0016).
//
// Each split file stays a facade that re-exports its previous API. These tests
// pin the runtime export names of every facade so a split that drops or adds a
// value export fails here. Type-only exports are erased at runtime; review them
// by hand (ADR 0016, R2).
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const exportsOf = async (path: string) => Object.keys(await import(path)).sort();

test('compute.ts keeps its runtime exports', async () => {
  assert.deepEqual(await exportsOf('./compute.ts'), [
    'COMPUTE_CAPABILITY_STATUSES',
    'COMPUTE_CLI_SCHEMA',
    'COMPUTE_LEASE_STATE_VERSION',
    'COMPUTE_LIFECYCLE_STATES',
    'COMPUTE_MODES',
    'COMPUTE_MODE_OPERATIONS',
    'COMPUTE_OPERATIONS',
    'COMPUTE_OWNERSHIP_STATUSES',
    'COMPUTE_POLICY_INVARIANTS',
    'COMPUTE_PROVIDER_IDENTITY_STATUSES',
    'COMPUTE_SCHEMA_VERSION',
    'COMPUTE_STATUS_INVARIANTS',
    'COMPUTE_STATUS_SCHEMA',
    'DEFAULT_COMPUTE_POLICY',
    'acquireComputeLease',
    'assertComputePolicy',
    'assertComputeStatus',
    'assertVerifiedComputeProviderIdentity',
    'authorizeComputeOperation',
    'createComputeLeaseState',
    'decideComputeFallback',
    'evaluateComputeScaleDown',
    'evaluateComputeScaleIn',
    'heartbeatComputeLease',
    'inspectComputeCapabilities',
    'inspectComputeLeaseState',
    'inspectComputePolicy',
    'inspectComputeProviderIdentity',
    'inspectComputeStatus',
    'modeAllowsOperation',
    'reclaimComputeLease',
    'reconcileComputeResource',
    'reconcileComputeStatus',
    'releaseComputeLease',
    'releaseComputeLeaseWithAuthority',
    'stopCompute',
    'stopComputeResource',
    'verifyComputeProviderIdentity'
  ]);
});

test('tools/tools.ts keeps its runtime exports', async () => {
  assert.deepEqual(await exportsOf('./tools/tools.ts'), [
    'HOP_SCHEMA_VERSION',
    'HopError',
    'TOOL_NAMES',
    'buildToolEnv',
    'callHop',
    'companionKeyEnv',
    'cpmModelEnv',
    'cpmReviewStatus',
    'crossmatrixUsesStore',
    'defaultManagedStatePath',
    'initHop',
    'inspectHop',
    'isReadTool',
    'loadHop',
    'main',
    'mcpCallSequence',
    'mcpCallTool',
    'probeToolVersion',
    'recordManagerAcceptance',
    'saveHop',
    'validateManifest'
  ]);
});

test('installer.ts keeps its runtime exports', async () => {
  assert.deepEqual(await exportsOf('./installer.ts'), [
    'APPROVED_HOSTS',
    'DEFAULT_INSTALL_ROOT',
    'DEFAULT_INSTALL_TIMEOUT_MS',
    'DEFAULT_MAX_ASSET_BYTES',
    'DEFAULT_MAX_CHECKSUM_BYTES',
    'DEFAULT_PROBE_TIMEOUT_MS',
    'DEFAULT_REDIRECT_LIMIT',
    'DEFAULT_REQUEST_TIMEOUT_MS',
    'INSTALL_STATE_SCHEMA_VERSION',
    'InstallerError',
    'SUPPORTED_MATRIX',
    'TOOL_NAMES',
    'TOOL_REPOS',
    'TRIZ_REPO',
    'binaryFileName',
    'checkToolUpdates',
    'defaultStatePath',
    'detectPlatform',
    'inspectIntegrations',
    'installTools',
    'main',
    'parseChecksums',
    'parseRelease',
    'parseReleaseManifest',
    'parseTarListing',
    'probeBinary',
    'readInstallState',
    'releaseAssetName',
    'resolveLatestRelease',
    'syncHopWithTools',
    'trizAssetName',
    'validateArchiveEntries',
    'writeInstallState'
  ]);
});

test('runtime.ts keeps its runtime exports', async () => {
  assert.deepEqual(await exportsOf('./runtime.ts'), [
    'DEFAULT_MAX_OUTPUT_BYTES',
    'EXECUTION_BOUNDS',
    'EXECUTION_DEFAULTS',
    'EXECUTION_FIELDS',
    'KILL_GRACE_MS',
    'REPORT_WORKFLOW_BUDGET',
    'RuntimeHeartbeat',
    'TOOL_TEXT_KEEP_BYTES',
    'TOOL_TEXT_LIMIT_BYTES',
    'ToolWatchdog',
    'compactEventLine',
    'defaultWorkflowBudget',
    'effectiveBudget',
    'executeCheck',
    'executeWorkerStreaming',
    'isReadLikeTool',
    'isSuccessStatus',
    'killChildGroup',
    'normalizeReadPath',
    'readPathMatches',
    'readToolPath',
    'resolveExecutionSettings',
    'sanitizeToolCallId',
    'spawnChildDetached',
    'splitLines',
    'validateExecutionSettings'
  ]);
});

test('compute-hetzner.ts keeps its runtime exports', async () => {
  assert.deepEqual(await exportsOf('./compute-hetzner.ts'), [
    'HETZNER_ADAPTER_VERSION',
    'HETZNER_PROVIDER',
    'HETZNER_SCHEMA_VERSION',
    'HETZNER_UNKNOWN',
    'createFakeHetznerProvider',
    'createHetznerAdapter',
    'discoverHetznerCapabilities',
    'inspectHetznerProviderIdentity',
    'normalizeHetznerCapabilities',
    'normalizeHetznerPlacement',
    'normalizeHetznerQuota',
    'verifyHetznerProviderIdentity'
  ]);
});

test('setup.ts keeps its runtime exports', async () => {
  assert.deepEqual(await exportsOf('./setup.ts'), [
    'DEFAULT_MODEL',
    'DEFAULT_PROVIDER',
    'DOCTOR_TIMEOUT_MS',
    'INSTALL_TIMEOUT_MS',
    'OPENROUTER_KEY_URL',
    'PACKAGED_SKILL_PATH',
    'PI_PACKAGE',
    'SKILL_FILENAME',
    'SKILL_MANIFEST_FILENAME',
    'SKILL_NAME',
    'SUPPORTED_NODE_MIN',
    'TESTED_PI_VERSION',
    'checkCredentials',
    'checkCredentialsOnline',
    'checkModel',
    'checkPi',
    'compareSemver',
    'detectSlowMount',
    'discoverInstalledPi',
    'doctor',
    'init',
    'inspectGateways',
    'inspectLitellm',
    'inspectSkill',
    'installSkill',
    'loadDefaults',
    'loadTestedPi',
    'parseInitOptions',
    'resolveJuniorCliPath',
    'setupCompanions',
    'summarizeInstall',
    'whichOnPath'
  ]);
});

test('compute-pi.ts keeps its runtime exports', async () => {
  assert.deepEqual(await exportsOf('./compute-pi.ts'), [
    'COMPUTE_PI_SCHEMA_VERSION',
    'PI_HOST_IDENTITY_STATUSES',
    'PiProtocolError',
    'assertVerifiedPiHost',
    'attachPiRemoteJob',
    'brokerPiSecrets',
    'createArtifactManifest',
    'createFakePiTransport',
    'createPiArtifactManifest',
    'createPiProtocol',
    'createPiSecretBroker',
    'createPiWorkspaceManifest',
    'createWorkspaceManifest',
    'executePiRemoteJob',
    'inspectPiHostIdentity',
    'redactPiLogs',
    'redactPiSecrets',
    'runPiRemoteJob',
    'verifyArtifactManifest',
    'verifyPiHostIdentity',
    'verifyPiManifest',
    'verifyWorkspaceManifest'
  ]);
});

test('matrix.ts keeps its runtime exports', async () => {
  assert.deepEqual(await exportsOf('./matrix.ts'), [
    'MATRIX_USAGE',
    'buildDimensionSet',
    'canonicalJson',
    'codeLocations',
    'cpmDeliverables',
    'fmecaFailureModes',
    'jevitateJobs',
    'jevitateJourneys',
    'jevitatePersonas',
    'main',
    'parseMatrixArgs',
    'sha256Hex',
    'sortKeysDeep',
    'tests',
    'validateDimensionSet',
    'writeDimensionSet'
  ]);
});
