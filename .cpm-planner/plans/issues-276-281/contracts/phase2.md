# Phase 2 contract: a machine that stays responsive, lanes that start warm, evidence you reuse (0.20.0)

Issues: #277 (admission control), #278 (warm builds), #280 (evidence identity,
`junior land`, review-queue aging). Integration branch: `integration/0.20.0`
(phase 1 shipped as 0.19.0, so this phase is 0.20.0). Every lane branches from
it after C2 lands, and owns only the files listed. Lanes do not touch
`package.json` or `CHANGELOG.md`: CAND2 registers new test files and writes the
changelog from the lane receipts.

C2 already landed these seams (full suite green, 4,122 tests):

| Seam | File | State |
|---|---|---|
| `MachineConfig`, `ResolvedMachineConfig`, `AdmissionWait`, `AdmissionRequest`, `AdmissionResult`, `AdmissionSnapshot`, `DEFAULT_MACHINE_CONFIG`, `validateMachineConfig`, `resolveMachineConfig`, `poolFor`, `admit`, `admissionSnapshot` | `admission.ts` | stubs: `admit` grants at once, `resolveMachineConfig` returns `enabled:false` |
| contract field `machine` | `worker-contract.ts` | in `TASK_FIELDS`; `validate()` calls `validateMachineConfig` |
| `RunState.admissionWaits`, `RunState.admissionTimeout` | `worker-preflight.ts` | typed; `result.admissionWaits`, `result.admissionTimeout`; terminal status `admission_timeout` in `worker-outcome.ts`; compact `admission: {waitedMs, reasons}` |
| runtime phase `admission`, snapshot field `admission` | `runtime-process.ts` | typed; set it with `heartbeat.update({phase:'admission', admission})` while waiting, `admission:null` after |
| `WarmFrom`, `WarmStartResult`, `validateWarmFrom`, `warmStart` | `warm-start.ts` | stubs: validation accepts anything, `warmStart` returns `warm:false` |
| `isolationSetup.warmFrom` | `isolation.ts` | in `SETUP_FIELDS` and the type; `validateIsolationSetup` calls `validateWarmFrom` |
| warm-start call | `worker-preflight.ts` `provisionWorktree` | after `provisionIsolationSetup`; sets `state.warmStart`, attached as `result.warmStart` |
| `EvidenceIdentity`, `CheckPhase`, `CheckTiming` | `worker-receipt.ts` | types |
| `checkIdentity`, `identityEqual`, `classifyCheck`, `checkTiming` | `evidence-identity.ts` | stubs: null, false, `'other'`, zeros |
| per-check `phase`, `durationMs`, `identity` | `worker-checks.ts` | every executed check carries them; `result.timing = checkTiming(...)`; compact checks carry `phase`, `durationMs`, compact `timing` |
| `ReviewQueueConfig`, `AgingReview`, `ReviewQueueReport`, `validateReviewQueueConfig`, `agingReviews`, `reviewQueue` | `review-queue.ts` | stubs: empty lists |

Rules for every lane: production-grade code, no TODOs or placeholders, every
new branch covered by a test with one behavioural assertion against a public
outcome, injected clock (`clock.ts`) for any time logic, no new dependency, no
real `/proc`, home directory or network in tests (inject `procRoot`,
`stateDir`, `spawn`).

## 1. Admission core (M1): `admission.ts`, `admission.test.ts`

- **Config.** `machine` in `delivery.config.json` (read beside the other
  project keys), then the contract's `machine` field by field, over
  `DEFAULT_MACHINE_CONFIG`. `JUNIOR_ADMISSION=off` in the environment, or
  `enabled:false`, turns admission off and `admit` grants at once.
  `validateMachineConfig` rejects an unknown key, a non-positive integer
  `slots` or pool `limit`, a negative number, and a pool without a non-empty
  `match` array of strings.
