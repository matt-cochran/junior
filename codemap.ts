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
import { tests as testArtifacts } from './matrix.ts';
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

/** Record each changed file as an `observe` link from the feature member. */
export async function codemapLink(options: CodemapLinkOptions): Promise<CodemapResult> {
  const call = options.deps?.callHop ?? callHop;
  const load = options.deps?.loadHop ?? loadHop;
  assertWriteCapable(load, options.hopPath);

  const { dimensionId, memberId } = parseFeature(options.feature);
  const relationId = `codemap-${dimensionId}`;
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
    const to = `loc:${path}`;
    const version = `${relationId}|${memberId}|${to}|${observation}|${resultId}`;
    const requestId = requestIdFor(options.modelId, 'observe', relationId, version);
    sent.push(
      await send(
        call,
        options.hopPath,
        command(
          options.modelId,
          {
            kind: 'observe',
            relationId,
            from: memberId,
            to,
            observation,
            provenanceClass: 'observed',
            confidence: 'high',
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
          },
          requestId,
        ),
      ),
    );
  }

  return { modelId: options.modelId, requestIds: sent.map((entry) => entry.requestId), sent };
}
