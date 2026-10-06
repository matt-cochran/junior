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

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { loadHop, mcpCallSequence } from "./tools/tools.ts";
import { isDirectEntry } from "./cli-entry.ts";

// ---------------------------------------------------------------------------
// Public constants and types
// ---------------------------------------------------------------------------

export type ToolName = "fmeca" | "cpm" | "crossmatrix";

export const TOOL_NAMES: readonly ToolName[] = ["fmeca", "cpm", "crossmatrix"];

/** Repository + published binary name for each managed tool. */
export const TOOL_REPOS: Record<ToolName, { repo: string; binary: string }> = {
  fmeca: { repo: "praxec/fmeca", binary: "fmeca-mcp" },
  cpm: { repo: "praxec/cpm-planner", binary: "cpm-planner" },
  crossmatrix: { repo: "praxec/crossmatrix", binary: "crossmatrix-mcp" },
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
export const APPROVED_HOSTS: ReadonlySet<string> = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

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

// ---------------------------------------------------------------------------
// Bounded HTTPS fetch with approved-host redirect validation
// ---------------------------------------------------------------------------

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    throw new InstallerError("BAD_URL", `malformed URL: ${url}`);
  }
}

function assertApprovedUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new InstallerError("INSECURE_URL", `refusing non-HTTPS URL: ${url}`);
  }
  if (!APPROVED_HOSTS.has(parsed.host)) {
    throw new InstallerError("UNAPPROVED_HOST", `refusing unapproved release host: ${parsed.host}`);
  }
}

/**
 * Effective per-operation timeout: the smaller of the caller's request budget
 * and the remaining overall install deadline. An already-expired install
 * deadline fails fast instead of starting another bounded operation.
 */
function effectiveTimeoutMs(deps: InstallerDeps, fallback: number): number {
  const request = deps.requestTimeoutMs ?? fallback;
  if (deps.deadlineAt === undefined) return request;
  const remaining = deps.deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new InstallerError("INSTALL_DEADLINE", "the overall install deadline has been exceeded");
  }
  return Math.min(request, remaining);
}

function abortError(url: string): InstallerError {
  return new InstallerError("TIMEOUT", `GET ${url} was aborted by the request timeout`);
}

/**
 * Read a response body without ever buffering past `maxBytes`. Real fetch
 * responses expose a `ReadableStream`; injectable fixtures may instead offer
 * `arrayBuffer()`. The read races the caller's abort signal so a stalled body
 * cannot outlive the request timeout.
 */
async function readBodyBounded(res: FetchResponseLike, maxBytes: number, signal: AbortSignal, url: string): Promise<Buffer> {
  const body = res.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(abortError(url));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      for (;;) {
        const step = await Promise.race([reader.read(), aborted]);
        if (step.done) break;
        const chunk = Buffer.from(step.value ?? new Uint8Array());
        total += chunk.length;
        if (total > maxBytes) {
          throw new InstallerError("ASSET_TOO_LARGE", `response exceeds ${maxBytes} bytes`);
        }
        chunks.push(chunk);
      }
    } finally {
      try {
        await reader.cancel?.();
      } catch {
        /* the stream may already be closed */
      }
      try {
        reader.releaseLock?.();
      } catch {
        /* ignore */
      }
    }
    return Buffer.concat(chunks);
  }
  if (typeof res.arrayBuffer !== "function") {
    throw new InstallerError("MALFORMED_RESPONSE", `response from ${url} has no readable body`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new InstallerError("ASSET_TOO_LARGE", `response exceeds ${maxBytes} bytes`);
  }
  return buf;
}

