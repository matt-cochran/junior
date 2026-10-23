// ---------------------------------------------------------------------------
// Code-map write side (Crossmatrix 0.3+).
//
// `codemapInit` declares the feature-to-code configuration in a Crossmatrix
// model: one categorical `codemap` scale, one `implements` relation from each
// feature dimension to `code`, and one `code -> code` `contains` relation.
//
// `codemapLink` reads a Junior `result.json` and records each file the handoff
// changed as one `observe` link from the feature member to a `loc:<path>` code
// location. Request ids are content-addressed over the observation, so
// re-linking the same result replays byte-for-byte identical writes.
//
// Both entry points reuse `matrix-sync.ts`'s command envelope constant and
// request-id hashing, and refuse a server older than Crossmatrix 0.3.0 before
// sending anything. `status`/lifecycle is the server's job and never sent.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { codeLocations, tests as testArtifacts, type MatrixFile } from './matrix.ts';
import {
  CROSSMATRIX_WRITE_SCHEMA_VERSION,
  requestIdFor,
  serverErrorDetail,
  type CommandRequest,
} from './matrix-sync.ts';
import { callHop, loadHop } from './tools/tools.ts';

const MIN_SOURCE_VERSION = [0, 3, 0] as const;

/** Default feature dimensions declared by `codemapInit`. */
export const DEFAULT_FEATURE_DIMENSIONS = ['cpm', 'jevitate-jobs', 'jevitate-journeys'] as const;

/** The categorical observations a code-map link can carry. */
export const CODEMAP_LEVELS = [
  { observation: 'implements', value: 9 },
  { observation: 'tests', value: 3 },
  { observation: 'touches', value: 1 },
] as const;

export type CodemapObservation = 'implements' | 'tests' | 'touches';

const OBSERVATIONS: readonly CodemapObservation[] = ['implements', 'tests', 'touches'];

export interface CodemapDeps {
  callHop?: typeof callHop;
  loadHop?: typeof loadHop;
}

export interface CodemapInitOptions {
  hopPath: string;
  modelId: string;
  /** Feature dimension ids to wire to `code`; defaults to `DEFAULT_FEATURE_DIMENSIONS`. */
  featureDimensions?: readonly string[];
  deps?: CodemapDeps;
}

export interface CodemapLinkOptions {
  hopPath: string;
  modelId: string;
  resultPath: string;
  /** `<dimensionId>:<memberId>` whose members the changed files implement. */
  feature: string;
  observation?: CodemapObservation;
  deps?: CodemapDeps;
}

/** One command the module sent, in order. */
export interface CodemapSent {
  requestId: string;
  kind: string;
}

export interface CodemapResult {
  modelId: string;
  requestIds: string[];
  sent: CodemapSent[];
}

/** Parse the leading `major[.minor[.patch]]` of a version string. */
function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** True when `actual` is a valid version >= `min` (prerelease tags ignored). */
function versionAtLeast(actual: string | undefined, min: readonly number[]): boolean {
  if (!actual) return false;
  const parsed = parseVersion(actual);
  if (!parsed) return false;
  for (let i = 0; i < 3; i++) {
    if (parsed[i] !== min[i]) return parsed[i] > min[i];
  }
  return true;
}

/** Refuse to build any command against a server below Crossmatrix 0.3.0. */
function assertWriteCapable(load: typeof loadHop, hopPath: string): void {
  const hop = load(hopPath);
  const recorded = hop.tools?.crossmatrix?.sourceVersion;
  if (!versionAtLeast(recorded, MIN_SOURCE_VERSION)) {
    throw new Error(
      `codemap requires Crossmatrix 0.3.0 or newer (hop records ${recorded ?? 'missing'})`,
    );
  }
}

/** Build the deterministic command envelope for one op. */
function command(modelId: string, op: CommandRequest['op'], requestId: string): CommandRequest {
  return {
    schemaVersion: CROSSMATRIX_WRITE_SCHEMA_VERSION,
    requestId,
    modelId,
    actor: { actorType: 'system', persona: 'model_admin' },
    op,
  };
}

