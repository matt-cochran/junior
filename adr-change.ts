// ---------------------------------------------------------------------------
// Whole-change judging input for the ADR conformance gate (#276, #279).
//
// The per-file gate can miss decisions that only become visible across files:
// one tool importing another tool's module, a shared hook used by several
// micro-apps, or an OpenAPI schema that $refs another tool's spec. This module
// builds one gate subject from the unified diff plus a static relationship
// graph, so each retrieved ADR is judged once over the whole change.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, sep } from 'node:path';
import { runSync } from './spawn-sync.ts';
import type { GateSubject } from './adr-gate.ts';

/** The whole-change diff is bounded to this many characters, whole hunks first. */
export const WHOLE_CHANGE_TEXT_LIMIT = 60_000;

const GIT_DIFF_MAX_BUFFER = 32 * 1024 * 1024;
const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SPEC_EXTENSIONS = new Set(['.json', '.yaml', '.yml']);
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];

export interface WholeChangeGit {
  (args: string[]): {status: number; stdout: string};
}

export interface WholeChangeOptions {
  root: string;
  base: string;
  head?: string;
  /** Test seam: the git runner; defaults to the sandbox-safe synchronous runner. */
  git?: WholeChangeGit;
}

function posix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function relativePath(root: string, path: string): string {
  return posix(relative(root, path));
}

function runGit(opts: WholeChangeOptions, args: string[]): {status: number; stdout: string} {
  if (opts.git) return opts.git(args);
  const result = runSync('git', args, {cwd: opts.root, maxBuffer: GIT_DIFF_MAX_BUFFER});
  return {status: typeof result.status === 'number' ? result.status : 1, stdout: result.stdout};
}

