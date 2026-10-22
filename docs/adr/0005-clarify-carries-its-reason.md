---
id: ADR-0005
title: A clarify names the contract part, quotes it, and asks at least one question
status: accepted
date: 2026-10-22
supersedes: []
applies_to:
  - worker.ts
  - clarify.ts
  - handoff.ts
rules:
  - id: R1
    text: Every clarify attention (trigger blocking_assumptions or contract_clear) carries the contract part Jev judged least clear, a bounded excerpt of that part, and at least one numbered question.
  - id: R2
    text: The contract-part judgment is asked in the existing readiness call; a clarify never adds a Jev call.
  - id: R3
    text: The compact receipt projects the clarification batch (session, round, questions) whenever the result has one.
---

## Context

Issue #68: five `junior handoff` runs stopped at the Jev preflight with
`decision: clarify`, `trigger: blocking_assumptions`, and each receipt gave only
the probability. The J68 recon traced why:

- `blocking_assumptions` and `contract_clear` are boolean questions, so the
  attention has a probability and a reason string and nothing else
  (worker.ts `assessPreflight`, `assumptionClarifyReason`).
- The clarification loop seeds elicitation only from `task.acceptance` and an
  explicit `task.assumptions`, so its questions can be empty or generic
  (clarify.ts `seedFromContract`, `questionBatch`).
- The compact receipt drops the `clarification` batch that `result.json`
  already holds (handoff.ts `compactHandoff`).

The alternatives were a second Jev call per clarify to extract assumptions
(extra cost and latency, and Jev returns no free text), or routing every
blocking clarify to the paid `prepare` worker. Both cost more than the
problem needs.

## Decision

1. **Contract part, same call.** `assessPreflight` asks one more `choice`
   question, `contract_part`, in the existing readiness call, before the trait
   questions so it counts against `MAX_GATE_QUESTIONS`: "Which part of the
   contract is least clear or rests on an unstated assumption?" with options
   `deliverable`, `acceptance`, `constraints`, `checks`, `context`.
2. **Attention fields.** A clarify attention gains
   `part: {name, probability}`, `excerpt` (that part of the contract as Junior
   sent it to Jev, bounded to 600 characters), and `questions: string[]`.
   Non-clarify attentions are unchanged.
3. **Deterministic questions.** Junior builds the questions from fixed
   per-part templates over the excerpt (for example, for `acceptance`: "Which
   of these acceptance criteria can't be checked as written: <excerpt>?").
   There is always at least one. When the clarification loop runs, its
   elicitation questions come first and the template questions fill in only
   when elicitation returns none.
4. **Receipt.** `compactHandoff` includes `clarification: {sessionId, round,
   questions}` whenever the result has one, so the manager sees the questions
   without opening `result.json`.

## Consequences

The manager sees which part to fix, the text Jev objected to, and a concrete
question, at no extra Jev cost. Template questions are generic by design;
they point at the part instead of guessing at the assumption. Carrying
answered assumptions into a clarify-to-brief (`briefFromSpec` still writes
`assumptions: []`) is a separate follow-up.
