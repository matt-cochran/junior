---
id: ADR-0017
title: Data-destination policy - Junior constrains and records who processes each model request, and fails closed
status: accepted
date: 2026-11-14
supersedes: []
applies_to:
  - data-policy.ts
  - gateway.ts
  - pi-overlay.ts
  - worker-preflight.ts
  - worker-receipt.ts
  - handoff.ts
  - doctor-data-policy.ts
  - auth.ts
rules:
  - id: R1
    text: delivery.config.json may hold models.dataPolicy = {dataCollection?: allow|deny, zdr?: boolean, providers?: {only?: string[], ignore?: string[]}, regions?: string[] (ISO 3166-1 alpha-2 codes), allowFallbacks?: boolean, allowUncovered?: ('typesafe'|'companions')[]}. Unknown fields or malformed values fail validation before any paid call. With no dataPolicy Junior sends no routing preferences and doctor warns that the destination is unconstrained.
  - id: R2
    text: The resolved policy maps to OpenRouter's provider object - data_collection, zdr, only, ignore, allow_fallbacks (default false whenever a dataPolicy is set). regions has no OpenRouter field; Junior resolves it by intersecting each candidate endpoint's provider (from GET /api/v1/models/{model}/endpoints) with providers whose datacenters (GET /api/v1/providers) all lie in the allowed regions, and sends the result as only. These lookups are unauthenticated metadata reads made by Junior's code paths, cached per run.
  - id: R3
    text: Every Junior call path that sends repository text through OpenRouter carries the same preferences - the Pi worker through compat.openRouterRouting in the run-local models.json overlay, and the readiness classifier and Jev through the openrouter gateway request body. A path that cannot carry them (the TypeSafe direct gateway, companion tools that call a model themselves) is refused while a dataPolicy is set, with refusal data_policy_unsatisfied naming the path, unless the policy lists it in allowUncovered.
  - id: R4
    text: Fail closed before spend. When no endpoint survives the policy (empty only after region resolution, every allowed provider ignored, or a provider with no datacenter data under a regions policy), preflight stops the run with outcome data_policy_unsatisfied, a reason naming the model and the constraint that emptied the set, and zero model calls.
  - id: R5
    text: After a run the receipt records, per served request, the upstream provider, its headquarters and datacenters, and whether it satisfied the policy. A served provider outside only, inside ignore, or outside the regions marks the run failed with data_policy_violated even when checks passed.
  - id: R6
    text: junior auth consent grant shows the effective policy and the providers and regions it permits, and stores a hash of the resolved policy in the consent record. A later policy that widens the destination (removes a constraint, adds a provider or region, enables fallbacks) does not match the stored hash, and the next run stops at consent_required.
  - id: R7
    text: junior doctor reports the posture - the preferences Junior will send, per approved model the candidate providers with headquarters and datacenters, and which ones the policy keeps. Account-level OpenRouter privacy settings cannot be read by API; doctor says they cannot be verified and links https://openrouter.ai/settings/privacy. Junior never claims a provider's retention or training terms beyond what data_collection and zdr guarantee.
---

## Context

Junior's model policy decides *which model* may run and the consent record decides *whether* repository text
may leave the machine. Neither says who processes a request or where (#218). On OpenRouter one model is served
by many upstream providers with different retention, training and hosting, and requests fall back between them.
The recon (`docs/research/openrouter-data-policy.md`) found that OpenRouter enforces `data_collection`, `zdr`,
`only`, `ignore` and `allow_fallbacks` server-side, exposes provider headquarters and datacenters but no
retention data, and has no region field; Pi forwards `compat.openRouterRouting` verbatim.

## Decision

1. **One policy, every path** (R1, R3). The policy lives in project config and every OpenRouter call Junior
   makes carries it. Paths that cannot carry it are refused rather than silently exempt.
2. **Use what OpenRouter enforces; compute what it does not** (R2). Data collection and retention use the
   server-side flags. Regions are resolved by Junior to an explicit provider allow-list with fallbacks off.
3. **Fail closed, verify after** (R4, R5). An unsatisfiable policy costs nothing; a served request that broke
   the policy fails the run.
4. **Consent covers the destination** (R6), and doctor shows the posture honestly, including what cannot be
   verified (R7).

## Consequences

- A strict policy can leave a model with no endpoint; the run says which constraint did it.
- `allow_fallbacks: false` trades availability for a predictable destination.
- Companion tools that call models are unavailable under a policy until they accept routing preferences.
