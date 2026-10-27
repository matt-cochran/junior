---
name: junior
description: Junior runs bounded coding deliverables on commodity models under your supervision and is the entry point to its planning and analysis toolbox: delegate a bounded coding deliverable, author and run CPM plans, assess FMECA risk, build crossmatrix traceability, run discover and investigate workflows, and resolve contradictions with TRIZ. Route any request with `junior routes "<request>"`; triggers include delegate/implement, CPM planning, FMECA risk, crossmatrix traceability, discovery, investigation and TRIZ. Companion tools run through `junior tools call`, with no MCP registration.
license: MIT
compatibility: Requires Node 22.19+, git and the junior CLI (npm @matthew-cochran/junior); delegated runs need Pi with a provider credential.
---

# Junior

You manage the deliverable; DeepSeek executes through Pi. `junior handoff` runs
one bounded task and prints a compact receipt; you review the artifacts and
accept. Keep the manager context small: contract, compact receipt, relevant diff
and check evidence.

## Choose a route

`junior routes "<request>"` ranks the routes best-first from your words, and
`junior routes --json` prints the full manifest. Pick the row that matches the
job, then follow its first command.

| Route | When | First command | Skill |
| --- | --- | --- | --- |
| `delegate` | implement, fix or hand off one bounded coding deliverable | `junior validate <task.json>` | — |
| `plan` | create, write or lint a CPM plan with owned files | `write .cpm-planner/plans/<name>/main.json` | cpm-plan |
| `plan-for-junior` | shape a plan into handoff-sized contracts and cohorts | `junior plan check <plan.json>` | — |
| `run-plan` | lease and run plan deliverables, then mark results | `junior tools call cpm plan.acquire_cohort caller_id=<id> plan_id=<id>` | cpm-run |
| `improve-plan` | fork, simulate, compare and select plan variants | `junior tools call cpm plan.fork request.json` | cpm-improve |
| `track-plan` | baseline, earned value and plan snapshots | `junior tools call cpm plan.baseline plan_id=<id> reason=<text>` | cpm-ev |
| `risk` | what could go wrong; FMECA failure modes and readiness | `junior tools call fmeca session.open request.json` | fmeca |
| `matrix` | trace requirements to tests; crossmatrix graph and QC | `junior matrix init` | crossmatrix |
| `discover` | turn a vague idea into acceptance criteria | `junior handoff <task.json>  # contract workflow: discover` | — |
| `investigate` | find root cause; frame a scientific-process experiment | `junior handoff <task.json>  # contract workflow: investigate` | — |
| `triz` | resolve a technical contradiction or trade-off | `triz analyze <request.json> --out <result.json>` | — |
| `browser-test` | verify a user journey in a real browser | `jevitate check --suite <file>` | jevitate-getting-started |
| `report-issue` | report a broken companion or managed tool upstream | `junior report-issue <tool> --title <title>` | — |
| `restore-context` | rebuild the session's working context after compaction or resume | `junior compact` | — |
| `setup` | set up, check readiness or update the project | `junior doctor` | — |
| `model` | inspect, list or approve commodity models | `junior model status` | — |

### Companion calls

Companion skills name MCP tools (`plan.status`, `session.open`, `append`,
`state.get`, `risk.next`, `crossmatrix.query`, ...); each maps to
`junior tools call <tool> <method>` through the local hop, with no MCP
registration (scientific-process sessions are opened for you in the same
process). Three forms:

- Inline, values parse as JSON: `junior tools call cpm plan.status plan_id=<id>`
- Stdin: `echo '{"tool":"plan.lint","arguments":{"path":"..."}}' | junior tools call cpm -`
- Request file: `junior tools call cpm request.json`

## Planning with Junior

1. `junior doctor` to confirm readiness.
2. Write `.cpm-planner/plans/<name>/main.json` with deliverables, `owned_files`
   and prerequisites.
