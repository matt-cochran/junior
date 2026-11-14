// ---------------------------------------------------------------------------
// Scaffold an ADR collection for a project (ADR 0018 R1, R2).
//
// `initAdrs` creates the configured (or default `docs/adr`) directory, a
// README index and, on request, the accepted "record architecture decisions"
// ADR. It never overwrites an existing file and reports only the files it
// created. The returned config is the value the CLI may propose to the user;
// this module deliberately does not call `writeAdrConfig` (R1: the user
// confirms the detected location and gate first).
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import { basename, join } from 'node:path';
import { createAdr, parseAdr } from './adr.ts';
import { defaultGate, detectAdrFormat, type AdrConfig } from './adr-config.ts';

export interface InitAdrsOptions {
  /** Directory relative to the project root; defaults to `docs/adr`. */
  dir?: string;
  /** Also create `0001-record-architecture-decisions.md` as an accepted ADR. */
  withRecordDecision?: boolean;
  /** ISO date (`YYYY-MM-DD`) for the created decision record. */
  date?: string;
}

export interface InitAdrsResult {
  dir: string;
  /** Project-relative paths of the files this run created, in creation order. */
  created: string[];
  /** The config this scaffold would propose; not written by this function. */
  config: AdrConfig;
}

const ADR_FILE_PATTERN = /^\d{4}-.+\.md$/;
const RECORD_DECISION_TITLE = 'Record architecture decisions';
const RECORD_DECISION_RULE = (dir: string) => `Significant architecture decisions are recorded as ADRs in ${dir}`;

function normalizeDir(dir: string): string {
  const normalized = dir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return normalized || '.';
}

function relativePath(dir: string, name: string): string {
  return dir === '.' ? name : `${dir}/${name}`;
}

function readIfPresent(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function recordLabel(absoluteDir: string, name: string): string {
  const content = readIfPresent(join(absoluteDir, name));
  if (content === null) return name.replace(/\.md$/, '');
  try {
    const adr = parseAdr(content);
    if (adr.id && adr.title) return `${adr.id}: ${adr.title}`;
    if (adr.id) return adr.id;
  } catch {
    // MADR/Nygard records have no Junior front matter; use their heading.
  }
  const heading = /^#\s+(.+?)\s*$/m.exec(content);
  return heading ? heading[1] : name.replace(/\.md$/, '');
}

function renderReadme(absoluteDir: string): string {
  const records = fs.readdirSync(absoluteDir).filter((name) => ADR_FILE_PATTERN.test(name)).sort();
  const lines = [
    '# Architecture decision records',
    '',
    'Architecture decisions for this project are recorded here.',
    '',
    '## Records',
    '',
  ];
  if (records.length === 0) {
    lines.push('_No records yet._');
  } else {
    for (const name of records) {
      lines.push(`- [${recordLabel(absoluteDir, name)}](${name})`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function writeRecordDecision(dir: string, absoluteDir: string, dirLabel: string, date?: string): string {
  const created = createAdr(absoluteDir, RECORD_DECISION_TITLE, {
    status: 'accepted',
    ...(date ? { date } : {}),
  });
  const rule = RECORD_DECISION_RULE(dirLabel);
  const original = fs.readFileSync(created.path, 'utf8');
  const updated = original
    .replace('applies_to: []', `applies_to: ['${dirLabel === '.' ? '**' : `${dirLabel}/**`}']`)
    .replace('rules: []', ['rules:', '  - id: R1', `    text: ${rule}`].join('\n'));
  if (updated === original) throw new Error(`could not add the record-decision front matter to ${created.path}`);
  fs.writeFileSync(created.path, updated);
  return relativePath(dir, basename(created.path));
}

/**
 * Create the ADR directory, README index and optional first decision record.
 * Existing files are left untouched; `created` lists only new paths.
 */
export function initAdrs(root: string, options: InitAdrsOptions = {}): InitAdrsResult {
  const dir = normalizeDir(options.dir ?? 'docs/adr');
  const absoluteDir = join(root, dir);
  fs.mkdirSync(absoluteDir, { recursive: true });

  const created: string[] = [];
  // A second init must not add a duplicate 000N record when one exists.
  const hasRecordDecision = fs.readdirSync(absoluteDir).some((name) => /^\d{4}-record-architecture-decisions\.md$/.test(name));
  if (options.withRecordDecision && !hasRecordDecision) {
    created.push(writeRecordDecision(dir, absoluteDir, dir, options.date));
  }

  const readmePath = join(absoluteDir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, renderReadme(absoluteDir));
    created.push(relativePath(dir, 'README.md'));
  }

  return {
    dir,
    created,
    config: {
      dir,
      format: detectAdrFormat(absoluteDir),
      gate: defaultGate(absoluteDir),
    },
  };
}
