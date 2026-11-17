import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_INSTALL_TIMEOUT_MS,
  DEFAULT_MAX_ASSET_BYTES,
  DEFAULT_INSTALL_ROOT,
  DEFAULT_PROBE_TIMEOUT_MS,
  InstallerError,
  SUPPORTED_MATRIX,
  binaryFileName,
  detectPlatform,
  releaseAssetName,
  TOOL_NAMES,
  TOOL_REPOS,
  UNAVAILABLE_TOOLS,
  type InstallerDeps,
  type PlatformTarget,
  type ToolName,
} from "./installer-platform.ts";
import {
  boundedFetch,
  defaultExec,
  effectiveTimeoutMs,
  expectedDigest,
  extractEntryToBuffer,
  installerClock,
  listArchive,
  resolveLatestRelease,
  sha256Hex,
  type ReleaseInfo,
} from "./installer-release.ts";
import {
  TRIZ_REPO,
  defaultStatePath,
  probeBinary,
  readInstallState,
  syncHopWithTools,
  trizAssetName,
  withInstallLock,
  writeFileAtomic,
  writeInstallState,
  type HopSyncResult,
  type InstallState,
  type InstalledTool,
} from "./installer-state.ts";
import { verifyManagedFile } from "./installer-integrations.ts";

// ---------------------------------------------------------------------------
// Install orchestration
// ---------------------------------------------------------------------------

export interface InstallOptions {
  tools?: ToolName[];
  update?: boolean;
  installRoot?: string;
  /** Also install the optional portable TRIZ CLI (separate, no model calls). */
  withTriz?: boolean;
}
export type ToolInstallStatus = "installed" | "current" | "update-available" | "unavailable" | "failed" | "skipped";
export interface ToolInstallOutcome {
  tool: ToolName;
  status: ToolInstallStatus;
  changed: boolean;
  version?: string;
  tag?: string;
  path?: string;
  error?: string;
}
/**
 * Bounded offline smoke for the extracted TRIZ entry. The default imports the
 * candidate as a real ESM module in a short-lived Node process so a broken
 * module (or a missing `type: module`) is caught before the working install is
 * replaced. Tests inject `deps.smokeTriz` and never spawn a process.
 */
async function defaultTrizSmoke(jsPath: string, deps: InstallerDeps): Promise<boolean> {
  const script = `import(${JSON.stringify(pathToFileURL(jsPath).href)}).then(() => process.exit(0), (err) => { console.error(String(err && err.message || err)); process.exit(1); });`;
  const r = defaultExec(process.execPath, ["--input-type=module", "--no-warnings", "-e", script], {
    timeout: effectiveTimeoutMs(deps, DEFAULT_PROBE_TIMEOUT_MS),
    env: { ...(deps.env ?? process.env), TRIZ_OFFLINE: "1", NO_UPDATE_NOTIFIER: "1" },
  });
  return !r.error && r.status === 0;
}

function trizShortcutOutcome(
  existing: InstalledTool | undefined,
  release: ReleaseInfo,
  destPath: string,
  opts: InstallOptions,
): TrizOutcome | null {
  const working = !!(existing && fs.existsSync(destPath));
  if (existing && existing.tag === release.tag && verifyManagedFile(destPath, existing.binaryDigest, false).verified) {
    return { status: "current", changed: false, version: existing.version, tag: existing.tag, path: destPath };
  }
  if (!opts.update && working) {
    return { status: "update-available", changed: false, version: existing!.version, tag: existing!.tag, path: destPath };
  }
  return null;
}