/** Send exactly one write command and surface upstream failures clearly. */
async function send(
  call: typeof callHop,
  hopPath: string,
  request: CommandRequest,
): Promise<CodemapSent> {
  const outcome = await call(hopPath, 'crossmatrix', {
    tool: 'crossmatrix.command',
    arguments: { request },
    // Leave the automatic store-session open to the ad-hoc `tools call` path;
    // codemap keeps its existing command sequence.
  });
  if (!outcome.ok) {
    const detail = serverErrorDetail(outcome) ?? outcome.error?.message ?? outcome.note ?? 'unknown error';
    throw new Error(`codemap ${request.op.kind} failed: ${detail}`);
  }
  return { requestId: request.requestId, kind: request.op.kind };
}

/** `code` + each feature dimension + the `code -> code` containment relation. */
export async function codemapInit(options: CodemapInitOptions): Promise<CodemapResult> {
  const call = options.deps?.callHop ?? callHop;
  const load = options.deps?.loadHop ?? loadHop;
  assertWriteCapable(load, options.hopPath);

  const features = options.featureDimensions ?? DEFAULT_FEATURE_DIMENSIONS;
  const sent: CodemapSent[] = [];

  const scaleId = requestIdFor(options.modelId, 'scale.declare', 'codemap', 'categorical');
  sent.push(
    await send(
      call,
      options.hopPath,
      command(
        options.modelId,
        { kind: 'scale.declare', scale: { id: 'codemap', mode: 'categorical', levels: CODEMAP_LEVELS } },
        scaleId,
      ),
    ),
  );

  for (const dimensionId of features) {
    const relationId = `codemap-${dimensionId}`;
    const relationVersion = `${dimensionId}|code|implements|codemap|none`;
    sent.push(
      await send(
        call,
        options.hopPath,
        command(
          options.modelId,
          {
            kind: 'relation.declare',
            relationId,
            from: dimensionId,
            to: 'code',
            relationType: 'implements',
            scale: 'codemap',
            coveragePolicy: 'none',
          },
          requestIdFor(options.modelId, 'relation.declare', relationId, relationVersion),
        ),
      ),
    );
  }

  sent.push(
    await send(
      call,
      options.hopPath,
      command(
        options.modelId,
        {
          kind: 'relation.declare',
          relationId: 'codemap-contains',
          from: 'code',
          to: 'code',
          relationType: 'contains',
          scale: 'codemap',
          coveragePolicy: 'none',
        },
        requestIdFor(options.modelId, 'relation.declare', 'codemap-contains', 'code|code|contains|codemap|none'),
      ),
    ),
  );

  return { modelId: options.modelId, requestIds: sent.map((entry) => entry.requestId), sent };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalize a changed-file path to POSIX form for the `loc:` target. */
function posixPath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** True when a changed path is the handoff's own `.delivery/` output. */
function isDeliveryPath(p: string): boolean {
  return p === '.delivery' || p.startsWith('.delivery/');
}

/** Changed file paths from `evidence.runChangedFiles`, falling back to `changedFiles`. */
function changedFiles(result: unknown): string[] {
  const evidence = isRecord(result) && isRecord(result.evidence) ? result.evidence : {};
  const raw = evidence.runChangedFiles ?? evidence.changedFiles ?? [];
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((entry) => (typeof entry === 'string' ? entry : isRecord(entry) ? entry.path : undefined))
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map(posixPath)
    .filter((p) => !isDeliveryPath(p));
}

/** A test file as defined by `matrix.ts`'s `tests` adapter. */
function isTestFile(p: string): boolean {
  const dimension = testArtifacts([{ path: p }]);
  return dimension.members.some(
    (member) => member.attributes?.type === 'file' && member.attributes?.path === p,
  );
}

/** Split `<dimensionId>:<memberId>` on the first colon (member ids may contain colons). */
/** Member id prefixes the matrix adapters use per dimension. */
const MEMBER_PREFIX: Record<string, string> = { cpm: 'cpm', 'jevitate-jobs': 'job', 'jevitate-journeys': 'journey', fmeca: 'fm' };

function parseFeature(feature: string): { dimensionId: string; memberId: string } {
  const separator = feature.indexOf(':');
  if (separator === -1) throw new Error(`invalid feature '${feature}': expected <dimensionId>:<memberId>`);
  const dimensionId = feature.slice(0, separator);
  const memberId = feature.slice(separator + 1);
  if (!dimensionId || !memberId) throw new Error(`invalid feature '${feature}': expected <dimensionId>:<memberId>`);
  // The matrix adapters prefix member ids (cpm:<id>, job:<id>, journey:<id>);
  // accept a bare id for those dimensions and add the prefix.
  const prefix = MEMBER_PREFIX[dimensionId];
  if (prefix && !memberId.startsWith(`${prefix}:`)) return { dimensionId, memberId: `${prefix}:${memberId}` };
  return { dimensionId, memberId };
}

/** One Crossmatrix evidence item: only sourceRef, locator and excerpt are allowed. */
export interface CodemapEvidence {
  sourceRef: { system: string; sourceType: string; sourceRef: string; locator?: string };
  locator: string;
  excerpt: string;
}

export interface CodemapObserveOptions {
  hopPath: string;
  modelId: string;
  /** `<dimensionId>:<memberId>` the observation starts from. */
  feature: string;
  /** Code location path (without the `loc:` prefix). */
  path: string;
  observation: CodemapObservation;
  confidence: 'high' | 'medium' | 'low';
  evidence: CodemapEvidence[];
  rationale: string;
  /** Stable content identity for the request id; defaults to the confidence. */
  contentVersion?: string;
  deps?: CodemapDeps;
}

/**
 * Record one `observe` link from a feature member to a `loc:<path>` code
 * location. Request ids are content-addressed over the relation, member, target,
 * observation and `contentVersion`, so replaying the same observation is a
 * no-op. Shared by `codemapLink` and the autopilot's `confirm`.
 */
export async function codemapObserve(options: CodemapObserveOptions): Promise<CodemapSent> {
  const call = options.deps?.callHop ?? callHop;
  const load = options.deps?.loadHop ?? loadHop;
  assertWriteCapable(load, options.hopPath);
  if (!OBSERVATIONS.includes(options.observation)) {
    throw new Error(`unknown codemap observation '${options.observation}'`);
  }

  const { dimensionId, memberId } = parseFeature(options.feature);
  const relationId = `codemap-${dimensionId}`;
  const to = `loc:${options.path}`;
  const version = `${relationId}|${memberId}|${to}|${options.observation}|${options.contentVersion ?? options.confidence}`;
  const requestId = requestIdFor(options.modelId, 'observe', relationId, version);
  return send(
    call,
    options.hopPath,
    command(
      options.modelId,
      {
        kind: 'observe',
        relationId,
        from: memberId,
        to,
        observation: options.observation,
        provenanceClass: 'observed',
        confidence: options.confidence,
        evidence: options.evidence,
        rationale: options.rationale,
      },
      requestId,
    ),
  );
}

/** Record each changed file as an `observe` link from the feature member. */
export async function codemapLink(options: CodemapLinkOptions): Promise<CodemapResult> {
  const load = options.deps?.loadHop ?? loadHop;
  assertWriteCapable(load, options.hopPath);

  const result: unknown = JSON.parse(fs.readFileSync(options.resultPath, 'utf8'));
  const record = isRecord(result) ? result : {};
  const resultId = String(record.id ?? '');
  const files = changedFiles(result);

  const sent: CodemapSent[] = [];
  for (const path of files) {
    const observation =
      options.observation ?? (isTestFile(path) ? 'tests' : 'implements');
    if (!OBSERVATIONS.includes(observation)) {
      throw new Error(`unknown codemap observation '${observation}'`);
    }
    sent.push(
      await codemapObserve({
        hopPath: options.hopPath,
        modelId: options.modelId,
        feature: options.feature,
        path,
        observation,
        confidence: 'high',
        contentVersion: resultId,
        // Crossmatrix evidence items allow only sourceRef, locator and excerpt.
        evidence: [
          {
            sourceRef: {
              system: 'junior',
              sourceType: 'handoff',
              sourceRef: `junior-handoff:${resultId}`,
              locator: String(record.artifactDir ?? ''),
            },
            locator: String(record.artifactDir ?? ''),
            excerpt: `Junior handoff ${resultId} (${String(record.status ?? 'unknown')})`,
          },
        ],
        rationale: `changed by Junior handoff ${resultId}`,
        deps: options.deps,
      }),
    );
  }

  return { modelId: options.modelId, requestIds: sent.map((entry) => entry.requestId), sent };
}

// ---------------------------------------------------------------------------
// Code-map read side (Crossmatrix 0.3+).
//
// `codemapFiles` walks the feature member's outgoing `codemap-*` links to `loc:`
// code members, following the server's `nextCursor` until exhausted.
// `codemapContext` turns that list into a Junior contract `context` array, and
// `codemapStale` recomputes the checkout's content hashes and asks the server
// which synced members changed. Every query goes through the wrapper's
// `crossmatrix.query`, which prepends the store-session `model.open` itself.
// ---------------------------------------------------------------------------

/** One feature-to-code link as returned by `codemapFiles`. */
export interface CodemapFile {
  path: string;
  observation: CodemapObservation;
  relation: string;
}

export interface CodemapFilesOptions {
  hopPath: string;
  modelId: string;
  feature: string;
  deps?: CodemapDeps;
}

export interface CodemapContextOptions extends CodemapFilesOptions {
  /** Maximum context entries to emit; defaults to 20 (Junior's `CONTEXT_MAX_ENTRIES`). */
  max?: number;
}

export interface CodemapStaleOptions {
  hopPath: string;
  modelId: string;
  /** Project directory whose `git ls-files` roster is hashed. */
  dir: string;
  deps?: CodemapDeps;
}

export interface CodemapStaleResult {
  changed: unknown[];
  affectedCells: unknown[];
}

/** Rank order the context array follows: implements > tests > touches. */
const OBSERVATION_RANK: Record<CodemapObservation, number> = {
  implements: 9,
  tests: 3,
  touches: 1,
};

const LOC_PREFIX = 'loc:';

interface CrossmatrixQuery {
  kind: string;
  [key: string]: unknown;
}

/** Run one `crossmatrix.query` and surface upstream failures clearly. */
async function query(
  call: typeof callHop,
  hopPath: string,
  modelId: string,
  q: CrossmatrixQuery,
): Promise<unknown> {
  const outcome = await call(hopPath, 'crossmatrix', {
    tool: 'crossmatrix.query',
    arguments: {
      request: {
        schemaVersion: CROSSMATRIX_WRITE_SCHEMA_VERSION,
        modelId,
        query: q,
      },
    },
  });
  if (!outcome.ok) {
    const detail = serverErrorDetail(outcome) ?? outcome.error?.message ?? outcome.note ?? 'unknown error';
    throw new Error(`codemap ${q.kind} failed: ${detail}`);
  }
  return outcome.result;
}

/** A page's `nextCursor`, treating null/empty as exhausted. */
function nextCursorOf(page: unknown): string | undefined {
  if (!isRecord(page)) return undefined;
  const next = page.nextCursor;
  if (next === undefined || next === null || next === '') return undefined;
  return String(next);
}

/** The first recognized observation token on a hop, if any. */
function observationOf(hop: Record<string, any>): CodemapObservation | null {
  const tokens = Array.isArray(hop.observations) ? hop.observations : [];
  for (const token of tokens) if (OBSERVATIONS.includes(token)) return token;
  return OBSERVATIONS.includes(hop.observation) ? hop.observation : null;
}

/** List the feature's outgoing `codemap-*` links to `loc:` code members. */
export async function codemapFiles(options: CodemapFilesOptions): Promise<CodemapFile[]> {
  const call = options.deps?.callHop ?? callHop;
  const load = options.deps?.loadHop ?? loadHop;
  assertWriteCapable(load, options.hopPath);
  const { memberId } = parseFeature(options.feature);

  const found: CodemapFile[] = [];
  let cursor: string | undefined;
  do {
    const q: CrossmatrixQuery = { kind: 'trace', member: memberId };
    if (cursor !== undefined) q.cursor = cursor;
    const page = await query(call, options.hopPath, options.modelId, q);
    const hops = isRecord(page) && Array.isArray(page.hops) ? page.hops : [];
    for (const raw of hops) {
      if (!isRecord(raw)) continue;
      if (raw.direction !== 'out') continue;
      if (typeof raw.relation !== 'string' || !raw.relation.startsWith('codemap-')) continue;
      if (typeof raw.member !== 'string' || !raw.member.startsWith(LOC_PREFIX)) continue;
      const observation = observationOf(raw);
      if (observation === null) continue;
      found.push({ path: raw.member.slice(LOC_PREFIX.length), observation, relation: raw.relation });
    }
    cursor = nextCursorOf(page);
  } while (cursor !== undefined);

  found.sort(
    (a, b) =>
      OBSERVATION_RANK[b.observation] - OBSERVATION_RANK[a.observation] ||
      a.path.localeCompare(b.path),
  );
  return found;
}

/** A Junior contract `context` array: ranked, deduplicated paths capped at `max`. */
export async function codemapContext(
  options: CodemapContextOptions,
): Promise<Array<{ path: string }>> {
  const files = await codemapFiles(options);
  const max = options.max ?? 20;
  const seen = new Set<string>();
  const context: Array<{ path: string }> = [];
  for (const file of files) {
    if (file.path.endsWith('/')) continue;
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    context.push({ path: file.path });
    if (context.length >= max) break;
  }
  return context;
}

/** Project paths that never belong to the synced code roster. */
export const DEFAULT_CODE_EXCLUDES = [
  '.changeset/**',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/Cargo.lock',
  '**/__snapshots__/**',
  '**/*.snap',
] as const;

/** Convert one forward-slash glob into a full-path regular expression. */
function globRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/** True when `path` is a code-roster candidate after `.crossmatrix/` and excludes. */
export function isCodeRosterPath(path: string, excludes: readonly string[]): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized === '.crossmatrix' || normalized.startsWith('.crossmatrix/')) return false;
  return !excludes.some((pattern) => globRegExp(pattern.replace(/\\/g, '/')).test(normalized));
}