3. `junior tools call cpm plan.lint path=.cpm-planner/plans/<name>/main.json`.
4. `junior tools call cpm plan.sync path=.cpm-planner/plans/<name>/main.json`.
5. `junior plan check <plan.json>` to split it into handoff-sized deliverables and safe parallel cohorts; add `--jev` for a paid plan-time clarity report.
6. `junior tools call cpm plan.status plan_id=<id>`; read the critical path and
   ready set, then `junior tools call cpm plan.schedule plan_id=<id>
   'capacities={"agent":3}'`.
7. `plan.fork`/`plan.simulate`/`plan.compare`, then `plan.select` the best variant.
8. `plan.baseline plan_id=<id> reason=<text>` before long-running execution.
9. `junior plan contracts <plan.json> --out <dir>` for skeleton contracts.
10. Lease deliverables per the Manager loop with the `cpm-plan`, `cpm-improve`,
    `cpm-run` and `cpm-ev` skills.

## Session start

Start every session with `junior doctor`; it is read-only and prints a
`readiness` object for the active harness (`--harness claude|cursor|codex`
forces one); its `warnings` and `remediation` name an outdated, customized or
missing Junior skill. Read `readiness.ready` and its `items` (Junior and companion
skills, MCP registration, managed tools, cached updates). If `ready` is false,
offer `junior setup`: it prints the ordered repair plan and, on a TTY, asks for
confirmation before applying it. `--dry-run` prints the plan only; `--yes`
applies it non-interactively, and a non-TTY run refuses to change anything
without `--yes`. Setup never shells out: each action is an argv or a
Junior-owned file write.

A cached 24-hour update check may print one stderr line on `init`, `doctor`,
`status` or `validate` covering Junior, the managed tools and the companions;
`JUNIOR_NO_UPDATE_CHECK=1` disables it. Adopt newer releases with
`junior update`, which updates Junior itself first, then every managed tool,
companion and unmodified skill.

After a compaction or resume, run `junior compact` and read the block before
continuing. It rebuilds the active plan, pending decisions with the file to
read, open notes, FMECA state, open hypotheses, recent unresolved runs, open
PRs and capture proposals from the live stores, with no model call. Work
Pending decisions first. For each Capture proposal, either `junior note promote
<id>` and then record the risk with fmeca, the hypothesis with
scientific-process or the plan change with cpm yourself, or `junior note dismiss
<id>`. Capture only writes proposals; it never writes companion stores. Use
`junior note add` for anything you must come back to. `junior setup
--context-hooks [--scope local|project] [--harness claude|codex|cursor]`
installs Claude Code `SessionStart` and `PreCompact` hooks; with `--harness
codex|cursor` it writes `.codex/hooks.json` or `.cursor/hooks.json` instead
(trust Codex hooks in `/hooks`).

## Junior as a junior engineer

Junior routes each contract from the task itself, checks back before acting
when the contract is unclear, and asks for missing information instead of
guessing.

### Routing

The readiness call asks Jev for one probability per fixed task trait. Its
answers select playbooks deterministically (for example `vague-feature`,
`decision-evaluate`, `flaky-bug`, `perf-regression`, `risky-migration`,
`ui-change`, `contradiction`, `planned-change`, `plain-change`); a playbook is
considered only when its primary trait reaches 0.5. The selected playbooks
flatten into a `toolPlan` on the receipt with per-application worker directions
and a `managerSetup` list. Reflect every manager setup item before the worker
starts: a required tool whose setup is unmet surfaces as a `tool_setup` clarify
in `jev.mode: enforce`, and the worker does not start.

### Check-back

When Jev flags an unclear contract or a blocking assumption, or a decision/plan
playbook routes, Junior runs the `prepare` workflow first and stops at
`needs_choice` with `brief.json`/`brief.md`: numbered understanding items
(`U1...`) and assumptions (`A1...`), scored options and a recommendation. Pick
one with `junior handoff <task.json> --choose <option> --correct <id>=<text>`;
each correction replaces the matching U/A item and becomes a constraint. Gating
is the contract's `checkBack`: `auto` (default), `always` or `off`. An explicit
`workflow` is never replaced by a check-back; the receipt records the
recommendation when it is not applied.

