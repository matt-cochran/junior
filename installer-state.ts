import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadHop, mcpCallSequence } from "./tools/tools.ts";
import {
  DEFAULT_INSTALL_ROOT,
  DEFAULT_PROBE_TIMEOUT_MS,
  INSTALL_STATE_SCHEMA_VERSION,
  InstallerError,
  TOOL_NAMES,
  TOOL_REPOS,
  UNAVAILABLE_TOOLS,
  type InstallerDeps,
  type ToolName,
} from "./installer-platform.ts";
import { effectiveTimeoutMs, resolveLatestRelease } from "./installer-release.ts";

// Re-exported for installer-integrations.ts so only this module imports tools/tools.ts.
export { loadHop };

// ---------------------------------------------------------------------------
// Managed state manifest + atomic writes + lock
// ---------------------------------------------------------------------------

export interface InstalledTool {
  repo: string;
  tag: string;
  version: string;
  asset: string;
  assetDigest: string;
  binaryDigest: string;
  path: string;
  sourceSha?: string;
  installedAt: string;
}
export interface InstallState {
  schemaVersion: number;
  tools: Partial<Record<ToolName, InstalledTool>>;
  /** Optional pure-JS tools (currently TRIZ) resolved from a release archive. */
  optional?: { triz?: InstalledTool };
}

/** Portable compiled-JS dependency published by matt-cochran/triz. */
export const TRIZ_REPO = "matt-cochran/triz";

export function trizAssetName(tag: string): string {
  return tag.startsWith("v") ? `triz-${tag}-node.tgz` : `triz-v${tag}-node.tgz`;
}

export function defaultStatePath(deps: InstallerDeps = {}): string {
  return deps.statePath ?? path.join(deps.installRoot ?? DEFAULT_INSTALL_ROOT, "installed.json");
}

export function readInstallState(deps: InstallerDeps = {}): InstallState {
  const statePath = defaultStatePath(deps);
  if (!fs.existsSync(statePath)) return { schemaVersion: INSTALL_STATE_SCHEMA_VERSION, tools: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== INSTALL_STATE_SCHEMA_VERSION) {
      throw new InstallerError("MALFORMED_MANIFEST", `unsupported install state at ${statePath}`);
    }
    return { schemaVersion: parsed.schemaVersion, tools: parsed.tools ?? {}, optional: parsed.optional ?? {} };
  } catch (err) {
    if (err instanceof InstallerError) throw err;
    throw new InstallerError("MALFORMED_MANIFEST", `cannot read install state at ${statePath}`, err);
  }
}

