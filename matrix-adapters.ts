// ---------------------------------------------------------------------------
// Crossmatrix ADR-0004 Dimensions adapters.
//
// Each `*Dimension` export is a PURE adapter: it takes already-read data
// (file bytes, parsed JSON, parsed plan/state graphs) and returns one ADR-0004
// Dimension object. This module is split out of matrix.ts per ADR 0016.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  fmecaFailureModes as readFmecaFailureModes,
  planDeliverables,
  strictItems,
} from './companion-shapes.ts';

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

export function isRecord(value: unknown): value is Record<string, any> {
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

/** Derive a plan id from a `.cpm-planner/plans/<name>/<variant>.json` path. */
export function planIdFromPath(filePath: string): string {
  const normalized = normalizePath(filePath);
  const match = normalized.match(/\.cpm-planner\/plans\/([^/]+)\/([^/]+)\.json$/);
  if (match) return `${match[1]}/${match[2]}`;
  return path.posix.basename(normalized).replace(/\.json$/, '');
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

export function parseJsonContent(content: string | Uint8Array): unknown {
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

/** Implementation assets from a CPM plan graph. */
export function cpmDeliverables(
  planGraph: unknown,
  planId: string,
  statuses?: Map<string, string>,
): MatrixDimension {
  const members: MatrixMember[] = strictItems(planDeliverables(planGraph), 'cpm', 'plan.get', planGraph).map((deliverable) => {
    const id = String(deliverable.id ?? deliverable.deliverableId ?? deliverable.slug ?? '');
    const sourceRef = `cpm:${planId}/${id}`;
    const attributes: Record<string, unknown> = {
      owned_files: deliverable.owned_files ?? deliverable.ownedFiles ?? [],
      prerequisites: deliverable.prerequisites ?? deliverable.depends_on ?? deliverable.dependsOn ?? [],
      estimated_effort_hours: deliverable.estimated_effort_hours ?? deliverable.estimatedEffortHours ?? null,
    };
    const status = statuses?.get(id);
    if (status !== undefined) attributes.status = status.toLowerCase();
    return {
      id: `cpm:${id}`,
      label: String(deliverable.title ?? deliverable.name ?? deliverable.description ?? id),
      status: 'active',
      attributes,
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
  const members: MatrixMember[] = strictItems(readFmecaFailureModes(state), 'fmeca', 'state.get', state).map((mode) => {
    const id = String(mode.id ?? mode.failure_mode_id ?? mode.name ?? '');
    const member: MatrixMember = {
      id: `fm:${id}`,
      label: String(mode.name ?? mode.description ?? mode.failure_mode ?? id),
      status: 'active',
      attributes: {
        criticality: mode.criticality ?? null,
        residual_criticality: mode.residual_criticality ?? null,
        standing: mode.standing ?? null,
        disposition: mode.disposition ?? null,
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
