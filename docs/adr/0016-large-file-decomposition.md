---
id: ADR-0016
title: Decompose production and test files over 1,000 lines behind re-export facades
status: accepted
date: 2026-10-29
supersedes: []
applies_to:
  - compute.ts
  - tools/tools.ts
  - installer.ts
  - runtime.ts
  - compute-hetzner.ts
  - setup.ts
  - compute-pi.ts
  - matrix.ts
  - worker.test.ts
  - tools/tools.test.ts
  - dependencies.test.ts
rules:
  - id: R1
    text: Each split file stays at its path as a facade that re-exports every symbol it exported before, so no importer changes. facade-exports.test.ts pins the runtime export names of every facade.
  - id: R2
    text: Moved types are imported and re-exported with `import type` / `export type`. Node strips types without checking them, so a plain import of a type fails at runtime and a dropped type export fails nowhere; review type exports by hand.
  - id: R3
    text: An `isDirectEntry(import.meta.url)` entry block stays in the facade; only `main` may move. setup-*.ts modules stay at the repository root because PACKAGED_SKILL_PATH and resolveJuniorCliPath derive from their own location.
  - id: R4
    text: setup.ts, installer.ts and tools/tools.ts form an import cycle (setup -> installer -> tools -> setup via loadDefaults). No new module may call an imported symbol at load time.
  - id: R5
    text: A split is a pure move. Function bodies, closures and behaviour do not change. createFakeHetznerProvider, createPiProtocol and executeWorkerStreaming stay whole.
  - id: R6
    text: Shared test helpers move into a module whose name ends in `.test.ts` and holds no test() calls, so scripts/build.mjs collect() never bundles it. Tests move verbatim; the package.json test script lists the new files.
---

# ADR 0016: Decompose files over 1,000 lines behind re-export facades

## Context

After the 0.13.0 worker.ts split, eight production files and three test files
still exceed 1,000 lines. They are hard for a commodity worker to hold in
context and attract merge conflicts. The worker.ts split showed the pattern:
cohesive modules named `<file>-<concern>.ts`, with the original file kept as a
re-export facade.

## Decision

Split each file along the seams below. Line ranges refer to the files at
`origin/dev` 164a6ce. Module order is the import order: a module imports only
modules before it.

### compute.ts (2190)

| Module | Takes |
|---|---|
| compute-schema.ts | L1-469: `COMPUTE_*` constants and types, `DEFAULT_COMPUTE_POLICY`, `COMPUTE_CLI_SCHEMA`, status schema and invariants, `ISSUE_SEVERITY`, `add`, `is*` guards; plus `resolveEpoch` and `sameTags` (L668-682) |
| compute-status.ts | L471-966: provider identity, `validate*`, `inspectComputeStatus`, `assertComputeStatus`, `modeAllowsOperation` |
| compute-policy.ts | L968-1278: policy, fallback, capabilities |
| compute-lease.ts | L1280-1589: lease state, acquire, heartbeat, release, reclaim |
| compute-authority.ts | L1591-2063: `authorizeComputeOperation`, reconcile, stop, `releaseComputeLeaseWithAuthority`, aliases `reconcileComputeResource` and `stopCompute` |
| compute-scale.ts | L2065-2190: scale-in and alias `evaluateComputeScaleDown` |

Order: schema; then status, policy and lease; then authority and scale.

### tools/tools.ts (1596)

| Module (tools/) | Takes |
|---|---|
| tools-manifest.ts | L49-517: constants, types, `HopError`, `probeToolVersion`, `isReadTool`, file helpers, `validateManifest`, `loadHop`, `saveHop`, `withManifestLock`, `initHop` |
| tools-mcp.ts | L519-728: `mcpCallSequence`, `mcpCallTool`, `killTree` |
| tools-env.ts | L730-952: `CallRequest`, `CallOutcome`, `buildToolEnv`, `companionKeyEnv`, cpm review and model env, semver |
| tools-call.ts | L954-1389: crossmatrix store, snapshot, `prepareCalls`, `callHop`, `inspectHop`, `recordManagerAcceptance` |
| tools-cli.ts | L1391-1590: CLI parsing, `main` |

Private helpers (`nowIso`, `readJsonFile`, `writeFileAtomic`, `toHopError`)
are exported between modules but not from the facade.

### installer.ts (1588)

| Module | Takes |
|---|---|
| installer-platform.ts | L33-238: types, `TOOL_NAMES`, `TOOL_REPOS`, `SUPPORTED_MATRIX`, `DEFAULT_*`, `InstallerError`, deps types, `detectPlatform`, asset names |
| installer-release.ts | L240-682: approved hosts, bounded fetch, `parseRelease`, `resolveLatestRelease`, manifest and checksums, tar listing and validation, default exec |
| installer-state.ts | L684-932: TRIZ constants, install state and lock, `probeBinary`, `syncHopWithTools`, `checkToolUpdates` |
| installer-install.ts | L934-1321: `installTriz`, `installOne`, `installTools` |
| installer-integrations.ts | L1323-1538: `verifyManagedFile`, `inspectIntegrations`, `trizReport` |

