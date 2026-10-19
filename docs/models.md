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

| Profile | Model | Strengths |
| --- | --- | --- |
| `general` (default) | `openrouter/deepseek/deepseek-v4.1-flash` | Bounded implementation: bug fixes, tests, small multi-file changes, docs and setup. Lowest cost; use unless the task clearly needs another profile. |
| `deep-reasoning` | `openrouter/deepseek/deepseek-v4-pro-0813` | Subtle debugging, concurrency, algorithms, performance work, or refactors whose correctness depends on careful analysis. |
| `long-horizon` | `openrouter/moonshotai/kimi-k2.7-code` | Long autonomous coding sessions with many tool calls, large-codebase navigation, and front-end or UI implementation. |
| `agentic-tools` | `openrouter/z-ai/glm-5.3` | Tool-heavy work: shell, build, CI and environment setup, scripting, and many small command steps. |
| `fast-mechanical` | `openrouter/qwen/qwen3.7-flash` | Cheap mechanical edits: renames, formatting, boilerplate and small summaries. |

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
    "roster": [
      { "id": "deep-reasoning", "model": "deepseek/deepseek-v4-pro-0813" },
      { "id": "agentic-tools", "disabled": true },
      {
        "id": "fast-mechanical",
        "provider": "openrouter",
        "model": "qwen/qwen3.7-flash",
        "strengths": "Cheap mechanical edits."
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
  `rejected`.
- The top-level `provider`/`model` pin the executor and the default profile. The
  pin is never rewritten; a frontier or unknown pin is reported as
  `pinnedVerdict` and refused at run time.
- `models.autoUpgrade` (boolean, default false) lets `junior update` adopt newer
  same-lineage commodity models; when false it only reports them.

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
threshold and the profile's model passes the commodity policy; otherwise the
requested model stays. The route is recorded on the result as `modelRouting`
(`mode`, `eligible`, `profile`, `confidence`, `applied`, `provider`, `model`,
`reason`) and in the compact handoff as `model.routing`.

## Receipt fields

- `requested`: the provider/model passed to Pi, plus `source` (`task`, `routed`,
  `project` or `builtin`).
- `modelRouting`: the route record above.
- `modelPolicy`: present on a blocked result when the policy refused the model.
- The compact handoff `model` carries `requested`, `routing`, `policy`,
  `observed`, token totals and cost.

## Detection

- `junior doctor` prints a `model` object: `pinned` (`provider`, `id`, `source`,
  `path`), `policy` (`class`, `reason`), `routing`, `autoUpgrade`, `roster` (each
  profile's `available` against the local catalog, and `default`), `rejected` and
  `newer`. Non-blocking `warnings` name a newer commodity release per profile
  with `junior model upgrade`, and any rejected roster profile. A frontier or
  unknown pin adds remediation and fails `ok`.
- The cached startup update check (24 hours; `JUNIOR_NO_UPDATE_CHECK=1`
  disables) adds one `model:<id>` entry per newer latest release and a
  `junior model upgrade` remediation.
- Catalog reads: `--online` fetches the OpenRouter catalog
  (`GET https://openrouter.ai/api/v1/models`) with a bounded timeout. When it is
  unreachable, the local Pi catalog is the fallback (`models-store.json`, then
  `models.json` under `$PI_CODING_AGENT_DIR`, default `~/.pi/agent`). Neither
  read throws; a missing catalog yields no updates.

## `junior model`

- `junior model status [--online]`: read-only. Prints `pinned`, `policy`,
  `routing`, `autoUpgrade`, `roster`, `rejected`, `catalog`
  (`online`/`local`/null) and `updates`.
- `junior model list [--online] [--vendor <v>]`: read-only. Prints commodity
  `models` and per-`vendors` groupings from the catalog.
- `junior model upgrade [--profile <id>] [--to <id>] [--online] [--dry-run]
  [--yes]`: plans same-lineage upgrades. `--profile` limits the plan to one
  profile; `--to` names an explicit target for the selected profile (the default
  profile when none is given) and is refused with a reason when it is not
  commodity. Without `--dry-run` it writes `delivery.config.json` only with
  `--yes`, or after a TTY confirmation; a non-TTY run without `--yes` refuses and
  exits nonzero. A default-profile change sets the top-level `model`; a
  non-default change updates the matching `models.roster` entry. The result
  carries `changes`, `refused` and `applied`.
- `junior update` runs the same adoption: when `models.autoUpgrade` is true,
  newer commodity models are applied; otherwise they are reported unapplied. The
  result carries `models` (`enabled`, `changes`, `refused`, `applied`,
  `catalog`).
