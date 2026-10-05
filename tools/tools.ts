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
 * Crossmatrix's current MCP is in-memory, so this wrapper is the durable owner
 * of the imported model JSON: it saves the validated model and replays it on
 * every fresh server before a query.
 *
 * ── No shell interpolation ──────────────────────────────────────────────────
 * MCP children are spawned with `spawn(command, args)` (never a shell), get a
 * bounded wall-clock budget, a bounded stdout budget, and are killed as a whole
 * process group on completion or timeout.
 *
 * Only Node builtins are used. No npm dependencies.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Public constants and types
// ---------------------------------------------------------------------------

export const HOP_SCHEMA_VERSION = 1;
export const TOOL_NAMES = ["fmeca", "cpm", "crossmatrix"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export type Acceptance = "pending" | "accepted" | "rejected";
export type CallKind = "read" | "command";

/** Launch + provenance config for one wrapped MCP server. */
export interface ToolConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  sourceVersion: string;
  sourceSha: string;
}

/** Where a tool's native (upstream-owned) state lives, relative to the HOP. */
export interface NativeStateRef {
  statePath: string;
  modelId?: string | null;
  modelSha256?: string | null;
}

/** Immutable exported reference to a real read-tool result. */
export interface SnapshotRef {
  id: string;
  tool: ToolName;
  toolName: string;
  kind: CallKind;
  revision: number;
  path: string;
  sha256: string;
  createdAt: string;
}

export interface EvidenceEntry {
  id: string;
  revision: number;
  tool: ToolName;
  toolName: string;
  kind: CallKind;
  status: "ok" | "error" | "unsupported";
  snapshotId?: string;
  note?: string;
  createdAt: string;
}

export interface UnresolvedEntry {
  id: string;
  revision: number;
  tool: ToolName;
  toolName: string;
  reason: string;
  detail?: string;
  createdAt: string;
}

/**
 * HOP (Hand-Off Package) manifest — schemaVersion 1.
 *
 * `managerAcceptance` starts at "pending" and is only ever changed by an
 * explicit manager action (`recordManagerAcceptance`). Worker tool calls must
 * never promote themselves to "accepted".
 */
export interface HopManifest {
  schemaVersion: number;
  projectId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  managerAcceptance: Acceptance;
  acceptedRevision: number | null;
  managerNote: string | null;
  timeoutMs: number;
  lockTimeoutMs: number;
  tools: Record<ToolName, ToolConfig>;
  native: Record<ToolName, NativeStateRef>;
  snapshots: SnapshotRef[];
  evidence: EvidenceEntry[];
  unresolved: UnresolvedEntry[];
}

export type HopErrorCode =
  | "MALFORMED_MANIFEST"
  | "HOP_EXISTS"
  | "HOP_NOT_FOUND"
  | "STALE_REVISION"
  | "LOCKED"
  | "UNKNOWN_TOOL"
  | "BAD_REQUEST"
  | "SPAWN_ERROR"
  | "TIMEOUT"
  | "OUTPUT_LIMIT"
  | "RPC_ERROR"
  | "UPSTREAM_ERROR"
  | "IO_ERROR"
  | "USAGE";

export class HopError extends Error {
  code: HopErrorCode;
  detail: unknown;

