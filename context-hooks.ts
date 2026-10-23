// ---------------------------------------------------------------------------
// Hook installation for Junior's compact context block and capture pass.
//
// Claude Code gets a SessionStart entry (`junior compact`) and a PreCompact
// entry (`junior compact --capture`). Codex and Cursor get equivalent project
// hook files. Everything here is a pure transform plus small, backup-preserving
// installers; no model or network call is made.

import * as fs from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { ensureLocalExcludes } from './isolation.ts';

/** Command Junior installs as its compact-context SessionStart hook. */
export const JUNIOR_HOOK_COMMAND = 'junior compact';

/** Command Junior installs as its capture PreCompact hook. */
export const JUNIOR_CAPTURE_COMMAND = 'junior compact --capture';

/** Hook matcher covering both Claude Code compaction and resume starts. */
const JUNIOR_HOOK_MATCHER = 'compact|resume';

const CODEX_HOOK_MATCHER = 'startup|resume|compact';
const CURSOR_HOOK_COMMAND = 'junior compact --cursor';
const CODEX_TRUST_NOTE =
  'Codex runs project hooks only after you trust them: open /hooks in Codex and trust the Junior entries.';

export type HarnessName = 'codex' | 'cursor';

export type HarnessHooksOptions = {
  projectDir: string;
  harness: HarnessName;
  remove?: boolean;
  fs?: ContextHooksFileSystem;
  now?: () => Date;
};

export type HarnessHooksInstallResult = {
  path: string;
  backup: string | null;
  changed: boolean;
  created: boolean;
  excludeError?: string;
  notes: string[];
};

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

function commandStartsJunior(command: unknown): boolean {
  return typeof command === 'string' && command.startsWith(JUNIOR_HOOK_COMMAND);
}

function isCaptureCommand(command: unknown): boolean {
  return commandStartsJunior(command) && String(command).includes('--capture');
}

function nestedEntryHasCommand(entry: unknown, predicate: (command: unknown) => boolean): boolean {
  if (!isObject(entry)) return false;
  const hooks = entry.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((hook) => isObject(hook) && predicate(hook.command));
}

function hasJuniorSessionStart(entry: unknown): boolean {
  return nestedEntryHasCommand(entry, (command) => commandStartsJunior(command) && !String(command).includes('--capture'));
}

function hasJuniorCapture(entry: unknown): boolean {
  return nestedEntryHasCommand(entry, isCaptureCommand);
}

function hasAnyJuniorCommand(entry: unknown): boolean {
  return nestedEntryHasCommand(entry, commandStartsJunior);
}

function flatEntryHasCommand(entry: unknown, predicate: (command: unknown) => boolean): boolean {
  return isObject(entry) && predicate(entry.command);
}

function eventEntries(settings: JsonObject, event: string): unknown[] {
  if (settings.hooks === undefined) return [];
  if (!isObject(settings.hooks)) throw new TypeError('settings.hooks must be a JSON object');
  if (settings.hooks[event] === undefined) return [];
  if (!Array.isArray(settings.hooks[event])) {
    throw new TypeError(`settings.hooks.${event} must be an array`);
  }
  return settings.hooks[event];
}

function ensureHooksObject(settings: JsonObject): JsonObject {
  if (settings.hooks === undefined) settings.hooks = {};
  if (!isObject(settings.hooks)) throw new TypeError('settings.hooks must be a JSON object');
  return settings.hooks;
}

function setOrDropEvent(settings: JsonObject, event: string, kept: unknown[]): void {
  if (kept.length > 0) {
    settings.hooks[event] = kept;
  } else {
    delete settings.hooks[event];
  }
}

