// ---------------------------------------------------------------------------
// Crossmatrix ADR-0004 Dimensions adapters.
//
// Each `*Dimension` export is a PURE adapter: it takes already-read data
// (file bytes, parsed JSON, parsed plan/state graphs) and returns one ADR-0004
// Dimension object. The `junior matrix export` CLI is the thin, side-effecting
// shell around them: it gathers tracked files, reads the jevitate catalog, or
// performs the single `cpm plan.get` / `fmeca state.get` read through the
// existing HOP wrapper, then writes one canonical Dimensions document per
// source through `writeDimensionSet`.
//
// No new dependencies: canonical JSON, hashing and the schema subset checks are
// implemented here. The vendored schema is never modified.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isDirectEntry } from './cli-entry.ts';
import { callHop } from './tools/tools.ts';

export type DimensionKind =
  | 'customer_requirement'
  | 'engineering_characteristic'
  | 'stakeholder_priority'
  | 'option'
  | 'criterion'
  | 'constraint'
  | 'implementation_asset'
  | 'test_artifact'
  | 'business_metric'
  | 'failure_mode'
  | 'jtbd_step'
  | 'context'
  | 'code_element';

export interface MatrixSourceRef {
  system: string;
  sourceType: string;
  sourceRef: string;
  locator: string;
  contentHash: string;
}

export interface MatrixMember {
  id: string;
  label?: string;
  weightObservation?: string;
  weight?: number;
  sourceRef?: MatrixSourceRef;
  status?: 'active' | 'deprecated';
  supersededBy?: string;
  attributes?: Record<string, unknown>;
}

export interface MatrixDimension {
  id: string;
  label?: string;
  kind?: DimensionKind;
  order: number;
  system?: string;
  weightSemantics?: string;
  weightScale?: string;
  members: MatrixMember[];
}

export interface DimensionsDocument {
  schemaVersion: string;
  dimensionSetId: string;
  version: string;
  dimensions: MatrixDimension[];
}

/** A tracked file (or fixture) with its bytes. Pure adapters never read disk. */
export interface MatrixFile {
  path: string;
  content?: string | Uint8Array;
  bytes?: string | Uint8Array;
  data?: string | Uint8Array;
}

function fileBytes(entry: MatrixFile): string | Uint8Array {
  return entry.content ?? entry.bytes ?? entry.data ?? '';
}

// ---------------------------------------------------------------------------
// Canonical JSON + hashing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively sort object keys so equal data always serializes identically. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

/** Canonical JSON: recursively sorted keys, 2-space indent, no trailing newline. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function contentHash(data: string | Uint8Array): string {
  return `sha256:${sha256Hex(data)}`;
}

function stableHash(value: unknown): string {
  return contentHash(canonicalJson(value));
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function normalizePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '');
}

function parentOf(p: string): string {
  const parent = path.posix.dirname(p);
  return parent === '.' ? '' : parent;
}

function isTestPath(p: string): boolean {
  const base = path.posix.basename(p);
  if (/\.(test|spec)\./.test(base)) return true;
  return p.split('/').slice(0, -1).some((seg) => seg === 'test' || seg === 'tests' || seg === '__tests__');
}

// ---------------------------------------------------------------------------
// File-driven dimensions (`code`, `tests`)
// ---------------------------------------------------------------------------

function fileMember(p: string, hash: string, type: 'file' | 'dir', prefix = 'loc'): MatrixMember {
  return {
    id: `${prefix}:${p}`,
    label: p,
    status: 'active',
    attributes: { path: p, parent: parentOf(p), type },
    sourceRef: {
      system: 'git',
      sourceType: type === 'file' ? 'file' : 'directory',
      sourceRef: p,
      locator: p,
      contentHash: hash,
    },
  };
}

/**
 * Build a `code_element`/`test_artifact` dimension. One member per selected
 * file plus one per ancestor directory. A file hash is over its bytes; a
 * directory hash is over its sorted children's ids and hashes.
 */
