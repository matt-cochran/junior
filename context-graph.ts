// ---------------------------------------------------------------------------
// Context graph read side (Crossmatrix 0.3+).
//
// `graphSlice` performs a deterministic breadth-first walk over the crossmatrix
// store: starting from `<dimension>:<member>` seeds it follows the `trace`
// query's incident relations/observations (both directions), preferring
// higher-confidence and non-stale links, until `depth` or `maxNodes` bounds the
// slice. `contractContext` turns a slice into a Junior contract `context` array
// plus an evidence summary. `impactChecks` reverse-walks changed files to the
// tests and jevitate journeys they affect and emits focused commands.
//
// Every query goes through the wrapper's `crossmatrix.query`, exactly as
// codemap.ts's read side does. Identical inputs produce byte-identical output.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { CROSSMATRIX_WRITE_SCHEMA_VERSION, serverErrorDetail } from './matrix-sync.ts';
import { callHop, loadHop } from './tools/tools.ts';

const MIN_SOURCE_VERSION = [0, 3, 0] as const;

export type Confidence = 'high' | 'medium' | 'low';

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

/** Numeric option bounds shared by the CLI and the library. */
const DEFAULT_DEPTH = 3;
const DEFAULT_MAX_NODES = 60;
const MAX_CONTEXT_ENTRIES = 20;

export interface GraphDeps {
  callHop?: typeof callHop;
  loadHop?: typeof loadHop;
  /** Whether a `jevitate` CLI exists; overridable so impact tests stay offline. */
  hasJevitate?: () => boolean;
}

export type GraphNodeKind =
  | 'deliverable'
  | 'job'
  | 'journey'
  | 'outcome'
  | 'feature'
  | 'file'
  | 'test'
  | 'failure-mode'
  | 'claim'
  | 'hypothesis'
  | 'adr'
  | 'member';

export interface GraphNode {
  /** Fully-prefixed crossmatrix member id. */
  member: string;
  kind: GraphNodeKind;
  /** Unprefixed path for `loc:` members. */
  path?: string;
  depth: number;
  confidence: Confidence | null;
  stale: boolean;
  /** The observation token on the link that discovered the node. */
  observation: string | null;
  /** A `standing` token on the link, when the server supplies one. */
  standing: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
  observation: string | null;
  confidence: Confidence | null;
  stale: boolean;
}

export interface GraphCut {
  maxNodes: number;
  dropped: number;
}

export interface GraphSlice {
  modelId: string;
  seeds: string[];
  depth: number;
  maxNodes: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  cut: GraphCut | null;
}

export interface GraphSliceOptions {
  hopPath: string;
  modelId: string;
  /** `<dimensionId>:<memberId>` seeds. */
  seeds: readonly string[];
  depth?: number;
  maxNodes?: number;
  deps?: GraphDeps;
}

export interface ContractContextEntry {
  path: string;
  start?: number;
  end?: number;
}

export interface ContractClaim {
  member: string;
  standing: string | null;
}

export interface ContractEvidenceSummary {
  outcomes: string[];
  risks: string[];
  claims: ContractClaim[];
  notes: string[];
}

export interface ContractContext {
  context: ContractContextEntry[];
  evidence: ContractEvidenceSummary;
}

export interface ImpactCheck {
  kind: 'test' | 'jevitate';
  /** The changed file whose reverse walk produced the check. */
  source: string;
  /** Linked test file or journey suite. */
  file: string;
  command: string;
  args: string[];
}

export interface ImpactResult {
  modelId: string;
  changedFiles: string[];
  checks: ImpactCheck[];
}