/** Validate the archive's optional package.json and build the managed manifest text. */
function trizManifestText(
  archivePath: string,
  entries: ReturnType<typeof listArchive>,
  matchName: string,
  assetName: string,
  release: ReleaseInfo,
  deps: InstallerDeps,
): string {
  // TRIZ 0.3+ reads its own package.json (name, version) at import time, so
  // the managed manifest carries the release's real identity, checked against
  // the release, plus `type: module`. Older archives have no package.json.
  const packageRoot = matchName.replace(/(^|\/)(dist\/)?triz\.js$/, "");
  const pkgEntry = entries.find((e) => e.type === "-" && e.name === `${packageRoot}${packageRoot && !packageRoot.endsWith("/") ? "/" : ""}package.json`);
  let manifest: Record<string, unknown> = { type: "module" };
  if (pkgEntry) {
    let pkg: any;
    try {
      pkg = JSON.parse(extractEntryToBuffer(archivePath, pkgEntry.name, deps).toString("utf8"));
    } catch (err) {
      throw new InstallerError("MALFORMED_MANIFEST", `archive ${assetName} has an unreadable package.json`, err);
    }
    if (pkg?.name !== undefined && pkg.name !== "@matthew-cochran/triz") {
      throw new InstallerError("MALFORMED_MANIFEST", `archive ${assetName} package.json names ${String(pkg.name)}, not @matthew-cochran/triz`);
    }
    if (typeof pkg?.version !== "string" || pkg.version !== release.version) {
      throw new InstallerError("MALFORMED_MANIFEST", `archive ${assetName} package.json version ${String(pkg?.version)} does not match release ${release.version}`);
    }
    manifest = { name: "@matthew-cochran/triz", version: pkg.version, type: "module" };
  }
  return JSON.stringify(manifest, null, 2) + "\n";
}

/** Stage the candidate with a managed ESM manifest, then smoke it. */
async function stageAndSmokeTriz(
  tmpDir: string,
  jsBytes: Buffer,
  manifestText: string,
  assetName: string,
  deps: InstallerDeps,
): Promise<string> {
  const candidateDir = path.join(tmpDir, "triz");
  const candidateJs = path.join(candidateDir, "dist", "triz.js");
  fs.mkdirSync(path.dirname(candidateJs), { recursive: true });
  fs.writeFileSync(candidateJs, jsBytes);
  fs.writeFileSync(path.join(candidateDir, "package.json"), manifestText);
  const smoke = deps.smokeTriz ?? ((p: string) => defaultTrizSmoke(p, deps));
  if (!(await smoke(candidateJs))) {
    throw new InstallerError("TRIZ_SMOKE_FAILED", `the extracted TRIZ entry ${assetName} failed its offline smoke test`);
  }
  return candidateJs;
}

function swapTrizInstall(candidateJs: string, destPath: string, packagePath: string, manifestText: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  writeFileAtomic(packagePath, manifestText);
  const backupPath = `${destPath}.bak`;
  const hadExisting = fs.existsSync(destPath);
  if (hadExisting) fs.renameSync(destPath, backupPath);
  try {
    fs.renameSync(candidateJs, destPath);
  } catch (err) {
    if (hadExisting && fs.existsSync(backupPath)) {
      try {
        fs.rmSync(destPath, { force: true });
      } catch {
        /* ignore */
      }
      fs.renameSync(backupPath, destPath);
    }
    throw err;
  }
  if (hadExisting) fs.rmSync(backupPath, { force: true });
}

/**
 * Optional portable TRIZ install: a checksum-verified compiled-JS release
 * archive whose `dist/triz.js` entry is written into managed state under a
 * managed `type: module` package manifest. A bounded offline smoke must pass
 * before the previous working installation is replaced, and a newer release is
 * never adopted without an explicit `--update`. It is a separate CLI run with
 * Node; no Rust build and no model call is involved.
 */