function fileDimension(
  id: string,
  label: string,
  kind: DimensionKind,
  files: MatrixFile[],
  selected: (p: string) => boolean,
  // Member ids are unique across a whole Crossmatrix model, so each file
  // dimension needs its own prefix (code `loc:`, tests `test:`).
  prefix = 'loc',
  // Directory members roll files up for the code map; a filtered dimension
  // (tests) lists files only, so its directories never shadow the code
  // dimension's under the same source key.
  includeDirs = true,
): MatrixDimension {
  const fileHashes = new Map<string, string>();
  for (const entry of files) {
    const p = normalizePath(entry.path);
    if (!selected(p)) continue;
    fileHashes.set(p, contentHash(fileBytes(entry)));
  }

  const dirs = new Set<string>();
  for (const p of fileHashes.keys()) {
    let dir = parentOf(p);
    while (dir) {
      dirs.add(dir);
      dir = parentOf(dir);
    }
  }

  const dirHashes = new Map<string, string>();
  const byDepth = [...dirs].sort(
    (a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b),
  );
  for (const dir of byDepth) {
    const children: Array<{ id: string; hash: string }> = [];
    // Hash over child paths (not prefixed member ids) so a directory hashes the
    // same in every file dimension that shares its source key.
    for (const [p, hash] of fileHashes) if (parentOf(p) === dir) children.push({ id: p, hash });
    for (const sub of dirs) if (sub !== dir && parentOf(sub) === dir) children.push({ id: sub, hash: dirHashes.get(sub)! });
    children.sort((a, b) => a.id.localeCompare(b.id));
    dirHashes.set(dir, stableHash(children));
  }

  const members: MatrixMember[] = [];
  for (const p of [...fileHashes.keys()].sort()) members.push(fileMember(p, fileHashes.get(p)!, 'file', prefix));
  if (includeDirs) for (const dir of [...dirs].sort()) members.push(fileMember(dir, dirHashes.get(dir)!, 'dir', prefix));

  return { id, label, kind, order: 0, system: 'git', members };
}

/** Tracked code locations: one member per file and per ancestor directory. */
export function codeLocations(files: MatrixFile[]): MatrixDimension {
  return fileDimension('code', 'Code locations', 'code_element', files, () => true);
}

/** Test artifacts: files matching `*.test.*`/`*.spec.*` or under test dirs. */
export function tests(files: MatrixFile[]): MatrixDimension {
  return fileDimension('tests', 'Test artifacts', 'test_artifact', files, isTestPath, 'test', false);
}

// ---------------------------------------------------------------------------
// Jevitate dimensions
// ---------------------------------------------------------------------------

function jobsFrom(json: unknown): any[] {
  if (Array.isArray(json)) return json;
  if (isRecord(json) && Array.isArray(json.jobs)) return json.jobs;
  return [];
}

function personaId(persona: unknown): string {
  if (typeof persona === 'string') return persona;
  if (isRecord(persona)) return String(persona.id ?? persona.name ?? '');
  return '';
}

function personaLabel(persona: unknown): string {
  if (typeof persona === 'string') return persona;
  if (isRecord(persona)) return String(persona.name ?? persona.label ?? persona.id ?? '');
  return '';
}

function personaAttributes(persona: unknown): Record<string, unknown> {
  if (!isRecord(persona)) return {};
  const { id: _id, name: _name, label: _label, ...rest } = persona;
  return rest;
}

/** Numeric weight for a desired outcome from its priority and gulf. */
const OUTCOME_PRIORITY_WEIGHT: Record<string, number> = { high: 3, medium: 2, low: 1 };
const OUTCOME_GULF_WEIGHT: Record<string, number> = { execution: 2, evaluation: 1 };

function desiredOutcomeWeight(priority: unknown, gulf: unknown): number {
  const priorityScore = OUTCOME_PRIORITY_WEIGHT[String(priority ?? '')] ?? 1;
  const gulfScore = OUTCOME_GULF_WEIGHT[String(gulf ?? '')] ?? 1;
  return priorityScore * gulfScore;
}

