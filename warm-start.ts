// Warm-start provisioning for worktree isolation (#278), lane W1.
//
// `isolationSetup.warmFrom` copies build caches (obj/, optionally bin/) from a
// pre-built tree into the fresh worktree before checks run, so a lane does not
// compile unchanged projects from cold. It copies, never symlinks: a lane's
// build must not write into the source tree's caches.

import {
  constants,
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { matchesAppliesTo } from './adr.ts';
import { systemClock, type Clock } from './clock.ts';

export interface WarmFrom {
  /** Pre-built tree to copy from: absolute, or relative to the source checkout. */
  path: string;
  /** Globs relative to `path` selecting cache directories. Default `["**\/obj/"]`. */
  include?: string[];
  /** Globs excluded from the copy. */
  exclude?: string[];
}

export interface WarmStartResult {
  warm: boolean;
  /** How files were copied; null when nothing was copied. */
  method: 'reflink' | 'copy' | null;
  files: number;
  bytes: number;
  durationMs: number;
  /** Directories copied, relative to the worktree. */
  dirs: string[];
  /** Why the run stayed cold (missing source, no matches, copy error). A warm-start failure never fails the run. */
  reason?: string;
}

const WARM_FROM_FIELDS = ['path', 'include', 'exclude'] as const;
const DEFAULT_INCLUDE = ['**/obj/'];
const SKIPPED_SEGMENTS = new Set(['.git', 'node_modules']);

/** A non-empty relative glob that cannot escape the warm-start source tree. */
function relativeGlob(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (value !== value.trim()) return false;
  const normalized = value.trim().replace(/\\/g, '/');
  if (isAbsolute(normalized) || win32.isAbsolute(normalized)) return false;
  return !normalized.split('/').includes('..');
}

/** Validate `isolationSetup.warmFrom`; throws an actionable message. */
export function validateWarmFrom(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Error('Invalid isolationSetup.warmFrom (expected an object with a "path")');
  }
  for (const key of Object.keys(value as object)) {
    if (!(WARM_FROM_FIELDS as readonly string[]).includes(key)) {
      throw Error(`Unknown warmFrom field: ${key}`);
    }
  }
  const warmFrom = value as WarmFrom;
  if (typeof warmFrom.path !== 'string' || !warmFrom.path.trim()) {
    throw Error('Invalid warmFrom.path (expected a non-empty string)');
  }
  for (const field of ['include', 'exclude'] as const) {
    const globs = warmFrom[field];
    if (globs === undefined) continue;
    if (!Array.isArray(globs)) throw Error(`Invalid warmFrom.${field} (expected an array of relative globs)`);
    for (const glob of globs) {
      if (!relativeGlob(glob)) throw Error(`Invalid warmFrom.${field} entry (expected a non-empty relative glob): ${String(glob)}`);
    }
  }
}

/** A directory path uses a trailing slash for glob matching; report it without. */
const directoryGlobPath = (path: string): string => `${path.replace(/\/+$/, '')}/`;
const reportedPath = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '');

function matchesDirectory(glob: string, path: string): boolean {
  const clean = reportedPath(path);
  return matchesAppliesTo(glob, directoryGlobPath(clean)) || matchesAppliesTo(glob, clean);
}

function matchesExcluded(globs: string[], path: string, isDirectory: boolean): boolean {
  const clean = reportedPath(path);
  return globs.some((glob) => (isDirectory
    ? matchesDirectory(glob, clean)
    : matchesAppliesTo(glob, clean)));
}

function isSkippedSegment(path: string): boolean {
  return path.replace(/\\/g, '/').split('/').some((segment) => SKIPPED_SEGMENTS.has(segment));
}

/** Select cache directories under `root` in deterministic order. A selected
 * directory is copied as a whole, so its descendants are not selected again. */
function discover(
  root: string,
  include: string[],
  exclude: string[],
  clock: Clock,
  deadlineAt: number,
): { dirs: string[]; timedOut: boolean; skipped: Array<{ path: string; error: string }> } {
  const dirs: string[] = [];
  const skipped: Array<{ path: string; error: string }> = [];
  let timedOut = false;
  const visit = (absolute: string, relativePath: string): void => {
    if (timedOut) return;
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (e: any) {
      skipped.push({ path: relativePath || '.', error: e?.message || String(e) });
      return;
    }
    for (const entry of entries) {
      if (clock.now() >= deadlineAt) {
        timedOut = true;
        return;
      }
      if (entry.isSymbolicLink() || SKIPPED_SEGMENTS.has(entry.name)) continue;
      const childPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (!entry.isDirectory()) continue;
      if (matchesExcluded(exclude, childPath, true)) continue;
      if (include.some((glob) => matchesDirectory(glob, childPath))) {
        dirs.push(childPath);
        continue;
      }
      visit(join(absolute, entry.name), childPath);
    }
  };
  visit(root, '');
  return { dirs, timedOut, skipped };
}

