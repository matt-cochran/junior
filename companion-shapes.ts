// The single module that reads companion responses. Every reader normalises one
// tool method's response into `{ items, shape, recognized }`, accepting every
// recorded and legacy shape and reporting when a non-empty response is not
// recognized. Adopting modules use these readers instead of their own ad hoc
// shape handling.

/** Tool versions with recorded fixtures under tools/test-fixtures/companions. */
export const VERIFIED_VERSIONS: Readonly<Record<string, readonly string[]>> = {
  cpm: ['0.4.0', '0.4.1', '0.4.2'],
  fmeca: ['0.2.0', '0.2.1', '0.2.2'],
  elicitation: ['0.1.0', '0.1.1'],
  'scientific-process': ['0.2.0', '0.3.0'],
};

export type ShapeResult<T> = { items: T[]; shape: string; recognized: boolean };

/** Thrown by `strictItems` for a non-empty response with no known shape. */
export class ShapeError extends Error {
  tool: string;
  method: string;
  keys: string[];

  constructor(tool: string, method: string, keys: string[]) {
    super(
      `Unrecognized ${tool}.${method} response; top-level keys: ${keys.length > 0 ? keys.join(', ') : '(none)'}`,
    );
    this.name = 'ShapeError';
    this.tool = tool;
    this.method = method;
    this.keys = keys;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function topLevelKeys(raw: unknown): string[] {
  return isRecord(raw) ? Object.keys(raw) : [];
}

type Candidate = { shape: string; path: readonly string[] };

function valueAt(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function empty<T>(shape = 'empty'): ShapeResult<T> {
  return { items: [], shape, recognized: true };
}

function unknown<T>(): ShapeResult<T> {
  return { items: [], shape: 'unknown', recognized: false };
}

/**
 * Recognise a response whose items live in the first candidate key holding an
 * array (or, when `allowMap`, an object map). A bare array is shape `array`;
 * null, an empty object and an empty expected array are recognized with no
 * items; a non-empty object with no candidate key is unrecognized.
 */
function recognize<T>(
  raw: unknown,
  candidates: readonly Candidate[],
  map: (item: unknown) => T,
  allowMap = false,
): ShapeResult<T> {
  if (Array.isArray(raw)) return { items: raw.map(map), shape: 'array', recognized: true };
  if (raw === null || raw === undefined) return empty<T>();
  if (!isRecord(raw)) return unknown<T>();
  if (Object.keys(raw).length === 0) return empty<T>();
  for (const candidate of candidates) {
    const value = valueAt(raw, candidate.path);
    if (Array.isArray(value)) return { items: value.map(map), shape: candidate.shape, recognized: true };
    if (allowMap && isRecord(value)) {
      return {
        items: Object.entries(value).map(([key, item]) =>
          isRecord(item) ? map({ ...item, id: (item as any).id ?? key }) : map(item),
        ),
        shape: candidate.shape,
        recognized: true,
      };
    }
  }
  return unknown<T>();
}

// ---------------------------------------------------------------------------
// cpm
// ---------------------------------------------------------------------------

const DELIVERABLE_CANDIDATES: readonly Candidate[] = [
  { shape: 'graph.deliverables', path: ['graph', 'deliverables'] },
  { shape: 'plan.deliverables', path: ['plan', 'deliverables'] },
  { shape: 'deliverables', path: ['deliverables'] },
];

/** Deliverables from a cpm plan graph response. */
export function planDeliverables(result: unknown): ShapeResult<Record<string, any>> {
  return recognize(result, DELIVERABLE_CANDIDATES, (item) => item as Record<string, any>);
}

function statusText(raw: unknown): string {
  const mark = isRecord(raw) ? raw.status ?? raw.mark_status ?? raw.markStatus : raw;
  return text(mark).trim().toLowerCase();
}

function statusRow(row: unknown): { id: string; status: string; raw: unknown } {
  if (Array.isArray(row)) {
    const raw = row.length >= 2 ? row[1] : undefined;
    return { id: text(row[0]), status: statusText(raw), raw };
  }
  if (isRecord(row)) {
    const raw = row.status ?? row.mark_status ?? row.markStatus;
    return {
      id: text(row.id ?? row.deliverableId ?? row.deliverable_id ?? row.slug),
      status: statusText(raw),
      raw,
    };
  }
  return { id: '', status: '', raw: row };
}

/** Deliverable status rows from a cpm `plan.status` response. */
export function planStatusRows(result: unknown): ShapeResult<{ id: string; status: string; raw: unknown }> {
  const candidates: readonly Candidate[] = [
    { shape: 'deliverables', path: ['deliverables'] },
    { shape: 'rows', path: ['rows'] },
    { shape: 'statuses', path: ['statuses'] },
  ];
  return recognize(result, candidates, statusRow);
}

/** Locks from a cpm `plan.acquire_cohort` (`locks`) or `plan.status` (`locks_held`) response. */
export function planLocks(result: unknown): ShapeResult<{ deliverableId: string; callerId: string; expiresAt?: string }> {
  const candidates: readonly Candidate[] = [
    { shape: 'locks', path: ['locks'] },
    { shape: 'locks_held', path: ['locks_held'] },
  ];
  return recognize(result, candidates, (item) => {
    const lock = isRecord(item) ? item : {};
    const expiresAt = lock.expiresAt ?? lock.expires_at;
    return {
      deliverableId: text(lock.deliverableId ?? lock.deliverable_id),
      callerId: text(lock.callerId ?? lock.caller_id),
      ...(expiresAt === null || expiresAt === undefined ? {} : { expiresAt: text(expiresAt) }),
    };
  });
}

/** Deliverable ids from a cpm `plan.acquire_cohort` response; entries may be strings or objects. */
export function cohortDeliverableIds(result: unknown): ShapeResult<string> {
  const candidates: readonly Candidate[] = [{ shape: 'deliverables', path: ['deliverables'] }];
  const base = recognize<string>(result, candidates, (item) => {
    const id = typeof item === 'string' ? item : isRecord(item) ? item.id : undefined;
    return text(id);
  });
  return { ...base, items: base.items.filter((id) => id.length > 0) };
}

// ---------------------------------------------------------------------------
// fmeca
// ---------------------------------------------------------------------------

/** Failure modes from an fmeca session state. */
export function fmecaFailureModes(result: unknown): ShapeResult<Record<string, any>> {
  const candidates: readonly Candidate[] = [
    { shape: 'failure_modes', path: ['failure_modes'] },
    { shape: 'failureModes', path: ['failureModes'] },
    { shape: 'modes', path: ['modes'] },
    { shape: 'risks', path: ['risks'] },
  ];
  return recognize(result, candidates, (item) => item as Record<string, any>);
}

// ---------------------------------------------------------------------------
// elicitation
// ---------------------------------------------------------------------------

/** Claims from an elicitation `state.get` response; array or id-keyed map shape. */
export function elicitationClaims(result: unknown): ShapeResult<Record<string, any>> {
  const candidates: readonly Candidate[] = [
    { shape: 'claims', path: ['claims'] },
    { shape: 'claim_standings', path: ['claim_standings'] },
    { shape: 'claimStandings', path: ['claimStandings'] },
    { shape: 'state.claims', path: ['state', 'claims'] },
  ];
  return recognize(result, candidates, (item) => item as Record<string, any>, true);
}

/** All signals from an elicitation `state.get` response, in server order. */
export function elicitationSignals(result: unknown): ShapeResult<Record<string, any>> {
  const candidates: readonly Candidate[] = [
    { shape: 'signals', path: ['signals'] },
    { shape: 'state.signals', path: ['state', 'signals'] },
  ];
  return recognize(result, candidates, (item) => item as Record<string, any>);
}

/**
 * The single signal from an elicitation `question.next` response: its
 * `question` or `signal` field, or the result itself; null when done or empty.
 */
export function elicitationTopSignal(result: unknown): Record<string, any> | null {
  if (!isRecord(result) || result.done === true) return null;
  const raw = isRecord(result.question) ? result.question : isRecord(result.signal) ? result.signal : result;
  return isRecord(raw) && Object.keys(raw).length > 0 ? raw : null;
}

// ---------------------------------------------------------------------------
// scientific-process
// ---------------------------------------------------------------------------

/** Hypotheses from a scientific-process `state.get`/`report.export` response. */
export function spHypotheses(result: unknown): ShapeResult<Record<string, any>> {
  const candidates: readonly Candidate[] = [
    { shape: 'hypotheses', path: ['hypotheses'] },
    { shape: 'claims', path: ['claims'] },
  ];
  return recognize(result, candidates, (item) => item as Record<string, any>);
}

// ---------------------------------------------------------------------------
// strict access
// ---------------------------------------------------------------------------

/** The items of a recognized result; throws `ShapeError` when unrecognized. */
export function strictItems<T>(r: ShapeResult<T>, tool: string, method: string, raw: unknown): T[] {
  if (!r.recognized) throw new ShapeError(tool, method, topLevelKeys(raw));
  return r.items;
}
