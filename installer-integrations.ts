import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_INSTALL_ROOT,
  TOOL_NAMES,
  TOOL_REPOS,
  SUPPORTED_MATRIX,
  type InstallerDeps,
  type ToolName,
} from "./installer-platform.ts";
import { sha256Hex } from "./installer-release.ts";
import {
  defaultStatePath,
  loadHop,
  readInstallState,
  type InstallState,
} from "./installer-state.ts";
// ---------------------------------------------------------------------------
// Read-only integration readiness for `doctor`
// ---------------------------------------------------------------------------

export interface IntegrationReport {
  tool: ToolName;
  repo: string;
  installed: boolean;
  /** Present and runnable; a recorded digest mismatch is not usable. */
  usable: boolean;
  /** Digest matches the recorded binary digest and, on unix, is executable. */
  verified: boolean;
  executable: boolean;
  version: string | null;
  tag: string | null;
  path: string | null;
  provenance: string | null;
  note: string;
}
export interface IntegrationsResult {
  ready: boolean;
  /** Optional dependencies are reported separately; they never gate core readiness. */
  optional?: { triz?: { installed: boolean; usable: boolean; verified: boolean; version: string | null; tag: string | null; path: string | null; provenance: string | null } };
  statePath: string;
  tools: IntegrationReport[];
  supported: typeof SUPPORTED_MATRIX;
}

interface FileVerdict {
  exists: boolean;
  digestOk: boolean;
  executable: boolean;
  verified: boolean;
  usable: boolean;
}

/** Verify a managed file on disk against its recorded digest and exec bit. */
export function verifyManagedFile(filePath: string, recordedDigest: string | undefined, requireExecutable: boolean): FileVerdict {
  const exists = fs.existsSync(filePath);
  if (!exists) return { exists: false, digestOk: false, executable: false, verified: false, usable: false };
  let executable = true;
  if (requireExecutable && process.platform !== "win32") {
    try {
      fs.accessSync(filePath, fs.constants.X_OK);
    } catch {
      executable = false;
    }
  }
  const want = recordedDigest?.replace(/^sha256:/i, "").toLowerCase();
  let digestOk = false;
  if (want && /^[0-9a-f]{64}$/.test(want)) {
    try {
      digestOk = sha256Hex(fs.readFileSync(filePath)) === want;
    } catch {
      digestOk = false;
    }
  }
  const verified = digestOk && executable;
  const usable = executable && (!want || digestOk);
  return { exists, digestOk, executable, verified, usable };
}

/** The configured HOP command, when it is a concrete local path. */
function hopLocalCommand(hopPath: string | undefined, hop: any, tool: ToolName): string | null {
  const command = hop?.tools?.[tool]?.command;
  if (typeof command !== "string" || !command) return null;
  if (!command.includes("/") && !command.includes("\\")) return null;
  return path.isAbsolute(command) ? command : path.resolve(path.dirname(hopPath ?? "."), command);
}

/**
 * Offline integration readiness: reports managed tool versions, provenance and
 * paths separately from Pi execution/auth readiness. A recorded binary is only
 * `verified` when its SHA-256 matches and (on unix) it is executable; a bare
 * file's existence is never enough. A configured local HOP path is reported as
 * `usable` unverified provenance when no managed install exists. It never
 * compiles Rust, never installs and never calls the network.
 */
export function inspectIntegrations(deps: InstallerDeps = {}): IntegrationsResult {
  const installRoot = deps.installRoot ?? DEFAULT_INSTALL_ROOT;
  const statePath = defaultStatePath({ ...deps, installRoot });
  const hopPath = deps.hopPath ?? (deps.cwd ? path.join(deps.cwd, ".delivery", "setup", "hop.json") : undefined);
  let hop: any = null;
  if (hopPath && fs.existsSync(hopPath)) {
    try {
      hop = loadHop(hopPath);
    } catch {
      hop = null;
    }
  }
  let state: InstallState;
  try {
    state = readInstallState({ ...deps, installRoot, statePath });
  } catch (err) {
    return {
      ready: false,
      statePath,
      tools: TOOL_NAMES.map((tool) => ({
        tool,
        repo: TOOL_REPOS[tool].repo,
        installed: false,
        usable: false,
        verified: false,
        executable: false,
        version: null,
        tag: null,
        path: null,
        provenance: null,
        note: err instanceof Error ? err.message : String(err),
      })),
      supported: SUPPORTED_MATRIX,
    };
  }
  const tools = TOOL_NAMES.map((tool): IntegrationReport => {
    const entry = state.tools[tool];
    if (entry) {
      const verdict = verifyManagedFile(entry.path, entry.binaryDigest, true);
      if (verdict.usable) {
        return {
          tool,
          repo: entry.repo,
          installed: true,
          usable: true,
          verified: verdict.verified,
          executable: verdict.executable,
          version: entry.version,
          tag: entry.tag,
          path: entry.path,
          provenance: `${entry.repo}@${entry.tag} (asset ${entry.assetDigest})`,
          note: verdict.verified ? "verified prebuilt binary present" : "prebuilt binary present (digest not recorded)",
        };
      }
      const note = !verdict.exists
        ? `recorded binary is missing at ${entry.path}`
        : !verdict.executable
          ? `recorded binary is not executable at ${entry.path}`
          : `recorded binary digest does not match at ${entry.path}`;
      const local = hopLocalCommand(hopPath, hop, tool);
      if (local && fs.existsSync(local)) {
        return {
          tool,
          repo: entry.repo,
          installed: true,
          usable: true,
          verified: false,
          executable: true,
          version: entry.version,
          tag: entry.tag,
          path: local,
          provenance: `local hop.json (unverified); managed binary unavailable: ${note}`,
          note: "configured local binary present (unverified provenance)",
        };
      }
      return {
        tool,
        repo: entry.repo,
        installed: true,
        usable: false,
        verified: false,
        executable: verdict.executable,
        version: entry.version,
        tag: entry.tag,
        path: entry.path,
        provenance: `${entry.repo}@${entry.tag} (asset ${entry.assetDigest})`,
        note,
      };
    }
    const local = hopLocalCommand(hopPath, hop, tool);
    if (local && fs.existsSync(local)) {
      return {
        tool,
        repo: TOOL_REPOS[tool].repo,
        installed: false,
        usable: true,
        verified: false,
        executable: true,
        version: null,
        tag: null,
        path: local,
        provenance: "local hop.json (unverified)",
        note: "configured local binary present (unverified provenance)",
      };
    }
    return {
      tool,
      repo: TOOL_REPOS[tool].repo,
      installed: false,
      usable: false,
      verified: false,
      executable: false,
      version: null,
      tag: null,
      path: null,
      provenance: null,
      note: `not installed; run \`junior.ts init --install\``,
    };
  });
  return { ready: tools.every((t) => t.usable), statePath, tools, supported: SUPPORTED_MATRIX, optional: { triz: trizReport(state) } };
}

function trizReport(state: InstallState) {
  const entry = state.optional?.triz;
  if (!entry) {
    return { installed: false, usable: false, verified: false, version: null, tag: null, path: null, provenance: null };
  }
  const verdict = verifyManagedFile(entry.path, entry.binaryDigest, false);
  return {
    installed: true,
    usable: verdict.usable,
    verified: verdict.verified,
    version: entry.version,
    tag: entry.tag,
    path: entry.path,
    provenance: `${entry.repo}@${entry.tag} (asset ${entry.assetDigest})`,
  };
}
