// ---------------------------------------------------------------------------
// Architecture decision record (ADR) conformance for Junior.
//
// `parseAdr` reads one MADR Markdown file: YAML front matter
// (`id`, `title`, `status`, `date`, `supersedes?`, `applies_to`, `rules`) plus
// Context / Decision / Consequences body sections. The front matter is a small,
// hand-parsed YAML subset — no new dependency is introduced.
//
// `loadAdrs` reads a `docs/adr` directory; `lintAdrs` checks id uniqueness,
// valid statuses, supersedes chains and the accepted-ADR invariants (at least
// one rule and one applies_to). `createAdr` writes the next numbered file from
// the same template.
//
// `adr sync` publishes accepted ADR rules as an `adr` dimension through the
// existing `syncDimensions` path. `adr check` scopes each rule's `applies_to`
// against the changed files (or the code members linked by the code map),
// scores every (rule, code member) pair with `matrix-analyze.ts` on a
// conforms / contradicts / not_applicable scale, and reports contradictions and
// low-confidence cells in the `link-qc.ts` review-queue format. `--record`
// stores proposed `adr-conformance` observations; nothing is written otherwise.
//
// This module is the CLI shell behind `junior matrix adr <new|lint|sync|check>`.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import { join } from 'node:path';
import { analyze, type AnalysisInput } from './matrix-analyze.ts';
import {
  CROSSMATRIX_WRITE_SCHEMA_VERSION,
  requestIdFor,
  serverErrorDetail,
  syncDimensions,
  type SyncDimensionsResult,
} from './matrix-sync.ts';
import type { MatrixDimension } from './matrix.ts';
import type { QcFinding, QcLink } from './link-qc.ts';
import { callHop, loadHop, type CallOutcome } from './tools/tools.ts';
import { createPiClassifier, type GateClassifier } from './worker.ts';

const ADR_ID_PATTERN = /^ADR-(\d+)$/;
const ADR_FILE_PATTERN = /^(\d{4})-(.+)\.md$/;
const VALID_STATUSES = new Set<AdrStatus>(['proposed', 'accepted', 'superseded', 'deprecated']);
const MEMBER_PREFIXES = ['feature', 'cpm', 'job', 'journey', 'fm', 'outcome', 'loc', 'test'];

export type AdrStatus = 'proposed' | 'accepted' | 'superseded' | 'deprecated';

export interface AdrRule {
  id: string;
  text: string;
}

export interface Adr {
  id: string;
  number: number;
  title: string;
  status: AdrStatus;
  date: string;
  supersedes: string[];
  appliesTo: string[];
  rules: AdrRule[];
  context: string;
  decision: string;
  consequences: string;
  /** Source path when the record was loaded from disk; '' otherwise. */
  path: string;
}

export type AdrFindingSeverity = 'error' | 'warning';

export interface AdrLintFinding {
  severity: AdrFindingSeverity;
  adrId: string | null;
  code: string;
  message: string;
}

export interface AdrDeps {
  callHop?: typeof callHop;
  loadHop?: typeof loadHop;
}

export const CONFORMANCE_SCALE = [
  { id: 'conforms', label: 'Conforms', score: 1 },
  { id: 'contradicts', label: 'Contradicts', score: -1 },
  { id: 'not_applicable', label: 'Not applicable', score: 0 },
] as const;

export interface AdrCheckPair {
  adrId: string;
  ruleId: string;
  rule: string;
  target: string;
  optionId: string | null;
  probability: number | null;
  confidence: 'high' | 'medium' | 'low' | null;
  known: boolean;
}

export interface AdrCheckResult {
  modelId: string;
  pairs: AdrCheckPair[];
  findings: QcFinding[];
  recorded: number;
}

export interface AdrCheckOptions {
  /** Directory holding the `NNNN-*.md` ADR files. */
  dir: string;
  changedFiles?: readonly string[];
  resultPath?: string;
  hopPath?: string;
  modelId?: string;
  record?: boolean;
  classify?: GateClassifier;
  deps?: AdrDeps;
}

