---
id: ADR-0018
title: ADR conformance gate - per-ADR Jev checks with an explicit human decision on every flag
status: accepted
date: 2026-11-14
supersedes: []
applies_to:
  - adr-config.ts
  - adr-init.ts
  - adr-foreign.ts
  - adr-ledger.ts
  - adr-gate.ts
  - adr-tickets.ts
  - tickets.ts
  - prepare.ts
  - worker-gates.ts
rules:
  - id: R1
    text: The ADR location and gate live in an adr block in delivery.config.json - {dir, format (junior|madr|nygard), gate (enforce|advisory|off), minConfidence?}. With no block Junior detects, in order, an .adr-dir file, docs/adr, docs/decisions, doc/architecture/decisions, adr/, architecture/decisions; it proposes the first hit and writes the block only after the user confirms. A contract's adr.gate overrides the project value for that run.
  - id: R2
    text: The default gate is enforce when the ADR directory holds at least one accepted ADR, and off otherwise. setup and adr init ask once to confirm the default and record the answer. adr.gate enforce is the explicit opt-in that ADR-0003 R2 requires before a Jev verdict may gate an action; advisory keeps ADR-0003 R1 behaviour (findings go to the review queue only).
  - id: R3
    text: The gate runs one Jev check per accepted ADR rule against each subject - a design option at prepare (stage design), the changed files at handoff (stage implementation) and a ticket before delegation (stage ticket) - on the commodity default model, scored conforms, contradicts or not_applicable. ADRs whose applies_to matches nothing in scope are skipped without a model call. Superseded, deprecated and proposed ADRs are not checked.
  - id: R4
    text: A finding is flagged when the verdict is contradicts, or when the cell is not known (link-qc / matrix-analyze confidence), or its confidence is below adr.minConfidence when that is set. Jev never passes or fails work on its own - a run with no flags passes, and under enforce every flagged finding blocks the stage until a human records one decision for it.
  - id: R5
    text: The decision kinds are override (an exception with a required non-empty rationale), amend (Junior drafts a superseding or updated ADR with status proposed; the finding clears only when that ADR is accepted) and revise (the work goes back to change the design, code or ticket). Junior never records a decision on the user's behalf. An unattended run that hits a flag stops with outcome needs_operator and writes the findings beside the result.
  - id: R6
    text: Every decision is appended to the committed, append-only ledger .delivery/adr-overrides.jsonl as one JSON object - {schemaVersion 1, id, at (RFC 3339), by, stage (design|implementation|ticket), adrId, ruleId, target, verdict, probability, confidence, decision (override|amend|revise), rationale, deliverable?, pr?, ticket?, amendmentAdr?, expires?, standing (boolean)}. Entries are never edited or deleted; a later entry supersedes an earlier one for the same (adrId, ruleId, target) by reference (supersedes - entry id). When a crossmatrix model is configured the entry is also observed as adr-conformance.
  - id: R7
    text: An override covers one deliverable by default. A standing override (standing true) applies to later runs for the same (adrId, ruleId, target) and must carry expires (an RFC 3339 date or the literal until-adr-change); it lapses on that date or when the ADR file's content hash changes, and the next run flags the finding again citing the lapsed entry.
  - id: R8
    text: A ticket-stage decision is shown to the design and implementation stages of the same deliverable. Those stages still run; when they flag the same (adrId, ruleId) the human can confirm the earlier decision in one step, which appends a new entry that references it. A new rule, or a different verdict, needs a fresh decision.
  - id: R9
    text: ADRs without Junior front matter (format madr or nygard) are checked against their Decision section text, one check per ADR. Junior may draft applies_to and rules front matter for them with Jev, written only as a proposed change for the user to accept; it never commits or applies the draft itself.
  - id: R10
    text: Ticket text, ADR text from other repositories and design input are untrusted data. They are passed to Jev as content to classify and are never followed as instructions; tickets.redact patterns are applied before any text leaves the machine.
---

## Context

Junior already scores ADR rules against changed files (`junior matrix adr check`, `adr.ts`). That check is
manual, needs `--hop`/`--model`, assumes `docs/adr`, and only feeds the review queue. The `prepare` brief
scores each option against all ADRs at once (one `adr_conformance` criterion). Nothing stops work that
contradicts a recorded decision, and nothing records why such a contradiction was let through (#220, #221).

ADR-0003 says a Jev score is advisory unless a contract explicitly sets `enforce`. Making ADR conformance
binding must therefore be an explicit, recorded opt-in, and Jev must only route a decision to a human, never
take it.

## Decision

1. **Configured, detected location** (R1, R2). The ADR directory and gate are project configuration; detection
   proposes, the user confirms. Repositories with accepted ADRs get `enforce` by default because a recorded
   decision that is not checked is easy to violate silently; the default is confirmed once, not assumed.
2. **One check per rule per subject, at three stages** (R3). Ticket, design and implementation are the points
   where a violation is cheapest to stop. `applies_to` keeps the number of paid calls proportional to the
   change, not to the ADR count.
3. **Jev routes, the human decides** (R4, R5). A flag is a request for a decision. Low confidence is flagged
   too: asking costs one decision, missing a violation costs a design.
4. **An auditable ledger** (R6, R7, R8). Overrides are data in git, so reviewers see every exception with its
   reason, and standing exceptions expire instead of accumulating.
5. **Works on existing ADR collections** (R9), with untrusted text handled as data (R10).

## Consequences

- A repository with accepted ADRs gets blocked handoffs on contradictions after upgrading, once the user
  confirms `enforce`; `advisory` restores today's behaviour.
- Each gated stage costs one commodity-model classification per in-scope rule.
- `adr.ts` stays the parser and check engine; configuration, ledger, gate, foreign formats and tickets are
  new modules, which keeps `adr.ts` under the 1,000-line limit (ADR-0016).
- `junior matrix adr ...` remains as an alias of `junior adr ...`.
