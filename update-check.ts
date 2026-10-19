// ---------------------------------------------------------------------------
// Startup update check and its short-lived cache.
//
// `collectUpdates` is the single collector shared by `junior doctor
// --check-updates` and the startup notice. It is the extraction of the doctor
// branch that used to live inline in junior.ts, so the doctor report keeps the
// exact same shape.
//
// `cachedUpdateSummary` fronts the collector with a `~/.junior/update-check.json`
// cache: a summary younger than 24 hours is served as-is, otherwise the
// collector refreshes it. A network/registry failure is silent: the previous
// cache is left untouched and no summary is produced.
//
// `startupNotice` prints at most one stderr line for the commands where an
// update is worth mentioning. Everything is injectable (clock, fs, collector
// and the individual probes) so tests run offline; a refresh is capped to a
// small budget so startup never stalls on a slow registry.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSpec } from './cli-entry.ts';
import { checkSelfUpdate, type SelfUpdateCheck, type SelfUpdateDeps } from './self-update.ts';
import { checkToolUpdates, type InstallerDeps, type ToolUpdateStatus, type ToolName } from './installer.ts';
import { inspectCompanions, type CompanionDeps, type CompanionsReport } from './companions.ts';
import { catalogIds, modelUpdates as detectModelUpdates, type ModelUpdate } from './model-updates.ts';
import type { CatalogFetch } from './models.ts';
import { loadModelConfig } from './roster.ts';

export const UPDATE_CHECK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_REFRESH_TIMEOUT_MS = 3000;

/** The `updates` object published by `doctor --check-updates`. */
export interface CollectedUpdates {
  junior: SelfUpdateCheck;
  managed: { tools: ToolUpdateStatus[]; outdated: Array<ToolName | 'triz'> };
  /** Packages of the companions that are behind their latest release. */
  companions: string[];
  /** Newer commodity models detected for the project roster. */
  models: { catalog: 'online' | 'local' | null; updates: ModelUpdate[] };
  remediation?: string;
}

export interface UpdateSummary {
  checkedAt: number;
  outdated: string[];
  remediation?: string;
}

/** Minimal fs seam so the cache can be exercised without disk. */
export interface UpdateCheckFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
  mkdirSync(path: string, options: { recursive: boolean }): void;
  renameSync(oldPath: string, newPath: string): void;
  existsSync(path: string): boolean;
  unlinkSync(path: string): void;
}

export interface UpdateCheckDeps {
  moduleUrl?: string;
  env?: NodeJS.ProcessEnv;
  /** Optional base directory for `update-check.json` (defaults to `~/.junior`). */
  home?: string;
  /** Explicit cache file path; wins over `home`/env resolution. */
  cachePath?: string;
  now?: () => number;
  fs?: UpdateCheckFs;
  ttlMs?: number;
  /** Hard budget for one refresh; also caps each probe. */
  refreshTimeoutMs?: number;
  /** Full live collection; tests inject it. Defaults to `collectUpdates`. */
  collect?: (deps?: UpdateCheckDeps) => Promise<CollectedUpdates>;
  /** Sink for the full companion report when `collectUpdates` runs. */
  onCompanions?: (report: CompanionsReport) => void;
  /** Where `startupNotice` writes; defaults to `process.stderr`. */
  writeNotice?: (line: string) => void;
  /** True for `doctor --check-updates`, which already prints the full report. */
  checkUpdates?: boolean;
  // Probe seams (defaults are the real self-update/installer/companion calls).
  checkSelf?: (deps: SelfUpdateDeps) => SelfUpdateCheck;
  checkTools?: (deps: InstallerDeps) => Promise<{ tools: ToolUpdateStatus[]; outdated: Array<ToolName | 'triz'> }>;
  inspect?: (deps: CompanionDeps, opts: { checkUpdates?: boolean }) => CompanionsReport;
  selfUpdateDeps?: SelfUpdateDeps;
  installerDeps?: InstallerDeps;
  companionDeps?: CompanionDeps;
  /** Caps forwarded to the default probes during a refresh. */
  budgetMs?: number;
  /** Project directory whose `delivery.config.json` drives model detection. */
  cwd?: string;
  /** Injectable OpenRouter catalog fetch for model detection. */
  modelFetch?: CatalogFetch;
  /** Full model-detection override; tests inject it. */
  modelUpdates?: (deps: UpdateCheckDeps) => Promise<CollectedUpdates['models']>;
}

const NOTICE_COMMANDS = new Set(['init', 'doctor', 'status', 'validate']);

const nodeFs: UpdateCheckFs = {
  readFileSync: (path) => readFileSync(path, 'utf8'),
  writeFileSync: (path, data) => writeFileSync(path, data),
  mkdirSync: (path, options) => mkdirSync(path, options),
  renameSync: (oldPath, newPath) => renameSync(oldPath, newPath),
  existsSync: (path) => existsSync(path),
  unlinkSync: (path) => unlinkSync(path),
};

/** Resolve `~/.junior/update-check.json`, honouring JUNIOR_HOME and the parent
 * of JUNIOR_TOOLS_ROOT (`<home>/.junior/tools` -> `<home>/.junior`). */
