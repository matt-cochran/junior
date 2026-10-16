# junior-tools

A dependency-free TypeScript CLI + library that wraps five MCP servers —
**FMECA**, **CPM Planner**, **Crossmatrix**, **scientific-process** and
**elicitation** — behind a persistent, versioned JSON hand-off file (a
**HOP**). It is built for a two-role workflow:

> **Jev recommends, the executor executes.**
> `inspect` produces a compact context a frontier manager or the Jev classifier
> reads to *recommend* the next tool call. `call` is the executor path: it runs
> exactly one MCP call, records evidence, and persists the result. A worker call
> never marks its own work as manager-accepted — only `recordManagerAcceptance()`
> changes `managerAcceptance`.

Runs on Node's native TypeScript type-stripping (verified on Node v26.5.0).
No npm dependencies; Node builtins only.

## Requirements

- Node.js with native TypeScript execution (v22.6+ for `--experimental-strip-types`;
  v26 tested).
- The five upstream Rust MCP binaries on `PATH` or referenced by absolute path
  in the HOP config (see [Building the MCP servers](#building-the-mcp-servers)).
  The `scientific-process` and `elicitation` releases are not published yet, so
  `junior init` reports them as `unavailable` instead of failing.

## Quick start

```bash
# 1. Create a HOP from a config that points at the real binaries.
node tools.ts init ./hop.json ./config.json

# 2. Run one tool call (executor path). The request file selects tool + args.
node tools.ts call ./hop.json fmeca ./request.json

# 3. Read the compact manager/Jev context.
node tools.ts inspect ./hop.json
```

All three commands print JSON to stdout. Failures print
`{"ok": false, "error": {"code": "...", "message": "..."}}` and exit `1`;
successful commands exit `0`.

## CLI reference

| Command | Description |
| --- | --- |
| `node tools.ts init <hop.json> [config.json]` | Create a new schemaVersion 1 HOP. Refuses to overwrite an existing file. |
| `node tools.ts call <hop.json> <fmeca\|cpm\|crossmatrix\|scientific-process\|elicitation> <request.json>` | Execute one MCP call, advance the revision, persist evidence + snapshots. |
| `node tools.ts inspect <hop.json>` | Emit a compact snapshot context for a manager or the Jev classifier. |

## Config file (input to `init`)

`config.json` is optional. Omitted fields fall back to the built-in defaults. For
provenance, without a config override `init` records the version and source SHA
of Junior's managed install (`~/.junior/tools/installed.json`) when the tool's
command is that managed binary. Any other command records the version it
prints for `--version` (`"unknown"` when it prints none) and an empty source
SHA. There is no built-in release table; `junior update` installs new releases.

```json
{
  "projectId": "checkout-hardening",
  "timeoutMs": 30000,
  "lockTimeoutMs": 5000,
  "tools": {
    "fmeca": {
      "command": "/opt/praxec/bin/fmeca-mcp",
      "args": [],
      "env": {},
      "sourceVersion": "0.2.0",
      "sourceSha": "83d16022ff03fa6725c5ed517ea75caa5bce8694"
    },
    "cpm": {
      "command": "/opt/praxec/bin/cpm-planner",
      "args": [],
      "env": {},
      "sourceVersion": "0.3.0",
      "sourceSha": "c05a30809ea28fecd4f3c28b47c90890b0711701"
    },
    "crossmatrix": {
      "command": "/opt/praxec/bin/crossmatrix-mcp",
      "args": [],
      "env": {},
      "sourceVersion": "0.3.2",
      "sourceSha": "81a8fbec6af8350c9377479d9b904c7c5d321d12"
    },
    "scientific-process": {
      "command": "/opt/praxec/bin/scientific-process",
      "args": [],
      "env": {}
    },
    "elicitation": {
      "command": "/opt/praxec/bin/elicitation",
      "args": [],
      "env": {}
    }
  }
}
```

`command`/`args` are passed to `child_process.spawn` directly — **never a
shell** — so there is no command interpolation.

## Request file (input to `call`)

```json
{
  "tool": "state.get",
  "arguments": { "session_id": "s1" },
  "expectedRevision": 3,
  "timeoutMs": 10000
}
```

- `tool` is the upstream MCP tool name (`session.open`, `append`, `plan.submit`,
  `crossmatrix.command`, `crossmatrix.query`, …).
- `expectedRevision` (optional) causes a `STALE_REVISION` error if the manifest
  has advanced since the caller last read it.
- `timeoutMs` (optional) overrides the manifest timeout for this call.

### Read vs command tools

Read (query) tools are recorded as immutable snapshots; everything else is a
command. The wrapper classifies them as:

| Tool | Read tools snapshotted | Commands |
| --- | --- | --- |
| `fmeca` | `state.get`, `risk.next`, `readiness.assess`, `report.export`, `scoring.catalog`, `analyze`, `session.list`, `actions.suggest`, `policy.list`, `vet` | `session.open`, `append`, … |
| `cpm` | `plan.status`, `plan.get`, `plan.lint`, `plan.schedule`, `plan.simulate`, `plan.list`, `plan.compare`, `plan.ev`, `plan.review` | `plan.submit`, `plan.export`, `plan.snapshot`, `plan.baseline`, `plan.acquire_cohort`, `plan.heartbeat`, `plan.mark_status`, `plan.force_release` |
| `crossmatrix` | `crossmatrix.query` | `crossmatrix.command` |
| `scientific-process` | `state.get`, `experiment.next`, `report.export`, `adjudicate` | `experiment.open`, `experiment.append`, … |
| `elicitation` | `state.get`, `question.next`, `readiness.assess`, `spec.export` | `session.open`, `answer.record`, … |

`vet` and `plan.review` are advisory, paid, nondeterministic model calls that
never change plan or analysis state, so they are snapshotted as reads and do not
invalidate manager acceptance; `plan.schedule`, `plan.simulate`, and `plan.lint`
persist nothing, while `plan.export` writes files and stays a command.

### OpenRouter key for `cpm` `plan.review`

`plan.review` needs an OpenRouter key. When neither the process env nor the
hop's `tools.cpm.env` sets `OPENROUTER_API_KEY` or `CPM_OPENROUTER_KEY_FILE`, the
wrapper reads the key Pi manages in `$PI_CODING_AGENT_DIR/auth.json` (default
`~/.pi/agent/auth.json`) and injects it into the cpm child as
`OPENROUTER_API_KEY`. An explicit process or hop value always wins, and
`CPM_OPENROUTER_KEY_FILE` suppresses the derived key. The value is passed to the
child spawn only and is never written to the HOP, argv or evidence; `inspect`
reports only `cpmReview` (`available` or `unavailable`).

The success envelope is JSON:

```json
{
  "ok": true,
  "tool": "fmeca",
  "toolName": "state.get",
  "revision": 4,
  "kind": "read",
  "isError": false,
  "unsupported": false,
  "note": null,
  "snapshot": { "id": "snap_4_state_get_52e258a9ab23", "sha256": "…", "path": "snapshots/snap_4_state_get_52e258a9ab23.json", "…": "…" },
  "result": { "…": "upstream result…" }
}
```

An upstream `isError`, a JSON-RPC error, an unsupported/deferred `note` (even
when the upstream `ok` field is `true`), a spawn failure, or a timeout is always
surfaced — never swallowed.

## The HOP manifest

`schemaVersion` is `1`. Key fields:

| Field | Meaning |
| --- | --- |
| `projectId` | Stable `prj_<uuid>`; never changes after `init`. |
| `revision` | Monotonic; increments once per committed `call`. |
| `managerAcceptance` | `pending` until a manager explicitly accepts/rejects. |
| `acceptedRevision` | Revision that was accepted (`null` while pending). |
| `tools` | Per-tool `command`, `args`, `env`, `sourceVersion`, `sourceSha`. |
| `native` | Upstream-owned state path for each tool (see below). |
| `snapshots` | Immutable exported read results with `sha256` + relative path. |
| `evidence` | Append-only log of every call outcome. |
| `unresolved` | Unsupported operations and call errors awaiting review. |

State files are written **atomically** (temp file + rename). A `<hop.json>.lock`
file serialises concurrent callers; acquisition retries until `lockTimeoutMs`
and then fails with `LOCKED`. Malformed or schema-mismatched manifests fail with
`MALFORMED_MANIFEST`.

### Native state paths (anchored to the manifest folder)

| Tool | Native path (relative to `<hop.json>`) | Upstream env | Format |
| --- | --- | --- | --- |
| FMECA | `fmeca-state/` | `FMECA_STATE_DIR` | one JSONL event log per session: `fmeca-state/<session_id>.jsonl` |
| CPM | `cpm-planner.db` | `CPM_PLANNER_DB` | SQLite database in WAL mode (`-shm`/`-wal` siblings) |
| Crossmatrix (0.2.x) | `crossmatrix-model.json` | — | wrapper-owned validated model JSON (see below) |
| Crossmatrix (0.3.0+) | `<project>/.crossmatrix/` | `CROSSMATRIX_DIR` | server-owned project store (see below) |
| scientific-process | `scientific-process-state/` | `SCIENTIFIC_PROCESS_STATE_DIR` | upstream-owned state directory |
| elicitation | `elicitation-state/` | `ELICITATION_STATE_DIR` | upstream-owned state directory |

`<project>` is the Git top-level of the hop file's directory, or the hop file's
grandparent when the hop is not inside a Git repository.

FMECA and CPM native state is **owned by the upstream servers**. This wrapper
only points their env vars at paths anchored to the manifest folder and never
edits those stores directly (no SQLite surgery).

### Snapshots

Each successful read exports the actual upstream result to
`snapshots/snap_<revision>_<toolname>_<sha12>.json` and records an immutable
reference with the SHA-256 of the stored bytes. Writes use `flag: "wx"`; an
existing snapshot is hash-verified, never overwritten.

## Crossmatrix project store

Crossmatrix's persistence model changed at 0.3.0.

### 0.3.0+ servers (project store)

When the configured Crossmatrix server is version `0.3.0` or newer (checked as a
semver; an unparseable version is treated as legacy), `junior tools call`
points the server at the project's committed store with `CROSSMATRIX_DIR`:

- `<project>` is the Git top-level of the hop file's directory, or the hop
  file's grandparent when the hop is not inside a Git repository.
- The env var is only set when `<project>/.crossmatrix/` already exists. Without
  that directory no Crossmatrix env is passed and the server keeps its default.
- The server owns persistence: the wrapper does **not** replay the imported
  model before a query and does **not** copy a successful import to the hop
  native file. `native.crossmatrix` remains in the manifest for provenance.

### 0.2.x servers (legacy replay, older than 0.3.0)

Older servers hold their model **in memory**, so the wrapper remains the durable
owner:

- On a successful import (`crossmatrix.command` with a full `request.model`) it
  saves the complete validated model to `crossmatrix-model.json` next to the
  hop.
- On each later Crossmatrix call it **replays that import on the fresh server**
  (request id `replay-<modelId>-<sha12>`) before issuing the real call, so
  queries survive across separate CLI invocations.

### 0.3.0 requests

A read names the model and a `query.kind`:

```json
{"tool":"crossmatrix.query","arguments":{"request":{"modelId":"checkout","query":{"kind":"model.status"}}}}
```

A write names the model, an `expectedVersion`, an actor, and an `op`:

```json
{"tool":"crossmatrix.command","arguments":{"request":{"schemaVersion":"0.3.0","requestId":"obs-0007","modelId":"checkout","expectedVersion":6,"actor":{"actorType":"llm","persona":"observer"},"op":{"kind":"observe","relationId":"rel_need_char","from":"need_fast","to":"char_latency","observation":"strong","provenanceClass":"inferred","evidence":[{"sourceRef":{"sourceRef":"docs/perf.md","locator":"L10-L24"}}]}}}}
```

Before any command or query that names a `modelId`, the wrapper prepends a
`model.open` command in the same server process.

0.3.0 query kinds: `model.status`, `describe`, `slice`, `trace`, `explain`,
`coverage`, `gaps.orphans`, `gaps.next`, `stale`, `conflicts`,
`analyze.marginalize`, `analyze.contract`, `analyze.findings`, `validate`,
`report`, `export`.

0.3.0 command op kinds: `model.open`, `model.status`, `dimension.register`,
`scale.declare`, `relation.declare`, `contraction.declare`, `members.sync`,
`observe`, `member.propose`, `evidence.attach`, `deprecate`.

A query without `query.kind` (for example `{"op":"validate"}` or
`{"query":"validate"}`) or a command without `op` comes back upstream as `ok`
with a "not supported" note, which the wrapper reports as `unsupported: true`
with a `review-unresolved` entry. On 0.2.x servers mutation ops are deferred
upstream (ADR-0004) and return `ok: true` with a deferred note, which the wrapper
likewise converts into `unsupported: true` and a `review-unresolved` entry; that
deferred-note behaviour applies only to servers older than 0.3.0.

## Library API (for embedding in Junior)

```ts
import {
  initHop, loadHop, saveHop, validateManifest,
  callHop, inspectHop, recordManagerAcceptance,
  mcpCallSequence, mcpCallTool,
  HopError,
} from "./tools.ts";

const hop = initHop("hop.json", { projectId: "checkout" });
const outcome = await callHop("hop.json", "fmeca", {
  tool: "state.get",
  arguments: { session_id: "s1" },
});
const context = inspectHop("hop.json"); // hand to the Jev classifier
await recordManagerAcceptance("hop.json", true, "reviewed");
```

`callHop` performs exactly one MCP call — there is no duplicated worker
orchestration. `mcpCallSequence`/`mcpCallTool` expose the bounded stdio JSON-RPC
client directly (newline-delimited JSON, request-id correlation, 8 MB output cap,
wall-clock timeout, whole-process-group kill).

## Building the MCP servers

`junior init` normally installs checksum-verified release binaries, so building
from source is only needed for development. The manifest records
`sourceVersion` + `sourceSha` for provenance; build each binary from its upstream
checkout at the recorded SHA. These are ordinary `cargo build` steps; no
installs, credentials, paid calls, or network APIs are used by this project.

```bash
# FMECA -> target/release/fmeca-mcp   (package version 0.2.0, tag v0.2.0)
git clone https://github.com/praxec/fmeca && cd fmeca
git checkout 83d16022ff03fa6725c5ed517ea75caa5bce8694
cargo build --release -p fmeca-mcp

# CPM Planner -> target/release/cpm-planner   (package version 0.2.2, tag v0.2.2)
git clone https://github.com/praxec/cpm-planner && cd cpm-planner
git checkout 1fdd3afbce3302d5aad19895bddc26eb54fd7aea
cargo build --release

# Crossmatrix -> target/release/crossmatrix-mcp   (package version 0.3.0, tag v0.3.0)
# (from the crossmatrix checkout)
git checkout ef0fda63f362ceeaa91f15b032ddbd721f5d29ef
cargo build --release -p crossmatrix-mcp
```

## Tests

```bash
node --test tools.test.ts
```

The suite is offline and atomic (one behavioral assertion per test). It drives
the public CLI round-trip/restart against a fake MCP child and covers: manifest
schema, stable project id, monotonic revision, pending acceptance, snapshot
hashing, missing binary, malformed manifest, timeout, stale revision, upstream
`isError`, unsupported operation, held lock, crossmatrix cross-process
persistence, and `inspect`. Tests assert behavior, never source text.
