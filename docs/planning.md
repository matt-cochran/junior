# Planning for Junior

[Back to the README](../README.md)

## Planning with Junior

The quick path from an empty checkout to bounded handoffs. The cpm companion is
reached through `junior tools call`, which spawns the managed binary, records
evidence and returns the bare result; the hop defaults to
`.delivery/setup/hop.json`.

```bash
# 1. Confirm the project can run a handoff.
junior doctor

# 2. Draft the plan. deliverable-cpm, or matrix plan-from-spec,
#    writes .cpm-planner/plans/<name>/main.json.

# 3. Lint and persist the draft in the cpm store.
junior tools call cpm plan.lint path=.cpm-planner/plans/<name>/main.json
junior tools call cpm plan.sync path=.cpm-planner/plans/<name>/main.json

# 4. Shape it for Junior: cohorts, warnings, one contract per deliverable.
junior plan check .cpm-planner/plans/<name>/main.json
junior plan contracts .cpm-planner/plans/<name>/main.json --out .delivery/contracts

# 5. Read the critical path and parallel capacity.
junior tools call cpm plan.status plan_id=<id>
junior tools call cpm plan.schedule plan_id=<id> 'capacities={"agent":3}'

# 6. Improve a plan: fork variants, simulate, compare, select.
junior tools call cpm plan.fork request.json
junior tools call cpm plan.simulate request.json
junior tools call cpm plan.compare request.json
junior tools call cpm plan.select request.json

# 7. Baseline earned value before long-running execution.
junior tools call cpm plan.baseline plan_id=<id> reason=<text>
```

The deep planning procedure — authoring deliverables, leasing and acceptance,
and earned value — lives in [skills/junior/SKILL.md](../skills/junior/SKILL.md) and the
`cpm-*` companion skills. `junior routes "create a cpm plan"` recovers this
route after a compaction.

## `junior plan check` and `junior plan contracts`

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
  leased into the same cohort. An entry is a path string or `{ path, mode }`;
  Junior uses `path` for ownership and scope.
- **Explicit `consumes` text for every interface.** A prerequisite edge is a
  string (`"D01"`) or `{ "id": "D01", "consumes": "the exported helper" }`; the
  `consumes` text names what flows across the boundary.
- **`metadata.junior.acceptance` and `metadata.junior.checks`.** Acceptance is a
  non-empty list of observable outcomes, each a string or an
  `{id, text, when, checks, mitigates}` object; checks are independent, runnable
  commands. `metadata.junior.workflow` optionally sets the workflow template
  (`test_first` is the contract default).
- **Design for the default model.** `general` (DeepSeek V4.1 Flash) is the
  default executor and needs no approval. A deliverable that sets
  `metadata.junior.profile` to another profile must have that profile approved:
  `junior plan check` reports `NEEDS_MODEL_APPROVAL` until the plan lists it in
  plan-level `metadata.junior.approvedProfiles`. Prefer splitting or tightening a
  deliverable so it fits the default model over reaching for a bigger one.
- **Hot registration files in one final deliverable.** `package.json`,
  `package-lock.json`, `scripts/build.mjs`, `CHANGELOG.md` and `README.md` are
  registration files whose edits serialize otherwise independent cohorts; keep
  them in a single deliverable late in the plan.
- **Manager-owned review and verify steps.** A deliverable with
  `metadata.owner: "manager"` (or `"owner"`), `metadata.kind: "manual"`, or
  `milestone: true` is not executed by Junior. Use those for review, verification
  and acceptance.
- **Register test files in scope.** When `package.json` declares its test files,
  a deliverable that owns an unregistered test file and does not own
  `package.json` gets `REGISTRATION_OUTSIDE_SCOPE`. Add the registration file to
  that deliverable or let the final registration deliverable own it.

When `junior matrix plan-from-spec` drafts a plan, `spec-bridge` assigns each
criterion the id `<requirement id>/ac<n>` (for example `req:c1/ac2`) as it writes
the draft. Ids are never recomputed from position after that: reordering or
editing criteria in the plan keeps their ids, and `junior plan contracts` copies
the acceptance objects unchanged.

