---
id: ADR-0004
title: Tool versions are never pinned in Junior; updates are detected and adopted
status: accepted
date: 2026-10-16
supersedes: []
applies_to:
  - update-check.ts
  - self-update.ts
  - tools/**
rules:
  - id: R1
    text: Junior never writes a pinned version for a wrapped tool; it records the detected source version instead.
  - id: R2
    text: A version change is detected from the tool's declared source version and the new version is adopted rather than rejected.
---

## Context

Pinning a wrapped tool would freeze its bug fixes and force Junior releases for
changes it does not own. The hop already records each tool's source version and
sha at registration time.

## Decision

Junior records the detected source version but never pins it. Update checks
compare the recorded version to the live one and adopt the new version.

## Consequences

A tool can be upgraded independently of Junior. Compatibility is expressed by
the source version that the hop records, not by a lock in Junior's code.
