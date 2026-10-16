# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/matt-cochran/junior/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/matt-cochran/junior/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/matt-cochran/junior/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/matt-cochran/junior/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/matt-cochran/junior/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/matt-cochran/junior/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/matt-cochran/junior/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/matt-cochran/junior/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/matt-cochran/junior/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/matt-cochran/junior/releases/tag/v0.1.0
