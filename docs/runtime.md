# Runtime

[Back to the README](../README.md)

### Execution receipts
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
- `finalStopReason`/`stopReasons`: the stop reason of the last assistant message
  and the ordered list for the segment. `outputLimited` is true when that final
  stop is the per-message output limit (`length`), and `errored` is true only
  when it is a genuine `error`.
- `recoveredErrors`: the count of `error`/`length` stops that a later assistant
  message followed. A recovered transient error does not fail the run; only a
  final `error` does.
- `responseIds`: unique provider response IDs Pi preserved on assistant
  `message_end` records (`message.responseId`). A live OpenRouter run populates
  these as `gen-...` generation IDs. They are the handle for obtaining
  authoritative billing, but this worker never calls a billing API; see
  [Authoritative provider billing](#authoritative-provider-billing).

Receipt metadata is Pi-reported, not independent upstream attestation. Mock runs
set `receipt.source` to `mock`, observe no model, and never claim an observed
model. A live run is `ready_for_review` only when Pi exits zero, the stream
parses, at least one assistant message ended, the final assistant message did
not stop `error`/`aborted` (a transient error followed by a later message is
recovered), Pi reported `agent_settled`, and all independent checks pass.
Otherwise the run reports `receipt_failed` even when Pi exits zero; a settled
stream with no assistant messages is rejected.


### Estimated execution cost
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
- `pricingSource`/`pricingDate` echo the supplied attribution. `billedUsd` is
  `null` unless the task opts in to authoritative billing capture (see
  [Authoritative provider billing](#authoritative-provider-billing)) and every
  relevant OpenRouter generation was accounted for; a Pi catalog cost is never
  promoted to `billedUsd`.
- This worker does not fetch live pricing and ships no authoritative rates. The
  example task `tasks/example-shadow.json` uses clearly-labelled illustrative
  rates; replace them with verified provider pricing before relying on an
  estimate.

`status` exposes the `cost` object when a saved result carries one.

#### Compact cost and token receipt
The compact manager handoff (`junior.ts handoff` or `status` without `--full`)
projects one small, truthfully-labelled cost under `model.cost`:

- `amountUsd`, `source` and `available` are the compact answer. `source` is
  `provider` for a captured authoritative provider bill, `pi_reported` for a
  finite Pi-reported total, or `estimate` for configured task pricing;
  `available` is true exactly when `amountUsd` is a finite, nonnegative number.
  Preference order is provider, then Pi-reported, then estimate. A
  Pi-reported numeric **zero** is available (a reported free call), while an
  absent, non-finite, or negative number is unknown. Pi's catalog estimate is
  never labelled `provider` (billed) cost.
- `unknownReason` is present only when no source is available and names each
  missing source separately: `missing upstream billing` (no authoritative
  provider bill was captured) and `missing Pi pricing` (Pi reported no numeric
  cost), plus the configured-pricing reason when applicable.
- `input`, `output`, `cacheRead`, `cacheWrite`, `tokens` (observed total) and
  `usageAvailable` expose the token counts without hiding the buckets.
- Legacy fields (`estimatedUsd`, `billedUsd`, `piReportedTotal`) remain for
  compatibility. `billedUsd` is null unless an authoritative provider bill was
  captured, and never carries a Pi catalog value. `billingReason` carries the
  concise reason an opted-in capture was unavailable.
- `responseIds` carries the provider generation IDs Pi preserved so a manager
  can reconcile the run against provider billing out of band.

#### Authoritative provider billing
Pi's `usage.cost` is a catalog estimate, so it is never labelled as provider
billing. A live OpenRouter run **does** preserve the OpenRouter generation ID on
each assistant `message_end` as `message.responseId` (format `gen-...`; verified
against a `pi --mode json` stream), and the receipt exposes one `generations`
entry per assistant message.

Authoritative capture is **opt-in** and off by default. A task enables it with:

```json
"billing": { "mode": "openrouter", "timeoutMs": 5000 }
```

- `mode` must be `openrouter`; `timeoutMs` is optional, positive, finite, and
  bounded (at most 600000 ms). Unknown keys and unknown modes are rejected
  before any paid call.
- When enabled, the worker looks up each unique preserved generation id against
  OpenRouter's documented endpoint
  (`GET https://openrouter.ai/api/v1/generation?id=<responseId>`) using an API
  key resolved privately from the environment (`OPENROUTER_API_KEY`) or Pi's
  AuthStorage/`auth.json`. The key, request headers, raw provider bodies and raw
  errors are never printed or written to the result.
- At most one request is made per unique generation, with no retries and a
  bounded maximum number of ids. The whole lookup is bounded by both the task's
  remaining wall deadline and `timeoutMs`; the SDK import and credential
  resolution are bounded the same way.
- `cost.billedUsd` is set and the compact `source` becomes `provider` **only**
  when every relevant OpenRouter assistant generation is accounted for with a
  matching response id and model and a finite, nonnegative `data.total_cost`.
  A reported zero is a captured bill. Missing ids, mixed providers, partial
  coverage, wrong ids/models, errors and timeouts leave `billedUsd` `null` with a
  concise `billingReason`; no estimate is ever promoted to a bill.
- Billing is an optional observation. Its failure never changes the primary run
  outcome; the limitation is recorded in the cost projection.
- Mock runs and runs without a `billing` config make no billing request.


### Git worktree isolation
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
then inspect/diff or merge it manually). In `worktree` mode the worker prompt
names only the execution checkout, and the Pi guard extension (`pi-guard.ts`)
blocks `write`/`edit` tools whose resolved path leaves the configured write
roots and blocks a `bash` command that reaches into the source checkout outside
`.delivery`. This is a tool-boundary guard, not an OS sandbox.

`isolation=worktree` refuses to start when the source checkout is dirty
(staged, unstaged or nonignored untracked changes) and reports an actionable
diagnostic instead of silently omitting edits. Because `init` records local
Git exclusions for its exact generated paths, the files it creates do not make
the source dirty. Commit or stash any other work, or use `isolation=none`.
This is **not a sandbox**: the worker runs with the same filesystem and network
access as the caller; isolation only provides a separate checkout and a clean
evidence baseline.

#### Provisioning a worktree (`isolationSetup`)
A `worktree` run can provision gitignored dependencies (for example
`node_modules` or a virtualenv) before any paid worker, classifier or check
runs:

```json
"isolation": "worktree",
"isolationSetup": {
  "links": [{ "from": "node_modules", "to": "node_modules" }],
  "copy": [".env.local"],
  "commands": [{ "command": "npm", "args": ["run", "build"], "cwd": "." }]
}
```

- `links` creates a symlink at `<worktree>/<to>` pointing at `<source>/<from>`.
- `copy` recursively copies each relative path into the worktree, preserving
  files, directories and symlinks.
- `commands` runs each command with argv (no shell) from the given `cwd`
  (relative to the worktree), bounded by the remaining wall deadline and
  `checkTimeoutMs`.

All paths must be relative and must not escape the checkout. `isolationSetup`
is ignored when `isolation` is `none`; a contract value takes precedence over
one in `delivery.config.json`. A malformed spec is rejected before any paid
call. A failed link, copy or command stops provisioning at the first failure and
ends the run with the terminal status `isolation_setup_failed` — never a check
failure and never a half-provisioned worker start. The step log is written to
`isolation-setup.log` in the artifact directory, and linked/copied paths are
added to the local Git exclude so they do not appear in change evidence.

#### Retained worktrees and `prune`
Each `worktree` run retains its linked checkout at
`.delivery/<id>/<timestamp>/worktree` for review, alongside the run's
`result.json`, `worker.log`, `events.jsonl` and `evidence.json`. The worktree is
never merged, committed or removed by the worker.

```bash
node junior.ts prune --dry-run              # report candidates only
node junior.ts prune --older-than 24h       # remove clean worktrees older than a day
node junior.ts prune --keep-last 2          # keep the two newest, remove the rest
node junior.ts prune --older-than 7d --keep-last 2
```

`prune` removes **only** inactive, clean, registered Junior worktrees and then
deregisters them; removal never passes `--force`. With no filters it removes
every eligible worktree, so run `--dry-run` first. It skips and reports:

- worktrees with unreviewed tracked or untracked changes,
- clean worktrees whose detached commits are not reachable from any retained
  source branch, tag or remote ref (an unreviewed commit is never discarded),
- worktrees held by an active `.delivery/locks/` advisory lock,
- foreign/non-Junior worktrees and the source checkout,
- paths that are symlinks or resolve outside `.delivery/`.

The artifact directory (logs and results) is preserved; only the linked
worktree checkout is removed. Before inspecting or removing a candidate,
`prune` acquires the same `checkout:<path>` advisory lock an execution uses and
releases it in `finally`, so a live run and a prune cannot race; an existing
active lock is never removed. `--older-than` takes `s`, `m`, `h` or `d`; the
filters compose so a worktree is removed only when it is older than the
duration **and** outside the last-N window. `doctor.retention` reports the
current count, disk usage and readiness note without writing.

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


#### Pi run isolation
Every non-mock run probes `pi --help` once before the first spawn and passes
the isolation flags the installed Pi advertises: `--no-extensions`,
`--no-skills`, `--no-context-files`, `--no-prompt-templates`, `--no-approve`
and `--no-mcp`. The default tool allowlist is
`--tools read,bash,edit,write`. A flag Pi does not advertise is recorded as
missing rather than passed. The tested Pi release is 1.0.4.

The contract's `piContext` can keep ambient setup (`ambient: true`), replace the
tool list, or forward explicit skills, context files and extensions. The result
and compact handoff carry `piIsolation` with `applied`, `missing`, `ambient`
and `probed`; `probed` is false when an injected offline child bypasses the CLI
probe. After the run, Junior checks Pi's first system message: ambient skills
under `--no-skills` or a tool outside the `--tools` allowlist become an
`isolation not honored: ...` line in the handoff's `unresolved` list
(`piIsolation.honored` is false), so a Pi release that ignores a flag is
reported rather than assumed. `junior doctor` reports unsupported isolation
flags in `remediation`.

Earlier worker runs inherited ambient resources: all 114 recorded runs had
received 18 unrelated ambient skills. Isolation makes the contract, not the
machine, the source of run inputs.


### Change evidence
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

#### Scope check
A contract can declare `scope.owned` (and optional `scope.incidental`) to
classify the run's changed files. `junior plan contracts` fills `scope.owned`
from the deliverable's `owned_files`; project `delivery.config.json`
`scope.incidental` overrides the default lockfile and snapshot globs.

After the run, `result.scope` and the compact handoff `scope` contain `checked`,
`inScope`, `incidental` and `outOfScope`. With no owned list, `checked` is false
and non-incidental changes are not labelled out of scope. An out-of-scope path
adds an unresolved line `out of scope: <paths>` to the handoff. Scope is
advisory evidence for review: it never changes the run status.


### Runtime, deadlines and handoff
Live runs no longer use a blocking `spawnSync` call. Pi runs as a streaming
async child in its own process group; stdout is appended live to `events.jsonl`
and stderr to `worker.log`, and a `runtime.json` heartbeat is written atomically
(tmp + rename). Tests inject an offline child, so `node --test` never makes a
paid call or installs anything.

#### Execution settings
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
| `checkReserveMs` | `min(120000, deadlineMs * 0.2)` | 0 .. 86400000 | worker-phase budget reserved so checks still run (must be < `deadlineMs`) |

`checkReserveMs` carves a reserve out of the total wall deadline for the
contract's checks. The worker phase is stopped at `deadlineAt - checkReserveMs`,
and the checks then run within the remaining budget, still bounded by the total
wall deadline. A run stopped this way still records its check results and keeps
the `deadline_exceeded` outcome — the reserve never turns a failed worker into a
success. `runtime.json` and the compact handoff expose `checkReserveMs`
alongside `deadlineMs`.

The total wall deadline starts **before** readiness, isolation and the
classifier, and covers checks, postflight and every attempt. Each phase uses the
remaining time; no success (`ready_for_review`/`simulation_passed`) is ever
reported after the deadline. The classifier SDK startup and the `git`
subprocesses used for isolation/evidence are bounded by the remaining budget; a
subprocess that is already running when the deadline passes may still take a
short bounded cleanup window, which is the strongest guarantee actually
implemented (never a harder one).

#### Runtime states
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

#### Model approval
A non-default model is never used without human consent. After the readiness
classifier recommends a model profile, or when the contract names a model that
differs from the project default, a run without a matching approval stops with
the terminal status `needs_model_approval` before the Pi worker starts. The run
writes `model-approval.json` in its artifact directory and mirrors it on the
result as `modelApproval` (`profile`, `provider`, `model`, `defaultModel`,
`confidence`, `strengths`, `reason`, `price`, and `approve.run`/`approve.project`
commands), leaves `workerExitCode` unset, records the pending route on
`modelRouting`, and exposes the request to the compact handoff as
`model.approvalRequest`. Consent can be granted for one run
(`--approve-model <key>` on `handoff`/`run`), for a plan (`approvedProfiles`), or
for the project (`models.approved` via `junior model approve`); an applied
consent is recorded as `modelRouting.approval` `{ source, key }`. With
`models.unapproved: default`, the recommendation is instead recorded without
running it (`modelRouting.declined: true`) and the run uses the default model.

#### Output cap, breakdown and continuation
The retained worker output is line-atomic: the cap is measured in bytes, but the
last accepted line that fits is kept whole rather than sliced mid-record, so
`events.jsonl` stays strict JSONL. Once the cap is reached the process group is
stopped exactly like a wall-deadline breach, `outputTruncated` is set, and the
run is reported as `output_truncated`; its checks never run because the receipt
is incomplete. A non-blank final line cut by the cap is reported as
`truncatedTail`, not as a malformed line.

Each stream result also carries an `outputBreakdown` (`rawBytes`, `retainedBytes`,
`byType` per event type, and the largest tool results). The compact handoff
projects it as `output` (`rawBytes`, `retainedBytes`, `largestToolResults`), or
`null` when the result has no stream breakdown (mock or legacy runs).

A segment that hits the accumulation cap or a final per-message output limit
(`stopReason: length`, surfaced as `receipt.outputLimited`) starts an automatic
continuation when `execution.continuations` (0-3, default 1) allows and at least
the remaining budget threshold is available. Junior writes a bounded
`checkpoint-<n>.md` (git status and diff-stat, the acceptance list and the
segment's last assistant text), starts a fresh Pi session in the same checkout
with the checkpoint appended to the prompt, and writes `events-<n>.jsonl` and
`worker-<n>.log` for the new segment. The output-limit continuation adds an
instruction to work incrementally. The receipt reflects the final segment, while
token usage, cost and provider response ids sum every segment. If the
continuation budget is exhausted and the final segment still stopped at the
per-message limit, the run records `unresolved` as
`Model hit its per-message output limit (stopReason length); split the deliverable
or reduce per-message work.` A segment stopped at the accumulation cap that
cannot continue still ends the run as `output_truncated`.

#### Repair lineage
There are **no automatic retries or restarts**. A repair is an explicit task
with `repairFrom` (a prior `result.json`) instead of `resumeFrom`. It reuses the
prior Pi session, defaults to at most one repair (`maxRepairs`), and persists a
lineage counter (`rootId`, `repairs`, `maxRepairs`, `deadlineAt`) in every
result. A repair over budget, or one whose inherited lineage deadline has
already elapsed, is rejected **before any paid call**. An optional
`lineageDeadlineMs` sets one absolute lineage deadline for the whole chain.

#### Provider routing and affinity
A deliverable stays on one model and, on OpenRouter, one upstream provider. Once
the final model is chosen and consented, the run records it in
`.delivery/<id>/route.json` (with the approval that allowed it); a later
non-resume run with the same id reuses that decision while the approval still
holds. For OpenRouter runs the run also derives a stable affinity key from the
source checkout and the lineage root id (never the deliverable id), passes it to
Pi as the `x-session-id` request header, and records it as
`providerRouting.affinityKey`, so continuation segments, repairs and
re-dispatches of one deliverable keep the same provider and its warm prompt
cache. A selected roster profile's `openrouter` provider routing (`order`,
`only`, `ignore`, `allow_fallbacks`, `sort`) is merged into the request's
provider settings and recorded as `providerRouting.openrouter`; both are null or
absent for a non-OpenRouter run.

#### Companion spawn environment
Companion tools spawn with the gateway resolver's environment: `OPENROUTER_API_KEY`
when it resolves, and `TYPESAFE_JEV_API_KEY` when a TypeSafe key resolves, both
from `companionGatewayEnv` through `companionKeyEnv`. An explicit value already
present in the hop's `tools.<tool>.env` or the process environment wins over the
derived one, and a set `CPM_OPENROUTER_KEY_FILE` suppresses the derived
`OPENROUTER_API_KEY`. These values are for the child spawn only and are never
persisted.

#### Contract clarity gate
An explicit-workflow contract whose readiness decision is clarify on
`contract_clear` (below 0.6) stops at `needs_answers` with a question batch
before a worker starts; a `blocking_assumptions` clarify alone does not. The confidence threshold is `0.6`.
`checkBack: "off"` opts out, and a contract with `preparedFrom` or
`clarifiedFrom` never re-enters the gate.

`junior handoff <task.json> --answers <file>` resolves the batch. For an
explicit workflow it returns outcome `contract` and writes
`clarified-contract.json` with the workflow unchanged, the answers from every
round as constraints, and `clarifiedFrom` set. The manager passes that contract
to the next handoff. `junior plan check <plan.json> --jev` runs the same check
on each planned contract and adds an opt-in paid `quality` report.

#### Compact handoff
`junior.ts handoff` (or `status` without `--full`) prints one small object: `id`,
`outcome`, `source` and preserved `sourceCwd`/`execution` cwd, artifact
location, changed file paths, compact check results, unresolved issues,
requested/observed model, the model `routing`/`approval`/`approvalRequest` and
its `policy`, token totals (`input`, `output`, `cacheRead`, `cacheWrite` and the
observed `tokens` total), the `cache` projection (`input`, `cacheRead`,
`cacheWrite` and the `hitRate` of cache reads over input plus cache reads), the
`upstream` provider aggregate captured by billing capture, and the labelled
compact cost (`cost.amountUsd`/`cost.source`/`cost.available`, preferring an authoritative
provider bill, then a finite Pi-reported total including a reported zero, then a
configured estimate), the preserved provider `responseIds`, and the runtime stop
reason. Pi's catalog estimate is never labelled as provider billing
(`source` is `pi_reported`), and the legacy cost fields remain for
compatibility. Repeated per-event stop reasons are deduplicated into
`runtime.stopReasonSummary`.
The full receipt, events, evidence and runtime heartbeat stay in the artifact
files (`events.jsonl`, `worker.log`, `runtime.json`, `evidence.json`,
`result.json`) and are available through `status --full`.

#### Session-start compact context
`junior compact [--json] [--max-chars N] [--cursor]` prints a session-start
block rebuilt from live local stores with no model call: the active
plan, pending decisions (`needs_answers`, `needs_choice` and
`needs_model_approval` runs with the file to read), open notes, FMECA sessions,
open scientific-process hypotheses, unresolved runs from the last 48 hours,
open PRs and capture proposals. Open PRs, the only network read, come from `gh` for this repo plus
`delivery.config.json` `compact.repos`, with a 3-second timeout; the section is
unavailable when `gh` is missing. `--max-chars` defaults to 6000 and drops
detail in this order: proposals, PRs, runs, hypotheses, risk, notes, decisions.
The active-plan section is never cut. `--json` prints the block plus
`truncated` and per-section status; `--cursor` prints only
`{additional_context}` for Cursor.

`junior setup --context-hooks [--scope local|project] [--remove]
[--harness claude|codex|cursor]` installs a Claude Code `SessionStart` hook
matching `compact|resume` that runs `junior compact`, plus a `PreCompact` hook
that runs `junior compact --capture`. Local scope writes
`.claude/settings.local.json` (the default) and project scope writes
`.claude/settings.json`; an existing file is backed up before it changes.
`--harness codex|cursor` writes `.codex/hooks.json` or `.cursor/hooks.json`
with `SessionStart` and `PreCompact` hooks instead, locally excluded when
created; Codex needs those hooks trusted in `/hooks`. After a compaction or
resume, run `junior compact` and read the block before continuing.

#### Session notes and pre-compact capture
Notes live in `.delivery/notes.jsonl`, one append-only event per line. Events
are `add`, `done`, `promote` and `dismiss`; standing is always computed by
folding the log. The file is local and never committed. Five subcommands
manage notes:

```sh
junior note add "re-check the retry budget" --kind todo
junior note list [--json]
junior note done <id>
junior note promote <id>
junior note dismiss <id>
```

`junior compact --capture` reads the PreCompact hook input as JSON on stdin.
It takes the transcript tail (at most 48000 characters), asks the project's
pinned default commodity model once through OpenRouter (`max_tokens` 1500,
temperature 0, 30-second timeout, at most 12 proposals) for open decisions,
questions, risks, hypotheses and todos, and writes them only as capture
proposals. It never routes to another profile or asks for model approval, and
it never writes FMECA, plan or scientific-process state; promoting a proposal
into one of those stores is the manager's act. Capture is fail-open: it always
exits 0 and writes one record per attempt, including skips and failures, to
`.delivery/capture/<timestamp>.json`. The record holds `captureId`, `at`,
`trigger`, `transcriptPath`, `tailChars`, `model`, `usage`, `proposals`,
`duplicates` and an optional `error`.

#### Handoff progress and live status
`junior handoff`, `junior run` and `junior qa` stream progress lines to
**stderr**, each prefixed `junior: `, so stdout stays one JSON object. Progress
follows the phases (`readiness`, `isolation`, `preflight`, `worker started`,
each check, `postflight`, `finished <status>`), plus slow-mount advisories and
periodic heartbeats. `--quiet` suppresses every progress line; it never changes
the result on stdout.

```bash
junior handoff task.json --mock          # progress on stderr
junior handoff task.json --mock --quiet  # nothing on stderr
```

`junior status <result.json|artifactDir> --live` prints a small live snapshot
directly from the run's `runtime.json` (`phase`, `state`, `elapsedMs`,
`remainingMs`, `currentTool`) without requiring `result.json` or executing
anything. It also accepts a direct `runtime.json` path. A missing or malformed
snapshot prints a concise error and exits nonzero.

#### Prompt search restriction
The common prompt restricts file reads and searches to the execution checkout
and to context/dependency paths named in the task, and instructs the worker to
stop and report a blocker rather than widening the search or performing a broad
filesystem search. This is an **instruction to the worker, not a sandbox
guarantee**.

