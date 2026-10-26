// ---------------------------------------------------------------------------
// Apply a reviewed Junior handoff worktree diff to the source checkout.
//
// A handoff artifact records a detached Git worktree created at the source
// HEAD. This module rebuilds that worktree's full change set (tracked edits
// plus new untracked files) as a binary patch and applies it to the contract's
// recorded source checkout with a three-way merge. Safety comes first: a
// non-ready status, a foreign or moved worktree, or a worktree HEAD that is no
// longer an ancestor of the recorded source HEAD is refused, and a failed apply
// restores every touched file so that source working tree is left exactly as it
// was. No shell is ever used.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export type ApplyHandoffResult = {
 applied: boolean;
 dryRun: boolean;
 files: string[];
 artifactDir: string;
 /** The resolved source checkout the patch was checked against or applied to. */
 target?: string;
 conflicts?: string[];
 error?: string;
};

type Run = { status: number; stdout: string; stderr: string; error?: string };

/** Bounded Git subprocess runner using argv arrays (never a shell). */
function runGit(cwd: string, args: string[], input?: string): Run {
 const r = spawnSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 });
 return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message };
}

const message = (e: any): string => e?.message || String(e);

/** Resolve `target` to the artifact directory that holds `result.json`. A file
 * or directory path is used directly; anything else is a deliverable id
 * resolved under `<cwd>/.delivery/<id>/`, newest numeric timestamp first. */
function resolveArtifactDir(target: string, cwd: string): { dir?: string; error?: string } {
 const candidate = isAbsolute(target) ? target : resolve(cwd, target);
 try {
  const st = statSync(candidate);
  if (st.isFile()) return { dir: dirname(candidate) };
  if (st.isDirectory() && existsSync(join(candidate, 'result.json'))) return { dir: candidate };
 } catch { /* not a path; fall through to id resolution */ }
 const base = join(cwd, '.delivery', target);
 let entries: string[];
 try { entries = readdirSync(base); } catch { return { error: `handoff target not found: ${target}` }; }
 const stamps = entries.filter((e) => /^\d+$/.test(e) && existsSync(join(base, e, 'result.json'))).sort((a, b) => Number(b) - Number(a));
 if (stamps.length === 0) return { error: `no run with result.json for handoff: ${target}` };
 return { dir: join(base, stamps[0]) };
}

/** Names of files involved in a failed `git apply` from its diagnostic output. */
function conflictsFrom(output: string): string[] {
 const found = new Set<string>();
 for (const raw of output.split('\n')) {
  const line = raw.trim();
  let m: RegExpExecArray | null;
  if ((m = /^error: patch failed: (.+):\d+$/.exec(line))) found.add(m[1]);
  else if ((m = /^error: (.+?): (?:patch does not apply|does not match index|already exists|does not exist in (?:index|working tree))/.exec(line))) found.add(m[1]);
  else if ((m = /^Applied patch to '(.+)' with conflicts\.$/.exec(line))) found.add(m[1]);
 }
 return [...found];
}

const fail = (dryRun: boolean, artifactDir: string, files: string[], error: string, conflicts?: string[]): ApplyHandoffResult =>
 ({ applied: false, dryRun, files, artifactDir, ...(conflicts && conflicts.length ? { conflicts } : {}), error });

export type WorktreePatch = { patch?: string; files?: string[]; sha256?: string; error?: string };

/** Build the full change set of a worktree (tracked edits plus untracked files
 * made visible with `git add -A -N`) as a binary patch, and hash the exact
 * bytes. This is the single definition of "the patch apply would apply";
 * `pruneWorktrees` reuses it to recognize an applied-but-still-dirty worktree. */
export function buildWorktreePatch(worktree: string): WorktreePatch {
 const intent = runGit(worktree, ['add', '-A', '-N']);
 if (intent.error || intent.status !== 0) {
  return { error: `could not enumerate worktree changes: ${intent.error || intent.stderr.trim() || `git add exited ${intent.status}`}` };
 }
 const patch = runGit(worktree, ['diff', '--binary', 'HEAD']);
 if (patch.error || patch.status !== 0) {
  return { error: `could not build the handoff diff: ${patch.error || patch.stderr.trim() || `git diff exited ${patch.status}`}` };
 }
 const files = runGit(worktree, ['diff', '--name-only', 'HEAD']).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
 const sha256 = hashPatch(patch.stdout);
 return { patch: patch.stdout, files, sha256 };
}

/** SHA-256 of an already-built patch. Kept separate so callers can hash the
 * exact bytes they applied. */
export function hashPatch(patch: string): string {
 return createHash('sha256').update(patch).digest('hex');
}

/** Resolve the exact source checkout recorded by the contract. A run executed
 * from a linked worktree records that worktree as `sourceCwd`; applying against
 * the caller's primary checkout would check and write the wrong HEAD. Older
 * results without `sourceCwd` keep the caller's cwd for compatibility. */
function resolveSourceCwd(result: any, fallback: string): { dir?: string; error?: string } {
 const recorded = typeof result?.sourceCwd === 'string' && result.sourceCwd.trim() ? result.sourceCwd.trim() : null;
 if (!recorded) return { dir: fallback };
 const dir = resolve(fallback, recorded);
 try {
  if (!statSync(dir).isDirectory()) return { error: `recorded source worktree is not a directory: ${dir}` };
 } catch {
  return { error: `recorded source worktree is missing or no longer exists: ${dir}` };
 }
 return { dir };
}

