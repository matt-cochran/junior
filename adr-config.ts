// ---------------------------------------------------------------------------
// ADR project configuration for Junior (ADR 0018 R1, R2).
//
// The ADR directory, document format and gate are project configuration in the
// `adr` block of `delivery.config.json`. Detection only proposes a value; the
// CLI confirms it with the user before `writeAdrConfig` records it. A default
// gate of `enforce` is proposed only when the collection already holds at least
// one accepted decision, because ADR-0003 requires an explicit opt-in before a
// Jev verdict may gate an action.
//
// This module is pure project inspection plus the one config writer. It never
// writes an ADR, a ledger entry or any other file.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import { join } from 'node:path';
import {
  ADR_PREFIX_FILE_PATTERN,
  adrFilePattern,
  adrIdFromFileName,
  parseAdr,
} from './adr.ts';

export { adrFilePattern, adrIdFromFileName } from './adr.ts';

export type AdrFormat = 'junior' | 'madr' | 'nygard';
export type AdrGate = 'enforce' | 'advisory' | 'off';

export interface AdrConfig {
  dir: string;
  format: AdrFormat;
  gate: AdrGate;
  /** Regular expression selecting ADR files; the `number` named group supplies the id. */
  filePattern?: string;
  minConfidence?: number;
  /** Uncertain (low-confidence) findings also block under enforce. Default false: only likely contradictions block. */
  flagUncertain?: boolean;
  /** NO_DISCRIMINATION checks at least this many cells before comparing the ratio. Default 10. */
  minDiscriminationCells?: number;
  /** NO_DISCRIMINATION fires when uncertain/checked reaches this ratio. Default 0.9. */
  maxUncertainRatio?: number;
}

export interface AdrPatternConfig {
  filePattern?: string;
}

export interface AdrDirDetection {
  /** Directory relative to the project root. */
  dir: string;
  source: '.adr-dir' | 'default-path';
}

const DEFAULT_ADR_DIRS = ['docs/adr', 'docs/decisions', 'doc/architecture/decisions', 'adr', 'architecture/decisions'];
const FORMATS = new Set<AdrFormat>(['junior', 'madr', 'nygard']);
const GATES = new Set<AdrGate>(['enforce', 'advisory', 'off']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDirectory(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function normalizeRelative(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.';
}

function markdownFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.md')).sort();
  } catch {
    return [];
  }
}

function adrFiles(dir: string, config?: AdrPatternConfig): string[] {
  const pattern = adrFilePattern(config);
  return markdownFiles(dir).filter((name) => adrIdFromFileName(name, pattern) !== null);
}

