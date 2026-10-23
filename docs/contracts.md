# Contracts

[Back to the README](../README.md)

#### Contract fields and unknown keys
`validate` recognizes exactly the supported top-level fields (`id`,
`deliverable`, `cwd`, `acceptance`, `checks`, `constraints`, `context`,
`provider`, `model`, `thinking`, `pricing`, `billing`, `jev`, `workflow`,
`isolation`, `isolationSetup`, `resumeFrom`, `repairFrom`,
`reviewFrom`, `maxRepairs`, `lineageDeadlineMs`, `preparedFrom`, `checkBack`,
`plan`, `hopFrom`, `hopRevision`, `hopContext`, `piContext`, `clarifiedFrom`,
`scope`, `execution`, and the six execution settings directly:
`deadlineMs`, `quietMs`, `toolTimeoutMs`, `heartbeatMs`, `checkTimeoutMs`,
`checkReserveMs`).
A misspelled or unsupported top-level key is rejected with `Unknown contract
field: <key>` rather than silently ignored, and each check accepts only
`command`, `args` and `cwd` (an unknown check key is rejected with `Unknown
check field: <key>`). Nested known fields (for example `execution.quietMs`,
`jev.mode` and `pricing.source`) remain supported.

`plan: {id, deliverable, callerId?}` links the contract to a cpm plan
deliverable and requires `hopFrom`. `handoff` then leases that deliverable
(`plan.acquire_cohort`, caller `junior-worker` unless `callerId` is given, TTL
the run deadline plus an hour) before the worker starts and refuses with
`plan_lease_refused` when it is not leased. Afterwards it calls
`plan.mark_status`: `in_progress` with the run's wall hours and an evidence line
(artifact directory, outcome, observed model) on success, leaving the lease for
the manager to review and complete, or `failed` with the reason. A lease the same
caller already holds is re-entered (`plan.reentered`), so a repair or a re-run
after a clarify works; a `needs_answers` or `needs_choice` result keeps the
lease and marks nothing. The contract is validated before the plan is touched.
The receipt gains a `plan` block.

A contract should normally omit `provider` and `model` so the commodity roster
and Jev routing choose the executor:

```json
{
  "id": "unique-deliverable-id",
  "deliverable": "A precise artifact and resulting behavior",
  "cwd": "/absolute/target/checkout",
  "workflow": "test_first",
  "acceptance": ["Observable behavior to verify"],
  "checks": [{ "command": "node", "args": ["--test", "relevant.test.ts"] }],
  "constraints": ["Only modify the named files; no commits or pushes"],
  "isolation": "worktree",
  "jev": { "mode": "shadow" }
}
```

Provider/model resolution, the roster and routing are in [Models](models.md);
shaping a cpm plan into these contracts is in
[Planning for Junior](planning.md). An explicit task `model` always wins and
must be a commodity/open-weight model.

#### Check working directory (`checks[].cwd`)
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

#### Contract code context (`context`)
A contract may name excerpts for the worker and the Jev readiness gate to read
without opening whole files:

```json
"context": [
  { "path": "src/worker.ts", "start": 120, "end": 180 },
  { "path": "README.md" }
]
```

Each entry is `{ path, start?, end? }`. `path` is relative to the contract
`cwd` and must stay inside it; `start`/`end` are 1-based inclusive line bounds
(defaulting to the whole file). At most 20 entries are accepted; each excerpt
is capped at 200 lines and 40000 characters in total, and a capped excerpt is
marked `truncated`. Unknown entry fields, absolute or escaping paths, and
non-positive or reversed bounds are rejected before any paid call. Resolution
never throws: an unreadable file becomes an `error` entry and an `end` past the
file length is clamped. Resolved excerpts are rendered in the worker prompt
under `Code context` and passed to the preflight gate; they are excerpts, not
the full files.

#### Pi context (`piContext`)
Every non-mock run probes `pi --help` and passes the isolation flags the
installed Pi supports: `--no-extensions`, `--no-skills`,
`--no-context-files`, `--no-prompt-templates`, `--no-approve` and `--no-mcp`.
Unless the contract says otherwise, it also passes
`--tools read,bash,edit,write`. This keeps the worker from inheriting unrelated
project skills, extensions, context files, prompt templates, trust and MCP
servers. The tested Pi release is 1.4.0.

`piContext` changes that baseline:

```json
"piContext": {
  "ambient": false,
  "tools": ["read", "bash", "edit", "write"],
  "skills": ["skills/example"],
  "contextFiles": ["docs/context.md"],
  "extensions": ["extensions/example.ts"]
}
```

- `ambient: true` keeps Pi's ambient setup and passes no isolation flags.
- `tools` replaces the default built-in tool list.
- `skills`, `contextFiles` and `extensions` forward explicit user choices; they
  are not ambient discovery.

A flag the installed Pi does not advertise is recorded as missing, not passed.
The result and compact handoff carry `piIsolation` with `applied`, `missing`,
`ambient` and `probed`, plus `honored` in the handoff: after the run Junior
reads Pi's own system message and reports `isolation not honored: ...` in
`unresolved` when ambient skills or tools outside the allowlist still appear.
`junior doctor` reports any missing isolation flag in its remediation text.

#### Scope check (`scope`)
`scope` declares the files a run may change:

```json
"scope": {
  "owned": ["src/worker.ts", { "path": "src/scope-check.ts", "mode": "write" }],
  "incidental": ["package-lock.json", "**/*.snap"]
}
```