export const ADR_USAGE = [
  'Usage: junior matrix adr new <title> [--dir <adb/adr dir>] [--status proposed|accepted] [--date YYYY-MM-DD]',
  '       junior matrix adr lint [--dir <adr dir>]',
  '       junior matrix adr sync --hop <hop.json> --model <modelId> [--dir <adr dir>]',
  '       junior matrix adr check --hop <hop.json> --model <modelId> [--dir <adr dir>]',
  '             [--changed <file...> | --result <result.json>] [--record] [--markdown <file>]',
].join('\n');

// ---------------------------------------------------------------------------
// Front matter parsing (small YAML subset, no dependency)
// ---------------------------------------------------------------------------

function parseScalar(raw: string): string {
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

function parseInlineList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((entry) => parseScalar(entry))
    .filter((entry) => entry.length > 0);
}

interface FrontMatter {
  data: Record<string, unknown>;
  body: string;
}

function parseFrontMatter(markdown: string): FrontMatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) throw new Error('ADR is missing YAML front matter');
  const data: Record<string, unknown> = {};
  let listKey: string | null = null;
  let inRules = false;
  let currentRule: Record<string, unknown> | null = null;

  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;

    if (indent === 0) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      listKey = null;
      inRules = false;
      currentRule = null;

      if (key === 'rules') {
        if (value && value !== '[]') {
          data.rules = [];
        } else {
          data.rules = [];
          inRules = value !== '[]';
        }
      } else if (key === 'supersedes' || key === 'applies_to') {
        if (value.startsWith('[')) data[key] = parseInlineList(value);
        else if (value) data[key] = [parseScalar(value)];
        else {
          data[key] = [];
          listKey = key;
        }
      } else {
        data[key] = parseScalar(value);
      }
      continue;
    }

    if (inRules) {
      if (line.startsWith('-')) {
        currentRule = {};
        (data.rules as Record<string, unknown>[]).push(currentRule);
        const rest = line.replace(/^-\s*/, '');
        const colon = rest.indexOf(':');
        if (colon !== -1) currentRule[rest.slice(0, colon).trim()] = parseScalar(rest.slice(colon + 1));
      } else if (currentRule) {
        const colon = line.indexOf(':');
        if (colon !== -1) currentRule[line.slice(0, colon).trim()] = parseScalar(line.slice(colon + 1));
      }
      continue;
    }

    if (listKey && line.startsWith('-')) {
      (data[listKey] as string[]).push(parseScalar(line.replace(/^-\s*/, '')));
    }
  }

  return { data, body: markdown.slice(match[0].length) };
}

function bodySection(body: string, heading: string): string {
  const headingMatch = new RegExp(`^##\\s+${heading}\\s*$`, 'im').exec(body);
  if (!headingMatch) return '';
  const rest = body.slice(headingMatch.index + headingMatch[0].length);
  const next = /^##\s+/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry)).filter((entry) => entry.length > 0);
}

/** Parse one MADR document. Throws when the front matter is malformed. */
export function parseAdr(markdown: string, path = ''): Adr {
  const { data, body } = parseFrontMatter(markdown);
  const id = String(data.id ?? '').trim();
  if (!id) throw new Error('ADR front matter requires an id');
  const idMatch = ADR_ID_PATTERN.exec(id);
  const rules = Array.isArray(data.rules)
    ? (data.rules as Array<Record<string, unknown>>).map((rule) => ({
        id: String(rule.id ?? '').trim(),
        text: String(rule.text ?? '').trim(),
      }))
    : [];
  return {
    id,
    number: idMatch ? Number(idMatch[1]) : Number.NaN,
    title: String(data.title ?? '').trim(),
    status: String(data.status ?? 'proposed').trim() as AdrStatus,
    date: String(data.date ?? '').trim(),
    supersedes: stringList(data.supersedes),
    appliesTo: stringList(data.applies_to),
    rules,
    context: bodySection(body, 'Context'),
    decision: bodySection(body, 'Decision'),
    consequences: bodySection(body, 'Consequences'),
    path,
  };
}