/** Load `codemap.exclude` from `<dir>/delivery.config.json`, or the defaults. */
export function loadCodeExcludes(dir: string): readonly string[] {
  const configPath = join(dir, 'delivery.config.json');
  if (!fs.existsSync(configPath)) return DEFAULT_CODE_EXCLUDES;
  const config: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!isRecord(config) || !isRecord(config.codemap) || !Array.isArray(config.codemap.exclude)) {
    return DEFAULT_CODE_EXCLUDES;
  }
  return config.codemap.exclude.map(String);
}

/** Tracked files under `dir` with their bytes, as `matrix.ts`'s adapters expect. */
function trackedFiles(dir: string): MatrixFile[] {
  const listing = spawnSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' });
  if (listing.status !== 0) {
    throw new Error(`git ls-files failed in ${dir}: ${listing.stderr?.trim() ?? 'unknown error'}`);
  }
  const excludes = loadCodeExcludes(dir);
  const files: MatrixFile[] = [];
  for (const line of listing.stdout.split('\n')) {
    const p = line.trim();
    if (!p) continue;
    if (!isCodeRosterPath(p, excludes)) continue;
    files.push({ path: p, content: fs.readFileSync(join(dir, p)) });
  }
  return files;
}

/**
 * Report synced members whose content hash no longer matches the checkout.
 * `readFiles` is never sent: Junior members carry `git` sourceRefs, not
 * `file://` URIs, so only the explicit `hashes` map is meaningful.
 */