  constructor(code: HopErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "HopError";
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Defaults (source SHAs are the pinned upstream revisions)
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MCP_PROTOCOL_VERSION = "2024-11-05";

// Versions read from each repository's Cargo.toml at the pinned SHA (see README).
const KNOWN_SOURCE: Record<ToolName, { version: string; sha: string }> = {
  fmeca: { version: "0.0.1", sha: "8f7fbfd7718707be35e443fa0a4a37370ee3e8a4" },
  cpm: { version: "0.0.2", sha: "12c8f9acc0fbd7c13b13fc3c3b50134afcffce89" },
  crossmatrix: { version: "0.2.0", sha: "aef46ffb8cf10801c237c49f79bd0829543c7c2d" },
};

const DEFAULT_COMMAND: Record<ToolName, string> = {
  fmeca: "fmeca-mcp",
  cpm: "cpm-planner",
  crossmatrix: "crossmatrix-mcp",
};

const NATIVE_RELATIVE: Record<ToolName, string> = {
  fmeca: "fmeca-state",
  cpm: "cpm-planner.db",
  crossmatrix: "crossmatrix-model.json",
};

/** Read (query) tools whose successful results are exported as snapshots. */
const READ_TOOLS: Record<ToolName, ReadonlySet<string>> = {
  fmeca: new Set([
    "state.get",
    "risk.next",
    "readiness.assess",
    "report.export",
    "scoring.catalog",
    "analyze",
  ]),
  cpm: new Set(["plan.status"]),
  crossmatrix: new Set(["crossmatrix.query"]),
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Atomic file write: temp file in the same dir, then rename over the target. */
function writeFileAtomic(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function readJsonFile(filePath: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new HopError("HOP_NOT_FOUND", `cannot read ${filePath}`, err);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new HopError("MALFORMED_MANIFEST", `invalid JSON in ${filePath}`, err);
  }
}

function toHopError(err: unknown): HopError {
  if (err instanceof HopError) return err;
  return new HopError("UPSTREAM_ERROR", err instanceof Error ? err.message : String(err), err);
}

// ---------------------------------------------------------------------------
// HOP validation / persistence
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a parsed manifest, rejecting malformed/stale-shaped state. */
export function validateManifest(value: unknown, filePath: string): HopManifest {
  if (!isRecord(value)) {
    throw new HopError("MALFORMED_MANIFEST", `${filePath}: manifest must be a JSON object`);
  }
  if (value.schemaVersion !== HOP_SCHEMA_VERSION) {
    throw new HopError(
      "MALFORMED_MANIFEST",
      `${filePath}: unsupported schemaVersion ${String(value.schemaVersion)} (expected ${HOP_SCHEMA_VERSION})`,
    );
  }
  if (typeof value.projectId !== "string" || value.projectId.length === 0) {
    throw new HopError("MALFORMED_MANIFEST", `${filePath}: missing stable projectId`);
  }
  if (typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 0) {
    throw new HopError("MALFORMED_MANIFEST", `${filePath}: revision must be a non-negative integer`);
  }
  if (
    value.managerAcceptance !== "pending" &&
    value.managerAcceptance !== "accepted" &&
    value.managerAcceptance !== "rejected"
  ) {
    throw new HopError("MALFORMED_MANIFEST", `${filePath}: invalid managerAcceptance`);
  }
  if (!isRecord(value.tools)) {
    throw new HopError("MALFORMED_MANIFEST", `${filePath}: missing tools config`);
  }
  for (const tool of TOOL_NAMES) {
    const entry = value.tools[tool];
    if (!isRecord(entry) || typeof entry.command !== "string" || !Array.isArray(entry.args)) {
      throw new HopError("MALFORMED_MANIFEST", `${filePath}: tools.${tool} needs command + args`);
    }
  }
  if (!isRecord(value.native)) {
    throw new HopError("MALFORMED_MANIFEST", `${filePath}: missing native state refs`);
  }
  for (const tool of TOOL_NAMES) {
    const entry = value.native[tool];
    if (!isRecord(entry) || typeof entry.statePath !== "string") {
      throw new HopError("MALFORMED_MANIFEST", `${filePath}: native.${tool}.statePath is required`);
    }
  }
  for (const field of ["snapshots", "evidence", "unresolved"] as const) {
    if (!Array.isArray(value[field])) {
      throw new HopError("MALFORMED_MANIFEST", `${filePath}: ${field} must be an array`);
    }
  }
  if (typeof value.timeoutMs !== "number" || typeof value.lockTimeoutMs !== "number") {
    throw new HopError("MALFORMED_MANIFEST", `${filePath}: timeoutMs/lockTimeoutMs must be numbers`);
  }
  return value as unknown as HopManifest;
}

/** Load + validate a HOP manifest. */
export function loadHop(hopPath: string): HopManifest {
  return validateManifest(readJsonFile(hopPath), hopPath);
}

/** Persist a manifest atomically (updates `updatedAt`). */
export function saveHop(hopPath: string, manifest: HopManifest): void {
  manifest.updatedAt = nowIso();
  writeFileAtomic(hopPath, JSON.stringify(manifest, null, 2) + "\n");
}

/**
 * Serialize access to one manifest via an exclusive lock file
 * (`<hop.json>.lock`). The lock is always released, even on failure.
 */
async function withManifestLock<T>(
  hopPath: string,
  lockTimeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = `${hopPath}.lock`;
  const deadline = Date.now() + lockTimeoutMs;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw new HopError("IO_ERROR", `cannot acquire lock ${lockPath}`, err);
      }
      if (Date.now() >= deadline) {
        throw new HopError("LOCKED", `manifest is locked: ${lockPath}`);
      }
      await sleep(25);
    }
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: nowIso() }));
    return await fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export interface InitOptions {
  projectId?: string;
  timeoutMs?: number;
  lockTimeoutMs?: number;
  tools?: Partial<Record<ToolName, Partial<ToolConfig>>>;
  overwrite?: boolean;
}

