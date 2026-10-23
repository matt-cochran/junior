// ---------------------------------------------------------------------------
// Claude Code SessionStart hook installation for the compact context block.
//
// The hook is a plain command entry (`junior compact`). Everything here is a
// pure settings transform plus a small, backup-preserving installer; no model
// or network call is made.

import * as fs from 'node:fs';
import { dirname, join } from 'node:path';

/** Command Junior installs as its compact-context SessionStart hook. */
export const JUNIOR_HOOK_COMMAND = 'junior compact';

/** Hook matcher covering both Claude Code compaction and resume starts. */
const JUNIOR_HOOK_MATCHER = 'compact|resume';

type JsonObject = Record<string, any>;

/**
 * Filesystem surface used by `installContextHooks`. Callers may inject a
 * subset; missing methods fall back to Node's filesystem.
 */
export type ContextHooksFileSystem = {
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: 'utf8') => string;
  writeFileSync?: (path: string, data: string) => void;
  mkdirSync?: (path: string, options: { recursive: true }) => void;
 };

/** Options accepted by `installContextHooks`. */
export type ContextHooksOptions = {
  projectDir: string;
  scope?: 'local' | 'project';
  command?: string;
  remove?: boolean;
  fs?: ContextHooksFileSystem;
  now?: () => Date;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneSettings(settings: unknown): JsonObject {
  if (settings === undefined || settings === null) return {};
  if (!isObject(settings)) throw new TypeError('settings must be a JSON object');
  return JSON.parse(JSON.stringify(settings)) as JsonObject;
}

function hasJuniorCommand(entry: unknown): boolean {
  if (!isObject(entry)) return false;
  const hooks = entry.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (hook) => isObject(hook) && typeof hook.command === 'string' && hook.command.startsWith(JUNIOR_HOOK_COMMAND),
  );
}

function sessionStartEntries(settings: JsonObject): unknown[] | null {
  if (settings.hooks === undefined) return [];
  if (!isObject(settings.hooks)) throw new TypeError('settings.hooks must be a JSON object');
  if (settings.hooks.SessionStart === undefined) return [];
  if (!Array.isArray(settings.hooks.SessionStart)) {
    throw new TypeError('settings.hooks.SessionStart must be an array');
  }
  return settings.hooks.SessionStart;
}

/**
 * Add one Junior `SessionStart` entry unless a command already starts with
 * `JUNIOR_HOOK_COMMAND`. Every other settings key and hook entry is preserved,
 * and the input object is never mutated.
 */
export function mergeContextHooks(
  settings: unknown,
  command: string = JUNIOR_HOOK_COMMAND,
): { settings: JsonObject; changed: boolean } {
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new TypeError('command must be a non-empty string');
  }
  const merged = cloneSettings(settings);
  const entries = sessionStartEntries(merged);
  if (entries === null) throw new TypeError('settings.hooks.SessionStart must be an array');
  if (entries.some(hasJuniorCommand)) return { settings: merged, changed: false };

  if (!isObject(merged.hooks)) merged.hooks = {};
  merged.hooks.SessionStart = [
    ...entries,
    { matcher: JUNIOR_HOOK_MATCHER, hooks: [{ type: 'command', command }] },
  ];
  return { settings: merged, changed: true };
}

/**
 * Remove only Junior `SessionStart` entries, preserving every unrelated
 * setting and hook. An empty `SessionStart` (or `hooks`) table is dropped.
 */
export function removeContextHooks(settings: unknown): { settings: JsonObject; changed: boolean } {
  const cleaned = cloneSettings(settings);
  const entries = sessionStartEntries(cleaned);
  if (entries === null) throw new TypeError('settings.hooks.SessionStart must be an array');
  const kept = entries.filter((entry) => !hasJuniorCommand(entry));
  if (kept.length === entries.length) return { settings: cleaned, changed: false };

  if (kept.length > 0) {
    cleaned.hooks.SessionStart = kept;
  } else {
    delete cleaned.hooks.SessionStart;
    if (Object.keys(cleaned.hooks).length === 0) delete cleaned.hooks;
  }
  return { settings: cleaned, changed: true };
}