/** Customer requirements from `.jevitate/jobs.json`; priority is categorical. */
export function jevitateJobs(json: unknown): MatrixDimension {
  const jobMembers: MatrixMember[] = jobsFrom(json).map((job) => {
    const id = String(job.id ?? job.name ?? '');
    const member: MatrixMember = {
      id: `job:${id}`,
      label: String(job.name ?? job.title ?? id),
      status: 'active',
      attributes: {
        outcome: job.outcome ?? null,
        personas: Array.isArray(job.personas) ? job.personas : [],
      },
      sourceRef: {
        system: 'jevitate',
        sourceType: 'job',
        sourceRef: `jevitate:${id}`,
        locator: '.jevitate/jobs.json',
        contentHash: stableHash(job),
      },
    };
    if (typeof job.priority === 'string' && job.priority) member.weightObservation = job.priority;
    return member;
  });
  // Desired outcomes are requirement members of the same dimension, weighted
  // deterministically from their (or the job's) priority and gulf.
  const outcomeMembers: MatrixMember[] = [];
  for (const job of jobsFrom(json)) {
    const jobId = String(job.id ?? job.name ?? '');
    for (const outcome of Array.isArray(job.desiredOutcomes) ? job.desiredOutcomes : []) {
      if (!isRecord(outcome)) continue;
      const outcomeId = String(outcome.id ?? outcome.name ?? '');
      if (!outcomeId) continue;
      const member: MatrixMember = {
        id: `job:${jobId}/outcome:${outcomeId}`,
        label: String(outcome.object ?? outcome.measure ?? outcomeId),
        status: 'active',
        attributes: {
          job: jobId,
          direction: outcome.direction ?? null,
          measure: outcome.measure ?? null,
          object: outcome.object ?? null,
          gulf: outcome.gulf ?? null,
          target: outcome.target ?? null,
          guardrail: outcome.guardrail ?? false,
        },
        sourceRef: {
          system: 'jevitate',
          sourceType: 'desired_outcome',
          sourceRef: `jevitate:${jobId}/outcome:${outcomeId}`,
          locator: '.jevitate/jobs.json',
          contentHash: stableHash(outcome),
        },
      };
      member.weight = desiredOutcomeWeight(outcome.priority ?? job.priority, outcome.gulf);
      outcomeMembers.push(member);
    }
  }
  const members: MatrixMember[] = [...jobMembers, ...outcomeMembers];
  return { id: 'jevitate-jobs', label: 'Jevitate jobs', kind: 'customer_requirement', order: 0, system: 'jevitate', members };
}

/** Personas referenced by the jevitate job catalog. */
export function jevitatePersonas(json: unknown): MatrixDimension {
  const members: MatrixMember[] = [];
  const seen = new Set<string>();
  for (const job of jobsFrom(json)) {
    for (const persona of Array.isArray(job.personas) ? job.personas : []) {
      const id = personaId(persona);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      members.push({
        id: `persona:${id}`,
        label: personaLabel(persona) || id,
        status: 'active',
        attributes: personaAttributes(persona),
        sourceRef: {
          system: 'jevitate',
          sourceType: 'persona',
          sourceRef: `jevitate:${id}`,
          locator: '.jevitate/jobs.json',
          contentHash: stableHash(persona),
        },
      });
    }
  }
  return { id: 'jevitate-personas', label: 'Jevitate personas', kind: 'context', order: 0, system: 'jevitate', members };
}