function gitOrThrow(opts: WholeChangeOptions, args: string[]): string {
  const result = runGit(opts, args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed with status ${result.status}`);
  }
  return result.stdout;
}

function porcelainPaths(stdout: string): {changed: string[]; untracked: string[]} {
  const changed: string[] = [];
  const untracked: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let path = line.slice(3).trim();
    const arrow = path.lastIndexOf(' -> ');
    if (arrow >= 0) path = path.slice(arrow + 4).trim();
    if (path === '') continue;
    if ((code.startsWith('"') || path.startsWith('"')) && path.endsWith('"')) {
      try {
        path = JSON.parse(path);
      } catch {
        path = path.slice(1, -1);
      }
    }
    if (code === '??') untracked.push(path);
    else changed.push(path);
  }
  return {changed, untracked};
}

function changedPaths(opts: WholeChangeOptions): {files: string[]; untracked: string[]} {
  const range = opts.head !== undefined ? `${opts.base}...${opts.head}` : opts.base;
  const paths = gitOrThrow(opts, ['diff', '--name-only', '--no-renames', range])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const untracked: string[] = [];
  if (opts.head === undefined) {
    const status = porcelainPaths(gitOrThrow(opts, ['status', '--porcelain=v1']));
    for (const path of [...status.changed, ...status.untracked]) paths.push(path);
    untracked.push(...status.untracked);
  }
  return {files: [...new Set(paths)].sort(), untracked: [...new Set(untracked)].sort()};
}

function readUntracked(root: string, path: string): string | null {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch {
    return null;
  }
}

function unifiedDiff(opts: WholeChangeOptions, untracked: readonly string[]): string {
  const range = opts.head !== undefined ? `${opts.base}...${opts.head}` : opts.base;
  let diff = gitOrThrow(opts, ['diff', '--unified=15', '--no-color', range]);
  const added: string[] = [];
  for (const path of untracked) {
    const text = readUntracked(opts.root, path);
    if (text === null) continue;
    added.push(`new file ${path}\n${text}`);
  }
  if (added.length > 0) diff = `${diff}${diff.endsWith('\n') || diff === '' ? '' : '\n'}${added.join('\n')}`;
  return diff;
}

/** Keep whole diff hunks from the start until the limit, then name the rest. */
function boundedWholeChangeDiff(diff: string, limit: number): string {
  if (diff.length <= limit) return diff;

  const marker = (count: number) => `\n[truncated: ${count} more hunks]`;
  const hunkStart = diff.startsWith('@@ ') ? 0 : diff.indexOf('\n@@ ') + 1;
  if (hunkStart <= 0) {
    const tail = marker(1);
    return `${diff.slice(0, Math.max(0, limit - tail.length))}${tail}`;
  }

  const header = diff.slice(0, hunkStart);
  const rest = diff.slice(hunkStart);
  const starts = [0];
  let offset = rest.indexOf('\n@@ ');
  while (offset >= 0) {
    starts.push(offset + 1);
    offset = rest.indexOf('\n@@ ', offset + 1);
  }

  let kept = 0;
  let body = header;
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : rest.length;
    const next = header + rest.slice(0, end);
    const tail = marker(starts.length - index - 1);
    if (next.length + tail.length > limit) break;
    body = next;
    kept = index + 1;
  }

  const tail = marker(starts.length - kept);
  if (body.length + tail.length > limit) body = body.slice(0, Math.max(0, limit - tail.length));
  return `${body}${tail}`;
}

function toolOf(path: string): string | null {
  const match = /(?:^|\/)tools\/([^/]+)\//.exec(posix(path));
  return match?.[1] ?? null;
}

function moduleCandidates(path: string): string[] {
  const ext = extname(path);
  if (ext !== '' && MODULE_EXTENSIONS.includes(ext)) return [path];
  return [...MODULE_EXTENSIONS.map((suffix) => `${path}${suffix}`), ...MODULE_EXTENSIONS.map((suffix) => join(path, `index${suffix}`))];
}

function resolveRelative(root: string, source: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = normalize(join(dirname(source), specifier));
  const candidates = moduleCandidates(base);
  for (const candidate of candidates) {
    try {
      if (statSync(join(root, candidate)).isFile()) return posix(candidate);
    } catch {
      // A missing candidate falls through to the next extension.
    }
  }
  return posix(base);
}

/** A path alias such as `@/src/tools/Billing/hooks` names a tool by segment. */
function resolveAlias(root: string, specifier: string): string | null {
  const match = /(?:^|\/)tools\/([^/?#]+)(?:\/([^?#]*))?/.exec(specifier);
  if (!match) return null;
  const tail = match[2] !== undefined && match[2] !== '' ? `/${match[2]}` : '';
  const base = posix(normalize(`tools/${match[1]}${tail}`));
  for (const candidate of moduleCandidates(base)) {
    try {
      if (statSync(join(root, candidate)).isFile()) return posix(candidate);
    } catch {
      // A missing alias target keeps the segment-derived path.
    }
  }
  return base;
}

function resolveImportTarget(root: string, source: string, specifier: string): string | null {
  return specifier.startsWith('.') ? resolveRelative(root, source, specifier) : resolveAlias(root, specifier);
}

function moduleKey(path: string): string {
  let key = posix(path).replace(/[?#].*$/, '');
  for (const extension of MODULE_EXTENSIONS) {
    if (key.endsWith(extension)) {
      key = key.slice(0, -extension.length);
      break;
    }
  }
  return key.replace(/\/index$/, '');
}

/** The module key from its last `tools/` segment on, so an alias that names
 * only `tools/<name>/...` matches the same module at any depth. */
function toolSuffixKey(path: string): string | null {
  const key = moduleKey(path);
  const index = key.lastIndexOf('tools/');
  return index === -1 || (index > 0 && key[index - 1] !== '/') ? null : key.slice(index);
}

function trackedTsJsFiles(root: string): string[] {
  const result = runSync('git', ['ls-files'], {cwd: root, maxBuffer: GIT_DIFF_MAX_BUFFER});
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((path) => path !== '' && TS_JS_EXTENSIONS.has(extname(path)));
}

function importSpecifiers(text: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

function refSpecifiers(text: string): string[] {
  const refs = new Set<string>();
  const pattern = /["']?\$ref["']?\s*:\s*["']?([^"'\s,}]+)/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1]) refs.add(match[1]);
  }
  return [...refs];
}

function readText(root: string, path: string): string | null {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch {
    return null;
  }
}

function resolveSpecRef(root: string, source: string, ref: string): string | null {
  if (ref === '' || ref.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(ref)) return null;
  const withoutFragment = ref.split('#')[0] ?? '';
  if (withoutFragment === '') return null;
  const absolute = withoutFragment.startsWith('/')
    ? join(root, withoutFragment.slice(1))
    : join(root, dirname(source), withoutFragment);
  const candidate = normalize(absolute);
  if (existsSync(candidate) && statSync(candidate).isFile()) return relativePath(root, candidate);
  return relativePath(root, candidate);
}

/**
 * Static relationships visible across a whole change: cross-tool relative
 * imports, cross-tool spec $refs, and modules imported by two or more tools.
 * The result is the body of the `Relationships` section; it never executes or
 * type-checks the changed code.
 */
export function changeGraph({root, files}: {root: string; files: readonly string[]}): string {
  const importEdges: {source: string; target: string; sourceTool: string; targetTool: string}[] = [];
  const refEdges: {source: string; target: string; sourceTool: string; targetTool: string}[] = [];
  const shared = new Map<string, Set<string>>();

  for (const source of [...new Set(files)].sort()) {
    const sourceTool = toolOf(source);
    const text = readText(root, source);
    if (text === null) continue;
    const extension = extname(source);

    if (TS_JS_EXTENSIONS.has(extension)) {
      for (const specifier of importSpecifiers(text)) {
        const target = resolveImportTarget(root, source, specifier);
        if (target === null) continue;
        const targetTool = toolOf(target);
        if (sourceTool !== null) {
          if (targetTool !== null && targetTool !== sourceTool) importEdges.push({source, target, sourceTool, targetTool});
          const tools = shared.get(target) ?? new Set<string>();
          tools.add(sourceTool);
          shared.set(target, tools);
        }
      }
    }

    if (SPEC_EXTENSIONS.has(extension)) {
      for (const ref of refSpecifiers(text)) {
        const target = resolveSpecRef(root, source, ref);
        if (target === null) continue;
        const targetTool = toolOf(target);
        if (sourceTool !== null && targetTool !== null && targetTool !== sourceTool) {
          refEdges.push({source, target, sourceTool, targetTool});
        }
      }
    }
  }

  // A changed module can be used by tools that did not change in this diff.
  // Tracked TS/JS importers supply those edges without widening the subject to
  // unrelated files: only relative or tool-aliased imports of a changed
  // module are considered.
  const changedModules = new Map<string, string>();
  const changedBySuffix = new Map<string, string>();
  for (const file of files) {
    if (!TS_JS_EXTENSIONS.has(extname(file))) continue;
    changedModules.set(moduleKey(file), file);
    const suffix = toolSuffixKey(file);
    if (suffix !== null) changedBySuffix.set(suffix, file);
  }
  if (changedModules.size > 0) {
    const changed = new Set(files);
    for (const importer of trackedTsJsFiles(root)) {
      if (changed.has(importer)) continue;
      const sourceTool = toolOf(importer);
      if (sourceTool === null) continue;
      const text = readText(root, importer);
      if (text === null) continue;
      for (const specifier of importSpecifiers(text)) {
        const target = resolveImportTarget(root, importer, specifier);
        if (target === null) continue;
        const suffix = specifier.startsWith('.') ? null : toolSuffixKey(target);
        const module = changedModules.get(moduleKey(target)) ?? (suffix !== null ? changedBySuffix.get(suffix) : undefined);
        if (module === undefined || moduleKey(importer) === moduleKey(module)) continue;
        const tools = shared.get(module) ?? new Set<string>();
        tools.add(sourceTool);
        shared.set(module, tools);
      }
    }
  }

  const lines: string[] = [];
  for (const edge of importEdges.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target))) {
    lines.push(`${edge.source} imports ${edge.target} (cross-tool: ${edge.sourceTool} -> ${edge.targetTool})`);
  }
  for (const edge of refEdges.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target))) {
    lines.push(`${edge.source} references ${edge.target} ($ref: ${edge.sourceTool} -> ${edge.targetTool})`);
  }
  for (const [target, tools] of [...shared.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (tools.size < 2) continue;
    const names = [...tools].sort();
    lines.push(`${target} is imported by ${names.length} tools: ${names.join(', ')}`);
  }
  return lines.length > 0 ? lines.join('\n') : '(none)';
}

/**
 * Build the one implementation-stage subject for a whole change: every changed
 * path plus the unified diff and its relationship graph. The diff keeps whole
 * hunks and is bounded so the complete subject stays within the 60,000
 * character limit.
 */
export function buildWholeChangeSubject(opts: WholeChangeOptions): GateSubject {
  const {files, untracked} = changedPaths(opts);
  const diff = unifiedDiff(opts, untracked);
  const relationships = `\n\nRelationships\n${changeGraph({root: opts.root, files})}`;
  const budget = Math.max(0, WHOLE_CHANGE_TEXT_LIMIT - relationships.length);
  return {
    target: 'change',
    kind: 'diff',
    files,
    text: `${boundedWholeChangeDiff(diff, budget)}${relationships}`,
  };
}