export interface ImpactChecksOptions {
  hopPath: string;
  modelId: string;
  changedFiles: readonly string[];
  /** Project dir used to resolve a journey suite path. */
  project?: string;
  depth?: number;
  deps?: GraphDeps;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- Crossmatrix query plumbing (mirrors codemap.ts) ------------------------

interface CrossmatrixQuery {
  kind: string;
  [key: string]: unknown;
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

/** Refuse to read the store from a server below Crossmatrix 0.3.0. */
function assertReadCapable(load: typeof loadHop, hopPath: string): void {
  const hop = load(hopPath);
  const recorded = hop.tools?.crossmatrix?.sourceVersion;
  if (!versionAtLeast(recorded, MIN_SOURCE_VERSION)) {
    throw new Error(
      `context-graph requires Crossmatrix 0.3.0 or newer (hop records ${recorded ?? 'missing'})`,
    );
  }
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
    throw new Error(`context-graph ${q.kind} failed: ${detail}`);
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

/** All `trace` hops incident to one member, following `nextCursor`. */
async function traceHops(
  call: typeof callHop,
  hopPath: string,
  modelId: string,
  member: string,
): Promise<Array<Record<string, any>>> {
  const hops: Array<Record<string, any>> = [];
  let cursor: string | undefined;
  do {
    const q: CrossmatrixQuery = { kind: 'trace', member };
    if (cursor !== undefined) q.cursor = cursor;
    const page = await query(call, hopPath, modelId, q);
    if (isRecord(page) && Array.isArray(page.hops)) {
      for (const raw of page.hops) if (isRecord(raw)) hops.push(raw);
    }
    cursor = nextCursorOf(page);
  } while (cursor !== undefined);
  return hops;
}

// --- Member interpretation --------------------------------------------------

const MEMBER_PREFIX: Record<string, string> = {
  cpm: 'cpm',
  'jevitate-jobs': 'job',
  'jevitate-journeys': 'journey',
  fmeca: 'fm',
};

/** Normalize `<dimensionId>:<memberId>` to a fully-prefixed member id. */
function normalizeMember(seed: string): string {
  const separator = seed.indexOf(':');
  if (separator === -1) return seed;
  const dimensionId = seed.slice(0, separator);
  const memberId = seed.slice(separator + 1);
  const prefix = MEMBER_PREFIX[dimensionId];
  if (prefix && memberId && !memberId.startsWith(`${prefix}:`)) return `${prefix}:${memberId}`;
  return seed;
}

/** True when a path is a test artifact per matrix.ts's conventions. */
function isTestPath(p: string): boolean {
  const base = path.posix.basename(p);
  if (/\.(test|spec)\./.test(base)) return true;
  return p.split('/').slice(0, -1).some((seg) => seg === 'test' || seg === 'tests' || seg === '__tests__');
}

/** Classify a fully-prefixed member id. */
function classify(member: string): { kind: GraphNodeKind; path?: string } {
  if (member.startsWith('loc:')) {
    const p = member.slice('loc:'.length);
    return { kind: isTestPath(p) ? 'test' : 'file', path: p };
  }
  if (member.startsWith('outcome:') || /\/outcome:/.test(member)) return { kind: 'outcome' };
  if (member.startsWith('cpm:')) return { kind: 'deliverable' };
  if (member.startsWith('journey:')) return { kind: 'journey' };
  if (member.startsWith('job:')) return { kind: 'job' };
  if (member.startsWith('feature:')) return { kind: 'feature' };
  if (member.startsWith('fm:') || member.startsWith('failure-mode:')) return { kind: 'failure-mode' };
  if (member.startsWith('claim:')) return { kind: 'claim' };
  if (member.startsWith('hypothesis:')) return { kind: 'hypothesis' };
  if (member.startsWith('adr:')) return { kind: 'adr' };
  return { kind: 'member' };
}

/** The first observation token on a hop, if any. */
function observationOf(hop: Record<string, any>): string | null {
  const tokens = Array.isArray(hop.observations) ? hop.observations : [];
  for (const token of tokens) if (typeof token === 'string' && token) return token;
  return typeof hop.observation === 'string' && hop.observation ? hop.observation : null;
}

/** A hop's confidence token, if recognized. */
function confidenceOf(hop: Record<string, any>): Confidence | null {
  const value = hop.confidence;
  return value === 'high' || value === 'medium' || value === 'low' ? value : null;
}

/** True when a hop is marked stale (explicitly or via an observation token). */
function staleOf(hop: Record<string, any>): boolean {
  if (hop.stale === true) return true;
  const tokens = Array.isArray(hop.observations) ? hop.observations : [];
  return tokens.includes('stale') && hop.stale !== false;
}

interface Neighbor {
  member: string;
  relation: string;
  observation: string | null;
  confidence: Confidence | null;
  stale: boolean;
  standing: string | null;
  from: string;
  to: string;
}

/** Deterministic neighbor order: confidence desc, non-stale first, member asc. */
function compareNeighbors(a: Neighbor, b: Neighbor): number {
  const confidence = (b.confidence ? CONFIDENCE_RANK[b.confidence] : 0) - (a.confidence ? CONFIDENCE_RANK[a.confidence] : 0);
  if (confidence !== 0) return confidence;
  if (a.stale !== b.stale) return a.stale ? 1 : -1;
  return a.member.localeCompare(b.member) || a.relation.localeCompare(b.relation);
}

function nodeFor(member: string, neighbor: Neighbor | null, depth: number): GraphNode {
  const { kind, path: p } = classify(member);
  return {
    member,
    kind,
    ...(p !== undefined ? { path: p } : {}),
    depth,
    confidence: neighbor?.confidence ?? null,
    stale: neighbor?.stale ?? false,
    observation: neighbor?.observation ?? null,
    standing: neighbor?.standing ?? null,
  };
}

// --- graphSlice -------------------------------------------------------------

/**
 * Deterministic BFS over the crossmatrix relations/observations incident to
 * `seeds`, bounded by `depth` and `maxNodes`.
 */
export async function graphSlice(options: GraphSliceOptions): Promise<GraphSlice> {
  const call = options.deps?.callHop ?? callHop;
  const load = options.deps?.loadHop ?? loadHop;
  assertReadCapable(load, options.hopPath);

  const depth = options.depth ?? DEFAULT_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const seeds = [...new Set(options.seeds.map(normalizeMember))];

  const nodes = new Map<string, GraphNode>();
  const candidateEdges = new Map<string, GraphEdge>();
  let dropped = 0;

  const queue: Array<{ member: string; depth: number }> = [];
  for (const seed of seeds) {
    if (nodes.has(seed)) continue;
    if (nodes.size >= maxNodes) {
      dropped += 1;
      continue;
    }
    nodes.set(seed, nodeFor(seed, null, 0));
    queue.push({ member: seed, depth: 0 });
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= depth) continue;
    const hops = await traceHops(call, options.hopPath, options.modelId, current.member);
    const neighbors: Neighbor[] = [];
    for (const raw of hops) {
      if (typeof raw.member !== 'string' || !raw.member) continue;
      const direction = raw.direction === 'in' ? 'in' : 'out';
      const relation = typeof raw.relation === 'string' ? raw.relation : '';
      const from = direction === 'out' ? current.member : raw.member;
      const to = direction === 'out' ? raw.member : current.member;
      neighbors.push({
        member: raw.member,
        relation,
        observation: observationOf(raw),
        confidence: confidenceOf(raw),
        stale: staleOf(raw),
        standing: typeof raw.standing === 'string' ? raw.standing : null,
        from,
        to,
      });
    }
    neighbors.sort(compareNeighbors);

    for (const neighbor of neighbors) {
      const edgeKey = `${neighbor.from}|${neighbor.to}|${neighbor.relation}|${neighbor.observation ?? ''}`;
      if (!candidateEdges.has(edgeKey)) {
        candidateEdges.set(edgeKey, {
          from: neighbor.from,
          to: neighbor.to,
          relation: neighbor.relation,
          observation: neighbor.observation,
          confidence: neighbor.confidence,
          stale: neighbor.stale,
        });
      }
      if (nodes.has(neighbor.member)) continue;
      if (nodes.size >= maxNodes) {
        dropped += 1;
        continue;
      }
      nodes.set(neighbor.member, nodeFor(neighbor.member, neighbor, current.depth + 1));
      queue.push({ member: neighbor.member, depth: current.depth + 1 });
    }
  }

  const nodeList = [...nodes.values()].sort(
    (a, b) => a.depth - b.depth || a.member.localeCompare(b.member),
  );
  const included = new Set(nodeList.map((node) => node.member));
  const edgeList = [...candidateEdges.values()]
    .filter((edge) => included.has(edge.from) && included.has(edge.to))
    .sort(
      (a, b) =>
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to) ||
        a.relation.localeCompare(b.relation) ||
        (a.observation ?? '').localeCompare(b.observation ?? ''),
    );

