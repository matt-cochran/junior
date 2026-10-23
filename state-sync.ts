// ---------------------------------------------------------------------------
// Companion-tool state mirror.
//
// `syncState` reads each companion tool's current state through the HOP
// (`cpm plan.get`, `fmeca state.get`) and turns the cross-tool links it finds
// into crossmatrix observation descriptors. It declares the scales and
// relations those observations need before writing them, and only declares a
// relation that at least one observation uses.
//
// Member status is a roster attribute owned by the source's own sync, so this
// module writes no status observations. Elicitation, scientific-process and
// jevitate results have no dimension holding their members yet, so they are
// reported as not mirrored rather than written to the wrong relation.
//
// Re-running against unchanged state replays byte-for-byte identical request
// ids, so the server treats the mirror as idempotent. Evidence excerpts are
// short summaries built from ids and state tokens only, so no secret or env
// value can leak into the model.
// ---------------------------------------------------------------------------

import {
  CROSSMATRIX_WRITE_SCHEMA_VERSION,
  requestIdFor,
  serverErrorDetail,
  type CommandRequest,
} from './matrix-sync.ts';
import type { CodemapEvidence, CodemapSent } from './codemap.ts';
import { callHop, loadHop } from './tools/tools.ts';
import {
  ShapeError,
  fmecaFailureModes,
  planDeliverables,
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
  /** State token recorded as the observation. */
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
  /** cpm plan id whose `plan.get` acceptance criteria are mirrored. */
  planId?: string;
  /** fmeca session id whose `state.get` is mirrored. */
  fmecaSession?: string;
  /** elicitation session id; not mirrored until a dimension holds its members. */
  elicitationSession?: string;
  /** scientific-process session id; not mirrored until a dimension holds its members. */
  spSession?: string;
  /** Directory or single file of jevitate journey result JSON; not mirrored. */
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
  failures: string[];
}

interface StateRelation {
  relationId: string;
  from: string;
  to: string;
  relationType: string;
  scale: string;
  coveragePolicy: 'none';
}

/** Scales declared by state sync, in declaration order. */
const STATE_SCALES = [
  {
    id: 'junior-reference',
    mode: 'categorical',
    levels: [{ observation: 'references', value: 3 }],
  },
  {
    id: 'junior-mitigation',
    mode: 'categorical',
    levels: [
      { observation: 'planned', value: 1 },
      { observation: 'implemented', value: 3 },
      { observation: 'verified', value: 9 },
    ],
  },
] as const;

/** Relations state sync may declare, in declaration order. */
const STATE_RELATIONS: readonly StateRelation[] = [
  {
    relationId: 'junior-fmeca-cpm',
    from: 'fmeca',
    to: 'cpm',
    relationType: 'concerns',
    scale: 'junior-reference',
    coveragePolicy: 'none',
  },
  {
    relationId: 'junior-fmeca-code',
    from: 'fmeca',
    to: 'code',
    relationType: 'concerns',
    scale: 'junior-reference',
    coveragePolicy: 'none',
  },
  {
    relationId: 'junior-cpm-fmeca',
    from: 'cpm',
    to: 'fmeca',
    relationType: 'mitigates',
    scale: 'junior-mitigation',
    coveragePolicy: 'none',
  },
];

const MITIGATION_STATUSES = new Set(['planned', 'implemented', 'verified']);

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
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
// cpm plan: acceptance criteria that name fmeca mitigations
// ---------------------------------------------------------------------------

interface PlanDeliverable {
  id: string;
  acceptance: unknown[];
}

/** Deliverables and their `metadata.junior.acceptance` entries from plan.get. */
function planDeliverableAcceptance(plan: unknown): PlanDeliverable[] {
  return strictItems(planDeliverables(plan), 'cpm', 'plan.get', plan)
    .filter(isRecord)
    .map((deliverable) => {
      const junior = isRecord(deliverable.metadata?.junior) ? deliverable.metadata.junior : {};
      return {
        id: text(deliverable.id),
        acceptance: asArray(junior.acceptance),
      };
    })
    .filter((deliverable) => deliverable.id.length > 0);
}

/** criterion id (or AC<n>) -> mitigates entries from one acceptance entry. */
function acceptanceMitigates(entry: unknown, index: number): { criterionId: string; mitigates: string[] } {
  if (!isRecord(entry)) return { criterionId: `AC${index + 1}`, mitigates: [] };
  return {
    criterionId: text(entry.id) || `AC${index + 1}`,
    mitigates: asArray(entry.mitigates).map(text).filter(Boolean),
  };
}

interface Mitigation {
  failureModeId: string;
  status: string;
}

