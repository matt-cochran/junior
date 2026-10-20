// ---------------------------------------------------------------------------
// Companion-tool state mirror.
//
// `syncState` reads each companion tool's current state through the HOP
// (`cpm plan.status`, `fmeca state.get`, `elicitation state.get`,
// `scientific-process state.get`) plus jevitate result JSON files, turns it into
// crossmatrix observation descriptors with the pure mappers in this module, and
// emits them through the same content-addressed `observe` command path the
// code-map uses. Re-running against unchanged state replays byte-for-byte
// identical request ids, so the server treats the mirror as idempotent.
//
// Missing tools or sessions are skipped with a note, never an error. Evidence
// excerpts are short summaries built from ids and state tokens only, so no
// secret or env value can leak into the model.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import {
  CROSSMATRIX_WRITE_SCHEMA_VERSION,
  requestIdFor,
  serverErrorDetail,
} from './matrix-sync.ts';
import type { CodemapEvidence, CodemapSent } from './codemap.ts';
import { callHop, loadHop } from './tools/tools.ts';
import {
  ShapeError,
  elicitationClaims,
  fmecaFailureModes,
  planStatusRows,
  spHypotheses,
  strictItems,
} from './companion-shapes.ts';

const MIN_SOURCE_VERSION = [0, 3, 0] as const;

/** A backend observation descriptor produced by a pure mapper. */
export interface StateObservation {
  /** Declared crossmatrix relation the observation rides on. */
  relationId: string;
  /** Fully-prefixed source member id. */
  from: string;
  /** Fully-prefixed target member id. */
  to: string;
  /** State token recorded as the observation (status, standing, verdict ...). */
  observation: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: CodemapEvidence[];
  rationale: string;
  /** Stable content identity folded into the request id. */
  contentVersion: string;
}

export interface StateSyncDeps {
  callHop?: typeof callHop;
  loadHop?: typeof loadHop;
}

export interface StateSyncOptions {
  hopPath: string;
  modelId: string;
  /** cpm plan id whose `plan.status` is mirrored. */
  planId?: string;
  /** fmeca session id whose `state.get` is mirrored. */
  fmecaSession?: string;
  /** elicitation session id whose `state.get` is mirrored. */
  elicitationSession?: string;
  /** scientific-process session id whose `state.get` is mirrored. */
  spSession?: string;
  /** Directory or single file of jevitate journey result JSON. */
  jevitateResults?: string;
  /** Project dir used to resolve a relative `--jevitate-results`; defaults to cwd. */
  dir?: string;
  deps?: StateSyncDeps;
}

export interface StateSyncResult {
  modelId: string;
  requestIds: string[];
  sent: CodemapSent[];
  observations: StateObservation[];
  notes: string[];
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/** First present array value from a list of candidate keys. */
function firstArray(source: Record<string, any>, keys: readonly string[]): any[] {
  for (const key of keys) if (Array.isArray(source[key])) return source[key];
  return [];
}

function evidence(
  system: string,
  sourceType: string,
  sourceRef: string,
  locator: string,
  excerpt: string,
): CodemapEvidence {
  return { sourceRef: { system, sourceType, sourceRef, locator }, locator, excerpt };
}

// ---------------------------------------------------------------------------
// cpm: deliverable status
// ---------------------------------------------------------------------------

/** Normalise the cpm status vocabulary to complete | in_progress | blocked. */
function normalizeCpmStatus(raw: unknown): string | null {
  const value = text(raw).trim().toLowerCase().replace(/\s+/g, '_');
  if (value === 'complete' || value === 'completed') return 'complete';
  if (['in_progress', 'in-progress', 'inprogress', 'active', 'started'].includes(value)) return 'in_progress';
  if (['blocked', 'blocked_by_dependency', 'blocked-by-dependency'].includes(value)) return 'blocked';
  return null;
}

/** One status observation per deliverable with a recognised cpm status. */
export function cpmStatusObservations(status: unknown, planId: string): StateObservation[] {
  const observations: StateObservation[] = [];
  for (const { id, status: mark } of strictItems(planStatusRows(status), 'cpm', 'plan.status', status)) {
    if (!id) continue;
    const normalized = normalizeCpmStatus(mark);
    if (!normalized) continue;
    const ref = `cpm:${planId}/${id}`;
    observations.push({
      relationId: 'codemap-cpm',
      from: `cpm:${id}`,
      to: `cpm:${id}`,
      observation: normalized,
      confidence: 'high',
      evidence: [evidence('cpm', 'deliverable-status', ref, ref, `cpm deliverable ${id} is ${normalized}`)],
      rationale: `cpm deliverable ${id} status is ${normalized}`,
      contentVersion: `cpm-status:${normalized}`,
    });
  }
  return observations;
}

// ---------------------------------------------------------------------------
// fmeca: failure modes -> features/files
// ---------------------------------------------------------------------------

const FILE_TOKEN = /[\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z][A-Za-z0-9]*/g;
const MEMBER_TOKEN = /\b(?:cpm|job|journey|fmeca|code|test|loc):[\w./:-]+/g;

function stringsIn(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const entry of value) stringsIn(entry, out, depth + 1);
  else if (isRecord(value)) for (const entry of Object.values(value)) stringsIn(entry, out, depth + 1);
  return out;
}

