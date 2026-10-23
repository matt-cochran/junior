// ---------------------------------------------------------------------------
// Crossmatrix autopilot: offline, deterministic feature-to-code proposals.
//
// `bootstrap` reads the project's already-known artifacts (a cpm plan graph,
// jevitate journeys/jobs, test files) and proposes `implements`/`tests` links
// from feature members to `loc:<path>` code locations. It is pure proposal
// logic: no LLM calls, no MCP writes. The proposals file is the review surface.
//
// `confirmProposals` records the reviewed subset through `codemapObserve`, so
// the same proposals replay byte-for-byte identical, content-addressed request
// ids and confirming twice is a no-op.
//
// `autolink` closes the loop for the handoff path: for each complete cpm
// deliverable whose evidence names an existing Junior `result.json`, it calls
// `codemapLink`, which is itself idempotent.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { codemapLink, codemapObserve, type CodemapDeps, type CodemapSent } from './codemap.ts';
import { planDeliverables, planStatusRows, strictItems } from './companion-shapes.ts';
import { jevitateJobs, jevitateJourneys, tests as testArtifacts, type MatrixFile } from './matrix.ts';
import { callHop, loadHop, type HopManifest } from './tools/tools.ts';

export type Confidence = 'high' | 'medium' | 'low';
export type ProposalObservation = 'implements' | 'tests';

/** Rank order used by `confirm --min`: high > medium > low. */
export const CONFIDENCE_RANK: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };

export interface ProposalEvidence {
  /** Machine-readable reason (e.g. `cpm-owned-file`, `journey-route`). */
  kind: string;
  /** Human-readable summary. */
  detail: string;
  /** Source locator (plan reference, journey file, ...). */
  source: string;
}

export interface Proposal {
  /** Stable identity; used by `confirm --only`/`--exclude`. */
  id: string;
  /** `<dimensionId>:<memberId>`, fully prefixed (e.g. `cpm:d1`). */
  feature: string;
  /** Code location path, without the `loc:` prefix. */
  path: string;
  observation: ProposalObservation;
  confidence: Confidence;
  evidence: ProposalEvidence;
}

export interface ProposalsDocument {
  schemaVersion: string;
  modelId: string;
  project: string;
  proposals: Proposal[];
}

export interface AutopilotDeps extends CodemapDeps {
  /** Tracked code files; defaults to `git ls-files` under the project dir. */
  files?: MatrixFile[];
  /** cpm plan graph; when set, the hop snapshot is not read. */
  planGraph?: unknown;
}

export interface BootstrapOptions {
  hopPath: string;
  modelId: string;
  dir: string;
  out?: string;
  deps?: AutopilotDeps;
}

export interface ConfirmOptions {
  hopPath: string;
  modelId: string;
  proposalsPath: string;
  min?: Confidence;
  only?: readonly string[];
  exclude?: readonly string[];
  deps?: AutopilotDeps;
}

export interface AutolinkOptions {
  hopPath: string;
  modelId: string;
  planId: string;
  /** Project dir used to resolve relative evidence result paths; defaults to cwd. */
  dir?: string;
  deps?: AutopilotDeps;
}

export interface BootstrapResult extends ProposalsDocument {
  out: string;
  counts: Record<Confidence, number>;
}

export interface ConfirmResult {
  modelId: string;
  requestIds: string[];
  sent: CodemapSent[];
}

export interface AutolinkResult {
  modelId: string;
  requestIds: string[];
  sent: CodemapSent[];
  skipped: Array<{ deliverable: string; reason: string }>;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '');
}