  const truncated = dropped > 0;
  return {
    modelId: options.modelId,
    seeds,
    depth,
    maxNodes,
    nodes: nodeList,
    edges: edgeList,
    truncated,
    cut: truncated ? { maxNodes, dropped } : null,
  };
}

// --- contractContext --------------------------------------------------------

/** Split an optional `#L<start>[-L<end>]` suffix off a `loc:` path. */
function parseLocation(member: string): ContractContextEntry | null {
  if (!member.startsWith('loc:')) return null;
  const raw = member.slice('loc:'.length);
  const hash = raw.indexOf('#');
  if (hash === -1) return { path: raw };
  const location = raw.slice(hash + 1);
  const path = raw.slice(0, hash);
  const match = /^L(\d+)(?:-L?(\d+))?$/.exec(location);
  if (!match) return { path };
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  return { path, start, end };
}

/**
 * Turn a slice into a Junior contract `context` array (bounded, deduplicated by
 * path) plus an evidence summary of related outcomes, risks, claims and notes.
 */
export function contractContext(slice: GraphSlice): ContractContext {
  const context: ContractContextEntry[] = [];
  const paths = new Set<string>();
  const outcomes: string[] = [];
  const risks: string[] = [];
  const claims: ContractClaim[] = [];
  const notes: string[] = [];

  for (const node of slice.nodes) {
    if (node.kind === 'file' || node.kind === 'test') {
      const entry = parseLocation(node.member);
      if (!entry || entry.path.endsWith('/')) continue;
      if (paths.has(entry.path)) continue;
      if (context.length >= MAX_CONTEXT_ENTRIES) continue;
      paths.add(entry.path);
      context.push(entry);
    } else if (node.kind === 'outcome') {
      if (!outcomes.includes(node.member)) outcomes.push(node.member);
    } else if (node.kind === 'failure-mode') {
      if (!risks.includes(node.member)) risks.push(node.member);
    } else if (node.kind === 'claim') {
      if (!claims.some((claim) => claim.member === node.member)) {
        claims.push({ member: node.member, standing: node.standing });
      }
    } else if (node.kind === 'adr' || node.kind === 'hypothesis') {
      if (!notes.includes(node.member)) notes.push(node.member);
    }
  }

  return { context, evidence: { outcomes, risks, claims, notes } };
}

// --- impactChecks -----------------------------------------------------------

/** Whether a `jevitate` binary is on PATH. */
function defaultHasJevitate(): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, ['jevitate'], { stdio: 'ignore' });
  return result.status === 0;
}

function normalizePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isDeliveryPath(p: string): boolean {
  return p === '.delivery' || p.startsWith('.delivery/');
}

/** Focused command for a linked test file, or null when neither convention fits. */
function testCommand(file: string): { command: string; args: string[] } | null {
  if (/\.test\.(ts|tsx|js|mjs|cjs)$/.test(file)) return { command: 'node', args: ['--test', file] };
  const cargo = /^tests\/(.+)\.rs$/.exec(file);
  if (cargo) return { command: 'cargo', args: ['test', '--test', cargo[1]] };
  return null;
}

/** A journey member id's suite path, relative to the project when possible. */
function journeySuite(member: string, project: string): string {
  const id = member.replace(/^journey:/, '');
  const relative = `.jevitate/journeys/${id}.json`;
  return project ? normalizePath(path.join(project, relative)) : relative;
}

/**
 * Reverse-walk each changed file to the tests and jevitate journeys/outcomes it
 * affects and produce focused contract checks.
 */
export async function impactChecks(options: ImpactChecksOptions): Promise<ImpactResult> {
  const deps = options.deps ?? {};
  const changedFiles = [...new Set(options.changedFiles.map(normalizePath).filter((p) => p && !isDeliveryPath(p)))];
  const hasJevitate = deps.hasJevitate ?? defaultHasJevitate;
  const project = options.project ?? '';
  const checks: ImpactCheck[] = [];
  const seen = new Set<string>();

  for (const source of changedFiles) {
    const slice = await graphSlice({
      hopPath: options.hopPath,
      modelId: options.modelId,
      seeds: [`loc:${source}`],
      depth: options.depth ?? DEFAULT_DEPTH,
      deps,
    });
    for (const node of slice.nodes) {
      if (node.member === `loc:${source}`) continue;
      if (node.kind === 'test' && node.path) {
        const command = testCommand(node.path);
        if (!command) continue;
        const key = `test|${node.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        checks.push({ kind: 'test', source, file: node.path, command: command.command, args: command.args });
      } else if (node.kind === 'journey' && hasJevitate()) {
        const file = journeySuite(node.member, project);
        const command = { command: 'jevitate', args: ['check', '--suite', file] };
        const key = `jevitate|${file}`;
        if (seen.has(key)) continue;
        seen.add(key);
        checks.push({ kind: 'jevitate', source, file, command: command.command, args: command.args });
      }
    }
  }

  return { modelId: options.modelId, changedFiles, checks };
}

// --- CLI: `junior matrix graph` --------------------------------------------

interface GraphOptions {
  hop?: string;
  model?: string;
  seeds: string[];
  impact: boolean;
  result?: string;
  project?: string;
  depth?: number;
  maxNodes?: number;
  json: boolean;
}

/** Parse an optional non-negative integer flag. */
function parseCount(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Option ${name} requires a non-negative integer, got: ${value}`);
  }
  return parsed;
}

function parseGraphArgs(argv: string[]): GraphOptions {
  const seeds: string[] = [];
  const values: Record<string, string> = {};
  let impact = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (name === '--impact') {
      impact = true;
      continue;
    }
    if (name === '--json') {
      json = true;
      continue;
    }
    if (!['--hop', '--model', '--seed', '--result', '--project', '--dir', '--depth', '--max-nodes', '--max'].includes(name)) {
      throw new Error(`Unknown option for matrix graph: ${arg}`);
    }
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined) value = argv[++i];
    if (value === undefined || value === '') throw new Error(`Option ${name} requires a value`);
    if (name === '--seed') seeds.push(value);
    else if (name === '--dir') values['--project'] = value;
    else values[name] = value;
  }
  return {
    hop: values['--hop'],
    model: values['--model'],
    seeds,
    impact,
    result: values['--result'],
    project: values['--project'],
    depth: parseCount('--depth', values['--depth']),
    maxNodes: parseCount('--max-nodes', values['--max-nodes'] ?? values['--max']),
    json,
  };
}

