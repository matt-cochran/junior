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
import { loadAdrs } from './adr.ts';

export type AdrFormat = 'junior' | 'madr' | 'nygard';
export type AdrGate = 'enforce' | 'advisory' | 'off';

export interface AdrConfig {
  dir: string;
  format: AdrFormat;
  gate: AdrGate;
  minConfidence?: number;
}

export interface AdrDirDetection {
  /** Directory relative to the project root. */
  dir: string;
  source: '.adr-dir' | 'default-path';
}

const ADR_FILE_PATTERN = /^\d{4}-.+\.md$/;
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

function adrFiles(dir: string): string[] {
  return markdownFiles(dir).filter((name) => ADR_FILE_PATTERN.test(name));
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
  return config;
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
      const dir = normalizeRelative(firstLine);
      if (isDirectory(join(root, dir))) return { dir, source: '.adr-dir' };
    }
  }
  for (const dir of DEFAULT_ADR_DIRS) {
    if (isDirectory(join(root, dir))) return { dir, source: 'default-path' };
  }
  return null;
}

/** `junior` for Junior front matter, `madr` for MADR headings, else `nygard`. */
export function detectAdrFormat(dir: string): AdrFormat {
  for (const name of adrFiles(dir)) {
    const content = readIfPresent(join(dir, name)) ?? '';
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (front && /^\s*id\s*:\s*["']?ADR-\d+["']?\s*$/m.test(front[1])) return 'junior';
  }
  for (const name of markdownFiles(dir)) {
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
 * `off`. Junior records go through `loadAdrs`; MADR/Nygard records are read by
 * their status line or Status section because they have no Junior front matter.
 */
export function defaultGate(dir: string): AdrGate {
  const format = detectAdrFormat(dir);
  if (format === 'junior') {
    return loadAdrs(dir).some((adr) => adr.status === 'accepted') ? 'enforce' : 'off';
  }
  return markdownFiles(dir)
    .filter((name) => name !== 'README.md')
    .some((name) => {
      const content = readIfPresent(join(dir, name));
      return content !== null && statusSaysAccepted(content);
    })
    ? 'enforce'
    : 'off';
}

/** Combine detection, format and gate without writing anything. */
export function proposeAdrConfig(root: string): AdrConfig | null {
  const detection = detectAdrDir(root);
  if (!detection) return null;
  const dir = join(root, detection.dir);
  return {
    dir: detection.dir,
    format: detectAdrFormat(dir),
    gate: defaultGate(dir),
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
