// Deterministic post-run wiring check (#186).
//
// A run can add an exported helper and a test for it without calling it from
// production. That passes the named checks but leaves the deliverable unwired.
// This module looks only at newly added export declarations and asks `git grep`
// for a word reference in a non-test file, so the answer is reproducible and
// does not depend on a model reading the diff.
//
// The check is advisory: an unavailable git checkout yields no entries rather
// than failing the run.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** One changed file; `addedLines` overrides what the diff says was added. */
export type WiringChange = { path: string; addedLines?: readonly string[] };

export type UnwiredSymbol = { symbol: string; file: string };

const EXPORT_DECLARATION = /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;

function isTestFile(path: string): boolean {
  return /\.test\.(?:ts|mjs|js)$/.test(path) || path.split('/').includes('test-fixtures');
}

/** Added lines per file from a unified diff. */
function addedLinesFromDiff(diff: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      file = raw === '/dev/null' ? null : raw.replace(/^b\//, '');
      continue;
    }
    if (file && line.startsWith('+')) out.set(file, [...(out.get(file) ?? []), line.slice(1)]);
  }
  return out;
}

function readLines(cwd: string, path: string): string[] {
  try {
    return readFileSync(join(cwd, path), 'utf8').split('\n');
  } catch {
    return [];
  }
}

/** Files (tracked or untracked, not ignored) that mention `symbol` as a word. */
function referencingFiles(cwd: string, symbol: string): string[] | null {
  const r = spawnSync('git', ['grep', '--untracked', '-l', '-w', '-F', '-e', symbol], { cwd, encoding: 'utf8' });
  if (r.error || (r.status !== 0 && r.status !== 1)) return null;
  return r.stdout.split('\n').filter(Boolean);
}

/**
 * List newly exported symbols with no reference outside their own declaration.
 *
 * Added lines come from each change's `addedLines`, else from `diff`, else (a
 * new untracked file absent from the diff) the whole file. Test files are never
 * candidates and never count as references.
 */
export function findUnwiredExports(cwd: string, changes: readonly WiringChange[] = [], opts: { diff?: string } = {}): UnwiredSymbol[] {
  const fromDiff = addedLinesFromDiff(opts.diff ?? '');
  const out: UnwiredSymbol[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    const file = change.path;
    if (!file || isTestFile(file)) continue;
    const added = change.addedLines ?? fromDiff.get(file) ?? readLines(cwd, file);
    for (const line of added) {
      const symbol = line.match(EXPORT_DECLARATION)?.[1];
      if (!symbol || seen.has(`${file}\0${symbol}`)) continue;
      seen.add(`${file}\0${symbol}`);
      const files = referencingFiles(cwd, symbol);
      if (files === null) return [];
      const own = readLines(cwd, file);
      const ownText = (own.length > 0 ? own : added).join('\n');
      const word = new RegExp(`(?<![\\w$])${symbol.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
      // A non-test file elsewhere, or a second mention (a call) in its own file, wires it.
      const wired = files.some((other) => other !== file && !isTestFile(other)) || (ownText.match(word)?.length ?? 0) > 1;
      if (!wired) out.push({ symbol, file });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol));
}