/** Apply a reviewed handoff to the contract's recorded source checkout (or
 * `opts.cwd` for older results). Refuses on a non-ready status (unless `force`),
 * a non-worktree or missing worktree, or a worktree HEAD that is not an
 * ancestor of that source HEAD. `dryRun` only checks the patch. A failed
 * three-way merge restores every touched file and reports the conflicts;
 * nothing is committed or pushed. */
export function applyHandoff(target: string, opts: { cwd: string; dryRun?: boolean; force?: boolean }): ApplyHandoffResult {
 const callerCwd = resolve(opts.cwd);
 const dryRun = opts.dryRun === true;
 const resolved = resolveArtifactDir(target, callerCwd);
 if (!resolved.dir) return fail(dryRun, '', [], resolved.error!);
 const artifactDir = resolved.dir;

 let result: any;
 try { result = JSON.parse(readFileSync(join(artifactDir, 'result.json'), 'utf8')); }
 catch (e) { return fail(dryRun, artifactDir, [], `could not read ${join(artifactDir, 'result.json')}: ${message(e)}`); }

 const source = resolveSourceCwd(result, callerCwd);
 if (!source.dir) return fail(dryRun, artifactDir, [], source.error!);
 const cwd = source.dir;

 if (result?.status !== 'ready_for_review' && !opts.force) {
  return fail(dryRun, artifactDir, [], `handoff status is "${result?.status ?? 'unknown'}"; expected "ready_for_review" (pass force to override)`);
 }
 const iso = result?.isolation;
 if (iso?.mode !== 'worktree') return fail(dryRun, artifactDir, [], `handoff isolation mode is "${iso?.mode ?? 'none'}"; expected "worktree"`);
 const worktree = iso?.worktree;
 if (typeof worktree !== 'string' || !worktree || !existsSync(worktree)) {
  return fail(dryRun, artifactDir, [], `handoff worktree is missing or no longer exists: ${typeof worktree === 'string' ? worktree : 'unknown'}`);
 }

 const wtHead = runGit(worktree, ['rev-parse', 'HEAD']);
 const srcHead = runGit(cwd, ['rev-parse', 'HEAD']);
 if (wtHead.status !== 0 || srcHead.status !== 0) return fail(dryRun, artifactDir, [], 'could not resolve HEAD commits for the worktree or source checkout');
 const ancestor = runGit(cwd, ['merge-base', '--is-ancestor', wtHead.stdout.trim(), srcHead.stdout.trim()]);
 if (ancestor.status !== 0) return fail(dryRun, artifactDir, [], `worktree HEAD ${wtHead.stdout.trim()} is not an ancestor of source HEAD ${srcHead.stdout.trim()}`);

 // Stage intent-to-add for untracked files so `git diff HEAD` carries them.
 const built = buildWorktreePatch(worktree);
 if (built.error) return fail(dryRun, artifactDir, [], built.error);
 const { patch, files, sha256 } = built as { patch: string; files: string[]; sha256: string };

 if (dryRun) {
  const check = runGit(cwd, ['apply', '--check'], patch);
  if (check.error || check.status !== 0) {
   const conflicts = conflictsFrom(`${check.stdout}\n${check.stderr}`);
   return fail(true, artifactDir, files, `handoff does not apply cleanly: ${conflicts.length ? conflicts.join(', ') : check.stderr.trim() || check.error || 'git apply --check failed'}`, conflicts);
  }
  return { applied: false, dryRun: true, files, artifactDir, target: cwd };
 }

 // Preserve each touched working-tree file so a failed three-way merge can be
 // rolled back exactly, then clear any unmerged index entries it may leave.
 const backups = new Map<string, Buffer>();
 for (const f of files) {
  try { backups.set(f, readFileSync(join(cwd, f))); } catch { /* absent before apply */ }
 }
 const applied = runGit(cwd, ['apply', '-3'], patch);
 if (applied.error || applied.status !== 0) {
  for (const f of files) {
   const p = join(cwd, f);
   const before = backups.get(f);
   try { if (before) writeFileSync(p, before); else rmSync(p, { force: true }); } catch { /* best-effort restore */ }
  }
  if (files.length > 0) runGit(cwd, ['reset', '-q', '--', ...files]);
  const conflicts = conflictsFrom(`${applied.stdout}\n${applied.stderr}`);
  return fail(false, artifactDir, files, `handoff apply failed: ${conflicts.length ? conflicts.join(', ') : applied.stderr.trim() || applied.error || `git apply exited ${applied.status}`}`, conflicts);
 }
 // Record the applied patch so `junior prune` can recognize this worktree as
 // reviewed once its diff still hashes to the same bytes. Best effort: a write
 // failure never turns a successful apply into a reported failure.
 try {
  writeFileSync(join(artifactDir, 'applied.json'), JSON.stringify({ appliedAt: new Date().toISOString(), patchSha256: sha256, target: cwd, sourceCwd: cwd }, null, 2) + '\n');
 } catch { /* the applied record is best effort */ }
 return { applied: true, dryRun: false, files, artifactDir, target: cwd };
}