async function boundedFetch(
  url: string,
  deps: InstallerDeps,
  opts: { accept: string; maxBytes: number },
): Promise<Buffer> {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  if (!fetchImpl) throw new InstallerError("NO_FETCH", "no fetch implementation is available");
  const redirectLimit = deps.redirectLimit ?? DEFAULT_REDIRECT_LIMIT;
  let current = url;
  for (let hop = 0; hop <= redirectLimit; hop++) {
    assertApprovedUrl(current);
    const timeoutMs = effectiveTimeoutMs(deps, DEFAULT_REQUEST_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: FetchResponseLike;
      try {
        res = await fetchImpl(current, {
          headers: {
            Accept: current.includes("/releases/assets/") ? "application/octet-stream" : opts.accept,
            "User-Agent": "junior-prebuilt-installer",
            ...(new URL(current).host === "api.github.com" && (deps.githubToken || (deps.env ?? process.env).GH_TOKEN || (deps.env ?? process.env).GITHUB_TOKEN)
              ? {Authorization: `Bearer ${deps.githubToken || (deps.env ?? process.env).GH_TOKEN || (deps.env ?? process.env).GITHUB_TOKEN}`} : {}),
          },
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof InstallerError) throw err;
        if ((err as { name?: string })?.name === "AbortError") throw abortError(current);
        throw new InstallerError("NETWORK_ERROR", `GET ${current} failed: ${err instanceof Error ? err.message : String(err)}`, err);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new InstallerError("BAD_REDIRECT", `redirect without Location from ${current}`);
        current = new URL(location, current).toString();
        continue;
      }
      if (!res.ok) {
        throw new InstallerError("HTTP_ERROR", `GET ${current} failed with HTTP ${res.status}`);
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        throw new InstallerError("ASSET_TOO_LARGE", `response exceeds ${opts.maxBytes} bytes`);
      }
      // Keep the abort timer armed while the body is read, and stream it with
      // a hard byte bound rather than buffering an over-limit response first.
      return await readBodyBounded(res, opts.maxBytes, controller.signal, current);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new InstallerError("TOO_MANY_REDIRECTS", `exceeded ${redirectLimit} redirects`);
}

// ---------------------------------------------------------------------------
// Release resolution + checksum parsing
// ---------------------------------------------------------------------------

export interface ReleaseAsset {
  name: string;
  url: string;
  digest?: string;
  size?: number;
  apiUrl?: string;
}
export interface ReleaseInfo {
  repo: string;
  tag: string;
  version: string;
  assets: ReleaseAsset[];
  sourceSha?: string;
}

export function parseRelease(repo: string, value: unknown): ReleaseInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InstallerError("MALFORMED_MANIFEST", `release metadata for ${repo} is not an object`);
  }
  const raw = value as Record<string, unknown>;
  const tag = raw.tag_name;
  if (typeof tag !== "string" || tag.length === 0) {
    throw new InstallerError("MALFORMED_MANIFEST", `release metadata for ${repo} is missing tag_name`);
  }
  if (!Array.isArray(raw.assets)) {
    throw new InstallerError("MALFORMED_MANIFEST", `release metadata for ${repo} is missing assets`);
  }
  const assets: ReleaseAsset[] = [];
  for (const item of raw.assets) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (typeof a.name !== "string") continue;
    const url = typeof a.browser_download_url === "string" ? a.browser_download_url : typeof a.url === "string" ? a.url : "";
    if (!url) continue;
    const asset: ReleaseAsset = { name: a.name, url };
    if (typeof a.url === "string") asset.apiUrl = a.url;
    if (typeof a.digest === "string") asset.digest = a.digest;
    if (typeof a.size === "number") asset.size = a.size;
    assets.push(asset);
  }
  return {
    repo,
    tag,
    version: tag.replace(/^v/i, ""),
    assets,
  };
}

export async function resolveLatestRelease(repo: string, deps: InstallerDeps): Promise<ReleaseInfo> {
  if (deps.resolveRelease) return deps.resolveRelease(repo);
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const buf = await boundedFetch(url, deps, {
    accept: "application/vnd.github+json",
    maxBytes: 4 * 1024 * 1024,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch (err) {
    throw new InstallerError("MALFORMED_MANIFEST", `invalid release JSON for ${repo}`, err);
  }
  const release = parseRelease(repo, parsed);
  if (deps.githubToken || (deps.env ?? process.env).GH_TOKEN || (deps.env ?? process.env).GITHUB_TOKEN) {
    for (const asset of release.assets) if (asset.apiUrl?.startsWith("https://api.github.com/")) asset.url = asset.apiUrl;
  }
  await loadReleaseManifest(release, deps);
  return release;
}

const GIT_SHA_RE = /^[0-9a-f]{40}$/i;

export interface ReleaseManifestInfo {
  sourceSha?: string;
  version?: string;
  tag?: string;
  targets?: string[];
}

function normalizeTargets(value: unknown): string[] {
  const names = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === "string" && v) names.add(v);
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") add(item);
      else if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        add(o.triple ?? o.target ?? o.name);
      }
    }
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      add(key);
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        add(o.triple ?? o.target);
      }
    }
  }
  return [...names];
}

