// ---------------------------------------------------------------------------
// Complete, bounded change evidence for a checkout.
//
// Evidence is taken against HEAD (`git diff HEAD`), so it includes staged,
// unstaged, deleted and renamed tracked changes plus nonignored untracked
// files. Untracked files are read defensively: symlinks are never followed
// (their target is recorded, not read) and binary files are never decoded as
// text. All output is bounded and every bound is reported explicitly, so a
// truncated or unavailable diff can never be mistaken for a complete one.
// ---------------------------------------------------------------------------

import { lstatSync, readlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export type GitFileChange = {
 /** Repo-relative path (the new path for a rename). */
 path: string;
 /** Git name-status letter: M, A, D, R, C, T, or `??` for untracked. */
 status: string;
 /** Original path for a rename/copy. */
 oldPath?: string;
 untracked?: boolean;
 /** True when the file contained a NUL byte; content is never decoded. */
 binary?: boolean;
 /** True when the path is a symlink; it is never followed. */
 symlink?: boolean;
 /** The symlink target string, recorded without following it. */
 linkTarget?: string;
 /** Bounded text content for untracked text files. */
 content?: string;
 /** True when `content` is a prefix of a larger file. */
 contentTruncated?: boolean;
 /** Why content was omitted (symlink, binary, unreadable, directory...). */
 note?: string;
 /** Content fingerprint for a tracked/untracked existing file. Unlike the
  * coarse Git status letter, this changes when an already-modified tracked
  * file is edited again, so before/after deltas can detect run edits. */
 fingerprint?: string;
};

export type EvidenceLimits = {
 maxChars: number;
 statMaxChars: number;
 maxFiles: number;
 maxUntrackedBytes: number;
 diffTruncated: boolean;
 statTruncated: boolean;
 filesTruncated: boolean;
 /** Bytes of untracked text actually included. */
 untrackedBytes: number;
};

export type GitEvidence = {
 stat: string;
 diff: string;
 truncated: boolean;
 unavailable?: string;
 changedFiles: GitFileChange[];
 limits: EvidenceLimits;
 /** Resolved HEAD commit, or null when the repository has no commit. */
 head: string | null;
};

export const STAT_MAX_CHARS = 2000;
export const DEFAULT_MAX_FILES = 200;
export const DEFAULT_MAX_UNTRACKED_BYTES = 20000;
/** Upper bound for hashing a working-tree file into a change fingerprint. */
export const FINGERPRINT_MAX_BYTES = 4 * 1024 * 1024;

function limits(over: Partial<EvidenceLimits> = {}): EvidenceLimits {
 return { maxChars: 20000, statMaxChars: STAT_MAX_CHARS, maxFiles: DEFAULT_MAX_FILES,
  maxUntrackedBytes: DEFAULT_MAX_UNTRACKED_BYTES,
  diffTruncated: false, statTruncated: false, filesTruncated: false, untrackedBytes: 0, ...over };
}

/** Pure, testable bounding so diff evidence cannot grow without limit. */
export function boundEvidence(statText: string, diffText: string, maxChars = 20000, unavailable?: string): GitEvidence {
 const statFull = String(statText ?? '');
 const stat = statFull.slice(0, STAT_MAX_CHARS);
 const statTruncated = statFull.length > STAT_MAX_CHARS;
 let diff = String(diffText ?? '');
 let diffTruncated = false;
 if (diff.length > maxChars) { diff = diff.slice(0, maxChars); diffTruncated = true; }
 return {
  stat, diff, truncated: diffTruncated || statTruncated,
  ...(unavailable ? { unavailable } : {}),
  changedFiles: [],
  limits: limits({ maxChars, diffTruncated, statTruncated }),
  head: null,
 };
}

/** Parse `git diff --name-status -z` output (NUL-separated). */
function parseNameStatusZ(text: string): GitFileChange[] {
 const parts = String(text ?? '').split('\0');
 const out: GitFileChange[] = [];
 let i = 0;
 while (i < parts.length) {
  const st = parts[i++];
  if (!st) continue;
  const code = st[0];
  if (code === 'R' || code === 'C') {
   const oldPath = parts[i++];
   const path = parts[i++];
   if (path) out.push({ path, oldPath: oldPath || undefined, status: code });
  } else {
   const path = parts[i++];
   if (path) out.push({ path, status: code });
  }
 }
 return out;
}

function parseNullList(text: string): string[] {
 return String(text ?? '').split('\0').filter(Boolean);
}

/** Hash a working-tree path into a change fingerprint. Deleted, symlink,
 * special and unreadable paths get a stable marker; regular files are hashed
 * from their bounded bytes so a re-edit of an already-modified tracked file is
 * observable even though the Git name-status stays `M`. */
function fingerprintPath(cwd: string, rel: string, maxBytes = FINGERPRINT_MAX_BYTES): string {
 const abs = resolve(cwd, rel);
 let st;
 try { st = lstatSync(abs); } catch { return 'deleted'; }
 if (st.isSymbolicLink()) {
  let target = '';
  try { target = readlinkSync(abs); } catch { /* unreadable target */ }
  return `symlink:${target}`;
 }
 if (!st.isFile()) return st.isDirectory() ? 'directory' : 'special';
 try {
  const bounded = readBoundedBytes(abs, maxBytes);
  const h = createHash('sha1');
  h.update(bounded.buf);
  return `${st.size}:${bounded.truncated ? 't' : 'f'}:${h.digest('hex')}`;
 } catch { return 'unreadable'; }
}

function readBoundedBytes(abs: string, maxBytes: number): { buf: Buffer; truncated: boolean; size: number } {
 const st = lstatSync(abs);
 const size = st.size;
 const toRead = Math.max(0, Math.min(size, maxBytes));
 const buf = Buffer.alloc(toRead);
 const fd = openSync(abs, 'r');
 try {
  let read = 0;
  while (read < toRead) {
   const n = readSync(fd, buf, read, toRead - read, read);
   if (n <= 0) break;
   read += n;
  }
  return { buf: buf.subarray(0, read), truncated: size > toRead, size };
 } finally {
  closeSync(fd);
 }
}

/** Inspect one untracked path without ever following a symlink or decoding a
 * binary as text. Content is bounded by `maxBytes`. */
function inspectUntracked(cwd: string, rel: string, maxBytes: number): GitFileChange {
 const abs = resolve(cwd, rel);
 const relCheck = relative(cwd, abs);
 if (relCheck.startsWith('..') || isAbsolute(relCheck)) {
  return { path: rel, status: '??', untracked: true, note: 'outside checkout; not read' };
 }
 let st;
 try { st = lstatSync(abs); } catch { return { path: rel, status: '??', untracked: true, note: 'unreadable; not read' }; }
 if (st.isSymbolicLink()) {
  let target: string | undefined;
  try { target = readlinkSync(abs); } catch { /* unreadable link target */ }
  return { path: rel, status: '??', untracked: true, symlink: true, linkTarget: target, note: 'symlink not followed', fingerprint: `symlink:${target ?? ''}` };
 }
 if (!st.isFile()) {
  return { path: rel, status: '??', untracked: true, note: st.isDirectory() ? 'directory skipped' : 'not a regular file' };
 }
 let bounded: { buf: Buffer; truncated: boolean };
 try { bounded = readBoundedBytes(abs, maxBytes); } catch { return { path: rel, status: '??', untracked: true, note: 'unreadable; not read' }; }
 if (bounded.buf.includes(0)) {
  return { path: rel, status: '??', untracked: true, binary: true, note: 'binary file not read as text',
   fingerprint: fingerprintPath(cwd, rel) };
 }
 return { path: rel, status: '??', untracked: true,
  content: bounded.buf.toString('utf8'), ...(bounded.truncated ? { contentTruncated: true } : {}),
  fingerprint: fingerprintPath(cwd, rel) };
}

export type CollectOptions = { maxChars?: number; maxFiles?: number; maxUntrackedBytes?: number; timeoutMs?: number };

/** Collect complete bounded evidence for a checkout. Returns `unavailable`
 * when the directory is not a Git work tree or git fails. */
export function collectGitEvidence(cwd: string, opts: CollectOptions = {}): GitEvidence {
 const maxChars = opts.maxChars ?? 20000;
 const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
 const maxUntrackedBytes = opts.maxUntrackedBytes ?? DEFAULT_MAX_UNTRACKED_BYTES;
 const timeout = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : 30000;
 const run = (args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });

 const inside = run(['rev-parse', '--is-inside-work-tree']);
 if (inside.error || inside.status !== 0 || (inside.stdout || '').trim() !== 'true') {
  const ev = boundEvidence('', '', maxChars, inside.error?.message || 'not a git repository');
  ev.limits = { ...ev.limits, maxChars, maxFiles, maxUntrackedBytes };
  return ev;
 }
 const headRes = run(['rev-parse', 'HEAD']);
 const head = headRes.status === 0 ? (headRes.stdout || '').trim() : null;

 const statRes = run(['diff', 'HEAD', '--stat']);
 const diffRes = run(['diff', 'HEAD']);
 const nameRes = run(['diff', '--name-status', '-z', '-M', 'HEAD']);
 const untrackedRes = run(['ls-files', '--others', '--exclude-standard', '-z']);
 const gitError = statRes.error?.message || diffRes.error?.message || nameRes.error?.message || untrackedRes.error?.message;
 if (gitError || statRes.status !== 0 || diffRes.status !== 0 || nameRes.status !== 0 || untrackedRes.status !== 0) {
  const ev = boundEvidence(statRes.stdout || '', diffRes.stdout || '', maxChars, gitError || 'git diff unavailable');
  ev.limits = { ...ev.limits, maxChars, maxFiles, maxUntrackedBytes };
  return ev;
 }

 const tracked = parseNameStatusZ(nameRes.stdout || '').map((f) => ({ ...f, untracked: false, fingerprint: fingerprintPath(cwd, f.path) }));
 const untrackedPaths = parseNullList(untrackedRes.stdout || '');
 let untrackedBytes = 0;
 const untracked: GitFileChange[] = [];
 for (const p of untrackedPaths) {
  const remaining = maxUntrackedBytes - untrackedBytes;
  const f = inspectUntracked(cwd, p, Math.max(0, remaining));
  if (f.content) untrackedBytes += Buffer.byteLength(f.content, 'utf8');
  untracked.push(f);
 }
 const all = [...tracked, ...untracked];
 const filesTruncated = all.length > maxFiles;
 const changedFiles = filesTruncated ? all.slice(0, maxFiles) : all;

 // Append untracked text as clearly-labelled blocks. Symlinks and binaries are
 // never rendered; their metadata stays in `changedFiles`.
 const blocks: string[] = [];
 for (const f of untracked) {
  if (f.content === undefined) continue;
  blocks.push(`--- untracked: ${f.path}${f.contentTruncated ? ' (truncated)' : ''} ---\n${f.content}`);
 }
 const diffText = [diffRes.stdout || '', ...blocks].join('\n');
 const ev = boundEvidence(statRes.stdout || '', diffText, maxChars);
 ev.changedFiles = changedFiles;
 ev.limits = { ...ev.limits, maxChars, maxFiles, maxUntrackedBytes, filesTruncated, untrackedBytes };
 ev.head = head;
 return ev;
}

