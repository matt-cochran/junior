# OpenRouter data destination: what Junior can send, read and verify (recon for #218)

Recorded 2026-11-14 against the live OpenRouter API and docs, and Pi 1.5.2 (`@earendil-works/pi-coding-agent`).
This note feeds ADR 0017.

## 1. Request-time routing preferences (enforced by OpenRouter)

These go in the `provider` object of a chat-completions request
(https://openrouter.ai/docs/features/provider-routing):

| Field | Type | Default | Effect relevant to #218 |
|---|---|---|---|
| `data_collection` | `"allow"` \| `"deny"` | `"allow"` | `deny` routes only to providers that do not collect or store user data |
| `zdr` | boolean | unset | `true` routes only to Zero Data Retention endpoints. Safety-retention endpoints stay eligible unless the account's privacy settings force ZDR-only. |
| `only` | string[] | unset | Allow-list of provider slugs (for example `fireworks`, `deepinfra/fp8`) |
| `ignore` | string[] | unset | Deny-list of provider slugs |
| `order` | string[] | unset | Preferred order |
| `allow_fallbacks` | boolean | `true` | `false` stops routing outside `order`/`only` |
| `require_parameters` | boolean | `false` | Only providers that support every request parameter |
| `quantizations`, `sort`, `max_price`, `preferred_*`, `enforce_distillable_text` | — | — | Not data-policy related |

There is **no region or country field** on `provider`. Region appears only:
- as a suffix inside some provider slugs (`wafer/us`, `fireworks/us`, `baseten/us`, `google-vertex/global`), which `only` can target;
- as regional hostnames (`eu.openrouter.ai`, `us.openrouter.ai`) for in-region processing. These are Business/Enterprise plans only and are a base-URL choice, not a request field.

## 2. Discovery APIs (read-only, no key needed)

- `GET /api/v1/models/{author}/{slug}/endpoints` lists every serving endpoint. For each one it gives `provider_name`, `tag` (the slug that `only`/`ignore` take), `quantization`, `pricing`, `status`, uptime, `supported_parameters` and limits. It has **no data-policy, retention or region fields**. `deepseek/deepseek-v4.1-flash` had 37 endpoints today.
- `GET /api/v1/providers` lists 123 providers with `slug`, `privacy_policy_url`, `terms_of_service_url`, `headquarters` and `datacenters` (country codes). This is the only machine-readable location data.
- Per-provider retention and training policy is **not exposed by any API**. Junior can enforce it only through `data_collection: "deny"` and `zdr: true`, which OpenRouter applies server-side.

## 3. Account privacy settings

OpenRouter's account settings (https://openrouter.ai/settings/privacy) set the account-wide default: data collection, ZDR, and allowed or ignored providers. The docs describe no API to read them. Doctor must say these **cannot be verified** and link the page. Request-time preferences are the only part Junior controls.

## 4. How each Junior call path can carry the preferences

| Path | Mechanism |
|---|---|
| Pi worker | Pi's `models.json` per-model `compat.openRouterRouting` object. It is sent verbatim as the request's `provider` field (`openai-completions`, `docs/models-configuration.md`). Junior already writes a run-local `models.json` overlay (`pi-overlay.ts`, `OVERLAY_FILES`), so the policy can go there per run. |
| Readiness classifier / Jev via the OpenRouter gateway (`gateway.ts`) | Junior builds the request body itself, so it adds `provider` directly |
| Jev via TypeSafe direct gateway | Not OpenRouter. The policy cannot be expressed, so under a policy that requires it this path must be refused or disclosed as a different destination. |
| Companions (cpm `plan.review`, crossmatrix assist, fmeca vet, scientific-process assist, triz) | Each companion makes its own OpenRouter call. Junior can only pass environment or arguments the companion supports. Today none accept routing preferences, so under a policy they are either disabled or reported as outside the policy. |

## 5. What a served request reports

The OpenRouter response and generation stats name the provider that served the request (already captured as `model.upstream` / billing providers). Junior can check after the fact that the served provider was in `only` and not in `ignore`, and record that provider's `headquarters` and `datacenters` from `/api/v1/providers`.

## 6. Implications for ADR 0017

1. Data-policy enforcement is `data_collection: "deny"` and/or `zdr: true`, plus `allowFallbacks: false` and provider allow/deny lists. Junior should not claim to know a provider's retention terms beyond what those flags guarantee.
2. A region allow-list must be implemented by Junior. Resolve each candidate endpoint's provider through `/api/v1/providers` `datacenters`, intersect with the allow-list, and send the result as `only` with `allow_fallbacks: false`. An empty intersection, or a provider with no datacenter data, is the fail-closed `data_policy_unsatisfied` case. This decision is made before spend.
3. Paths that cannot carry the policy (TypeSafe direct, companions) must be refused or shown as uncovered whenever a policy is set. They must never be silently treated as covered.
4. Doctor reports account settings as "cannot verify" with the settings link.
