# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.3.2]: https://github.com/matt-cochran/junior/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/matt-cochran/junior/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/matt-cochran/junior/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/matt-cochran/junior/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/matt-cochran/junior/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/matt-cochran/junior/releases/tag/v0.1.0
