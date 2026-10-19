# Models

[Back to the README](../README.md)

Junior executes only on commodity / open-weight models. A frontier or unknown
provider/model is refused before any classifier, worker or provider spend, and
Jev (`typesafe/jev-1.13`) is a classifier only, never an executor.

## Commodity-only policy

`model-policy.ts` classifies a provider/model pair offline and
case-insensitively. It resolves the vendor first:

- For an aggregator (`openrouter`), the id's leading `vendor/` segment names the
  vendor; one leading `~` floating-alias marker is stripped.
- For a direct provider, the provider name is the vendor (`zai` normalizes to
  `z-ai`), unless the id itself carries a `vendor/` prefix.
- A direct provider that does not host the id's vendor is refused even when the
  id names a commodity vendor.

The verdicts are:

- **commodity**: the vendors `deepseek`, `moonshotai`, `z-ai`, `qwen`, `minimax`
  and `meta-llama`, plus `openai/gpt-oss*` (open weight, treated as commodity).
- **frontier**: `anthropic`, `openai` (except `gpt-oss*`), `google`, `x-ai` and
  `xai`.
- **unknown**: an unrecognized vendor, an undetermined vendor, or the `typesafe`
  Jev classifier.

A frontier or unknown pin refuses the run before any spend. The result has
`status: needs_review`, a `workerError` of `frontier_model_refused: ...` or
`unknown_model_refused: ...`, and a `modelPolicy` record
`{ provider, model, class, reason, code }`. The compact handoff exposes it under
`model.policy`.

## Roster

The built-in roster is a set of OpenRouter commodity profiles:

| Profile | Provider | Model | Strengths |
| --- | --- | --- | --- |
| `general` (default) | `openrouter` | `deepseek/deepseek-v4.1-flash` | Bounded implementation: bug fixes, tests, small multi-file changes, docs and setup. Lowest cost; use unless the task clearly needs another profile. |
| `deep-reasoning` | `openrouter` | `deepseek/deepseek-v4-pro-0813` | Subtle debugging, concurrency, algorithms, performance work, or refactors whose correctness depends on careful analysis. |
| `long-horizon` | `openrouter` | `moonshotai/kimi-k2.7-code` | Long autonomous coding sessions with many tool calls, large-codebase navigation, and front-end or UI implementation. |
| `agentic-tools` | `openrouter` | `z-ai/glm-5.3` | Tool-heavy work: shell, build, CI and environment setup, scripting, and many small command steps. |
| `fast-mechanical` | `openrouter` | `qwen/qwen3.7-flash` | Cheap mechanical edits: renames, formatting, boilerplate and small summaries. |

`junior model list` classifies the catalog with the same policy and groups the
commodity ids by vendor.

## Routing

`delivery.config.json` drives the roster. A complete example:

```json
{
  "provider": "openrouter",
  "model": "deepseek/deepseek-v4.1-flash",
  "models": {
    "routing": "auto",
    "autoUpgrade": false,
    "approved": ["deep-reasoning"],
    "unapproved": "ask",
    "priceTolerance": 1.25,
    "roster": [
      { "id": "deep-reasoning", "model": "deepseek/deepseek-v4-pro-0813" },
      { "id": "agentic-tools", "disabled": true },
      {
        "id": "fast-mechanical",
        "provider": "openrouter",
        "model": "qwen/qwen3.7-flash",
        "strengths": "Cheap mechanical edits.",
        "openrouter": { "order": ["deepinfra"] }
      }
    ]
  }
}
```

- `models.routing` is `off`, `shadow` or `auto` (default `auto`). `off` never
  routes, `shadow` records the Jev recommendation without applying it, and
  `auto` applies it when the conditions below hold.