export function updateCheckCachePath(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  if (env.JUNIOR_HOME) return join(env.JUNIOR_HOME, 'update-check.json');
  if (env.JUNIOR_TOOLS_ROOT) return join(dirname(env.JUNIOR_TOOLS_ROOT), 'update-check.json');
  const base = home ?? env.HOME ?? env.USERPROFILE ?? '.';
  return join(base, '.junior', 'update-check.json');
}

/** True when JUNIOR_NO_UPDATE_CHECK disables the notice. */
export function updateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.JUNIOR_NO_UPDATE_CHECK;
  return value === '1' || value === 'true';
}

/** Total-budget exec for the companion probes: once the deadline passes every
 * later call returns immediately, so a refresh cannot chain slow registries. */
function boundedCompanionExec(budgetMs: number): NonNullable<CompanionDeps['exec']> {
  const deadline = Date.now() + budgetMs;
  return (command, args, options = {}) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { status: null, error: 'update check budget exceeded' };
    const spec = spawnSpec(command, args);
    const timeout = Math.max(1, Math.min(options.timeout ?? budgetMs, remaining));
    const r = spawnSync(spec.command, spec.args, {
      encoding: 'utf8',
      timeout,
      env: options.env,
      cwd: options.cwd,
      shell: spec.shell,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error?.message };
  };
}

function remediationFor(updates: CollectedUpdates): string | null {
  const parts: string[] = [];
  if (updates.junior.outdated === true) {
    parts.push(updates.junior.kind === 'source'
      ? 'This Junior runs from a source checkout; update it with `git pull` (junior update never touches a checkout).'
      : 'Run `junior update` to adopt the newer Junior release.');
  }
  if (updates.managed.outdated.length || updates.companions.length) {
    parts.push(updates.managed.outdated.includes('triz')
      ? 'Run `junior update --with-triz` to adopt the newer releases.'
      : 'Run `junior update` to adopt the newer releases.');
  }
  if (updates.models.updates.length) {
    parts.push('Run `junior model upgrade` to adopt newer models.');
  }
  return parts.length ? parts.join(' ') : null;
}

/** Detect newer commodity models for the project roster. Never throws: a
 * failure degrades to an empty, catalog-less result so the rest of the update
 * collection is unaffected. */
async function collectModelUpdates(deps: UpdateCheckDeps): Promise<CollectedUpdates['models']> {
  try {
    if (deps.modelUpdates) return await deps.modelUpdates(deps);
    const config = loadModelConfig(deps.cwd ?? process.cwd());
    const { ids, catalog } = await catalogIds({
      online: true,
      fetch: deps.modelFetch,
      timeoutMs: deps.budgetMs,
      env: deps.env,
    });
    const updates = detectModelUpdates(config, ids).filter((update) => update.newer.length > 0);
    return { catalog, updates };
  } catch {
    return { catalog: null, updates: [] };
  }
}

/**
 * Collect the live update state plus the full companion report. Kept separate
 * from `collectUpdates` so `doctor` can publish the companion report without a
 * second round of probes.
 */
export async function collectUpdateCheck(deps: UpdateCheckDeps = {}): Promise<{ updates: CollectedUpdates; companions: CompanionsReport }> {
  const checkSelf = deps.checkSelf ?? checkSelfUpdate;
  const selfDeps: SelfUpdateDeps = { ...(deps.selfUpdateDeps ?? {}) };
  if (deps.moduleUrl !== undefined) selfDeps.moduleUrl = deps.moduleUrl;
  if (deps.budgetMs !== undefined && selfDeps.timeoutMs === undefined) selfDeps.timeoutMs = deps.budgetMs;
  const junior = checkSelf(selfDeps);

  const checkTools = deps.checkTools ?? checkToolUpdates;
  const installerDeps: InstallerDeps = { ...(deps.installerDeps ?? {}) };
  if (deps.budgetMs !== undefined && installerDeps.requestTimeoutMs === undefined) installerDeps.requestTimeoutMs = deps.budgetMs;
  const managed = await checkTools(installerDeps);

  const inspect = deps.inspect ?? inspectCompanions;
  const companionDeps: CompanionDeps = { ...(deps.companionDeps ?? {}) };
  if (deps.budgetMs !== undefined && companionDeps.exec === undefined) companionDeps.exec = boundedCompanionExec(deps.budgetMs);
  const report = inspect(companionDeps, { checkUpdates: true });

  deps.onCompanions?.(report);
  const companions = report.companions.filter((c) => c.outdated === true).map((c) => c.package);
  const models = await collectModelUpdates(deps);
  const updates: CollectedUpdates = { junior, managed, companions, models };
  const remediation = remediationFor(updates);
  if (remediation) updates.remediation = remediation;
  return { updates, companions: report };
}

/** The live `doctor --check-updates` update object. */
export async function collectUpdates(deps: UpdateCheckDeps = {}): Promise<CollectedUpdates> {
  return (await collectUpdateCheck(deps)).updates;
}

