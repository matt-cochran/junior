/**
 * HOP manifest schema, persistence and init for junior-tools.
 * Split from tools/tools.ts per ADR 0016; the facade re-exports the public API.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// Public constants and types
// ---------------------------------------------------------------------------

export const HOP_SCHEMA_VERSION = 1;
export const TOOL_NAMES = ["fmeca", "cpm", "crossmatrix", "scientific-process", "elicitation"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Tools every HOP has always carried. A HOP written before
 * scientific-process/elicitation were registered legitimately lacks those two
 * entries; only the legacy tools are required for such a manifest to load.
 */
const LEGACY_TOOL_NAMES: ReadonlySet<ToolName> = new Set(["fmeca", "cpm", "crossmatrix"]);
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

export const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MCP_PROTOCOL_VERSION = "2024-11-05";

// Provenance for a command that is not Junior's managed binary: the version
// the binary reports through `--version`. No release table is kept here, so a
// new upstream release never needs a Junior change; `junior update` installs it.
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const UNKNOWN_SOURCE_VERSION = "unknown";

/** Run `<command> --version` and return the first semver it prints, or null. */
export function probeToolVersion(command: string): string | null {
  const res = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: VERSION_PROBE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (res.error || res.status !== 0 || typeof res.stdout !== "string") return null;
  const match = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(res.stdout);
  return match ? match[0] : null;
}

const DEFAULT_COMMAND: Record<ToolName, string> = {
  fmeca: "fmeca-mcp",
  cpm: "cpm-planner",
  crossmatrix: "crossmatrix-mcp",
  "scientific-process": "scientific-process",
  elicitation: "elicitation",
};

export const NATIVE_RELATIVE: Record<ToolName, string> = {
  fmeca: "fmeca-state",
  cpm: "cpm-planner.db",
  crossmatrix: "crossmatrix-model.json",
  "scientific-process": "scientific-process-state",
  elicitation: "elicitation-state",
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
    "session.list",
    "actions.suggest",
    "policy.list",
    "vet",
  ]),
  cpm: new Set([
    "plan.status",
    "plan.get",
    "plan.lint",
    "plan.schedule",
    "plan.simulate",
    "plan.list",
    "plan.compare",
    "plan.ev",
    "plan.review",
  ]),
  crossmatrix: new Set(["crossmatrix.query"]),
  "scientific-process": new Set(["state.get", "experiment.next", "report.export", "adjudicate"]),
  elicitation: new Set(["state.get", "question.next", "readiness.assess", "spec.export"]),
};

/**
 * Classify an upstream tool call as a snapshot `read` or a state-mutating
 * `command`. Only successful reads are exported as immutable snapshots.
 */
export function isReadTool(tool: ToolName, toolName: string): boolean {
  return READ_TOOLS[tool].has(toolName);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Atomic file write: temp file in the same dir, then rename over the target. */
export function writeFileAtomic(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

export function readJsonFile(filePath: string): unknown {
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

export function toHopError(err: unknown): HopError {
  if (err instanceof HopError) return err;
  return new HopError("UPSTREAM_ERROR", err instanceof Error ? err.message : String(err), err);
}

// ---------------------------------------------------------------------------
// HOP validation / persistence
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when an env value is a non-blank string. */
export function isSet(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
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
    if (entry === undefined && !LEGACY_TOOL_NAMES.has(tool)) continue;
    if (!isRecord(entry) || typeof entry.command !== "string" || !Array.isArray(entry.args)) {
      throw new HopError("MALFORMED_MANIFEST", `${filePath}: tools.${tool} needs command + args`);
    }
  }
  if (!isRecord(value.native)) {
    throw new HopError("MALFORMED_MANIFEST", `${filePath}: missing native state refs`);
  }
  for (const tool of TOOL_NAMES) {
    const entry = value.native[tool];
    if (entry === undefined && !LEGACY_TOOL_NAMES.has(tool)) continue;
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

type LockHolder = { pid?: number; hostname?: string };

/** Read the holder recorded by an existing lock file, or null when it is
 * unreadable, malformed (legacy) or already gone. */
function readLockHolder(lockPath: string): LockHolder | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const pid = typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 ? value.pid : undefined;
  const hostname = typeof value.hostname === "string" && value.hostname.length > 0 ? value.hostname : undefined;
  return { pid, hostname };
}

/** True when `pid` names a live process (or liveness cannot be proven). Only a
 * `process.kill(pid, 0)` that throws ESRCH proves the holder is gone. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Remove a lock left by a dead same-host holder. A lock from another host, an
 * unparseable/legacy lock, or a live pid is never removed (returns false). */
function reapDeadHolderLock(lockPath: string): boolean {
  const holder = readLockHolder(lockPath);
  if (!holder || holder.hostname !== os.hostname() || holder.pid === undefined) return false;
  if (isPidAlive(holder.pid)) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Serialize access to one manifest via an exclusive lock file
 * (`<hop.json>.lock`). The lock records the holder's pid, hostname and creation
 * time, and a lock left by a dead same-host holder is reaped on contention; any
 * other lock is kept and yields LOCKED once the deadline passes. The lock is
 * always released, even on failure.
 */
export async function withManifestLock<T>(
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
      if (reapDeadHolderLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new HopError("LOCKED", `manifest is locked: ${lockPath}`);
      }
      await sleep(25);
    }
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, hostname: os.hostname(), at: nowIso() }));
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
  /** Junior's managed install state (`~/.junior/tools/installed.json`). A tool
   * installed there defaults to that binary and its recorded version. */
  managedStatePath?: string;
  /** Reports the version of a command that is not the managed binary
   * (default: `probeToolVersion`, which runs `<command> --version`). */
  probeVersion?: (command: string) => string | null;
}

