---
id: ADR-0002
title: Every tool I/O from a worker goes through the hop
status: accepted
date: 2026-10-16
supersedes: []
applies_to:
  - worker.ts
  - tools/**
rules:
  - id: R1
    text: A worker performs every upstream tool call through the hop wrapper (`junior tools call`), never by spawning or calling a server directly.
  - id: R2
    text: Direct network and MCP access is confined to the hop implementation in tools/tools.ts.
---

## Context

Workers run commodity models against several MCP servers. If each worker spoke
to a server directly, timeouts, budgets, evidence capture and replay would be
reimplemented inconsistently and could not be audited.

## Decision

All tool input and output goes through the hop. The hop owns spawning, the
wall-clock and stdout budgets, evidence recording and replay. A worker only
hands the hop one `callHop` request and reads its outcome.

## Consequences

Every call is recorded with provenance and can be replayed or audited. Workers
cannot bypass the hop without an obvious new dependency.
