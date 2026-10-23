---
id: ADR-0009
title: Plan contracts go through the clarity gate before delegation
status: accepted
date: 2026-10-23
supersedes: []
applies_to:
  - worker.ts
  - clarify.ts
  - plan-quality.ts
rules:
  - id: R1
    text: A contract with an explicit workflow stops for clarification when the readiness call decides clarify on the contract_clear trigger (contract_clear below 0.6), unless checkBack is off or the contract already came from a prepare brief or a clarification. A blocking_assumptions clarify alone does not stop it.
  - id: R2
    text: Answering a clarification for an explicit-workflow contract produces the same contract with the answers as constraints and the workflow unchanged; it never drafts a plan or brief in place of the requested workflow.
  - id: R3
    text: The gate threshold is CONFIDENCE_THRESHOLD (0.6) and changes only on evidence from the recorded check-back tally (hypothesis H16).
  - id: R4
    text: Plan-time scoring (junior plan check --jev) runs the worker's own readiness call on each plan contract; it adds no questions of its own and is opt-in because it is a paid call.
---

## Context

Value vetting with Junior's scientific-process companion (session
`junior-pi-hub-value`, offline experiments over 125 `.delivery` runs) found
that the runs that came back `ready_for_review` but needed repair (B11, J39,
J7) failed at the request, not at verification:

- Every written criterion was met by passing tests, and the Jev postflight
  passed all three at 0.67-0.90 (H3, H4 refuted). Checking the written criteria
  harder would not have caught them.
- The Jev preflight had flagged all three before they ran: `contract_clear`
  0.35-0.55, below the 0.6 threshold. Across real runs, `contract_clear < 0.6`
  flags 8 of 11 problem runs and 3 of 3 false-ready runs; the problem rate is
  18% among flagged contracts against 4% among unflagged ones (H9, H10).
- The flag was never acted on. The clarification gate in `worker.ts` runs only
  when the workflow is `auto`, and plan contracts always set one (`planContracts`
  defaults to `test_first`), so every plan-driven run skipped it.
- Today's readiness call decides `clarify` on all three contracts, so the gate
  alone would have stopped them (H12). Its questions are generic per contract
  part, but a respondent without hindsight who answered them with repository
  access named the repaired gap class in 3 of 3 cases and the exact defects in
  2 of 3 (H15).
- A narrower Jev question about unknown external shapes fired on half of the
  good contracts, so no new question is added (H11 inconclusive).

## Decision

1. **Gate explicit workflows.** `clarityGateApplies` extends
   `clarificationApplies`: for an explicit workflow, a `clarify` decision on
   the `contract_clear` trigger stops the run with a clarification
   batch before any worker starts. `checkBack: "off"` disables it; a contract
   with `preparedFrom` or `clarifiedFrom` never re-enters it. The `auto`
   behaviour, including the vague-feature playbook rule, is unchanged.
2. **Keep the requested workflow.** For an explicit-workflow task,
   `applyAnswers` returns outcome `contract`: the original contract with one
   `Clarified Qn: ... -> stance: answer` constraint per answered question,
   `clarifiedFrom` set, and the workflow unchanged, written to
   `clarified-contract.json` for the next `junior handoff`.
3. **Threshold.** The gate uses `CONFIDENCE_THRESHOLD` (0.6): it caught 3 of 3
   false-ready runs and also asks for clarification on about a third of good
   contracts. Each check-back is recorded (cost, and whether the contract
   changed) for H13 and H16; the threshold moves only on that evidence.
4. **Plan-time scoring.** `scorePlanContracts` calls `assessPreflight` on each
   plan contract, so plan check and the run judge the same input with the same
   questions. It is opt-in (`--jev`) because it is a paid classifier call.

## Consequences

- Fewer false `ready_for_review` handoffs from unclear contracts, at the cost
  of a clarification round on some clear ones; the tally decides whether 0.6 is
  right.
- Answering well needs investigation, not just reading the question (H15). A
  premium respondent costs about 45k tokens per contract; whether a commodity
  recon worker can answer as well is open (H17).
- Plan check can flag contracts before any lease, which is cheaper than a run
  that stops at the gate.

## Amendment (2026-10-23, live verification)

Live verification measured what the gate keys on. The readiness decision is
`clarify` on 121 of 122 recorded runs, because `blocking_assumptions` is at or
above 0.6 on 102 of 109 runs that came back clean. Keying the gate on the
decision would stop almost every plan run. The analysis behind the original
decision measured `contract_clear` alone, which flags 35% of clean runs and
both measured false-ready runs. R1 therefore keys explicit workflows on the
`contract_clear` trigger only, and plan-time scoring flags the same condition
(plus frontier-required and uncertain decisions). Recorded as H16 evidence in
`junior-pi-hub-value`. Auto-workflow behaviour is unchanged.

Plan-time scoring of generated plan contracts (`junior plan contracts`, which
carry the artifact text and acceptance but no code context) scored
`contract_clear` 0.24-0.55 on all nine deliverables of the 0.10 plan, all of
which succeeded once their contracts were enriched with context. Treat a
plan-time flag as "add context before delegating", not as a defect.
