---
id: ADR-0003
title: Jev is advisory unless a contract sets enforce
status: accepted
date: 2026-10-16
supersedes: []
applies_to:
  - worker.ts
  - matrix-analyze.ts
  - link-qc.ts
rules:
  - id: R1
    text: A Jev score is advisory by default; it never blocks a write, a merge or a handoff on its own.
  - id: R2
    text: A contract must explicitly set enforce before a Jev verdict can gate an action.
---

## Context

Jev classifies gates and scores matrix cells with probabilities. Treating a
probabilistic model as an authority would make Junior brittle and would hide
low-confidence judgments behind a pass/fail.

## Decision

Jev recommends; the executor decides. Scores, confidences and contradictions
are surfaced for review, and only an explicit `enforce` in a contract turns a
verdict into a gate.

## Consequences

Low-confidence cells flow to the review queue instead of failing a run.
Enforcement stays a deliberate, per-contract choice.