export async function codemapStale(options: CodemapStaleOptions): Promise<CodemapStaleResult> {
  const call = options.deps?.callHop ?? callHop;
  const load = options.deps?.loadHop ?? loadHop;
  assertWriteCapable(load, options.hopPath);

  const files = trackedFiles(options.dir);
  const hashes: Record<string, string> = {};
  for (const dimension of [codeLocations(files), testArtifacts(files)]) {
    for (const member of dimension.members) {
      // Crossmatrix keys `stale` hashes by the member's source reference (its
      // uri, else sourceRef.sourceRef = the file path), not by member id.
      const key = member.sourceRef?.sourceRef;
      if (key && member.sourceRef?.contentHash) hashes[key] = member.sourceRef.contentHash;
    }
  }

  const changed: unknown[] = [];
  const affectedCells: unknown[] = [];
  let cursor: string | undefined;
  do {
    const q: CrossmatrixQuery = { kind: 'stale', hashes };
    if (cursor !== undefined) q.cursor = cursor;
    const page = await query(call, options.hopPath, options.modelId, q);
    if (isRecord(page)) {
      if (Array.isArray(page.changed)) changed.push(...page.changed);
      if (Array.isArray(page.affectedCells)) affectedCells.push(...page.affectedCells);
    }
    cursor = nextCursorOf(page);
  } while (cursor !== undefined);

  return { changed, affectedCells };
}
