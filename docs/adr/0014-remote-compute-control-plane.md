---
id: ADR-0014
title: Remote compute is a provider-neutral, lease-fenced resource lifecycle with secure defaults and explicit local fallback
status: accepted
date: 2026-10-25
supersedes: []
applies_to:
  - compute/**
  - docs/adr/0014-remote-compute-control-plane.md
rules:
  - id: R1
    text: Junior controls remote compute through one provider-neutral adapter contract (inspect, attach, create, start, stop, resize, destroy, tag and reconcile) and keeps provider-specific API names, credentials, identifiers and retry rules inside the adapter. Contracts, prompts, plans, results and policy never encode a provider API, and an adapter that cannot perform a required operation reports unsupported rather than emulating it implicitly.
  - id: R2
    text: 'The only resource modes are adopt, managed-existing and provision. adopt attaches to an existing resource without lifecycle ownership and may read, connect to and release it, but never create, start, stop, resize or destroy it. managed-existing attaches to owner-supplied existing resource and may start, stop, resize and tag it only under a recorded delegation, but never creates or destroys it. provision lets Junior create a resource and manage its full lifecycle, but Junior may destroy only resources whose ownership record says Junior created them at the exact observed generation.'
  - id: R3
    text: 'Every managed resource has one ownership record: provider, account/project, resource id, mode, owning party, creator, current generation, tags, creation evidence and timestamps. Before any lifecycle mutation, reconciliation or destroy, Junior compares the observed identity, owner, tags and generation with that record. A missing, malformed, conflicting or unverifiable ownership record fails closed: no lease is granted and no create, start, stop, resize, destroy, adopt or steal action is attempted until an operator resolves it.'
  - id: R4
    text: 'A resource has a desired state and a separately observed lifecycle state (requested, provisioning, ready, leased, active, draining, released, dormant, destroying, destroyed or failed). Transitions are idempotent, keyed by a stable request id, and driven by observed provider facts, never by the assumption that a previous request succeeded. Desired and observed state that disagree are a reconciliation finding, not permission to force the desired state.'
  - id: R5
    text: 'Remote work requires a valid lease containing lease id, holder, resource id, resource generation and fencing token, issue time, expiry and heartbeat. At most one active work lease may use a resource generation. A lease is released on every success, failure, cancellation and timeout path; an expired lease is reclaimed only after its expiry plus a bounded grace period and a successful observation that no work is active. Lease or fencing uncertainty fails closed: no new work starts and no resource is resized, stopped or destroyed.'
  - id: R6
    text: 'Scale-to-zero is the default: minCapacity defaults to zero, maxCapacity and budget are finite and explicit, and idle resources scale down only when there is no valid lease, no unreclaimed expired lease, no queued work and reconciliation confirms no active work. A nonzero minimum capacity is an explicit per-resource opt-in with a stated reason. When activity or lease state is unknown, capacity is retained and the condition is reported rather than scaled down.'
  - id: R7
    text: 'Provider credentials, host credentials, tokens and other secret material never appear in contracts, prompts, plans, logs, results, diagnostics, error messages, repository files or committed artifacts. Secrets are obtained at use time from the environment, OS keychain or a secret manager, are short-lived and least-privilege, are scoped to one provider account and operation, are redacted from every emitted record, and are revoked or allowed to expire when the lease ends. A missing credential is a failed operation, never a reason to use a less-protected default.'
  - id: R8
    text: 'Reconciliation compares desired state, observed state and ownership, and is idempotent and safe to repeat. It detects orphans, drift, leaked resources, expired leases, tag or generation mismatches and unexpected cost, and reports findings with evidence. Reconciliation never creates, adopts, steals, resizes, stops or destroys a resource when ownership, identity or activity is uncertain; it records the finding and requires operator action. A resource is destroyed only after ownership, generation and lease quiescence are all confirmed.'
  - id: R9
    text: 'Local fallback is an explicit, observable policy decision, not a silent retry and not a reconciliation action. When remote compute is disabled, unavailable, unhealthy, over budget or loses its lease, Junior may run locally only if the contract and project policy allow local execution and the work does not require remote-only data, capacity or isolation. A fallback records the reason and the local execution receipt, preserves the same contract checks, scope and evidence rules, and never mutates or reclaims remote resources. If local execution is not allowed, the run fails with an actionable reason.'
  - id: R10
    text: 'Secure defaults are: remote compute disabled until a mode is explicitly selected; provision requires explicit opt-in; minCapacity zero; finite maxCapacity and budget; no public ingress by default; encrypted transport and storage; least-privilege identities; no long-lived credentials; no destructive action under uncertainty; and no automatic adoption or destruction of pre-existing resources. Any relaxation is a per-resource, recorded, reviewable exception.'
  - id: R11
    text: 'Every remote-compute run and reconciliation emits a secret-free receipt containing provider and adapter version, mode, resource identity and generation, ownership evidence, lease and fencing identity, state transitions, observed cost or an explicit unknown, reconciliation findings and any local-fallback reason. Unknown cost, capacity or activity is reported as unknown, never as zero or free.'
  - id: R12
    text: 'Conformance is proven with fake and local provider/transport fixtures using the three modes, zero and nonzero minimum capacity, lease expiry and fencing, ownership ambiguity, reconciliation drift, secret redaction and local fallback. No test, default or policy requires real cloud credentials or external infrastructure; real provisioning remains an explicit owner-controlled action under ADR 0013.'
---

## Context

Issue #123 adds a remote-compute control plane to the #101-#128 release scope.
That scope already says implementation uses fake or local provider and transport
fixtures until an owner separately authorizes real infrastructure, and that
real cloud provisioning, real SSH targets and publication remain owner
actions (ADR 0013).

Remote compute introduces failure modes that a local worker does not have:
a resource may exist before Junior knows about it, may be shared with another
owner, may be changed outside Junior, may keep running after a failed run, may
carry credentials, and may cost money while idle. A provider-specific design
would also make the policy depend on one vendor's lifecycle vocabulary and make
it hard to test without real infrastructure.

The release therefore needs an accepted policy before implementation: which
resources Junior may create or touch, who owns them, how work is leased, how
secrets are handled, how idle capacity reaches zero, how drift is reconciled,
and what happens when remote compute is unavailable. The policy must have safe
defaults rather than relying on an operator to remember every guardrail.

## Decision

### Provider-neutral adapter boundary

Junior speaks one logical adapter contract. The adapter owns provider-specific
authentication, endpoint names, request shapes and retries. The control plane
owns mode, ownership, lease, state, budget, reconciliation and fallback policy.
Adapter capabilities are advertised explicitly; a missing capability is an
`unsupported` result, not a degraded mode that silently changes the contract.

### Three ownership modes

| Mode | Existing resource | Create | Start/stop/resize | Destroy | Intended use |
| --- | --- | --- | --- | --- | --- |
| `adopt` | Yes | No | No | No | Observe, connect to and release a resource Junior did not create and does not manage. |
| `managed-existing` | Yes | No | Yes, with recorded delegation | No | Use owner-supplied capacity while the owner retains the resource. |
| `provision` | No | Yes | Yes | Yes, only for Junior-created resources at the observed generation | Fully owner-authorized ephemeral capacity. Real provisioning remains an explicit owner action. |

The mode determines the maximum permission. It never implies permission by
itself: the ownership record, lease and generation checks still apply. In
particular, `provision` is not a licence to delete an arbitrary resource that
happens to share a name or tag, and `managed-existing` never becomes `provision`
through a retry or a reconciliation pass.

### Ownership is fail-closed

Ownership is recorded once and checked before every mutating action. If the
record is missing, ambiguous, points at a different account, generation or tag,
or cannot be verified because the provider is unavailable, Junior treats the
resource as not-owned and not-leasable. It may report the condition and retry a
read, but it must not create a replacement, adopt the resource, steal a lease,
or destroy anything. Operator resolution is required. This is the ownership
uncertainty rule and it applies equally to `adopt`, `managed-existing` and
`provision`.

### Lifecycle, leases and fencing

A resource moves through requested, provisioning, ready, leased, active,
draining, released, dormant, destroying, destroyed or failed. Desired state and
observed state are kept separately. Every transition is idempotent and keyed by
a request id, so a retried request cannot create a second resource or apply a
second action.

Work uses a lease with a holder, resource generation, fencing token, expiry and
heartbeat. A stale holder cannot resume work merely because it still has a
process or a client object; the fencing token rejects its writes. An expired
lease is not reclaimed immediately: Junior waits for a bounded grace period and
observes that no work is active. When that observation cannot be made, the
resource is left in place and the lease conflict is reported.

### Scale-to-zero and cost

`minCapacity` defaults to zero and `maxCapacity` is finite. A resource is scaled
down only when no valid or unreclaimed lease exists, no work is queued, and
reconciliation confirms there is no active work. A nonzero floor is an explicit
opt-in with a reason. Unknown activity means retain capacity, because guessing
"idle" is not a safe basis for stopping a host that may still be running work.
Budgets and maximum capacity are checked before provisioning, not after the
first bill arrives.

### Secrets

Secrets are used, not stored. They are read at the point of use from the
environment, OS keychain or a secret manager, are short-lived and scoped to one
account and operation, and are redacted from logs, receipts, errors and model
context. Remote-host credentials are not copied into the repository, a plan, a
prompt or a result. Losing a credential fails the operation; it never causes a
fallback to a shared, ambient or less-protected credential.

### Reconciliation

Reconciliation is a read-first, idempotent comparison of desired state,
observed state and ownership. It finds orphans, drift, leaked resources, stale
leases, unexpected tags or generations and cost anomalies. It reports findings
with evidence and performs no destructive action while identity, ownership or
activity is uncertain. Destruction is the last step and requires all three
confirmations: Junior created the resource, the generation still matches, and
the lease is quiescent.

### Local fallback

Local execution is a supported outcome, but only as an explicit policy decision.
When remote compute is unavailable, unhealthy, over budget or the lease is lost,
Junior may fall back to local execution only when the contract and project
policy allow local execution and the work does not require remote-only data,
capacity or isolation. The fallback is recorded with its reason and a normal
local receipt, keeps the same checks, scope and evidence rules, and never
mutates remote resources. If local execution is not allowed, the run fails with
an actionable reason rather than silently changing where the work runs.

### Secure defaults

Remote compute is off until a mode is explicitly selected. `provision` needs
explicit opt-in; `minCapacity` is zero; maximum capacity and budget are
finite; public ingress is off; transport and storage are encrypted;
identities are least-privilege; credentials are short-lived; and destructive
actions are blocked under uncertainty. Relaxations are per-resource, recorded
and reviewable exceptions, not global defaults.

### Observability and conformance

Every lifecycle and reconciliation action emits a secret-free receipt with the
adapter and provider version, mode, resource identity and generation, ownership
evidence, lease and fencing identity, state transitions, observed cost or an
explicit unknown, findings and any fallback reason. Unknown cost or capacity is
reported as unknown, never as zero.

Conformance is tested against fake and local provider/transport fixtures: the
three modes, zero and nonzero minimum capacity, lease expiry and fencing,
ownership ambiguity, reconciliation drift, secret redaction and local
fallback. Tests do not use real cloud credentials or external infrastructure.
Real provisioning remains an explicit owner-controlled action under ADR 0013.

## Consequences

- The control plane can be implemented and tested with a fake provider before
  any real infrastructure exists.
- `adopt`, `managed-existing` and `provision` have different permissions, so a
  resource cannot be destroyed merely because a later mode would have been
  allowed to create one.
- Ownership ambiguity stops work. That is deliberate: a failed run is cheaper
  than deleting or mutating a resource Junior cannot prove it owns.
- Scale-to-zero and finite budgets limit idle cost, while a nonzero capacity
  floor remains available as a reviewed exception.
- Local fallback keeps small or data-local work moving during a remote outage,
  but it is visible in the receipt and cannot be used to bypass a contract that
  requires remote execution.
- Operators must resolve ambiguous ownership, stale leases and reconciliation
  findings; the policy reports them rather than guessing.
