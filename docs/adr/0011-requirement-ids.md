---
id: ADR-0011
title: One requirement id from elicitation claim to verified mitigation
status: accepted
date: 2026-10-23
supersedes: []
applies_to:
  - spec-bridge.ts
  - plan-junior.ts
  - worker.ts
  - fmeca-verify.ts
  - junior.ts
rules:
  - id: R1
    text: An acceptance entry may be a string or an object {id?, text, when?, checks?, mitigates?}. A supplied id matches ^[A-Za-z0-9:._/-]{1,128}$ and is unique within the contract; it is kept verbatim from the plan file to the contract, the prompt and result.json. An entry without an id is reported as AC<n> (1-based position), as today.
  - id: R2
    text: spec-bridge assigns criterion ids once, when it writes the draft plan, as <requirement id>/ac<n> (for example req:c1/ac2). After that the plan file is the definition; ids are never recomputed from position, so reordering or editing criteria in the plan keeps them.
  - id: R3
    text: The link from a criterion to a check is checks, a list of 0-based indexes into the contract's checks array. The link from a criterion to an fmeca mitigation is mitigates, a list of "<session_id>/<mitigation_id>" strings. Both live only on the criterion in the plan file (and the contract copied from it); fmeca stores no link back (fm-f31).
  - id: R4
    text: Each result.json criterion record carries id, text, verdict, probability, tier and, when set, mitigates. tier is check_passed when the criterion names checks and every named check ran in this run and exited 0; deterministic when Junior settled it without a model; judged when only the Jev postflight decided it; none otherwise.
  - id: R5
    text: junior fmeca propose-verified <result.json|run id> prints one proposal per (criterion, mitigation) pair whose criterion verdict is met at tier check_passed, as a ready set_mitigation_status request with status verified and evidence [{kind:test, reference:<run id>:<criterion id>, basis:test}]. It never calls fmeca; the manager applies proposals with junior tools call fmeca.
  - id: R6
    text: No fmeca schema change in 0.12. If a later need cannot be met by R3, it is a new ADR and an fmeca release, not a second store in Junior.
---

## Context

Issue #81. Today the same requirement has a different identity at every step:

- Elicitation exports requirements with ids such as `req:c1`, derived from
  the claims they rest on (`source_claims: ["c1"]`). Their
  `acceptance_criteria` are plain strings with no ids (fixture
  `tools/test-fixtures/companions/elicitation@0.1.1/spec.export.json`).
- `spec-bridge.ts` copies those strings into `metadata.junior.acceptance` and
  keeps only `metadata.source: elicitation:<session>/<requirement id>`.
- `worker.ts` (`assessPostflight`) numbers criteria `AC1..ACn` by position,
  so an edit that reorders criteria renumbers them, and AC2 in one contract
  is unrelated to AC2 in another.
- fmeca mitigations are marked `verified` by hand. In 0.10 a mitigation's
  description drifted from the code and nothing caught it (#91).
- fmeca's `Mitigation` (`crates/fmeca/src/model.rs:335`) has no refs field;
  its status changes take `evidence` of kind `test`, `commit`, `file`, ...

The project-plan FMECA (`junior-0.10.1-0.12-project-plan`) records two delivery
risks this ADR must close: FM1 needing an fmeca field that no deliverable
provides (`pp-fm1-upstream-field`), and the same fact in two stores
(parent `fm-f31-fact-two-stores`).

## Decision

1. **One id, assigned once.** spec-bridge gives each criterion the id
   `<requirement id>/ac<n>` when it drafts the plan (R2). Manager-written plans
   may supply their own ids. The plan file is the definition from then on.
2. **The id travels unchanged.** `junior plan contracts` copies acceptance
   objects as they are; `validate` accepts `{id, text, when, checks,
   mitigates}`; the postflight and result use the supplied id, falling back to
   `AC<n>` (R1).
3. **Links live on the criterion.** Which checks prove a criterion and which
   mitigations it verifies are both written on the criterion (R3). The plan
   file is already reviewed and versioned with the code, so the link has one
   owner and changes in a pull request.
4. **A tier says how a verdict was reached.** `check_passed` means a named
   check ran and passed in this run, so a model's opinion alone never
   verifies a mitigation (R4). This is the "ran-and-passed" tier #81 named.
5. **Junior proposes; the manager applies.** `propose-verified` prints ready
   requests and changes nothing (R5), matching fmeca's rule that the model
   proposes and the code, or a person, decides.

## Shapes

Contract acceptance entry (plan `metadata.junior.acceptance[]`):

```json
{"id": "req:c1/ac1", "text": "CSV export includes a header row",
 "checks": [0], "mitigates": ["junior-pi-hub-technical-plan/mit-f12-pi-api-drift-4"]}
```

result.json criterion record:

```json
{"id": "req:c1/ac1", "index": 0, "text": "CSV export includes a header row",
 "verdict": "met", "probability": 1, "tier": "check_passed",
 "mitigates": ["junior-pi-hub-technical-plan/mit-f12-pi-api-drift-4"]}
```

propose-verified output (one per pair):

```json
{"criterion": "req:c1/ac1", "run": "EXPORT1/1792735795378",
 "request": {"tool": "append", "arguments": {"session_id": "junior-pi-hub-technical-plan",
   "variant": "set_mitigation_status", "mitigation_id": "mit-f12-pi-api-drift-4",
   "status": "verified",
   "evidence": [{"kind": "test", "reference": "EXPORT1/1792735795378:req:c1/ac1", "basis": "test"}],
   "note": "criterion req:c1/ac1 met at tier check_passed"}}}
```

## Consequences

- FM1 can be built and tested against a recorded result.json in the shape
  above before ELI1b lands (plan 16 interface edge ADR11 -> FM1).
- Contracts without ids, `checks` or `mitigates` behave exactly as today.
- A criterion whose text changes keeps its id; if its meaning changes, the
  manager gives it a new id in the plan, and old results stay attached to the
  old one.
- Personas (PER1) are out of scope here; they wait for the A0 audit.
