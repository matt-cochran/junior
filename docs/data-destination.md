# Where your code goes

Junior sends repository text to a model in three situations: the worker (Pi) that does a handoff, the
readiness classifier (Jev) that checks a contract, and companion tools that make their own model calls.
Three separate controls decide what is allowed. They answer different questions.

| Control | Question it answers | Where it lives |
|---|---|---|
| **Consent** | May repository text leave this machine at all, for this project and provider? | `junior auth consent grant <provider> --project <dir>` |
| **Model policy** | Which model may run? Junior refuses frontier and unknown vendors, and a non-default model needs your approval. | `models.*` in `delivery.config.json`, `junior model ...` |
| **Data policy** | Who may process the request, under what data terms, and where? | `models.dataPolicy` in `delivery.config.json` (ADR 0017) |

Approving a model does not approve a destination. On OpenRouter one model is usually served by many
upstream providers, each with its own retention, training use and hosting country. Requests can also fall
back from one provider to another. The data policy is how you constrain that.

## The data policy

```json
{
  "models": {
    "dataPolicy": {
      "dataCollection": "deny",
      "zdr": true,
      "regions": ["US"],
      "providers": { "ignore": ["some-provider"] },
      "allowFallbacks": false
    }
  }
}
```

| Field | Effect |
|---|---|
| `dataCollection: "deny"` | Only providers that do not collect or store your data. OpenRouter enforces this. |
| `zdr: true` | Only Zero Data Retention endpoints. OpenRouter enforces this. |
| `providers.only` / `providers.ignore` | Allow-list or deny-list of upstream provider slugs (as listed for each model on openrouter.ai) |
| `regions` | Two-letter country codes. Junior keeps only providers whose listed datacenters are all in these countries and sends them as an explicit allow-list. OpenRouter has no region field of its own. |
| `allowFallbacks` | Defaults to `false` whenever a policy is set, so a request never moves to a provider outside the policy |
| `allowUncovered` | `typesafe` and/or `companions`: let paths that cannot carry the policy run anyway (see below) |

### What Junior guarantees

- **Every OpenRouter call Junior makes carries the policy.** The Pi worker gets it through its run-local model
  settings, and the classifier and Jev through the OpenRouter gateway.
- **Fails closed before spending anything.** If no provider of the chosen model satisfies the policy, the run
  stops with `data_policy_unsatisfied`. It names the constraint that ruled everyone out, and no model is called.
- **Verifies afterwards.** The receipt records which provider actually served each request, with its
  headquarters and datacenters. A served provider outside the policy fails the run with `data_policy_violated`.
- **Paths that cannot carry the policy are refused, not silently exempt.** The TypeSafe direct Jev gateway and
  companion tools that call a model themselves cannot send OpenRouter routing preferences. While a policy is
  set they are refused unless you list them in `allowUncovered`.
- **Consent covers the destination.** `junior auth consent grant` shows the providers and regions your policy
  allows and records the policy. Widening the policy later (removing a constraint, adding a provider or region,
  allowing fallbacks) means the next run asks for consent again.

### What Junior cannot guarantee

- **A provider's own retention or training terms.** Junior does not know them beyond what `dataCollection` and
  `zdr` enforce. Read each provider's privacy policy (linked from openrouter.ai) if you need more.
- **Your OpenRouter account settings.** Account-wide privacy settings (training opt-out, logging, account-level
  provider lists) cannot be read through the API. `junior doctor` says it cannot verify them. Check them at
  <https://openrouter.ai/settings/privacy>.
- **In-region processing by OpenRouter itself.** The `eu.openrouter.ai` / `us.openrouter.ai` hostnames are a
  Business/Enterprise plan feature, not a request setting.

## Checking your posture

`junior doctor` reports:
- the routing preferences Junior will send;
- for each approved model, the candidate providers with their headquarters and datacenters, and which ones
  your policy keeps;
- a warning when no `dataPolicy` is set (the destination is then whatever OpenRouter chooses);
- that account-level settings cannot be verified, with the link above.

References: [OpenRouter provider routing](https://openrouter.ai/docs/features/provider-routing),
[OpenRouter privacy settings](https://openrouter.ai/settings/privacy), ADR 0017
(`docs/adr/0017-data-destination-policy.md`).