/** Backwards-compatible entry point: bounded evidence for a checkout. */
export function boundedGitEvidence(cwd: string, maxChars = 20000): GitEvidence {
 return collectGitEvidence(cwd, { maxChars });
}

export type EvidenceDelta = {
 before: GitEvidence;
 after: GitEvidence;
 /** Files changed or added by the run (preexisting work removed). */
 runChangedFiles: GitFileChange[];
 /** Files that were already changed before the run and are unchanged after. */
 preexistingFiles: GitFileChange[];
 changed: boolean;
};

function fileFingerprint(f: GitFileChange): string {
 // Prefer the content fingerprint when present: the Git status letter alone
 // cannot distinguish a tracked file that was already `M` before the run from
 // one the run edited again. Untracked text still falls back to `content`.
 return JSON.stringify([f.status, f.oldPath ?? '', !!f.binary, !!f.symlink, f.linkTarget ?? '',
  f.fingerprint ?? f.content ?? '']);
}

/** Distinguish run changes from preexisting work by comparing two snapshots. */
export function evidenceDelta(before: GitEvidence, after: GitEvidence): EvidenceDelta {
 const bmap = new Map(before.changedFiles.map((f) => [f.path, f]));
 const runChangedFiles: GitFileChange[] = [];
 const preexistingFiles: GitFileChange[] = [];
 for (const f of after.changedFiles) {
  const b = bmap.get(f.path);
  if (!b || fileFingerprint(b) !== fileFingerprint(f)) runChangedFiles.push(f);
  else preexistingFiles.push(f);
 }
 for (const f of before.changedFiles) {
  if (!after.changedFiles.some((a) => a.path === f.path)) {
   runChangedFiles.push({ path: f.path, status: f.untracked ? '??' : 'M', note: 'preexisting change no longer present after run' });
  }
 }
 return { before, after, runChangedFiles, preexistingFiles, changed: runChangedFiles.length > 0 };
}