- **Slots.** The state dir is `opts.stateDir`, else `$JUNIOR_STATE_DIR`, else
  `~/.junior`, then `admission/`. One file per held slot:
  `slots/<n>.json` for machine slots `0..slots-1` and `pools/<pool>/<n>.json`
  for pool slots, each created with `O_EXCL` (`writeFileSync(..., {flag:'wx'})`)
  holding `{holder, pid, kind, pool, acquiredAt}`. A slot whose `pid` is not
  alive (`process.kill(pid, 0)` throws `ESRCH`) is stale: remove it and retry.
  A pool slot is taken first, then a machine slot; if the machine slot is not
  available, release the pool slot before waiting again (no hold-and-wait).
- **Pressure.** Read `<procRoot>/meminfo` `MemAvailable` (kB → MB) and the
  `pswpout` counter in `<procRoot>/vmstat` twice, one second apart on the
  injected clock, for pages per second. A missing or unreadable file means
  "unknown", which never blocks (macOS, Windows). Memory or swap over its
  threshold blocks every new admission.
- **Pools.** `poolFor(argv, config)` returns the first pool (in key order)
  whose `match` entry equals the joined argv or is a prefix of it at a word
  boundary, after `stripCommandPrefixes` from `command-policy.ts` so
  `env`/`timeout`/`nice` cannot hide the command. Workers never take a pool.
- **Waiting.** `admit` polls every 2 s on the injected clock, calls
  `onWait` when it starts waiting and whenever the reason or detail changes,
  and returns `E_ADMISSION_TIMEOUT` after `admissionTimeoutMs` or
  `E_ADMISSION_INTERRUPTED` when `signal` aborts. `grant.release()` deletes
  its files and is idempotent. Install no process exit handler: stale-pid
  recovery covers a crashed holder.
- `admissionSnapshot` reads the same files and pressure without taking
  anything; it lists live holders only.

Tests use a temp `stateDir`, a fake `procRoot` and `createManualClock`: slots
fill and the next request waits with reason `slots`; a released slot admits
the waiter; a dead-pid slot is reclaimed; a pool limit of 2 makes a third
`dotnet test` wait with reason `pool` while an `npm test` is admitted; low
`MemAvailable` waits with reason `memory`; a timeout returns
`E_ADMISSION_TIMEOUT`; `enabled:false` grants at once.

## 2. Admission wiring (M2): `worker-launch.ts`, `worker-launch.test.ts`, `worker-checks.ts`, `worker-checks.test.ts`

- Both files call `resolveMachineConfig(sourceCwd, t)` once per phase.
- `launch`: before Pi starts (live and streaming paths only; mock and the
  legacy `spawnPi` seam skip admission), `admit({kind:'worker', holder:`${t.id}:worker`, ...})`.
  While waiting: `heartbeat.update({phase:'admission', admission:wait})` and
  `emit('waiting for admission: <detail>')`; push each wait (with its
  `waitedMs` once admitted) to `state.admissionWaits`. On timeout or
  interrupt, do not spawn Pi, set `state.admissionTimeout = {kind:'worker', ...}`
  and a non-zero `workerStatus`, so the run ends `admission_timeout`
  (interrupt still ends `interrupted`). Release the worker slot as soon as Pi
  exits, before checks start: a run never holds two machine slots.
- `runChecks`: around each `executeCheck`, `admit({kind:'check', argv,
  holder:`${t.id}:check-${i}`, signal, ...})`, release when the check exits
  (`try/finally`). A timeout records the check with `refused:'E_ADMISSION_TIMEOUT'`,
  `exitCode:null`, sets `state.admissionTimeout = {kind:'check', checkIndex:i, ...}`
  and stops the loop. Admission wait time does not count toward the check's
  own `timeoutMs`, but the wait is bounded by the remaining run deadline
  (`Math.min(admissionTimeoutMs, remainingMs(state))`).
- Inject `admit` through `deps.admit` (default the real one) so the tests use a
  fake.

## 3. Warm start (W1): `warm-start.ts`, `warm-start.test.ts`, `worker-preflight.ts`, `worker-isolation.test.ts`

- `validateWarmFrom`: an object with a non-empty string `path` and optional
  `include`/`exclude` arrays of non-empty relative globs; unknown keys are
  errors. Default `include` is `["**/obj/"]`; to warm `bin/` too, list
  `"**/bin/"`.