/** Load and number-sort every `NNNN-*.md` record in `dir` (empty when absent). */
export function loadAdrs(dir: string): Adr[] {
  if (!fs.existsSync(dir)) return [];
  const adrs: Adr[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!ADR_FILE_PATTERN.test(name)) continue;
    const path = join(dir, name);
    adrs.push(parseAdr(fs.readFileSync(path, 'utf8'), path));
  }
  adrs.sort((a, b) => (Number.isNaN(a.number) ? 0 : a.number) - (Number.isNaN(b.number) ? 0 : b.number) || a.id.localeCompare(b.id));
  return adrs;
}

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

function finding(severity: AdrFindingSeverity, adrId: string | null, code: string, message: string): AdrLintFinding {
  return { severity, adrId, code, message };
}

/** All structural problems in a set of records, in a stable order. */
export function lintAdrs(adrs: Adr[]): AdrLintFinding[] {
  const findings: AdrLintFinding[] = [];
  const byId = new Map<string, Adr>();
  for (const adr of adrs) {
    if (byId.has(adr.id)) {
      findings.push(finding('error', adr.id, 'duplicate-id', `duplicate ADR id ${adr.id}`));
    } else {
      byId.set(adr.id, adr);
    }
  }

  for (const adr of adrs) {
    if (!VALID_STATUSES.has(adr.status)) {
      findings.push(finding('error', adr.id, 'invalid-status', `invalid status '${adr.status}'`));
    }
    for (const ref of adr.supersedes) {
      const target = byId.get(ref);
      if (!target) {
        findings.push(finding('error', adr.id, 'missing-supersedes', `${adr.id} supersedes missing ${ref}`));
      } else if (target.status === 'accepted' && adr.status === 'accepted') {
        findings.push(
          finding('error', target.id, 'superseded-still-accepted', `${target.id} is superseded by ${adr.id} but is still accepted`),
        );
      }
    }
    if (adr.status === 'accepted') {
      if (adr.rules.length === 0) {
        findings.push(finding('error', adr.id, 'missing-rules', `${adr.id} is accepted but has no rules`));
      }
      if (adr.appliesTo.length === 0) {
        findings.push(finding('error', adr.id, 'missing-applies-to', `${adr.id} is accepted but has no applies_to`));
      }
    }
  }
  return findings;
}

/** Throw when any lint finding is an error; used by the CLI before syncing. */
export function assertLintClean(adrs: Adr[]): void {
  const errors = lintAdrs(adrs).filter((entry) => entry.severity === 'error');
  if (errors.length > 0) throw new Error(errors.map((entry) => entry.message).join('; '));
}

// ---------------------------------------------------------------------------
// adr new
// ---------------------------------------------------------------------------

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'adr';
}

export function renderAdrTemplate(options: {
  id: string;
  number: number;
  title: string;
  status: AdrStatus;
  date: string;
}): string {
  return [
    '---',
    `id: ${options.id}`,
    `title: ${options.title}`,
    `status: ${options.status}`,
    `date: ${options.date}`,
    'supersedes: []',
    'applies_to: []',
    'rules: []',
    '---',
    '',
    '## Context',
    '',
    '<!-- What is the issue that we are seeing that is motivating this decision? -->',
    '',
    '## Decision',
    '',
    '<!-- What is the change that we are proposing and/or doing? -->',
    '',
    '## Consequences',
    '',
    '<!-- What becomes easier or more difficult because of this change? -->',
    '',
  ].join('\n');
}

export interface CreateAdrResult {
  path: string;
  adr: Adr;
}

export interface CreateAdrOptions {
  date?: string;
  status?: AdrStatus;
}