/** cpSync filter: never follow or recreate source symlinks, skip build-ignored
 * trees and anything the warmFrom exclude globs name. */
function copyFilter(
  root: string,
  exclude: string[],
  clock: Clock,
  deadlineAt: number,
  onDeadline: () => void,
) {
  return (source: string): boolean => {
    if (clock.now() >= deadlineAt) {
      onDeadline();
      return false;
    }
    let stat;
    try {
      stat = lstatSync(source);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) return false;
    const relativePath = relative(root, source).replace(/\\/g, '/');
    if (!relativePath) return true;
    if (isSkippedSegment(relativePath)) return false;
    return !matchesExcluded(exclude, relativePath, stat.isDirectory());
  };
}

/** The first regular file copied from a directory, used for the reflink probe. */
function firstRegularFile(dir: string, root: string, exclude: string[]): string | null {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return null;
  }
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    const relativePath = relative(root, absolute).replace(/\\/g, '/');
    if (entry.isSymbolicLink() || isSkippedSegment(relativePath)) continue;
    if (entry.isDirectory()) {
      if (matchesExcluded(exclude, relativePath, true)) continue;
      const nested = firstRegularFile(absolute, root, exclude);
      if (nested) return nested;
    } else if (entry.isFile() && !matchesExcluded(exclude, relativePath, false)) {
      return absolute;
    }
  }
  return null;
}

function countCopied(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const visit = (absolute: string): void => {
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(absolute, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(child);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += statSync(child).size;
        } catch { /* a file removed during copy is not counted */ }
      }
    }
  };
  visit(dir);
  return { files, bytes };
}

/** The first symlink on the target path, if any, or null when every existing
 * component is a real directory. `lstat` never follows a link, so a worktree
 * symlink can never redirect a copy into another tree. */
function symlinkedTarget(worktree: string, relativePath: string): string | null {
  let current = worktree;
  try {
    if (lstatSync(current).isSymbolicLink()) return current;
  } catch {
    return null;
  }
  for (const segment of relativePath.split('/')) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return current;
    } catch {
      return null;
    }
  }
  return null;
}

/** Probe reflink support on the first copied file. A failed probe falls back to
 * the ordinary FICLONE copy mode, which copies plainly where reflinks are unsupported. */
function probeReflink(source: string, target: string, copyFile: typeof copyFileSync): boolean {
  try {
    mkdirSync(join(target, '..'), { recursive: true });
    copyFile(source, target, constants.COPYFILE_FICLONE_FORCE);
    return true;
  } catch {
    return false;
  }
}

/** One warm start's copy phase: where to copy, and what it has copied so far. */
interface WarmCopy {
  root: string;
  worktree: string;
  exclude: string[];
  clock: Clock;
  deadlineAt: number;
  copyFile: typeof copyFileSync;
  result: WarmStartResult;
  problems: string[];
}

const errorText = (e: any): string => e?.message || String(e);

/** Resolve warmFrom.path to an existing directory, or say why it cannot be used. */
function resolveWarmRoot(warmFrom: WarmFrom, sourceCwd: string): { root: string } | { reason: string } {
  if (!warmFrom || typeof warmFrom.path !== 'string' || !warmFrom.path.trim()) {
    return { reason: 'warmFrom.path is empty' };
  }
  const root = isAbsolute(warmFrom.path) ? warmFrom.path : resolve(sourceCwd, warmFrom.path);
  if (!existsSync(root)) return { reason: `warmFrom path does not exist: ${root}` };
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch (e: any) {
    return { reason: `warmFrom path is unreadable: ${errorText(e)}` };
  }
  if (!rootStat.isDirectory()) return { reason: `warmFrom path is not a directory: ${root}` };
  return { root };
}

/** Select the cache directories to copy, or say why there are none. */
function selectCacheDirs(
  root: string,
  include: string[],
  exclude: string[],
  clock: Clock,
  deadlineAt: number,
): { dirs: string[]; problems: string[] } | { reason: string } {
  const discovered = discover(root, include, exclude, clock, deadlineAt);
  const problems = discovered.skipped.map((item) => `skipped unreadable directory ${item.path}: ${item.error}`);
  if (discovered.timedOut) {
    problems.push('wall deadline exceeded while selecting cache directories');
    return { reason: problems.join('; ') };
  }
  if (discovered.dirs.length === 0) {
    return { reason: problems.length > 0 ? problems.join('; ') : 'no cache directories matched warmFrom include' };
  }
  return { dirs: discovered.dirs, problems };
}

