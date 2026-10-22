---
id: ADR-0007
title: LiteLLM is a Pi custom provider; the model policy treats it as an aggregator
status: accepted
date: 2026-10-22
supersedes: []
applies_to:
  - model-policy.ts
  - billing.ts
  - setup.ts
rules:
  - id: R1
    text: Worker execution through LiteLLM uses a Pi models.json provider named litellm; Junior opens no HTTP connection of its own for execution.
  - id: R2
    text: The model policy treats litellm as an aggregator; a litellm model id must carry a vendor/ prefix, and the vendor decides commodity, frontier or unknown exactly as it does on OpenRouter.
  - id: R3
    text: A litellm run's cost is an estimate and is labelled as one; Junior never reports it as billed.
  - id: R4
    text: Jev does not go through LiteLLM; the Jev gateways stay openrouter and typesafe (ADR-0006).
---

## Context

Issue #70 asks for LiteLLM support. The J70 recon found that Pi, not Junior,
opens the provider connection: Junior spawns
`pi --provider <p> --model <id>` (worker.ts `buildPiArgs`). Pi already supports
custom OpenAI-compatible providers in `<agent-dir>/models.json` (`baseUrl`,
`api: "openai-completions"`, `apiKey` with `$ENV` interpolation), but treats
those definitions as chat-only, so Jev classification cannot use them. Today
`model-policy.ts` refuses any `litellm` provider as `unknown` because only
`openrouter` is an aggregator.

## Decision

1. LiteLLM is configured in Pi as a `models.json` provider named `litellm`
   (for example `baseUrl: "http://127.0.0.1:4000/v1"`,
   `apiKey: "$LITELLM_API_KEY"`). Junior's docs show the entry.
2. `model-policy.ts` adds `litellm` to `AGGREGATOR_PROVIDERS`. A litellm model
   id needs a `vendor/` prefix (`deepseek/deepseek-v4.1-flash`); an unprefixed
   id is refused as `unknown`.
3. Billing: `billing.mode: "openrouter"` capture is skipped for a non-OpenRouter
   run with a stated reason, and the receipt's cost is labelled estimated.
4. Doctor reports the `litellm` provider: whether Pi's `models.json` defines
   it, and whether its key variable resolves, never the value.
5. Jev stays on the ADR-0006 gateways.

## Consequences

A team with a LiteLLM proxy points Pi at it and pins `provider: "litellm"`
with vendor-prefixed models; the commodity-only rule keeps working because the
vendor prefix is still checked. LiteLLM spend is visible only as an estimate
unless a later change reads LiteLLM's spend API.
