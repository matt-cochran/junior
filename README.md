# Junior — deliverable delegation
Run inside Ubuntu WSL with Node 22.19 or newer (Node 26.5 is the tested
version; load nvm first, for example `nvm use 24`).

node --test worker.test.ts
node worker.ts doctor
node worker.ts init [--install]
node worker.ts validate smoke.json
node worker.ts run smoke.json --mock
node worker.ts status .delivery/<id>/<timestamp>/result.json

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

## Setup
- Node 22.19 or newer (`node --test`, `node worker.ts`); the worker is tested on
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

The result includes `checks` (one entry per prerequisite) and `remediation`
strings. If `pi` is missing it recommends `init --install`; if credentials are
missing it recommends `pi` then `/login` and `/model`.

### `node worker.ts init`
Idempotent project setup. It creates, only when absent:

- `delivery.config.json` with the project defaults (`provider`, `model`, and the
  pinned tested Pi version (1.0.3)).
- `tasks/example-task.json` with a runnable example contract.

Existing files are preserved and global auth/model configuration is never
touched. `run` loads `delivery.config.json` from the task's resolved `cwd`; an
explicit task `provider`/`model` always takes precedence over the defaults.

`init` reports readiness honestly: it runs the same checks as `doctor` and
returns `ready`, plus `instructions` when something is missing.

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
`test_first`, `checks_first` or `auto` (the default when omitted). An explicit
value always wins and the classifier is not asked:

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
- `auto`: ask Jev exactly one `choice` question (with the fixed descriptions
  above, in the same readiness classify call) and use a confident answer. A
  below-threshold answer, a classifier outage, or no classifier defaults to the
  inspect-first `checks_first` and records the recommendation.

The final prompt is always assembled from a fixed common block and the fixed
workflow block plus the task contract JSON. No Jev-generated prose is inserted.
Each run saves `prompt.txt` and `workflow.json` (selected template IDs and the
workflow decision) in its artifact directory, and the result carries `workflow`
and `templates`.

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
review. There is no automatic repair yet.

Passing checks and gates means ready for review, not accepted. This prototype
runs one worker synchronously and independent checks. It does not implement
dependencies, automatic repairs, sandboxing, or parallel jobs, and it makes no
claim of independent upstream attestation or full code correctness.

## Premium-model delegation skill

The canonical skill is `skills/junior/SKILL.md`. It teaches the manager to define
one bounded deliverable, delegate to DeepSeek, inspect evidence and accept the
result. Install the folder as `~/.codex/skills/junior` for Codex or
`~/.claude/skills/junior` for Claude Code. Windows Codex uses its Windows user
skill directory. Copies need updating when the canonical skill changes.

Invoke it explicitly with `$junior` in Codex or `/junior` in Claude Code, for
example: “Use Junior to implement this deliverable; you manage and review it.”
Newly installed skills may require a new session. Skill discovery is a hint;
explicit invocation is the clearest way to select this workflow.

The project is named Junior; its existing `delivery-worker` directory and
`node worker.ts` commands are retained to preserve saved artifact/session paths.