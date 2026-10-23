# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.0] - 2026-10-23

### Added

- `junior note add|list|done|promote|dismiss` (#93): local session notes in
  `.delivery/notes.jsonl`, one append-only event per line (`add`, `done`,
  `promote`, `dismiss`). The file is locally excluded and never committed. A
  manager note stays open until done; a capture proposal stays pending until
  promoted or dismissed.
- `junior compact --capture` (#93): reads the PreCompact hook input from stdin,
  asks the pinned default commodity model (today DeepSeek V4.1 Flash, via
  OpenRouter) once for open decisions, questions, risks, hypotheses and todos,
  and writes them only as proposals. The budget is a 48000-character transcript
  tail, 1500 output tokens with model reasoning off, one request with a
  30-second timeout and at most 12 proposals. It always exits 0 and writes one
  record per attempt to `.delivery/capture/<timestamp>.json`; it never writes FMECA, plan or
  scientific-process state.
- Four new `junior compact` block sections (#93): Pending decisions
  (`needs_answers`, `needs_choice` and `needs_model_approval` runs with the file
  to read), Open notes, Open PRs (`gh` for this repo plus `compact.repos` from
  `delivery.config.json`, with a 3-second timeout and unavailable when `gh` is
  missing) and Capture proposals.
- `junior compact --cursor` (#93) prints `{additional_context}` for Cursor.

### Changed

- `junior setup --context-hooks` (#93) also installs a Claude Code `PreCompact`
  hook running `junior compact --capture`. With `--harness codex|cursor` it
  writes `.codex/hooks.json` or `.cursor/hooks.json` with `SessionStart` and
  `PreCompact` hooks, locally excluded when created (Codex needs the hooks
  trusted in `/hooks`), instead of printing instructions.
- Junior is tested with Pi 1.4.0 (was 1.0.4): every Pi option Junior passes is
  unchanged, a live DeepSeek handoff reports the same receipt fields, and Pi
  1.4.0 fixes sessions that broke after an output-limit cut-off, which
  continuation segments can hit. `junior init` installs 1.4.0 and `doctor`
  compares against it.
- Junior verifies cpm-planner 0.4.3, elicitation 0.1.2 and scientific-process
  0.3.1; their recorded responses are unchanged.

## [0.10.1] - 2026-10-23

### Changed

- `junior model list` and `junior model upgrade` plan from the online OpenRouter
  catalog by default, as `junior update` does, so both report the same newer
  same-lineage model. `--offline` uses Pi's local catalog; `--online` is still
  accepted. `model approve` and `model revoke` now reject unknown flags (#74).
- `junior plan contracts` and `junior plan check --jev` honour a deliverable's
  `metadata.repo` through `delivery.config.json` `plan.repos` (repo name to
  checkout): the contract's `cwd` is that checkout and the `<repo>:` prefix is
  stripped before the scope and registration-file rules, so a deliverable that
  owns `triz:README.md` is no longer told not to edit README.md. A repo missing
  from `plan.repos` keeps the plan's checkout. Contracts carry
  `metadata.junior.context` and `metadata.junior.constraints`, and plan-time
  scoring passes the resolved context to Jev, as the run-time gate does (#94).

### Fixed

- `junior compact` no longer lists finished work as in flight: a run whose
  deliverable is complete in any cpm plan line (archived or complete lines
  included) and synthetic `live-check-*` runs are left out (#92).
- The crossmatrix code roster never includes `.crossmatrix/` and skips
  `codemap.exclude` globs from `delivery.config.json` (default: `.changeset/`,
  lockfiles and snapshots); members dropped from the roster are deprecated by
  the server, not deleted (#90).
- FMECA: the f12 Pi-drift detection mitigation now says the isolation check
  reports after the run rather than aborting before spend (#91).
- `junior setup --context-hooks` records its settings backup
  (`.claude/settings.local.json.<stamp>.bak`) in `.git/info/exclude`, so the
  backup no longer makes the checkout dirty and blocks worktree handoffs (#95).
- A plan-leased handoff refused before any worker starts (for example, worktree
  isolation refused on a dirty checkout) keeps its lease and leaves the
  deliverable's status alone instead of marking it failed, so re-running the
  same contract picks it up again (#96).

## [0.10.0] - 2026-10-23

### Added

- Run isolation (#75): every non-mock run probes `pi --help` and passes the
  isolation flags Pi supports (`--no-extensions`, `--no-skills`,
  `--no-context-files`, `--no-prompt-templates`, `--no-approve`, `--no-mcp`)
  and `--tools read,bash,edit,write`. The contract can set `piContext`
  (`ambient`, `tools`, `skills`, `contextFiles`, `extensions`), and the result
  and compact handoff record `piIsolation` (`applied`, `missing`, `ambient`,
  `probed`, and `honored` from a post-run check of Pi's own system message).
  `junior doctor` names any missing isolation flag. Tested Pi is 1.0.4. All 114 recorded worker runs had received 18 unrelated ambient skills.
- Scope check (#76): the contract field `scope` takes `owned` and optional
  `incidental` entries, and `junior plan contracts` fills `scope.owned` from
  the plan. `delivery.config.json` `scope.incidental` overrides the default
  lockfile and snapshot globs. The result and handoff report `scope`
  (`checked`, `inScope`, `incidental`, `outOfScope`), and an out-of-scope path
  appears in the handoff's `unresolved` list as `out of scope: ...`. The run
  status does not change.
- Contract clarity before delegation (ADR 0009, #85): an explicit-workflow
  contract that Jev judges unclear (`contract_clear` below 0.6) stops at
  `needs_answers` before a worker starts. A `blocking_assumptions` clarify
  alone does not stop it: it fires on 94% of runs that came back clean.
  `junior handoff <task.json> --answers <file>` returns outcome `contract`
  with `clarified-contract.json`: the original workflow, every round's answers
  as constraints, and `clarifiedFrom`. `checkBack: "off"` opts out, and a
  contract already prepared or clarified never re-enters the gate. `junior
  plan check <plan> --jev` adds an opt-in, paid `quality` report from the same
  readiness check.
- Plan-check lessons (#79): `junior plan check` reports
  `REGISTRATION_OUTSIDE_SCOPE` when a deliverable owns a test file that
  `package.json` does not register. Plan contracts accept `owned_files` as
  paths or `{ path, mode }` entries and default to `modelProfile: general`, a
  25-minute deadline, a cargo `checkTimeoutMs` when a check runs cargo, and a
  constraint against editing unowned registration files.
- `junior compact [--json] [--max-chars N]` (#78) prints a session-start block
  rebuilt from live stores with no model call: the active plan, FMECA state,
  open scientific-process hypotheses and unresolved runs from the last 48
  hours. `junior setup --context-hooks [--scope local|project] [--remove]
  [--harness claude|codex|cursor]` installs a Claude Code SessionStart hook
  (`compact|resume`) or prints setup instructions for Codex and Cursor.
- `restore-context` in `routes.ts`: `junior compact`, then `junior setup
  --context-hooks`, for rebuilding a session after compaction or resume.

### Changed

- The build collects every production module, so a new module is included in
  the published package without a separate list.
- The Junior skill keeps the new route in its route table and explains the
  clarity gate, `junior compact` and how to derive sharper hypotheses from a
  refuted one.

### Fixed

- Worker runs no longer inherit ambient Pi skills, extensions, context files,
  prompt templates, project trust or MCP servers (#75).
- A plan-backed run now reports files changed outside its owned scope instead
  of leaving them implicit (#76).
- Explicit-workflow plan contracts no longer bypass the clarification gate
  when Jev judges the contract unclear (#85).
- Clarification questions quote at most 160 characters of their context
  instead of repeating the whole deliverable in every question.

## [0.9.0] - 2026-10-22

### Added

- Jev gateways (ADR 0006, #69): `gateway.ts` holds one table of gateways
  (`openrouter`, `typesafe`) with key order (environment variable, then Pi
  `auth.json`) and model ids. `jev.provider` (`auto`, `openrouter` or
  `typesafe`) in the contract or `delivery.config.json` chooses where Jev
  calls go; `auto` uses TypeSafe when `TYPESAFE_JEV_API_KEY` resolves and
  OpenRouter otherwise. An OpenRouter key alone is still a complete setup. A
  provider pinned without its key fails with `jev_provider_key_missing`
  instead of switching paid paths. Direct TypeSafe calls go to
  `api.typesafe.ai` with the System One wire format and `jev-latest`;
  TypeSafe's Data Processing Agreement is at
  https://typesafe.ai/legal/data-processing. The run record names the Jev
  gateway, and key values never appear in errors, receipts or doctor output.
- Companion tools spawned through `junior tools call` get
  `OPENROUTER_API_KEY` and, when configured, `TYPESAFE_JEV_API_KEY` from the
  same resolver; values in the hop env or the process env still win.
- `junior doctor` has a `gateways` section: each gateway's status and key
  source, the resolved Jev provider, and the `litellm` provider in Pi's
  `models.json` (defined, how its key is configured, model count). A
  `!command` key is reported, never run.
- LiteLLM (ADR 0007, #70): point Pi at a LiteLLM proxy with a `litellm`
  provider in its `models.json` and pin `provider: "litellm"` with a
  vendor-prefixed model. The commodity-only policy treats `litellm` like
  OpenRouter: the vendor prefix decides, frontier vendors are refused, and an
  unprefixed id is refused as unknown. Jev stays on OpenRouter or TypeSafe.

### Changed

- A clarify names what to fix (ADR 0005, #68): the readiness call also asks
  which contract part is least clear, and a `contract_clear` or
  `blocking_assumptions` clarify carries `part`, a quoted `excerpt` and at
  least one question. The compact receipt now shows the clarification batch.
- `junior tools call cpm` passes the project's model as `CPM_LLM_MODEL` and
  refuses a frontier or unknown model before cpm-planner starts (#67).
  cpm-planner 0.4.2 also defaults to a commodity model on its own.
- A non-OpenRouter run's billing records why there is no authoritative bill,
  and a Pi-reported `0` for real token use on such a provider is shown as
  unpriced rather than free.
- Recorded responses for cpm 0.4.2 and fmeca 0.2.2 (unchanged shapes); the
  companion releases adopted are cpm-planner 0.4.2, crossmatrix 0.3.4,
  fmeca 0.2.2 and triz 0.4.0.

## [0.8.1] - 2026-10-20

### Added

- `junior apply` records the applied patch hash in `applied.json`, and
  `junior prune` removes a worktree whose changes were applied and are
  unchanged since, instead of skipping it as "unreviewed changes".
- Recorded responses for cpm 0.4.1, fmeca 0.2.1, elicitation 0.1.1 and
  scientific-process 0.3.0: `junior doctor` reports them as verified. Their
  response shapes are unchanged from the previous versions. The fixture index
  lists every verified version per tool.

### Changed

- The companion releases this adopts document `junior tools call` in their
  own skills (praxec/cpm-planner#82, scientific-process#11, elicitation#12,
  fmeca#88, crossmatrix#31), and scientific-process 0.3.0 accepts a per-call
  `session_id` (scientific-process#12); Junior's same-process session opening
  stays for older servers.

## [0.8.0] - 2026-10-20

### Added

- `junior routes [--json] [<query>]` and `routes.ts`: one machine-readable map
  of manager jobs to Junior routes (delegate, CPM planning, plan shaping,
  running and tracking plans, FMECA risk, crossmatrix traceability, discover,
  investigate, TRIZ, browser testing, issue reports, setup, models). A query
  ranks the routes by trigger match, so an agent can recover the right command
  after a compaction.
- `companion-shapes.ts`: the single reader for cpm, fmeca, elicitation and
  scientific-process responses. It accepts every known shape (including cpm
  0.4.0 `graph.deliverables`) and raises `ShapeError` for an unrecognized
  response instead of reading it as empty. Recorded responses of the installed
  companion versions live in `tools/test-fixtures/companions/`, regenerated by
  `node scripts/capture-companion-fixtures.mjs`.
- `junior doctor` reports an advisory `shape:<tool>` item per installed
  companion: `verified` when this release has recorded that version's
  responses, `unverified` otherwise. It never changes readiness.
- `junior matrix export|sync --source cpm --plan-file <plan.json>` and
  `junior matrix bootstrap --plan-file <plan.json>` read a plan file offline,
  with no hop or server.

### Changed

- The Junior skill leads with a "Choose a route" table and a "Planning with
  Junior" quick path, and its description names every route's triggers, so
  planning, risk and traceability requests load it, not only delegation.
  `skill-routing.test.ts` keeps the table in sync with `routes.ts`.
- `junior init` creates the project Crossmatrix store when it is missing
  (`--no-matrix` opts out). `junior update` no longer creates project state
  unless `--with-matrix` is passed, reports `"command": "update"`, and stops
  repeating the `junior matrix init` reminder.
- `matrix`, `matrix-autopilot`, `state-sync`, `plan-handoff` and `clarify`
  read companion responses only through `companion-shapes.ts`.
- `matrix bootstrap` expands an owned directory to the tracked files under it
  and skips owned paths that are not tracked yet, so `matrix confirm` no longer
  fails on them.

### Fixed

- `matrix export|sync --source cpm` read 0 deliverables from cpm-planner 0.4.0
  `plan.get`, so `matrix confirm` failed with `unknown_member` (#58).
- The Junior skill did not trigger on CPM/FMECA planning requests and buried
  the planning loop (#59). (`tools call` stdin and inline forms already
  shipped in 0.7.0; the skill now shows them up front.)
- `junior tools call` with scientific-process failed with `no session open`
  for every method but `session.open`, because each call starts a new server.
  The session is now opened in the same process first.
- A handoff that stopped at `needs_model_approval` marked its plan deliverable
  `failed`; it now keeps the lease like `needs_answers` and `needs_choice`.

## [0.7.0] - 2026-10-19

### Added

- `junior apply <id|result.json> [--dry-run] [--force]` applies a reviewed
  handoff's worktree diff, including new files, to the source checkout with a
  three-way merge. It refuses a run that is not `ready_for_review` or whose base
  is no longer an ancestor of `HEAD`, and leaves the tree unchanged on conflict.
- Plan-aware handoff: a contract with `plan: {id, deliverable, callerId?}` and
  `hopFrom` leases that cpm deliverable before the worker starts (refusing with
  `plan_lease_refused`), then records wall hours and evidence with
  `plan.mark_status` (`in_progress` on success, `failed` otherwise). A lease the
  same caller already holds is re-entered for repairs and clarify re-runs, and
  `needs_answers`/`needs_choice` keep the lease without marking. The receipt
  gains a `plan` block; the manager still reviews and completes.
- `junior tools call` takes an optional hop (default
  `.delivery/setup/hop.json`) and an inline form,
  `junior tools call cpm plan.status plan_id=...`, whose values are JSON when
  they parse.

### Changed

- `junior tools call` prints only the tool result by default, writes the
  revision and snapshot id to stderr and exits 1 on a tool or RPC failure;
  `--full` prints the previous envelope.
- `junior init` refreshes an unmodified outdated Junior skill copy without
  `--upgrade` (a customized copy is still preserved unless `--force`) (#55).

### Fixed

- `junior doctor` names an outdated, customized or missing Junior skill and the
  affected managers in `warnings` and `remediation` instead of only reporting
  `readiness.summary`, and the startup update notice includes an outdated
  Junior skill (#55).

- Companion skill installs build their argv per companion: scientific-process
  and elicitation now receive `--target claude|codex|both` (never `all`) and
  `--dir <cwd>` for project scope, so `junior update` installs their skills
  (#52, #53).

## [0.6.0] - 2026-10-19

### Added

- Commodity-only executor policy (`model-policy.ts`): Junior executes only on a
  recognized commodity/open-weight vendor (DeepSeek, Moonshot, Z.ai, Qwen,
  MiniMax, Meta Llama), treats `openai/gpt-oss*` as commodity, and refuses a
  frontier vendor (Anthropic, OpenAI, Google, xAI and their floating aliases) or
  an unrecognized vendor or direct host before any spend. A refusal carries
  `workerError` `frontier_model_refused` or `unknown_model_refused` with a
  `modelPolicy` record; Jev (typesafe) is a classifier only.
- Commodity model roster and routing (`roster.ts`, `worker.ts`): built-in
  profiles `general` (default, DeepSeek V4.1 Flash), `deep-reasoning`,
  `long-horizon`, `agentic-tools` and `fast-mechanical`; `delivery.config.json`
  `models.routing` (`off|shadow|auto`, default `auto`), `models.roster`
  overrides/additions/disabled and `models.autoUpgrade`.
- Model visibility: a `junior doctor` model section (pin, policy, roster
  availability, newer releases, warnings); the cached startup update check lists
  `model:<id>` entries and suggests `junior model upgrade`.
- `junior model status|list|upgrade` (`model-cli.ts`) with `--online`,
  `--vendor`, `--profile`, `--to`, `--dry-run`, `--yes` and TTY confirmation.
- Junior-ready planning (`plan-junior.ts`): `junior plan check <plan.json>
  [--max-hours N]` and `junior plan contracts <plan.json> --out <dir>`;
  `plan-from-spec` emits `metadata.junior`.
- Human consent before any non-default model: a run stops with
  `needs_model_approval` and a `model-approval.json` rationale, granted per run
  (`--approve-model`), per plan (`approvedProfiles`) or per project
  (`models.approved` via `junior model approve|revoke`); `models.unapproved`
  (`ask|default`) controls whether an unapproved target asks or falls back.
- Model pricing in catalogs and plans (USD per million `inputPerM`/
  `outputPerM`/`cacheReadPerM`, and a `priceDelta` on every planned change) and
  price-gated adoption: `models.priceTolerance` (default 1.25x on input and
  output), measured on the cheapest tool-capable OpenRouter endpoint, so
  `models.autoUpgrade` adopts only price-comparable versions and pricier ones
  are listed as waiting for price parity in `doctor`, the startup notice and
  `junior model upgrade`.
- Prompt-cache hit rate and upstream provider visibility on the compact receipt
  (`model.cache.hitRate` and `model.upstream` from authoritative billing
  capture).
- Sticky per-deliverable model routing via `.delivery/<id>/route.json` and the
  contract `modelProfile`; a per-deliverable OpenRouter affinity key and
  per-profile `openrouter` provider routing keep a deliverable on one upstream
  provider and its warm prompt cache.
- Plan-level model approval: `junior plan check` flags `NEEDS_MODEL_APPROVAL`
  for a non-default `metadata.junior.profile`, and `junior plan contracts`
  carries `modelProfile` and plan-level `approvedProfiles`.

### Changed

- Jev asks one `model_profile` choice in the readiness call when the contract
  names no model and is not a resume; `auto` applies a non-default profile at
  confidence >= 0.6. Receipts record `requested.source` and
  `result.modelRouting`, and the compact handoff exposes `model.routing` and
  `model.policy`.
- Model precedence is task model > routed profile > project pin > built-in.
- `junior update` adopts newer same-lineage commodity models at price parity
  when `models.autoUpgrade` is true; price-comparable ones are applied and the
  rest are reported (with `waiting`) as `result.models`.

### Fixed

- OpenRouter billing capture matches a generation recorded under the model's
  dated canonical slug (for example `deepseek/deepseek-v4.1-flash-20260910`),
  so `billedUsd` is captured again instead of failing with a model mismatch.
- Billing capture retries a generation OpenRouter has not recorded yet (HTTP 404
  for about five seconds after it finishes), within the billing budget.
- The model-approval request names how to decline: pin
  `"modelProfile": "general"` to run on the default model.

- Output cap retains whole lines and reports an `outputBreakdown` in the compact
  `output` (#44).
- A final per-message output-limit stop (`stopReason: length`) continues in a
  fresh segment and is named in the receipt, and a recovered transient error no
  longer fails a run (#46).
- Analysis workflows judge acceptance with a report outline and excerpt and
  settle no-other-file-changed criteria deterministically (#49).

## [0.5.1] - 2026-10-16

### Fixed

- `junior update` refreshes the cached update summary once the newer releases
  are adopted, so the startup notice and `junior doctor` readiness stop
  reporting the components that were just installed.
- `junior setup` records the companion skill files its installers create in the
  repository-local `.git/info/exclude`, matching `junior init`; outside a Git
  repository it stays silent.

## [0.5.0] - 2026-10-16

### Added

- Harness detection for Claude Code, Cursor and Codex (`junior doctor
  --harness`), listing each harness's skill roots and MCP config locations.
- `junior doctor` reports a per-harness `readiness` object covering skills, MCP
  registration, managed tools and cached updates, with one `junior setup` fix
  command; `inspectMcpRegistration` reads Claude (project/user/local), Cursor
  and Codex MCP configs read-only.
- `junior setup` previews the ordered repair plan and confirms before applying
  it; `--dry-run` previews only, `--yes` applies non-interactively, and a
  non-TTY run refuses to change anything without `--yes`.
- Startup update notice: a cached 24-hour check over Junior, the managed tools
  and the companions prints one stderr line on `init`, `doctor`, `status` and
  `validate`; `JUNIOR_NO_UPDATE_CHECK=1` disables it.
- Jev tool routing: the readiness call returns one probability per task trait,
  selects deterministic playbooks and attaches a `toolPlan` (worker directions
  plus `managerSetup`) to the receipt; in `jev.mode: enforce` a required tool
  with unmet setup returns a `tool_setup` clarify before the worker starts.
- Multi-tool playbooks and a deterministic capability map (`playbooks/`),
  with the routing evaluation set in `tasks/routing-eval`; `junior matrix sync
  --source playbooks` publishes the map into Crossmatrix.
- Cross-tool state mirror: `junior matrix sync --source state` records cpm
  status, fmeca failure modes, elicitation claim standing, scientific-process
  verdicts and jevitate journey results as idempotent Crossmatrix observations.
- Crossmatrix autopilot: `junior matrix bootstrap` proposes
  feature/journey/job/test -> code links with evidence and confidence, `junior
  matrix confirm` records a reviewed selection, and `junior matrix autolink`
  links completed cpm deliverables' results.
- Context graph and impact analysis: `junior matrix graph` walks the store to a
  bounded, deterministic slice with a contract `context` array, and `--impact`
  turns changed files into focused test and jevitate checks.
- `junior matrix qc` audits Crossmatrix links (stale, contradictory, coverage
  gaps, Jev plausibility) into an advisory review queue and never writes.
- `junior matrix analyze` scores items x criteria x scales with batched Jev
  cells and weighted ranking, coverage, orphans and sensitivity, with
  `decision-matrix`, `house-of-quality`, `traceability` and `risk-matrix`
  presets and optional `--record`.
- `junior matrix adr new|lint|sync|check`: MADR records with checkable rules,
  published as an `adr` dimension and scored for conformance; Junior's first
  four ADRs live in `docs/adr/`.
- `junior matrix jtbd seed|evidence|draft`: jevitate jobs seed elicitation
  coverage, journey results become evidence, and a ready spec becomes unapproved
  job drafts.
- `junior matrix plan-from-spec`: turns an elicitation spec (or `--session`)
  into a lint-clean draft cpm plan with deliverables per requirement and
  evidence-only edges; `--suggest-edges`, `--codemap`, `--allow-unready` and
  `--force` are supported.
- Prepare workflow and check-back: `junior handoff --choose <option> --correct
  <id>=<text>` consumes a `needs_choice` brief (numbered U/A items, scored
  options, recommendation), gated by `checkBack: auto|always|off`.
- Clarification loop: an unclear contract (or a vague-feature routing) opens an
  elicitation session and returns a `needs_answers` batch of ranked questions
  with the reason and any suggested answer; `junior handoff <task.json>
  --answers <file>` records assent, refutation or amendments until the
  readiness gate passes, then drafts a cpm plan (plan-sized work) or a
  prepare brief. Same gating as the check-back: an explicit workflow is never
  replaced.
- `discover` and `investigate` analysis workflows: an elicitation-backed
  requirements interview and one scientific-process experiment per handoff.
- Managed tools `scientific-process` and `elicitation`: installer, npm
  companions, agent skills, hop native state (`SCIENTIFIC_PROCESS_STATE_DIR`,
  `ELICITATION_STATE_DIR`), read classification and MCP names. Their releases
  are reported as `unavailable` until published.

### Fixed

- A playbook activates only when its primary trait reaches 0.5, so a vague
  request no longer selects `vague-feature` at a 0.10 primary-trait score.

## [0.4.0] - 2026-10-16

### Added

- `junior doctor` reports companion agent-skill readiness as `companionSkills`:
  each skill is `present`, `missing`, `modified`, `unknown` or `not_installed`,
  and an unready one carries a complete `junior init --target ...` remediation
  command. Skill readiness is reported separately and never gates `ok` (#39).
- The Pi guard extension (`pi-guard.ts`) makes every bash tool call read stdin
  from `/dev/null` and caps its timeout ten seconds under
  `execution.toolTimeoutMs` (half the budget below 20s), so a slow command fails
  only that call before Junior's watchdog; a timed-out tool is named in the
  receipt as `timedOutTool` (#42).
- `execution.maxOutputBytes` (1-32 MiB, default 8 MiB) bounds the retained
  worker output; the retained Pi event stream is compacted and oversized tool
  text is written once to `tool-output/<toolCallId>.txt` behind a head/tail
  marker (#41).
- `execution.continuations` (0-3, default 1) starts an automatic fresh-session
  continuation segment after an output-capped segment, writing
  `checkpoint-<n>.md` and `events-<n>.jsonl` (#41).
- `junior validate` adds non-blocking split warnings for a contract naming more
  than six distinct context paths or more than ten acceptance criteria (#41).
- The cpm tool's `plan.review` sees Junior's managed OpenRouter key when no
  explicit key is set, and `junior tools inspect` reports review-key visibility
  as `cpmReview` without its value (praxec/cpm-planner#72).

### Changed

- A tool command that is not Junior's managed binary records the version it
  reports through `--version` (`unknown` when none) and an empty source SHA,
  instead of a built-in last-known release table that went stale with every
  upstream release.

### Fixed

- Local git excludes are verified with `git check-ignore`; a pattern Git does
  not apply is reported in `unapplied` and named in an error instead of being
  recorded as added (#40).
- `isolationSetup` provisioning is idempotent in a resumed worktree: an
  existing link that already points at the source is satisfied instead of
  failing with EEXIST, while a link to a different target still fails (resumed
  worktree link fix).

## [0.3.2] - 2026-10-12

### Fixed

- `junior tools init` no longer records stale tool provenance when no managed
  install exists: the fallback is now the current releases (fmeca 0.2.0,
  cpm-planner 0.2.2, Crossmatrix 0.3.0), and a managed install's version is only
  recorded when the tool's command is that managed binary (#36).
- FMECA `vet` is classified as a read, like cpm `plan.review`: it is an advisory
  model call that never changes state, so it is snapshotted and no longer
  invalidates manager acceptance (#35).
- `tools/README.md` documents the current read/command table, provenance, and
  the Crossmatrix 0.3.0 query and command request shapes (#35, #36, #37).

## [0.3.1] - 2026-10-12

### Added

- `junior update` updates Junior itself from npm first, then re-runs as the
  new version to update every managed binary, companion and skill;
  `--no-self` skips it and source checkouts are never touched.
- `junior doctor --check-updates` reports Junior's own version.
- `junior update` refreshes an installed managed TRIZ without `--with-triz`.

### Fixed

- The managed TRIZ install keeps the release's package name and version, which
  TRIZ 0.3+ needs at import time (`update --with-triz` failed on v0.3.0).
- npm and npm-installed companion CLIs (`.cmd` shims) are spawned correctly on
  Windows.

## [0.3.0] - 2026-10-12

The Crossmatrix hub: Junior ties CPM, FMECA, jevitate, tests and code
together in a committed `.crossmatrix/` store (requires Crossmatrix 0.3.0).

### Added

- `junior matrix export` and `junior matrix sync`: turn code, tests, jevitate
  jobs/personas/journeys, CPM deliverables and FMECA failure modes into
  Crossmatrix dimensions with content hashes; an unchanged re-sync is a no-op.
- `junior matrix init`: create the project's committed `.crossmatrix/` store.
- The code map: `junior matrix codemap init`, `junior matrix link` (record
  the files a handoff changed against its feature), `junior matrix files`,
  `junior matrix context` (a contract `context` array) and
  `junior matrix stale` (links to re-confirm after changes).
- Crossmatrix as an npm companion with its agent skills.
- `junior tools call` uses the project's `.crossmatrix/` store with
  Crossmatrix 0.3.0+ instead of replaying the model on every call.
- The Crossmatrix hub section in the manager skill.
- A slim README with reference documentation under `docs/`, and this changelog.

## [0.2.1] - 2026-10-12

### Fixed

- Stop the worker as soon as its output reaches the accumulation cap (#26).
- Skip re-downloading a companion or managed release that is already current (#27).
- Guard installs in tests with `JUNIOR_NO_INSTALL` (#28).

## [0.2.0] - 2026-10-12

### Added

- Companion tools FMECA, CPM Planner, jevitate and TRIZ, installed with their
  agent skills.
- `junior update` and `junior doctor --check-updates`.
- `junior auth set` and `junior auth remove` for provider keys.
- `junior mcp register` for agent hosts.
- `junior report-issue` for reporting bugs upstream.
- `junior doctor --online` credential and credit verification.
- Streaming handoff progress and `junior status --live`.
- Contract code context, conditional acceptance criteria and the
  `checkReserveMs` execution setting.
- `isolationSetup` worktree provisioning.
- Frontier-attention fields in the compact handoff.

### Fixed

- Fixes #6–#24.

## [0.1.0]

### Added

- Initial release: bounded deliverable handoffs to a commodity model, independent
  checks, Git change evidence, optional Jev gates and the compact manager
  handoff.

[Unreleased]: https://github.com/matt-cochran/junior/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/matt-cochran/junior/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/matt-cochran/junior/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/matt-cochran/junior/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/matt-cochran/junior/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/matt-cochran/junior/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/matt-cochran/junior/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/matt-cochran/junior/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/matt-cochran/junior/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/matt-cochran/junior/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/matt-cochran/junior/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/matt-cochran/junior/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/matt-cochran/junior/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/matt-cochran/junior/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/matt-cochran/junior/releases/tag/v0.1.0