The facade keeps `parseArgs`, `main` and the entry block. installer-state.ts is
the only module that imports tools/tools.ts.

### runtime.ts (1156)

| Module | Takes |
|---|---|
| runtime-settings.ts | L25-111 and L309-360: settings, `EXECUTION_*`, `KILL_GRACE_MS`, `DEFAULT_MAX_OUTPUT_BYTES`, budgets |
| runtime-process.ts | L113-307 and L1013-1156: `RuntimeHeartbeat`, `ToolWatchdog`, spawn, `killChildGroup`, `executeCheck`, `isSuccessStatus` |
| runtime-events.ts | L362-600: result and accounting types, compaction, read-path helpers |
| runtime-stream.ts | L602-1011: `executeWorkerStreaming`, kept whole |

### compute-hetzner.ts (1137)

| Module | Takes |
|---|---|
| compute-hetzner-capabilities.ts | L1-302: constants, types, identity, capabilities, quota, discovery |
| compute-hetzner-placement.ts | L304-524: placement, request fingerprint, `serialQueue` |

The facade keeps `createFakeHetznerProvider` (a closure over shared state,
about 600 lines) and the `createHetznerAdapter` alias.

### setup.ts (1122)

| Module | Takes |
|---|---|
| setup-env.ts | L36-257: constants, `SKILL_*`, `PACKAGED_SKILL_PATH`, `resolveJuniorCliPath`, `SetupDeps`, helpers, semver, `discoverInstalledPi`, `checkPi`; plus `loadDefaults` (L858-873) |
| setup-skill.ts | L875-1052: skill install, inspect and messages |
| setup-doctor.ts | L259-707: credentials, model, gateways, litellm, slow mount, `doctor`, `summarizeInstall` |
| setup-init.ts | L709-856 and L1055-1122: `init`, excludes, `parseInitOptions`, `setupCompanions` |

Moving `loadDefaults` into setup-env.ts avoids a doctor/init cycle.

### compute-pi.ts (1072)

| Module | Takes |
|---|---|
| compute-pi-host.ts | L1-383: schema and status constants, `PiProtocolError`, host identity, manifests and aliases |
| compute-pi-secrets.ts | L385-550: secret broker, redaction and aliases |
| compute-pi-protocol.ts | L552-995: abort scope, `raceWithAbort`, `createPiProtocol` (kept whole), `executePiRemoteJob` and aliases |

The facade keeps `createFakePiTransport` and `abortableDelay`.

### matrix.ts (1061)

| Module | Takes |
|---|---|
| matrix-adapters.ts | L30-496: types, hashing, file dimensions, `codeLocations`, `tests`, jevitate, cpm and fmeca adapters |
| matrix-dimensions.ts | L498-603: build, write, validate |
| matrix-cli.ts | L605-1055: `MATRIX_USAGE`, argument parsing, `gitTrackedFiles`, `dimensionsForSource`, `main` |

playbooks.ts imports matrix types with `import type`; keep it that way.

### Test files

None uses `describe`, hooks or `mock.*`; each is flat `test()` calls under
`// --- section ---` comments.

- worker.test.ts (551 tests): worker-helpers.test.ts (shared helpers such as
  `run`, `task`, `U`, `assistant`, `cli`), worker-gates (Jev classifier,
  gateway, attention, B05), worker-workflows (cost, templates, D09/D10),
  worker-continuation, worker-setup (D06, D06b, D10 skill, companions, B09,
  B07, `JUNIOR_NO_INSTALL`), worker-routing (commodity policy, consent, sticky
  routing, J3), worker-isolation (D07, D08, B01, B06, #14), worker-runtime
  (D08 handoff, P03, J41a, #22), worker-contract (#17, #23, #125, external
  consent, WIRE10).
- tools/tools.test.ts (112 tests): tools-helpers.test.ts, tools-manifest
  (init, manifest, read classification, defaults, provenance), tools-call
  (call ergonomics, failures, inspect, crossmatrix store, model.open,
  scientific-process prelude), tools-env (cpm review keys, `companionKeyEnv`,
  cpm model selection).
- dependencies.test.ts (83 tests): dependencies-helpers.test.ts,
  installer.test.ts (platform, install, update, failures, unreleased tools,
  HOP state, TRIZ, update check), doctor.test.ts (doctor readiness, digest, Pi
  pairing, summaries). Classify the unlabelled L589-936 block first.

## Consequences

- Importers and tests keep working through the facades; facade-exports.test.ts
  catches a dropped or added value export.
- The compute, compute-hetzner, compute-pi, gateway and doctor-gateways tests,
  previously unregistered, join the npm test script with the split test files.
- One full `npm test` and `npm run build` on the integrated tree is the gate
  for the whole wave.