- `models.roster` overrides or extends the built-ins. An entry whose `id` matches
  an existing profile overrides only the fields it provides (`provider`, `model`,
  `strengths`), or removes the profile with `"disabled": true` (a default profile
  cannot be disabled). A new `id` needs `provider`, `model` and `strengths`; an
  incomplete new profile is reported in `rejected` and kept out of `roster`. A
  non-default profile whose model fails the commodity policy is also reported in
  `rejected`. A profile may also carry `openrouter` provider routing (`order`,
  `only`, `ignore`, `allow_fallbacks`, `sort`); see [Caching](#caching).
- `models.approved` lists the project-approved model keys (profile ids or model
  ids); the default profile never needs an entry. `models.unapproved` is `ask`
  (default) or `default`. See [Consent and approvals](#consent-and-approvals).
- `models.priceTolerance` is a finite number at least `1` (default `1.25`), the
  maximum input and output ratio for adopting a newer release. See
  [Pricing and price parity](#pricing-and-price-parity).
- The top-level `provider`/`model` pin the executor and the default profile. The
  pin is never rewritten; a frontier or unknown pin is reported as
  `pinnedVerdict` and refused at run time.
- `models.autoUpgrade` (boolean, default false) lets `junior update` adopt newer
  same-lineage commodity models at price parity; when false it only reports
  them.

Precedence is an explicit task model (`requested.source: task`) over a routed
profile (`routed`) over the project pin (`project`) over the built-in default
(`builtin`). Routing is eligible only when the contract names no model, is not a
`resumeFrom`/`repairFrom` run, Jev is on, `models.routing` is not `off`, and the
roster has at least two profiles; otherwise it is skipped and the reason is
recorded.

When routing is eligible, the readiness classify call adds exactly one
`model_profile` `choice` question whose criteria are the roster strengths.
`shadow` records the recommendation without applying it. `auto` applies a known
non-default profile only when the classifier's confidence reaches the `0.6`
threshold, the profile's model passes the commodity policy, and a human has
approved the profile (see below); otherwise the requested model stays. The route
is recorded on the result as `modelRouting` (`mode`, `eligible`, `profile`,
`confidence`, `applied`, `provider`, `model`, `reason`, plus `approval` when
consent applied) and in the compact handoff as `model.routing`.

## Consent and approvals

The default executor is the cheapest DeepSeek (`general`, DeepSeek V4.1 Flash).
Junior never moves to another model without a human approval. Neither a Jev
routing recommendation nor a model named in the contract counts as consent: a
non-default target stops the run in `status: needs_model_approval` before the
Pi worker starts. The Jev classify call has already produced the
recommendation, and the run writes the request to `model-approval.json` in its
artifact directory and mirrors it on the result as `modelApproval`; the compact
handoff exposes it as `model.approvalRequest` and the worker exit code stays
unset.

The request names the `profile` (or null for an explicit contract model), the
`provider` and `model`, the `defaultModel` it would replace, the Jev
`confidence` and matched `strengths` when there are any, a `reason`, the
`price` delta against the default (see below), and an `approve` object with the
`run` and `project` commands.

An approval applies at one of three scopes, most specific first:

- **run**: `--approve-model <key>` on `junior handoff` or `junior run` (the
  contract's `approveModel`).
- **plan**: `approvedProfiles` on the contract, or
  `metadata.junior.approvedProfiles` on a cpm plan, which
  `junior plan contracts` copies onto every skeleton.
- **project**: `models.approved` in `delivery.config.json`, written by
  `junior model approve <key>` and removed by `junior model revoke <key>`.

A key is a roster profile id or a model id; either matches. The default profile
never needs approval, and `junior model approve general` is a no-op.
`junior model approve` refuses a key that is not commodity. An applied approval
is recorded on `modelRouting.approval` as `{ source, key }` with `source` one of
`run`, `plan` or `project`.

`models.unapproved` controls what happens when a valid non-default target lacks
consent: `ask` (default) stops for approval, while `default` records the
recommendation on `modelRouting` (with `declined: true`) and runs on the project
default instead. The contract `modelProfile` field pins a roster profile, and it
too needs approval when it differs from the default.

## Pricing and price parity

Catalog prices are USD per million tokens: `inputPerM`, `outputPerM` and
`cacheReadPerM` (null when unknown). The OpenRouter catalog supplies the
headline prices from each model's `pricing`; Pi's local catalog supplies them
from each entry's `cost`. `junior model status` attaches each roster profile's
`price` and each newer release's price delta.

Every planned change carries a `price` delta with `from`, `to`, `inputRatio` and
`outputRatio` (target/source, rounded to two decimals, null when a price is
unknown or the source is zero) and `pricier` (true when either ratio rises,
null when a price is unknown). When the price came from an endpoint, the delta
also carries `priceSource` (`endpoint` or `headline`) and `provider`.

A newer release is adopted only at price parity. `models.priceTolerance` is the
maximum input and output ratio; a release is comparable only when both ratios
are within it. `models.autoUpgrade` applies only price-comparable versions. A
pricier automatic update is never applied: it is listed under `waiting` (reason
`waiting for price parity`, with its ratios) by `junior model upgrade` and
`junior update`, and `junior doctor` and the startup update notice report it as
waiting. An unknown price is treated as adoptable. An explicit `--to` target is
still planned when pricier, with `pricier` recorded for the TTY confirmation.

Parity is measured on the cheapest **tool-capable** OpenRouter endpoint, not the
headline price: for the bounded set of current pins and newest candidates,
Junior reads each model's endpoints and picks the endpoint that supports `tools`
with the lowest input-plus-output sum. When no endpoint supports tools, the
headline price stays and the source is `headline`.

## Caching

The compact handoff reports prompt-cache accounting under `model.cache`:
`input`, `cacheRead`, `cacheWrite`, and `hitRate`, the cache-read share of input
plus cache read rounded to two decimals (null when there was no activity to
measure).

With an opted-in authoritative billing capture, `model.upstream` lists the
captured OpenRouter generations aggregated by upstream provider
(`{ provider, generations, cachedTokens }`, largest first), or null when nothing
was captured. Billing also remains the source of `model.cost` when every
generation was accounted for.

A deliverable keeps one model and one upstream provider:

- After the final model is chosen and consented, the run writes
  `.delivery/<id>/route.json` with the `profile`, `provider`, `model`,
  `approval` and `decidedAt`. A later non-resume run with the same id and no
  explicit model reuses that decision while its approval still holds (or the
  model is the current default), recording `applied` with a `sticky:` reason. A
  revoked approval makes the record inert.
- On OpenRouter, an affinity key is set for the whole deliverable lineage. It is
  a hash of the source path and the lineage root id, so a descriptive
  deliverable id never leaves the machine and continuation segments, repairs and
  re-dispatches of one deliverable share it. Junior sends it as the
  `x-session-id` request header, which keeps OpenRouter on one upstream provider
  and its warm prompt cache. The run records it under
  `providerRouting.affinityKey`.
- A roster profile may carry OpenRouter provider routing (`order`, `only`,
  `ignore`, `allow_fallbacks`, `sort`), merged into the request's provider
  settings for that profile and recorded under `providerRouting.openrouter`.

## Receipt fields

- `requested`: the provider/model passed to Pi, plus `source` (`task`, `routed`,
  `project` or `builtin`).
- `modelRouting`: the route record above, including `approval`, `needsApproval`
  or `declined` when they apply.
- `modelApproval`: the consent request on a `needs_model_approval` result.
- `providerRouting`: `{ affinityKey, openrouter }` (both null for a
  non-OpenRouter run).
- `modelPolicy`: present on a blocked result when the policy refused the model.
- The compact handoff `model` carries `requested`, `routing`, `approval`,
  `approvalRequest`, `policy`, `observed`, token totals, `cache`, `upstream` and
  cost.

## Detection

- `junior doctor` prints a `model` object: `pinned` (`provider`, `id`, `source`,
  `path`), `policy` (`class`, `reason`), `routing`, `autoUpgrade`, `roster` (each
  profile's `available` against the local catalog, and `default`), `rejected`,
  and `newer` (each release with its `comparable`, `inputRatio` and
  `outputRatio`). Non-blocking `warnings` name a newer commodity release
  per profile with `junior model upgrade`, noting `price-comparable` or
  `waiting for price parity (inputx/outputx)`, and any rejected roster profile.
  A frontier or unknown pin adds remediation and fails `ok`.
- The cached startup update check (24 hours; `JUNIOR_NO_UPDATE_CHECK=1`
  disables) adds one `model:<id>` entry per newer latest release, annotated
  `(price-comparable)` or `(waiting for price parity ...)`, and a
  `junior model upgrade` remediation.
- Catalog reads: `--online` fetches the OpenRouter catalog
  (`GET https://openrouter.ai/api/v1/models`) with a bounded timeout, plus the
  endpoints (`GET https://openrouter.ai/api/v1/models/<id>/endpoints`) for the
  bounded adoption candidates. When it is unreachable, the local Pi catalog is
  the fallback (`models-store.json`, then `models.json` under
  `$PI_CODING_AGENT_DIR`, default `~/.pi/agent`). Neither read throws; a missing
  catalog yields no updates.

## `junior model`

- `junior model status [--online]`: read-only. Prints `pinned`, `policy`,
  `routing`, `autoUpgrade`, `approved`, `unapproved`, `priceTolerance`, `roster`
  (each profile with its `price`), `rejected`, `catalog`
  (`online`/`local`/null) and `updates`.
- `junior model list [--online] [--vendor <v>]`: read-only. Prints commodity
  `models` and per-`vendors` groupings from the catalog.
- `junior model approve <profile|model>` / `junior model revoke
  <profile|model>`: add or remove a project approval in `models.approved`.
  Approve refuses a non-commodity key; approving the default profile is a no-op.
- `junior model upgrade [--profile <id>] [--to <id>] [--online] [--dry-run]
  [--yes]`: plans same-lineage upgrades at price parity. `--profile` limits the
  plan to one profile; `--to` names an explicit target for the selected profile
  (the default profile when none is given) and is refused with a reason when it
  is not commodity. The result carries `changes` (each with its `price`),
  `refused`, `waiting`, `pricier` and `applied`. Without `--dry-run` it writes
  `delivery.config.json` only with `--yes`, or after a TTY confirmation; a
  non-TTY run without `--yes` refuses and exits nonzero. A default-profile change
  sets the top-level `model`; a non-default change updates the matching
  `models.roster` entry.
- `junior update` runs the same adoption: when `models.autoUpgrade` is true,
  newer price-comparable commodity models are applied; others are reported. The
  result carries `models` (`enabled`, `changes`, `refused`, `waiting`,
  `applied`, `catalog`).
