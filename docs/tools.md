# Tools

[Back to the README](../README.md)

### Common tool handoffs

`node junior.ts tools init hop.json config.json`, `tools call hop.json fmeca|cpm|crossmatrix request.json`, and `tools inspect hop.json` expose the same persistent Praxec adapter to managers and workers. See [tool configuration and native state](tools/README.md). Add `hopFrom` to a delivery contract to provide the latest integrity-checked snapshots to both Jev gates and the worker, without loading transcripts. Context is bounded to the latest snapshot per tool. State changes invalidate previous acceptance; workers never accept their own work. Manager acceptance is an explicit library operation, not authentication or a security boundary.

#### Reporting tool bugs upstream (`junior report-issue`)
When a companion or managed tool misbehaves, draft an issue for its own
repository instead of working around it silently:

```bash
junior report-issue cpm --title "plan.lint rejects a valid graph" \
  --body-file notes.md --hop .delivery/setup/hop.json   # draft only
junior report-issue cpm --title "plan.lint rejects a valid graph" \
  --body-file notes.md --hop .delivery/setup/hop.json --file   # after approval
```

Tools map to `praxec/fmeca`, `praxec/cpm-planner`, `praxec/crossmatrix`,
`matt-cochran/jevitate`, `matt-cochran/triz` and `matt-cochran/junior`. The draft
holds your description, an Environment section (Junior and tool versions, OS,
Node) and, with `--hop`, the tool's last ten evidence entries (never snapshot
contents). Secrets (`sk-…`, GitHub tokens, `Bearer …`, `*KEY/TOKEN/SECRET=…`)
are replaced with `[REDACTED]` and your home directory with `~`. Without
`--file` nothing is filed: it prints the draft and the exact `gh issue create`
argv. `--file` first searches open issues and refuses a same-title duplicate
unless `--force`. Filing publishes the draft, so show it to the human first.

#### Registering the MCP servers (`junior mcp register`)
`junior mcp register` derives the FMECA / CPM / Crossmatrix MCP servers from a
HOP manifest (so their state env is anchored to the manifest folder) and
registers them in an agent host:

```bash
junior mcp register --hop .delivery/setup/hop.json --target claude
junior mcp register --hop .delivery/setup/hop.json --target cursor --project .
junior mcp register --hop .delivery/setup/hop.json --target print
junior mcp register --hop .delivery/setup/hop.json --target codex
```

- `claude` merges under `mcpServers` in `<project>/.mcp.json`.
- `cursor` merges under `mcpServers` in `<project>/.cursor/mcp.json`.
- `print` writes the MCP config JSON to stdout and nothing to disk.
- `codex` writes a TOML `[mcp_servers.<name>]` snippet to stdout, since Codex
  config is TOML and is never written automatically.

`--project` selects the host directory (default: the current directory).
Existing unrelated servers and top-level keys are preserved. A same-name entry
whose content differs is reported as a conflict and left unchanged unless
`--force` replaces it; `--dry-run` reports planned changes without writing. The
JSON report lists `added`, `unchanged`, `conflicts` and `written`. `init` never
registers MCP servers implicitly.

Use `thinking: "low"` (the default) for bounded worker tasks; increase it explicitly for difficult deliverables. Output-limit termination is a failed receipt, even when existing checks pass. Newly written tests follow the shared atomic, declarative, one-behavioral-assertion convention.

Optional QA: `node junior.ts qa qa-contract.json` (or a `handoff` contract with `workflow: "qa"`) requires `reviewFrom` pointing at a prior result. It starts a fresh reviewer session, reviews in place, saves an evidence-based report, and flags detected production edits. Missing reports cannot succeed. Review completion is not manager acceptance; repairs require a separate deliverable. A prompt restriction is not an OS sandbox. QA checks should be read-only; it has the same filesystem permissions as the executor.

Development: `npm test` runs the offline public-behavior suites. No npm dependencies are needed. The legacy `worker.ts` CLI remains supported; `junior.ts` is the compact manager entry point. Runtime, evidence, isolation, setup, and tool adapters share one implementation each.

Private release repositories (including TRIZ) require `GH_TOKEN` or `GITHUB_TOKEN` with repository read access. Junior sends it only to the GitHub API host and drops authorization on asset redirects. Public Praxec releases require no token.

#### Frontier-attention classification

Jev preflight asks `requires_frontier` in the same classification call as
readiness. The compact handoff's `attention` field records the raw classifier
evidence, not just a label:

- `decision`: `frontier_required`, `delegate`, `clarify` or `uncertain`.
- `target`: `frontier`, `commodity` or `manager`.
- `trigger`: the readiness question that drove the decision —
  `requires_frontier`, `contract_clear`, `blocking_assumptions` or `error`.
- `probabilities`: the reported P(true) for each readiness question
  (`requires_frontier`, `contract_clear`, `blocking_assumptions`), or `null`
  when a question was unanswered.
- `probability`: the driving question's P(true), or `null`.
- `threshold`: the confidence threshold (`0.6`) at which a boolean answer
  becomes a definitive verdict.
- `reason`: a human-readable explanation naming the answer and its distance
  from the threshold.

Enforce mode stops frontier-required, missing or uncertain readiness before
starting the worker; shadow mode records it and continues. Off remains the
default. No frontier model is automatically called. Classification is advisory
evidence, not a calibrated capability guarantee.