function parseJsonContent(content: string | Uint8Array): unknown {
  const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function hasHiddenDirAfterJourneys(p: string): boolean {
  const segments = p.split('/');
  const index = segments.indexOf('journeys');
  if (index === -1) return false;
  return segments.slice(index + 1).some((seg) => seg.startsWith('.'));
}

/** Journey artifacts from `.jevitate/journeys/**`, ignoring dot-directories. */
export function jevitateJourneys(files: MatrixFile[]): MatrixDimension {
  const members: MatrixMember[] = [];
  for (const entry of files) {
    const p = normalizePath(entry.path);
    if (!p.startsWith('.jevitate/journeys/') || !p.endsWith('.json')) continue;
    if (hasHiddenDirAfterJourneys(p)) continue;
    const journey = parseJsonContent(fileBytes(entry));
    const record = isRecord(journey) ? journey : {};
    const id = String(record.id ?? record.name ?? path.posix.basename(p, '.json'));
    members.push({
      id: `journey:${id}`,
      label: String(record.name ?? record.title ?? id),
      status: 'active',
      attributes: isRecord(record.attributes) ? record.attributes : {},
      sourceRef: {
        system: 'jevitate',
        sourceType: 'journey',
        sourceRef: `jevitate:${id}`,
        locator: p,
        contentHash: contentHash(fileBytes(entry)),
      },
    });
  }
  return { id: 'jevitate-journeys', label: 'Jevitate journeys', kind: 'test_artifact', order: 0, system: 'jevitate', members };
}

// ---------------------------------------------------------------------------
// CPM
// ---------------------------------------------------------------------------

function deliverablesFrom(planGraph: unknown): any[] {
  if (Array.isArray(planGraph)) return planGraph;
  if (isRecord(planGraph)) {
    if (Array.isArray(planGraph.deliverables)) return planGraph.deliverables;
    if (isRecord(planGraph.plan) && Array.isArray(planGraph.plan.deliverables)) return planGraph.plan.deliverables;
  }
  return [];
}

/** Implementation assets from a CPM plan graph. */
export function cpmDeliverables(planGraph: unknown, planId: string): MatrixDimension {
  const members: MatrixMember[] = deliverablesFrom(planGraph).map((deliverable) => {
    const id = String(deliverable.id ?? deliverable.deliverableId ?? deliverable.slug ?? '');
    const sourceRef = `cpm:${planId}/${id}`;
    return {
      id: `cpm:${id}`,
      label: String(deliverable.title ?? deliverable.name ?? deliverable.description ?? id),
      status: 'active',
      attributes: {
        owned_files: deliverable.owned_files ?? deliverable.ownedFiles ?? [],
        prerequisites: deliverable.prerequisites ?? deliverable.depends_on ?? deliverable.dependsOn ?? [],
        estimated_effort_hours: deliverable.estimated_effort_hours ?? deliverable.estimatedEffortHours ?? null,
      },
      sourceRef: {
        system: 'cpm',
        sourceType: 'deliverable',
        sourceRef,
        locator: sourceRef,
        contentHash: stableHash(deliverable),
      },
    };
  });
  return { id: 'cpm', label: 'CPM deliverables', kind: 'implementation_asset', order: 0, system: 'cpm', members };
}

// ---------------------------------------------------------------------------
// FMECA
// ---------------------------------------------------------------------------

function failureModesFrom(state: unknown): any[] {
  if (Array.isArray(state)) return state;
  if (isRecord(state)) {
    for (const key of ['failure_modes', 'failureModes', 'modes', 'risks']) {
      if (Array.isArray(state[key])) return state[key];
    }
  }
  return [];
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function criticalityOf(mode: any): number | null {
  const explicit = numeric(mode.criticality ?? mode.rpn ?? mode.risk);
  if (explicit !== null) return explicit;
  const severity = numeric(mode.severity);
  const occurrence = numeric(mode.occurrence);
  const detection = numeric(mode.detection);
  if (severity !== null && occurrence !== null && detection !== null) return severity * occurrence * detection;
  return null;
}

/** Failure modes from a FMECA session state; deterministic numeric criticality. */
export function fmecaFailureModes(state: unknown, sessionId: string): MatrixDimension {
  const members: MatrixMember[] = failureModesFrom(state).map((mode) => {
    const id = String(mode.id ?? mode.failure_mode_id ?? mode.name ?? '');
    const member: MatrixMember = {
      id: `fm:${id}`,
      label: String(mode.name ?? mode.description ?? mode.failure_mode ?? id),
      status: 'active',
      attributes: {
        severity: mode.severity ?? null,
        occurrence: mode.occurrence ?? null,
        detection: mode.detection ?? null,
        effect: mode.effect ?? null,
        cause: mode.cause ?? null,
      },
      sourceRef: {
        system: 'fmeca',
        sourceType: 'failure_mode',
        sourceRef: `fmeca:${sessionId}/${id}`,
        locator: `fmeca-state/${sessionId}`,
        contentHash: stableHash(mode),
      },
    };
    const criticality = criticalityOf(mode);
    if (criticality !== null) member.weight = criticality;
    return member;
  });
  return { id: 'fmeca', label: 'FMECA failure modes', kind: 'failure_mode', order: 0, system: 'fmeca', members };
}

// ---------------------------------------------------------------------------
// Dimension set assembly + atomic writes
// ---------------------------------------------------------------------------

/** Assemble a Dimensions document; the version hashes its canonical roster. */
export function buildDimensionSet(dimensionSetId: string, dimensions: MatrixDimension[]): DimensionsDocument {
  const version = sha256Hex(canonicalJson(dimensions)).slice(0, 12);
  return { schemaVersion: '0.2.0', dimensionSetId, version, dimensions };
}

/** Write `<dir>/dimensions/<dimensionSetId>@<version>.json` atomically. */
export function writeDimensionSet(dir: string, doc: DimensionsDocument): { path: string; unchanged: boolean } {
  const target = path.join(dir, 'dimensions', `${doc.dimensionSetId}@${doc.version}.json`);
  const bytes = `${canonicalJson(doc)}\n`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === bytes) {
    return { path: target, unchanged: true };
  }
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, target);
  return { path: target, unchanged: false };
}

// ---------------------------------------------------------------------------
// Schema subset validation (no dependency; mirrors the vendored schema)
// ---------------------------------------------------------------------------

