# junior-tools

A dependency-free TypeScript CLI + library that wraps three MCP servers —
**FMECA**, **CPM Planner**, and **Crossmatrix** — behind a persistent, versioned
JSON hand-off file (a **HOP**). It is built for a two-role workflow:

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
- The three upstream Rust MCP binaries on `PATH` or referenced by absolute path
  in the HOP config (see [Building the MCP servers](#building-the-mcp-servers)).

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
| `node tools.ts call <hop.json> <fmeca\|cpm\|crossmatrix> <request.json>` | Execute one MCP call, advance the revision, persist evidence + snapshots. |
| `node tools.ts inspect <hop.json>` | Emit a compact snapshot context for a manager or the Jev classifier. |

## Config file (input to `init`)

`config.json` is optional. Omitted fields fall back to the built-in defaults and
the pinned source metadata.

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
      "sourceVersion": "0.0.1",
      "sourceSha": "8f7fbfd7718707be35e443fa0a4a37370ee3e8a4"
    },
    "cpm": {
      "command": "/opt/praxec/bin/cpm-planner",
      "args": [],
      "env": {},
      "sourceVersion": "0.0.2",
      "sourceSha": "12c8f9acc0fbd7c13b13fc3c3b50134afcffce89"
    },
    "crossmatrix": {
      "command": "/opt/praxec/bin/crossmatrix-mcp",
      "args": [],
      "env": {},
      "sourceVersion": "0.2.0",
      "sourceSha": "aef46ffb8cf10801c237c49f79bd0829543c7c2d"
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
| `fmeca` | `state.get`, `risk.next`, `readiness.assess`, `report.export`, `scoring.catalog`, `analyze` | `session.open`, `append`, … |
| `cpm` | `plan.status` | `plan.submit`, `plan.acquire_cohort`, `plan.heartbeat`, `plan.mark_status`, `plan.force_release` |
| `crossmatrix` | `crossmatrix.query` | `crossmatrix.command` |

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
| Crossmatrix | `crossmatrix-model.json` | — | wrapper-owned validated model JSON (see limitation) |

FMECA and CPM native state is **owned by the upstream servers**. This wrapper
only points their env vars at paths anchored to the manifest folder and never
edits those stores directly (no SQLite surgery).

### Snapshots

Each successful read exports the actual upstream result to
`snapshots/snap_<revision>_<toolname>_<sha12>.json` and records an immutable
reference with the SHA-256 of the stored bytes. Writes use `flag: "wx"`; an
existing snapshot is hash-verified, never overwritten.

## Crossmatrix limitation

The current Crossmatrix MCP server holds its model **in memory** and its
mutation ops are deferred (ADR-0004). Consequently:

- Only **import** (`crossmatrix.command` with a full `request.model`) and the
  **implemented queries** (`validate`, `describe`, `slice`, `trace`, `explain`,
  `coverage`, `stale`, `conflicts`, `gaps.*`, `analyze.*`, `export.*`) work.
  Unsupported mutation ops return `ok: true` with a deferred `note`; the wrapper
  converts that into `unsupported: true` and a `review-unresolved` entry rather
  than pretending the mutation happened.
- To make queries survive across separate CLI invocations, the wrapper saves the
  complete validated model to `crossmatrix-model.json` on a successful import
  and **replays that import on each fresh server** before issuing a query
  (replay request id `replay-<modelId>-<sha12>`).

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

The manifest records `sourceVersion` + `sourceSha` for provenance. Build each
binary from its upstream checkout at the pinned SHA. These are ordinary
`cargo build` steps; no installs, credentials, paid calls, or network APIs are
used by this project.

```bash
# FMECA -> target/release/fmeca-mcp   (package version 0.0.1)
git clone https://github.com/praxec/fmeca && cd fmeca
git checkout 8f7fbfd7718707be35e443fa0a4a37370ee3e8a4
cargo build --release -p fmeca-mcp

# CPM Planner -> target/release/cpm-planner   (package version 0.0.2)
git clone https://github.com/praxec/cpm-planner && cd cpm-planner
git checkout 12c8f9acc0fbd7c13b13fc3c3b50134afcffce89
cargo build --release

# Crossmatrix -> target/release/crossmatrix-mcp   (package version 0.2.0)
# (from the crossmatrix checkout)
git checkout aef46ffb8cf10801c237c49f79bd0829543c7c2d
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