`owned` is required when `scope` is present. Entries are path strings, objects
with a `path` (a `mode` value is accepted but does not change scope matching),
or repo-prefixed entries such as `api:src/a.ts`. `incidental` overrides the
default lockfile and snapshot globs for this contract.

When `scope` is omitted, `junior plan contracts` still fills `scope.owned` from
the plan deliverable's `owned_files`. The project `delivery.config.json` can set
`scope.incidental` to replace the default incidental globs for every run.

After the run, the result carries `scope` with `checked`, `inScope`,
`incidental` and `outOfScope`. The compact handoff keeps the same block, and
each out-of-scope path adds an unresolved line `out of scope: <paths>`. Scope is
reported for review; it does not change the run status.


### Micro-deliverable stages
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


### Workflow templates
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

#### Analysis report lifecycle
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


### Session continuation
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


### Contract clarity before delegation
An explicit-workflow contract can still be unclear. When the readiness decision
is clarify on `contract_clear` (below 0.6), Junior stops at
`needs_answers` before a worker starts and writes the question batch to
`clarify.json`/`clarify.md`. The confidence threshold is `0.6`. A clarify on
`blocking_assumptions` alone does not stop an explicit workflow: that answer is
at or above 0.6 on 94% of runs that came back clean (ADR 0009 amendment).

Answer the batch in a JSON file and re-run:

```bash
junior handoff task.json --answers answers.json
```

For an explicit workflow, a ready round returns outcome `contract` and writes
`clarified-contract.json`. That contract keeps the requested `workflow`, adds
one `Clarified Qn: ... -> stance: answer` constraint per answered question from
every round, and sets `clarifiedFrom` to the clarify batch path. Pass the
clarified contract to the next handoff.

`checkBack: "off"` opts out of the gate. A contract with `preparedFrom` or
`clarifiedFrom` does not re-enter it. A contract with `workflow: "auto"` keeps
the existing prepare and vague-feature rules.

`junior plan check <plan.json> --jev` runs the same readiness check on each
planned contract and adds a paid, opt-in `quality` report; see
[Planning for Junior](planning.md).


### Jev readiness and completion gates
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

#### Acceptance entries and tracing
An acceptance entry is a plain string or an object. The object fields are:

- `text` (required, non-empty): the observable outcome.
- `id` (optional): the criterion id, matching `^[A-Za-z0-9:._/-]{1,128}$` and
  unique within the contract. `validate` rejects an invalid or duplicate id.
- `when` (optional, non-empty): the condition under which the criterion
  applies.
- `checks` (optional): 0-based indexes into the contract's `checks` array.
  `validate` rejects an index outside that array. A criterion is
  `check_passed` only when it names at least one check and every named check ran
  in this run and exited 0.
- `mitigates` (optional): `"<session_id>/<mitigation_id>"` strings naming the
  fmeca mitigations this criterion verifies. The link lives only on the
  criterion; fmeca stores no link back.

When a criterion has no `id` the result reports it as `AC<n>` (1-based
position). A supplied id is kept verbatim from the plan file to the contract,
the prompt and `result.json`, so reordering criteria does not renumber them.
`spec-bridge` assigns `<requirement id>/ac<n>` when it writes a draft plan (for
example `req:c1/ac2`); the plan file is the definition after that. `junior
fmeca propose-verified <result.json|run id>` prints one ready
`set_mitigation_status` request per (criterion, mitigation) pair whose verdict
is `met` at tier `check_passed`; it never calls fmeca.

A conditional criterion is assessed in two steps: whether its `when` condition
was actually exercised, then whether the criterion was met. If the condition
was not exercised the criterion resolves to `not_applicable` and never counts
as a gap or an uncertainty:

```json
"acceptance": [
  "Every new file has a license header",
  { "text": "Node 18 stays supported", "when": "the change targets Node 18" }
]
```

Each criterion in the result's `jev.postflight.criteria` records `id`, `index`,
`text`, `verdict` (`met`, `gap`, `uncertain` or `not_applicable`), `probability`
(P(satisfied)), `tier` and, when set, `mitigates`, and for a conditional
criterion its `when` and `conditionProbability`. `tier` says how the verdict was
reached: `check_passed` when the criterion names `checks` and every named check
ran in this run and exited 0, `deterministic` when Junior settled it without a
model, `judged` when only the Jev postflight decided it, and `none` otherwise.
`gapIds` and `uncertainIds` list only actionable criteria, so a
`not_applicable` criterion never appears there. `validate` rejects an acceptance
object with an empty `text` or `when`.

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


### Premium-model delegation skill

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
changes; `junior init` and `junior update` replace only the unmodified installed
copy, while `--force` is required for a customization.

Invoke it explicitly with `$junior` in Codex or `/junior` in Claude Code, for
example: “Use Junior to implement this deliverable; you manage and review it.”
Newly installed skills may require a new session. Skill discovery is a hint;
explicit invocation is the clearest way to select this workflow.

The project is named Junior; its existing `delivery-worker` directory and
`node worker.ts` commands are retained to preserve saved artifact/session paths.
Testing convention: all newly written or changed tests use atomic scenarios, declarative names, and exactly one behavioral assertion per test against public deliverable behavior. Use a proportionate testing pyramid: focused tests first, integration tests for real boundaries, and essential end-to-end acceptance checks. Avoid implementation-detail assertions, bundled unrelated assertions, duplicated layers, and unrelated rewrites of existing suites. The shared prompt applies this policy in every workflow, including TDD.