const KIND_ENUM: readonly string[] = [
  'customer_requirement', 'engineering_characteristic', 'stakeholder_priority', 'option',
  'criterion', 'constraint', 'implementation_asset', 'test_artifact', 'business_metric',
  'failure_mode', 'jtbd_step', 'context', 'code_element',
];
const STATUS_ENUM: readonly string[] = ['active', 'deprecated'];
const TOP_KEYS = ['schemaVersion', 'dimensionSetId', 'version', 'label', 'dimensions'];
const DIM_KEYS = ['id', 'label', 'kind', 'order', 'system', 'weightSemantics', 'weightScale', 'members'];
const MEMBER_KEYS = ['id', 'label', 'weightObservation', 'weight', 'sourceRef', 'status', 'supersededBy', 'attributes'];
const SOURCE_REF_KEYS = ['system', 'sourceType', 'sourceRef', 'locator', 'contentHash', 'version', 'excerpt'];

function rejectUnknownKeys(record: Record<string, unknown>, allowed: string[], base: string, errors: string[]): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) errors.push(`${base}.${key}: unknown property`);
}

/** Check a document against the vendored schema's rules; return path errors. */
export function validateDimensionSet(doc: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(doc)) return ['$: expected object'];

  for (const key of ['schemaVersion', 'dimensionSetId', 'version', 'dimensions']) {
    if (!(key in doc)) errors.push(`$.${key}: required property missing`);
  }
  rejectUnknownKeys(doc, TOP_KEYS, '$', errors);

  if (doc.dimensions !== undefined && !Array.isArray(doc.dimensions)) {
    errors.push('$.dimensions: expected array');
    return errors;
  }

  const dimensions = Array.isArray(doc.dimensions) ? doc.dimensions : [];
  dimensions.forEach((dimension, di) => {
    const base = `$.dimensions[${di}]`;
    if (!isRecord(dimension)) {
      errors.push(`${base}: expected object`);
      return;
    }
    for (const key of ['id', 'order', 'members']) {
      if (!(key in dimension)) errors.push(`${base}.${key}: required property missing`);
    }
    rejectUnknownKeys(dimension, DIM_KEYS, base, errors);
    if (dimension.kind !== undefined && !KIND_ENUM.includes(String(dimension.kind))) {
      errors.push(`${base}.kind: unknown dimension kind '${String(dimension.kind)}'`);
    }
    if (dimension.order !== undefined && (!Number.isInteger(dimension.order) || dimension.order < 0)) {
      errors.push(`${base}.order: expected a non-negative integer`);
    }
    if (dimension.members !== undefined && !Array.isArray(dimension.members)) {
      errors.push(`${base}.members: expected array`);
      return;
    }
    const members = Array.isArray(dimension.members) ? dimension.members : [];
    members.forEach((member, mi) => {
      const memberBase = `${base}.members[${mi}]`;
      if (!isRecord(member)) {
        errors.push(`${memberBase}: expected object`);
        return;
      }
      if (!('id' in member)) errors.push(`${memberBase}.id: required property missing`);
      rejectUnknownKeys(member, MEMBER_KEYS, memberBase, errors);
      if (member.status !== undefined && !STATUS_ENUM.includes(String(member.status))) {
        errors.push(`${memberBase}.status: unknown lifecycle status '${String(member.status)}'`);
      }
      if (member.sourceRef !== undefined) {
        if (!isRecord(member.sourceRef)) {
          errors.push(`${memberBase}.sourceRef: expected object`);
        } else {
          rejectUnknownKeys(member.sourceRef, SOURCE_REF_KEYS, `${memberBase}.sourceRef`, errors);
        }
      }
      if (member.weight !== undefined && !(isRecord(member.sourceRef) && typeof member.sourceRef.system === 'string' && member.sourceRef.system.length > 0)) {
        errors.push(`${memberBase}.weight: numeric weight requires sourceRef.system`);
      }
    });
  });

  return errors;
}

// ---------------------------------------------------------------------------
// CLI: `junior matrix export`
// ---------------------------------------------------------------------------

interface MatrixOptions {
  sources: string[];
  dir: string;
  out?: string;
  set?: string;
  hop?: string;
  plan?: string;
  session?: string;
  model?: string;
}

const SOURCES = ['code', 'tests', 'jevitate', 'cpm', 'fmeca'];
const VALUE_FLAGS = ['--source', '--dir', '--out', '--set', '--hop', '--plan', '--session', '--model'];

