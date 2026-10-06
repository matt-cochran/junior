// ---------------------------------------------------------------------------
// Retained-worktree retention: inventory, disk usage and safe pruning.
//
// A `worktree` run creates a linked Git worktree under
// `.delivery/<id>/<timestamp>/worktree` and retains it for review; logs and
// results live beside it in the artifact directory. This module discovers
// those Junior-owned worktrees, reports their footprint for `doctor`, and
// removes only inactive, clean, registered ones.
//
// Safety is the point: the source checkout and any foreign worktree are never
// touched, dirty or unreviewed worktrees are preserved, an active advisory lock
// blocks removal, symlinked or escaping paths are skipped, and removal never
// passes `--force`. Removing a worktree leaves its logs/results artifacts in
// place.
// ---------------------------------------------------------------------------

import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { acquireLock, removeRegisteredWorktree, runGit, sourceDirty } from './isolation.ts';

/** Parse a bounded `--older-than` duration such as `30m`, `24h` or `7d`. */
export function parseDuration(text: string): number | null {
 const match = /^(\d+)(s|m|h|d)$/.exec(String(text ?? '').trim());
 if (!match) return null;
 const value = Number(match[1]);
 const unit = match[2];
 const multiplier = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
 const ms = value * multiplier;
 return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Classify a path as a Junior run worktree: exactly
 * `<source>/.delivery/<id>/<numeric stamp>/worktree`, with no `..` escape. */
export function juniorWorktreeMeta(sourceCwd: string, candidate: string): { id: string; stamp: string } | null {
 const root = resolve(sourceCwd, '.delivery');
 const rel = relative(root, resolve(candidate));
 if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
 const parts = rel.split(sep);
 if (parts.length !== 3) return null;
 const [id, stamp, leaf] = parts;
 if (leaf !== 'worktree') return null;
 if (!id || id === '.' || id === '..') return null;
 if (!/^\d+$/.test(stamp)) return null;
 return { id, stamp };
}

export type JuniorWorktree = {
 path: string;
 artifactDir: string;
 id: string;
 stamp: string;
 ageMs: number;
};

/** Registered worktrees that match the Junior run layout, newest stamp first is
 * left to the caller; this returns Git's registration order. */
export function listJuniorWorktrees(sourceCwd: string, now: number = Date.now()): JuniorWorktree[] {
 const r = runGit(sourceCwd, ['worktree', 'list', '--porcelain']);
 if (r.status !== 0) return [];
 const found: JuniorWorktree[] = [];
 for (const line of (r.stdout || '').split('\n')) {
  if (!line.startsWith('worktree ')) continue;
  const raw = line.slice('worktree '.length).trim();
  if (!raw) continue;
  const meta = juniorWorktreeMeta(sourceCwd, raw);
  if (!meta) continue;
  const path = resolve(raw);
  const stampMs = Number(meta.stamp);
  found.push({ path, artifactDir: dirname(path), id: meta.id, stamp: meta.stamp, ageMs: Math.max(0, now - stampMs) });
 }
 return found;
}

/** Bounded recursive directory usage. Symlinked roots and entries are never
 * followed, so a traversal cannot escape through a link. `truncated` reports
 * honestly when an entry/time limit stopped the walk before completion. */
export function directoryUsage(root: string, limits: { maxEntries?: number; maxMs?: number } = {}): { bytes: number; truncated: boolean } {
 const maxEntries = limits.maxEntries ?? 50_000;
 const maxMs = limits.maxMs ?? 2_000;
 const started = Date.now();
 let bytes = 0;
 let entries = 0;
 let truncated = false;
 let rootStat;
 try { rootStat = lstatSync(root); } catch { return { bytes: 0, truncated: false }; }
 if (rootStat.isSymbolicLink()) return { bytes: 0, truncated: false };
 const stack = [root];
 while (stack.length) {
  if (entries >= maxEntries || Date.now() - started > maxMs) { truncated = true; break; }
  const dir = stack.pop()!;
  let items;
  try { items = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
  for (const item of items) {
   if (entries >= maxEntries || Date.now() - started > maxMs) { truncated = true; break; }
   entries += 1;
   const full = join(dir, item.name);
   if (item.isSymbolicLink()) continue;
   if (item.isDirectory()) { stack.push(full); continue; }
   if (item.isFile()) { try { bytes += statSync(full).size; } catch { /* raced removal */ } }
  }
  if (truncated) break;
 }
 return { bytes, truncated };
}

/** Bounded recursive directory size in bytes. Symlinks are never followed. */
export function directoryBytes(root: string, limits: { maxEntries?: number; maxMs?: number } = {}): number {
 return directoryUsage(root, limits).bytes;
}

export type RetentionSummary = { count: number; bytes: number; path: string | null; note: string; truncated: boolean };

function formatBytes(bytes: number): string {
 if (bytes < 1024) return `${bytes} B`;
 if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
 if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
 return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

/** Read-only retained-worktree count and disk usage for `doctor`. Only
 * worktrees whose real path stays inside `.delivery/` are measured, so a
 * symlinked root or parent outside the source delivery is never traversed. */
export function retainedWorktreeSummary(sourceCwd: string): RetentionSummary {
 const entries = listJuniorWorktrees(sourceCwd);
 const deliveryRoot = resolve(sourceCwd, '.delivery');
 let deliveryReal: string | null = null;
 try {
  deliveryReal = realpathSync(deliveryRoot);
  if (deliveryReal !== deliveryRoot) return { count: 0, bytes: 0, truncated: false, path: null, note: 'Retained worktree usage unavailable: symlinked delivery directory.' };
 } catch { deliveryReal = null; }
 let bytes = 0;
 let truncated = false;
 let count = 0;
 for (const entry of entries) {
  if (deliveryReal) {
   let real: string;
   try { real = realpathSync(entry.path); } catch { continue; }
   const rel = relative(deliveryReal, real);
   if (rel.startsWith('..') || isAbsolute(rel)) continue;
  }
  const usage = directoryUsage(entry.path);
  bytes += usage.bytes;
  truncated = truncated || usage.truncated;
  count += 1;
 }
 return {
  count,
  bytes,
  truncated,
  path: count ? join(resolve(sourceCwd), '.delivery') : null,
  note: count === 0
   ? 'No retained worktrees.'
   : `${count} retained worktree(s) using ${truncated ? 'at least ' : ''}${formatBytes(bytes)}${truncated ? ' (measurement truncated)' : ''}; review and remove clean inactive ones with \`junior prune\`.`,
 };
}

export type PruneOptions = { olderThanMs?: number; keepLast?: number; dryRun?: boolean; now?: number };
export type PruneResult = {
 ok: boolean;
 dryRun: boolean;
 sourceCwd: string;
 removed: string[];
 skipped: Array<{ path: string; reason: string }>;
 retained: string[];
};

/** True when `commit` is reachable from a retained source branch, tag, remote
 * ref, or the source HEAD. A detached worktree commit the source never saw is
 * unreviewed and must not be silently discarded. */
export function isCommitReachableFromSource(sourceCwd: string, commit: string, timeoutMs?: number): { reachable: boolean; error?: string } {
 if (!commit) return { reachable: false, error: 'worktree HEAD is missing' };
 const refs = runGit(sourceCwd, ['for-each-ref', '--contains', commit, '--format=%(refname)', 'refs/heads', 'refs/tags', 'refs/remotes'], timeoutMs);
 if (refs.error) return { reachable: false, error: refs.error.message };
 if (refs.status !== 0) return { reachable: false, error: (refs.stderr || `git for-each-ref exited ${refs.status}`).trim() };
 if ((refs.stdout || '').trim()) return { reachable: true };
 const head = runGit(sourceCwd, ['merge-base', '--is-ancestor', commit, 'HEAD'], timeoutMs);
 if (head.error) return { reachable: false, error: head.error.message };
 if (head.status === 0) return { reachable: true };
 if (head.status === 1) return { reachable: false };
 return { reachable: false, error: (head.stderr || `git merge-base exited ${head.status}`).trim() };
}

/** Remove only inactive, clean, registered Junior worktrees whose commits are
 * reachable from a retained source ref. Everything else is reported as skipped
 * or retained; removal is never forced. Each candidate is inspected and
 * removed while holding the same checkout lock an execution would acquire, so
 * a live run and a prune can never race; the lock is released in `finally` and
 * an existing active lock is never removed. */
export function pruneWorktrees(sourceCwd: string, options: PruneOptions = {}): PruneResult {
 const now = options.now ?? Date.now();
 const deliveryRoot = resolve(sourceCwd, '.delivery');
 const lockDir = join(deliveryRoot, 'locks');
 const entries = listJuniorWorktrees(sourceCwd, now);
 const sorted = [...entries].sort((a, b) => Number(b.stamp) - Number(a.stamp));
 const keepLast = options.keepLast === undefined ? 0 : Math.max(0, Math.floor(options.keepLast));
 const keep = new Set(sorted.slice(0, keepLast).map((e) => e.path));
 const removed: string[] = [];
 const skipped: Array<{ path: string; reason: string }> = [];
 const retained: string[] = [];

 for (const entry of sorted) {
  if (keep.has(entry.path)) { retained.push(entry.path); continue; }
  if (options.olderThanMs !== undefined && entry.ageMs < options.olderThanMs) { retained.push(entry.path); continue; }

  const lock = acquireLock(lockDir, `checkout:${entry.path}`, { id: entry.id, stamp: entry.stamp, prune: true });
  if (lock.error) { skipped.push({ path: entry.path, reason: 'active lock' }); continue; }
  try {
   let stat;
   try { stat = lstatSync(entry.path); } catch { stat = null; }
   if (stat && stat.isSymbolicLink()) { skipped.push({ path: entry.path, reason: 'symlink worktree path' }); continue; }
   try {
    const real = realpathSync(entry.path);
    const rel = relative(deliveryRoot, real);
    if (rel.startsWith('..') || isAbsolute(rel)) { skipped.push({ path: entry.path, reason: 'path escapes the delivery directory' }); continue; }
   } catch {
    skipped.push({ path: entry.path, reason: 'unresolvable worktree path' });
    continue;
   }

   const dirty = sourceDirty(entry.path);
   if (dirty.error) { skipped.push({ path: entry.path, reason: `git status failed: ${dirty.error}` }); continue; }
   if (dirty.dirty) { skipped.push({ path: entry.path, reason: 'unreviewed changes' }); continue; }

   const head = runGit(entry.path, ['rev-parse', 'HEAD']);
   if (head.error) { skipped.push({ path: entry.path, reason: `git rev-parse failed: ${head.error.message}` }); continue; }
   if (head.status !== 0) { skipped.push({ path: entry.path, reason: 'cannot verify worktree HEAD' }); continue; }
   const commit = (head.stdout || '').trim();
   if (head.status === 0 && commit) {
    const reachable = isCommitReachableFromSource(sourceCwd, commit);
    if (reachable.error) { skipped.push({ path: entry.path, reason: `cannot verify commit reachability: ${reachable.error}` }); continue; }
    if (!reachable.reachable) { skipped.push({ path: entry.path, reason: 'unreviewed commit not reachable from a source ref' }); continue; }
   }

   if (options.dryRun) { removed.push(entry.path); continue; }

   const result = removeRegisteredWorktree(sourceCwd, entry.path);
   if (!result.ok) { skipped.push({ path: entry.path, reason: result.error || 'git worktree remove failed' }); continue; }
   removed.push(entry.path);
  } finally {
   lock.handle?.release();
  }
 }

 return { ok: true, dryRun: !!options.dryRun, sourceCwd, removed, skipped, retained };
}
