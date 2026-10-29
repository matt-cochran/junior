// ---------------------------------------------------------------------------
// Prebuilt release-tool installer for Junior.
//
// `junior.ts init --install` downloads checksum-verified prebuilt binaries for
// FMECA, CPM Planner and Crossmatrix from GitHub stable releases instead of
// compiling Rust/Cargo locally. Nothing here runs unless the caller explicitly
// asks to install or update; `doctor` only reads the resulting state.
//
// Design rules enforced by this module:
//   • HTTPS + approved GitHub release hosts only (redirects are re-validated).
//   • Every asset is matched against a SHA-256 from `checksums.sha256` or the
//     release asset `digest` before it is extracted or executed.
//   • Archives are listed first; absolute paths, `..` traversal and symlink /
//     hardlink entries are rejected, then the exact regular binary entry is
//     streamed out with the system `tar`.
//   • Only the managed destination is written, atomically. A failed download,
//     verification, extraction or probe preserves the previous working install.
//   • State is recorded in a managed user-state manifest; a concurrent install
//     is excluded with a lock file and never partially overwrites.
//
// Only Node builtins are used. No npm dependencies, no shell interpolation.
// ---------------------------------------------------------------------------

import process from "node:process";
import { isDirectEntry } from "./cli-entry.ts";
import {
  DEFAULT_INSTALL_ROOT,
  DEFAULT_INSTALL_TIMEOUT_MS,
  DEFAULT_MAX_ASSET_BYTES,
  DEFAULT_MAX_CHECKSUM_BYTES,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_REDIRECT_LIMIT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  INSTALL_STATE_SCHEMA_VERSION,
  InstallerError,
  SUPPORTED_MATRIX,
  TOOL_NAMES,
  TOOL_REPOS,
  binaryFileName,
  detectPlatform,
  releaseAssetName,
  type ArchName,
  type ArchiveExt,
  type ExecBufferResult,
  type ExecResult,
  type FetchLike,
  type FetchResponseLike,
  type InstallerDeps,
  type OsName,
  type PlatformTarget,
  type ToolName,
} from "./installer-platform.ts";
import {
  APPROVED_HOSTS,
  parseChecksums,
  parseRelease,
  parseReleaseManifest,
  parseTarListing,
  resolveLatestRelease,
  validateArchiveEntries,
  type ReleaseAsset,
  type ReleaseInfo,
  type ReleaseManifestInfo,
} from "./installer-release.ts";
import {
  TRIZ_REPO,
  checkToolUpdates,
  defaultStatePath,
  probeBinary,
  readInstallState,
  syncHopWithTools,
  trizAssetName,
  writeInstallState,
  type HopSyncResult,
  type InstallState,
  type InstalledTool,
  type ToolUpdateStatus,
} from "./installer-state.ts";
import {
  installTools,
  type InstallOptions,
  type InstallReport,
  type ToolInstallOutcome,
  type ToolInstallStatus,
  type TrizOutcome,
} from "./installer-install.ts";
import {
  inspectIntegrations,
  type IntegrationReport,
  type IntegrationsResult,
} from "./installer-integrations.ts";

export {
  APPROVED_HOSTS,
  DEFAULT_INSTALL_ROOT,
  DEFAULT_INSTALL_TIMEOUT_MS,
  DEFAULT_MAX_ASSET_BYTES,
  DEFAULT_MAX_CHECKSUM_BYTES,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_REDIRECT_LIMIT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  INSTALL_STATE_SCHEMA_VERSION,
  InstallerError,
  SUPPORTED_MATRIX,
  TOOL_NAMES,
  TOOL_REPOS,
  TRIZ_REPO,
  binaryFileName,
  checkToolUpdates,
  defaultStatePath,
  detectPlatform,
  inspectIntegrations,
  installTools,
  parseChecksums,
  parseRelease,
  parseReleaseManifest,
  parseTarListing,
  probeBinary,
  readInstallState,
  releaseAssetName,
  resolveLatestRelease,
  syncHopWithTools,
  trizAssetName,
  validateArchiveEntries,
  writeInstallState,
};
export type {
  ArchName,
  ArchiveExt,
  ExecBufferResult,
  ExecResult,
  FetchLike,
  FetchResponseLike,
  HopSyncResult,
  InstallOptions,
  InstallReport,
  InstallState,
  InstalledTool,
  InstallerDeps,
  IntegrationReport,
  IntegrationsResult,
  OsName,
  PlatformTarget,
  ReleaseAsset,
  ReleaseInfo,
  ReleaseManifestInfo,
  ToolInstallOutcome,
  ToolInstallStatus,
  ToolName,
  ToolUpdateStatus,
  TrizOutcome,
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): InstallOptions {
  const opts: InstallOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--update") opts.update = true;
    else if (a === "--install-root") opts.installRoot = argv[++i];
    else if (a.startsWith("--install-root=")) opts.installRoot = a.slice("--install-root=".length);
    else if (a === "--tool") opts.tools = [argv[++i] as ToolName];
    else if (a.startsWith("--tool=")) opts.tools = [a.slice("--tool=".length) as ToolName];
    else if (a === "--with-triz") opts.withTriz = true;
  }
  return opts;
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  try {
    if (command === "install" || command === "update") {
      const opts = parseArgs(argv.slice(1));
      if (command === "update") opts.update = true;
      const report = await installTools(opts);
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return report.ok ? 0 : 1;
    }
    if (command === "status" || command === "doctor") {
      process.stdout.write(JSON.stringify(inspectIntegrations(), null, 2) + "\n");
      return 0;
    }
    process.stdout.write(
      JSON.stringify({ ok: false, error: { code: "USAGE", message: "usage: installer.ts <install|update|status> [--update] [--install-root DIR]" } }, null, 2) + "\n",
    );
    return 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof InstallerError ? err.code : "INSTALL_ERROR";
    process.stdout.write(JSON.stringify({ ok: false, error: { code, message } }, null, 2) + "\n");
    return 1;
  }
}

if (isDirectEntry(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