/** Member ids and code paths a failure mode names in its free-text fields. */
function fmecaTargets(mode: Record<string, any>): string[] {
  const tokens = new Set<string>();
  const fields = ['feature', 'features', 'files', 'owned_files', 'ownedFiles', 'statement', 'description', 'effect', 'cause', 'name', 'label'];
  for (const field of fields) {
    for (const value of stringsIn(mode[field])) {
      for (const match of value.matchAll(MEMBER_TOKEN)) tokens.add(match[0]);
      for (const match of value.matchAll(FILE_TOKEN)) tokens.add(`loc:${match[0]}`);
    }
  }
  return [...tokens];
}

/** Link each failure mode to the features/files it names (or to itself). */
export function fmecaStateObservations(state: unknown, sessionId: string): StateObservation[] {
  const observations: StateObservation[] = [];
  for (const raw of strictItems(fmecaFailureModes(state), 'fmeca', 'state.get', state)) {
    if (!isRecord(raw)) continue;
    const id = text(raw.id ?? raw.failure_mode_id ?? raw.name);
    if (!id) continue;
    const targets = fmecaTargets(raw);
    const ref = `fmeca:${sessionId}/${id}`;
    for (const to of targets.length > 0 ? targets : [`fm:${id}`]) {
      observations.push({
        relationId: 'codemap-fmeca',
        from: `fm:${id}`,
        to,
        observation: 'touches',
        confidence: 'medium',
        evidence: [evidence('fmeca', 'failure-mode', ref, ref, `fmeca failure mode ${id} names ${to}`)],
        rationale: `fmeca failure mode ${id} names ${to}`,
        contentVersion: `fmeca-link:${to}`,
      });
    }
  }
  return observations;
}

// ---------------------------------------------------------------------------
// elicitation: claim standing -> jevitate outcome/requirement members
// ---------------------------------------------------------------------------

/** Resolve the jevitate member a claim id belongs to. */
function claimTarget(id: string): string | null {
  const outcome = /^job:([^/]+)\/outcome:.+$/.exec(id);
  if (outcome) return id;
  const story = /^job:([^/]+)\/story$/.exec(id);
  if (story) return `job:${story[1]}`;
  const job = /^job:([^/]+)$/.exec(id);
  if (job) return `job:${job[1]}`;
  return null;
}