/** Create a fresh HOP manifest (schemaVersion 1). */
export function initHop(hopPath: string, options: InitOptions = {}): HopManifest {
  if (fs.existsSync(hopPath) && options.overwrite !== true) {
    throw new HopError("HOP_EXISTS", `refusing to overwrite existing manifest: ${hopPath}`);
  }
  fs.mkdirSync(path.dirname(hopPath), { recursive: true });

  const tools = {} as Record<ToolName, ToolConfig>;
  const native = {} as Record<ToolName, NativeStateRef>;
  for (const tool of TOOL_NAMES) {
    const override = options.tools?.[tool] ?? {};
    const known = KNOWN_SOURCE[tool];
    tools[tool] = {
      command: override.command ?? DEFAULT_COMMAND[tool],
      args: override.args ?? [],
      env: override.env ?? {},
      sourceVersion: override.sourceVersion ?? known.version,
      sourceSha: override.sourceSha ?? known.sha,
    };
    native[tool] = { statePath: NATIVE_RELATIVE[tool], modelId: null, modelSha256: null };
  }

  const manifest: HopManifest = {
    schemaVersion: HOP_SCHEMA_VERSION,
    projectId: options.projectId ?? `prj_${randomUUID()}`,
    revision: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    managerAcceptance: "pending",
    acceptedRevision: null,
    managerNote: null,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    tools,
    native,
    snapshots: [],
    evidence: [],
    unresolved: [],
  };
  saveHop(hopPath, manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// MCP stdio JSON-RPC client (bounded, id-correlated, process-group kill)
// ---------------------------------------------------------------------------

export interface McpCallSpec {
  name: string;
  arguments: unknown;
}

export interface McpSequenceOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes?: number;
}

export interface McpSequenceResult {
  value: unknown;
  isError: boolean;
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

function extractStructured(result: unknown): unknown {
  if (!isRecord(result)) return result;
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (result.structured_content !== undefined) return result.structured_content;
  const content = Array.isArray(result.content) ? result.content : [];
  const textPart = content.find(
    (part): part is Record<string, unknown> =>
      isRecord(part) && part.type === "text" && typeof part.text === "string",
  );
  if (textPart && typeof textPart.text === "string") {
    try {
      return JSON.parse(textPart.text);
    } catch {
      return textPart.text;
    }
  }
  return result;
}

/**
 * Spawn an MCP server, run `initialize` + `notifications/initialized`, then
 * issue each `tools/call` in order, returning the LAST result. The connection
 * is closed and the whole process group killed on success, error, or timeout.
 */
export async function mcpCallSequence(
  options: McpSequenceOptions,
  calls: McpCallSpec[],
): Promise<McpSequenceResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const child = spawn(options.command, options.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(options.env ?? {}) },
    detached: true,
  });

  return new Promise<McpSequenceResult>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let stdoutBuf = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrText = "";
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      killTree(child);
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      reject(err);
    };
    const succeed = (value: McpSequenceResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      killTree(child);
      resolve(value);
    };

    timer = setTimeout(() => {
      fail(new HopError("TIMEOUT", `MCP call exceeded ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      fail(new HopError("SPAWN_ERROR", `failed to spawn '${options.command}': ${err.message}`, err));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrText.length < 8192) stderrText += chunk.toString("utf8");
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      if (pending.size > 0) {
        const tail = stderrText.trim();
        fail(
          new HopError(
            "SPAWN_ERROR",
            `MCP server exited before responding (code=${String(code)} signal=${String(signal)})${tail ? `: ${tail}` : ""}`,
          ),
        );
      }
    });

    function write(obj: unknown): void {
      if (!child.stdin || child.stdin.destroyed) return;
      try {
        child.stdin.write(JSON.stringify(obj) + "\n");
      } catch (err) {
        fail(new HopError("SPAWN_ERROR", `cannot write to MCP server: ${String(err)}`, err));
      }
    }

    function request(method: string, params: unknown): Promise<unknown> {
      const id = nextId++;
      return new Promise<unknown>((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        write({ jsonrpc: "2.0", id, method, params });
      });
    }

    function notify(method: string, params: unknown): void {
      write({ jsonrpc: "2.0", method, params });
    }

    function handleLine(line: string): void {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(msg) || msg.id === undefined || msg.id === null) return;
      const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (isRecord(msg.error)) {
        const message = typeof msg.error.message === "string" ? msg.error.message : "JSON-RPC error";
        entry.reject(new HopError("RPC_ERROR", message, msg.error));
      } else {
        entry.resolve(msg.result);
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        fail(new HopError("OUTPUT_LIMIT", `MCP output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
      let idx: number;
      while ((idx = stdoutBuf.indexOf(0x0a)) !== -1) {
        const line = stdoutBuf.subarray(0, idx).toString("utf8").trim();
        stdoutBuf = stdoutBuf.subarray(idx + 1);
        if (line) handleLine(line);
      }
    });

    void (async () => {
      await request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "junior-tools", version: "0.1.0" },
      });
      notify("notifications/initialized", {});
      let last: unknown;
      for (const call of calls) {
        last = await request("tools/call", { name: call.name, arguments: call.arguments ?? {} });
      }
      const isError = isRecord(last) && last.isError === true;
      succeed({ value: extractStructured(last), isError });
    })().catch((err) => fail(err));
  });
}