/** Index every mitigation under its failure mode, in state order. */
function mitigationIndex(state: unknown): Map<string, Mitigation> {
  const index = new Map<string, Mitigation>();
  for (const raw of strictItems(fmecaFailureModes(state), 'fmeca', 'state.get', state)) {
    if (!isRecord(raw)) continue;
    const failureModeId = text(raw.id ?? raw.failure_mode_id ?? raw.name);
    if (!failureModeId) continue;
    for (const mitigation of asArray(raw.mitigations)) {
      if (!isRecord(mitigation)) continue;
      const id = text(mitigation.id ?? mitigation.mitigation_id);
      if (!id) continue;
      index.set(id, { failureModeId, status: text(mitigation.status).trim().toLowerCase() });
    }
  }
  return index;
}

function mitigationObservations(
  deliverables: readonly PlanDeliverable[],
  mitigations: Map<string, Mitigation>,
  planId: string,
  fmecaSession: string,
  notes: string[],
): StateObservation[] {
  const observations: StateObservation[] = [];
  for (const deliverable of deliverables) {
    deliverable.acceptance.forEach((entry, index) => {
      const { criterionId, mitigates } = acceptanceMitigates(entry, index);
      for (const reference of mitigates) {
        const separator = reference.indexOf('/');
        if (separator < 0) {
          notes.push(`plan criterion ${criterionId} mitigation '${reference}' skipped: expected '<session>/<mitigation id>'`);
          continue;
        }
        const session = reference.slice(0, separator);
        const mitigationId = reference.slice(separator + 1);
        if (session !== fmecaSession) {
          notes.push(`plan criterion ${criterionId} mitigation ${reference} skipped: another fmeca session`);
          continue;
        }
        const mitigation = mitigations.get(mitigationId);
        if (!mitigation) {
          notes.push(`plan criterion ${criterionId} mitigation ${reference} skipped: unknown mitigation`);
          continue;
        }
        if (!MITIGATION_STATUSES.has(mitigation.status)) continue;
        const criterionRef = `cpm:${planId}/${deliverable.id}`;
        const mitigationRef = `fmeca:${fmecaSession}/${mitigationId}`;
        observations.push({
          relationId: 'junior-cpm-fmeca',
          from: `cpm:${deliverable.id}`,
          to: `fm:${mitigation.failureModeId}`,
          observation: mitigation.status,
          confidence: 'high',
          evidence: [
            evidence(
              'cpm',
              'acceptance-mitigation',
              criterionRef,
              criterionId,
              `plan criterion ${criterionId} mitigates ${mitigationId}`,
            ),
            evidence(
              'fmeca',
              'mitigation-status',
              mitigationRef,
              mitigationId,
              `fmeca mitigation ${mitigationId} is ${mitigation.status}`,
            ),
          ],
          rationale: `plan criterion ${criterionId} links ${deliverable.id} to mitigation ${mitigationId}`,
          contentVersion: `cpm-mitigation:${criterionId}:${mitigationId}:${mitigation.status}`,
        });
      }
    });
  }
  return observations;
}

// ---------------------------------------------------------------------------
// fmeca: failure-mode refs -> plan deliverables and code
// ---------------------------------------------------------------------------

const FILE_TOKEN = /[\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z][A-Za-z0-9]*/g;
const MEMBER_TOKEN = /\b(?:cpm|job|journey|fmeca|code|test|loc|file):[\w./:-]+/g;

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
  const fields = [
    'feature',
    'features',
    'files',
    'owned_files',
    'ownedFiles',
    'statement',
    'description',
    'effect',
    'cause',
    'name',
    'label',
  ];
  for (const field of fields) {
    for (const value of stringsIn(mode[field])) {
      for (const match of value.matchAll(MEMBER_TOKEN)) tokens.add(match[0]);
      for (const match of value.matchAll(FILE_TOKEN)) tokens.add(`loc:${match[0]}`);
    }
  }
  return [...tokens];
}

function looksLikePath(value: string): boolean {
  return value.includes('/') || /\.[A-Za-z][A-Za-z0-9]*$/.test(value);
}

