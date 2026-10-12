// ---------------------------------------------------------------------------
// Crossmatrix 0.3+ write-API sync.
//
// `syncDimensions` is the side-effecting counterpart to the pure `matrix.ts`
// adapters: it takes already-built ADR-0004 `Dimension` objects and pushes their
// rosters into a Crossmatrix 0.3+ model through the wrapper's `callHop`:
//
//   model.open (once) -> dimension.register -> members.sync  (per dimension)
//
// Request ids are content-addressed so an unchanged roster replays byte-for-
// byte identical writes and the server can treat them idempotently. Member
// `status` is deliberately not sent: lifecycle/deprecation is the server's job.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { buildDimensionSet, type MatrixDimension, type MatrixMember } from './matrix.ts';
import { callHop, loadHop } from './tools/tools.ts';

/** Schema version of the Crossmatrix write-API command envelope. */
export const CROSSMATRIX_WRITE_SCHEMA_VERSION = '0.3.0';

const MIN_SOURCE_VERSION = [0, 3, 0] as const;

/** A single write-API command envelope accepted by `crossmatrix.command`. */
export interface CommandRequest {
  schemaVersion: '0.3.0';
  requestId: string;
  modelId: string;
  actor: { actorType: 'system'; persona: 'model_admin' };
  op: { kind: string } & Record<string, unknown>;
}

/** The fields a member keeps on the wire; `status`/`supersededBy` are dropped. */
export interface SyncMember {
  id: string;
  label?: string;
  weightObservation?: string;
  weight?: number;
  sourceRef?: MatrixMember['sourceRef'];
  attributes?: Record<string, unknown>;
}

export interface SyncedDimension {
  dimensionId: string;
  members: number;
  requestIds: string[];
}

export interface SyncDimensionsResult {
  modelId: string;
  synced: SyncedDimension[];
}

export interface SyncDeps {
  callHop?: typeof callHop;
  loadHop?: typeof loadHop;
}

export interface SyncDimensionsOptions {
  hopPath: string;
  modelId: string;
  dimensions: MatrixDimension[];
  deps?: SyncDeps;
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

/** `jr-` + the first 16 hex chars of sha256(modelId + op.kind + dimensionId + version). */
export function requestIdFor(
  modelId: string,
  opKind: string,
  dimensionId: string,
  contentVersion: string,
): string {
  const digest = createHash('sha256')
    .update(`${modelId}${opKind}${dimensionId}${contentVersion}`)
    .digest('hex');
  return `jr-${digest.slice(0, 16)}`;
}

/** Project a matrix member onto the write API's member shape (drop `status`). */
function syncMember(member: MatrixMember): SyncMember {
  const projected: SyncMember = { id: member.id };
  if (member.label !== undefined) projected.label = member.label;
  if (member.weightObservation !== undefined) projected.weightObservation = member.weightObservation;
  if (member.weight !== undefined) projected.weight = member.weight;
  if (member.sourceRef !== undefined) projected.sourceRef = member.sourceRef;
  if (member.attributes !== undefined) projected.attributes = member.attributes;
  return projected;
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
  options: SyncDimensionsOptions,
  request: CommandRequest,
): Promise<void> {
  const outcome = await call(options.hopPath, 'crossmatrix', {
    tool: 'crossmatrix.command',
    arguments: { request },
  });
  if (!outcome.ok) {
    const detail = outcome.error?.message ?? outcome.note ?? 'unknown error';
    throw new Error(`matrix sync ${request.op.kind} failed: ${detail}`);
  }
}

/**
 * Push each dimension's roster into a Crossmatrix 0.3+ model. `model.open` is
 * sent once, then every dimension is registered before its members are synced.
 */
export async function syncDimensions(options: SyncDimensionsOptions): Promise<SyncDimensionsResult> {
  const call = options.deps?.callHop ?? callHop;
  const load = options.deps?.loadHop ?? loadHop;

  const hop = load(options.hopPath);
  const recorded = hop.tools?.crossmatrix?.sourceVersion;
  if (!versionAtLeast(recorded, MIN_SOURCE_VERSION)) {
    throw new Error(
      `matrix sync requires Crossmatrix 0.3.0 or newer (hop records ${recorded ?? 'missing'})`,
    );
  }

  await send(
    call,
    options,
    command(options.modelId, { kind: 'model.open' }, requestIdFor(options.modelId, 'model.open', '', '')),
  );

  const synced: SyncedDimension[] = [];
  for (const dimension of options.dimensions) {
    const version = buildDimensionSet(dimension.id, [dimension]).version;

    const registerId = requestIdFor(options.modelId, 'dimension.register', dimension.id, version);
    await send(
      call,
      options,
      command(
        options.modelId,
        {
          kind: 'dimension.register',
          dimensionId: dimension.id,
          dimensionKind: dimension.kind,
          label: dimension.label,
          system: dimension.system,
          order: dimension.order,
        },
        registerId,
      ),
    );

    const syncId = requestIdFor(options.modelId, 'members.sync', dimension.id, version);
    await send(
      call,
      options,
      command(
        options.modelId,
        {
          kind: 'members.sync',
          dimensionId: dimension.id,
          members: dimension.members.map(syncMember),
        },
        syncId,
      ),
    );

    synced.push({ dimensionId: dimension.id, members: dimension.members.length, requestIds: [registerId, syncId] });
  }

  return { modelId: options.modelId, synced };
}