function fileText(entry: MatrixFile | undefined): string {
  if (!entry) return '';
  const raw = entry.content ?? entry.bytes ?? entry.data ?? '';
  return typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Tracked files under `dir` with their bytes, as matrix.ts's adapters expect. */
function trackedFiles(dir: string): MatrixFile[] {
  const listing = spawnSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' });
  if (listing.status !== 0) {
    throw new Error(`git ls-files failed in ${dir}: ${listing.stderr?.trim() ?? 'unknown error'}`);
  }
  const files: MatrixFile[] = [];
  for (const line of listing.stdout.split('\n')) {
    const p = line.trim();
    if (!p) continue;
    files.push({ path: p, content: fs.readFileSync(path.join(dir, p)) });
  }
  return files;
}

/** The most recent cpm `plan.get` snapshot recorded in the hop, if any. */
function planGraphFromHop(hopPath: string, load: typeof loadHop): unknown {
  const hop: HopManifest = load(hopPath);
  const snapshots = Array.isArray(hop.snapshots) ? hop.snapshots : [];
  const snapshot = [...snapshots].reverse().find((s) => s.tool === 'cpm' && s.toolName === 'plan.get');
  if (!snapshot) return null;
  const abs = path.resolve(path.dirname(hopPath), snapshot.path);
  if (!fs.existsSync(abs)) return null;
  return parseJson(fs.readFileSync(abs, 'utf8'));
}

function deliverableId(deliverable: any): string {
  return String(deliverable?.id ?? deliverable?.deliverableId ?? deliverable?.slug ?? '');
}

function deliverableLabel(deliverable: any): string {
  return String(deliverable?.title ?? deliverable?.name ?? deliverable?.label ?? deliverable?.description ?? '');
}

function ownedFiles(deliverable: any): string[] {
  const raw = deliverable?.owned_files ?? deliverable?.ownedFiles ?? [];
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((entry) => (typeof entry === 'string' ? entry : isRecord(entry) ? entry.path : undefined))
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map(normalizePath);
}

/**
 * Owned paths as code-dimension members: a tracked file stays, an owned
 * directory expands to the tracked files under it, and a path that is not
 * tracked yet is dropped, since confirming a link to it would fail.
 */
function trackedOwnedFiles(owned: string[], byPath: Map<string, unknown>): string[] {
  const out: string[] = [];
  for (const entry of owned) {
    if (byPath.has(entry)) {
      out.push(entry);
      continue;
    }
    const prefix = entry.endsWith('/') ? entry : `${entry}/`;
    for (const path of byPath.keys()) if (path.startsWith(prefix)) out.push(path);
  }
  return out;
}

function jobsFrom(json: unknown): any[] {
  if (Array.isArray(json)) return json;
  if (isRecord(json) && Array.isArray(json.jobs)) return json.jobs;
  return [];
}

function jobId(job: any): string {
  return String(job?.id ?? job?.name ?? '');
}

function jobLabel(job: any): string {
  return String(job?.name ?? job?.title ?? jobId(job));
}

/** Status of a deliverable as `plan.get` or a merged `plan.status` reports it. */
function deliverableStatus(deliverable: any): string {
  const marks = [deliverable?.status, deliverable?.mark_status, deliverable?.markStatus];
  for (const mark of marks) {
    if (typeof mark === 'string') return mark.toLowerCase();
    if (isRecord(mark) && typeof mark.status === 'string') return mark.status.toLowerCase();
  }
  return '';
}

function isComplete(deliverable: any): boolean {
  const status = deliverableStatus(deliverable);
  return status === 'complete' || status === 'completed';
}

/** Every evidence string recorded for a deliverable (tolerating the cpm shapes). */
function deliverableEvidence(deliverable: any): string[] {
  const raw = [deliverable?.evidence, deliverable?.mark_status?.evidence, deliverable?.markStatus?.evidence];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string') out.push(entry);
        else if (isRecord(entry) && typeof entry.path === 'string') out.push(entry.path);
      }
    }
  }
  return out;
}

/** Resolve the first evidence token naming an existing `result.json` under `dir`. */
function existingResultPath(evidence: readonly string[], dir: string): string | null {
  for (const text of evidence) {
    const match = /(\S*result\.json)/.exec(text);
    if (!match) continue;
    const candidate = match[1].replace(/[.,;:)\]]+$/, '');
    const abs = path.isAbsolute(candidate) ? candidate : path.resolve(dir, candidate);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