- `warmStart`: resolve `path` against `sourceCwd`; a missing directory is
  `warm:false` with `reason`, never an error. Walk it (skipping `.git` and
  `node_modules`), select directories matching an `include` glob (use
  `globToRegExp`/`matchesAppliesTo` from `adr.ts`) and not an `exclude`, and
  copy each into the same relative path in the worktree with
  `cpSync(src, dest, {recursive:true, mode: fs.constants.COPYFILE_FICLONE})`
  (reflink where the filesystem supports it, a plain copy elsewhere). Report
  `method:'reflink'` only when a probe `copyFileSync(..., COPYFILE_FICLONE_FORCE)`
  succeeds on the first file, else `'copy'`. Never create a symlink; skip a
  symlink found in the source. Stop at `deadlineAt` with what was copied and a
  `reason`. Count files and bytes.
- `worker-preflight.ts`: the call is in place; make copied directories
  invisible to change evidence by adding them to the `excludePatterns` passed
  to `ensureLocalExcludes`, the same way `copy` entries are.
- `worker-isolation.test.ts`: a worktree run with `warmFrom` on a fixture whose
  source tree has `src/App/obj/cache.bin` ends with that file in the worktree,
  `result.warmStart.warm === true`, and it is not in the run's changed files.

## 4. Evidence identity (E1): `evidence-identity.ts`, `evidence-identity.test.ts`, `worker-receipt.ts`

- `classifyCheck(argv)`: `'build'` when `isBuildCommand(argv)` (from
  `command-guards.ts`) is true or the argv is `tsc` with `--noEmit`,
  `dotnet build`, `cargo check`; `'test'` for `node --test`, `npm test`,
  `npm run test*`, `npx jest|vitest`, `pytest`, `dotnet test`, `cargo test`,
  `go test`, `mvn test`, `gradle test`; else `'other'`. Strip prefixes first.