### Clarification loop

A clarify returns a `needs_answers` batch of numbered questions instead of a
result. Answer them in a JSON file and re-run:

```json
{ "Q1": { "stance": "assent", "answer": "Your answer here" } }
```

Keys must name questions in `clarify.json`; every value has only `stance`
(`assent`, `refute`, or `amend`) and a non-empty `answer`. Malformed or unknown
answers fail with exit code 64 before state changes. Run
`junior handoff <task.json> --answers <file>`; the readiness gate re-runs and
either drafts a plan (`junior matrix plan-from-spec --spec <spec.json>`) or
produces a prepare brief for `--choose`. An explicit-workflow contract whose
readiness decision is clarify on `contract_clear` (below 0.6) stops the same
way instead of starting a worker; a `blocking_assumptions` clarify alone does
not stop it. Its ready round returns outcome
`contract` and writes `clarified-contract.json` with the workflow unchanged,
the answers from every round as constraints, and `clarifiedFrom` set; pass that
contract to the next handoff. `checkBack: "off"` opts out, and a prepared or
previously clarified contract does not re-enter the gate. Never invent user
answers; unresolved questions stay unresolved.

### Analysis workflows

`discover` is an elicitation-backed requirements interview: research the
repository first, record established claims with evidence, rank open questions
by leverage with suggested answers, record contradictions and the
`readiness.assess` result, and write `analysis-report.md`. `investigate` runs one
scientific-process experiment per handoff: state or resume a hypothesis, design
the smallest refuting experiment, record the observation with raw evidence, and
recommend the next experiment. Neither changes production code.

## Investigate to ask better questions

The scientific-process loop is for deriving the next, sharper hypothesis from
each verdict, not just collecting answers. Before building, vet an investment
with offline experiments over `.delivery` history. Record hypotheses,
experiments and observations in a session. Treat a refuted hypothesis as a
pointer to a better question, not a dead end.

Worked example from session `junior-pi-hub-value`: "an evidence ledger would
catch false-ready runs" (H3) and "the Jev postflight discriminates them" (H4)
were refuted because the defects sat outside the written criteria. That led to
H9 (Jev's preflight already flagged all three, but plan contracts bypassed the
gate), H12 (clarify questions are generic) and H15 (a respondent with repo
access found the gaps), then H17 (can a commodity worker answer them). Live
verification then tested the gate itself (H16): keyed on the whole readiness
decision it would have stopped 121 of 122 recorded runs, so it now keys on
`contract_clear` alone. Measure the signal you will act on, not a nearby one.

## Locate the CLI

The skill may be installed from a source checkout (`junior.ts`) or from the
published npm package (`dist/junior.js`). Do not assume a fixed path:

- Use `$JUNIOR_CLI` (an absolute path to the CLI entry) when it is set.
- Otherwise run the installed `junior` command when it is on `PATH`.
- Otherwise use the CLI recorded in the manifest beside the installed skill
  (`.junior-manifest.json`, field `skills.junior.cli`); run `node <that path>`.
- Otherwise ask the manager for the CLI path and run `node <path> <command>`.

## Dispatch

Choose one concrete artifact and independently verifiable acceptance criteria.
Keep strategic uncertainty and architecture decisions with the manager. Use
`recon` when mechanisms are unknown and review its findings before authorizing
implementation; use `test_first` for behavior changes, `checks_first` for
setup/docs, and `fmeca`/`evaluate` for bounded analysis. Analysis workflows
produce a report artifact and are not implementation. Analysis reports are leads
to verify; treat a proven-here claim without a quoted span as inferred. Jev is
advisory.

Create a JSON contract in the target workspace:

```json
{
  "id": "unique-deliverable-id",
  "deliverable": "A precise artifact and resulting behavior",
  "cwd": "/absolute/target/checkout",
  "workflow": "test_first",
  "acceptance": ["Observable behavior to verify"],
  "constraints": ["Allowed files and explicit exclusions; no commits or pushes unless authorized", "Restrict searches to the checkout and named dependency paths; no nested workers"],
  "checks": [{"command": "node", "args": ["--test", "relevant.test.ts"]}],
  "isolation": "worktree",
  "jev": {"mode": "shadow"}
}
```

