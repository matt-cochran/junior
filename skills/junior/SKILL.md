---
name: junior
description: Delegate a bounded coding deliverable to DeepSeek through the local Junior delivery worker (junior.ts handoff), then review its compact receipt and independent checks. Use when the user requests Junior or wants commodity-model execution under premium-model supervision.
---

# Junior

You manage the deliverable; DeepSeek executes through Pi. `junior handoff` runs
one bounded task and prints a compact receipt; you review the artifacts and
accept. Keep the manager context small: contract, compact receipt, relevant diff
and check evidence.

## Locate the CLI

The skill is installed from a Junior checkout. Do not assume a fixed path:

- Use `$JUNIOR_CLI` (an absolute path to `junior.ts`) when it is set.
- Otherwise use the checkout that produced this skill. It is recorded in the
  manifest beside the installed skill (`.junior-manifest.json`, field
  `skills.junior.source`); that file's checkout contains `junior.ts`.
- Otherwise ask the manager for the checkout path and run
  `node <checkout>/junior.ts`.

## Dispatch

Choose one concrete artifact and independently verifiable acceptance criteria.
Keep strategic uncertainty and architecture decisions with the manager. Use
`recon` when mechanisms are unknown and review its findings before authorizing
implementation; use `test_first` for behavior changes, `checks_first` for
setup/docs, and `fmeca`/`evaluate` for bounded analysis. Analysis workflows
produce a report artifact and are not implementation. Jev is advisory.

Create a JSON contract in the target workspace:

```json
{
  "id": "unique-deliverable-id",
  "deliverable": "A precise artifact and resulting behavior",
  "cwd": "/absolute/target/checkout",
  "provider": "openrouter",
  "model": "deepseek/deepseek-v4.1-flash",
  "workflow": "test_first",
  "acceptance": ["Observable behavior to verify"],
  "constraints": ["Allowed files and explicit exclusions; no commits or pushes unless authorized", "Restrict searches to the checkout and named dependency paths; no nested workers"],
  "checks": [{"command": "node", "args": ["--test", "relevant.test.ts"]}],
  "isolation": "worktree",
  "jev": {"mode": "shadow"}
}
```

`cwd` is where edits and checks run; task paths passed to the CLI should be
absolute. `isolation` defaults to `worktree` for `handoff`; pass `"none"` to run
in place. Contract scope is instruction, not a sandbox guarantee.

```bash
node <checkout>/junior.ts validate /absolute/task.json
node <checkout>/junior.ts handoff /absolute/task.json
```

`handoff` prints a compact receipt. Add `--full` for the full result, `--mock`
for an offline simulation with no provider spend. `doctor` is a read-only
readiness check; `init` is idempotent project setup.

## Runtime and isolation guarantees

- Default `worktree` isolation creates a detached worktree from a clean source
  checkout and runs Pi and checks there; the source index is never edited
  implicitly. Worktree isolation refuses a dirty source, so commit or review
  your work first, or pass `isolation: "none"` explicitly.
- A run is bounded by wall/quiet deadlines and a tool watchdog; the process
  group is cancelled on interrupt and execution/session locks are released.
- The receipt records requested and observed model, usage, cost availability,
  stop reasons, changed files and artifact paths. `ready_for_review` is a
  handoff, not acceptance. An unavailable estimate with `billedUsd: null` is
  unknown, not free.

## Review and bounded repair

Inspect `artifactDir/result.json`, the check logs and the changed files (bounded
diff evidence can omit new/staged files). Confirm the observed model matches the
request. For a specific repair, issue a new bounded contract with `resumeFrom`
pointing at the prior `result.json` and the same cwd/provider/model. Allow at
most one automatic repair unless the user authorizes more; escalate an
unresolved blocker with evidence. Never treat a recon recommendation as
approval to implement.

Report the deliverable outcome, verification, remaining issues and recorded
model/cost briefly. Persist accepted deliverables and next dependencies in a
small project plan so the manager can resume without reloading transcripts.

## Shared state and test discipline

Use `node <junior>/junior.ts tools inspect /absolute/hop.json` for the compact shared FMECA/CPM/Crossmatrix state. A contract may supply `hopFrom` and an expected `hopRevision`; verified snapshots go to both Jev and the executor. State mutations invalidate earlier manager acceptance. Keep contracts and tool calls scoped to one deliverable; the worker does not accept its own work.

All newly written or changed tests use atomic scenarios, declarative names, and exactly one behavioral assertion against a public outcome. Test the deliverable capability rather than private implementation details. Prefer focused tests, fewer boundary integrations, and essential end-to-end acceptance checks. Never bundle unrelated assertions to evade the rule.

`thinking` defaults to `low`; increase it explicitly when needed. A model output-limit stop is incomplete work, regardless of passing existing checks.
