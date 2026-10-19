# Planning for Junior

[Back to the README](../README.md)

`junior plan check` and `junior plan contracts` take a cpm plan
(`{ "deliverables": [...] }`, or a bare array of deliverables) and shape it for
bounded Junior handoffs. `junior matrix plan-from-spec` writes a draft plan
whose agent deliverables carry `metadata.junior`.

## Junior-ready deliverables

Shape each deliverable so one handoff can finish it and a manager can verify it
independently:

- **One handoff-sized deliverable each.** Keep the likely estimate within the
  `--max-hours` ceiling (default 4). A larger deliverable should be split into
  chained handoffs.
- **Disjoint `owned_files` for parallel cohorts.** Two agent deliverables that
  share an owned file must be ordered by a prerequisite relation, so they are not
  leased into the same cohort.
- **Explicit `consumes` text for every interface.** A prerequisite edge is a
  string (`"D01"`) or `{ "id": "D01", "consumes": "the exported helper" }`; the
  `consumes` text names what flows across the boundary.
- **`metadata.junior.acceptance` and `metadata.junior.checks`.** Acceptance is a
  non-empty list of observable outcomes; checks are independent, runnable
  commands. `metadata.junior.workflow` optionally sets the workflow template
  (`test_first` is the contract default).
- **Hot registration files in one final deliverable.** `package.json`,
  `package-lock.json`, `scripts/build.mjs`, `CHANGELOG.md` and `README.md` are
  registration files whose edits serialize otherwise independent cohorts; keep
  them in a single deliverable late in the plan.
- **Manager-owned review and verify steps.** A deliverable with
  `metadata.owner: "manager"` (or `"owner"`), `metadata.kind: "manual"`, or
  `milestone: true` is not executed by Junior. Use those for review, verification
  and acceptance.

## `junior plan check`

`junior plan check <plan.json> [--max-hours N]` lints the plan and prints
`{ ok, findings, cohorts }`. `ok` is true when no finding is an error.

| Code | Severity | Meaning |
| --- | --- | --- |
| `SHARED_FILE_PARALLEL` | error | two agent deliverables own the same file without a prerequisite relation |
| `NO_OWNED_FILES` | warning | an agent deliverable owns no files and cannot be parallelized safely |
| `TOO_LARGE` | warning | the likely estimate exceeds `--max-hours` |
| `NO_ACCEPTANCE` | warning | missing `metadata.junior.acceptance` |
| `NO_CHECKS` | warning | missing `metadata.junior.checks` |
| `INTERFACE_UNSPECIFIED` | warning | a prerequisite edge has no `consumes` text |
| `HOT_FILE` | info | the deliverable owns one or more hot registration files |

`cohorts` are Kahn-layered and then greedily split so no cohort holds two
deliverables that share an owned file. A manager-owned or milestone deliverable
is not itself in a cohort, but the agent deliverables behind it still constrain
the ones that depend on it, and a cycle is kept together in one layer rather
than dropped from the report.

## `junior plan contracts`

`junior plan contracts <plan.json> --out <dir>` writes one JSON contract
skeleton per agent deliverable to `<dir>/<id>.json`. The skeleton sets `id`,
`deliverable` (from `metadata.artifact`), `cwd`, `workflow` (from
`metadata.junior.workflow`, default `test_first`), `acceptance`, `constraints`
(the owned files plus the standard scope constraint), `checks`,
`isolation: "worktree"` and `jev: { "mode": "shadow" }`.

The skeleton omits `provider` and `model`, so Jev routing applies by default.
An explicit model added by hand must be a commodity model (see
[Models](models.md)).