function failureModeObservations(
  state: unknown,
  sessionId: string,
  planId: string | undefined,
  notes: string[],
): StateObservation[] {
  const observations: StateObservation[] = [];
  for (const raw of strictItems(fmecaFailureModes(state), 'fmeca', 'state.get', state)) {
    if (!isRecord(raw)) continue;
    const id = text(raw.id ?? raw.failure_mode_id ?? raw.name);
    if (!id) continue;

    const targets: Array<{ relationId: string; to: string; ref: string }> = [];
    const seen = new Set<string>();
    const add = (relationId: string, to: string, ref: string): void => {
      if (!to || to === `fm:${id}`) return;
      const key = `${relationId}\n${to}`;
      if (seen.has(key)) return;
      seen.add(key);
      targets.push({ relationId, to, ref });
    };
    const addCode = (codePath: string, ref: string): void => {
      const cleaned = codePath.replace(/^\/+/, '');
      if (cleaned) add('junior-fmeca-code', `loc:${cleaned}`, ref);
    };

    // `cpm:<deliverable>` or `cpm:<plan_id>/<deliverable>`; a qualified ref to
    // another plan names no member of the synced roster.
    const addCpm = (rest: string, ref: string): void => {
      const separator = rest.indexOf('/');
      if (separator < 0) {
        add('junior-fmeca-cpm', `cpm:${rest}`, ref);
        return;
      }
      const refPlan = rest.slice(0, separator);
      const target = rest.slice(separator + 1);
      if (refPlan !== planId) {
        notes.push(`fmeca failure mode ${id} ref ${ref} skipped: another plan`);
        return;
      }
      if (target.startsWith('loc:') || target.startsWith('file:')) {
        addCode(target.replace(/^(?:loc|file):/, ''), ref);
      } else {
        add('junior-fmeca-cpm', `cpm:${target}`, ref);
      }
    };

    for (const ref of asArray(raw.refs).map(text).filter(Boolean)) {
      if (ref.startsWith('cpm:')) {
        addCpm(ref.slice('cpm:'.length), ref);
        continue;
      }
      if (ref.startsWith('loc:') || ref.startsWith('file:')) {
        addCode(ref.replace(/^(?:loc|file):/, ''), ref);
        continue;
      }
      if (!ref.includes(':') && looksLikePath(ref)) addCode(ref, ref);
    }

    for (const token of fmecaTargets(raw)) {
      if (token.startsWith('cpm:')) {
        addCpm(token.slice('cpm:'.length), token);
      } else if (token.startsWith('loc:')) {
        addCode(token.slice('loc:'.length), token);
      } else if (token.startsWith('file:')) {
        addCode(token.slice('file:'.length), token);
      }
    }

    const ref = `fmeca:${sessionId}/${id}`;
    for (const target of targets) {
      observations.push({
        relationId: target.relationId,
        from: `fm:${id}`,
        to: target.to,
        observation: 'references',
        confidence: 'medium',
        evidence: [evidence('fmeca', 'failure-mode-ref', ref, target.ref, `fmeca failure mode ${id} references ${target.to}`)],
        rationale: `fmeca failure mode ${id} references ${target.to}`,
        contentVersion: `fmeca-ref:${target.to}`,
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

function command(modelId: string, op: CommandRequest['op'], requestId: string): CommandRequest {
  return {
    schemaVersion: CROSSMATRIX_WRITE_SCHEMA_VERSION,
    requestId,
    modelId,
    actor: { actorType: 'system', persona: 'model_admin' },
    op,
  };
}

interface SendOutcome {
  ok: boolean;
  requestId: string;
  code: string | null;
  detail: string;
}

async function send(
  call: typeof callHop,
  load: typeof loadHop,
  hopPath: string,
  request: CommandRequest,
): Promise<SendOutcome> {
  assertWriteCapable(load, hopPath);
  const outcome = await call(hopPath, 'crossmatrix', {
    tool: 'crossmatrix.command',
    arguments: { request },
  });
  const result = outcome.result;
  const code = isRecord(result) && isRecord(result.error) && typeof result.error.code === 'string'
    ? result.error.code
    : null;
  if (!outcome.ok) {
    return {
      ok: false,
      requestId: request.requestId,
      code,
      detail: serverErrorDetail(outcome) ?? outcome.error?.message ?? outcome.note ?? 'unknown error',
    };
  }
  return { ok: true, requestId: request.requestId, code: null, detail: '' };
}

/** Read one tool's state; a missing/failed tool is a note, never an error. */
async function readState(
  call: typeof callHop,
  hopPath: string,
  tool: 'cpm' | 'fmeca',
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

function relationVersion(relation: StateRelation): string {
  return `${relation.from}|${relation.to}|${relation.relationType}|${relation.scale}|${relation.coveragePolicy}`;
}

/**
 * Mirror every configured companion tool's state into crossmatrix. Each source
 * is optional; a missing flag or unavailable tool is skipped with a note.
 */
export async function syncState(options: StateSyncOptions): Promise<StateSyncResult> {
  const call = options.deps?.callHop ?? callHop;
  const load = options.deps?.loadHop ?? loadHop;
  const notes: string[] = [];
  const failures: string[] = [];
  const observations: StateObservation[] = [];

  /** Record a ShapeError as a note; any other error still fails the sync. */
  const mapOrNote = (map: () => void): void => {
    try {
      map();
    } catch (error) {
      if (!(error instanceof ShapeError)) throw error;
      notes.push(error.message);
    }
  };

  let deliverables: PlanDeliverable[] = [];
  if (options.planId) {
    const plan = await readState(call, options.hopPath, 'cpm', 'plan.get', { plan_id: options.planId }, notes);
    if (plan !== undefined) {
      mapOrNote(() => {
        deliverables = planDeliverableAcceptance(plan);
      });
    }
  } else {
    notes.push('cpm plan.get skipped: no --plan');
  }

  let mitigations = new Map<string, Mitigation>();
  if (options.fmecaSession) {
    const state = await readState(
      call,
      options.hopPath,
      'fmeca',
      'state.get',
      { session_id: options.fmecaSession },
      notes,
    );
    if (state !== undefined) {
      mapOrNote(() => {
        observations.push(...failureModeObservations(state, options.fmecaSession!, options.planId, notes));
      });
      mapOrNote(() => {
        mitigations = mitigationIndex(state);
      });
    }
  } else {
    notes.push('fmeca state.get skipped: no --fmeca-session');
  }

  if (options.planId && options.fmecaSession) {
    mapOrNote(() => {
      observations.push(
        ...mitigationObservations(
          deliverables,
          mitigations,
          options.planId!,
          options.fmecaSession!,
          notes,
        ),
      );
    });
  }

  if (options.elicitationSession) {
    notes.push('elicitation not mirrored: no dimension holds its members (ADR 0012 R5)');
  } else {
    notes.push('elicitation state.get skipped: no --elicitation-session');
  }

  if (options.spSession) {
    notes.push('scientific-process not mirrored: no dimension holds its members (ADR 0012 R5)');
  } else {
    notes.push('scientific-process state.get skipped: no --sp-session');
  }

  if (options.jevitateResults) {
    notes.push('jevitate not mirrored: no dimension holds its members (ADR 0012 R5)');
  } else {
    notes.push('jevitate results skipped: no --jevitate-results');
  }

  const usedRelations = STATE_RELATIONS.filter((relation) =>
    observations.some((observation) => observation.relationId === relation.relationId),
  );
  const usedScales = new Set(usedRelations.map((relation) => relation.scale));

  const sent: CodemapSent[] = [];
  const unavailableScales = new Set<string>();

  for (const scale of STATE_SCALES) {
    if (!usedScales.has(scale.id)) continue;
    const requestId = requestIdFor(options.modelId, 'scale.declare', scale.id, scale.mode);
    const outcome = await send(
      call,
      load,
      options.hopPath,
      command(options.modelId, { kind: 'scale.declare', scale }, requestId),
    );
    if (outcome.ok) {
      sent.push({ requestId, kind: 'scale.declare' });
    } else {
      unavailableScales.add(scale.id);
      failures.push(`scale ${scale.id} declare failed: ${outcome.detail}`);
    }
  }

  for (const relation of usedRelations) {
    if (unavailableScales.has(relation.scale)) continue;
    const requestId = requestIdFor(
      options.modelId,
      'relation.declare',
      relation.relationId,
      relationVersion(relation),
    );
    const declaration = await send(
      call,
      load,
      options.hopPath,
      command(
        options.modelId,
        {
          kind: 'relation.declare',
          relationId: relation.relationId,
          from: relation.from,
          to: relation.to,
          relationType: relation.relationType,
          scale: relation.scale,
          coveragePolicy: relation.coveragePolicy,
        },
        requestId,
      ),
    );
    if (!declaration.ok) {
      if (declaration.code === 'unknown_dimension') {
        notes.push(`${relation.relationId} not declared: ${declaration.detail}`);
      } else {
        failures.push(`${relation.relationId} declare failed: ${declaration.detail}`);
      }
      continue;
    }
    sent.push({ requestId, kind: 'relation.declare' });

    for (const observation of observations.filter((item) => item.relationId === relation.relationId)) {
      const version = `${observation.relationId}|${observation.from}|${observation.to}|${observation.observation}|${observation.contentVersion}`;
      const observeId = requestIdFor(options.modelId, 'observe', observation.relationId, version);
      const outcome = await send(
        call,
        load,
        options.hopPath,
        command(
          options.modelId,
          {
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
          observeId,
        ),
      );
      if (outcome.ok) {
        sent.push({ requestId: observeId, kind: 'observe' });
        continue;
      }
      // A reference to a file or deliverable no longer in its roster is stale
      // fmeca data, not a failed sync.
      if (outcome.code === 'unknown_member' && observation.observation === 'references') {
        notes.push(`${observation.relationId} ${observation.from} -> ${observation.to} skipped: ${outcome.detail}`);
      } else {
        failures.push(
          `${observation.relationId} observe ${observation.from} -> ${observation.to} failed: ${outcome.detail}`,
        );
      }
    }
  }

  return {
    modelId: options.modelId,
    requestIds: sent.map((entry) => entry.requestId),
    sent,
    observations,
    notes,
    failures,
  };
}
