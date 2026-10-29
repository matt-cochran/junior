/**
 * Spawn environment and version helpers for junior-tools.
 * Split from tools/tools.ts per ADR 0016; the facade re-exports the public API.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { companionGatewayEnv, resolveGatewayKey } from "../gateway.ts";
import type { GatewayDeps } from "../gateway.ts";
import { loadDefaults } from "../setup.ts";
import { assertCommodity } from "../model-policy.ts";
import { HopError, NATIVE_RELATIVE, isSet } from "./tools-manifest.ts";
import type { CallKind, HopManifest, SnapshotRef, ToolName } from "./tools-manifest.ts";

// ---------------------------------------------------------------------------
// call
// ---------------------------------------------------------------------------

export interface CallRequest {
  tool: string;
  arguments?: unknown;
  expectedRevision?: number;
  timeoutMs?: number;
  /**
   * Whether `callHop` should prepend a store-session `model.open` before a
   * Crossmatrix 0.3+ command/query that names a model. Defaults to true so an
   * ad-hoc `tools call` works against a fresh server. The wrapper's internal
   * write flows set it false and keep their existing command sequences.
   */
  prependModelOpen?: boolean;
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

export function nativeAbsPath(hopPath: string, tool: ToolName, manifest: HopManifest): string {
  const rel = manifest.native[tool]?.statePath ?? NATIVE_RELATIVE[tool];
  return path.resolve(path.dirname(hopPath), rel);
}

/**
 * Resolve the Git work-tree root for a directory. Prefers
 * `git rev-parse --show-toplevel` (correct for linked worktrees and
 * submodules) and falls back to the nearest ancestor containing a `.git`
 * entry when Git is unavailable or the directory is not a repository.
 */