/** Write the next numbered `NNNN-<slug>.md` record into `dir`. */
export function createAdr(dir: string, title: string, options: CreateAdrOptions = {}): CreateAdrResult {
  fs.mkdirSync(dir, { recursive: true });
  let next = 1;
  for (const name of fs.readdirSync(dir)) {
    const match = ADR_FILE_PATTERN.exec(name);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  const padded = String(next).padStart(4, '0');
  const id = `ADR-${padded}`;
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const status = options.status ?? 'proposed';
  const path = join(dir, `${padded}-${slugify(title)}.md`);
  fs.writeFileSync(path, renderAdrTemplate({ id, number: next, title, status, date }));
  return { path, adr: parseAdr(fs.readFileSync(path, 'utf8'), path) };
}

// ---------------------------------------------------------------------------
// Dimension
// ---------------------------------------------------------------------------

/** Accepted ADR rules as one `adr` dimension (`adr:ADR-0001/R1` members). */
export function adrDimension(adrs: Adr[]): MatrixDimension {
  const members: MatrixDimension['members'] = [];
  for (const adr of adrs) {
    if (adr.status !== 'accepted') continue;
    for (const rule of adr.rules) {
      members.push({
        id: `adr:${adr.id}/${rule.id}`,
        label: rule.text.slice(0, 120) || rule.id,
        attributes: { adr: adr.id, rule: rule.id, status: adr.status, appliesTo: adr.appliesTo },
      });
    }
  }
  return { id: 'adr', label: 'Architecture decision records', kind: 'context', order: 0, system: 'junior-adr', members };
}

// ---------------------------------------------------------------------------
// Scoping
// ---------------------------------------------------------------------------

function normalizePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isDeliveryPath(p: string): boolean {
  return p === '.delivery' || p.startsWith('.delivery/');
}

function isGlob(entry: string): boolean {
  return entry.includes('*') || entry.includes('?') || entry.includes('[');
}

/** Match one `applies_to` entry (glob, literal path or `loc:` member) to a path. */
export function matchesAppliesTo(entry: string, path: string): boolean {
  if (entry.startsWith('loc:')) entry = entry.slice(4);
  if (isGlob(entry)) return globToRegExp(entry).test(path);
  if (entry.endsWith('/')) return path.startsWith(entry);
  return entry === path;
}

/** Compile a glob where `**` crosses path separators and `*` stays in a segment. */
export function globToRegExp(glob: string): RegExp {
  let source = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`${source}$`);
}

function isMemberRef(entry: string): boolean {
  const colon = entry.indexOf(':');
  if (colon === -1) return false;
  return MEMBER_PREFIXES.includes(entry.slice(0, colon));
}

/** Changed files from a handoff `result.json`, excluding `.delivery/`. */
export function changedFilesFromResult(resultPath: string): string[] {
  const doc: unknown = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const record = typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>) : {};
  const evidence = typeof record.evidence === 'object' && record.evidence !== null ? (record.evidence as Record<string, unknown>) : {};
  const raw = evidence.runChangedFiles ?? evidence.changedFiles ?? [];
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((entry) => (typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).path : undefined))
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map(normalizePath)
    .filter((p) => !isDeliveryPath(p));
}

// ---------------------------------------------------------------------------
// Crossmatrix read helpers (code-map members)
// ---------------------------------------------------------------------------