export function writeFileAtomic(filePath: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

export function writeInstallState(state: InstallState, deps: InstallerDeps = {}): void {
  writeFileAtomic(defaultStatePath(deps), JSON.stringify(state, null, 2) + "\n");
}

export async function withInstallLock<T>(statePath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${statePath}.lock`;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  let fd: number | null = null;
  const deadline = Date.now() + 10_000;
  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw new InstallerError("IO_ERROR", `cannot acquire install lock ${lockPath}`, err);
      if (Date.now() >= deadline) throw new InstallerError("LOCKED", `another install holds ${lockPath}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
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
// Health probe (no model calls)
// ---------------------------------------------------------------------------

/** Conservative MCP `initialize` probe using the existing transport. */
export async function probeBinary(binaryPath: string, deps: InstallerDeps = {}): Promise<boolean> {
  if (deps.probe) return deps.probe(binaryPath);
  try {
    await mcpCallSequence(
      { command: binaryPath, args: [], timeoutMs: effectiveTimeoutMs(deps, DEFAULT_PROBE_TIMEOUT_MS) },
      [],
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HOP synchronization
// ---------------------------------------------------------------------------

export interface HopSyncResult {
  hopPath: string;
  created: boolean;
  updated: ToolName[];
}

/**
 * A HOP tool command is safe to repoint only when it is still a missing value,
 * the bare default binary name, a path previously written by this installer,
 * or a path inside the current managed install root. Anything else is an
 * explicit user customization and must be preserved verbatim.
 */
function isManagedToolCommand(
  tool: ToolName,
  command: string | undefined,
  previousPath: string | undefined,
  installRoot: string,
): boolean {
  if (!command) return true;
  if (command === TOOL_REPOS[tool].binary) return true;
  if (previousPath && command === previousPath) return true;
  const root = path.resolve(installRoot);
  const resolved = path.resolve(command);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Point `.delivery/setup/hop.json` at the downloaded binaries and record their
 * release provenance. Existing project id, revision, acceptance, native paths,
 * snapshots and evidence are preserved; nothing is reset. Explicitly custom
 * tool command/args/env are left untouched, and an idempotent sync makes no
 * mutation at all, so manager acceptance is only cleared when a managed tool
 * configuration actually changes.
 */
export async function syncHopWithTools(
  installed: Partial<Record<ToolName, InstalledTool>>,
  deps: InstallerDeps = {},
  previous: Partial<Record<ToolName, InstalledTool>> = {},
): Promise<HopSyncResult> {
  const cwd = deps.cwd ?? process.cwd();
  const hopPath = deps.hopPath ?? path.join(cwd, ".delivery", "setup", "hop.json");
  const installRoot = deps.installRoot ?? DEFAULT_INSTALL_ROOT;
  const tools = await import("./tools/tools.ts");
  let created = false;
  let hop: any;
  if (fs.existsSync(hopPath)) {
    hop = tools.loadHop(hopPath);
  } else {
    hop = tools.initHop(hopPath, { projectId: `prj_${randomUUID()}` });
    created = true;
  }
  const updated: ToolName[] = [];
  for (const tool of TOOL_NAMES) {
    const entry = installed[tool];
    if (!entry) continue;
    const current = hop.tools[tool] ?? { command: undefined, args: [], env: {} };
    if (!isManagedToolCommand(tool, current.command, previous[tool]?.path, installRoot)) continue;
    const sourceSha = entry.sourceSha ?? current.sourceSha ?? "";
    const unchanged =
      current.command === entry.path &&
      current.sourceVersion === entry.version &&
      (current.sourceSha ?? "") === sourceSha;
    if (unchanged) continue;
    hop.tools[tool] = {
      command: entry.path,
      args: current.args ?? [],
      env: current.env ?? {},
      sourceVersion: entry.version,
      sourceSha,
    };
    updated.push(tool);
  }
  if (created || updated.length > 0) {
    if (updated.length > 0) {
      hop.revision += 1;
      hop.managerAcceptance = "pending";
      hop.acceptedRevision = null;
      hop.managerNote = null;
    }
    tools.saveHop(hopPath, hop);
  }
  return { hopPath, created, updated };
}

// ---------------------------------------------------------------------------
// Update check (read-only: release metadata only, nothing is downloaded)
// ---------------------------------------------------------------------------

export interface ToolUpdateStatus {
  tool: ToolName | 'triz';
  installed: string | null;
  latest: string | null;
  /** null when the latest release could not be resolved. */
  outdated: boolean | null;
  /** True for a registered tool whose release is not published yet. */
  unavailable?: boolean;
  error?: string;
}

function compareDotted(a: string, b: string): number {
  const x = a.split(/[.-]/).slice(0, 3).map(Number);
  const y = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}

/** Compare each managed tool's recorded version with its latest stable release. */
export async function checkToolUpdates(deps: InstallerDeps = {}): Promise<{ tools: ToolUpdateStatus[]; outdated: Array<ToolName | 'triz'> }> {
  const state = readInstallState(deps);
  const tools = await Promise.all(TOOL_NAMES.map(async (tool): Promise<ToolUpdateStatus> => {
    const installed = state.tools[tool]?.version ?? null;
    try {
      const latest = (await resolveLatestRelease(TOOL_REPOS[tool].repo, deps)).version;
      return { tool, installed, latest, outdated: installed ? compareDotted(installed, latest) < 0 : true };
    } catch (err) {
      return {
        tool,
        installed,
        latest: null,
        outdated: null,
        ...(UNAVAILABLE_TOOLS.has(tool) ? { unavailable: true } : {}),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }));
  const optionalTriz = state.optional?.triz;
  if (optionalTriz) {
    const installed = optionalTriz.version ?? null;
    try {
      const latest = (await resolveLatestRelease(TRIZ_REPO, deps)).version;
      tools.push({ tool: 'triz', installed, latest, outdated: installed ? compareDotted(installed, latest) < 0 : true });
    } catch (err) {
      tools.push({ tool: 'triz', installed, latest: null, outdated: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { tools, outdated: tools.filter((t) => t.outdated === true).map((t) => t.tool) };
}
