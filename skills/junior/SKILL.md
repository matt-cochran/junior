---
name: junior
description: Delegate a bounded coding deliverable to DeepSeek through the local Junior delivery worker (junior.ts handoff), then review its compact receipt and independent checks. Use when the user requests Junior or wants commodity-model execution under premium-model supervision.
license: MIT
compatibility: Requires Node 22.19+, git and the junior CLI (npm @matthew-cochran/junior); delegated runs need Pi with a provider credential.
---

# Junior

You manage the deliverable; DeepSeek executes through Pi. `junior handoff` runs
one bounded task and prints a compact receipt; you review the artifacts and
accept. Keep the manager context small: contract, compact receipt, relevant diff
and check evidence.

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
in place. To ground the readiness classifier and worker in existing code, add a
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
manual commit or stash.

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

## Review and bounded repair

Inspect `artifactDir/result.json`, the check logs and the changed files.
Change evidence covers the complete tracked, staged and untracked changes; a
`truncated` diff or receipt means the reviewer saw an explicit prefix, not the
whole change, so treat the run as incomplete. Confirm the observed model matches
the request. For a specific repair, issue a new bounded contract with
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
tool call through `node <cli> tools call /absolute/hop.json <fmeca|cpm|crossmatrix> request.json`
so it is recorded as evidence (reads become immutable snapshots):

1. Plan: `plan.submit` deliverables with `owned_files` and prerequisites;
   `plan.lint`, `plan.simulate` and `plan.status` (critical path, ready set) are reads.
2. Risk: an FMECA session (`session.open`, `append`), then `risk.next` and
   `readiness.assess` before risky work.
3. Lease: `plan.acquire_cohort` returns non-conflicting ready deliverables;
   dispatch each as one Junior contract (pass `hopFrom` to share state).
4. Review the receipt, diff and checks yourself, then `plan.mark_status`
   complete (with `evidence`) or failed with a reason; repair at most once.
5. Repeat until `plan.status` shows the plan complete.

Neither tool needs registering as an MCP server for this loop; Junior spawns the
managed binaries itself.

## Companion tools and skills

`junior init` installs, by default: Pi, the checksum-verified managed
FMECA/CPM/Crossmatrix binaries (`~/.junior/tools`, used by delegated runs), the
npm companion CLIs `@matthew-cochran/fmeca`, `@matthew-cochran/cpm`,
`@jevitate/cli` and `@matthew-cochran/triz`, and each companion's own agent skills
for the selected targets
(`--no-install` and `--no-companions` opt out). Prefer those skills for their
domain: `fmeca*` for risk analysis, `cpm-*`/`deliverable-cpm` for planning, and
`jevitate-getting-started` as the entry point for browser testing, demos and CI
gates of web apps. A jevitate command with a pass/fail exit code (for example
`jevitate check --suite <file>`) can be a contract `checks` entry so a commodity
deliverable is verified in a real browser.

`junior doctor` is read-only; it reports Pi, skills, managed tools and companion
tools separately. `junior doctor --check-updates` also asks npm and GitHub for
newer releases, and `junior update` adopts them and refreshes unmodified skills.

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
Use the installed Junior skill to delegate one bounded deliverable. Review its receipt and independent checks before accepting the work.
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