async function installTriz(
  state: InstallState,
  installRoot: string,
  opts: InstallOptions,
  deps: InstallerDeps,
): Promise<TrizOutcome> {
  const release = await resolveLatestRelease(TRIZ_REPO, deps);
  const assetName = trizAssetName(release.tag);
  const existing = state.optional?.triz;
  const trizDir = path.join(installRoot, "triz");
  const destPath = path.join(trizDir, "dist", "triz.js");
  const packagePath = path.join(trizDir, "package.json");
  const shortcut = trizShortcutOutcome(existing, release, destPath, opts);
  if (shortcut) return shortcut;
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    return { status: "failed", changed: false, error: `release ${release.tag} of ${TRIZ_REPO} has no asset ${assetName}` };
  }
  const expected = await expectedDigest(asset, release, deps);
  const body = await boundedFetch(asset.url, deps, {
    accept: "application/octet-stream",
    maxBytes: deps.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES,
  });
  if (sha256Hex(body) !== expected) {
    throw new InstallerError("CHECKSUM_MISMATCH", `SHA-256 mismatch for ${assetName}`);
  }
  const tmpDir = fs.mkdtempSync(path.join(installRoot, ".tmp-triz-"));
  try {
    const archivePath = path.join(tmpDir, assetName);
    fs.writeFileSync(archivePath, body);
    const entries = listArchive(archivePath, deps);
    const match = entries.find((e) => e.type === "-" && (e.name === "dist/triz.js" || e.name.endsWith("/dist/triz.js") || e.name === "triz.js"));
    if (!match) throw new InstallerError("MISSING_BINARY", `archive ${assetName} has no dist/triz.js entry`);
    const jsBytes = extractEntryToBuffer(archivePath, match.name, deps);
    const manifestText = trizManifestText(archivePath, entries, match.name, assetName, release, deps);

    // Stage the candidate with a managed ESM manifest, then smoke it before
    // touching the working installation.
    const candidateJs = await stageAndSmokeTriz(tmpDir, jsBytes, manifestText, assetName, deps);

    swapTrizInstall(candidateJs, destPath, packagePath, manifestText);

    state.optional = {
      ...(state.optional ?? {}),
      triz: {
        repo: TRIZ_REPO,
        tag: release.tag,
        version: release.version,
        asset: assetName,
        assetDigest: `sha256:${expected}`,
        binaryDigest: `sha256:${sha256Hex(jsBytes)}`,
        path: destPath,
        ...(release.sourceSha ? { sourceSha: release.sourceSha } : {}),
        installedAt: installerClock(deps).iso(),
      },
    };
    return { status: "installed", changed: true, version: release.version, tag: release.tag, path: destPath };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export interface TrizOutcome {
  status: ToolInstallStatus;
  changed: boolean;
  version?: string;
  tag?: string;
  path?: string;
  error?: string;
}
export interface InstallReport {
  ok: boolean;
  platform: PlatformTarget;
  statePath: string;
  outcomes: ToolInstallOutcome[];
  triz?: TrizOutcome;
  hop?: HopSyncResult;
  error?: string;
}

async function resolveToolRelease(
  tool: ToolName,
  repo: string,
  deps: InstallerDeps,
): Promise<{ release: ReleaseInfo } | { outcome: ToolInstallOutcome }> {
  try {
    return { release: await resolveLatestRelease(repo, deps) };
  } catch (err) {
    if (UNAVAILABLE_TOOLS.has(tool) && !(err instanceof InstallerError && err.code === "GITHUB_RATE_LIMITED")) {
      const message = err instanceof Error ? err.message : String(err);
      return { outcome: { tool, status: "unavailable", changed: false, error: `release unavailable for ${repo}: ${message}` } };
    }
    throw err;
  }
}

function toolShortcutOutcome(
  tool: ToolName,
  existing: InstalledTool | undefined,
  release: ReleaseInfo,
  destPath: string,
  opts: InstallOptions,
): ToolInstallOutcome | null {
  if (existing && existing.tag === release.tag && verifyManagedFile(destPath, existing.binaryDigest, true).verified) {
    return { tool, status: "current", changed: false, version: existing.version, tag: existing.tag, path: destPath };
  }
  if (!opts.update && existing && existing.tag !== release.tag && fs.existsSync(destPath)) {
    return {
      tool,
      status: "update-available",
      changed: false,
      version: existing.version,
      tag: existing.tag,
      path: destPath,
    };
  }
  return null;
}

/** Extract the tool binary from the archive into a probed candidate path. */
async function stageToolBinary(
  tool: ToolName,
  target: PlatformTarget,
  paths: { tmpDir: string; archivePath: string; destDir: string },
  body: Buffer,
  assetName: string,
  deps: InstallerDeps,
): Promise<{ candidatePath: string; binaryDigest: string }> {
  const { tmpDir, archivePath, destDir } = paths;
  fs.writeFileSync(archivePath, body);
  const binaryName = binaryFileName(tool, target);
  const entries = listArchive(archivePath, deps);
  const match = entries.find((e) => e.type === "-" && (e.name === binaryName || e.name.endsWith(`/${binaryName}`)));
  if (!match) {
    throw new InstallerError("MISSING_BINARY", `archive ${assetName} has no regular ${binaryName} entry`);
  }
  const binBytes = extractEntryToBuffer(archivePath, match.name, deps);
  const binaryDigest = sha256Hex(binBytes);

  fs.mkdirSync(destDir, { recursive: true });
  const candidatePath = path.join(tmpDir, binaryName);
  fs.writeFileSync(candidatePath, binBytes);
  if (target.os !== "windows") fs.chmodSync(candidatePath, 0o755);

  const healthy = await probeBinary(candidatePath, deps);
  if (!healthy) {
    throw new InstallerError("PROBE_FAILED", `the downloaded ${tool} binary failed its protocol probe`);
  }
  return { candidatePath, binaryDigest };
}

/**
 * Move the verified candidate into place. `swap.movedOld` is set as soon as the
 * old binary is moved aside so the caller's rollback can restore it.
 */
function swapToolBinary(
  candidatePath: string,
  destPath: string,
  backupPath: string,
  swap: { movedOld: boolean },
): boolean {
  // Atomic swap: move the old binary aside, then move the verified new one
  // into the managed destination so a partial write is never observable. The
  // old binary is only considered replaced once the new rename succeeds; any
  // failure after the old is moved restores it, so there is never a window
  // with no working install.
  const hadExisting = fs.existsSync(destPath);
  if (hadExisting) {
    fs.renameSync(destPath, backupPath);
    swap.movedOld = true;
  }
  try {
    fs.renameSync(candidatePath, destPath);
  } catch (err) {
    if (swap.movedOld && fs.existsSync(backupPath)) {
      try {
        fs.rmSync(destPath, { force: true });
      } catch {
        /* ignore */
      }
      fs.renameSync(backupPath, destPath);
    }
    throw err;
  }
  return hadExisting;
}

async function fetchVerifiedToolAsset(
  asset: ReleaseInfo["assets"][number],
  release: ReleaseInfo,
  assetName: string,
  deps: InstallerDeps,
): Promise<{ body: Buffer; expected: string }> {
  const expected = await expectedDigest(asset, release, deps);
  const body = await boundedFetch(asset.url, deps, {
    accept: "application/octet-stream",
    maxBytes: deps.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES,
  });
  const actual = sha256Hex(body);
  if (actual !== expected) {
    throw new InstallerError("CHECKSUM_MISMATCH", `SHA-256 mismatch for ${assetName}`, { expected, actual });
  }
  return { body, expected };
}

/** One tool's install, with the previous working binary preserved on failure. */
async function installOne(
  tool: ToolName,
  target: PlatformTarget,
  state: InstallState,
  statePath: string,
  installRoot: string,
  opts: InstallOptions,
  deps: InstallerDeps,
): Promise<ToolInstallOutcome> {
  const repo = TOOL_REPOS[tool].repo;
  const resolved = await resolveToolRelease(tool, repo, deps);
  if ("outcome" in resolved) return resolved.outcome;
  const release = resolved.release;
  const assetName = releaseAssetName(tool, target);
  const asset = release.assets.find((a) => a.name === assetName);
  const existing = state.tools[tool];
  const destDir = path.join(installRoot, tool);
  const destPath = path.join(destDir, binaryFileName(tool, target));

  const shortcut = toolShortcutOutcome(tool, existing, release, destPath, opts);
  if (shortcut) return shortcut;
  if (!asset) {
    if (UNAVAILABLE_TOOLS.has(tool)) {
      return { tool, status: "unavailable", changed: false, error: `release ${release.tag} of ${repo} has no asset ${assetName}` };
    }
    throw new InstallerError(
      "MISSING_ASSET",
      `release ${release.tag} of ${repo} has no asset ${assetName}`,
      { supported: SUPPORTED_MATRIX },
    );
  }

  const { body, expected } = await fetchVerifiedToolAsset(asset, release, assetName, deps);

  const tmpDir = fs.mkdtempSync(path.join(installRoot, `.tmp-${tool}-`));
  const archivePath = path.join(tmpDir, assetName);
  const backupPath = `${destPath}.bak`;
  const swap = { movedOld: false };
  try {
    const { candidatePath, binaryDigest } = await stageToolBinary(
      tool,
      target,
      { tmpDir, archivePath, destDir },
      body,
      assetName,
      deps,
    );

    const hadExisting = swapToolBinary(candidatePath, destPath, backupPath, swap);
    if (target.os !== "windows") fs.chmodSync(destPath, 0o755);

    state.tools[tool] = {
      repo,
      tag: release.tag,
      version: release.version,
      asset: assetName,
      assetDigest: `sha256:${expected}`,
      binaryDigest: `sha256:${binaryDigest}`,
      path: destPath,
      ...(release.sourceSha ? { sourceSha: release.sourceSha } : {}),
      installedAt: installerClock(deps).iso(),
    };
    if (hadExisting) fs.rmSync(backupPath, { force: true });

    return { tool, status: "installed", changed: true, version: release.version, tag: release.tag, path: destPath };
  } catch (err) {
    if (swap.movedOld && fs.existsSync(backupPath)) {
      // Roll back to the previous working install.
      try {
        fs.rmSync(destPath, { force: true });
      } catch {
        /* ignore */
      }
      fs.renameSync(backupPath, destPath);
    }
    throw err;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Remove `.tmp-<tool>-*` staging directories a crashed install left behind.
 * Only called while holding the install lock, so no live install owns them (#210).
 */
function removeStaleTempDirs(installRoot: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(installRoot);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(".tmp-")) continue;
    try {
      fs.rmSync(path.join(installRoot, name), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Install or verify the requested tools. With no `update`, an existing current
 * install is left untouched and a newer release is reported without floating to
 * it. A failure for one tool never removes another tool's working binary.
 */
export async function installTools(
  opts: InstallOptions = {},
  deps: InstallerDeps = {},
): Promise<InstallReport> {
  const target = detectPlatform(deps);
  const installRoot = opts.installRoot ?? deps.installRoot ?? DEFAULT_INSTALL_ROOT;
  const statePath = defaultStatePath({ ...deps, installRoot });
  const selected = opts.tools ?? [...TOOL_NAMES];
  const log = deps.logger ?? (() => {});
  const clock = installerClock(deps);
  const deadlineAt = deps.deadlineAt ?? clock.now() + (deps.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS);
  const runDeps: InstallerDeps = { ...deps, installRoot, statePath, deadlineAt };
  const outcomes: ToolInstallOutcome[] = [];
  let triz: TrizOutcome | undefined;
  let hop: HopSyncResult | undefined;
  let fatal: string | undefined;

  await withInstallLock(statePath, async () => {
    removeStaleTempDirs(installRoot);
    const state = readInstallState(runDeps);
    const previousTools: Partial<Record<ToolName, InstalledTool>> = { ...state.tools };
    for (const tool of selected) {
      try {
        log(`installing ${tool} for ${target.triple}`);
        outcomes.push(await installOne(tool, target, state, statePath, installRoot, opts, runDeps));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A GitHub rate limit is transient: report the tool skipped, not failed (#187).
        const skipped = err instanceof InstallerError && err.code === "GITHUB_RATE_LIMITED";
        outcomes.push({ tool, status: skipped ? "skipped" : "failed", changed: false, error: message });
      }
    }
    if (opts.withTriz || (opts.update && state.optional?.triz)) {
      try {
        triz = await installTriz(state, installRoot, opts, runDeps);
      } catch (err) {
        triz = { status: "failed", changed: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    // The managed manifest must only describe files that actually exist, so a
    // failed update never leaves a stale entry claiming a working install.
    for (const tool of TOOL_NAMES) {
      const e = state.tools[tool];
      if (e && !fs.existsSync(e.path)) delete state.tools[tool];
    }
    if (state.optional?.triz && !fs.existsSync(state.optional.triz.path)) delete state.optional.triz;
    const installed = Object.fromEntries(
      Object.entries(state.tools).filter(([, v]) => v && fs.existsSync((v as InstalledTool).path)),
    ) as Partial<Record<ToolName, InstalledTool>>;
    writeInstallState(state, runDeps);
    hop = await syncHopWithTools(installed, { ...runDeps, cwd: deps.cwd }, previousTools);
    const failed = outcomes.filter((o) => o.status === "failed");
    if (failed.length > 0) {
      fatal = failed.map((f) => `${f.tool}: ${f.error}`).join("; ");
    }
    if (triz?.status === "failed") {
      fatal = fatal ? `${fatal}; triz: ${triz.error}` : `triz: ${triz.error}`;
    }
  }, clock);

  return {
    ok: !fatal,
    platform: target,
    statePath,
    outcomes,
    ...(triz ? { triz } : {}),
    ...(hop ? { hop } : {}),
    ...(fatal ? { error: fatal } : {}),
  };
}