/** Convenience wrapper for a single tool call. */
export function mcpCallTool(
  options: McpSequenceOptions,
  toolName: string,
  args: unknown,
): Promise<McpSequenceResult> {
  return mcpCallSequence(options, [{ name: toolName, arguments: args }]);
}

// ---------------------------------------------------------------------------
// call
// ---------------------------------------------------------------------------

export interface CallRequest {
  tool: string;
  arguments?: unknown;
  expectedRevision?: number;
  timeoutMs?: number;
}

export interface CallOutcome {
  ok: boolean;
  tool: ToolName;
  toolName: string;
  revision: number;
  kind: CallKind;
  isError: boolean;
  unsupported: boolean;
  note: string | null;
  snapshot?: SnapshotRef | null;
  result?: unknown;
  error?: { code: string; message: string; detail?: unknown };
}

function nativeAbsPath(hopPath: string, tool: ToolName, manifest: HopManifest): string {
  const rel = manifest.native[tool]?.statePath ?? NATIVE_RELATIVE[tool];
  return path.resolve(path.dirname(hopPath), rel);
}

function buildToolEnv(hopPath: string, tool: ToolName, manifest: HopManifest): Record<string, string> {
  const abs = nativeAbsPath(hopPath, tool, manifest);
  if (tool === "fmeca") return { FMECA_STATE_DIR: abs };
  if (tool === "cpm") return { CPM_PLANNER_DB: abs };
  return {};
}

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
 * Build the ordered tools/call sequence for a request.
 *
 * Crossmatrix is in-memory upstream, so when a validated model has been stored
 * and the incoming call is not itself an import, we replay the import on the
 * fresh server before issuing the real call.
 */
