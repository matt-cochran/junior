# Junior

Delegate one bounded deliverable to a capable commodity model (DeepSeek is the tested default), then review a compact receipt and independent evidence. The manager keeps the contract and acceptance decision; Junior handles execution, checks, artifacts and optional Jev gates.

```bash
node junior.ts init
node junior.ts doctor
node junior.ts handoff /absolute/task.json
node junior.ts status /absolute/result.json
npm test
```

Implementation handoffs default to a clean Git worktree. `init` writes project files and installs project-local manager skills; review/commit those files before a worktree handoff, or explicitly choose `isolation: "none"`. Optional report-only workflows are `recon`, `fmeca`, `evaluate`, and fresh-session `qa`. Shared FMECA/CPM/Crossmatrix state uses `junior.ts tools`; TRIZ is a [separate tool](https://github.com/matt-cochran/triz).

The detailed reference below retains the legacy `worker.ts` commands and all configuration options.

## Start here

Junior is MIT licensed. A frontier manager defines and reviews the deliverable; the worker returns changes, independent checks, usage, and unresolved work. Jev can block unsuitable or uncertain tasks before execution when enabled with `jev.mode: enforce`; it is off by default. Junior never automatically invokes a frontier model or accepts its own work.

For a reproducible source installation:

```bash
git clone https://github.com/matt-cochran/junior.git
cd junior
npm ci
npm run build
node dist/junior.js --help
npm test
```

Use Node 24+ and Ubuntu WSL on Windows for worker execution. Native installed-CLI smoke tests cover Linux, macOS, and Windows on x64 and ARM64; process-group cancellation guarantees are tested on Linux. Provider credentials and optional planning tool releases are configured separately by `junior init --install` and `junior doctor`. Do not commit credentials, transcripts, or local task artifacts.

Read [CONTRIBUTING.md](CONTRIBUTING.md) to contribute, [SECURITY.md](SECURITY.md) for security reporting, and [SUPPORT.md](SUPPORT.md) for troubleshooting. The `tasks/D*` contracts are development history with local paths; adapt examples to your own workspace before executing them. Installation does not authorize paid model calls.

## Install

The npm package name is `@matthew-cochran/junior` (Node 24 or newer). It ships
compiled JavaScript under `dist/`; there is no install-time build and no runtime
npm dependency.

```bash
# Once a release is available on npm:
npm install -g @matthew-cochran/junior
junior --help
junior --version
junior init
```

`junior` is the installed bin (`dist/junior.js`). `junior --help` and
`junior --version` are offline. Every subcommand also accepts `--help`/`-h`,
which prints that command's usage and exits zero without writing files,
installing anything, or making a provider call (for example
`junior init --help` and `junior tools init --help`). Unknown long and short
options are rejected before any side effect, options that require a value must
receive one, and excess positional arguments are refused. `init` is offline
unless you pass `--install`, and `handoff ... --mock` makes no provider call.
The legacy source entry points (`node junior.ts ...`, `node worker.ts ...`) are
retained unchanged.

### Build from a source checkout

```bash
npm ci
npm run build      # transpile production TypeScript to dist/ (no typecheck claim)
node dist/junior.js --version
npm test           # builds, then runs the behavioral suite
```

The build is transpile-only: it uses the TypeScript compiler's
`transpileModule` with `isolatedModules` and rewrites relative `.ts` imports to
the emitted `.js` files, so the compiled runtime resolves its own module graph
without any raw TypeScript or runtime compilation. It makes **no typecheck
claim**. `dist/` is gitignored but always included in the published tarball via
the `files` whitelist. The packaged skill is copied to
`dist/skills/junior/SKILL.md`.

## Publishing

The initial release can be published after `npm login`. Subsequent releases can use GitHub Actions trusted publishing with provenance (npm 11.5.1 or newer).

- `npm pack` (or `npm run pack`) builds and produces
  `matthew-cochran-junior-<version>.tgz`. `prepack` runs the build, so the tarball
  always contains fresh compiled output and never raw TypeScript.
- `npm run release` runs `npm publish --access public`; the release
  workflow invokes it, never `npm install`.

### One-time setup

1. `npm login` locally as a maintainer of the `@matthew-cochran` scope and confirm
   with `npm whoami`.
2. On npmjs.com, open the package settings and add a **Trusted Publisher**:
   provider GitHub Actions, repository `matt-cochran/junior`, workflow
   `publish.yml`, environment blank. CI then authenticates with OIDC
   (`id-token: write`) and attaches provenance; no long-lived `NPM_TOKEN` secret
   is stored.
3. Bump `package.json` `version`, commit, then push a matching `vX.Y.Z` tag (or
   run the **Publish** workflow manually with `tag=vX.Y.Z`).

The workflow runs the packaged tests, fails if the tag does not match
`package.json`, skips a version that is already on the registry, and only then
publishes. It never publishes on an ordinary push or pull request.

# Junior — deliverable delegation
Run inside Ubuntu WSL with Node 24 or newer (Node 26.5 is the tested
version; load nvm first, for example `nvm use 24`).

node --test worker.test.ts
node worker.ts doctor
node worker.ts init [--install]
node worker.ts validate smoke.json
node worker.ts run smoke.json --mock
node worker.ts status .delivery/<id>/<timestamp>/result.json

# Compact manager entry point (same worker/setup structures underneath).
node junior.ts handoff tasks/example-task.json --mock
node junior.ts handoff tasks/example-task.json --full
node junior.ts status .delivery/<id>/<timestamp>/result.json
node junior.ts status .delivery/<id>/<timestamp>/result.json --full
node junior.ts doctor
node junior.ts init [--install]
node junior.ts validate smoke.json
node junior.ts run smoke.json --mock

`junior.ts handoff` is the compact entry point. It defaults a task to
`isolation: "worktree"` unless the task explicitly sets `isolation: "none"`,
runs the task and prints one small handoff object (see **Runtime, deadlines and
handoff** below). `junior.ts` `init`/`doctor`/`run`/`validate`/`status` delegate
to the same `setup.ts`/`worker.ts` code as the legacy `worker.ts` CLI, which is
retained unchanged for saved artifact/session paths.

`doctor` performs a read-only readiness check with no arguments. `init` creates
project defaults and an example task only when absent. Neither makes a paid
network call or writes global configuration.

`status` inspects a saved result file and prints its id, outcome, checks,
artifact directory and (when present) receipt and Jev gate record as JSON. Old
result files without those fields still work. It does not execute anything; a
saved failed run is reported successfully. Missing files, invalid JSON, and
malformed results print a concise error and exit nonzero.

Live execution: install/authenticate Pi with OpenRouter (`init`, then `pi` and
`/login`/`/model`), then opt in to the paid smoke test by omitting `--mock`.
Tasks declare id, deliverable, cwd, acceptance, checks (command + args), optional
constraints, model and `jev`. Provider/model come from `delivery.config.json`
when present, otherwise they default to openrouter and
deepseek/deepseek-v4.1-flash; an explicit task value always wins.

### Contract fields and unknown keys
`validate` recognizes exactly the supported top-level fields (`id`,
`deliverable`, `cwd`, `acceptance`, `checks`, `constraints`, `provider`, `model`,
`thinking`, `pricing`, `jev`, `workflow`, `isolation`, `resumeFrom`, `repairFrom`,
`reviewFrom`, `maxRepairs`, `lineageDeadlineMs`, `hopFrom`, `hopRevision`,
`hopContext`, `execution`, and the five execution settings directly:
`deadlineMs`, `quietMs`, `toolTimeoutMs`, `heartbeatMs`, `checkTimeoutMs`).
A misspelled or unsupported top-level key is rejected with `Unknown contract
field: <key>` rather than silently ignored, and each check accepts only
`command`, `args` and `cwd` (an unknown check key is rejected with `Unknown
check field: <key>`). Nested known fields (for example `execution.quietMs`,
`jev.mode` and `pricing.source`) remain supported.

### Check working directory (`checks[].cwd`)
Each check may set an optional `cwd`. It defaults to the execution checkout
(`executionCwd`). A relative `cwd` resolves under the execution checkout and is
rejected if it escapes it. An absolute `cwd` inside the source checkout is
remapped to the equivalent path in the isolated worktree, so a monorepo check
authored against the source path (for example `/repo/packages/app`) runs against
the isolated copy (`.../worktree/packages/app`) instead of the source tree. An
absolute `cwd` outside the workspace, an empty or non-string `cwd`, and any
check `cwd` that escapes the workspace are rejected by `validate` before any
paid call. A check `cwd` whose lexical path is inside the workspace but whose
real (symlink-resolved) target points outside is rejected before execution. If
`resolveCheckCwd` rejects a `cwd`, the check is recorded as failed with the
rejection reason and the command is not run; the worker never silently falls
back to the checkout root. Every check result records the actual resolved `cwd`
it ran in, so a manager can verify what was tested.

## Micro-deliverable stages
This prototype was built as small, inspectable stages:

1. `validate` plus the synchronous `run` skeleton and independent checks.
2. `status` inspection of a saved result (D01-status).
3. Verifiable Pi execution receipts from `--mode json` (D02-receipt).
4. Opt-in Jev readiness/completion gates and honest usage/cost availability
   (D03-jev).
5. Git change tracking plus a distinct estimated execution cost, kept separate
   from Pi's raw catalog cost and from unobservable billing (D04-cost-shadow).
6. Deterministic workflow templates selected by Jev and explicit Pi session
   continuation (D05-workflows).
7. Idempotent `init` plus a read-only `doctor` readiness check for Ubuntu WSL
   (D06-setup).
8. Complete before/after change evidence, content fingerprints, and advisory
   execution/session locks (D07-evidence).
9. Streaming child lifecycle, validated deadlines, tool watchdog, repair
   lineage and the compact manager handoff (D08-runtime-handoff).

## Setup
- Node 24 or newer (`node --test`, `node worker.ts`); the worker is tested on
  Node 26.5, and `doctor` reports the running version and the minimum. Install nvm
  inside WSL and use it for both `node` and the global `pi` install so the two
  resolve from the same bin directory.
- The worker shells out to `pi` for live runs; `--mock` performs no Pi call.
- Logs and results are saved in the target checkout under `.delivery/`. Add it
  to that repository's ignore rules.
- Jev gates use the installed Pi SDK. Resolution order: `PI_SDK_MODULE` (or
  `PI_SDK_PATH`) if set, then the global `node_modules` beside the running
  `node`, then normal package resolution. No dependency install is performed.
- Tests never load the SDK and never make paid calls: they inject an offline
  classifier through `run(task, mock, { classify })`.

## Setup commands: `doctor` and `init`
Both commands take no task file and are offline by default.

### `node worker.ts doctor`
Read-only readiness check. It emits concise JSON and exits nonzero when a
required prerequisite fails. It never installs anything, writes configuration,
or makes a paid network call. Checks:

- **Node**: the running version versus the supported minimum (`22.19.0`).
- **Pi**: resolves `pi` on `PATH`, records the bounded `pi --version` output and
  the executable location, and flags a PATH/nvm mismatch when `pi` and the
  running `node` resolve from different directories (a global install under
  another nvm version is invisible to the active Node).
- **Credentials**: inspects whether the requested provider has a credential in
  Pi's `auth.json` or its environment variable. Only provider names and source
  labels are reported; credential values are never returned or printed.
- **Model**: verifies the configured provider/model (default `openrouter/deepseek/deepseek-v4.1-flash`) against Pi's
  local catalog (`models-store.json`) and agent `models.json` with no network
  call, and gives an actionable diagnosis when it is missing.
- **Skill**: reports delegation-skill readiness **separately** from Pi execution
  readiness in the `skill` field (`current`, `outdated`, `customized` or
  `missing` per manager). A missing or customized skill does not change the
  Pi execution `ok`/exit status.
- **Integrations**: reports prebuilt FMECA/CPM/Crossmatrix readiness (installed
  version, release provenance and binary path) separately from Pi execution and
  auth readiness in the `integrations`/`integrationsReady` fields, plus the
  optional TRIZ status. It is offline and never compiles Rust; an existing
  configured local binary is reported usable from its metadata without an
  implicit build.

The result includes `checks` (one entry per prerequisite) and `remediation`
strings. If `pi` is missing it recommends `init --install`; if credentials are
missing it recommends `pi` then `/login` and `/model`.

### `node worker.ts init`
Idempotent project setup. It creates, only when absent:

- `delivery.config.json` with the project defaults (`provider`, `model`, and the
  pinned tested Pi version (1.0.3)).
- `tasks/example-task.json` with a runnable example contract.
- The packaged delegation skill under `.agents/skills/junior/` (Codex) and
  `.claude/skills/junior/` (Claude Code), copied from the canonical
  `skills/junior/SKILL.md` resolved relative to the Junior module, never from
  the caller's working directory.

Existing files are preserved and global auth/model configuration is never
touched. `run` loads `delivery.config.json` from the task's resolved `cwd`; an
explicit task `provider`/`model` always takes precedence over the defaults.

`init` reports readiness honestly: it runs the same checks as `doctor` and
returns `ready` (Pi execution **and** skill install), plus `instructions` when
something is missing.

> **Project init creates Git changes.** It writes config, the example task and
> the skill directories into the target checkout. The default `handoff`
> isolation is `worktree`, which requires a clean source checkout, so commit or
> review these init files (or pass `isolation: "none"`) before the first
> handoff. Junior never commits and never silently excludes generated files.

#### Skill install and upgrade
By default `init` installs the skill for both managers into the project. The
operations are explicitly scoped:

- `--target codex|claude|both|none` (or `--no-skill`) selects the manager
  targets; the default is `both` for the project.
- `--user` switches to a user-wide install under `HOME` —
  `HOME/.agents/skills/junior` for Codex and `HOME/.claude/skills/junior` for
  Claude Code. Without `--user`, `init` never writes outside the project.
- `--skill-root DIR` supplies an explicit skill root (for example a Windows
  manager user directory) and overrides the resolved root.

Reruns are safe: an identical copy is left as-is, a missing copy is created, an
unmodified but outdated copy is reported and preserved until `--upgrade`, and a
customized copy is reported as a conflict and preserved unless `--force` is
given. Junior records the hash it wrote in a `.junior-manifest.json` beside the
installed skill; `--upgrade` only replaces a file whose current hash still
matches that manifest, so a customization is never silently overwritten.

#### `init --install`
Installing Pi happens only through the explicit `--install` flag. Ordinary
`init` never installs; it prints the instruction instead. `--install`:

- Uses the pinned tested `@earendil-works/pi-coding-agent@1.0.3` release; preserves an existing working Pi installation. The local Pi
  `package.json` can also be inspected for version diagnosis (no floating install version).
- Runs `npm install -g --ignore-scripts <name>@<version>` as argv with no shell
  interpolation and a bounded `300000` ms timeout.

After a successful installation, readiness is checked again. Fresh installations use the pinned version even when no local Pi metadata exists. It
reports authentication and model setup instructions to run with the
active Node/nvm.

#### Prebuilt release tools (`init --install`, `--update`, `--with-triz`)
`init --install` also downloads checksum-verified **prebuilt** binaries for the
FMECA, CPM Planner and Crossmatrix MCP servers; no Rust, Cargo or Git local
build is ever performed, and no shell installer is used. Releases come from the
stable GitHub release API for `praxec/fmeca`, `praxec/cpm-planner` and
`praxec/crossmatrix`.

- Asset names are `<binary>-<triple>.tar.gz` on Linux/macOS and
  `<binary>-<triple>.zip` on Windows. Supported targets:

  | OS | Architecture | Target triple |
  | --- | --- | --- |
  | Linux (incl. WSL) | x64 | `x86_64-unknown-linux-gnu` |
  | Linux (incl. WSL) | arm64 | `aarch64-unknown-linux-gnu` |
  | macOS | x64 | `x86_64-apple-darwin` |
  | macOS | arm64 | `aarch64-apple-darwin` |
  | Windows | x64 | `x86_64-pc-windows-msvc` |
  | Windows | arm64 | `aarch64-pc-windows-msvc` |

- Windows ARM64 is detected from the native processor environment even when the
  running Node process is x64-emulated. An unsupported OS/architecture fails
  explicitly with the matrix above; there is no compile fallback.
- Every selected asset must match a SHA-256 from the release's
  `checksums.sha256` (or the release asset digest metadata) before it is
extracted. Downloads are HTTPS-only to approved GitHub release hosts (redirects
are re-validated) and are bounded by request timeout, size and an overall
install deadline.
- Archives are listed first; absolute paths, `..` traversal and symlink /
  hardlink entries are rejected. The exact regular binary entry is streamed out
  with the system `tar` and written atomically only to the managed destination.
- A downloaded binary must pass a conservative MCP `initialize` protocol probe
  (no model call) before it replaces anything. A failed download, checksum,
  extraction or probe preserves the previous working install.
- The first explicit install resolves the current complete published release.
  Re-running is idempotent and does not re-download; a newer release is reported
  but not adopted until `--update`. Installed version, repo, tag, source SHA,
  asset digest, binary digest and path are recorded in the managed user-state
  manifest and `.delivery/setup/hop.json`; existing project id, revision,
  acceptance, native paths and snapshots are preserved, and explicitly custom
  tool command/args/env are never overwritten. The recorded **source SHA** is
  taken only from the checksum-verified `release-manifest.json` (`sourceSha` for
  Praxec, `commit` for TRIZ); it is never fabricated from the binary digest. A
  new-format manifest must agree with the release tag and list all six supported
  targets, or the install fails explicitly.
- `--with-triz` additionally downloads the optional portable compiled-JS archive
  from `matt-cochran/triz` (`triz-vVERSION-node.tgz`), verifies its checksum and
  resolves `dist/triz.js`. The file is installed under a managed
  `package.json` (`"type": "module"`) and must pass a bounded offline ESM smoke
  test before it replaces a working installation, so a broken module or missing
  ESM metadata preserves the previous working TRIZ. A newer TRIZ release is
  never adopted without an explicit `--update`. TRIZ stays a separate CLI run
  with the active Node; it is never compiled locally and never makes a paid
  model call.
- `doctor` verifies each recorded binary against its recorded SHA-256 and checks
  the executable bit before calling it usable; a bare file's existence is not
  enough. A configured local path in `.delivery/setup/hop.json` is reported as
  usable **unverified** provenance when no managed install is present.

Prerequisites for the prebuilt tools are Node, a system `tar`, and (`init
--install`) `npm` for Pi. Rust/Cargo and Git are **not** client requirements.

### Authentication and the paid smoke test
Authenticate only through Pi itself: start `pi` and run `/login`, then choose a
model with `/model`. The setup commands never collect, print, copy, or automate
secrets, and they never read credential values for output.

The setup checks are free. A **paid smoke test is a separate, explicit opt-in**:
run a live task without `--mock`, for example
`node worker.ts run tasks/example-task.json`. That is the only path that spends
money. It is never part of `node --test worker.test.ts`, and `doctor`/`init`
never trigger it. Use `--mock` for an offline simulation.

## Execution receipts
Live runs invoke `pi --provider <p> --model <m> --mode json`. Raw stdout is saved
verbatim as `events.jsonl` (strict JSONL) and stderr separately as `worker.log`,
so the stream can be audited after the fact.

Each result carries a `receipt` parsed from authoritative assistant
`message_end` records only:
- `requested`: the provider/model passed to Pi.
- `observed`: unique provider/model pairs Pi reported on assistant messages.
  Missing fields are recorded as `unknown`; when there are no observed pairs,
  `observed` is `[]` and `observedUnknown` is `true`.
- `sessionId`, `assistantMessages`, `stopReasons`.
- `usage`: totals summed across assistant `message_end` records. `turn_end`,
  `agent_end`, and cumulative `message_update` usage are ignored to avoid double
  counting.
- `usage.available`: true only when at least one message_end reported usage.
- `usage.cost.available`: true only when a message_end reported a numeric cost.
  When it is false the cost is **unknown, not free**; the numeric fields remain
  0 only as placeholders. An empty cost object does not count as a report.
- `malformed`/`malformedLines`: JSONL records that failed to parse.
- `settled`: whether Pi emitted `agent_settled`.

Receipt metadata is Pi-reported, not independent upstream attestation. Mock runs
set `receipt.source` to `mock`, observe no model, and never claim an observed
model. A live run is `ready_for_review` only when Pi exits zero, the stream
parses, at least one assistant message ended, no assistant message ended
`error`/`aborted`, Pi reported `agent_settled`, and all independent checks pass.
Otherwise the run reports `receipt_failed` even when Pi exits zero; a settled
stream with no assistant messages is rejected.

## Estimated execution cost
Pi's `usage.cost` is a **catalog estimate reported by Pi, not a bill**. This
worker never observes actual billing, so `billedUsd` is always `null`. The raw
Pi cost is kept separate under `cost.piReported` (same availability semantics as
`receipt.usage.cost`), and a distinct estimate is computed only when the task
supplies explicit, attributable pricing:

```json
"pricing": {
  "input": 0.14,
  "output": 0.28,
  "cacheRead": 0.014,
  "cacheWrite": 0.14,
  "source": "provider pricing page captured 2025-01-01",
  "date": "2025-01-01"
}
```

- Rates are USD per million tokens for `input`, `output`, `cacheRead` and
  `cacheWrite`. Any supplied rate must be finite and nonnegative; `source` and
  `date` are required so an estimate is attributable. Rates may be omitted, but
  a nonzero usage bucket with no rate makes the estimate unknown.
- The estimate uses independently observed `usage` only. Reasoning tokens are
  excluded because Pi already includes them in `output`.
- `estimatedUsd` is `null` (unknown, **not** free) when pricing is absent, usage
  is unavailable, the observed model is unknown or multiple, or a used bucket
  lacks a rate. `unknownReason` records which case applied.
- `pricingSource`/`pricingDate` echo the supplied attribution; `billedUsd` is
  always `null`.
- This worker does not fetch live pricing and ships no authoritative rates. The
  example task `tasks/example-shadow.json` uses clearly-labelled illustrative
  rates; replace them with verified provider pricing before relying on an
  estimate.

`status` exposes the `cost` object when a saved result carries one.

## Workflow templates
Each task selects one deterministic template. `workflow` accepts `recon`,
`test_first`, `checks_first`, `fmeca`, `evaluate` or `auto` (the default when
omitted). An explicit value always wins and the classifier is not asked:

```json
{ "workflow": "test_first" }
```

- `recon`: inspect first and report **tested / inferred / unknown** findings
  plus a recommended strategy. Experiments stay in the `.delivery` scratch
  directory and no production change is retained. That is an instruction to the
  worker, **not** a sandbox guarantee.
- `test_first`: write a failing behavior test for the requested behavior, then
  implement the smallest change that makes it pass, then run focused checks.
- `checks_first`: inspect-first; run the existing checks before changing
  anything. Used for setup and documentation work and as the `auto` fallback.
- `fmeca`: analysis-only qualitative FMECA across UX / user interaction,
  runtime behavior, technical architecture and project / delivery design. It
  reports bounded, highest-impact failure modes (8-15 where the scope warrants,
  never invented to fill a quota) over at most three iterations, with evidence
  labels, prevention-first mitigation, production observability and conditional
  residual risk. It does not modify production code; removal or demotion is a
  proposal only. That is an instruction to the worker, **not** a sandbox
  guarantee.
- `evaluate`: analysis-only architecture review. It establishes architecture
  validity first (component classification, simpler alternatives, and
  removal/demotion proposals), then applies the same FMECA discipline, then
  runs a calibration / observability / over-engineering / incremental-delivery
  reality check. It does not modify production code; removal or demotion is a
  proposal only.
- `auto`: ask Jev exactly one `choice` question (with the fixed descriptions
  above, in the same readiness classify call) and use a confident answer. A
  below-threshold answer, a classifier outage, or no classifier defaults to the
  inspect-first `checks_first` and records the recommendation.

The final prompt is always assembled from a fixed common block and the fixed
workflow block plus the task contract JSON. No Jev-generated prose is inserted.
Each run saves `prompt.txt` and `workflow.json` (selected template IDs, the
deterministic report path for analysis workflows, and the workflow decision) in
its artifact directory, and the result carries `workflow` and `templates`.

### Analysis report lifecycle
`fmeca`, `evaluate` (and the analysis-only `recon`) are a **contract boundary,
not an OS sandbox**. For `fmeca` and `evaluate` the worker appends a
deterministic report path to the prompt:

```
<artifactDir>/analysis-report.md
```

The worker writes the report there before finishing. The run reports
`ready_for_review` only when the report exists; a missing report downgrades an
otherwise-passing run to `needs_review` (it never upgrades a failure). The full
result carries `analysis` (`workflow`, `report`, `reportPresent`), and the
compact handoff exposes `analysis` plus `artifacts.report`, with the missing
report listed under `unresolved`. `--mock` performs no Pi call and therefore
writes no report, so a bare mock analysis run is `needs_review`; offline tests
inject a spawn seam that writes the report, with no paid call.

Analysis-to-implementation is an **explicit authorization** step: resuming an
analysis-only session (`recon`, `fmeca` or `evaluate`) with `auto` can never
select the code-writing `test_first` template. It falls back to the
inspect-first `checks_first` and records that an explicit workflow is required
in the new contract.

```bash
# 1. Analysis only (no production changes).
node worker.ts run tasks/fmeca-task.json
# 2. Review the analysis report and the compact handback.
node junior.ts status .delivery/fmeca-task/<timestamp>/result.json
# 3. Explicitly authorize implementation by selecting a code workflow and
#    resuming; `auto` alone is not authorization.
node worker.ts run tasks/implementation-task.json
```

## Session continuation
A task may continue a prior Pi session by pointing `resumeFrom` at that run's
`result.json`:

```json
{
  "workflow": "test_first",
  "resumeFrom": "<prior-artifact-dir>/result.json"
}
```

The worker validates that the prior result has a receipt with a valid Pi session
ID and the **same resolved cwd and requested provider/model**. It then passes an
explicit `--session <id>` to Pi and never `--continue`, so continuation cannot
silently attach to the wrong session. The new contract is appended to the
session; a prior `recon` recommendation is never treated as automatic approval
to write code. Resuming a `recon` run with `auto` and a test-first
recommendation is downgraded to `checks_first` until a new contract selects a
code workflow explicitly. The result records `resume` (parent result, parent
session and resumed session).

The example below is the documented recon-then-code sequence. It performs **no
nested paid runs**: each step is a separate, explicitly authorized invocation.

```bash
# 1. Inspect only (explicit recon).
node worker.ts run tasks/example-recon.json
# 2. Review the recon result and its recommended strategy.
node worker.ts status .delivery/example-recon/<timestamp>/result.json
# 3. Explicitly authorize coding by selecting test_first and resuming.
#    Replace <timestamp> in tasks/example-resume.json, then:
node worker.ts run tasks/example-resume.json
```

Cache reuse across a continuation is **best effort and never guaranteed**. The
receipt always preserves the observed `cacheRead` counters, the requested and
observed provider/model, and does not claim actual billing. Each result carries
a `cache` note to that effect.

## Git worktree isolation
`isolation` is opt-in per task and defaults to `none`:

```json
{ "isolation": "worktree" }
```

- `none` (default): the worker runs in the task's resolved `cwd`. This preserves
the prior behavior; preexisting uncommitted work is left in place.
- `worktree`: before any paid call the worker creates a unique detached Git
worktree at the source `HEAD`, runs Pi and every check in that checkout, and
keeps artifacts in the source `.delivery/` directory. The result records
`sourceCwd`, `executionCwd` and `isolation`. The worktree is **retained for
review**; the worker never merges, removes, commits or pushes it. Review the
isolated checkout and integrate it yourself (use `git worktree list` to find it,
then inspect/diff or merge it manually).

`isolation=worktree` refuses to start when the source checkout is dirty
(staged, unstaged or nonignored untracked changes) and reports an actionable
diagnostic instead of silently omitting edits. Commit or stash the work, or use
`isolation=none`. This is **not a sandbox**: the worker runs with the same
filesystem and network access as the caller; isolation only provides a separate
checkout and a clean evidence baseline.

Continuation (`resumeFrom`) is checkout-scoped because a Pi session is bound to
its working directory. A continuation must use the same isolation as the prior
run: resuming a `none` run as `worktree` (or vice versa) is rejected before any
paid call. A `worktree` continuation reuses the prior run's execution checkout
rather than creating a new one.

Concurrent runs are serialized by advisory lock files under
`.delivery/locks/`: the execution checkout and, when resuming, the Pi session.
A second run fails fast before any classifier or worker call. Locks are released
on every success and error path. A foreign or stale lock is never deleted
automatically; the error names the lock file and its holder, and removal is a
manual `rm`.

## Change evidence
Each run captures a **before** and **after** snapshot of the execution checkout
and saves the complete pair as `evidence.json` in its artifact directory, so
preexisting changes are distinguishable from changes the run made. Evidence is
taken against `HEAD` (`git diff HEAD`) and includes staged, unstaged, deleted
and renamed tracked changes plus nonignored untracked files. The result carries
`evidence` with `changedFiles`, `runChangedFiles`, `preexistingFiles`,
`truncated` and `unavailable`; the same complete evidence is passed to the Jev
postflight gate.

Evidence is defensive and bounded: untracked symlinks are never followed (the
target string is recorded, not read), binary files are never decoded as text,
and the diff is capped with explicit `limits` metadata (`diffTruncated`,
`statTruncated`, `filesTruncated`, `untrackedBytes`). A truncated diff means the
gate and reviewer saw a prefix, not the whole change; an `unavailable` diff
means no evidence was collected (for example outside a Git repository).

## Runtime, deadlines and handoff
Live runs no longer use a blocking `spawnSync` call. Pi runs as a streaming
async child in its own process group; stdout is appended live to `events.jsonl`
and stderr to `worker.log`, and a `runtime.json` heartbeat is written atomically
(tmp + rename). Tests inject an offline child, so `node --test` never makes a
paid call or installs anything.

### Execution settings
All optional, nested under `execution` (top-level keys are also accepted). Every
value must be a finite positive number within its bound; otherwise `validate`
rejects the task before any paid call.

| Setting | Default | Bound | Meaning |
| --- | --- | --- | --- |
| `deadlineMs` | 600000 | 1 .. 86400000 | total wall deadline for the whole run |
| `quietMs` | 120000 | 1 .. 86400000 | no-output interval reported as `quiet` |
| `toolTimeoutMs` | 300000 | 1 .. 86400000 | per-tool watchdog limit |
| `heartbeatMs` | 5000 | 1 .. 3600000 | heartbeat write interval |
| `checkTimeoutMs` | 120000 | 1 .. 86400000 | per-check limit (also capped by `toolTimeoutMs` and the remaining deadline) |

The total wall deadline starts **before** readiness, isolation and the
classifier, and covers checks, postflight and every attempt. Each phase uses the
remaining time; no success (`ready_for_review`/`simulation_passed`) is ever
reported after the deadline. The classifier SDK startup and the `git`
subprocesses used for isolation/evidence are bounded by the remaining budget; a
subprocess that is already running when the deadline passes may still take a
short bounded cleanup window, which is the strongest guarantee actually
implemented (never a harder one).

### Runtime states
`runtime.json` records `state`, `phase`, `elapsedMs`, `lastActivityAt`,
`currentTool`, `activeToolMs`, the settings, `deadlineAt` and the stop reason.
States: `running`, `quiet`, `tool_timed_out`, `deadline_exceeded`, `failed`,
`interrupted`, `ready_for_review`.

- `quiet` means no activity for `quietMs`. It is reported only; quiet **never**
  restarts or kills the child.
- The tool watchdog times `tool_execution_start` through `tool_execution_end`;
  `tool_execution_update` events do **not** reset the duration. On expiry the
  process group is stopped with `SIGTERM`, then `SIGKILL` after a bounded grace
  period. On Linux the child is detached into its own process group, so shell
  descendants are cancelled too.
- `SIGINT`/`SIGTERM` produce an `interrupted` handback: process groups are
  stopped, `events.jsonl`/`worker.log`/`evidence.json` are preserved, partial
  edits stay in the checkout, and locks are released.
- Independent checks run through the same async bounded executor as the worker,
  not a blocking `spawnSync`. Each check is bounded by `checkTimeoutMs`,
  `toolTimeoutMs` and the remaining deadline, and its process group is stopped
  with `SIGTERM` then a bounded `SIGKILL`, so a hung check with a TERM-ignoring
  descendant cannot survive. Interrupting a run while a check is running
  cancels that check and yields `interrupted`; the heartbeat keeps advancing to
  the `checks` phase.
- Completion is driven by the child `close` event (not `exit`), so trailing
  stdout bytes that arrive after `exit` are still parsed; the bounded `SIGKILL`
  escalation is not cancelled just because the direct child exited.
- Worker stdout/stderr (and the persisted artifacts) are capped (8 MiB default).
  Overflow is reported explicitly (`outputTruncated`, `workerError`) and the
  receipt is never claimed complete. A synchronous spawn throw, a stream error
  or a disk-persistence failure produce a recoverable failed result with the
  evidence still captured.

Malformed or partial event lines, and child startup errors, still produce an
inspectable failed result with the artifacts on disk.

### Repair lineage
There are **no automatic retries or restarts**. A repair is an explicit task
with `repairFrom` (a prior `result.json`) instead of `resumeFrom`. It reuses the
prior Pi session, defaults to at most one repair (`maxRepairs`), and persists a
lineage counter (`rootId`, `repairs`, `maxRepairs`, `deadlineAt`) in every
result. A repair over budget, or one whose inherited lineage deadline has
already elapsed, is rejected **before any paid call**. An optional
`lineageDeadlineMs` sets one absolute lineage deadline for the whole chain.

### Compact handoff
`junior.ts handoff` (or `status` without `--full`) prints one small object: `id`,
`outcome`, `source` and preserved `sourceCwd`/`execution` cwd, artifact
location, changed file paths, compact check results, unresolved issues,
requested/observed model, token totals (including `cacheRead`/`cacheWrite`),
honest cost (`billedUsd` always `null`) and the runtime stop reason. A zero raw
Pi catalog cost is **not** reported as a known charge (`cost.available` is only
true for a real estimate or a strictly positive Pi-reported total). Repeated
per-event stop reasons are deduplicated into `runtime.stopReasonSummary`.
The full receipt, events, evidence and runtime heartbeat stay in the artifact
files (`events.jsonl`, `worker.log`, `runtime.json`, `evidence.json`,
`result.json`) and are available through `status --full`.

### Prompt search restriction
The common prompt restricts file reads and searches to the execution checkout
and to context/dependency paths named in the task, and instructs the worker to
stop and report a blocker rather than widening the search or performing a broad
filesystem search. This is an **instruction to the worker, not a sandbox
guarantee**.

## Jev readiness and completion gates
Jev gates are opt-in per task and default off:

```json
{ "jev": { "mode": "shadow" } }
```

- `off` (default): no classifier call.
- `shadow`: run the gates, record the answers, and continue. The task outcome is
  unchanged.
- `enforce`: run the gates and, for an otherwise-passing run, block readiness by
  reporting `needs_review`. A failing preflight stops the worker before it
  starts. Gates can only downgrade an otherwise-passing run; they can never
  upgrade `worker_failed`, `receipt_failed`, or `checks_failed`.

The gates use the installed Pi SDK's `modelRegistry.classify` with the
OpenRouter `typesafe/jev-1.13` classifier, reusing normal Pi `AuthStorage`. They
make no premium chat call. If the local catalog lacks the entry, an explicit
`{ provider, id }` model is supplied (Pi's `classify` uses only those fields).

- Preflight (readiness) assesses contract clarity and unresolved assumptions
  before the worker starts.
- Postflight (completion) assesses each acceptance criterion against the
  independent check results and bounded `git diff` evidence (capped output).
- A classifier outage or an answer below the confidence threshold is
  `uncertain`; in `enforce` mode uncertainty marks the run `needs_review`.

The result's `jev` record holds the mode, classifier model and whether it was
explicit, whether the gate ran, the preflight/postflight statuses, the raw
answers, classifier usage (with the same availability distinction as receipts),
any error, and actionable criterion IDs (`gapIds`, `uncertainIds`) for parent
review. Repairs are explicit and budgeted (see **Repair lineage**); there is no
automatic repair.

Passing checks and gates means ready for review, not accepted. This prototype
runs one worker synchronously and independent checks. It does not implement
dependencies, sandboxing, or parallel jobs, and it makes no claim of independent
upstream attestation or full code correctness. Automatic retries and restarts
are deliberately absent (see below); repairs are explicit and budgeted.

## Premium-model delegation skill

The canonical skill is `skills/junior/SKILL.md`. It teaches the manager to
locate the `junior.ts` CLI, define one bounded deliverable, delegate to
DeepSeek, review the compact receipt and explicitly bounded repair, and accept
the result. `junior init` installs it into the project for both managers:
`.agents/skills/junior` for Codex and `.claude/skills/junior` for Claude Code.
Use `--user` for `HOME/.agents/skills/junior` and `HOME/.claude/skills/junior`,
or `--skill-root DIR` for an explicit user skill root (for example a Windows
manager directory).

Codex discovers project skills under `.agents/skills` (official reference:
<https://learn.chatgpt.com/docs/build-skills>). Claude Code discovers project
skills under `.claude/skills` and user skills under `~/.claude/skills` (the same
locations `junior init` writes). Copies need updating when the canonical skill
changes; `init --upgrade` replaces only the unmodified installed copy, while
`--force` is required for a customization.

Invoke it explicitly with `$junior` in Codex or `/junior` in Claude Code, for
example: “Use Junior to implement this deliverable; you manage and review it.”
Newly installed skills may require a new session. Skill discovery is a hint;
explicit invocation is the clearest way to select this workflow.

The project is named Junior; its existing `delivery-worker` directory and
`node worker.ts` commands are retained to preserve saved artifact/session paths.
Testing convention: all newly written or changed tests use atomic scenarios, declarative names, and exactly one behavioral assertion per test against public deliverable behavior. Use a proportionate testing pyramid: focused tests first, integration tests for real boundaries, and essential end-to-end acceptance checks. Avoid implementation-detail assertions, bundled unrelated assertions, duplicated layers, and unrelated rewrites of existing suites. The shared prompt applies this policy in every workflow, including TDD.

## Common tool handoffs

`node junior.ts tools init hop.json config.json`, `tools call hop.json fmeca|cpm|crossmatrix request.json`, and `tools inspect hop.json` expose the same persistent Praxec adapter to managers and workers. See [tool configuration and native state](tools/README.md). Add `hopFrom` to a delivery contract to provide the latest integrity-checked snapshots to both Jev gates and the worker, without loading transcripts. Context is bounded to the latest snapshot per tool. State changes invalidate previous acceptance; workers never accept their own work. Manager acceptance is an explicit library operation, not authentication or a security boundary.

Use `thinking: "low"` (the default) for bounded worker tasks; increase it explicitly for difficult deliverables. Output-limit termination is a failed receipt, even when existing checks pass. Newly written tests follow the shared atomic, declarative, one-behavioral-assertion convention.

Optional QA: `node junior.ts qa qa-contract.json` (or a `handoff` contract with `workflow: "qa"`) requires `reviewFrom` pointing at a prior result. It starts a fresh reviewer session, reviews in place, saves an evidence-based report, and flags detected production edits. Missing reports cannot succeed. Review completion is not manager acceptance; repairs require a separate deliverable. A prompt restriction is not an OS sandbox. QA checks should be read-only; it has the same filesystem permissions as the executor.

Development: `npm test` runs the offline public-behavior suites. No npm dependencies are needed. The legacy `worker.ts` CLI remains supported; `junior.ts` is the compact manager entry point. Runtime, evidence, isolation, setup, and tool adapters share one implementation each.

Private release repositories (including TRIZ) require `GH_TOKEN` or `GITHUB_TOKEN` with repository read access. Junior sends it only to the GitHub API host and drops authorization on asset redirects. Public Praxec releases require no token.

### Frontier-attention classification

Jev preflight asks `requires_frontier` in the same classification call as readiness. The `attention` field in the compact handoff reports `frontier_required`, `delegate`, `clarify`, or `uncertain` with a target, reason and raw probability. Enforce mode stops frontier-required, missing or uncertain readiness before starting the worker; shadow mode records it and continues. Off remains the default. No frontier model is automatically called. Classification is advisory evidence, not a calibrated capability guarantee.
