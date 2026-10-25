---
id: ADR-0013
title: Open-issues production release scope
status: accepted
date: 2026-10-25
supersedes: []
applies_to:
  - worker.ts
  - compute.ts
  - compute-hetzner.ts
  - package.json
  - docs/adr/0013-open-issues-release-scope.md
rules:
  - id: R1
    text: The #101, #102, #103, #117, and #121-#128 release scope is implemented and verified through bounded local or fixture-backed execution before release acceptance.
  - id: R2
    text: External model-context handoffs must retain the provider, model, scope, evidence and cost receipt; cloud provisioning, SSH targets and npm publication require an explicit owner-controlled action.
---

# 0013: Open-issues production release scope

## Status

Accepted 2026-10-25 by the release owner.

## Decision

Deliver all currently open issues in `matt-cochran/junior` (#101, #102, #103,
#117, #121, #122, #123, #124, #125, #126, #127, and #128) in the selected
`open-issues-production-release/pi-transport-overlap` plan variant. Publish the
result as the next minor release of `@matthew-cochran/junior` after independent
review, a clean release candidate, and owner-controlled npm publication.

Junior may send only the scoped repository context required by each bounded
handoff to the configured OpenRouter commodity model. Handoffs must retain the
provider, model, scope, evidence, and cost receipt. Real cloud provisioning,
real SSH targets, and npm publication remain explicit owner-controlled actions.

## Consequences

- Implementation is isolated in Junior worktrees and reviewed before application.
- Remote-compute implementation uses fake/local provider and transport fixtures
  until an owner separately authorizes real infrastructure actions.
- Any upstream CPM-planner capability required for #128 is linked and verified
  before the Junior release is accepted.