interface CrossmatrixQuery {
  kind: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function query(call: typeof callHop, hopPath: string, modelId: string, q: CrossmatrixQuery): Promise<unknown> {
  const outcome = await call(hopPath, 'crossmatrix', {
    tool: 'crossmatrix.query',
    arguments: { request: { schemaVersion: CROSSMATRIX_WRITE_SCHEMA_VERSION, modelId, query: q } },
  });
  if (!outcome.ok) {
    const detail = serverErrorDetail(outcome) ?? outcome.error?.message ?? outcome.note ?? 'unknown error';
    throw new Error(`adr check ${q.kind} failed: ${detail}`);
  }
  return outcome.result;
}

function nextCursorOf(page: unknown): string | undefined {
  if (!isRecord(page)) return undefined;
  const next = page.nextCursor;
  if (next === undefined || next === null || next === '') return undefined;
  return String(next);
}

/** Members linked out of `member` to `loc:` code locations, via `trace`. */
async function loadMemberPaths(
  call: typeof callHop,
  hopPath: string,
  modelId: string,
  member: string,
): Promise<string[]> {
  const paths = new Set<string>();
  try {
    let cursor: string | undefined;
    do {
      const q: CrossmatrixQuery = { kind: 'trace', member };
      if (cursor !== undefined) q.cursor = cursor;
      const page = await query(call, hopPath, modelId, q);
      const hops = isRecord(page) && Array.isArray(page.hops) ? page.hops : [];
      for (const hop of hops) {
        if (!isRecord(hop)) continue;
        if (hop.direction && hop.direction !== 'out') continue;
        const endpoint = typeof hop.member === 'string' ? hop.member : '';
        if (endpoint.startsWith('loc:')) paths.add(endpoint.slice(4));
      }
      cursor = nextCursorOf(page);
    } while (cursor !== undefined);
  } catch {
    /* an unresolved member contributes no targets */
  }
  return [...paths].sort();
}

/** All `loc:` code members of the model, linked by any code-map relation. */
async function loadCodeMembers(call: typeof callHop, hopPath: string, modelId: string): Promise<string[]> {
  const paths = new Set<string>();
  let relations: Array<Record<string, unknown>> = [];
  try {
    const described = await query(call, hopPath, modelId, { kind: 'describe' });
    const doc = isRecord(described) && isRecord(described.describe) ? described.describe : {};
    relations = Array.isArray(doc.relations) ? (doc.relations as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
  for (const relation of relations) {
    const relationId = typeof relation.id === 'string' ? relation.id : '';
    if (!relationId) continue;
    try {
      let cursor: string | undefined;
      do {
        const q: CrossmatrixQuery = { kind: 'slice', relationId };
        if (cursor !== undefined) q.cursor = cursor;
        const page = await query(call, hopPath, modelId, q);
        const cells = isRecord(page) && Array.isArray(page.cells) ? page.cells : [];
        for (const cell of cells) {
          if (!isRecord(cell)) continue;
          for (const endpoint of [cell.from, cell.to]) {
            if (typeof endpoint === 'string' && endpoint.startsWith('loc:')) paths.add(endpoint.slice(4));
          }
        }
        cursor = nextCursorOf(page);
      } while (cursor !== undefined);
    } catch {
      /* a relation that does not support slice contributes nothing */
    }
  }
  return [...paths].sort();
}

// ---------------------------------------------------------------------------
// adr check
// ---------------------------------------------------------------------------

function toLink(pair: AdrCheckPair): QcLink {
  return {
    from: `adr:${pair.adrId}/${pair.ruleId}`,
    to: `loc:${pair.target}`,
    relation: 'adr-conformance',
    observation: pair.optionId ?? 'unknown',
    confidence: pair.confidence,
    rationale: `Jev judged ${pair.ruleId} on ${pair.target}`,
    excerpts: [pair.rule],
    observedAt: null,
  };
}

function makeFinding(kind: QcFinding['kind'], action: QcFinding['suggestedAction'], pair: AdrCheckPair, reason: string): QcFinding {
  const entry: QcFinding = { id: '', kind, link: toLink(pair), reason, suggestedAction: action };
  if (pair.probability !== null) entry.probability = pair.probability;
  return entry;
}

/**
 * Score every scoped (rule, code member) pair and turn contradictions and
 * low-confidence cells into review-queue findings. Nothing is written unless
 * `record` is set.
 */
export async function adrCheck(options: AdrCheckOptions): Promise<AdrCheckResult> {
  const call = options.deps?.callHop ?? callHop;
  const load = options.deps?.loadHop ?? loadHop;
  const adrs = loadAdrs(options.dir).filter((adr) => adr.status === 'accepted');

  let changed: string[] | null = options.changedFiles ? [...options.changedFiles].map(normalizePath) : null;
  if (!changed && options.resultPath) changed = changedFilesFromResult(options.resultPath);

  const codeMembersCache: { value: string[] | null } = { value: null };
  const allCodeMembers = async (): Promise<string[]> => {
    if (codeMembersCache.value) return codeMembersCache.value;
    if (!options.hopPath || !options.modelId) return [];
    codeMembersCache.value = await loadCodeMembers(call, options.hopPath, options.modelId);
    return codeMembersCache.value;
  };

  const targetsFor = async (adr: Adr): Promise<string[]> => {
    const targets = new Set<string>();
    for (const entry of adr.appliesTo) {
      if (isMemberRef(entry) && !entry.startsWith('loc:')) {
        if (!options.hopPath || !options.modelId) continue;
        const resolved = await loadMemberPaths(call, options.hopPath, options.modelId, entry);
        for (const path of resolved) if (!changed || changed.includes(path)) targets.add(path);
      } else {
        const pool = changed ?? (await allCodeMembers());
        for (const path of pool) if (matchesAppliesTo(entry, path)) targets.add(path);
      }
    }
    return [...targets].sort();
  };

  const pairs: AdrCheckPair[] = [];
  for (const adr of adrs) {
    const targets = await targetsFor(adr);
    if (targets.length === 0) continue;
    const criteria = targets.map((target) => ({
      id: target,
      label: target,
      question: `The code location "${target}" — does it conform to this architecture decision rule?`,
      weight: 1,
      scale: CONFORMANCE_SCALE.map((option) => ({ ...option })),
    }));
    for (const rule of adr.rules) {
      const input: AnalysisInput = {
        items: [{ id: `${adr.id}/${rule.id}`, label: rule.text }],
        criteria,
      };
      const result = await analyze({
        input,
        classify: options.classify,
        deps: { callHop: call, loadHop: load },
      });
      for (const cell of result.cells) {
        pairs.push({
          adrId: adr.id,
          ruleId: rule.id,
          rule: rule.text,
          target: cell.criterionId,
          optionId: cell.optionId,
          probability: cell.probability,
          confidence: cell.confidence,
          known: cell.known,
        });
      }
    }
  }

  const findings: QcFinding[] = [];
  for (const pair of pairs) {
    if (pair.optionId === 'contradicts') {
      findings.push(makeFinding('contradiction', 'investigate', pair, `${pair.adrId}/${pair.ruleId} contradicts ${pair.target}`));
    } else if (!pair.known) {
      findings.push(makeFinding('uncertain', 'investigate', pair, `conformance of ${pair.adrId}/${pair.ruleId} to ${pair.target} is uncertain`));
    }
  }

  let recorded = 0;
  if (options.record) {
    if (!options.hopPath || !options.modelId) throw new Error('adr check --record requires --hop <hop.json> and --model <modelId>');
    recorded = await recordConformance({
      adrs,
      pairs,
      hopPath: options.hopPath,
      modelId: options.modelId,
      deps: { callHop: call, loadHop: load },
    });
  }

  return { modelId: options.modelId ?? '', pairs, findings, recorded };
}

// ---------------------------------------------------------------------------
// adr sync / record
// ---------------------------------------------------------------------------

export interface AdrSyncOptions {
  hopPath: string;
  modelId: string;
  dir: string;
  deps?: AdrDeps;
}

/** Publish accepted ADR rules as an `adr` dimension. */
export async function adrSync(options: AdrSyncOptions): Promise<SyncDimensionsResult> {
  const adrs = loadAdrs(options.dir);
  return syncDimensions({
    hopPath: options.hopPath,
    modelId: options.modelId,
    dimensions: [adrDimension(adrs)],
    deps: options.deps,
  });
}

interface RecordConformanceOptions {
  adrs: Adr[];
  pairs: AdrCheckPair[];
  hopPath: string;
  modelId: string;
  deps?: AdrDeps;
}

async function sendCommand(
  call: typeof callHop,
  hopPath: string,
  modelId: string,
  op: Record<string, unknown>,
  requestId: string,
): Promise<void> {
  const request = {
    schemaVersion: CROSSMATRIX_WRITE_SCHEMA_VERSION,
    requestId,
    modelId,
    actor: { actorType: 'system', persona: 'model_admin' },
    op,
  };
  const outcome: CallOutcome = await call(hopPath, 'crossmatrix', {
    tool: 'crossmatrix.command',
    arguments: { request },
  });
  if (!outcome.ok) {
    const detail = serverErrorDetail(outcome) ?? outcome.error?.message ?? outcome.note ?? 'unknown error';
    throw new Error(`adr conformance ${String(op.kind)} failed: ${detail}`);
  }
}

async function recordConformance(options: RecordConformanceOptions): Promise<number> {
  const call = options.deps?.callHop ?? callHop;
  await syncDimensions({
    hopPath: options.hopPath,
    modelId: options.modelId,
    dimensions: [adrDimension(options.adrs)],
    deps: options.deps,
  });

  const levels = CONFORMANCE_SCALE.map((option) => ({ id: option.id, label: option.label }));
  const version = levels.map((entry) => entry.id).join(',');
  await sendCommand(
    call,
    options.hopPath,
    options.modelId,
    { kind: 'scale.declare', scale: { id: 'adr-conformance', mode: 'categorical', levels } },
    requestIdFor(options.modelId, 'scale.declare', 'adr-conformance', version),
  );
  await sendCommand(
    call,
    options.hopPath,
    options.modelId,
    { kind: 'relation.declare', relationId: 'adr-conformance', from: 'adr', to: 'code', relationType: 'conforms', scale: 'adr-conformance', coveragePolicy: 'none' },
    requestIdFor(options.modelId, 'relation.declare', 'adr-conformance', 'adr|code|conforms'),
  );

  let recorded = 0;
  for (const pair of options.pairs) {
    if (pair.optionId === null) continue;
    const from = `adr:${pair.adrId}/${pair.ruleId}`;
    const to = `loc:${pair.target}`;
    const content = `${from}|${to}|${pair.optionId}|${pair.probability}`;
    await sendCommand(
      call,
      options.hopPath,
      options.modelId,
      {
        kind: 'observe',
        relationId: 'adr-conformance',
        from,
        to,
        observation: pair.optionId,
        provenanceClass: 'jev',
        confidence: pair.confidence ?? 'low',
        evidence: [
          {
            sourceRef: { system: 'junior', sourceType: 'adr', sourceRef: from, locator: pair.target },
            locator: pair.target,
            excerpt: pair.rule,
          },
        ],
        rationale: `Jev judged ${pair.ruleId} on ${pair.target} with probability ${pair.probability}`,
      },
      requestIdFor(options.modelId, 'observe', 'adr-conformance', content),
    );
    recorded += 1;
  }
  return recorded;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export function renderAdrCheckMarkdown(result: AdrCheckResult): string {
  const lines = ['# ADR conformance', '', `| ADR | Rule | Target | Verdict | Confidence |`, '| --- | --- | --- | --- | --- |'];
  for (const pair of result.pairs) {
    lines.push(`| ${pair.adrId} | ${pair.ruleId} | ${pair.target} | ${pair.optionId ?? 'unknown'} | ${pair.confidence ?? 'n/a'} |`);
  }
  lines.push('', '## Review', '');
  if (result.findings.length === 0) lines.push('_No findings._');
  else for (const entry of result.findings) lines.push(`- ${entry.kind}: ${entry.reason}`);
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function defaultAdrDir(): string {
  return join(process.cwd(), 'docs', 'adr');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runAdrNew(argv: string[]): Promise<number> {
  let dir = defaultAdrDir();
  let date: string | undefined;
  let status: AdrStatus = 'proposed';
  const titleParts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') dir = argv[++i] ?? dir;
    else if (arg.startsWith('--dir=')) dir = arg.slice('--dir='.length);
    else if (arg === '--date') date = argv[++i];
    else if (arg.startsWith('--date=')) date = arg.slice('--date='.length);
    else if (arg === '--status') status = (argv[++i] as AdrStatus) ?? status;
    else if (arg.startsWith('--status=')) status = arg.slice('--status='.length) as AdrStatus;
    else titleParts.push(arg);
  }
  const title = titleParts.join(' ').trim();
  if (!title) throw new Error('Usage: junior matrix adr new <title> [--dir <adr dir>]');
  const created = createAdr(dir, title, { date, status });
  process.stdout.write(`${created.path}\n`);
  return 0;
}

function runAdrLint(argv: string[]): number {
  let dir = defaultAdrDir();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') dir = argv[++i] ?? dir;
    else if (arg.startsWith('--dir=')) dir = arg.slice('--dir='.length);
  }
  const findings = lintAdrs(loadAdrs(dir));
  process.stdout.write(`${JSON.stringify({ findings }, null, 2)}\n`);
  return findings.some((entry) => entry.severity === 'error') ? 1 : 0;
}

async function runAdrSync(argv: string[]): Promise<number> {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') values.dir = argv[++i];
    else if (arg.startsWith('--dir=')) values.dir = arg.slice('--dir='.length);
    else if (arg === '--hop') values.hop = argv[++i];
    else if (arg.startsWith('--hop=')) values.hop = arg.slice('--hop='.length);
    else if (arg === '--model') values.model = argv[++i];
    else if (arg.startsWith('--model=')) values.model = arg.slice('--model='.length);
  }
  if (!values.hop) throw new Error('matrix adr sync requires --hop <hop.json>');
  if (!values.model) throw new Error('matrix adr sync requires --model <modelId>');
  const result = await adrSync({ hopPath: values.hop, modelId: values.model, dir: values.dir ?? defaultAdrDir() });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

interface CheckArgs {
  hop?: string;
  model?: string;
  dir: string;
  changed: string[];
  result?: string;
  record: boolean;
  markdown?: string;
}

function parseCheckArgs(argv: string[]): CheckArgs {
  const args: CheckArgs = { dir: defaultAdrDir(), changed: [], record: false };
  const valueFlags = ['--hop', '--model', '--dir', '--result', '--markdown'];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--record') {
      args.record = true;
      continue;
    }
    if (arg === '--changed') {
      let next = argv[i + 1];
      while (next !== undefined && !next.startsWith('--')) {
        args.changed.push(...next.split(',').map((entry) => entry.trim()).filter(Boolean));
        i += 1;
        next = argv[i + 1];
      }
      continue;
    }
    if (arg.startsWith('--changed=')) {
      args.changed.push(...arg.slice('--changed='.length).split(',').map((entry) => entry.trim()).filter(Boolean));
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!valueFlags.includes(name)) throw new Error(`Unknown option for matrix adr check: ${arg}`);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined) value = argv[++i];
    if (value === undefined || value === '') throw new Error(`Option ${name} requires a value`);
    if (name === '--hop') args.hop = value;
    else if (name === '--model') args.model = value;
    else if (name === '--dir') args.dir = value;
    else if (name === '--result') args.result = value;
    else if (name === '--markdown') args.markdown = value;
  }
  return args;
}

async function runAdrCheck(argv: string[]): Promise<number> {
  const args = parseCheckArgs(argv);
  if (!args.hop) throw new Error('matrix adr check requires --hop <hop.json>');
  if (!args.model) throw new Error('matrix adr check requires --model <modelId>');
  const classify = await createPiClassifier();
  const result = await adrCheck({
    dir: args.dir,
    hopPath: args.hop,
    modelId: args.model,
    changedFiles: args.changed.length > 0 ? args.changed : undefined,
    resultPath: args.result,
    record: args.record,
    classify,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (args.markdown) fs.writeFileSync(args.markdown, renderAdrCheckMarkdown(result));
  return 0;
}

/** Thin CLI shell for `junior matrix adr <new|lint|sync|check>`. */
export async function runAdr(argv: string[]): Promise<number> {
  const subcommand = argv[0];
  try {
    if (subcommand === 'new') return await runAdrNew(argv.slice(1));
    if (subcommand === 'lint') return runAdrLint(argv.slice(1));
    if (subcommand === 'sync') return await runAdrSync(argv.slice(1));
    if (subcommand === 'check') return await runAdrCheck(argv.slice(1));
    process.stderr.write(`${ADR_USAGE}\n`);
    return 1;
  } catch (err) {
    process.stderr.write(`${message(err)}\n`);
    return 1;
  }
}
