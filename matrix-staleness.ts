// ---------------------------------------------------------------------------
// Git-anchored link staleness.
//
// A confirmed feature-to-code link records the commit and git blob id it was
// observed against. `gitStaleness` compares those anchors with the checkout's
// HEAD using git metadata only: one `ls-tree` for the current blob ids and one
// rename-aware diff per linked commit that lost a path. It never re-reads or
// re-hashes the working tree, so an unstaged edit is still "current" until it
// is committed.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';

export interface GitAnchor {
  commit: string;
  blob: string;
}

export interface GitLink {
  feature: string;
  path: string;
  /** Commit the link was confirmed against; absent on pre-anchor links. */
  commit?: string;
  /** Git blob id of `path` at `commit`. */
  blob?: string;
  /**
   * Entity source file backing the feature member, when the store exposes it.
   * `entityBlob` is the git blob id recorded with the link; without it the link
   * commit is diffed for changes to `entityPath`.
   */
  entityPath?: string;
  entityBlob?: string;
  /** Alternate nested shape accepted for store adapters. */
  entity?: { path?: string; blob?: string };
}

export interface GitStaleEntry extends GitLink {
  /** Current git blob id, when the path still exists in HEAD. */
  currentBlob?: string;
  /** Rename source and destination for a `moved` entry. */
  from?: string;
  to?: string;
}

export interface GitStalenessResult {
  current: GitStaleEntry[];
  changed: GitStaleEntry[];
  moved: GitStaleEntry[];
  deleted: GitStaleEntry[];
  entityChanged: GitStaleEntry[];
  unanchored: GitStaleEntry[];
}

export interface GitStalenessOptions {
  dir: string;
  links: readonly GitLink[];
  /** Inject a git runner for tests; defaults to `spawnSync('git', ...)`. */
  runGit?: GitRunner;
}

export interface GitCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], dir: string) => GitCommandResult;

function runGitDefault(args: string[], dir: string): GitCommandResult {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function posixPath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * The commit and blob a path is currently anchored to. A path committed at
 * HEAD uses `HEAD:<path>`; an uncommitted path uses `git hash-object`.
 */
export function gitAnchor(options: { dir: string; path: string }): GitAnchor | null {
  const runGit = runGitDefault;
  const path = posixPath(options.path);
  const head = runGit(['rev-parse', 'HEAD'], options.dir);
  if (head.status !== 0) return null;
  const commit = head.stdout.trim();
  if (!commit) return null;

  const committed = runGit(['rev-parse', `HEAD:${path}`], options.dir);
  if (committed.status === 0) {
    const blob = committed.stdout.trim();
    if (blob) return { commit, blob };
  }
  const hashed = runGit(['hash-object', '--', path], options.dir);
  if (hashed.status !== 0) return null;
  const blob = hashed.stdout.trim();
  return blob ? { commit, blob } : null;
}

/** Parse `git ls-tree -r -z HEAD` into path -> blob id. */
function treeBlobs(runGit: GitRunner, dir: string): Map<string, string> | null {
  const listing = runGit(['ls-tree', '-r', '-z', 'HEAD'], dir);
  if (listing.status !== 0) return null;
  const blobs = new Map<string, string>();
  for (const record of listing.stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(' ');
    const blob = meta[2];
    const path = record.slice(tab + 1);
    if (blob && path) blobs.set(path, blob);
  }
  return blobs;
}

interface CommitChanges {
  renames: Map<string, string>;
  touched: Set<string>;
}

/** One rename-aware diff from `commit` to HEAD, shared by every link at that commit. */
function changesSince(runGit: GitRunner, dir: string, commit: string): CommitChanges {
  const changes: CommitChanges = { renames: new Map(), touched: new Set() };
  const diff = runGit(['diff', '-M', '--name-status', '--no-ext-diff', commit, 'HEAD'], dir);
  if (diff.status !== 0) return changes;
  for (const line of diff.stdout.split('\n')) {
    if (!line) continue;
    const fields = line.split('\t');
    const status = fields[0]?.[0] ?? '';
    if (status === 'R' || status === 'C') {
      const from = fields[1];
      const to = fields[2];
      if (from && to) {
        changes.renames.set(from, to);
        changes.touched.add(from);
        changes.touched.add(to);
      }
      continue;
    }
    const path = fields[1];
    if (!path) continue;
    changes.touched.add(path);
  }
  return changes;
}

function linkKey(link: GitLink): string {
  return `${link.feature}\u0000${link.path}`;
}

/**
 * Classify links against HEAD. Anchored links become `current`, `changed`,
 * `moved` or `deleted`; a missing anchor is `unanchored`, never `changed`.
 * A known entity source path whose git content changed since the link commit is
 * reported in `entityChanged`. Store queries do not always expose an entity
 * member's source path, so when they do not, entity staleness is limited to the
 * links that carry `entityPath` (or a recorded `entityBlob`).
 */
export function gitStaleness(options: GitStalenessOptions): GitStalenessResult {
  const runGit = options.runGit ?? runGitDefault;
  const result: GitStalenessResult = {
    current: [],
    changed: [],
    moved: [],
    deleted: [],
    entityChanged: [],
    unanchored: [],
  };
  if (options.links.length === 0) return result;

  const blobs = treeBlobs(runGit, options.dir);
  if (blobs === null) {
    // No HEAD yet: nothing can be compared, so every link is unanchored.
    result.unanchored.push(...options.links.map((link) => ({ ...link })));
    return result;
  }

  const commits = new Set<string>();
  for (const link of options.links) {
    if (!link.commit || !link.blob) continue;
    const entityPath = link.entityPath ?? link.entity?.path;
    const entityBlob = link.entityBlob ?? link.entity?.blob;
    if (!blobs.has(link.path) || (entityPath && !entityBlob)) commits.add(link.commit);
  }
  const changes = new Map<string, CommitChanges>();
  for (const commit of commits) changes.set(commit, changesSince(runGit, options.dir, commit));

  const seen = new Set<string>();
  for (const raw of options.links) {
    const link = { ...raw, path: posixPath(raw.path) };
    if (!link.commit || !link.blob) {
      result.unanchored.push(link);
      continue;
    }

    const currentBlob = blobs.get(link.path);
    if (currentBlob !== undefined) {
      if (currentBlob === link.blob) result.current.push(link);
      else result.changed.push({ ...link, currentBlob });
    } else {
      const diff = changes.get(link.commit);
      const to = diff?.renames.get(link.path);
      if (to !== undefined) result.moved.push({ ...link, from: link.path, to });
      else result.deleted.push(link);
    }

    const entityPath = link.entityPath ?? link.entity?.path;
    const entityBlobAtLink = link.entityBlob ?? link.entity?.blob;
    if (entityPath) {
      let entityChanged = false;
      if (entityBlobAtLink !== undefined) {
        const currentEntityBlob = blobs.get(entityPath);
        entityChanged = currentEntityBlob === undefined || currentEntityBlob !== entityBlobAtLink;
      } else {
        entityChanged = changes.get(link.commit)?.touched.has(entityPath) ?? false;
      }
      if (entityChanged) {
        const key = linkKey(link);
        if (!seen.has(key)) {
          seen.add(key);
          result.entityChanged.push(link);
        }
      }
    }
  }
  return result;
}
