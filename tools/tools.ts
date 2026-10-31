/**
 * junior-tools — dependency-free TypeScript CLI + library that wraps the
 * FMECA, CPM Planner and Crossmatrix MCP servers behind a persistent,
 * versioned JSON "HOP" (Hand-Off Package) state file.
 *
 * ── Jev recommends, the executor executes ───────────────────────────────────
 * This module is deliberately split into two audiences:
 *   • `inspectHop()` returns a compact, machine-consumable snapshot context for
 *     a frontier manager or the Jev classifier. Jev READS it and RECOMMENDS the
 *     next tool call (see `recommendedNext`).
 *   • `callHop()` is the executor path. It runs exactly the one MCP call it is
 *     handed, records evidence, and persists the result. It never invents a
 *     recommendation and never marks a worker's own completion as manager
 *     acceptance.
 *
 * ── State ownership ─────────────────────────────────────────────────────────
 * FMECA and CPM native state stays owned by the upstream MCP servers: this
 * wrapper only points `FMECA_STATE_DIR` / `CPM_PLANNER_DB` at paths anchored to
 * the manifest folder and never edits those stores directly (no SQLite surgery).
 * cpm-planner 0.4.3 otherwise falls back to its user-level default database, so
 * generated Hops emit `CPM_PLANNER_DB` and every cpm call verifies the database
 * path the server reports opening before accepting the result.
 * Crossmatrix's MCP is in-memory up to 0.2.x, so this wrapper is the durable
 * owner of the imported model JSON: it saves the validated model and replays it
 * on every fresh server before a query. Crossmatrix 0.3+ keeps the model in a
 * committed `<project>/.crossmatrix` store instead, which the wrapper points at
 * with `CROSSMATRIX_DIR`; it neither replays nor copies the model in that mode.
 *
 * ── No shell interpolation ──────────────────────────────────────────────────
 * MCP children are spawned with `spawn(command, args)` (never a shell), get a
 * bounded wall-clock budget, a bounded stdout budget, and are killed as a whole
 * process group on completion or timeout.
 *
 * This file is the public facade. The implementation lives in cohesive
 * modules split along the seams in ADR 0016; every previously exported symbol
 * is re-exported here so no importer changes.
 *
 * Only Node builtins are used. No npm dependencies.
 */

import { isDirectEntry } from "../cli-entry.ts";
import { main } from "./tools-cli.ts";

export {
  HOP_SCHEMA_VERSION,
  TOOL_NAMES,
  HopError,
  probeToolVersion,
  isReadTool,
  validateManifest,
  loadHop,
  saveHop,
  defaultManagedStatePath,
  initHop,
} from "./tools-manifest.ts";
export type {
  ToolName,
  Acceptance,
  CallKind,
  ToolConfig,
  NativeStateRef,
  SnapshotRef,
  EvidenceEntry,
  UnresolvedEntry,
  HopManifest,
  HopErrorCode,
  InitOptions,
} from "./tools-manifest.ts";

export { mcpCallSequence, mcpCallTool } from "./tools-mcp.ts";
export type { McpCallSpec, McpSequenceOptions, McpSequenceResult } from "./tools-mcp.ts";

export { buildToolEnv, companionKeyEnv, cpmModelEnv, cpmReviewStatus, crossmatrixUsesStore } from "./tools-env.ts";
export type { CallRequest, CallOutcome } from "./tools-env.ts";

export { callHop, inspectHop, openHopSession, recordManagerAcceptance } from "./tools-call.ts";
export type { HopSession, InspectSnapshot, InspectReport } from "./tools-call.ts";

export { main } from "./tools-cli.ts";

if (isDirectEntry(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