/** Resolve an evidence run id `<id>/<stamp>` to `<dir>/.delivery/<id>/<stamp>/result.json`. */
function runResultPath(evidence: readonly string[], dir: string): string | null {
  const pattern = /(?:^|[^A-Za-z0-9._-])([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;
  for (const text of evidence) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const id = match[1].replace(/[.,;:)\]]+$/, '');
      const stamp = match[2].replace(/[.,;:)\]]+$/, '');
      const abs = path.resolve(dir, '.delivery', id, stamp, 'result.json');
      if (fs.existsSync(abs)) return abs;
    }
  }
  return null;
}

/** The lexically greatest delivery stamp holding a result for this deliverable. */
function latestRunResultPath(id: string, dir: string): string | null {
  const base = path.resolve(dir, '.delivery', id);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return null;
  }
  const stamps = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (let index = stamps.length - 1; index >= 0; index -= 1) {
    const candidate = path.join(base, stamps[index], 'result.json');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Candidate strings a journey exposes for matching against source files. */
function journeyCandidates(journey: unknown): string[] {
  const out = new Set<string>();
  const addSegments = (value: string): void => {
    for (const segment of value.split('/')) {
      if (segment.length >= 3 && /^[A-Za-z0-9_.-]+$/.test(segment)) out.add(segment);
    }
  };
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      out.add(value);
      addSegments(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (isRecord(value)) for (const entry of Object.values(value)) visit(entry);
  };
  visit(journey);
  return [...out].filter((value) => value.length >= 3);
}

function containsString(value: unknown, needle: string): boolean {
  if (needle.length < 2) return false;
  return JSON.stringify(value ?? '').includes(needle);
}

function testNames(text: string): string[] {
  const names: string[] = [];
  const pattern = /(?:test|it|describe)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) names.push(match[1]);
  return names;
}

interface FeatureRef {
  feature: string;
  names: string[];
}

function addProposal(
  proposals: Proposal[],
  seen: Set<string>,
  proposal: Omit<Proposal, 'id'>,
): void {
  const id = `${proposal.feature}::${proposal.path}::${proposal.observation}`;
  if (seen.has(id)) return;
  seen.add(id);
  proposals.push({ id, ...proposal });
}

/**
 * Build the deterministic proposal set from the project's known artifacts.
 * Writes the proposals document to `--out` (default `<dir>/proposals.json`).
 */