- `checkIdentity({cwd, check, touchedFiles?})`: `touchedFiles` defaults to the
  changed and untracked paths from `git status --porcelain=v1 -z` in `cwd`.
  A file's project is its nearest ancestor directory (within the repo) holding
  `package.json`, `*.csproj`, `*.fsproj`, `Cargo.toml`, `go.mod`,
  `pyproject.toml`, `pom.xml` or `build.gradle*`; the root is `.`. With no
  touched files, the project is the check's `cwd` project. `tree` is
  `sha256:` over sorted `<dir>:<tree>` lines where `<tree>` comes from a
  temporary index (`GIT_INDEX_FILE` in `os.tmpdir()`, `git read-tree HEAD`,
  `git add -A -- <dir>`, `git write-tree`, `git rev-parse <tree>:<dir>`), so
  uncommitted edits count; remove the temp index. `filter` is the value after
  `--filter`, `-t`, `--testNamePattern`, `-k`, or the test file paths in the
  argv, joined by spaces; null when none. `dependencyLock` hashes, in path
  order, every lockfile found in the projects and the repo root
  (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`,
  `go.sum`, `poetry.lock`, `uv.lock`, `packages.lock.json`, `global.json`,
  `Directory.Packages.props`). `toolchain` is the first-line version of the
  check's tool (`node --version` for node/npm/npx, `dotnet --version`, ...) via
  the injectable `toolVersion`. On a git failure `tree` is
  `unknown:<reason>`; the function never throws.
- `identityEqual` compares every field; any `unknown:` tree is never equal.
- `checkTiming` sums `durationMs` by `phase` (missing phase counts as other).
- `worker-receipt.ts`: keep the types; add JSDoc only if a field's meaning
  changes. The compact receipt (`handoff.ts`) is already wired.

Tests: a fixture git repo with two packages; editing one changes only that
project's tree; an untracked file changes the tree; two calls on the same tree
are `identityEqual`; a changed lockfile breaks equality; `-t` and `--filter`
are captured; classify covers each family with one case.

## 5. junior land (E2): `land.ts`, `land.test.ts`, `junior.ts`, `cli.test.ts`

`junior land <result.json|id>... --into <dir> [--compile <command...>] [--dry-run]`

- `--into` is an integration checkout (a branch worktree), which must be clean.
- For each lane in the given order: refuse it (`E_LAND_NOT_READY`) unless its
  status is `ready_for_review`; apply its patch with `applyHandoff` from
  `apply.ts` with `cwd:<into>` (stop the batch at the first apply conflict,
  name it, and leave the earlier lanes applied). Do not commit.
- After all lanes apply, for each lane's executed checks, recompute
  `checkIdentity({cwd:<into>, check, touchedFiles:<that lane's changed files>})`
  and compare with the stored `identity`: equal → `reused`, otherwise `stale`
  with the differing fields. A check with no stored identity is `stale`
  (`reason:'no identity'`).
- Run one compile-only check for the batch: `--compile`, else the
  `delivery.config.json` `land.compile` argv, else the first `phase:'build'`
  check from the landed contracts, else none (reported as `compile:null`,
  with a `warnings` entry; `ok` can still be true).
  It goes through `admit` like any check.
- Write `land-report.json` into `<into>/.delivery/land/<timestamp>/` and print
  it: `{lanes:[{id, applied, checks:[{command, verdict, changed?}]}], compile,
  rerun:[<argv of each stale check>], ok}`. `ok` is true only when every lane
  applied and the compile passed. Exit 0 on ok, 1 otherwise.
- `junior.ts`: register `land` in the command table and the help text.
  `junior status` with no file prints the review-queue report
  (`reviewQueue({cwd})`), and `junior status <result.json>` additionally lists
  aged reviews on stderr when any exist. Change `status` to `min: 0`.

## 6. Review-queue aging (E3): `review-queue.ts`, `review-queue.test.ts`

- Config `reviewQueue` from `delivery.config.json`: `agingMinutes` (positive
  number, default 30) and `notify` (`{command, args?}`).
- `agingReviews`: scan `<deliveryDir>/<id>/<ts>/result.json` (the layout
  `junior prune` reads in `retention.ts`), keep `status === 'ready_for_review'` whose run end
  time (`runtime.finishedAt`, else file mtime) is older than the threshold on
  the injected clock and that has no `applied.json` beside it (what
  `applyHandoff` writes; check `apply.ts`) or newer run of the same id that is
  applied. `next` is `junior apply <resultPath>`. Oldest first.
- `reviewQueue`: compute, then for each aged id not in
  `<deliveryDir>/review-queue.json`'s `notified` list, run the notify argv
  (no shell, 10 s timeout, JSON on stdin), record success in that file; a
  failure goes to `notifyErrors` and is retried next time.

## 7. Doctor (DR1): `setup-doctor.ts`, `doctor.test.ts`

- Add an `admission` block to `junior doctor` output:
  `admissionSnapshot({config: resolveMachineConfig(cwd)})`, plus a warning
  when pressure is over a threshold right now (`memory pressure: available X MB
  < Y MB`) or slots are all held.
- Cold-build warning: read the newest 20 `result.json` under `.delivery`; when
  at least 3 ran with worktree isolation, `timing.warm === false` and
  `timing.buildMs` ≥ 60,000, and neither the contracts nor
  `delivery.config.json` set `isolationSetup.warmFrom`, warn `checks build
  cold in worktrees (median build N s); set isolationSetup.warmFrom` with the
  docs pointer `docs/runtime.md#warm-start`. Readiness stays true: these are
  warnings.

## 8. Docs (DOC2): `docs/runtime.md`, `docs/contracts.md`

Document §1–§7 for users: admission (slots, pools, pressure gate, defaults,
`JUNIOR_ADMISSION=off`, `admission_timeout`, the waiting phase in
`status --live`), `isolationSetup.warmFrom` (anchor `#warm-start`; copy never
symlink, reflink), evidence identity and timing on receipts, `junior land`,
`junior status` review queue and `reviewQueue.notify`, and the doctor
warnings. Contract field `machine` in `docs/contracts.md`.

## Gate (GATE2)

On `integration/0.20.0` after CAND2: `npm run build`, full `npm test`. Then
a local smoke, all `--mock` or offline where possible: three concurrent
`node --test` checks through `admit` with a pool limit of 2 showing one wait;
a worktree handoff (`--mock`) with `warmFrom` showing `warm:true`; and a
`junior land` of a mock lane reusing its check evidence (`reused`).