/** Link each claim's standing to the jevitate member it came from. */
export function elicitationStateObservations(state: unknown, sessionId: string): StateObservation[] {
  const observations: StateObservation[] = [];
  for (const raw of strictItems(elicitationClaims(state), 'elicitation', 'state.get', state)) {
    if (!isRecord(raw)) continue;
    const id = text(raw.id ?? raw.claim_id ?? raw.claimId);
    const to = id ? claimTarget(id) : null;
    if (!id || !to) continue;
    const standing = text(raw.standing ?? raw.status).toLowerCase() || 'open';
    const ref = `elicitation:${sessionId}/${id}`;
    observations.push({
      relationId: 'codemap-jevitate-jobs',
      from: `claim:${id}`,
      to,
      observation: standing,
      confidence: 'high',
      evidence: [evidence('elicitation', 'claim-standing', ref, `elicitation:${sessionId}`, `claim ${id} is ${standing}`)],
      rationale: `elicitation claim ${id} standing is ${standing}`,
      contentVersion: `elicitation-standing:${standing}`,
    });
  }
  return observations;
}

// ---------------------------------------------------------------------------
// scientific-process: hypothesis verdicts -> features/files
// ---------------------------------------------------------------------------

function verdictOf(item: Record<string, any>): string {
  return text(item.verdict ?? item.status ?? item.outcome ?? item.result).trim();
}

function experimentsFrom(state: unknown): any[] {
  if (isRecord(state)) return firstArray(state, ['experiments', 'runs']);
  return [];
}

/** Link each hypothesis verdict to the files named in its statement/evidence. */
export function scientificProcessStateObservations(state: unknown, sessionId: string): StateObservation[] {
  const observations: StateObservation[] = [];
  const hypotheses = strictItems(spHypotheses(state), 'scientific-process', 'state.get', state).filter(isRecord);
  for (const hypothesis of hypotheses) {
    const id = text(hypothesis.id ?? hypothesis.hypothesis_id ?? hypothesis.hypothesisId);
    if (!id) continue;
    let verdict = verdictOf(hypothesis);
    let files = stringsIn([hypothesis.statement, hypothesis.evidence]).flatMap((value) =>
      [...value.matchAll(FILE_TOKEN)].map((match) => match[0]),
    );
    for (const experiment of experimentsFrom(state).filter(isRecord)) {
      const ref = text(experiment.hypothesis_id ?? experiment.hypothesisId);
      if (ref && ref === id) {
        if (!verdict) verdict = verdictOf(experiment);
        files = files.concat(
          stringsIn([experiment.statement, experiment.evidence]).flatMap((value) =>
            [...value.matchAll(FILE_TOKEN)].map((match) => match[0]),
          ),
        );
      }
    }
    const targets = [...new Set(files.length > 0 ? files.map((file) => `loc:${file}`) : [`hypothesis:${id}`])];
    for (const to of targets) {
      observations.push({
        relationId: 'codemap-scientific-process',
        from: `hypothesis:${id}`,
        to,
        observation: verdict || 'unknown',
        confidence: 'high',
        evidence: [
          evidence(
            'scientific-process',
            'hypothesis-verdict',
            `scientific-process:${sessionId}/${id}`,
            `scientific-process:${sessionId}`,
            `hypothesis ${id} verdict is ${verdict || 'unknown'}`,
          ),
        ],
        rationale: `scientific-process hypothesis ${id} verdict is ${verdict || 'unknown'}`,
        contentVersion: `sp-verdict:${verdict || 'unknown'}`,
      });
    }
  }
  return observations;
}

// ---------------------------------------------------------------------------
// jevitate: journey results -> journeys + desired outcomes
// ---------------------------------------------------------------------------

/** Passing state of a journey result, or null when it carries no verdict. */
function journeyPassing(result: Record<string, any>): boolean | null {
  if (result.outcome !== undefined) return text(result.outcome).toLowerCase() === 'ok';
  if (result.verdict !== undefined) return text(result.verdict).toLowerCase() === 'passed';
  if (typeof result.passed === 'boolean') return result.passed;
  return null;
}