/** Changed file paths from a handoff `result.json`, excluding `.delivery/`. */
function changedFilesFromResult(resultPath: string): string[] {
  const doc: unknown = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const evidence = isRecord(doc) && isRecord(doc.evidence) ? doc.evidence : {};
  const raw = evidence.runChangedFiles ?? evidence.changedFiles ?? [];
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((entry) => (typeof entry === 'string' ? entry : isRecord(entry) ? entry.path : undefined))
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map(normalizePath)
    .filter((p) => !isDeliveryPath(p));
}

/** Thin CLI shell for `junior matrix graph`; returns the process exit code. */
export async function runGraph(argv: string[]): Promise<number> {
  try {
    const options = parseGraphArgs(argv);
    if (!options.hop) throw new Error('matrix graph requires --hop <hop.json>');
    if (!options.model) throw new Error('matrix graph requires --model <modelId>');

    if (options.impact) {
      if (!options.result) throw new Error('matrix graph --impact requires --result <result.json>');
      const result = await impactChecks({
        hopPath: options.hop,
        modelId: options.model,
        changedFiles: changedFilesFromResult(options.result),
        project: options.project,
        depth: options.depth,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }

    if (options.seeds.length === 0) {
      throw new Error('matrix graph requires --seed <dimensionId>:<memberId>');
    }
    const slice = await graphSlice({
      hopPath: options.hop,
      modelId: options.model,
      seeds: options.seeds,
      depth: options.depth,
      maxNodes: options.maxNodes,
    });
    const context = contractContext(slice);
    if (!options.json) {
      process.stdout.write(`${slice.nodes.length} nodes, ${context.context.length} context paths\n`);
    }
    process.stdout.write(`${JSON.stringify({ slice, context: context.context }, null, 2)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
