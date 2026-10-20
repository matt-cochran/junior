# Tools

[Back to the README](../README.md)

### Common tool handoffs

`node junior.ts tools init hop.json config.json`, `tools call hop.json fmeca|cpm|crossmatrix request.json`, and `tools inspect hop.json` expose the same persistent Praxec adapter to managers and workers. See [tool configuration and native state](tools/README.md). Add `hopFrom` to a delivery contract to provide the latest integrity-checked snapshots to both Jev gates and the worker, without loading transcripts. Context is bounded to the latest snapshot per tool. State changes invalidate previous acceptance; workers never accept their own work. Manager acceptance is an explicit library operation, not authentication or a security boundary.

## The three `junior tools call` forms

`junior tools call [<hop.json>] <fmeca|cpm|crossmatrix|scientific-process|elicitation> <request.json|-> [key=value ...] [--full]`
executes exactly one upstream MCP call, advances the HOP revision and records
evidence. The hop defaults to `.delivery/setup/hop.json`. Output is the bare tool
result; a failure prints `{ "ok": false, "error": ... }` and exits `1`; `--full`
prints the whole envelope. The positional tail after the tool selects one of
three request forms:

```bash
# inline <method> key=value ...: a value that parses as JSON is JSON, else a raw string
junior tools call cpm plan.status plan_id=plan_123
junior tools call cpm plan.schedule plan_id=plan_123 'capacities={"agent":3}'

# stdin (`-`): the whole request object as JSON
echo '{"tool":"plan.status","arguments":{"plan_id":"plan_123"}}' \
  | junior tools call cpm -

# request file: the same object read from a JSON file
junior tools call cpm request.json
```

A request object sets `tool`, `arguments`, and the optional `expectedRevision`
and `timeoutMs`; see [tool configuration and native state](tools/README.md).

## `junior routes`

`junior routes [--json] [<query>]` is the routing manifest for a manager that
woke up without its conversation. Without a query it prints every route in
declaration order; with a query it ranks routes by deterministic keyword overlap
and prints the top three. `--json` prints the same `Route` objects (ranked when a query
is given). Each route carries `id`, `job`, `triggers`, `first`, `then`, the
companion `skill` and the `junior tools call` forms, for example
`junior routes "the request is vague"`.

## Companion skills and MCP names

Companion skills name their upstream MCP servers and tools (`fmeca-mcp`,
`cpm-planner`, `crossmatrix-mcp`). Do not register those servers just to follow
a skill: map each named method to `junior tools call <tool> <method>`, which
spawns the managed binary and returns the bare result. No MCP registration is
required for the manager loop.

`scientific-process` keeps its session in process memory and the wrapper spawns
a fresh server per call, so a `scientific-process` call that is not itself
`session.open` opens the session automatically in the same process before
forwarding the method (`session_id` defaults to `default`). A companion-skill
call therefore needs no explicit `session.open`.

## Companion response fixtures

Junior reads companion responses through one shape adapter
(`companion-shapes.ts`), tested against recorded responses under
`tools/test-fixtures/companions/<tool>@<version>/` and indexed by
`tools/test-fixtures/companions/index.json`. Regenerate them with
`node scripts/capture-companion-fixtures.mjs`. `junior doctor` warns when an
installed companion version has no recorded fixtures, so a new response shape
surfaces before it is parsed in production.

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