`cwd` is where edits and checks run; task paths passed to the CLI should be
absolute. The example omits `provider`/`model` so Jev routing applies; an
explicit model must be a commodity/open-weight model. `isolation` defaults to
`worktree` for `handoff`; pass `"none"` to run in place. To ground the readiness classifier and worker in existing code, add a
`context` array of `{path, start?, end?}` entries (relative to `cwd`, 1-based
inclusive lines) for bounded excerpts. Contract scope is instruction, not a
sandbox guarantee.

```bash
node <cli> validate /absolute/task.json
node <cli> handoff /absolute/task.json
```

`handoff` prints a compact receipt. Add `--full` for the full result, `--mock`
for an offline simulation with no provider spend. `doctor` is a read-only
readiness check; `init` is idempotent project setup. `init` records exact local
Git exclusions (`.git/info/exclude`) for the files it generates and `.delivery/`,
so a fresh project is immediately ready for a `worktree` handoff without a
manual commit or stash. Set `JUNIOR_NO_INSTALL=1` (or `true`) to make `init`
and `update` skip the Pi, managed-tool and companion installers entirely and
report them as skipped.

## Models

Junior executes only on commodity/open-weight models. `model-policy.ts` accepts
the commodity vendors (DeepSeek, Moonshot, Z.ai, Qwen, MiniMax, Meta Llama, plus
`openai/gpt-oss*`) and refuses a frontier vendor (Anthropic, OpenAI, Google, xAI
and their floating aliases) or an unrecognized vendor or direct host before any
spend. A refusal is `frontier_model_refused` or `unknown_model_refused`, with a
`modelPolicy` record on the result and `model.policy` on the compact receipt.

`delivery.config.json` holds `models.routing` (`off|shadow|auto`, default
`auto`), `models.roster` (overrides, additions or `disabled`),
`models.autoUpgrade`, `models.approved`/`models.unapproved` and
`models.priceTolerance`. Built-in profiles are `general` (default, DeepSeek V4.1
Flash), `deep-reasoning`, `long-horizon`, `agentic-tools` and `fast-mechanical`.
When the contract names no model and is not a resume, Jev asks one
`model_profile` choice; `auto` applies a non-default profile at confidence >=
0.6, `shadow` records it without applying. Precedence is task model > routed
profile > project pin > built-in. The receipt records `requested.source` and
`modelRouting`; `junior model status|list|upgrade` reports the roster and plans
or applies same-lineage upgrades (an explicit target must be commodity).

Junior never switches away from the default model without a human approval. A
non-default profile or contract model stops the run at `needs_model_approval`
with a `model-approval.json` rationale (pick, confidence, strengths, price vs
the default). Relay that rationale to the human.
Never approve a model on the human's behalf: consent is a per-run
`--approve-model <key>`, a plan's `approvedProfiles`, or a project
`junior model approve <key>` (with `junior model revoke <key>` to withdraw it).
`models.unapproved: default` runs on the default instead of asking. Adoption is
price-gated: `models.autoUpgrade` applies only a newer same-lineage version
within `models.priceTolerance`
(default 1.25x on input and output, measured on the cheapest tool-capable
endpoint); a pricier version is listed as waiting for price parity. The compact
receipt's `model.cache.hitRate` is the prompt-cache read share, and
`model.upstream` lists the captured upstream providers. Treat a model
output-limit stop as incomplete work, regardless of passing checks. Inspect
`junior model status` before a paid run when routing matters.

## Runtime and isolation guarantees

- Default `worktree` isolation creates a detached worktree from a clean source
  checkout and runs Pi and checks there; the source index is never edited
  implicitly. Worktree isolation refuses a dirty source, so commit or review
  your work first, or pass `isolation: "none"` explicitly.
