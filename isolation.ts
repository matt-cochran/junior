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

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, readdirSync, statSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { COMMAND_PLACEMENT_ERROR, decideCommand, type CommandPolicy } from './command-policy.ts';

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
 * duplicated. After writing, every requested pattern is verified with
 * `git check-ignore --no-index` (a directory pattern like `/.delivery/` is
 * checked as `.delivery/`); a pattern Git does not apply is reported in
 * `unapplied` with an error naming it and is never reported in `added`. Outside
 * a Git checkout there is nothing to do. This is a local exclusion only; it
 * never edits a tracked `.gitignore` or a user's rules. */
export function ensureLocalExcludes(cwd: string, patterns: string[]): { path: string | null; added: string[]; unapplied: string[]; error?: string } {
 // `--git-path info/exclude` resolves the shared common git dir for a linked
 // worktree (where `--git-dir` points at `.git/worktrees/<name>` and its own
 // `info/exclude` is never read by Git). A plain checkout resolves the same
 // `.git/info/exclude` as before.
 const gd = git(cwd, ['rev-parse', '--git-path', 'info/exclude']);
 if (gd.error) return { path: null, added: [], unapplied: [], error: gd.error.message };
 if (gd.status !== 0) return { path: null, added: [], unapplied: [] };
 const raw = (gd.stdout || '').trim();
 if (!raw) return { path: null, added: [], unapplied: [] };
 const excludePath = isAbsolute(raw) ? raw : resolve(cwd, raw);
 let existing = '';
 try { existing = readFileSync(excludePath, 'utf8'); } catch { /* an absent exclude file is the normal case */ }
 const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
 const wanted = patterns.filter((p) => p && !lines.has(p));
 if (wanted.length > 0) {
  const prefix = existing.length === 0 ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
  const header = lines.has(JUNIOR_EXCLUDE_HEADER) ? '' : `${JUNIOR_EXCLUDE_HEADER}\n`;
  try {
   mkdirSync(dirname(excludePath), { recursive: true });
   writeFileSync(excludePath, `${prefix}${header}${wanted.join('\n')}\n`);
  } catch (e: any) {
   return { path: excludePath, added: [], unapplied: [], error: e?.message || String(e) };
  }
 }
 // Verify every requested pattern's path against the rules Git actually reads.
 // A directory pattern keeps its trailing slash; only the leading slash is
 // dropped so `git check-ignore` sees a repo-relative path.
 const unapplied: string[] = [];
 const applied = new Set<string>();
 for (const p of patterns) {
  if (!p) continue;
  const r = git(cwd, ['check-ignore', '-q', '--no-index', p.replace(/^\//, '')]);
  if (r.status === 0) applied.add(p);
  else unapplied.push(p);
 }
 const added = wanted.filter((p) => applied.has(p));
 if (unapplied.length > 0) return { path: excludePath, added, unapplied, error: `Git does not apply these exclude patterns: ${unapplied.join(', ')}` };
 return { path: excludePath, added, unapplied };
}

// ---------------------------------------------------------------------------
// Opt-in isolation setup: links, copies and setup commands.
//
// `isolationSetup` lets a repo with gitignored dependencies (node_modules,
// virtualenvs, build caches) provision the detached worktree before any paid
// worker or independent check runs. It is ignored when `isolation` is `none`.
// ---------------------------------------------------------------------------

export type IsolationSetupLink = { from: string; to: string };
export type IsolationSetupCommand = { command: string; args?: string[]; cwd?: string };
export type IsolationSetup = {
 links?: IsolationSetupLink[];
 copy?: string[];
 commands?: IsolationSetupCommand[];
};

const SETUP_FIELDS = ['links', 'copy', 'commands'] as const;
const LINK_FIELDS = ['from', 'to'] as const;
const COMMAND_FIELDS = ['command', 'args', 'cwd'] as const;

/** A relative, non-empty path that does not escape its base via `..`. The base
 * is implicit here (source or worktree), so an absolute path or any `..`
 * segment is rejected before it can reach the filesystem. */
function relativeSetupPath(v: unknown): v is string {
 if (typeof v !== 'string' || !v.trim()) return false;
 if (isAbsolute(v)) return false;
 return !v.replace(/\\/g, '/').split('/').includes('..');
}

/** Validate the contract `isolationSetup` shape before any paid call. Throws
 * with an actionable message; malformed entries are never coerced. */
export function validateIsolationSetup(setup: unknown): void {
 if (setup === undefined || setup === null) return;
 if (typeof setup !== 'object' || Array.isArray(setup)) throw Error('Invalid isolationSetup (expected an object)');
 for (const k of Object.keys(setup as any)) if (!(SETUP_FIELDS as readonly string[]).includes(k)) throw Error(`Unknown isolationSetup field: ${k}`);
 const s = setup as IsolationSetup;
 if (s.links !== undefined) {
  if (!Array.isArray(s.links)) throw Error('Invalid isolationSetup.links (expected an array)');
  for (const l of s.links) {
   if (!l || typeof l !== 'object' || Array.isArray(l)) throw Error('Invalid isolationSetup.links entry (expected an object with "from" and "to" paths)');
   for (const k of Object.keys(l)) if (!(LINK_FIELDS as readonly string[]).includes(k)) throw Error(`Unknown isolationSetup.links field: ${k}`);
   if (!relativeSetupPath((l as any).from)) throw Error('Invalid isolationSetup.links.from (expected a relative path)');
   if (!relativeSetupPath((l as any).to)) throw Error('Invalid isolationSetup.links.to (expected a relative path)');
  }
 }
 if (s.copy !== undefined) {
  if (!Array.isArray(s.copy)) throw Error('Invalid isolationSetup.copy (expected an array)');
  for (const p of s.copy) if (!relativeSetupPath(p)) throw Error('Invalid isolationSetup.copy entry (expected a relative path string)');
 }
 if (s.commands !== undefined) {
  if (!Array.isArray(s.commands)) throw Error('Invalid isolationSetup.commands (expected an array)');
  for (const c of s.commands) {
   if (!c || typeof c !== 'object' || Array.isArray(c)) throw Error('Invalid isolationSetup.commands entry (expected an object with "command" and optional "args")');
   for (const k of Object.keys(c)) if (!(COMMAND_FIELDS as readonly string[]).includes(k)) throw Error(`Unknown isolationSetup.commands field: ${k}`);
   if (typeof (c as any).command !== 'string' || !(c as any).command.trim()) throw Error('Invalid isolationSetup.commands.command (expected a non-empty string)');
   if ((c as any).args !== undefined && (!Array.isArray((c as any).args) || (c as any).args.some((a: any) => typeof a !== 'string'))) throw Error('Invalid isolationSetup.commands.args (expected an array of strings)');
   if ((c as any).cwd !== undefined && !relativeSetupPath((c as any).cwd)) throw Error('Invalid isolationSetup.commands.cwd (expected a relative path)');
  }
 }
}

/** Read the project `isolationSetup` value from delivery.config.json. Returns
 * undefined when the file is absent, unreadable or carries no such key. The
 * contract field, when present, takes precedence over this. */
export function configuredIsolationSetup(cwd: string): unknown {
 try {
  const j = JSON.parse(readFileSync(join(cwd, 'delivery.config.json'), 'utf8'));
  return j?.isolationSetup;
 } catch { return undefined; }
}

export type IsolationSetupStep = { kind: 'link' | 'copy' | 'command'; target: string; ok: boolean; output?: string; error?: string };
export type IsolationSetupResult = { ok: boolean; error?: string; steps: IsolationSetupStep[]; logPath: string | null; excludePatterns: string[] };

/** True when `dest` is a symlink resolving to `expected` (an absolute path).
 * Used to make link/copy provisioning idempotent across a reused worktree. */
function linkResolvesTo(dest: string, expected: string): boolean {
 try {
  if (!lstatSync(dest).isSymbolicLink()) return false;
  return resolve(dirname(dest), readlinkSync(dest)) === resolve(expected);
 } catch { return false; }
}

/** True when a path exists, including a dangling symlink. */
function pathExists(p: string): boolean {
 try { lstatSync(p); return true; } catch { return false; }
}

/** Recursively copy a file, directory or symlink, preserving relative shape. */
function copyRecursive(src: string, dest: string): void {
 const st = lstatSync(src);
 if (st.isSymbolicLink()) {
  mkdirSync(dirname(dest), { recursive: true });
  try {
   symlinkSync(readlinkSync(src), dest);
  } catch (e: any) {
   // A reused worktree already holds the copied symlink: only an identical
   // target is satisfied; anything else is a real conflict.
   if (e?.code === 'EEXIST' && linkResolvesTo(dest, resolve(dirname(src), readlinkSync(src)))) return;
   throw e;
  }
 } else if (st.isDirectory()) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) copyRecursive(join(src, entry), join(dest, entry));
 } else {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
 }
}

/** Provision an isolated worktree from an `isolationSetup` spec. Every link is
 * a symlink at `<worktree>/<to>` pointing at `<source>/<from>`, every copy keeps
 * its relative path, and every command runs with argv (no shell) inside
 * `<worktree>/<cwd>` bounded by the remaining wall deadline and the per-tool
 * timeout. Output is written to `isolation-setup.log` in the artifact dir. The
 * returned `excludePatterns` are the linked/copied paths to add to the local
 * exclude before change evidence is collected. A failure stops at the first
 * failing step and is reported, never silently skipped. */
export function provisionIsolationSetup(
 setup: IsolationSetup,
 sourceCwd: string,
 worktreeCwd: string,
 artifactDir: string,
 opts: { deadlineAt: number; checkTimeoutMs: number; commandPolicy?: CommandPolicy | null },
): IsolationSetupResult {
 const steps: IsolationSetupStep[] = [];
 const lines: string[] = [];
 const excludePatterns: string[] = [];
 const logPath = artifactDir ? join(artifactDir, 'isolation-setup.log') : null;
 const finish = (error?: string): IsolationSetupResult => {
  if (logPath) { try { writeFileSync(logPath, `${lines.join('\n')}\n`); } catch { /* the log is best effort */ } }
  return { ok: !error, ...(error ? { error } : {}), steps, logPath, excludePatterns };
 };

 for (const link of setup.links ?? []) {
  const source = join(sourceCwd, link.from);
  const target = join(worktreeCwd, link.to);
  try {
   if (!existsSync(source)) throw Error(`source does not exist: ${source}`);
   mkdirSync(dirname(target), { recursive: true });
   if (pathExists(target)) {
    if (linkResolvesTo(target, source)) {
     excludePatterns.push(`/${link.to}`);
     steps.push({ kind: 'link', target: link.to, ok: true });
     lines.push(`link ${link.to} already present`);
     continue;
    }
    throw Error(`destination ${target} already exists and is not a symlink to ${source}`);
   }
   symlinkSync(source, target, statSync(source).isDirectory() ? 'dir' : 'file');
   excludePatterns.push(`/${link.to}`);
   steps.push({ kind: 'link', target: link.to, ok: true });
   lines.push(`link ${link.to} -> ${source}`);
  } catch (e: any) {
   const message = e?.message || String(e);
   steps.push({ kind: 'link', target: link.to, ok: false, error: message });
   lines.push(`link ${link.to} FAILED: ${message}`);
   return finish(`link ${link.to}: ${message}`);
  }
 }

 for (const rel of setup.copy ?? []) {
  const source = join(sourceCwd, rel);
  const target = join(worktreeCwd, rel);
  try {
   if (!existsSync(source)) throw Error(`source does not exist: ${source}`);
   copyRecursive(source, target);
   excludePatterns.push(`/${rel}`);
   steps.push({ kind: 'copy', target: rel, ok: true });
   lines.push(`copy ${rel} <- ${source}`);
  } catch (e: any) {
   const message = e?.message || String(e);
   steps.push({ kind: 'copy', target: rel, ok: false, error: message });
   lines.push(`copy ${rel} FAILED: ${message}`);
   return finish(`copy ${rel}: ${message}`);
  }
 }

 for (const cmd of setup.commands ?? []) {
  const decision = decideCommand(opts.commandPolicy ?? null, [cmd.command, ...(cmd.args ?? [])]);
  if (decision.decision === 'refuse') {
   const parts = [decision.reason ?? COMMAND_PLACEMENT_ERROR];
   if (decision.rule) parts.push(`rule: ${decision.rule.match.join(' ')}`);
   if (decision.wrapper) parts.push(`wrapper: ${decision.wrapper}`);
   const message = parts.join('; ');
   steps.push({ kind: 'command', target: cmd.command, ok: false, error: message });
   lines.push(`command ${cmd.command} REFUSED: ${message}`);
   return finish(`command ${cmd.command}: ${message}`);
  }
  const cwd = join(worktreeCwd, cmd.cwd ?? '.');
  const remaining = opts.deadlineAt - Date.now();
  if (remaining <= 0) {
   steps.push({ kind: 'command', target: cmd.command, ok: false, error: 'wall deadline exceeded before setup command' });
   lines.push(`command ${cmd.command} SKIPPED: wall deadline exceeded`);
   return finish('wall deadline exceeded before setup command');
  }
  const timeout = Math.max(1, Math.min(opts.checkTimeoutMs > 0 ? opts.checkTimeoutMs : remaining, remaining));
  const r = spawnSync(cmd.command, cmd.args ?? [], { cwd, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  if (output) lines.push(`command ${[cmd.command, ...(cmd.args ?? [])].join(' ')} output:\n${output}`);
  if (r.error) {
   steps.push({ kind: 'command', target: cmd.command, ok: false, error: r.error.message, output });
   lines.push(`command ${cmd.command} FAILED: ${r.error.message}`);
   return finish(`command ${cmd.command}: ${r.error.message}`);
  }
  if (r.status !== 0) {
   steps.push({ kind: 'command', target: cmd.command, ok: false, error: `exit ${r.status}`, output });
   lines.push(`command ${cmd.command} FAILED: exit ${r.status}`);
   return finish(`command ${cmd.command} exited ${r.status}`);
  }
  steps.push({ kind: 'command', target: cmd.command, ok: true, output });
  lines.push(`command ${cmd.command} ok`);
 }

 return finish();
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
