// Warm-start provisioning for worktree isolation (#278), lane W1.
//
// `isolationSetup.warmFrom` copies build caches (obj/, optionally bin/) from a
// pre-built tree into the fresh worktree before checks run, so a lane does not
// compile unchanged projects from cold. It copies, never symlinks: a lane's
// build must not write into the source tree's caches.

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

/** Validate `isolationSetup.warmFrom`; throws an actionable message. */
export function validateWarmFrom(_value: unknown): void {}

/** Copy caches into the worktree. Never throws. */
export function warmStart(_warmFrom: WarmFrom, _opts: { sourceCwd: string; worktree: string; deadlineAt: number; clock?: import('./clock.ts').Clock }): WarmStartResult {
  return { warm: false, method: null, files: 0, bytes: 0, durationMs: 0, dirs: [], reason: 'warm start not implemented' };
}
