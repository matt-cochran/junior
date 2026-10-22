---
id: ADR-0006
title: Model calls go through named gateways; Jev may use OpenRouter or TypeSafe directly
status: accepted
date: 2026-10-22
supersedes: []
applies_to:
  - gateway.ts
  - worker.ts
  - tools/tools.ts
  - setup.ts
  - readiness.ts
rules:
  - id: R1
    text: Every gateway (base URL, key source, model-id mapping) is resolved through the one per-kind table in gateway.ts; no other module reads a provider key from the environment or the Pi auth file directly.
  - id: R2
    text: A gateway kind not in the table is rejected with an error naming the allowed kinds; it is never ignored or defaulted.
  - id: R3
    text: An OpenRouter key alone is a complete configuration; a TypeSafe key is optional and only changes where Jev calls go.
  - id: R4
    text: jev.provider typesafe without a TypeSafe key is an error; Junior never silently switches to a different paid path.
  - id: R5
    text: Key values never appear in errors, receipts, run records, doctor output or logs.
---

## Context

Junior's Jev calls are hard-wired to OpenRouter (`DEFAULT_JEV` in worker.ts),
the companion tools each resolve `OPENROUTER_API_KEY` / `TYPESAFE_JEV_API_KEY`
their own way, and other proxies (LiteLLM, #70) are expected later. Issue #69.

## Decision

1. **Gateway table.** `gateway.ts` exports one table keyed by kind. This
   release ships two kinds:

   | kind | base URL | key (in order) | Jev model id |
   |---|---|---|---|
   | `openrouter` | `https://openrouter.ai/api` | `OPENROUTER_API_KEY`, then Pi `auth.json` `openrouter` | `typesafe/jev-1.13` (through Pi `registry.classify`, as today) |
   | `typesafe` | `https://api.typesafe.ai` | `TYPESAFE_JEV_API_KEY`, then Pi `auth.json` `typesafe` | `jev-1.13` (direct HTTP) |

   Adding a kind (for example `litellm` in #70) adds a table row plus its
   model-id mapping; call sites do not change. `baseUrl` may be overridden per
   kind (https, or loopback http for tests).

2. **Jev provider.** Task or project config `jev.provider`:
   `auto` (default) | `openrouter` | `typesafe`. `auto` picks `typesafe` when a
   TypeSafe key resolves, otherwise `openrouter`. An explicit provider whose key
   is missing is a typed error (R4); with no key at all, Jev is unavailable
   exactly as it is today (a missing classifier, not a pass).

3. **Direct TypeSafe call.** `POST {base}/v1/systemone` with
   `Authorization: Bearer <key>` and body `{state, model, questions}`, the same
   request and answer shapes crossmatrix's `assist/jev.rs` uses. The direct
   client implements the existing `GateClassifier` contract, so preflight,
   postflight, workflow and model-routing callers are unchanged.

4. **Execution stays put.** Worker execution keeps its current
   provider/model resolution and the model policy; this ADR only moves Jev.
   #70 extends the table to execution traffic.

5. **Companions.** Companion spawns get `OPENROUTER_API_KEY` as today and, when
   a TypeSafe key resolves, `TYPESAFE_JEV_API_KEY`, both from gateway.ts. An
   explicit value in the hop env still wins.

6. **Visibility.** The run record's `jev` section and `junior doctor` name the
   Jev provider and each gateway's status (configured / not configured), never
   a key (R5).

## Consequences

One OpenRouter key keeps working with no new setup. Users with a TypeSafe key
get direct Jev calls by setting nothing more than the key. Later gateways are a
table row, and an unknown kind fails loudly instead of quietly sending traffic
somewhere unexpected.