function readIfPresent(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Read and validate the `adr` block, or `null` when the block is absent. */
export function readAdrConfig(root: string): AdrConfig | null {
  const raw = readIfPresent(join(root, 'delivery.config.json'));
  if (raw === null) return null;

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new Error(`delivery.config.json is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(document) || document.adr === undefined || document.adr === null) return null;
  if (!isRecord(document.adr)) throw new Error('adr must be an object');

  const block = document.adr;
  const dir = block.dir;
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new Error('adr.dir must be a non-empty string');
  }
  const format = block.format;
  if (typeof format !== 'string' || !FORMATS.has(format as AdrFormat)) {
    throw new Error('adr.format must be one of junior, madr, nygard');
  }
  const gate = block.gate;
  if (typeof gate !== 'string' || !GATES.has(gate as AdrGate)) {
    throw new Error('adr.gate must be one of enforce, advisory, off');
  }

  const config: AdrConfig = { dir, format: format as AdrFormat, gate: gate as AdrGate };
  if (block.minConfidence !== undefined) {
    const minConfidence = block.minConfidence;
    if (typeof minConfidence !== 'number' || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      throw new Error('adr.minConfidence must be a number between 0 and 1');
    }
    config.minConfidence = minConfidence;
  }
  if (block.filePattern !== undefined) {
    if (typeof block.filePattern !== 'string') {
      throw new Error("adr.filePattern must be a regular expression with a named group 'number'");
    }
    adrFilePattern({filePattern: block.filePattern});
    config.filePattern = block.filePattern;
  }
  if (block.flagUncertain !== undefined) {
    if (typeof block.flagUncertain !== 'boolean') throw new Error('adr.flagUncertain must be a boolean');
    config.flagUncertain = block.flagUncertain;
  }
  if (block.minDiscriminationCells !== undefined) {
    const minDiscriminationCells = block.minDiscriminationCells;
    if (typeof minDiscriminationCells !== 'number' || !Number.isFinite(minDiscriminationCells) || minDiscriminationCells < 0) {
      throw new Error('adr.minDiscriminationCells must be a non-negative number');
    }
    config.minDiscriminationCells = minDiscriminationCells;
  }
  if (block.maxUncertainRatio !== undefined) {
    const maxUncertainRatio = block.maxUncertainRatio;
    if (typeof maxUncertainRatio !== 'number' || !Number.isFinite(maxUncertainRatio) || maxUncertainRatio < 0 || maxUncertainRatio > 1) {
      throw new Error('adr.maxUncertainRatio must be a number between 0 and 1');
    }
    config.maxUncertainRatio = maxUncertainRatio;
  }
  return config;
}

/** The on-disk spelling of `relative` under `root`, matched case-insensitively per segment. */
function actualDirectory(root: string, relative: string): string | null {
  const normalized = normalizeRelative(relative);
  if (normalized === '.') return isDirectory(root) ? '.' : null;
  let current = '';
  for (const part of normalized.split('/').filter((entry) => entry !== '' && entry !== '.')) {
    let entries: string[];
    try {
      entries = fs.readdirSync(current === '' ? root : join(root, current));
    } catch {
      return null;
    }
    const actual = entries.find((entry) => entry.toLowerCase() === part.toLowerCase());
    if (actual === undefined) return null;
    current = current === '' ? actual : `${current}/${actual}`;
  }
  return current !== '' && isDirectory(join(root, current)) ? current : null;
}

/**
 * Find the ADR directory. An explicit `.adr-dir` file wins when its first line
 * names an existing directory; otherwise the conventional paths are tried in
 * order. The result is relative to `root`; `null` means "no ADR directory".
 */
export function detectAdrDir(root: string): AdrDirDetection | null {
  const marker = readIfPresent(join(root, '.adr-dir'));
  if (marker !== null) {
    const firstLine = marker.split(/\r?\n/, 1)[0].trim();
    if (firstLine) {
      const dir = actualDirectory(root, firstLine);
      if (dir !== null) return { dir, source: '.adr-dir' };
    }
  }
  for (const candidate of DEFAULT_ADR_DIRS) {
    const dir = actualDirectory(root, candidate);
    if (dir !== null) return { dir, source: 'default-path' };
  }
  return null;
}

/** `junior` for Junior front matter, `madr` for MADR headings, else `nygard`. */
export function detectAdrFormat(dir: string, config?: AdrPatternConfig): AdrFormat {
  for (const name of adrFiles(dir, config)) {
    const content = readIfPresent(join(dir, name)) ?? '';
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (front && /^\s*id\s*:\s*["']?ADR-\d+[a-z]?["']?\s*$/m.test(front[1])) return 'junior';
  }
  for (const name of adrFiles(dir, config)) {
    const content = readIfPresent(join(dir, name)) ?? '';
    if (/^##\s+(Decision Outcome|Considered Options)\s*$/im.test(content)) return 'madr';
  }
  return 'nygard';
}

function statusSaysAccepted(content: string): boolean {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (front) {
    const statusLine = /^\s*status\s*:\s*(.+?)\s*$/im.exec(front[1]);
    if (statusLine && /^["']?accepted["']?$/i.test(statusLine[1].trim())) return true;
  }

  const section = /^##\s+Status\s*(?::\s*(.*))?$/im.exec(content);
  if (section) {
    if (section[1] && /\baccepted\b/i.test(section[1])) return true;
    const rest = content.slice(section.index + section[0].length);
    const next = /^##\s+/m.exec(rest);
    const body = next ? rest.slice(0, next.index) : rest;
    if (/\bstatus\s*:\s*["']?accepted["']?\b/i.test(body) || /^\s*(?:\*\*)?accepted(?:\*\*)?\s*$/im.test(body)) {
      return true;
    }
  }

  return /^\s*status\s*:\s*["']?accepted["']?\s*$/im.test(content);
}

/**
 * `enforce` when the collection already contains an accepted decision, else
 * `off`. Each record is read by its own format: Junior front matter through
 * `parseAdr`, MADR/Nygard through their status line or Status section, so a
 * mixed folder never goes through the strict `loadAdrs` loader.
 */
export function defaultGate(dir: string, config?: AdrPatternConfig): AdrGate {
  return adrFiles(dir, config).some((name) => {
    const content = readIfPresent(join(dir, name));
    if (content === null) return false;
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (front && /^\s*id\s*:\s*["']?ADR-\d+[a-z]?["']?\s*$/m.test(front[1])) {
      try {
        return parseAdr(content).status === 'accepted';
      } catch {
        return statusSaysAccepted(content);
      }
    }
    return statusSaysAccepted(content);
  })
    ? 'enforce'
    : 'off';
}

/** Propose a non-default pattern only when the folder uses `ADR-NNN-title` names. */
export function detectFilePattern(dir: string): string | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const defaultPattern = adrFilePattern();
  if (names.some((name) => adrIdFromFileName(name, defaultPattern) !== null)) return undefined;
  const prefixPattern = adrFilePattern({filePattern: ADR_PREFIX_FILE_PATTERN});
  return names.some((name) => adrIdFromFileName(name, prefixPattern) !== null)
    ? ADR_PREFIX_FILE_PATTERN
    : undefined;
}

/** Combine detection, format, gate and file pattern without writing anything. */
export function proposeAdrConfig(root: string): AdrConfig | null {
  const detection = detectAdrDir(root);
  if (!detection) return null;
  const dir = join(root, detection.dir);
  const filePattern = detectFilePattern(dir);
  const config: AdrPatternConfig = filePattern === undefined ? {} : {filePattern};
  return {
    dir: detection.dir,
    format: detectAdrFormat(dir, config),
    gate: defaultGate(dir, config),
    ...(filePattern === undefined ? {} : {filePattern}),
  };
}

/**
 * Merge `{adr: config}` into `delivery.config.json`, preserving every other
 * key and the project's 2-space JSON formatting with a trailing newline.
 */
export function writeAdrConfig(root: string, config: AdrConfig): void {
  const path = join(root, 'delivery.config.json');
  let document: Record<string, unknown> = {};
  const raw = readIfPresent(path);
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`delivery.config.json is not valid JSON: ${(error as Error).message}`);
    }
    if (!isRecord(parsed)) throw new Error('delivery.config.json must contain a JSON object');
    document = parsed;
  }
  fs.mkdirSync(root, { recursive: true });
  document.adr = config;
  fs.writeFileSync(path, JSON.stringify(document, null, 2) + '\n');
}