function settingsPath(projectDir: string, scope: 'local' | 'project'): string {
  return join(projectDir, '.claude', scope === 'project' ? 'settings.json' : 'settings.local.json');
}

function backupPath(path: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${path}.${stamp}.bak`;
}

/**
 * Install (or with `remove`, uninstall) the Junior compact hook in Claude Code
 * project settings. Local scope is the default. A timestamped `.bak` copy is
 * written only when an existing file actually changes. A settings file that is
 * not a JSON object is refused rather than overwritten.
 */
export function installContextHooks(options: ContextHooksOptions): {
  path: string;
  backup: string | null;
  changed: boolean;
} {
  if (!isObject(options) || typeof options.projectDir !== 'string' || options.projectDir.trim().length === 0) {
    throw new TypeError('projectDir must be a non-empty string');
  }
  const scope = options.scope ?? 'local';
  if (scope !== 'local' && scope !== 'project') {
    throw new TypeError(`scope must be 'local' or 'project', got '${String(scope)}'`);
  }
  if (options.command !== undefined && (typeof options.command !== 'string' || options.command.trim().length === 0)) {
    throw new TypeError('command must be a non-empty string');
  }

  const files: Required<ContextHooksFileSystem> = {
    existsSync: options.fs?.existsSync ?? fs.existsSync,
    readFileSync: options.fs?.readFileSync ?? ((path, encoding) => fs.readFileSync(path, encoding)),
    writeFileSync: options.fs?.writeFileSync ?? ((path, data) => fs.writeFileSync(path, data)),
    mkdirSync: options.fs?.mkdirSync ?? ((path, opts) => fs.mkdirSync(path, opts)),
  };
  const path = settingsPath(options.projectDir, scope);

  if (!files.existsSync(path)) {
    if (options.remove) return { path, backup: null, changed: false };
    const merged = mergeContextHooks({}, options.command);
    files.mkdirSync(dirname(path), { recursive: true });
    files.writeFileSync(path, JSON.stringify(merged.settings, null, 2) + '\n');
    return { path, backup: null, changed: true };
  }

  const raw = files.readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path}: settings file is not valid JSON`);
  }
  if (!isObject(parsed)) throw new TypeError(`${path}: settings file must be a JSON object`);

  const result = options.remove ? removeContextHooks(parsed) : mergeContextHooks(parsed, options.command);
  if (!result.changed) return { path, backup: null, changed: false };

  const stamp = (options.now ?? (() => new Date()))();
  if (!(stamp instanceof Date) || Number.isNaN(stamp.getTime())) {
    throw new TypeError('now must return a valid Date');
  }
  const backup = backupPath(path, stamp);
  files.mkdirSync(dirname(path), { recursive: true });
  files.writeFileSync(backup, raw);
  files.writeFileSync(path, JSON.stringify(result.settings, null, 2) + '\n');
  return { path, backup, changed: true };
}

/**
 * Printable manual setup steps for harnesses that read no Claude Code project
 * settings. Nothing is written to disk for these harnesses.
 */
export function harnessInstructions(harness: 'codex' | 'cursor'): string {
  const steps = (file: string) => [
    `Add this to ${file} so the agent reloads Junior's state after its context is compacted or a session resumes:`,
    '',
    `  At the start of a session, and whenever earlier context seems lost, run \`${JUNIOR_HOOK_COMMAND}\``,
    '  and read its output before continuing: it lists the active plan, open risks,',
    '  open hypotheses and in-flight Junior runs from the project stores.',
  ];
  if (harness === 'codex') return ['Codex manual setup (nothing was written).', ...steps('AGENTS.md')].join('\n');
  if (harness === 'cursor') return ['Cursor manual setup (nothing was written).', ...steps('a project rule, e.g. .cursor/rules/junior-context.mdc')].join('\n');
  throw new TypeError(`unsupported harness '${String(harness)}'`);
}