/** Turn jevitate journey results into journey and desired-outcome observations. */
export function jevitateResultObservations(results: readonly unknown[]): StateObservation[] {
  const observations: StateObservation[] = [];
  for (const value of results) {
    if (!isRecord(value)) continue;
    const metadata = isRecord(value.metadata) ? value.metadata : {};
    const journeyId = text(metadata.id ?? value.journeyId ?? value.id);
    if (!journeyId) continue;
    const passing = journeyPassing(value);
    if (passing === null) continue;
    const state = passing ? 'passed' : 'failed';
    observations.push({
      relationId: 'codemap-jevitate-journeys',
      from: `journey-result:${journeyId}`,
      to: `journey:${journeyId}`,
      observation: state,
      confidence: 'high',
      evidence: [
        evidence('jevitate', 'journey-result', `jevitate:${journeyId}`, `jevitate:${journeyId}`, `journey ${journeyId} ${state}`),
      ],
      rationale: `jevitate journey ${journeyId} ${state}`,
      contentVersion: `journey-result:${state}`,
    });

    // J9's mapping: metadata.job + metadata.serves/outcomes resolve the
    // desired-outcome members this journey verifies.
    const jobId = text(metadata.job ?? value.job ?? value.jobId);
    const served = asArray(metadata.serves ?? value.serves ?? value.outcomes).map(text).filter(Boolean);
    for (const outcomeId of served) {
      observations.push({
        relationId: 'codemap-jevitate-jobs',
        from: `journey-result:${journeyId}`,
        to: jobId ? `job:${jobId}/outcome:${outcomeId}` : `outcome:${outcomeId}`,
        observation: state,
        confidence: 'high',
        evidence: [
          evidence(
            'jevitate',
            'journey-outcome',
            `jevitate:${journeyId}/${outcomeId}`,
            `jevitate:${journeyId}`,
            `journey ${journeyId} ${state} outcome ${outcomeId}`,
          ),
        ],
        rationale: `jevitate journey ${journeyId} ${state} outcome ${outcomeId}`,
        contentVersion: `journey-outcome:${state}`,
      });
    }
  }
  return observations;
}

// ---------------------------------------------------------------------------
// Side-effecting shell
// ---------------------------------------------------------------------------

/** Parse the leading `major[.minor[.patch]]` of a version string. */
function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function versionAtLeast(actual: string | undefined, min: readonly number[]): boolean {
  if (!actual) return false;
  const parsed = parseVersion(actual);
  if (!parsed) return false;
  for (let i = 0; i < 3; i++) {
    if (parsed[i] !== min[i]) return parsed[i] > min[i];
  }
  return true;
}

function assertWriteCapable(load: typeof loadHop, hopPath: string): void {
  const hop = load(hopPath);
  const recorded = hop.tools?.crossmatrix?.sourceVersion;
  if (!versionAtLeast(recorded, MIN_SOURCE_VERSION)) {
    throw new Error(`state sync requires Crossmatrix 0.3.0 or newer (hop records ${recorded ?? 'missing'})`);
  }
}

/** Send one content-addressed `observe` through the codemap write path. */
async function sendObserve(
  call: typeof callHop,
  load: typeof loadHop,
  hopPath: string,
  modelId: string,
  observation: StateObservation,
): Promise<CodemapSent> {
  assertWriteCapable(load, hopPath);
  const version = `${observation.relationId}|${observation.from}|${observation.to}|${observation.observation}|${observation.contentVersion}`;
  const requestId = requestIdFor(modelId, 'observe', observation.relationId, version);
  const request = {
    schemaVersion: CROSSMATRIX_WRITE_SCHEMA_VERSION,
    requestId,
    modelId,
    actor: { actorType: 'system', persona: 'model_admin' },
    op: {
      kind: 'observe',
      relationId: observation.relationId,
      from: observation.from,
      to: observation.to,
      observation: observation.observation,
      provenanceClass: 'observed',
      confidence: observation.confidence,
      evidence: observation.evidence,
      rationale: observation.rationale,
    },
  };
  const outcome = await call(hopPath, 'crossmatrix', {
    tool: 'crossmatrix.command',
    arguments: { request },
  });
  if (!outcome.ok) {
    const detail = serverErrorDetail(outcome) ?? outcome.error?.message ?? outcome.note ?? 'unknown error';
    throw new Error(`state sync observe failed: ${detail}`);
  }
  return { requestId, kind: 'observe' };
}