/**
 * Parse a release's `release-manifest.json`. Praxec publishes
 * `{version, tag, sourceSha, targets:{<triple>:...}}`; TRIZ publishes
 * `{version, commit}` with no targets. A manifest that carries `targets` is the
 * new format and must cover the complete six-target matrix. The source SHA is
 * only ever a real 40-hex commit, never a binary digest.
 */
export function parseReleaseManifest(repo: string, value: unknown, release: ReleaseInfo): ReleaseManifestInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InstallerError("MALFORMED_MANIFEST", `release manifest for ${repo} is not an object`);
  }
  const raw = value as Record<string, unknown>;
  const info: ReleaseManifestInfo = {};

  const shaCandidate = raw.sourceSha ?? raw.source_sha ?? raw.sourceCommit ?? raw.commit;
  if (shaCandidate !== undefined) {
    if (typeof shaCandidate !== "string" || !GIT_SHA_RE.test(shaCandidate)) {
      throw new InstallerError("MALFORMED_MANIFEST", `release manifest for ${repo} has an invalid source SHA`);
    }
    info.sourceSha = shaCandidate.toLowerCase();
  }

  const version = typeof raw.version === "string" ? raw.version : undefined;
  const tag = typeof raw.tag === "string" ? raw.tag : typeof raw.tag_name === "string" ? raw.tag_name : undefined;
  if (version !== undefined) info.version = version;
  if (tag !== undefined) info.tag = tag;
  if (version !== undefined && version.replace(/^v/i, "") !== release.version.replace(/^v/i, "")) {
    throw new InstallerError("MALFORMED_MANIFEST", `release manifest version ${version} disagrees with release ${release.version}`);
  }
  if (tag !== undefined && tag.replace(/^v/i, "") !== release.tag.replace(/^v/i, "")) {
    throw new InstallerError("MALFORMED_MANIFEST", `release manifest tag ${tag} disagrees with release ${release.tag}`);
  }

  if (raw.targets !== undefined) {
    const targets = normalizeTargets(raw.targets);
    const required = repo === "matt-cochran/triz"
      ? ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"]
      : SUPPORTED_MATRIX.map((m) => m.triple);
    const missing = required.filter((t) => !targets.includes(t));
    if (missing.length > 0) {
      throw new InstallerError("MALFORMED_MANIFEST", `release manifest for ${repo} is missing targets: ${missing.join(", ")}`);
    }
    info.targets = targets;
  }
  return info;
}