export const MATRIX_USAGE = [
  'Usage: junior matrix export --source code|tests|jevitate|cpm|fmeca [--source ...]',
  '       [--dir <project>] [--out <crossmatrix dir, default <project>/.crossmatrix>]',
  '       [--set <dimensionSetId, default project-<source>>]',
  '       [--hop <hop.json> --plan <plan_id>] [--hop <hop.json> --session <fmeca session_id>]',
  'Usage: junior matrix init [--dir <project>]',
  'Usage: junior matrix sync --hop <hop.json> --model <modelId> --source code|tests|jevitate|cpm|fmeca [--source ...]',
  '       [--dir <project>] [--plan <plan_id>] [--session <fmeca session_id>]',
  'Usage: junior matrix codemap init --hop <hop.json> --model <modelId> [--feature-dimension <id> ...]',
  'Usage: junior matrix link --hop <hop.json> --model <modelId> --result <result.json> --feature <dimensionId>:<memberId> [--observation implements|tests|touches]',
  'Usage: junior matrix files --hop <hop.json> --model <modelId> --feature <dimensionId>:<memberId>',
  'Usage: junior matrix context --hop <hop.json> --model <modelId> --feature <dimensionId>:<memberId> [--max N]',
  'Usage: junior matrix stale --hop <hop.json> --model <modelId> [--dir <project>]',
  'Usage: junior matrix bootstrap --hop <hop.json> --model <modelId> --dir <project> [--out proposals.json]',
  'Usage: junior matrix confirm --hop <hop.json> --model <modelId> --proposals <proposals.json> [--min high|medium|low] [--only <id,...>] [--exclude <id,...>]',
  'Usage: junior matrix autolink --hop <hop.json> --model <modelId> --plan <plan_id>',
].join('\n');

export function parseMatrixArgs(argv: string[]): MatrixOptions {
  const sources: string[] = [];
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!VALUE_FLAGS.includes(name)) throw new Error(`Unknown option for matrix: ${arg}`);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined) value = argv[++i];
    if (value === undefined || value === '') throw new Error(`Option ${name} requires a value`);
    if (name === '--source') sources.push(value);
    else values[name] = value;
  }
  if (sources.length === 0) throw new Error(MATRIX_USAGE);
  for (const source of sources) if (!SOURCES.includes(source)) throw new Error(`Unknown source: ${source}`);
  return {
    sources,
    dir: values['--dir'] ?? process.cwd(),
    out: values['--out'],
    set: values['--set'],
    hop: values['--hop'],
    plan: values['--plan'],
    session: values['--session'],
    model: values['--model'],
  };
}

interface CodemapOptions {
  hop?: string;
  model?: string;
  result?: string;
  feature?: string;
  observation?: string;
  featureDimensions: string[];
  max?: number;
  dir?: string;
  out?: string;
  proposals?: string;
  min?: string;
  only?: string[];
  exclude?: string[];
  plan?: string;
}

const CODEMAP_VALUE_FLAGS = ['--hop', '--model', '--result', '--feature', '--observation', '--feature-dimension', '--max', '--dir', '--out', '--proposals', '--min', '--only', '--exclude', '--plan'];
const CODEMAP_OBSERVATIONS = ['implements', 'tests', 'touches'];
const CODEMAP_CONFIDENCES = ['high', 'medium', 'low'];
const CODEMAP_LIST_FLAGS = ['--only', '--exclude']; // comma-separated id lists

function parseCodemapArgs(argv: string[]): CodemapOptions {
  const featureDimensions: string[] = [];
  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = { '--only': [], '--exclude': [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!CODEMAP_VALUE_FLAGS.includes(name)) throw new Error(`Unknown option for matrix codemap: ${arg}`);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined) value = argv[++i];
    if (value === undefined || value === '') throw new Error(`Option ${name} requires a value`);
    if (name === '--feature-dimension') featureDimensions.push(value);
    else if (CODEMAP_LIST_FLAGS.includes(name)) lists[name].push(...value.split(',').map((entry) => entry.trim()).filter(Boolean));
    else values[name] = value;
  }
  if (values['--observation'] !== undefined && !CODEMAP_OBSERVATIONS.includes(values['--observation'])) {
    throw new Error(`Unknown observation: ${values['--observation']}`);
  }
  if (values['--min'] !== undefined && !CODEMAP_CONFIDENCES.includes(values['--min'])) {
    throw new Error(`Unknown minimum confidence: ${values['--min']}`);
  }
  return {
    hop: values['--hop'],
    model: values['--model'],
    result: values['--result'],
    feature: values['--feature'],
    observation: values['--observation'],
    featureDimensions,
    max: parseMax(values['--max']),
    dir: values['--dir'],
    out: values['--out'],
    proposals: values['--proposals'],
    min: values['--min'],
    only: lists['--only'],
    exclude: lists['--exclude'],
    plan: values['--plan'],
  };
}

