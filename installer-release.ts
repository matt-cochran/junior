import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  DEFAULT_MAX_ASSET_BYTES,
  DEFAULT_MAX_CHECKSUM_BYTES,
  DEFAULT_REDIRECT_LIMIT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  InstallerError,
  SUPPORTED_MATRIX,
  type ExecBufferResult,
  type ExecResult,
  type FetchLike,
  type FetchResponseLike,
  type InstallerDeps,
} from "./installer-platform.ts";

export const APPROVED_HOSTS: ReadonlySet<string> = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

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
export function effectiveTimeoutMs(deps: InstallerDeps, fallback: number): number {
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

export async function boundedFetch(
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

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function expectedDigest(asset: ReleaseAsset, release: ReleaseInfo, deps: InstallerDeps): Promise<string> {
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

export function listArchive(archivePath: string, deps: InstallerDeps): ArchiveEntry[] {
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
export function extractEntryToBuffer(archivePath: string, entryName: string, deps: InstallerDeps): Buffer {
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

export function defaultExec(command: string, args: string[], options: any = {}): ExecResult {
  const r = spawnSync(command, args, { encoding: "utf8", ...options });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error?.message };
}
export function defaultExecBuffer(command: string, args: string[], options: any = {}): ExecBufferResult {
  const r = spawnSync(command, args, { maxBuffer: options.maxBuffer ?? DEFAULT_MAX_ASSET_BYTES, timeout: options.timeout, ...options });
  return {
    status: r.status,
    stdout: Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout ?? ""),
    stderr: typeof r.stderr === "string" ? r.stderr : r.stderr?.toString("utf8"),
    error: r.error?.message,
  };
}
