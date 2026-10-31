/**
 * HOP call, inspect and manager-acceptance operations for junior-tools.
 * Split from tools/tools.ts per ADR 0016; the facade re-exports the public API.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  HopError,
  NATIVE_RELATIVE,
  TOOL_NAMES,
  isReadTool,
  isRecord,
  loadHop,
  nowIso,
  saveHop,
  sha256Hex,
  toHopError,
  withManifestLock,
  writeFileAtomic,
} from "./tools-manifest.ts";
import type {
  Acceptance,
  CallKind,
  HopManifest,
  SnapshotRef,
  ToolConfig,
  ToolName,
  UnresolvedEntry,
} from "./tools-manifest.ts";
import { mcpCallSequence, openMcpSession } from "./tools-mcp.ts";
import type { McpCallSpec, McpSequenceResult } from "./tools-mcp.ts";
import {
  assertCpmProjectDatabase,
  buildToolEnv,
  companionKeyEnv,
  cpmModelEnv,
  cpmReviewEnv,
  cpmReviewStatus,
  crossmatrixUsesStore,
  nativeAbsPath,
} from "./tools-env.ts";
import type { CallOutcome, CallRequest } from "./tools-env.ts";

function findNote(value: unknown): string | null {
  if (isRecord(value) && typeof value.note === "string" && value.note.length > 0) {
    return value.note;
  }
  return null;
}

/** A deferred/unsupported diagnostic is surfaced even when upstream ok is true. */
function isUnsupportedNote(note: string): boolean {
  return /not supported|unsupported|deferred/i.test(note);
}

function extractCrossmatrixModel(args: unknown): { model: unknown; modelId: string | null } | null {
  if (!isRecord(args)) return null;
  const request = args.request;
  if (!isRecord(request) || request.model === undefined) return null;
  return {
    model: request.model,
    modelId: typeof request.modelId === "string" ? request.modelId : null,
  };
}

/** Save a validated crossmatrix import to its native path (wrapper-owned). */
function persistCrossmatrixImport(hopPath: string, hop: HopManifest, args: unknown): void {
  const extracted = extractCrossmatrixModel(args);
  if (!extracted) return;
  const modelPath = nativeAbsPath(hopPath, "crossmatrix", hop);
  const serialized = JSON.stringify(extracted.model);
  writeFileAtomic(modelPath, serialized + "\n");
  hop.native.crossmatrix = {
    statePath: hop.native.crossmatrix.statePath,
    modelId: extracted.modelId,
    modelSha256: sha256Hex(serialized),
  };
}

