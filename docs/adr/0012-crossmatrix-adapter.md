---
id: ADR-0012
title: Junior writes only declared, existing crossmatrix structure; crossmatrix stays standalone
status: accepted
date: 2026-10-23
supersedes: []
applies_to:
  - codemap.ts
  - state-sync.ts
  - matrix.ts
  - matrix-autopilot.ts
  - tools/test-fixtures/fake-mcp.mjs
rules:
  - id: R1
    text: Crossmatrix is a standalone tool. Junior uses only its public crossmatrix.command and crossmatrix.query contract and never asks for Junior-specific behaviour in crossmatrix. Every dimension, scale and relation Junior needs is declared by the Junior command that writes to it, with idempotent request ids.
  - id: R2
    text: A relation is declared, and observed on, only when both of its dimensions are registered in the model. A missing default dimension is skipped with a note; a dimension the user named explicitly (for example --feature-dimension) and that is missing is an error.
  - id: R3
    text: A member's state is a member attribute written by its own roster sync, never an observation. matrix sync --source cpm with --hop and --plan adds attributes.status from plan.status (complete, in_progress, ready, pending, failed); matrix sync --source fmeca adds attributes.criticality, residual_criticality, standing and disposition from state.get. Self-edge status observations are removed.
  - id: R4
    text: Cross-tool links are observations on relations Junior declares between existing dimensions. matrix sync --source state declares and writes - junior-fmeca-cpm (fmeca to cpm, relationType undermines, scale junior-reference, observation references) from a failure mode's refs naming cpm:<synced plan_id>/<deliverable id>; junior-fmeca-code (fmeca to code, undermines, junior-reference, references) from refs that name a path in the code roster; junior-cpm-fmeca (cpm to fmeca, relationType mitigates, scale junior-mitigation, observation planned|implemented|verified from the mitigation's fmeca status) from a plan criterion's mitigates entry <synced fmeca session>/<mitigation id> (ADR 0011 R3), resolved to the mitigation's failure mode. Refs or mitigates naming another plan or session are skipped with a note.
  - id: R5
    text: State-sync sources with no dimension that holds their members (elicitation claims, scientific-process hypotheses, jevitate journey results) write nothing and report one note each; their flags stay accepted. Giving them dimensions is a later ADR. A failed write of one relation is reported and the sync continues with the next; the command exits non-zero when any write failed.
  - id: R6
    text: Matrix, code-map and state-sync tests run against a strict crossmatrix test double that tracks registered dimensions, synced members and declared relations and rejects writes with the server's error codes (unknown_dimension, unknown_relation, unknown_member). One opt-in test runs the setup against an installed crossmatrix-mcp.
---

## Context

The X12 trace for 0.12 (#81) tried to show a requirement's trace in crossmatrix on a fresh model and could not
(#108-#111):

- `junior matrix codemap init` declares relations for `jevitate-jobs` and `jevitate-journeys` even when the
  model has no Jevitate dimensions, and stops with `unknown_dimension`.
- every `matrix sync --source state` mapper observes on a `codemap-<dim>` relation (declared `<dim> -> code`)
  with members that are not in those dimensions: `cpm:X -> cpm:X` status self-edges, `fm:`, `claim:`,
  `hypothesis:` and `journey-result:` members that no dimension holds, and relations that are never declared.
  The first write fails with `unknown_member` and aborts the sync.
- failure-mode `refs` (`cpm:<plan_id>/<deliverable>`, paths) are ignored, so failure modes never link to
  deliverables or files.
- the crossmatrix test double accepts any write, so none of this failed a test.

Crossmatrix behaved correctly throughout. The defect is Junior's model of it.

## Decision

1. **Declare before writing, and only between real dimensions** (R1, R2). Junior owns its vocabulary
   (`junior-*` relations and scales); crossmatrix gains nothing Junior-specific and keeps working for
   projects that never run Junior.
2. **State on rosters, links as observations** (R3, R4). Status is a property of a member, so it travels
   with the roster the owning source already syncs. Observations are kept for what crossmatrix is for:
   weighted links between members of two dimensions, each with evidence pointing back to the source of
   truth (the plan file criterion, the fmeca session).
3. **Mirror only what has a home** (R5). Claims, hypotheses and journey results have no dimension today;
   writing nothing with a clear note beats writing to the wrong relation.
4. **Test against the contract** (R6). The double mirrors crossmatrix's public errors, not Junior's
   expectations.

Scales declared by state sync: `junior-reference` (categorical, `references` = 3) and `junior-mitigation`
(categorical, `planned` = 1, `implemented` = 3, `verified` = 9).

The job -> persona relation from the A0 audit (PER1 follow-up) uses the same mechanism and is left to 0.12.

## Consequences

- A project with only code, tests, cpm and fmeca gets a working code map and a state mirror whose trace
  joins deliverable, test file, failure mode and mitigation.
- `matrix sync --source state` writes less than it claimed to before; everything it writes lands.
- Models synced before 0.11.1 hold no status observations (every one failed), so nothing needs migrating.