- Repos with gitignored dependencies can opt into provisioning with
  `isolationSetup` (or the same key in `delivery.config.json`; the contract
  wins). Each `links` entry creates a symlink in the worktree pointing at the
  source path, each `copy` entry copies the relative path, and each `commands`
  entry runs with argv (no shell) bounded by the remaining deadline and
  `checkTimeoutMs`. Setup output goes to `isolation-setup.log`; a failure ends
  the run as `isolation_setup_failed` before Pi starts, and linked or copied
  paths are excluded from change evidence. `isolationSetup` is ignored when
  isolation is `none`.
- A run is bounded by a total wall deadline and a tool watchdog; the `quiet`
  setting only reports a no-output interval and is **not** a hard deadline. The
  process group is cancelled on interrupt and execution/session locks are
  released.
- Retained worktrees live at `.delivery/<id>/<timestamp>/worktree`; logs and
  results stay beside them. Review them, then clean unreviewed ones with
  `junior prune [--older-than 24h] [--keep-last N] [--dry-run]`. `prune` removes
  only inactive clean registered Junior worktrees, never uses `--force`, preserves
  the artifact directory, and skips dirty, locked, foreign, symlinked or
  escaping paths and the source checkout. `doctor` reports the retained count
  and disk usage read-only.
- The receipt records requested and observed model, usage, cost availability,
  stop reasons, changed files and artifact paths. `ready_for_review` is a
  handoff, not acceptance. An unavailable estimate with `billedUsd: null` is
  unknown, not free.
- A Pi guard extension makes every bash tool call read stdin from `/dev/null`
  and caps its timeout ten seconds under `execution.toolTimeoutMs` (half below
  20s), so a slow bash call fails only that call. Any tool that outlasts the
  watchdog still stops the run, and the receipt names it as `timedOutTool`.
- `execution.maxOutputBytes` (1-32 MiB, default 8 MiB) bounds the retained
  worker output. Oversized tool text is compacted to a head/tail marker and the
  full text is written to `tool-output/<toolCallId>.txt`.
- After an output-capped segment, `execution.continuations` (0-3, default 1)
  starts an automatic fresh-session continuation segment, writing
  `checkpoint-<n>.md` and `events-<n>.jsonl`; the receipt reflects the final
  segment.

## Review and bounded repair

Inspect `artifactDir/result.json`, the check logs and the changed files.
Change evidence covers the complete tracked, staged and untracked changes; a
`truncated` diff or receipt means the reviewer saw an explicit prefix, not the
whole change, so treat the run as incomplete. Confirm the observed model matches
the request. Apply an accepted run with `junior apply <id|result.json>`
(`--dry-run` to check first) instead of copying files. For a specific repair, issue a new bounded contract with
`resumeFrom` pointing at the prior `result.json` and the same
cwd/provider/model. Allow at most one automatic repair unless the user
authorizes more; escalate an unresolved blocker with evidence. Never treat a
recon recommendation as approval to implement.

Report the deliverable outcome, verification, remaining issues and recorded
model/cost briefly. Persist accepted deliverables and next dependencies in a
small project plan so the manager can resume without reloading transcripts.

## Shared state and test discipline

Use `node <cli> tools inspect /absolute/hop.json` for the compact
shared FMECA/CPM/Crossmatrix state. A contract may supply `hopFrom` and an
expected `hopRevision`; verified snapshots go to both Jev and the executor. State
mutations invalidate earlier manager acceptance. Keep contracts and tool calls
scoped to one deliverable; the worker does not accept its own work.

Fresh-session `qa` remains an optional, report-only workflow.

All newly written or changed tests use atomic scenarios, declarative names, and exactly one behavioral assertion against a public outcome. Test the deliverable capability rather than private implementation details. Prefer focused tests, fewer boundary integrations, and essential end-to-end acceptance checks. Never bundle unrelated assertions to evade the rule.

`thinking` defaults to `low`; increase it explicitly when needed. A model output-limit stop is incomplete work, regardless of passing existing checks.

## Frontier attention

