// ---------------------------------------------------------------------------
// Opt-in Git worktree isolation and advisory run locks.
//
// `isolation: "worktree"` creates a unique detached worktree at the source
// HEAD and refuses to start when the source checkout is dirty, so uncommitted
// work is never silently omitted. Worktrees are retained for review and are
// never merged, removed or committed by this worker.
//
// Locks are advisory files under the source `.delivery/locks/`. A lock is
// created atomically and only the holder releases it; a foreign or stale lock
// is reported with an actionable diagnostic and never auto-deleted.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export type IsolationMode = 'none' | 'worktree';

/** Read the task's isolation mode. Invalid values are reported, not coerced. */
export function resolveIsolation(t: any): { mode: IsolationMode; error?: string } {
 const v = t?.isolation;
 if (v === undefined || v === null || v === 'none') return { mode: 'none' };
 if (v === 'worktree') return { mode: 'worktree' };
 return { mode: 'none', error: 'Invalid isolation (expected "none" or "worktree")' };
}

function git(cwd: string, args: string[], timeoutMs = 60000) {
 return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 1, maxBuffer: 8 * 1024 * 1024 });
}

/** Bounded Git subprocess runner shared by the retention/quarantine helpers. */
export function runGit(cwd: string, args: string[], timeoutMs = 60000) {
 return git(cwd, args, timeoutMs);
}

/** Report whether a checkout has any staged, unstaged or nonignored untracked
 * changes. A git failure is surfaced separately rather than treated as clean. */
export function sourceDirty(cwd: string, timeoutMs?: number): { dirty: boolean; status?: string; error?: string } {
 const r = git(cwd, ['status', '--porcelain', '--untracked-files=normal'], timeoutMs);
 if (r.error) return { dirty: false, error: r.error.message };
 if (r.status !== 0) return { dirty: false, error: (r.stderr || `git status exited ${r.status}`).trim() };
 const out = (r.stdout || '').trim();
 return { dirty: out.length > 0, status: out };
}

/** Resolve the source HEAD commit, or null when there is no commit yet. */
export function headOf(cwd: string): string | null {
 const r = git(cwd, ['rev-parse', 'HEAD']);
 return r.status === 0 ? (r.stdout || '').trim() : null;
}

/** Create a unique detached worktree at the source HEAD. */
export function createDetachedWorktree(sourceCwd: string, dest: string, timeoutMs?: number): { ok: boolean; error?: string } {
 try { mkdirSync(dirname(dest), { recursive: true }); } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
 const r = git(sourceCwd, ['worktree', 'add', '--detach', dest, 'HEAD'], timeoutMs);
 if (r.error) return { ok: false, error: r.error.message };
 if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || `git worktree add exited ${r.status}`).trim() };
 return { ok: true };
}

/** Header written before the exact Junior-generated local exclude patterns. */
export const JUNIOR_EXCLUDE_HEADER = '# junior-generated (local, not committed)';

/** Append exact Junior-owned paths to the repository-local `.git/info/exclude`.
 * Existing content is preserved verbatim and already-present patterns are not
 * duplicated. Outside a Git checkout there is nothing to do. This is a local
 * exclusion only; it never edits a tracked `.gitignore` or a user's rules. */
export function ensureLocalExcludes(cwd: string, patterns: string[]): { path: string | null; added: string[]; error?: string } {
 const gd = git(cwd, ['rev-parse', '--git-dir']);
 if (gd.error) return { path: null, added: [], error: gd.error.message };
 if (gd.status !== 0) return { path: null, added: [] };
 const raw = (gd.stdout || '').trim();
 if (!raw) return { path: null, added: [] };
 const gitDir = isAbsolute(raw) ? raw : resolve(cwd, raw);
 const excludePath = join(gitDir, 'info', 'exclude');
 let existing = '';
 try { existing = readFileSync(excludePath, 'utf8'); } catch { /* an absent exclude file is the normal case */ }
 const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
 const wanted = patterns.filter((p) => p && !lines.has(p));
 if (wanted.length === 0) return { path: excludePath, added: [] };
 const prefix = existing.length === 0 ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
 const header = lines.has(JUNIOR_EXCLUDE_HEADER) ? '' : `${JUNIOR_EXCLUDE_HEADER}\n`;
 try {
  mkdirSync(dirname(excludePath), { recursive: true });
  writeFileSync(excludePath, `${prefix}${header}${wanted.join('\n')}\n`);
 } catch (e: any) {
  return { path: excludePath, added: [], error: e?.message || String(e) };
 }
 return { path: excludePath, added: wanted };
}

/** Remove a registered linked worktree and deregister it. Uses no `--force`, so
 * Git still refuses to discard modified or untracked files. */
export function removeRegisteredWorktree(sourceCwd: string, path: string, timeoutMs?: number): { ok: boolean; error?: string } {
 const r = git(sourceCwd, ['worktree', 'remove', path], timeoutMs);
 if (r.error) return { ok: false, error: r.error.message };
 if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || `git worktree remove exited ${r.status}`).trim() };
 git(sourceCwd, ['worktree', 'prune'], timeoutMs);
 return { ok: true };
}

/** True when `path` is a live linked worktree registered to `sourceCwd`. */
export function isWorktreeOf(sourceCwd: string, path: string, timeoutMs?: number): boolean {
 if (!existsSync(path)) return false;
 const inside = git(path, ['rev-parse', '--is-inside-work-tree'], timeoutMs);
 if (inside.status !== 0 || (inside.stdout || '').trim() !== 'true') return false;
 const list = git(sourceCwd, ['worktree', 'list', '--porcelain'], timeoutMs);
 if (list.status !== 0) return false;
 return (list.stdout || '').split('\n').some((line) => {
  if (!line.startsWith('worktree ')) return false;
  try { return resolve(line.slice('worktree '.length).trim()) === resolve(path); } catch { return false; }
 });
}

export type LockHandle = { path: string; key: string; release: () => void };

/** Deterministic lock file path for a key. */
export function lockPathFor(lockDir: string, key: string): string {
 const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
 return join(lockDir, `${hash}.lock`);
}

/** Atomically acquire a lock. A held lock is reported with its holder and a
 * manual removal hint; it is never auto-deleted. */
export function acquireLock(lockDir: string, key: string, info: Record<string, unknown> = {}): { handle?: LockHandle; error?: string; lockPath: string } {
 const lockPath = lockPathFor(lockDir, key);
 try { mkdirSync(lockDir, { recursive: true }); } catch (e: any) { return { error: `could not create lock directory ${lockDir}: ${e?.message || e}`, lockPath }; }
 const payload = JSON.stringify({ key, pid: process.pid, startedAt: new Date().toISOString(), ...info }, null, 2) + '\n';
 try {
  writeFileSync(lockPath, payload, { flag: 'wx' });
 } catch (e: any) {
  if (e?.code === 'EEXIST') {
   let existing = '';
   try { existing = readFileSync(lockPath, 'utf8').trim(); } catch { /* unreadable lock is still a held lock */ }
   return { error: `lock already held: ${lockPath}${existing ? `\nholder: ${existing}` : ''}\nIf that run is no longer active, inspect and remove it manually: rm ${lockPath}`, lockPath };
  }
  return { error: `could not create lock ${lockPath}: ${e?.message || e}`, lockPath };
 }
 let released = false;
 const handle: LockHandle = { path: lockPath, key, release: () => {
  if (released) return;
  released = true;
  try { rmSync(lockPath, { force: true }); } catch { /* best effort; a leftover lock is reported next run */ }
 } };
 return { handle, lockPath };
}