export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const dir = options.dir;
  const deps = options.deps ?? {};
  const files = deps.files ?? trackedFiles(dir);
  const byPath = new Map(files.map((entry) => [normalizePath(entry.path), fileText(entry)]));
  const testPaths = new Set(
    testArtifacts(files).members
      .filter((member) => member.attributes?.type === 'file')
      .map((member) => String(member.attributes?.path)),
  );
  const planGraph = deps.planGraph ?? planGraphFromHop(options.hopPath, deps.loadHop ?? loadHop);
  const proposals: Proposal[] = [];
  const seen = new Set<string>();
  const featureRefs: FeatureRef[] = [];

  // 1. cpm deliverables -> their owned files (high).
  for (const deliverable of strictItems(planDeliverables(planGraph), 'cpm', 'plan.get', planGraph)) {
    const id = deliverableId(deliverable);
    if (!id) continue;
    const feature = `cpm:${id}`;
    featureRefs.push({ feature, names: [id, deliverableLabel(deliverable)] });
    for (const file of trackedOwnedFiles(ownedFiles(deliverable), byPath)) {
      addProposal(proposals, seen, {
        feature,
        path: file,
        observation: 'implements',
        confidence: 'high',
        evidence: { kind: 'cpm-owned-file', detail: `cpm deliverable ${id} owns ${file}`, source: `cpm:${id}` },
      });
    }
  }

  // 2. jevitate journeys -> source files containing a route/selector (medium).
  const journeyDimension = jevitateJourneys(files);
  const journeyLinks = new Map<string, Set<string>>();
  for (const file of files) {
    const p = normalizePath(file.path);
    if (!p.startsWith('.jevitate/journeys/') || !p.endsWith('.json')) continue;
    if (p.split('/').slice(2).some((segment) => segment.startsWith('.'))) continue;
    const journey = parseJson(byPath.get(p) ?? '');
    const member = journeyDimension.members.find((m) => m.sourceRef?.locator === p);
    if (!member) continue;
    const id = member.id.replace(/^journey:/, '');
    const feature = `jevitate-journeys:${member.id}`;
    featureRefs.push({ feature, names: [id, member.label ?? ''] });
    const candidates = journeyCandidates(journey);
    const linked = new Set<string>();
    for (const [candidatePath, text] of byPath) {
      if (candidatePath === p || testPaths.has(candidatePath)) continue;
      if (!candidates.some((candidate) => text.includes(candidate))) continue;
      linked.add(candidatePath);
      addProposal(proposals, seen, {
        feature,
        path: candidatePath,
        observation: 'implements',
        confidence: 'medium',
        evidence: { kind: 'journey-route', detail: `journey ${id} route/selector appears in ${candidatePath}`, source: p },
      });
    }
    journeyLinks.set(id, linked);
  }

  // 3. jevitate jobs -> files of the journeys that reference the job (low).
  const jobsFile = files.find((entry) => normalizePath(entry.path) === '.jevitate/jobs.json');
  const jobs = jobsFrom(jobsFile ? parseJson(fileText(jobsFile)) : []).filter((job) => jobId(job));
  const jobDimension = jevitateJobs(jobs);
  for (const job of jobs) {
    const id = jobId(job);
    const member = jobDimension.members.find((m) => m.id === `job:${id}`);
    const feature = `jevitate-jobs:${member?.id ?? `job:${id}`}`;
    featureRefs.push({ feature, names: [id, jobLabel(job)] });
    for (const [journeyId, linked] of journeyLinks) {
      const journey = files.find((entry) => normalizePath(entry.path).includes(`/journeys/`) && normalizePath(entry.path).endsWith(`${journeyId}.json`));
      if (!journey || !containsString(parseJson(fileText(journey)), id)) continue;
      for (const candidatePath of linked) {
        addProposal(proposals, seen, {
          feature,
          path: candidatePath,
          observation: 'implements',
          confidence: 'low',
          evidence: { kind: 'job-journey', detail: `job ${id} is referenced by journey ${journeyId}`, source: normalizePath(journey.path) },
        });
      }
    }
  }

  // 4. test files -> features named in the test names (medium, `tests` links).
  for (const testPath of testPaths) {
    const names = testNames(byPath.get(testPath) ?? '');
    if (names.length === 0) continue;
    const lowered = names.map((name) => name.toLowerCase());
    for (const ref of featureRefs) {
      const hit = ref.names.some((candidate) => {
        const needle = candidate.trim().toLowerCase();
        return needle.length >= 2 && lowered.some((name) => name.includes(needle));
      });
      if (!hit) continue;
      addProposal(proposals, seen, {
        feature: ref.feature,
        path: testPath,
        observation: 'tests',
        confidence: 'medium',
        evidence: { kind: 'test-name', detail: `test names in ${testPath} name ${ref.feature}`, source: testPath },
      });
    }
  }

  proposals.sort(
    (a, b) => a.feature.localeCompare(b.feature) || a.path.localeCompare(b.path) || a.observation.localeCompare(b.observation),
  );
  const counts: Record<Confidence, number> = { high: 0, medium: 0, low: 0 };
  for (const proposal of proposals) counts[proposal.confidence] += 1;

  const document: ProposalsDocument = { schemaVersion: '0.1.0', modelId: options.modelId, project: dir, proposals };
  if (options.out) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(document, null, 2)}\n`);
  }
  return { ...document, out: options.out ?? '', counts };
}

/** Rank-filter and select proposals by `--min`, `--only` and `--exclude`. */
export function selectProposals(
  proposals: readonly Proposal[],
  options: { min?: Confidence; only?: readonly string[]; exclude?: readonly string[] } = {},
): Proposal[] {
  const min = options.min ? CONFIDENCE_RANK[options.min] : 0;
  const only = options.only && options.only.length > 0 ? new Set(options.only) : null;
  const exclude = new Set(options.exclude ?? []);
  return proposals.filter((proposal) => {
    if (CONFIDENCE_RANK[proposal.confidence] < min) return false;
    if (only && !only.has(proposal.id)) return false;
    if (exclude.has(proposal.id)) return false;
    return true;
  });
}

/** Record the selected proposals as content-addressed crossmatrix observations. */
export async function confirmProposals(options: ConfirmOptions): Promise<ConfirmResult> {
  const document = parseJson(fs.readFileSync(options.proposalsPath, 'utf8'));
  const proposals = isRecord(document) && Array.isArray(document.proposals) ? (document.proposals as Proposal[]) : [];
  const selected = selectProposals(proposals, options);
  const sent: CodemapSent[] = [];
  for (const proposal of selected) {
    sent.push(
      await codemapObserve({
        hopPath: options.hopPath,
        modelId: options.modelId,
        feature: proposal.feature,
        path: proposal.path,
        observation: proposal.observation,
        confidence: proposal.confidence,
        contentVersion: proposal.confidence,
        evidence: [
          {
            sourceRef: {
              system: 'junior',
              sourceType: 'autopilot-proposal',
              sourceRef: proposal.id,
              locator: proposal.evidence.source,
            },
            locator: proposal.evidence.source,
            excerpt: proposal.evidence.detail,
          },
        ],
        rationale: `autopilot ${proposal.evidence.kind}: ${proposal.evidence.detail}`,
        deps: options.deps,
      }),
    );
  }
  return { modelId: options.modelId, requestIds: sent.map((entry) => entry.requestId), sent };
}

/** Link each complete cpm deliverable whose evidence names an existing result. */
export async function autolink(options: AutolinkOptions): Promise<AutolinkResult> {
  const call = options.deps?.callHop ?? callHop;
  const dir = options.dir ?? process.cwd();
  const outcome = await call(options.hopPath, 'cpm', { tool: 'plan.get', arguments: { plan_id: options.planId } });
  if (!outcome.ok) {
    throw new Error(`cpm plan.get failed: ${outcome.error?.message ?? outcome.note ?? 'unknown error'}`);
  }
  const graph = outcome.result;
  const deliverables = strictItems(planDeliverables(graph), 'cpm', 'plan.get', graph);

  // `plan.get` does not carry progress; consult `plan.status` for any
  // deliverable whose status is not already embedded in the graph.
  let statuses: Map<string, string> | null = null;
  if (deliverables.some((deliverable) => !deliverableStatus(deliverable))) {
    const statusOutcome = await call(options.hopPath, 'cpm', { tool: 'plan.status', arguments: { plan_id: options.planId } });
    if (statusOutcome.ok) {
      statuses = new Map(
        strictItems(planStatusRows(statusOutcome.result), 'cpm', 'plan.status', statusOutcome.result).map((row) => [
          row.id,
          row.status,
        ]),
      );
    }
  }

  const sent: CodemapSent[] = [];
  const skipped: AutolinkResult['skipped'] = [];
  for (const deliverable of deliverables) {
    const id = deliverableId(deliverable);
    if (!id) continue;
    const status = deliverableStatus(deliverable) || statuses?.get(id) || '';
    if (status !== 'complete' && status !== 'completed') continue;
    const evidence = deliverableEvidence(deliverable);
    const resultPath =
      existingResultPath(evidence, dir) ?? runResultPath(evidence, dir) ?? latestRunResultPath(id, dir);
    if (!resultPath) {
      skipped.push({ deliverable: id, reason: 'no result.json' });
      continue;
    }
    const linked = await codemapLink({
      hopPath: options.hopPath,
      modelId: options.modelId,
      resultPath,
      feature: `cpm:${id}`,
      deps: options.deps,
    });
    sent.push(...linked.sent);
  }
  return { modelId: options.modelId, requestIds: sent.map((entry) => entry.requestId), sent, skipped };
}