Use `jev.mode: enforce` when frontier suitability must block execution. The compact receipt's `attention` field reports the target, decision, `trigger` (the question behind the decision), `reason`, `probability`, per-question `probabilities` and the `threshold` (`0.6`).
For a clarify, `probability` is the P(true) of the triggering question (`contract_clear` when not judged clear, else `blocking_assumptions`), and the reason cites it against the threshold (`>=` for a detected blocking assumption, `<` for a contract not judged clear).
`frontier_required` returns to the manager before the commodity worker starts in enforce mode; shadow remains advisory. Missing/uncertain classification is not a pass. No frontier model is called automatically. Review the classification and the contract before clarifying, re-scoping or taking over.

## Manager loop with CPM and FMECA

You (the frontier model) coordinate; commodity workers execute. Route every
tool call through `node <cli> tools call [/absolute/hop.json] <fmeca|cpm|crossmatrix> <request.json | method key=value ...>`
so it is recorded as evidence (reads become immutable snapshots). The hop
defaults to `.delivery/setup/hop.json`; inline values are JSON when they parse
(`junior tools call cpm plan.status plan_id=plan_123`). Output is the bare
result; a failure exits 1; `--full` prints the envelope:

1. Plan: `plan.submit` deliverables with `owned_files` and prerequisites;
   `plan.lint`, `plan.simulate` and `plan.status` (critical path, ready set) are reads.
   Shape the plan for Junior with `junior plan check <plan.json>`: one
   handoff-sized deliverable each, disjoint `owned_files` for parallel cohorts,
   explicit `consumes` text for interfaces, and `metadata.junior`
   acceptance/checks. Its `cohorts` are the safe parallel sets; keep hot
   registration files (`package.json`, `package-lock.json`, `scripts/build.mjs`,
   `CHANGELOG.md`, `README.md`) in one final deliverable. Write skeletons with
   `junior plan contracts <plan.json> --out <dir>`; they omit `provider`/`model`
   so routing applies. Manager-owned review/verify steps stay outside cohorts.
2. Risk: an FMECA session (`session.open`, `append`), then `risk.next` and
   `readiness.assess` before risky work.
3. Lease: give each contract `plan: {id, deliverable}` with `hopFrom`;
   `handoff` leases the deliverable (refusing with `plan_lease_refused` when it
   is not ready), runs it, and records hours and evidence (`in_progress` on
   success, `failed` otherwise). Or lease a cohort yourself with
   `plan.acquire_cohort` (`caller_id`, `ids`, `max_count`).
4. Review the receipt, diff and checks yourself, apply the worktree with
   `junior apply <id>` (three-way, refuses unsafe states), then
   `plan.mark_status` complete (with `evidence`) or failed with a reason;
   repair at most once.
5. Repeat until `plan.status` shows the plan complete.

The companion cpm skills follow the plan's life: `cpm-plan` (author, lint, sync,
critical path), `cpm-improve` (parallelize, crash or fast-track; advisory
`plan.review`), `cpm-run` (lease, mark, accept) and `cpm-ev` (baseline, earned
value, snapshots). cpm-planner auto-baselines at the first execution unless
`CPM_BASELINE_MODE=refuse`; re-baselines stay explicit.

Neither tool needs registering as an MCP server for this loop; Junior spawns the
managed binaries itself.

### Requirement tracing

Put a stable `id` on each acceptance criterion, plus the `checks` it proves and
the fmeca `mitigates` links it verifies. After a run,
`node <cli> fmeca propose-verified <result.json|run id>` prints one ready
`set_mitigation_status` request per (criterion, mitigation) pair whose verdict is
`met` at tier `check_passed`. Review each proposal and apply it yourself with
`node <cli> tools call fmeca`; Junior never calls fmeca and never applies a
proposal automatically. Never apply a proposal
for a criterion that was only judged (tier `judged`).

## Crossmatrix state graph

Crossmatrix (0.3.0+) ties the other tools together in a committed
`.crossmatrix/` store. Use it when work spans features, jobs, journeys, tests,
risks, ADRs and code, so the next session reads the relationships instead of
rediscovering them. Every write is an observation (a scale token plus evidence),
never a number you invent.

