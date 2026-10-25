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