/** Read one tool's state; a missing/failed tool is a note, never an error. */
async function readState(
  call: typeof callHop,
  hopPath: string,
  tool: 'cpm' | 'fmeca' | 'elicitation' | 'scientific-process',
  toolName: string,
  args: Record<string, unknown>,
  notes: string[],
): Promise<unknown | undefined> {
  try {
    const outcome = await call(hopPath, tool, { tool: toolName, arguments: args });
    if (!outcome.ok) {
      notes.push(`${tool} ${toolName} skipped: ${outcome.error?.message ?? outcome.note ?? 'unavailable'}`);
      return undefined;
    }
    return outcome.result;
  } catch (err) {
    notes.push(`${tool} ${toolName} skipped: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Recursively collect `.json` files under `dir`, ignoring dot-directories. */
function jsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

/** Read jevitate result JSON from a directory or a single file. */
export function readJevitateResults(target: string): unknown[] {
  const stat = fs.statSync(target);
  const files = stat.isDirectory() ? jsonFiles(target) : [target];
  const results: unknown[] = [];
  for (const file of files) {
    try {
      results.push(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      /* an unreadable result file is skipped */
    }
  }
  return results;
}

/**
 * Mirror every configured companion tool's state into crossmatrix. Each source
 * is optional; a missing flag or unavailable tool is skipped with a note.
 */
export async function syncState(options: StateSyncOptions): Promise<StateSyncResult> {
  const call = options.deps?.callHop ?? callHop;
  const load = options.deps?.loadHop ?? loadHop;
  const notes: string[] = [];
  const observations: StateObservation[] = [];

  /** Record a ShapeError as a note; any other error still fails the sync. */
  const mapOrNote = (map: () => StateObservation[]): void => {
    try {
      observations.push(...map());
    } catch (error) {
      if (!(error instanceof ShapeError)) throw error;
      notes.push(error.message);
    }
  };

  if (options.planId) {
    const status = await readState(call, options.hopPath, 'cpm', 'plan.status', { plan_id: options.planId }, notes);
    if (status !== undefined) mapOrNote(() => cpmStatusObservations(status, options.planId!));
  } else {
    notes.push('cpm plan.status skipped: no --plan');
  }

  if (options.fmecaSession) {
    const state = await readState(call, options.hopPath, 'fmeca', 'state.get', { session_id: options.fmecaSession }, notes);
    if (state !== undefined) mapOrNote(() => fmecaStateObservations(state, options.fmecaSession!));
  } else {
    notes.push('fmeca state.get skipped: no --fmeca-session');
  }

  if (options.elicitationSession) {
    const state = await readState(
      call,
      options.hopPath,
      'elicitation',
      'state.get',
      { session_id: options.elicitationSession },
      notes,
    );
    if (state !== undefined) mapOrNote(() => elicitationStateObservations(state, options.elicitationSession!));
  } else {
    notes.push('elicitation state.get skipped: no --elicitation-session');
  }

  if (options.spSession) {
    const state = await readState(
      call,
      options.hopPath,
      'scientific-process',
      'state.get',
      { session_id: options.spSession },
      notes,
    );
    if (state !== undefined) mapOrNote(() => scientificProcessStateObservations(state, options.spSession!));
  } else {
    notes.push('scientific-process state.get skipped: no --sp-session');
  }

  if (options.jevitateResults) {
    const target = path.isAbsolute(options.jevitateResults)
      ? options.jevitateResults
      : path.resolve(options.dir ?? process.cwd(), options.jevitateResults);
    if (fs.existsSync(target)) {
      observations.push(...jevitateResultObservations(readJevitateResults(target)));
    } else {
      notes.push(`jevitate results skipped: ${options.jevitateResults} not found`);
    }
  } else {
    notes.push('jevitate results skipped: no --jevitate-results');
  }

  const sent: CodemapSent[] = [];
  for (const observation of observations) {
    sent.push(await sendObserve(call, load, options.hopPath, options.modelId, observation));
  }

  return { modelId: options.modelId, requestIds: sent.map((entry) => entry.requestId), sent, observations, notes };
}