1. Once per project: `node <cli> matrix init` creates `.crossmatrix/`; commit it.
   `matrix export --source code|tests|jevitate|cpm|fmeca|playbooks` writes the
   same dimensions as files under `.crossmatrix/` without a hop.
2. Federate the entities: `node <cli> matrix sync --hop <hop.json> --model <id>
   --source code --source tests [--source jevitate] [--source playbooks]
   [--source cpm --plan <plan_id>] [--source fmeca --session <id>]`.
   The cpm roster carries each deliverable's status and the fmeca roster each
   failure mode's criticality and standing. `--source state --plan <plan_id>
   --fmeca-session <id>` links failure modes to the deliverables and files their
   refs name (`junior-fmeca-cpm`, `junior-fmeca-code`) and deliverables to the
   failure modes their criteria's `mitigates` verify (`junior-cpm-fmeca`, with
   the mitigation's status); a relation whose dimension is missing is skipped
   with a note, and elicitation, scientific-process and jevitate results are not
   mirrored (ADR 0012). `--source playbooks` publishes the capability map.
   Re-run after changes; an unchanged roster is a no-op.
3. Map features to code: `matrix codemap init` declares the code-map relations
   for the feature dimensions the model has (a missing default is a note), then
   `matrix link --result <result.json> --feature <dimensionId>:<memberId>` after
   each accepted handoff.
4. Autopilot the links once artifacts exist: `matrix bootstrap` proposes
   feature/journey/job/test -> code links with evidence and confidence,
   `matrix confirm --proposals <proposals.json>` records a reviewed selection
   (`--min high|medium|low`, `--only`, `--exclude`), and `matrix autolink --plan
   <plan_id>` links completed cpm deliverables' results, found by evidence path,
   run id or the latest `.delivery/<id>/<stamp>/result.json`, and lists the
   ones it skipped. All three are content-addressed and replay identically.
5. Query the graph: `matrix graph --seed <dimensionId>:<memberId>` walks to a
   bounded, deterministic slice and prints a contract `context` array;
   `matrix graph --impact --result <result.json>` reverse-walks changed files
   into focused test and jevitate checks. `matrix context` prints one feature's
   contract context, `matrix files` lists its linked files and relation
   (implements, tests, touches), and `matrix stale` lists links to re-confirm.
6. Audit quality with `matrix qc`: it scopes links (optionally `--seed`, capped
   by `--max-links`) and reports stale links, contradictions, coverage gaps and
   Jev-implausible/uncertain links to a review queue (`--no-jev`, `--md`,
   `--out`). It never writes; confirm or remove links through
   `crossmatrix.command`.
7. Analyze with `matrix analyze --input <analysis.json>`: items x criteria x
   scales scored in batched Jev cells, with weighted ranking, coverage, orphans,
   sensitivity and low-confidence review. Presets are `decision-matrix`,
   `house-of-quality`, `traceability` and `risk-matrix`; `--record` mirrors the
   result into the store, and nothing is written without it.
8. Govern decisions with `matrix adr new|lint|sync|check`: `new` writes the next
   numbered MADR record, `lint` checks id/status/supersedes and accepted-record
   invariants, `sync` publishes accepted rules as an `adr` dimension, and
   `check` scores rules against changed files or the code map (`--record` stores
   proposed conformance observations).
9. Bridge jobs with `matrix jtbd seed|evidence|draft`: `seed` turns a jevitate
   job into elicitation coverage and claims, `evidence` appends journey results
   as evidence, and `draft` turns an exported elicitation spec into unapproved
   job drafts.
10. Turn a ready spec into work with `matrix plan-from-spec --spec <spec.json>`
    (`--session <id>` exports it through elicitation): it writes a lint-clean
    draft cpm plan under `.cpm-planner/plans/<name>/main.json` with deliverables
    per requirement and evidence-only edges. `--allow-unready` overrides the
    readiness gate, `--suggest-edges` adds Jev-suggested edges marked for
    review, `--codemap --hop <hop.json> --model <id>` records owned files, and
    `--force` overwrites an existing draft.
11. For analysis, use the Crossmatrix skills (`crossmatrix-hoq`,
    `crossmatrix-jtbd`, `crossmatrix-test-coverage`, `crossmatrix-risk`,
    `crossmatrix-prioritize`, `crossmatrix-review`) through `node <cli> tools
    call <hop> crossmatrix`. Feed the results back: revise cpm priorities from
    `crossmatrix-prioritize`, point fmeca at high-weight uncovered requirements,
    and turn uncovered journeys into jevitate campaigns.

AI assist (`assist.suggest`, `assist.members`) is opt-in and paid; its
proposals do not count until a human or you confirm them with `observe`.

## Companion tools and skills

`junior init` installs, by default: Pi, the checksum-verified managed
FMECA/CPM/Crossmatrix/scientific-process/elicitation binaries (`~/.junior/tools`,
used by delegated runs), the npm companion CLIs `@matthew-cochran/fmeca`,
`@matthew-cochran/cpm`, `@matthew-cochran/crossmatrix`,
`@matthew-cochran/scientific-process`, `@matthew-cochran/elicitation`,
`@jevitate/cli` and `@matthew-cochran/triz`, and each companion's own agent
skills for the selected targets (`--no-install` and `--no-companions` opt out).
The two newest managed tools are registered before their first release, so a
missing release is reported as `unavailable` rather than a failure. Prefer those
skills for their domain: `fmeca*` for risk analysis, `cpm-*`/`deliverable-cpm`
for planning, and `jevitate-getting-started` as the entry point for browser
testing, demos and CI gates of web apps. A jevitate command with a pass/fail exit
code (for example `jevitate check --suite <file>`) can be a contract `checks`
entry so a commodity deliverable is verified in a real browser.

`junior doctor` is read-only; it reports Pi, skills, managed tools and companion
tools separately. `junior doctor --check-updates` also asks npm and GitHub for
newer releases (Junior's own included), and `junior update` updates Junior itself first, then adopts
every newer tool and companion release and refreshes unmodified skills.

## Report tool issues upstream

When a companion or managed tool misbehaves, draft an upstream issue with
`node <cli> report-issue <tool> --title "<title>" [--body-file <draft.md>] [--hop <hop.json>]`,
show the draft to the human, and add `--file` only after explicit approval.
Without `--file` nothing is filed; the draft includes a redacted description,
an Environment section and (with `--hop`) the last ten evidence entries for that
tool. `--file` checks for an open same-title issue first and `--force` is the
only thing that overrides it.

## TRIZ

Use TRIZ only for a real technical or physical contradiction, not as a general
brainstorming step. The `triz` CLI is installed as a companion by `junior init`.

- `triz catalog` lists the TRIZ principles offline.
- `triz analyze <request.json> --out <result.json>` makes a paid Jev
  classification call, so it needs explicit manager authorization. Add
  `--offline <response.json>` to replay a recorded response without a call.
- `triz inspect <result.json>` summarizes a saved result.

Attach the saved result to the deliverable context so the decision and its
evidence travel with the work.

## Idempotent shared manager instructions

If you add Junior-specific instructions to `AGENTS.md`, `CLAUDE.md`, or another
shared Markdown instruction file, place all of that content inside exactly one
managed block:

```markdown
<junior>
Use the installed Junior skill for delegation, CPM planning, FMECA risk, crossmatrix traceability and investigations; run `junior routes "<request>"` when unsure which command fits. Review receipts and independent checks before accepting work.
</junior>
```

On first installation, append the block without replacing existing content. On
reruns, replace the existing block in place rather than appending another.
Preserve every byte outside the block. If the desired content already matches,
leave the file unchanged. If tags are duplicated, nested, or unbalanced, stop and
report the conflict instead of guessing or overwriting user instructions. Do not
add Junior text outside the tags. Remove only the managed block when uninstalling
an authorized integration. Junior init installs separate skill files; it does
not itself add AGENTS.md or CLAUDE.md blocks (a companion installer such as
jevitate's may add its own).