function dropEmptyHooks(settings: JsonObject): void {
  if (isObject(settings.hooks) && Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

function removeNestedJuniorEntries(settings: JsonObject, event: string): boolean {
  const entries = eventEntries(settings, event);
  if (!entries.some(hasAnyJuniorCommand)) return false;
  const kept = entries.filter((entry) => !hasAnyJuniorCommand(entry));
  setOrDropEvent(settings, event, kept);
  return true;
}

function removeFlatJuniorEntries(settings: JsonObject, event: string): boolean {
  const entries = eventEntries(settings, event);
  if (!entries.some((entry) => flatEntryHasCommand(entry, commandStartsJunior))) return false;
  const kept = entries.filter((entry) => !flatEntryHasCommand(entry, commandStartsJunior));
  setOrDropEvent(settings, event, kept);
  return true;
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
  const sessionStart = eventEntries(merged, 'SessionStart');
  const preCompact = eventEntries(merged, 'PreCompact');
  let changed = false;

  if (!sessionStart.some(hasJuniorSessionStart)) {
    ensureHooksObject(merged);
    merged.hooks.SessionStart = [
      ...sessionStart,
      { matcher: JUNIOR_HOOK_MATCHER, hooks: [{ type: 'command', command }] },
    ];
    changed = true;
  }
  if (!preCompact.some(hasJuniorCapture)) {
    ensureHooksObject(merged);
    merged.hooks.PreCompact = [
      ...preCompact,
      { hooks: [{ type: 'command', command: JUNIOR_CAPTURE_COMMAND }] },
    ];
    changed = true;
  }
  return { settings: merged, changed };
}

/**
 * Remove only Junior `SessionStart` entries, preserving every unrelated
 * setting and hook. An empty `SessionStart` (or `hooks`) table is dropped.
 */
export function removeContextHooks(settings: unknown): { settings: JsonObject; changed: boolean } {
  const cleaned = cloneSettings(settings);
  const removedSessionStart = removeNestedJuniorEntries(cleaned, 'SessionStart');
  const removedPreCompact = removeNestedJuniorEntries(cleaned, 'PreCompact');
  if (!removedSessionStart && !removedPreCompact) return { settings: cleaned, changed: false };
  dropEmptyHooks(cleaned);
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
  excludeError?: string;
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

  const backupRelative = relative(options.projectDir, backup);
  if (backupRelative.length > 0 && !backupRelative.startsWith('..') && !isAbsolute(backupRelative)) {
    const pattern = '/' + backupRelative.split(sep).join('/');
    try {
      const excluded = ensureLocalExcludes(options.projectDir, [pattern]);
      if (excluded.error) return { path, backup, changed: true, excludeError: excluded.error };
    } catch (e: any) {
      return { path, backup, changed: true, excludeError: e?.message || String(e) };
    }
  }
  return { path, backup, changed: true };
}

/** Path of the project hook file read by Codex or Cursor. */
export function harnessHooksPath(projectDir: string, harness: HarnessName): string {
  if (harness !== 'codex' && harness !== 'cursor') throw new TypeError(`unsupported harness '${String(harness)}'`);
  return join(projectDir, `.${harness}`, 'hooks.json');
}

/**
 * Add Junior's SessionStart and PreCompact hooks to a Codex or Cursor config.
 * Each event is merged independently, every other key is preserved, and the
 * input object is never mutated.
 */
export function mergeHarnessHooks(harness: HarnessName, config: unknown): { config: JsonObject; changed: boolean } {
  const merged = cloneSettings(config);
  let changed = false;

  if (harness === 'codex') {
    const sessionStart = eventEntries(merged, 'SessionStart');
    const preCompact = eventEntries(merged, 'PreCompact');
    if (!sessionStart.some(hasJuniorSessionStart)) {
      ensureHooksObject(merged);
      merged.hooks.SessionStart = [
        ...sessionStart,
        { matcher: CODEX_HOOK_MATCHER, hooks: [{ type: 'command', command: JUNIOR_HOOK_COMMAND }] },
      ];
      changed = true;
    }
    if (!preCompact.some(hasJuniorCapture)) {
      ensureHooksObject(merged);
      merged.hooks.PreCompact = [
        ...preCompact,
        { hooks: [{ type: 'command', command: JUNIOR_CAPTURE_COMMAND }] },
      ];
      changed = true;
    }
  } else if (harness === 'cursor') {
    const sessionStart = eventEntries(merged, 'sessionStart');
    const preCompact = eventEntries(merged, 'preCompact');
    if (merged.version === undefined) {
      merged.version = 1;
      changed = true;
    }
    if (!sessionStart.some((entry) => flatEntryHasCommand(entry, commandStartsJunior))) {
      ensureHooksObject(merged);
      merged.hooks.sessionStart = [...sessionStart, { command: CURSOR_HOOK_COMMAND }];
      changed = true;
    }
    if (!preCompact.some((entry) => flatEntryHasCommand(entry, isCaptureCommand))) {
      ensureHooksObject(merged);
      merged.hooks.preCompact = [...preCompact, { command: JUNIOR_CAPTURE_COMMAND }];
      changed = true;
    }
  } else {
    throw new TypeError(`unsupported harness '${String(harness)}'`);
  }

  return { config: merged, changed };
}

/** Remove only Junior-owned entries from a Codex or Cursor hook config. */
export function removeHarnessHooks(harness: HarnessName, config: unknown): { config: JsonObject; changed: boolean } {
  const cleaned = cloneSettings(config);
  let changed = false;
  if (harness === 'codex') {
    changed = removeNestedJuniorEntries(cleaned, 'SessionStart') || changed;
    changed = removeNestedJuniorEntries(cleaned, 'PreCompact') || changed;
  } else if (harness === 'cursor') {
    changed = removeFlatJuniorEntries(cleaned, 'sessionStart') || changed;
    changed = removeFlatJuniorEntries(cleaned, 'preCompact') || changed;
  } else {
    throw new TypeError(`unsupported harness '${String(harness)}'`);
  }
  if (!changed) return { config: cleaned, changed: false };
  dropEmptyHooks(cleaned);
  return { config: cleaned, changed: true };
}

/**
 * Install (or with `remove`, uninstall) Junior hooks for Codex or Cursor.
 * Existing files are backed up only when they change. A newly created hook
 * file is locally excluded so a fresh install does not dirty the checkout.
 */
export function installHarnessHooks(options: HarnessHooksOptions): HarnessHooksInstallResult {
  if (!isObject(options) || typeof options.projectDir !== 'string' || options.projectDir.trim().length === 0) {
    throw new TypeError('projectDir must be a non-empty string');
  }
  if (options.harness !== 'codex' && options.harness !== 'cursor') {
    throw new TypeError(`unsupported harness '${String(options.harness)}'`);
  }
  const files: Required<ContextHooksFileSystem> = {
    existsSync: options.fs?.existsSync ?? fs.existsSync,
    readFileSync: options.fs?.readFileSync ?? ((path, encoding) => fs.readFileSync(path, encoding)),
    writeFileSync: options.fs?.writeFileSync ?? ((path, data) => fs.writeFileSync(path, data)),
    mkdirSync: options.fs?.mkdirSync ?? ((path, opts) => fs.mkdirSync(path, opts)),
  };
  const path = harnessHooksPath(options.projectDir, options.harness);
  const notes = options.harness === 'codex' ? [CODEX_TRUST_NOTE] : [];

  const exclude = (patterns: string[]): string | undefined => {
    try {
      const result = ensureLocalExcludes(options.projectDir, patterns);
      return result.error;
    } catch (e: any) {
      return e?.message || String(e);
    }
  };

  if (!files.existsSync(path)) {
    if (options.remove) return { path, backup: null, changed: false, created: false, notes };
    const merged = mergeHarnessHooks(options.harness, {});
    files.mkdirSync(dirname(path), { recursive: true });
    files.writeFileSync(path, JSON.stringify(merged.config, null, 2) + '\n');
    const excludeError = exclude([`/.${options.harness}/hooks.json`]);
    return {
      path,
      backup: null,
      changed: true,
      created: true,
      ...(excludeError ? { excludeError } : {}),
      notes,
    };
  }

  const raw = files.readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path}: hooks file is not valid JSON`);
  }
  if (!isObject(parsed)) throw new TypeError(`${path}: hooks file must be a JSON object`);

  const result = options.remove ? removeHarnessHooks(options.harness, parsed) : mergeHarnessHooks(options.harness, parsed);
  if (!result.changed) return { path, backup: null, changed: false, created: false, notes };

  const stamp = (options.now ?? (() => new Date()))();
  if (!(stamp instanceof Date) || Number.isNaN(stamp.getTime())) {
    throw new TypeError('now must return a valid Date');
  }
  const backup = backupPath(path, stamp);
  files.mkdirSync(dirname(path), { recursive: true });
  files.writeFileSync(backup, raw);
  files.writeFileSync(path, JSON.stringify(result.config, null, 2) + '\n');

  let excludeError: string | undefined;
  const backupRelative = relative(options.projectDir, backup);
  if (backupRelative.length > 0 && !backupRelative.startsWith('..') && !isAbsolute(backupRelative)) {
    excludeError = exclude(['/' + backupRelative.split(sep).join('/')]);
  }
  return {
    path,
    backup,
    changed: true,
    created: false,
    ...(excludeError ? { excludeError } : {}),
    notes,
  };
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