function readCache(fs: UpdateCheckFs, path: string): UpdateSummary | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.checkedAt !== 'number' || !Array.isArray(parsed.outdated)) return null;
    const outdated = parsed.outdated.filter((value: unknown): value is string => typeof value === 'string');
    const summary: UpdateSummary = { checkedAt: parsed.checkedAt, outdated };
    if (typeof parsed.remediation === 'string') summary.remediation = parsed.remediation;
    return summary;
  } catch {
    return null;
  }
}

function writeCache(fs: UpdateCheckFs, path: string, summary: UpdateSummary): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(summary, null, 2));
  fs.renameSync(tmp, path);
}

/** Remove the cached summary, treating a missing or unremovable file as fine. */
function removeCache(fs: UpdateCheckFs, path: string): void {
  try {
    if (fs.existsSync(path)) fs.unlinkSync(path);
  } catch {
    /* an unremovable cache is not a failure */
  }
}

/** True when at least one probe actually reached its registry. A complete
 * failure (all `latest` null) must not overwrite the cache with "nothing". */
function collectionResolved(updates: CollectedUpdates): boolean {
  if (updates.junior.latest !== null) return true;
  if (updates.models.catalog === 'online') return true;
  return updates.managed.tools.some((tool) => tool.latest !== null);
}

function summarize(updates: CollectedUpdates, checkedAt: number): UpdateSummary {
  const outdated: string[] = [];
  if (updates.junior.outdated === true) outdated.push('junior');
  outdated.push(...updates.managed.outdated);
  outdated.push(...updates.companions);
  outdated.push(...updates.models.updates.map((update) => `model:${update.latest}`));
  const summary: UpdateSummary = { checkedAt, outdated };
  if (updates.remediation) summary.remediation = updates.remediation;
  return summary;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('update check timed out')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Return the cached update summary, refreshing it when it is older than 24
 * hours (or missing). Returns null when the refresh fails, so callers stay
 * silent offline; the previous cache is never overwritten.
 */
export async function cachedUpdateSummary(deps: UpdateCheckDeps = {}): Promise<UpdateSummary | null> {
  const env = deps.env ?? process.env;
  const fs = deps.fs ?? nodeFs;
  const now = deps.now ?? Date.now;
  const path = deps.cachePath ?? updateCheckCachePath(env, deps.home);
  const ttl = deps.ttlMs ?? UPDATE_CHECK_CACHE_TTL_MS;
  const budget = deps.budgetMs ?? deps.refreshTimeoutMs ?? UPDATE_CHECK_REFRESH_TIMEOUT_MS;

  const existing = readCache(fs, path);
  if (existing && now() - existing.checkedAt < ttl) return existing;

  const collect = deps.collect ?? ((collectDeps?: UpdateCheckDeps) => collectUpdates(collectDeps));
  try {
    const updates = await withTimeout(collect({ ...deps, budgetMs: budget }), budget);
    if (!collectionResolved(updates)) return null;
    const summary = summarize(updates, now());
    writeCache(fs, path, summary);
    return summary;
  } catch {
    return null;
  }
}

/**
 * Refresh the cached update summary after `junior update` has adopted newer
 * releases. The stale summary is removed first, so a failed fresh collection
 * (or a cache write error) can never keep reporting the components that were
 * just installed. Every error is swallowed: updating must never fail because
 * the cache could not be refreshed.
 */
export async function refreshUpdateCache(deps: UpdateCheckDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const fs = deps.fs ?? nodeFs;
  const now = deps.now ?? Date.now;
  const path = deps.cachePath ?? updateCheckCachePath(env, deps.home);
  const budget = deps.budgetMs ?? deps.refreshTimeoutMs ?? UPDATE_CHECK_REFRESH_TIMEOUT_MS;
  const collect = deps.collect ?? ((collectDeps?: UpdateCheckDeps) => collectUpdates(collectDeps));
  removeCache(fs, path);
  try {
    const updates = await withTimeout(collect({ ...deps, budgetMs: budget }), budget);
    if (!collectionResolved(updates)) return;
    writeCache(fs, path, summarize(updates, now()));
  } catch {
    /* the stale cache is already gone; stay silent offline */
  }
}

/** The one-line stderr notice for a count of outstanding updates. */
export function formatUpdateNotice(outdated: string[]): string {
  const n = outdated.length;
  return `junior: ${n} update${n === 1 ? '' : 's'} available (${outdated.join(', ')}); run \`junior update\``;
}

/**
 * Print at most one update line to stderr for the commands where it is useful.
 * Never throws and never changes the exit code; ineligible commands return
 * immediately without touching the cache.
 */
export async function startupNotice(command: string, deps: UpdateCheckDeps = {}): Promise<string | null> {
  try {
    if (!NOTICE_COMMANDS.has(command)) return null;
    if (command === 'doctor' && deps.checkUpdates) return null;
    if (updateCheckDisabled(deps.env ?? process.env)) return null;
    const summary = await cachedUpdateSummary(deps);
    if (!summary || summary.outdated.length === 0) return null;
    const line = formatUpdateNotice(summary.outdated);
    (deps.writeNotice ?? ((text: string) => process.stderr.write(`${text}\n`)))(line);
    return line;
  } catch {
    return null;
  }
}
