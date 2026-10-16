# Routing evaluation set

A labelled evaluation set for Junior's **tool routing** decision: given a handoff
contract, which companion tools (and which *application* of each tool) should be
used, and what the manager must set up before dispatching the handoff.

The set is deliberately concrete: every case is a realistic Junior contract
paired with the routing a careful frontier manager should choose. It exists to
score router suggestions, not to be executed.

## Files

- `cases/<nn>-<slug>.json` — 30 labelled cases. `nn` is a two-digit ordinal,
  `slug` is a short kebab-case description.
- `validate.mjs` — schema validator, coverage enforcer and coverage reporter.
  Run it with `node tasks/routing-eval/validate.mjs`. It exits `0` only when
  every case is schema-valid and the coverage minimums below are met, otherwise
  it prints each violation and exits `1`.

## Case shape

```json
{
  "contract": {
    "id": "unique-deliverable-id",
    "deliverable": "A precise artifact and resulting behavior",
    "workflow": "test_first",
    "acceptance": ["Observable behavior to verify"],
    "constraints": ["Allowed files and explicit exclusions"]
  },
  "expected": {
    "tools": [
      { "tool": "cpm", "application": "cpm:plan-backed-deliverable", "relevance": "required" }
    ],
    "notTools": ["fmeca"],
    "managerSetup": ["sync a cpm plan with this deliverable"],
    "rationale": "One sentence explaining the routing."
  }
}
```

### `contract`

The five fields Junior's handoff contract needs for routing. They must be
realistic enough that a router could reason about scope, uncertainty and risk.

- `id` — non-empty, unique across the whole set.
- `deliverable` — non-empty string naming the artifact and the resulting
  behavior.
- `workflow` — one of `recon`, `test_first`, `checks_first`, `fmeca`,
  `evaluate`, `qa`, `auto`.
- `acceptance` — non-empty array of non-empty observable-behavior strings.
- `constraints` — non-empty array of non-empty allowed-files/exclusion strings.

### `expected`

The routing label.

- `tools` — array of `{tool, application, relevance}` entries.
  - `tool` is one of `cpm`, `fmeca`, `crossmatrix`, `elicitation`,
    `scientific-process`, `jevitate`, `triz`.
  - `application` is a `tool:application` string from the registry below.
  - `relevance` is `required` (the handoff is unsound without it) or
    `recommended` (materially improves the handoff but is optional).
  - An empty array means **no companion tool is needed**; this is a real label,
    not a missing value.
- `notTools` — tool names that must **not** be suggested for this case. Useful
  for catching over-application (e.g. suggesting `fmeca` for a one-line fix).
- `managerSetup` — short imperative strings naming what the manager must do
  before the handoff (plan sync, matrix init/context, elicitation interview,
  hidden-state checks, etc.). Empty when nothing is required.
- `rationale` — one non-empty sentence. Exactly one sentence keeps the label
  auditable and prevents the label from smuggling in a second decision.

## Allowed applications

Applications are grounded in `skills/junior/SKILL.md` and `tools/README.md`.

| Tool | Application | Capability |
| --- | --- | --- |
| `cpm` | `cpm:plan-backed-deliverable` | Author/lint/simulate a plan and pin `owned_files` before dispatch. |
| `cpm` | `cpm:lease-cohort` | `plan.acquire_cohort` to lease a non-conflicting ready set. |
| `cpm` | `cpm:earned-value` | Baseline, earned-value and snapshots for long work. |
| `fmeca` | `fmeca:risk-before-change` | Open a session and score failure modes before a risky edit. |
| `fmeca` | `fmeca:readiness-assess` | `readiness.assess` gate before release or high-blast-radius work. |
| `crossmatrix` | `crossmatrix:codemap-context` | `matrix codemap init` + `matrix context`/`files` to bound a handoff. |
| `crossmatrix` | `crossmatrix:house-of-quality` | Map requirements to characteristics and prioritize. |
| `crossmatrix` | `crossmatrix:multidimensional-matrix` | Federate features, jobs, journeys, tests, risks and code. |
| `crossmatrix` | `crossmatrix:test-coverage` | Surface uncovered requirements and journeys. |
| `crossmatrix` | `crossmatrix:stale-relink` | `matrix stale` then re-link or deprecate after merges. |
| `elicitation` | `elicitation:requirements-interview` | Turn a vague request into testable acceptance criteria. |
| `scientific-process` | `scientific-process:hypothesis-experiment` | Frame a hypothesis and run a bounded discriminating experiment. |
| `jevitate` | `jevitate:browser-check` | `jevitate check --suite` as a real-browser acceptance check. |
| `triz` | `triz:contradiction` | Resolve a genuine technical/physical contradiction, not brainstorm. |

## Coverage minimums

`validate.mjs` enforces:

- exactly 30 cases;
- at least 4 cases whose `tools` array is empty;
- at least 3 cases for every tool;
- at least 5 cases that name two or more distinct tools.

## Labelling rules

1. Tools resolve *manager-side* gaps: planning, risk, shared context,
   requirement discovery, experiment design, browser verification or a real
   contradiction. A small, well-specified change gets **no** tools even when a
   tool *could* be pointed at it.
2. `required` means skipping it would make the handoff unsound (unowned files,
   unmanaged risk, untestable acceptance, unverifiable UI). `recommended` means
   it helps but the handoff is defensible without it.
3. `managerSetup` is imperative and names only setup Junior's own loop needs,
   e.g. `sync a cpm plan with this deliverable`, `run matrix codemap init and
   pass matrix context`, `interview the requester before dispatch`.
4. `notTools` records the tools a router is most likely to over-suggest for the
   case's shape.
5. `triz:contradiction` appears only when the contract contains a real
   trade-off that cannot be satisfied by ordinary engineering.