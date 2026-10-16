---
id: ADR-0001
title: Tool state lives in the committed crossmatrix store and is mirrored by sync, never duplicated
status: accepted
date: 2026-10-16
supersedes: []
applies_to:
  - tools/**
  - feature:crossmatrix
rules:
  - id: R1
    text: Durable tool state lives in the committed crossmatrix store and is mirrored by sync, never duplicated in a second store.
  - id: R2
    text: A read path reads through the hop or the crossmatrix query API rather than keeping a private copy of the model.
---

## Context

Junior wraps several upstream MCP servers. Some of them own native state, and
Crossmatrix 0.3+ keeps its model in a committed `<project>/.crossmatrix` store.
A second copy of that state drifts and makes handoffs unreliable.

## Decision

The committed crossmatrix store is the single durable source of tool state.
`junior matrix sync` mirrors Junior's exported dimensions into it. No Junior
module keeps a parallel copy of the model or of an upstream native store.

## Consequences

Reads become query calls through the hop instead of local reads, which is
slightly slower but always consistent. Sync becomes idempotent because request
ids are content-addressed.