function addCopied(result: WarmStartResult, directory: string, copied: { files: number; bytes: number }): void {
  result.files += copied.files;
  result.bytes += copied.bytes;
  result.dirs.push(reportedPath(directory));
}

/** Decide the copy method once, by probing a reflink on the first file. */
function probeMethod(copy: WarmCopy, sourceDir: string): void {
  if (copy.result.method !== null) return;
  const first = firstRegularFile(sourceDir, copy.root, copy.exclude);
  if (!first) return;
  const probeTarget = join(copy.worktree, relative(copy.root, first));
  if (probeReflink(first, probeTarget, copy.copyFile)) copy.result.method = 'reflink';
}

/** Copy one cache directory. True when it copied cleanly; a failure is recorded
 * as a problem, keeping whatever files did land. */
function copyCacheDir(copy: WarmCopy, directory: string, filter: ReturnType<typeof copyFilter>): boolean {
  const sourceDir = join(copy.root, directory);
  const targetDir = join(copy.worktree, directory);
  try {
    probeMethod(copy, sourceDir);
    cpSync(sourceDir, targetDir, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter,
    });
    addCopied(copy.result, directory, countCopied(targetDir));
    if (copy.result.method === null) copy.result.method = 'copy';
    return true;
  } catch (e: any) {
    const copied = countCopied(targetDir);
    if (copied.files > 0) addCopied(copy.result, directory, copied);
    copy.problems.push(`could not copy ${reportedPath(directory)}: ${errorText(e)}`);
    return false;
  }
}

/** Copy each selected directory until done or past the deadline. True when
 * the deadline cut the copy short. */
function copyCacheDirs(copy: WarmCopy, dirs: string[]): boolean {
  let blockedByDeadline = false;
  const deadlinePassed = (): boolean => copy.clock.now() >= copy.deadlineAt;
  const filter = copyFilter(copy.root, copy.exclude, copy.clock, copy.deadlineAt, () => {
    blockedByDeadline = true;
  });
  for (const directory of dirs) {
    if (deadlinePassed()) return true;
    const linked = symlinkedTarget(copy.worktree, directory);
    if (linked) {
      copy.problems.push(`skipped directory ${reportedPath(directory)}: target ${linked} is a symlink`);
      continue;
    }
    if (copyCacheDir(copy, directory, filter) && deadlinePassed()) return true;
  }
  return blockedByDeadline;
}

/** Copy caches into the worktree. Never throws. */
export function warmStart(
  warmFrom: WarmFrom,
  opts: { sourceCwd: string; worktree: string; deadlineAt: number; clock?: Clock; copyFile?: typeof copyFileSync },
): WarmStartResult {
  const clock = opts.clock ?? systemClock;
  const startedAt = clock.now();
  const result: WarmStartResult = {
    warm: false,
    method: null,
    files: 0,
    bytes: 0,
    durationMs: 0,
    dirs: [],
  };
  const finish = (): WarmStartResult => {
    result.durationMs = Math.max(0, clock.now() - startedAt);
    return result;
  };
  const cold = (reason: string): WarmStartResult => {
    result.reason = reason;
    return finish();
  };

  try {
    const located = resolveWarmRoot(warmFrom, opts.sourceCwd);
    if ('reason' in located) return cold(located.reason);
    const { root } = located;
    const include = warmFrom.include ?? DEFAULT_INCLUDE;
    const exclude = warmFrom.exclude ?? [];
    if (clock.now() >= opts.deadlineAt) return cold('wall deadline exceeded before warm start');

    const selected = selectCacheDirs(root, include, exclude, clock, opts.deadlineAt);
    if ('reason' in selected) return cold(selected.reason);

    const copy: WarmCopy = {
      root,
      worktree: opts.worktree,
      exclude,
      clock,
      deadlineAt: opts.deadlineAt,
      copyFile: opts.copyFile ?? copyFileSync,
      result,
      problems: selected.problems,
    };
    const blockedByDeadline = copyCacheDirs(copy, selected.dirs);

    result.warm = result.files > 0;
    if (result.files === 0) result.method = null;
    if (blockedByDeadline) copy.problems.push('wall deadline exceeded while copying cache directories');
    if (copy.problems.length > 0) result.reason = copy.problems.join('; ');
    return finish();
  } catch (e: any) {
    return cold(`warm start failed: ${errorText(e)}`);
  }
}