/** Default managed install state, honoring `JUNIOR_TOOLS_ROOT`. */
export function defaultManagedStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.JUNIOR_TOOLS_ROOT || path.join(env.HOME ?? env.USERPROFILE ?? ".", ".junior", "tools");
  return path.join(root, "installed.json");
}

/** Managed binaries that are recorded and still present; unreadable state yields none. */
function readManagedTools(statePath: string | undefined): Partial<Record<ToolName, { path: string; version: string; sourceSha: string }>> {
  if (!statePath) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
  const out: Partial<Record<ToolName, { path: string; version: string; sourceSha: string }>> = {};
  const entries = isRecord(parsed) && isRecord(parsed.tools) ? parsed.tools : {};
  for (const tool of TOOL_NAMES) {
    const e = entries[tool];
    if (isRecord(e) && typeof e.path === "string" && typeof e.version === "string" && fs.existsSync(e.path)) {
      out[tool] = { path: e.path, version: e.version, sourceSha: typeof e.sourceSha === "string" ? e.sourceSha : "" };
    }
  }
  return out;
}

/** Create a fresh HOP manifest (schemaVersion 1). */
export function initHop(hopPath: string, options: InitOptions = {}): HopManifest {
  if (fs.existsSync(hopPath) && options.overwrite !== true) {
    throw new HopError("HOP_EXISTS", `refusing to overwrite existing manifest: ${hopPath}`);
  }
  fs.mkdirSync(path.dirname(hopPath), { recursive: true });

  const tools = {} as Record<ToolName, ToolConfig>;
  const native = {} as Record<ToolName, NativeStateRef>;
  const managed = readManagedTools(options.managedStatePath);
  const probe = options.probeVersion ?? probeToolVersion;
  for (const tool of TOOL_NAMES) {
    const override = options.tools?.[tool] ?? {};
    const installed = managed[tool];
    const command = override.command ?? installed?.path ?? DEFAULT_COMMAND[tool];
    // A managed install's provenance only applies when the resolved command is
    // that binary. Any other command records the version it reports (not
    // probed when the config sets sourceVersion) and an unknown source SHA.
    const usesManagedBinary = installed !== undefined && command === installed.path;
    const known = usesManagedBinary
      ? { version: installed.version, sha: installed.sourceSha }
      : {
          version: override.sourceVersion ?? probe(command) ?? UNKNOWN_SOURCE_VERSION,
          sha: "",
        };
    const env = { ...(override.env ?? {}) };
    // cpm-planner 0.4.3 falls back to a user-level database when
    // CPM_PLANNER_DB is absent. Emit the project anchor in every generated
    // config so an unset or refreshed Hop never opens that default store.
    if (tool === "cpm" && !isSet(env.CPM_PLANNER_DB)) {
      env.CPM_PLANNER_DB = path.resolve(path.dirname(hopPath), NATIVE_RELATIVE.cpm);
    }
    tools[tool] = {
      command,
      args: override.args ?? [],
      env,
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