/** Immutably export a real read result and return its reference. */
function writeSnapshot(
  hopPath: string,
  tool: ToolName,
  toolName: string,
  revision: number,
  value: unknown,
): SnapshotRef {
  const serialized = JSON.stringify(value, null, 2) + "\n";
  const digest = sha256Hex(serialized);
  const id = `snap_${revision}_${toolName.replace(/[^a-z0-9]+/gi, "_")}_${digest.slice(0, 12)}`;
  const rel = path.join("snapshots", `${id}.json`);
  const abs = path.resolve(path.dirname(hopPath), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  try {
    fs.writeFileSync(abs, serialized, { flag: "wx" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      throw new HopError("IO_ERROR", `cannot write snapshot ${abs}`, err);
    }
    const existing = fs.readFileSync(abs, "utf8");
    if (sha256Hex(existing) !== digest) {
      throw new HopError("IO_ERROR", `immutable snapshot collision at ${abs}`);
    }
  }
  return { id, tool, toolName, kind: "read", revision, path: rel, sha256: digest, createdAt: nowIso() };
}

/**
 * The `model.open` call a Crossmatrix 0.3+ store-backed server needs in the
 * same process before a command/query that names a model. Returns null when the
 * call must not be preceded by an open: a non-command/query tool, a request
 * without a non-empty modelId, or a `model.open` command itself.
 */
function storeOpenCall(toolName: string, args: unknown): McpCallSpec | null {
  if (toolName !== "crossmatrix.command" && toolName !== "crossmatrix.query") return null;
  if (!isRecord(args)) return null;
  const request = args.request;
  if (!isRecord(request)) return null;
  const modelId = request.modelId;
  if (typeof modelId !== "string" || modelId.length === 0) return null;
  if (isRecord(request.op) && request.op.kind === "model.open") return null;
  return {
    name: "crossmatrix.command",
    arguments: {
      request: {
        schemaVersion: "0.3.0",
        requestId: `jr-open-${modelId}`,
        modelId,
        actor: { actorType: "system", persona: "model_admin" },
        op: { kind: "model.open" },
      },
    },
  };
}

/**
 * The `session.open` prelude a scientific-process server needs in the same
 * process before any method other than `session.open` itself. The server keeps
 * the open session in process memory and the wrapper spawns a fresh server per
 * call, so without the prelude every method fails with
 * "no session open; call session.open first".
 *
 * The session id is the request's top-level `session_id`; when omitted it
 * defaults to "default". The wrapper-level `session_id` is stripped from the
 * forwarded method: the 0.2.0 server scopes methods to the already-open session
 * and rejects unknown fields. Returns null when the request itself is
 * `session.open`, which is forwarded untouched and unaccompanied.
 */
function scientificProcessPrelude(toolName: string, args: unknown): McpCallSpec[] | null {
  if (toolName === "session.open") return null;
  const request = isRecord(args) ? { ...args } : {};
  const raw = request.session_id;
  const sessionId = typeof raw === "string" && raw.length > 0 ? raw : "default";
  delete request.session_id;
  return [
    { name: "session.open", arguments: { session_id: sessionId } },
    { name: toolName, arguments: request },
  ];
}

/**
 * Build the ordered tools/call sequence for a request.
 *
 * Crossmatrix is in-memory upstream, so when a validated model has been stored
 * and the incoming call is not itself an import, we replay the import on the
 * fresh server before issuing the real call. Crossmatrix 0.3+ opens the
 * store-backed model per process, and scientific-process opens its session per
 * process; both preludes run in the same server process as the real call.
 */
function prepareCalls(
  hopPath: string,
  hop: HopManifest,
  tool: ToolName,
  toolName: string,
  args: unknown,
  prependModelOpen = true,
): McpCallSpec[] {
  if (tool === "scientific-process") {
    return scientificProcessPrelude(toolName, args) ?? [{ name: toolName, arguments: args ?? {} }];
  }
  const actual: McpCallSpec = { name: toolName, arguments: args ?? {} };
  if (tool !== "crossmatrix") return [actual];
  if (crossmatrixUsesStore(hop)) {
    if (!prependModelOpen) return [actual];
    const open = storeOpenCall(toolName, args);
    return open ? [open, actual] : [actual];
  }
  const isImport = toolName === "crossmatrix.command" && extractCrossmatrixModel(args) !== null;
  const native = hop.native.crossmatrix;
  const modelPath = nativeAbsPath(hopPath, "crossmatrix", hop);
  if (isImport || !native.modelSha256 || !fs.existsSync(modelPath)) return [actual];

  let model: unknown;
  try {
    model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
  } catch (err) {
    throw new HopError("IO_ERROR", `cannot reload stored crossmatrix model ${modelPath}`, err);
  }
  const replay: McpCallSpec = {
    name: "crossmatrix.command",
    arguments: {
      request: {
        requestId: `replay-${native.modelId ?? "model"}-${native.modelSha256.slice(0, 12)}`,
        modelId: native.modelId ?? undefined,
        model,
      },
    },
  };
  return [replay, actual];
}

/**
 * Run one tool call's per-call bookkeeping — manifest lock, revision bump,
 * snapshots, evidence, unresolved entries and error mapping — around a supplied
 * MCP executor. `callHop` supplies a fresh-server executor; `openHopSession`
 * supplies one that reuses a single long-lived server.
 */
async function processCall(
  hopPath: string,
  tool: ToolName,
  request: CallRequest,
  run: (ctx: {
    hop: HopManifest;
    cfg: ToolConfig;
    env: Record<string, string>;
    timeoutMs: number;
    toolName: string;
  }) => Promise<McpSequenceResult>,
): Promise<CallOutcome> {
  const toolName = typeof request.tool === "string" ? request.tool : "";
  if (!toolName) throw new HopError("BAD_REQUEST", "request.tool is required");

  const preloaded = loadHop(hopPath);
  return withManifestLock(hopPath, preloaded.lockTimeoutMs, async () => {
    // Re-read under the lock so concurrent executors serialize cleanly.
    const hop = loadHop(hopPath);
    if (request.expectedRevision !== undefined && request.expectedRevision !== hop.revision) {
      throw new HopError(
        "STALE_REVISION",
        `expected revision ${request.expectedRevision} but manifest is at ${hop.revision}`,
      );
    }

    const kind: CallKind = isReadTool(tool, toolName) ? "read" : "command";
    const revision = hop.revision + 1;
    const cfg = hop.tools[tool];
    if (!cfg) {
      throw new HopError(
        "MALFORMED_MANIFEST",
        `hop manifest has no configuration for '${tool}'; run \`junior init --install\` to refresh it`,
      );
    }
    const timeoutMs = request.timeoutMs ?? hop.timeoutMs;
    const env = { ...companionKeyEnv(cfg.env), ...(cfg.env ?? {}), ...buildToolEnv(hopPath, tool, hop) };
    if (tool === "cpm") Object.assign(env, cpmReviewEnv(cfg.env), cpmModelEnv(hopPath, cfg.env));

    let outcome: CallOutcome;
    try {
      const mcp = await run({ hop, cfg, env, timeoutMs, toolName });
      if (tool === "cpm" && env.CPM_PLANNER_DB) {
        assertCpmProjectDatabase(mcp.stderr, env.CPM_PLANNER_DB);
      }
      const note = findNote(mcp.value);
      const unsupported = note !== null && isUnsupportedNote(note);
      const ok = !mcp.isError && !unsupported;

      let snapshot: SnapshotRef | null = null;
      if (kind === "read" && ok) {
        snapshot = writeSnapshot(hopPath, tool, toolName, revision, mcp.value);
        hop.snapshots.push(snapshot);
      }
      if (tool === "crossmatrix" && toolName === "crossmatrix.command" && ok && !crossmatrixUsesStore(hop)) {
        persistCrossmatrixImport(hopPath, hop, request.arguments);
      }

      hop.evidence.push({
        id: `ev_${revision}_${randomUUID().slice(0, 8)}`,
        revision,
        tool,
        toolName,
        kind,
        status: ok ? "ok" : unsupported ? "unsupported" : "error",
        snapshotId: snapshot?.id,
        note: note ?? undefined,
        createdAt: nowIso(),
      });
      if (unsupported) {
        hop.unresolved.push({
          id: `un_${revision}_${randomUUID().slice(0, 8)}`,
          revision,
          tool,
          toolName,
          reason: "unsupported-operation",
          detail: note ?? undefined,
          createdAt: nowIso(),
        });
      }

      outcome = {
        ok,
        tool,
        toolName,
        revision,
        kind,
        isError: mcp.isError,
        unsupported,
        note,
        snapshot,
        result: mcp.value,
      };
    } catch (err) {
      const hopErr = toHopError(err);
      hop.evidence.push({
        id: `ev_${revision}_${randomUUID().slice(0, 8)}`,
        revision,
        tool,
        toolName,
        kind,
        status: "error",
        note: hopErr.message,
        createdAt: nowIso(),
      });
      hop.unresolved.push({
        id: `un_${revision}_${randomUUID().slice(0, 8)}`,
        revision,
        tool,
        toolName,
        reason: hopErr.code,
        detail: hopErr.message,
        createdAt: nowIso(),
      });
      outcome = {
        ok: false,
        tool,
        toolName,
        revision,
        kind,
        isError: hopErr.code === "UPSTREAM_ERROR",
        unsupported: false,
        note: null,
        error: { code: hopErr.code, message: hopErr.message, detail: hopErr.detail },
      };
    }

    hop.managerAcceptance = 'pending';
    hop.acceptedRevision = null;
    hop.managerNote = null;
    hop.revision = revision;
    saveHop(hopPath, hop);
    return outcome;
  });
}

/**
 * Execute exactly one MCP tool call for a manifest, persist the outcome, and
 * return a structured envelope. Read results are exported as immutable
 * snapshots; unsupported/deferred notes become unresolved entries. This never
 * touches `managerAcceptance`.
 */
export function callHop(
  hopPath: string,
  tool: ToolName,
  request: CallRequest,
): Promise<CallOutcome> {
  if (!TOOL_NAMES.includes(tool)) {
    throw new HopError("UNKNOWN_TOOL", `unknown tool '${String(tool)}'`);
  }
  return processCall(hopPath, tool, request, ({ hop, cfg, env, timeoutMs, toolName }) => {
    const calls = prepareCalls(
      hopPath,
      hop,
      tool,
      toolName,
      request.arguments,
      request.prependModelOpen !== false,
    );
    return mcpCallSequence({ command: cfg.command, args: cfg.args, env, timeoutMs }, calls);
  });
}

// ---------------------------------------------------------------------------
// per-command session
// ---------------------------------------------------------------------------

/** One long-lived tool server plus the per-command open/prelude state. */
export interface HopSession {
  call(hopPath: string, tool: ToolName, request: CallRequest): Promise<CallOutcome>;
  close(): Promise<void>;
}

interface CrossmatrixSessionState {
  openedModels: Set<string>;
  replayedImport: boolean;
}

/** The model id a crossmatrix command/query names, or null when it names none. */
function referencedModelId(toolName: string, args: unknown): string | null {
  if (toolName !== "crossmatrix.command" && toolName !== "crossmatrix.query") return null;
  if (!isRecord(args)) return null;
  const request = args.request;
  if (!isRecord(request)) return null;
  const modelId = request.modelId;
  return typeof modelId === "string" && modelId.length > 0 ? modelId : null;
}

/** True when the call is itself a store-backed `model.open` command. */
function isModelOpenCommand(toolName: string, args: unknown): boolean {
  if (toolName !== "crossmatrix.command") return false;
  if (!isRecord(args)) return false;
  const request = args.request;
  return isRecord(request) && isRecord(request.op) && request.op.kind === "model.open";
}

/**
 * The tools/call sequence for one Crossmatrix request inside a session. Store
 * mode opens each model once per session; legacy in-memory mode replays the
 * stored import once instead of on every call.
 */
function crossmatrixSessionCalls(
  hopPath: string,
  hop: HopManifest,
  toolName: string,
  args: unknown,
  prependModelOpen: boolean,
  actual: McpCallSpec,
  state: CrossmatrixSessionState,
): McpCallSpec[] {
  if (!crossmatrixUsesStore(hop)) {
    const isImport = toolName === "crossmatrix.command" && extractCrossmatrixModel(args) !== null;
    if (isImport) {
      // The import itself puts the model in the persistent server's memory.
      state.replayedImport = true;
      return [actual];
    }
    const native = hop.native.crossmatrix;
    const modelPath = nativeAbsPath(hopPath, "crossmatrix", hop);
    if (!state.replayedImport && native.modelSha256 && fs.existsSync(modelPath)) {
      state.replayedImport = true;
      let model: unknown;
      try {
        model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
      } catch (err) {
        throw new HopError("IO_ERROR", `cannot reload stored crossmatrix model ${modelPath}`, err);
      }
      const replay: McpCallSpec = {
        name: "crossmatrix.command",
        arguments: {
          request: {
            requestId: `replay-${native.modelId ?? "model"}-${native.modelSha256.slice(0, 12)}`,
            modelId: native.modelId ?? undefined,
            model,
          },
        },
      };
      return [replay, actual];
    }
    return [actual];
  }

  if (prependModelOpen) {
    const open = storeOpenCall(toolName, args);
    const modelId = referencedModelId(toolName, args);
    if (open !== null && modelId !== null && !state.openedModels.has(modelId)) {
      state.openedModels.add(modelId);
      return [open, actual];
    }
  }
  // A model.open command itself opens the model; record it so later calls
  // skip the prelude.
  const modelId = referencedModelId(toolName, args);
  if (modelId !== null && isModelOpenCommand(toolName, args)) {
    state.openedModels.add(modelId);
  }
  return [actual];
}

/**
 * Open one Crossmatrix server process for a whole `junior matrix` command and
 * reuse it for every call in that command instead of respawning per call. The
 * manifest lock, revision bump, snapshot and error mapping stay identical to
 * `callHop` (which `call` delegates to for tools other than the sessioned one).
 */
export async function openHopSession(
  hopPath: string,
  tool: ToolName,
): Promise<HopSession> {
  if (!TOOL_NAMES.includes(tool)) {
    throw new HopError("UNKNOWN_TOOL", `unknown tool '${String(tool)}'`);
  }
  const hop = loadHop(hopPath);
  const cfg = hop.tools[tool];
  if (!cfg) {
    throw new HopError(
      "MALFORMED_MANIFEST",
      `hop manifest has no configuration for '${tool}'; run \`junior init --install\` to refresh it`,
    );
  }
  const env = { ...companionKeyEnv(cfg.env), ...(cfg.env ?? {}), ...buildToolEnv(hopPath, tool, hop) };
  if (tool === "cpm") Object.assign(env, cpmReviewEnv(cfg.env), cpmModelEnv(hopPath, cfg.env));
  const mcp = await openMcpSession({ command: cfg.command, args: cfg.args, env, timeoutMs: hop.timeoutMs });

  const state: CrossmatrixSessionState = { openedModels: new Set<string>(), replayedImport: false };

  return {
    call(h, t, request) {
      if (t !== tool) return callHop(h, t, request);
      return processCall(hopPath, tool, request, ({ hop: manifest, toolName, timeoutMs }) => {
        const actual: McpCallSpec = { name: toolName, arguments: request.arguments ?? {} };
        const calls = crossmatrixSessionCalls(
          hopPath,
          manifest,
          toolName,
          request.arguments,
          request.prependModelOpen !== false,
          actual,
          state,
        );
        return mcp.call(calls, timeoutMs);
      });
    },
    close() {
      return mcp.close();
    },
  };
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

export interface InspectSnapshot {
  id: string;
  tool: ToolName;
  toolName: string;
  revision: number;
  sha256: string;
  path: string;
  createdAt: string;
}

export interface InspectReport {
  schemaVersion: number;
  projectId: string;
  revision: number;
  managerAcceptance: Acceptance;
  acceptedRevision: number | null;
  toolSourceVersions: Record<ToolName, string>;
  toolSourceShas: Record<ToolName, string>;
  nativeStatePaths: Record<ToolName, string>;
  snapshotCount: number;
  snapshots: InspectSnapshot[];
  latestSnapshot: InspectSnapshot | null;
  evidenceCount: number;
  unresolved: UnresolvedEntry[];
  recommendedNext: string;
  note: string;
  /** Whether the cpm tool would see an OpenRouter review key, never its value. */
  cpmReview: "available" | "unavailable";
}

/**
 * Compact context for a frontier manager or the Jev classifier. Jev reads this
 * and recommends the next `call`; the executor then performs exactly that call.
 */
export function inspectHop(hopPath: string): InspectReport {
  const hop = loadHop(hopPath);
  const toolSourceVersions = {} as Record<ToolName, string>;
  const toolSourceShas = {} as Record<ToolName, string>;
  const nativeStatePaths = {} as Record<ToolName, string>;
  for (const tool of TOOL_NAMES) {
    toolSourceVersions[tool] = hop.tools[tool]?.sourceVersion ?? "";
    toolSourceShas[tool] = hop.tools[tool]?.sourceSha ?? "";
    nativeStatePaths[tool] = hop.native[tool]?.statePath ?? NATIVE_RELATIVE[tool];
  }
  const snapshots: InspectSnapshot[] = hop.snapshots.map((s) => ({
    id: s.id,
    tool: s.tool,
    toolName: s.toolName,
    revision: s.revision,
    sha256: s.sha256,
    path: s.path,
    createdAt: s.createdAt,
  }));
  const recommendedNext =
    hop.unresolved.length > 0
      ? "review-unresolved"
      : snapshots.length === 0
        ? "run-a-read"
        : "request-manager-acceptance";

  return {
    schemaVersion: hop.schemaVersion,
    projectId: hop.projectId,
    revision: hop.revision,
    managerAcceptance: hop.managerAcceptance,
    acceptedRevision: hop.acceptedRevision,
    toolSourceVersions,
    toolSourceShas,
    nativeStatePaths,
    snapshotCount: snapshots.length,
    snapshots,
    latestSnapshot: snapshots.length > 0 ? snapshots[snapshots.length - 1] : null,
    evidenceCount: hop.evidence.length,
    unresolved: hop.unresolved,
    recommendedNext,
    cpmReview: cpmReviewStatus(hop.tools.cpm?.env),
    note: "Jev recommends the next MCP call from this context; the executor executes it. Worker completion is never manager acceptance — acceptance only changes via recordManagerAcceptance().",
  };
}

/**
 * Explicit manager action. This is the ONLY way `managerAcceptance` changes;
 * a worker tool call can never promote itself to accepted.
 */
export async function recordManagerAcceptance(
  hopPath: string,
  accepted: boolean,
  note?: string,
): Promise<HopManifest> {
  const preloaded = loadHop(hopPath);
  return withManifestLock(hopPath, preloaded.lockTimeoutMs, async () => {
    const hop = loadHop(hopPath);
    hop.managerAcceptance = accepted ? "accepted" : "rejected";
    hop.acceptedRevision = accepted ? hop.revision : null;
    hop.managerNote = note ?? null;
    saveHop(hopPath, hop);
    return hop;
  });
}
