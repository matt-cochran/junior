import path from "node:path";
import process from "node:process";
import type { ReleaseInfo } from "./installer-release.ts";

// ---------------------------------------------------------------------------
// Public constants and types
// ---------------------------------------------------------------------------

export type ToolName = "fmeca" | "cpm" | "crossmatrix" | "scientific-process" | "elicitation";

export const TOOL_NAMES: readonly ToolName[] = ["fmeca", "cpm", "crossmatrix", "scientific-process", "elicitation"];

/**
 * Managed tools registered before they publish a standard release. A missing
 * release, a 404 or a release without this platform's asset is reported as a
 * non-fatal `unavailable` for these tools only; the original three keep their
 * existing failure behaviour.
 */
export const UNAVAILABLE_TOOLS: ReadonlySet<ToolName> = new Set(["scientific-process", "elicitation"]);

/** Repository + published binary name for each managed tool. */
export const TOOL_REPOS: Record<ToolName, { repo: string; binary: string }> = {
  fmeca: { repo: "praxec/fmeca", binary: "fmeca-mcp" },
  cpm: { repo: "praxec/cpm-planner", binary: "cpm-planner" },
  crossmatrix: { repo: "praxec/crossmatrix", binary: "crossmatrix-mcp" },
  "scientific-process": { repo: "praxec/scientific-process", binary: "scientific-process" },
  elicitation: { repo: "praxec/elicitation", binary: "elicitation" },
};

export const INSTALL_STATE_SCHEMA_VERSION = 1;

/** The supported mainstream release matrix (six targets). */
export const SUPPORTED_MATRIX: ReadonlyArray<{ os: OsName; arch: ArchName; triple: string; ext: ArchiveExt }> = [
  { os: "linux", arch: "x64", triple: "x86_64-unknown-linux-gnu", ext: "tar.gz" },
  { os: "linux", arch: "arm64", triple: "aarch64-unknown-linux-gnu", ext: "tar.gz" },
  { os: "darwin", arch: "x64", triple: "x86_64-apple-darwin", ext: "tar.gz" },
  { os: "darwin", arch: "arm64", triple: "aarch64-apple-darwin", ext: "tar.gz" },
  { os: "windows", arch: "x64", triple: "x86_64-pc-windows-msvc", ext: "zip" },
  { os: "windows", arch: "arm64", triple: "aarch64-pc-windows-msvc", ext: "zip" },
];

export type OsName = "linux" | "darwin" | "windows";
export type ArchName = "x64" | "arm64";
export type ArchiveExt = "tar.gz" | "zip";

export interface PlatformTarget {
  os: OsName;
  arch: ArchName;
  triple: string;
  ext: ArchiveExt;
}

/** Approved hosts for release metadata, downloads and redirects. */

export const DEFAULT_INSTALL_ROOT = path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".junior", "tools");
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_ASSET_BYTES = 200 * 1024 * 1024;
export const DEFAULT_MAX_CHECKSUM_BYTES = 1024 * 1024;
export const DEFAULT_REDIRECT_LIMIT = 5;
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
export const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60_000;

export class InstallerError extends Error {
  code: string;
  detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "InstallerError";
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Real-fetch streaming body; injectable fixtures may omit it. */
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel?: () => Promise<void> | void;
      releaseLock?: () => void;
    };
  };
}
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; redirect?: "manual" | "follow"; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export interface ExecResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
}
export interface ExecBufferResult {
  status: number | null;
  stdout: Buffer;
  stderr?: string;
  error?: string;
}

export interface InstallerDeps {
  fetch?: FetchLike;
  exec?: (command: string, args: string[], options?: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv }) => ExecResult;
  execBuffer?: (command: string, args: string[], options?: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv }) => ExecBufferResult;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  installRoot?: string;
  statePath?: string;
  hopPath?: string;
  cwd?: string;
  /** Conservative health probe; injectable so tests never spawn a server. */
  probe?: (binaryPath: string) => Promise<boolean>;
  logger?: (line: string) => void;
  maxAssetBytes?: number;
  maxChecksumBytes?: number;
  requestTimeoutMs?: number;
  redirectLimit?: number;
  /** Overall wall-clock budget for one install across every tool and probe. */
  installTimeoutMs?: number;
  /** Absolute epoch ms by which the whole install must finish (internal). */
  deadlineAt?: number;
  /** Optional token for private GitHub releases; sent only to api.github.com. */
  githubToken?: string;
  /** Injectable bounded offline TRIZ smoke; defaults to importing it as ESM. */
  smokeTriz?: (jsPath: string) => Promise<boolean>;
  /** Force the resolved release instead of asking the GitHub API. */
  resolveRelease?: (repo: string) => Promise<ReleaseInfo>;
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

function normalizeOs(platform: NodeJS.Platform): OsName | null {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return "windows";
  return null;
}

function normalizeArch(arch: string): ArchName | null {
  const a = arch.toLowerCase();
  if (a === "x64" || a === "amd64") return "x64";
  if (a === "arm64" || a === "aarch64") return "arm64";
  return null;
}

/**
 * Resolve the native OS/architecture target. WSL reports `linux` and is treated
 * as Linux. On Windows, when the running process is an x64 emulation layer on
 * an ARM64 machine, `process.arch` is `x64`; the native architecture is read
 * from `PROCESSOR_ARCHITEW6432` / `PROCESSOR_ARCHITECTURE` so the correct ARM64
 * asset is selected instead of the emulated x64 one.
 */
export function detectPlatform(deps: InstallerDeps = {}): PlatformTarget {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const os = normalizeOs(platform);
  if (!os) {
    throw new InstallerError("UNSUPPORTED_PLATFORM", `unsupported operating system '${platform}'`, {
      supported: SUPPORTED_MATRIX,
    });
  }
  let archInput = deps.arch ?? process.arch;
  if (os === "windows") {
    const native = env.PROCESSOR_ARCHITEW6432 || env.PROCESSOR_ARCHITECTURE;
    if (native) archInput = native;
  }
  const arch = normalizeArch(archInput);
  if (!arch) {
    throw new InstallerError("UNSUPPORTED_PLATFORM", `unsupported architecture '${archInput}'`, {
      supported: SUPPORTED_MATRIX,
    });
  }
  const entry = SUPPORTED_MATRIX.find((m) => m.os === os && m.arch === arch);
  if (!entry) {
    throw new InstallerError("UNSUPPORTED_PLATFORM", `no release target for ${os}/${arch}`, {
      supported: SUPPORTED_MATRIX,
    });
  }
  return { os, arch, triple: entry.triple, ext: entry.ext };
}

/** Exact published asset file name: `<binary>-<triple>.tar.gz` (unix) / `.zip` (Windows). */
export function releaseAssetName(tool: ToolName, target: PlatformTarget): string {
  return `${TOOL_REPOS[tool].binary}-${target.triple}.${target.ext}`;
}

export function binaryFileName(tool: ToolName, target: PlatformTarget): string {
  return target.os === "windows" ? `${TOOL_REPOS[tool].binary}.exe` : TOOL_REPOS[tool].binary;
}