function gitTopLevel(startDir: string): string | null {
  try {
    const res = spawnSync("git", ["-C", startDir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (res.status === 0) {
      const out = (res.stdout ?? "").split("\n")[0].trim();
      if (out) return path.resolve(out);
    }
  } catch {
    /* fall through to the `.git` walk */
  }
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The project directory that anchors the Crossmatrix store: the Git top-level
 * of the hop file's directory, falling back to the hop file's grandparent when
 * the hop is not inside a Git repository.
 */
function crossmatrixProjectDir(hopPath: string): string {
  const hopDir = path.dirname(path.resolve(hopPath));
  return gitTopLevel(hopDir) ?? path.dirname(hopDir);
}

/**
 * cpm-planner 0.4.3 logs the SQLite database it opens. Junior compares that
 * path with the project database it supplied, so an old or misconfigured
 * binary cannot silently use cpm-planner's user-level default database.
 */
export function assertCpmProjectDatabase(stderr: string, expected: string): void {
  const marker = "opening planner database db=";
  const line = stderr.split(/\r?\n/).find((entry) => entry.includes(marker));
  if (!line) return;
  const reported = line.slice(line.indexOf(marker) + marker.length);
  const stateMode = reported.search(/\s+state_mode=/);
  const opened = reported.slice(0, stateMode === -1 ? reported.length : stateMode).trim();
  if (path.resolve(opened) !== path.resolve(expected)) {
    throw new HopError(
      "UPSTREAM_ERROR",
      `cpm-planner opened database '${opened}' instead of the project database '${expected}'`,
    );
  }
}

export function buildToolEnv(hopPath: string, tool: ToolName, manifest: HopManifest): Record<string, string> {
  if (tool === "fmeca") return { FMECA_STATE_DIR: nativeAbsPath(hopPath, tool, manifest) };
  if (tool === "cpm") return { CPM_PLANNER_DB: nativeAbsPath(hopPath, tool, manifest) };
  if (tool === "scientific-process") {
    return { SCIENTIFIC_PROCESS_STATE_DIR: nativeAbsPath(hopPath, tool, manifest) };
  }
  if (tool === "elicitation") return { ELICITATION_STATE_DIR: nativeAbsPath(hopPath, tool, manifest) };
  const store = path.join(crossmatrixProjectDir(hopPath), ".crossmatrix");
  return fs.existsSync(store) ? { CROSSMATRIX_DIR: store } : {};
}

/**
 * Gateway env for a companion spawn: the OpenRouter key and, when it resolves,
 * the TypeSafe key. A name already set non-blank in the process env or the
 * hop's `tools.<tool>.env` is left to that source, and cpm's explicit
 * CPM_OPENROUTER_KEY_FILE suppresses the derived OPENROUTER_API_KEY (the same
 * rule `cpmReviewEnv` applies). Values are for the child spawn only and are
 * never persisted by the caller.
 */
export function companionKeyEnv(
  hopEnv: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
  deps: GatewayDeps = {},
): Record<string, string> {
  const resolved = companionGatewayEnv({ env, ...deps });
  const provided = (name: string): boolean =>
    isSet(env[name]) || isSet(deps.env?.[name]) || isSet(hopEnv?.[name]);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(resolved)) {
    if (provided(name)) continue;
    out[name] = value;
  }
  if (provided("CPM_OPENROUTER_KEY_FILE")) {
    delete out.OPENROUTER_API_KEY;
  }
  return out;
}

/** Env var names that, when set, already direct the cpm tool at a review key. */
const CPM_REVIEW_ENV_KEYS = ["OPENROUTER_API_KEY", "CPM_OPENROUTER_KEY_FILE"] as const;

/** Whether the process or hop env already names a review key (or key file). */
function explicitCpmReviewEnv(hopEnv: Record<string, string> | undefined, env: NodeJS.ProcessEnv): boolean {
  for (const name of CPM_REVIEW_ENV_KEYS) {
    if (typeof env[name] === "string" && env[name]!.trim()) return true;
    if (typeof hopEnv?.[name] === "string" && hopEnv[name]!.trim()) return true;
  }
  return false;
}

/**
 * Extra env for a cpm spawn. When neither the process env nor the hop's
 * `tools.cpm.env` names a review key, fall back to the OpenRouter gateway
 * resolution (gateway.ts's single key source) and inject it as
 * OPENROUTER_API_KEY. The value is for the child spawn only and is never
 * persisted by the caller.
 */
export function cpmReviewEnv(hopEnv: Record<string, string> | undefined, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (explicitCpmReviewEnv(hopEnv, env)) return {};
  const key = resolveGatewayKey("openrouter", { env });
  return key ? { OPENROUTER_API_KEY: key } : {};
}

/** Whether a review key would be visible to the cpm tool, without exposing it. */
export function cpmReviewStatus(hopEnv: Record<string, string> | undefined, env: NodeJS.ProcessEnv = process.env): "available" | "unavailable" {
  if (explicitCpmReviewEnv(hopEnv, env)) return "available";
  return resolveGatewayKey("openrouter", { env }) ? "available" : "unavailable";
}

/** The first non-empty CPM_LLM_MODEL: hop env first, then the process env. */
function explicitCpmModel(hopEnv: Record<string, string> | undefined, env: NodeJS.ProcessEnv): string | null {
  for (const value of [hopEnv?.CPM_LLM_MODEL, env.CPM_LLM_MODEL]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Extra env for a cpm spawn that selects the executor model. An explicit
 * CPM_LLM_MODEL in the hop env wins over the process env, and both win over
 * the project's resolved model. The project model only applies when the
 * project provider is openrouter, the provider cpm routes through; otherwise
 * cpm-planner's own commodity default is left in charge. Whichever id wins is
 * policy-checked with the commodity gate, so a frontier or unknown model
 * throws and the caller fails before spawning any child.
 */
export function cpmModelEnv(
  hopPath: string,
  hopEnv: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
  loadProjectDefaults = loadDefaults,
): Record<string, string> {
  const explicit = explicitCpmModel(hopEnv, env);
  if (explicit) {
    assertCommodity("openrouter", explicit);
    return { CPM_LLM_MODEL: explicit };
  }
  // hop.json lives at <project>/.delivery/setup/hop.json.
  const projectDir = path.dirname(path.dirname(path.dirname(hopPath)));
  const defaults = loadProjectDefaults(projectDir);
  if (defaults.provider !== "openrouter") return {};
  assertCommodity("openrouter", defaults.model);
  return { CPM_LLM_MODEL: defaults.model };
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: boolean;
}

/** Parse a full semantic version, or null when it is not well-formed. */
function parseSemver(version: unknown): Semver | null {
  if (typeof version !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, prerelease: match[4] !== undefined };
}

/**
 * Whether the Crossmatrix server owns persistence through its 0.3.0+ project
 * store (`<project>/.crossmatrix`) rather than the wrapper replaying a stored
 * model on every call. Unparseable versions are treated as legacy. A 0.3.0
 * prerelease sorts below the 0.3.0 release and is therefore legacy.
 */
export function crossmatrixUsesStore(hop: HopManifest): boolean {
  const version = parseSemver(hop?.tools?.crossmatrix?.sourceVersion);
  if (version === null) return false;
  if (version.major !== 0) return version.major > 0;
  if (version.minor !== 3) return version.minor > 3;
  if (version.patch !== 0) return version.patch > 0;
  return !version.prerelease;
}
