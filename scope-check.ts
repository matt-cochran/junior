// ---------------------------------------------------------------------------
// Scope checking for a run's changed files.
//
// `classifyScope` separates changes into files the run was allowed to touch
// (owned), incidental noise (lockfiles, snapshots) and genuine scope escapes.
// When no owned entry applies to the target repo, the result is explicitly
// unchecked: it reports nothing as out of scope without an owned list.
//
// Matching reuses `matchesAppliesTo` from adr.ts so scope globs, literal paths
// and `loc:` members behave exactly like architecture rules.
// ---------------------------------------------------------------------------

import type { GitFileChange } from './evidence.ts';
import { matchesAppliesTo } from './adr.ts';

/** Globs for files that may change without counting as a scope escape. */
export const DEFAULT_INCIDENTAL_GLOBS: readonly string[] = [
  'package-lock.json',
  '**/package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
  '**/Cargo.lock',
  '**/*.snap',
  '**/__snapshots__/**',
];

/** Classification of a run's changed files against an owned list. */
export type ScopeResult = {
  /** False when no owned entry applies to the target repo. */
  checked: boolean;
  /** Changed paths matched by an owned entry. */
  inScope: string[];
  /** Changed paths matched by an incidental glob. */
  incidental: string[];
  /** Changed paths matched by neither an owned entry nor an incidental glob. */
  outOfScope: string[];
};

/** Options controlling scope classification. */
type ScopeOptions = {
  /** Override the default incidental globs. */
  incidental?: readonly string[];
  /** Repo name used to resolve `<repo>:<path>` owned entries. */
  repo?: string;
};

function normalizePath(input: string): string {
  let path = input.replace(/^\.\//, '');
  while (path.startsWith('./')) path = path.slice(2);
  return path;
}

function isGlobChar(char: string): boolean {
  return char === '*' || char === '?' || char === '[';
}

function parseOwnedEntry(entry: string | { path: string }, repo: string | undefined): string | null {
  let raw: string;
  if (typeof entry === 'string') {
    raw = entry;
  } else if (typeof entry === 'object' && entry !== null && typeof entry.path === 'string') {
    raw = entry.path;
  } else {
    throw new TypeError('invalid owned entry: expected a non-empty path string or a { path } object');
  }
  if (raw.length === 0) {
    throw new TypeError('invalid owned entry: path must be a non-empty string');
  }

  if (!raw.startsWith('loc:')) {
    const colon = raw.indexOf(':');
    if (colon > 0) {
      const prefix = raw.slice(0, colon);
      if (!prefix.includes('/') && !prefix.includes('\\') && ![...prefix].some(isGlobChar)) {
        const path = raw.slice(colon + 1);
        if (path.length === 0) {
          throw new TypeError(`invalid owned entry "${raw}": missing path after repo prefix`);
        }
        // A repo-scoped entry is simply ignored for a different repo: the
        // caller may legitimately own files in more than one checkout.
        if (repo !== prefix) return null;
        return normalizePath(path);
      }
    }
  }
  return normalizePath(raw);
}

function validateIncidental(globs: readonly string[]): readonly string[] {
  if (!Array.isArray(globs)) {
    throw new TypeError('invalid incidental globs: expected an array of non-empty strings');
  }
  for (const glob of globs) {
    if (typeof glob !== 'string' || glob.length === 0) {
      throw new TypeError('invalid incidental globs: expected an array of non-empty strings');
    }
  }
  return globs;
}

/**
 * Classify changed files as in scope, incidental or out of scope.
 *
 * A `<repo>:<path>` owned entry only applies when `opts.repo` equals `<repo>`;
 * otherwise it is ignored. With no applicable owned entry the result is
 * `checked: false` and non-incidental changes are reported in neither scope
 * list. All three output arrays are sorted and de-duplicated.
 */
export function classifyScope(
  changes: readonly GitFileChange[],
  owned: ReadonlyArray<string | { path: string }>,
  opts: ScopeOptions = {},
): ScopeResult {
  if (!Array.isArray(changes)) {
    throw new TypeError('invalid changes: expected an array of GitFileChange objects');
  }
  if (!Array.isArray(owned)) {
    throw new TypeError('invalid owned list: expected an array of owned entries');
  }
  if (opts === null || typeof opts !== 'object') {
    throw new TypeError('invalid scope options: expected an object');
  }
  if (opts.repo !== undefined && typeof opts.repo !== 'string') {
    throw new TypeError('invalid scope options: repo must be a string');
  }
  const incidental = validateIncidental(opts.incidental ?? DEFAULT_INCIDENTAL_GLOBS);

  const ownedPaths: string[] = [];
  for (const entry of owned) {
    const path = parseOwnedEntry(entry, opts.repo);
    if (path !== null) ownedPaths.push(path);
  }
  const checked = ownedPaths.length > 0;

  const inScope = new Set<string>();
  const incidentalPaths = new Set<string>();
  const outOfScope = new Set<string>();

  for (const change of changes) {
    if (typeof change?.path !== 'string' || change.path.length === 0) {
      throw new TypeError('invalid change: path must be a non-empty string');
    }
    const path = normalizePath(change.path);
    if (path.length === 0) {
      throw new TypeError('invalid change: path must not be empty after normalisation');
    }
    if (ownedPaths.some((entry) => matchesAppliesTo(entry, path))) {
      inScope.add(path);
    } else if (incidental.some((glob) => matchesAppliesTo(glob, path))) {
      incidentalPaths.add(path);
    } else if (checked) {
      outOfScope.add(path);
    }
  }

  return {
    checked,
    inScope: [...inScope].sort(),
    incidental: [...incidentalPaths].sort(),
    outOfScope: [...outOfScope].sort(),
  };
}

/**
 * Read incidental globs from `config.scope.incidental`.
 *
 * Returns the configured non-empty string array, or the defaults when the
 * setting is absent. A present but malformed value is rejected rather than
 * silently replaced, so a typo cannot disable scope checks.
 */
export function incidentalGlobsFromConfig(config: unknown): string[] {
  const record = typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : null;
  const scope = record && typeof record.scope === 'object' && record.scope !== null
    ? (record.scope as Record<string, unknown>)
    : null;
  if (!scope || !Object.prototype.hasOwnProperty.call(scope, 'incidental')) {
    return [...DEFAULT_INCIDENTAL_GLOBS];
  }
  const value = scope.incidental;
  if (!Array.isArray(value) || value.some((glob) => typeof glob !== 'string' || glob.length === 0)) {
    throw new TypeError('invalid config: scope.incidental must be an array of non-empty strings');
  }
  return [...value];
}