/** Parse an optional non-negative integer `--max`. */
function parseMax(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Option --max requires a non-negative integer, got: ${value}`);
  }
  return parsed;
}

function gitTrackedFiles(dir: string): MatrixFile[] {
  const listing = spawnSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' });
  if (listing.status !== 0) throw new Error(`git ls-files failed in ${dir}: ${listing.stderr?.trim() ?? 'unknown error'}`);
  const files: MatrixFile[] = [];
  for (const line of listing.stdout.split('\n')) {
    const p = line.trim();
    if (!p) continue;
    files.push({ path: p, content: fs.readFileSync(path.join(dir, p)) });
  }
  return files;
}

function readJevitateFiles(dir: string): MatrixFile[] {
  const files: MatrixFile[] = [];
  const jobs = path.join(dir, '.jevitate', 'jobs.json');
  if (fs.existsSync(jobs)) files.push({ path: '.jevitate/jobs.json', content: fs.readFileSync(jobs) });

  const journeysDir = path.join(dir, '.jevitate', 'journeys');
  const walk = (absDir: string, relDir: string): void => {
    if (!fs.existsSync(absDir)) return;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(absDir, entry.name);
      const rel = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push({ path: rel, content: fs.readFileSync(abs) });
    }
  };
  walk(journeysDir, '.jevitate/journeys');
  return files;
}

async function dimensionsForSource(options: MatrixOptions, source: string): Promise<MatrixDimension[]> {
  if (source === 'code') return [codeLocations(gitTrackedFiles(options.dir))];
  if (source === 'tests') return [tests(gitTrackedFiles(options.dir))];
  if (source === 'jevitate') {
    const files = readJevitateFiles(options.dir);
    const jobsFile = files.find((f) => f.path === '.jevitate/jobs.json');
    const jobsJson = jobsFile ? parseJsonContent(jobsFile.content) : [];
    return [jevitateJobs(jobsJson), jevitatePersonas(jobsJson), jevitateJourneys(files)];
  }
  if (source === 'cpm') {
    if (!options.hop || !options.plan) throw new Error('cpm export requires --hop <hop.json> and --plan <plan_id>');
    const outcome = await callHop(options.hop, 'cpm', { tool: 'plan.get', arguments: { plan_id: options.plan } });
    if (!outcome.ok) throw new Error(`cpm plan.get failed: ${outcome.error?.message ?? outcome.note ?? 'unknown error'}`);
    return [cpmDeliverables(outcome.result, options.plan)];
  }
  if (!options.hop || !options.session) throw new Error('fmeca export requires --hop <hop.json> and --session <fmeca session_id>');
  const outcome = await callHop(options.hop, 'fmeca', { tool: 'state.get', arguments: { session_id: options.session } });
  if (!outcome.ok) throw new Error(`fmeca state.get failed: ${outcome.error?.message ?? outcome.note ?? 'unknown error'}`);
  return [fmecaFailureModes(outcome.result, options.session)];
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${MATRIX_USAGE}\n`);
    return 0;
  }
  if (argv[0] === 'init') {
    const { runMatrixInit } = await import('./matrix-init.ts');
    return runMatrixInit(argv.slice(1));
  }
  if (argv[0] === 'sync') {
    try {
      const options = parseMatrixArgs(argv.slice(1));
      if (!options.hop) throw new Error('matrix sync requires --hop <hop.json>');
      if (!options.model) throw new Error('matrix sync requires --model <modelId>');
      const dimensions: MatrixDimension[] = [];
      for (const source of options.sources) dimensions.push(...(await dimensionsForSource(options, source)));
      const { syncDimensions } = await import('./matrix-sync.ts');
      const result = await syncDimensions({ hopPath: options.hop, modelId: options.model, dimensions });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (argv[0] === 'codemap') {
    try {
      if (argv[1] !== 'init') throw new Error('Usage: junior matrix codemap init --hop <hop.json> --model <modelId> [--feature-dimension <id> ...]');
      const options = parseCodemapArgs(argv.slice(2));
      if (!options.hop) throw new Error('matrix codemap init requires --hop <hop.json>');
      if (!options.model) throw new Error('matrix codemap init requires --model <modelId>');
      const { codemapInit } = await import('./codemap.ts');
      const result = await codemapInit({
        hopPath: options.hop,
        modelId: options.model,
        featureDimensions: options.featureDimensions.length > 0 ? options.featureDimensions : undefined,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (argv[0] === 'link') {
    try {
      const options = parseCodemapArgs(argv.slice(1));
      if (!options.hop) throw new Error('matrix link requires --hop <hop.json>');
      if (!options.model) throw new Error('matrix link requires --model <modelId>');
      if (!options.result) throw new Error('matrix link requires --result <result.json>');
      if (!options.feature) throw new Error('matrix link requires --feature <dimensionId>:<memberId>');
      const { codemapLink } = await import('./codemap.ts');
      const result = await codemapLink({
        hopPath: options.hop,
        modelId: options.model,
        resultPath: options.result,
        feature: options.feature,
        observation: options.observation as 'implements' | 'tests' | 'touches' | undefined,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (argv[0] === 'bootstrap' || argv[0] === 'confirm' || argv[0] === 'autolink') {
    const subcommand = argv[0];
    try {
      const options = parseCodemapArgs(argv.slice(1));
      if (!options.hop) throw new Error(`matrix ${subcommand} requires --hop <hop.json>`);
      if (!options.model) throw new Error(`matrix ${subcommand} requires --model <modelId>`);
      const autopilot = await import('./matrix-autopilot.ts');
      if (subcommand === 'bootstrap') {
        const dir = options.dir ?? process.cwd();
        const result = await autopilot.bootstrap({
          hopPath: options.hop,
          modelId: options.model,
          dir,
          out: options.out ?? path.join(dir, 'proposals.json'),
        });
        process.stdout.write(
          `${JSON.stringify({ out: result.out, count: result.proposals.length, ...result.counts })}\n`,
        );
        return 0;
      }
      if (subcommand === 'confirm') {
        if (!options.proposals) throw new Error('matrix confirm requires --proposals <proposals.json>');
        const result = await autopilot.confirmProposals({
          hopPath: options.hop,
          modelId: options.model,
          proposalsPath: options.proposals,
          min: options.min as 'high' | 'medium' | 'low' | undefined,
          only: options.only,
          exclude: options.exclude,
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }
      if (!options.plan) throw new Error('matrix autolink requires --plan <plan_id>');
      const result = await autopilot.autolink({
        hopPath: options.hop,
        modelId: options.model,
        planId: options.plan,
        dir: options.dir ?? process.cwd(),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (argv[0] === 'files' || argv[0] === 'context' || argv[0] === 'stale') {
    const subcommand = argv[0];
    try {
      const options = parseCodemapArgs(argv.slice(1));
      if (!options.hop) throw new Error(`matrix ${subcommand} requires --hop <hop.json>`);
      if (!options.model) throw new Error(`matrix ${subcommand} requires --model <modelId>`);
      const codemap = await import('./codemap.ts');
      if (subcommand === 'stale') {
        const result = await codemap.codemapStale({
          hopPath: options.hop,
          modelId: options.model,
          dir: options.dir ?? process.cwd(),
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }
      if (!options.feature) throw new Error(`matrix ${subcommand} requires --feature <dimensionId>:<memberId>`);
      if (subcommand === 'files') {
        const result = await codemap.codemapFiles({
          hopPath: options.hop,
          modelId: options.model,
          feature: options.feature,
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }
      const result = await codemap.codemapContext({
        hopPath: options.hop,
        modelId: options.model,
        feature: options.feature,
        max: options.max,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (argv[0] === 'jtbd') {
    const { runJtbd } = await import('./jtbd-bridge.ts');
    return runJtbd(argv.slice(1));
  }
  if (argv[0] !== 'export') {
    process.stdout.write(`${MATRIX_USAGE}\n`);
    return 1;
  }
  try {
    const options = parseMatrixArgs(argv.slice(1));
    const written: string[] = [];
    const unchanged: string[] = [];
    for (const source of options.sources) {
      const dimensionSetId = options.set ?? `project-${source}`;
      const dimensions = await dimensionsForSource(options, source);
      const doc = buildDimensionSet(dimensionSetId, dimensions);
      const outDir = options.out ?? path.join(options.dir, '.crossmatrix');
      const result = writeDimensionSet(outDir, doc);
      if (result.unchanged) unchanged.push(result.path);
      else written.push(result.path);
    }
    process.stdout.write(`${JSON.stringify({ written, unchanged }, null, 2)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (isDirectEntry(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