/** Fetch and verify the optional `release-manifest.json`, preferring its SHA. */
async function loadReleaseManifest(release: ReleaseInfo, deps: InstallerDeps): Promise<void> {
  const asset = release.assets.find((a) => a.name === "release-manifest.json");
  if (!asset) return;
  const body = await boundedFetch(asset.url, deps, {
    accept: "application/json",
    maxBytes: deps.maxChecksumBytes ?? DEFAULT_MAX_CHECKSUM_BYTES,
  });
  if (asset.digest && /^sha256:[0-9a-f]{64}$/i.test(asset.digest)) {
    const expected = asset.digest.slice("sha256:".length).toLowerCase();
    if (sha256Hex(body) !== expected) {
      throw new InstallerError("CHECKSUM_MISMATCH", `release-manifest.json digest mismatch for ${release.repo}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch (err) {
    throw new InstallerError("MALFORMED_MANIFEST", `invalid release manifest JSON for ${release.repo}`, err);
  }
  const info = parseReleaseManifest(release.repo, parsed, release);
  if (info.sourceSha) release.sourceSha = info.sourceSha;
}

/** Parse a `checksums.sha256` file (`<hex>  <name>` lines). */
export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!match) continue;
    map.set(match[2].trim(), match[1].toLowerCase());
  }
  return map;
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function expectedDigest(asset: ReleaseAsset, release: ReleaseInfo, deps: InstallerDeps): Promise<string> {
  const checksumAsset = release.assets.find((a) => a.name === "checksums.sha256" || a.name === "SHA256SUMS");
  if (checksumAsset) {
    const body = await boundedFetch(checksumAsset.url, deps, {
      accept: "text/plain",
      maxBytes: deps.maxChecksumBytes ?? DEFAULT_MAX_CHECKSUM_BYTES,
    });
    const checksums = parseChecksums(body.toString("utf8"));
    const digest = checksums.get(asset.name);
    if (!digest) throw new InstallerError("MISSING_CHECKSUM", `no SHA-256 entry for ${asset.name}`);
    return digest;
  }
  if (asset.digest && /^sha256:[0-9a-f]{64}$/i.test(asset.digest)) {
    return asset.digest.slice("sha256:".length).toLowerCase();
  }
  throw new InstallerError("MISSING_CHECKSUM", `no checksums.sha256 asset or asset digest for ${asset.name}`);
}

// ---------------------------------------------------------------------------
// Safe archive handling
// ---------------------------------------------------------------------------

interface ArchiveEntry {
  name: string;
  type: string;
}

function isUnsafeName(name: string): boolean {
  if (!name) return true;
  if (name.startsWith("/") || name.startsWith("\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(name)) return true;
  return name.split(/[\\/]/).some((segment) => segment === "..");
}

/** Parse `tar -tvf` output into name/type entries (type = first mode char). */
export function parseTarListing(output: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([-dlhcbpsD])([rwxsStT-]{9})\s+\S+\s+\d+\s+\S+\s+\S+\s+(.*)$/);
    if (match) {
      entries.push({ type: match[1], name: match[3].trim() });
      continue;
    }
    entries.push({ type: "-", name: line.trim() });
  }
  return entries;
}

/**
 * Reject archives containing absolute paths, `..` traversal, or symlink /
 * hardlink entries before any extraction occurs.
 */
export function validateArchiveEntries(entries: ArchiveEntry[]): void {
  for (const entry of entries) {
    if (isUnsafeName(entry.name)) {
      throw new InstallerError("UNSAFE_ARCHIVE", `archive entry escapes the extraction root: ${entry.name}`);
    }
    if (entry.type === "l" || entry.type === "h") {
      throw new InstallerError("UNSAFE_ARCHIVE", `archive entry is a link and is refused: ${entry.name}`);
    }
  }
}

function listArchive(archivePath: string, deps: InstallerDeps): ArchiveEntry[] {
  const exec = deps.exec ?? defaultExec;
  const r = exec("tar", ["-tvf", archivePath], { timeout: effectiveTimeoutMs(deps, DEFAULT_REQUEST_TIMEOUT_MS) });
  if (r.error || r.status !== 0) {
    throw new InstallerError("ARCHIVE_LIST_FAILED", `cannot list archive: ${r.error ?? r.stderr ?? `tar exited ${r.status}`}`);
  }
  const entries = parseTarListing(r.stdout ?? "");
  validateArchiveEntries(entries);
  return entries;
}

/** Stream exactly one regular binary entry out of the archive to stdout. */
function extractEntryToBuffer(archivePath: string, entryName: string, deps: InstallerDeps): Buffer {
  const execBuffer = deps.execBuffer ?? defaultExecBuffer;
  const r = execBuffer("tar", ["-xOf", archivePath, entryName], {
    timeout: effectiveTimeoutMs(deps, DEFAULT_REQUEST_TIMEOUT_MS),
    maxBuffer: deps.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES,
  });
  if (r.error || r.status !== 0) {
    throw new InstallerError("EXTRACT_FAILED", `cannot extract ${entryName}: ${r.error ?? r.stderr ?? `tar exited ${r.status}`}`);
  }
  return r.stdout;
}

function defaultExec(command: string, args: string[], options: any = {}): ExecResult {
  const r = spawnSync(command, args, { encoding: "utf8", ...options });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error?.message };
}
function defaultExecBuffer(command: string, args: string[], options: any = {}): ExecBufferResult {
  const r = spawnSync(command, args, { maxBuffer: options.maxBuffer ?? DEFAULT_MAX_ASSET_BYTES, timeout: options.timeout, ...options });
  return {
    status: r.status,
    stdout: Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout ?? ""),
    stderr: typeof r.stderr === "string" ? r.stderr : r.stderr?.toString("utf8"),
    error: r.error?.message,
  };
}

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

function writeFileAtomic(filePath: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

export function writeInstallState(state: InstallState, deps: InstallerDeps = {}): void {
  writeFileAtomic(defaultStatePath(deps), JSON.stringify(state, null, 2) + "\n");
}

async function withInstallLock<T>(statePath: string, fn: () => Promise<T>): Promise<T> {
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
// Install orchestration
// ---------------------------------------------------------------------------

export interface InstallOptions {
  tools?: ToolName[];
  update?: boolean;
  installRoot?: string;
  /** Also install the optional portable TRIZ CLI (separate, no model calls). */
  withTriz?: boolean;
}
export type ToolInstallStatus = "installed" | "current" | "update-available" | "failed";
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
  const working = !!(existing && fs.existsSync(destPath));
  if (!opts.update && working) {
    if (existing!.tag === release.tag) {
      return { status: "current", changed: false, version: existing!.version, tag: existing!.tag, path: destPath };
    }
    return { status: "update-available", changed: false, version: existing!.version, tag: existing!.tag, path: destPath };
  }
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

    // Stage the candidate with a managed ESM manifest, then smoke it before
    // touching the working installation.
    const candidateDir = path.join(tmpDir, "triz");
    const candidateJs = path.join(candidateDir, "dist", "triz.js");
    fs.mkdirSync(path.dirname(candidateJs), { recursive: true });
    fs.writeFileSync(candidateJs, jsBytes);
    fs.writeFileSync(path.join(candidateDir, "package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n");
    const smoke = deps.smokeTriz ?? ((p: string) => defaultTrizSmoke(p, deps));
    if (!(await smoke(candidateJs))) {
      throw new InstallerError("TRIZ_SMOKE_FAILED", `the extracted TRIZ entry ${assetName} failed its offline smoke test`);
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    writeFileAtomic(packagePath, JSON.stringify({ type: "module" }, null, 2) + "\n");
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
        installedAt: new Date().toISOString(),
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
  const release = await resolveLatestRelease(repo, deps);
  const assetName = releaseAssetName(tool, target);
  const asset = release.assets.find((a) => a.name === assetName);
  const existing = state.tools[tool];
  const destDir = path.join(installRoot, tool);
  const destPath = path.join(destDir, binaryFileName(tool, target));

  if (!opts.update && existing && existing.tag === release.tag && fs.existsSync(destPath)) {
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
  if (!asset) {
    throw new InstallerError(
      "MISSING_ASSET",
      `release ${release.tag} of ${repo} has no asset ${assetName}`,
      { supported: SUPPORTED_MATRIX },
    );
  }

  const expected = await expectedDigest(asset, release, deps);
  const body = await boundedFetch(asset.url, deps, {
    accept: "application/octet-stream",
    maxBytes: deps.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES,
  });
  const actual = sha256Hex(body);
  if (actual !== expected) {
    throw new InstallerError("CHECKSUM_MISMATCH", `SHA-256 mismatch for ${assetName}`, { expected, actual });
  }

  const tmpDir = fs.mkdtempSync(path.join(installRoot, `.tmp-${tool}-`));
  const archivePath = path.join(tmpDir, assetName);
  const backupPath = `${destPath}.bak`;
  let movedOld = false;
  try {
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

    // Atomic swap: move the old binary aside, then move the verified new one
    // into the managed destination so a partial write is never observable. The
    // old binary is only considered replaced once the new rename succeeds; any
    // failure after the old is moved restores it, so there is never a window
    // with no working install.
    const hadExisting = fs.existsSync(destPath);
    if (hadExisting) {
      fs.renameSync(destPath, backupPath);
      movedOld = true;
    }
    try {
      fs.renameSync(candidatePath, destPath);
    } catch (err) {
      if (movedOld && fs.existsSync(backupPath)) {
        try {
          fs.rmSync(destPath, { force: true });
        } catch {
          /* ignore */
        }
        fs.renameSync(backupPath, destPath);
      }
      throw err;
    }
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
      installedAt: new Date().toISOString(),
    };
    if (hadExisting) fs.rmSync(backupPath, { force: true });

    return { tool, status: "installed", changed: true, version: release.version, tag: release.tag, path: destPath };
  } catch (err) {
    if (movedOld && fs.existsSync(backupPath)) {
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
  const deadlineAt = deps.deadlineAt ?? Date.now() + (deps.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS);
  const runDeps: InstallerDeps = { ...deps, installRoot, statePath, deadlineAt };
  const outcomes: ToolInstallOutcome[] = [];
  let triz: TrizOutcome | undefined;
  let hop: HopSyncResult | undefined;
  let fatal: string | undefined;

  await withInstallLock(statePath, async () => {
    const state = readInstallState(runDeps);
    const previousTools: Partial<Record<ToolName, InstalledTool>> = { ...state.tools };
    for (const tool of selected) {
      try {
        log(`installing ${tool} for ${target.triple}`);
        outcomes.push(await installOne(tool, target, state, statePath, installRoot, opts, runDeps));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        outcomes.push({ tool, status: "failed", changed: false, error: message });
      }
    }
    if (opts.withTriz) {
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
  });

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
function verifyManagedFile(filePath: string, recordedDigest: string | undefined, requireExecutable: boolean): FileVerdict {
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