function prepareCalls(
  hopPath: string,
  hop: HopManifest,
  tool: ToolName,
  toolName: string,
  args: unknown,
): McpCallSpec[] {
  const actual: McpCallSpec = { name: toolName, arguments: args ?? {} };
  if (tool !== "crossmatrix") return [actual];
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
 * Execute exactly one MCP tool call for a manifest, persist the outcome, and
 * return a structured envelope. Read results are exported as immutable
 * snapshots; unsupported/deferred notes become unresolved entries. This never
 * touches `managerAcceptance`.
 */
export async function callHop(
  hopPath: string,
  tool: ToolName,
  request: CallRequest,
): Promise<CallOutcome> {
  if (!TOOL_NAMES.includes(tool)) {
    throw new HopError("UNKNOWN_TOOL", `unknown tool '${String(tool)}'`);
  }
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

    const kind: CallKind = READ_TOOLS[tool].has(toolName) ? "read" : "command";
    const revision = hop.revision + 1;
    const cfg = hop.tools[tool];
    const timeoutMs = request.timeoutMs ?? hop.timeoutMs;
    const env = { ...(cfg.env ?? {}), ...buildToolEnv(hopPath, tool, hop) };

    let outcome: CallOutcome;
    try {
      const calls = prepareCalls(hopPath, hop, tool, toolName, request.arguments);
      const mcp = await mcpCallSequence(
        { command: cfg.command, args: cfg.args, env, timeoutMs },
        calls,
      );
      const note = findNote(mcp.value);
      const unsupported = note !== null && isUnsupportedNote(note);
      const ok = !mcp.isError && !unsupported;

      let snapshot: SnapshotRef | null = null;
      if (kind === "read" && ok) {
        snapshot = writeSnapshot(hopPath, tool, toolName, revision, mcp.value);
        hop.snapshots.push(snapshot);
      }
      if (tool === "crossmatrix" && toolName === "crossmatrix.command" && ok) {
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
    toolSourceVersions[tool] = hop.tools[tool].sourceVersion;
    toolSourceShas[tool] = hop.tools[tool].sourceSha;
    nativeStatePaths[tool] = hop.native[tool].statePath;
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

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseInitConfig(configPath: string | undefined): InitOptions {
  if (!configPath) return {};
  const raw = readJsonFile(configPath);
  if (!isRecord(raw)) throw new HopError("BAD_REQUEST", "config must be a JSON object");
  const options: InitOptions = {};
  if (typeof raw.projectId === "string") options.projectId = raw.projectId;
  if (typeof raw.timeoutMs === "number") options.timeoutMs = raw.timeoutMs;
  if (typeof raw.lockTimeoutMs === "number") options.lockTimeoutMs = raw.lockTimeoutMs;
  if (isRecord(raw.tools)) {
    options.tools = raw.tools as InitOptions["tools"];
  }
  return options;
}

async function cliInit(args: string[]): Promise<HopManifest> {
  const [hopPath, configPath] = args;
  if (!hopPath) throw new HopError("USAGE", "usage: tools.ts init <hop.json> [config.json]");
  return initHop(hopPath, parseInitConfig(configPath));
}

async function cliCall(args: string[]): Promise<CallOutcome> {
  const [hopPath, tool, requestPath] = args;
  if (!hopPath || !tool || !requestPath) {
    throw new HopError(
      "USAGE",
      "usage: tools.ts call <hop.json> <fmeca|cpm|crossmatrix> <request.json>",
    );
  }
  if (!TOOL_NAMES.includes(tool as ToolName)) {
    throw new HopError("UNKNOWN_TOOL", `unknown tool '${tool}'`);
  }
  const raw = readJsonFile(requestPath);
  if (!isRecord(raw)) throw new HopError("BAD_REQUEST", "request must be a JSON object");
  return callHop(hopPath, tool as ToolName, raw as unknown as CallRequest);
}

function cliInspect(args: string[]): InspectReport {
  const [hopPath] = args;
  if (!hopPath) throw new HopError("USAGE", "usage: tools.ts inspect <hop.json>");
  return inspectHop(hopPath);
}

function errorEnvelope(err: unknown): { ok: false; error: { code: string; message: string; detail?: unknown } } {
  const hopErr = err instanceof HopError ? err : toHopError(err);
  const error: { code: string; message: string; detail?: unknown } = {
    code: hopErr.code,
    message: hopErr.message,
  };
  if (hopErr.detail !== undefined) error.detail = hopErr.detail;
  return { ok: false, error };
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    let output: unknown;
    if (command === "init") output = await cliInit(rest);
    else if (command === "call") output = await cliCall(rest);
    else if (command === "inspect") output = cliInspect(rest);
    else throw new HopError("USAGE", "usage: tools.ts <init|call|inspect> ...");
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    return 0;
  } catch (err) {
    process.stdout.write(JSON.stringify(errorEnvelope(err), null, 2) + "\n");
    return 1;
  }
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