## `junior plan check`

`junior plan check <plan.json> [--max-hours N]` lints the plan and prints
`{ ok, findings, cohorts }`. `ok` is true when no finding is an error.
`--jev` keeps that report and adds a `quality` report; see
[Plan-time clarity](#plan-time-clarity---jev).

| Code | Severity | Meaning |
| --- | --- | --- |
| `SHARED_FILE_PARALLEL` | error | two agent deliverables own the same file without a prerequisite relation |
| `NO_OWNED_FILES` | warning | an agent deliverable owns no files and cannot be parallelized safely |
| `TOO_LARGE` | warning | the likely estimate exceeds `--max-hours` |
| `NO_ACCEPTANCE` | warning | missing `metadata.junior.acceptance` |
| `NO_CHECKS` | warning | missing `metadata.junior.checks` |
| `INTERFACE_UNSPECIFIED` | warning | a prerequisite edge has no `consumes` text |
| `HOT_FILE` | info | the deliverable owns one or more hot registration files |
| `NEEDS_MODEL_APPROVAL` | warning | an agent deliverable pins a non-default profile that plan-level `metadata.junior.approvedProfiles` does not approve |
| `REGISTRATION_OUTSIDE_SCOPE` | warning | a deliverable owns a test file that `package.json` does not register, and neither the deliverable nor a dependent one owns `package.json` |

`cohorts` are Kahn-layered and then greedily split so no cohort holds two
deliverables that share an owned file. A manager-owned or milestone deliverable
is not itself in a cohort, but the agent deliverables behind it still constrain
the ones that depend on it, and a cycle is kept together in one layer rather
than dropped from the report.

## Plan-time clarity (`--jev`)

`junior plan check <plan.json> --jev` runs the worker's own readiness check on
each planned contract through the configured classifier. It is a paid call and
only runs when `--jev` is passed. The output keeps `ok`, `findings` and
`cohorts`, and adds:

```json
{
  "quality": {
    "threshold": 0.6,
    "scores": [
      { "id": "D01", "status": "clear", "trigger": null, "probability": null, "questions": [] }
    ],
    "flagged": 0,
    "unscored": 0
  }
}
```

Each score is `clear`, `flagged` or `unscored`. `flagged` means the readiness
decision is not delegate: clarify, frontier attention or uncertainty. The
questions come from the same readiness check a handoff uses, so plan check does
not add its own. Flag a contract before leasing it; a classifier outage leaves
it `unscored` rather than blocking the plan lint.

## `junior plan contracts`

`junior plan contracts <plan.json> --out <dir>` writes one JSON contract
skeleton per agent deliverable to `<dir>/<id>.json`. The skeleton sets `id`,
`deliverable` (from `metadata.artifact`), `cwd`, `workflow` (from
`metadata.junior.workflow`, default `test_first`), `acceptance`, `constraints`
(the owned files plus the standard scope constraint), `checks`, `scope` with the
owned files, `isolation: "worktree"` and `jev: { "mode": "shadow" }`.

The defaults keep a skeleton inside one bounded handoff:

- `modelProfile: "general"` unless `metadata.junior.profile` names another
  profile.
- `execution.deadlineMs: 1500000` (25 minutes).
- `execution.checkTimeoutMs: 900000` when a check runs `cargo`.
- A constraint against editing unowned registration files (`package.json`,
  `package-lock.json`, `scripts/build.mjs`, `junior.ts`, `cli.test.ts`,
  `CHANGELOG.md`, `README.md`), telling the worker to report the need instead.

When the deliverable sets `metadata.junior.profile`, the skeleton carries it as
`modelProfile`; a plan-level `metadata.junior.approvedProfiles` list is copied
to every skeleton as `approvedProfiles`.

The skeleton omits `provider` and `model`, so Jev routing applies by default.
`modelProfile` pins a roster profile and `approvedProfiles` grants plan-scope
consent to it; both are subject to the human-approval rules in
[Models](models.md). An explicit model added by hand must be a commodity model.
