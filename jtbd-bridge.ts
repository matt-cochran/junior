// ---------------------------------------------------------------------------
// Jobs-to-be-Done bridge: jevitate catalog <-> elicitation tool <-> crossmatrix.
//
// The catalog (`.jevitate/jobs.json`) carries formal job stories, steps and
// desired outcomes (see jevitate's docs/catalog.md). This module turns that
// formal structure into elicitation coverage schemas and claim/evidence append
// payloads, turns an exported elicitation spec back into (unapproved) jevitate
// job drafts, and wires the three `junior matrix jtbd` subcommands.
//
// `seedElicitation`, `journeyEvidence` and `draftJobsFromSpec` are PURE: they
// take already-parsed data and return plain payloads. `runJtbd` is the thin
// side-effecting shell: it reads catalog/spec files and, for `seed`/`evidence`,
// sends the payloads through the existing HOP `elicitation` tool.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { callHop } from './tools/tools.ts';

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function records(value: unknown): Array<Record<string, any>> {
  return asArray(value).filter(isRecord);
}

// ---------------------------------------------------------------------------
// Elicitation wire shapes (mirrors praxec/elicitation's typed model)
// ---------------------------------------------------------------------------

export interface CoverageDimension {
  tag: string;
  required: boolean;
}

export interface ElicitationEntityRef {
  id: string;
  label?: string;
}

export type ElicitationObject =
  | { kind: 'entity'; id: string; label?: string }
  | { kind: 'value'; value: string };

export interface ElicitationClaim {
  id: string;
  session_id: string;
  subject: ElicitationEntityRef;
  predicate: string;
  object: ElicitationObject;
  polarity: 'positive' | 'negative';
  category: 'requirement' | 'constraint' | 'risk' | 'context' | 'decision';
  modality: 'fact' | 'goal' | 'constraint' | 'assumption' | 'decision' | 'risk' | 'preference';
  dimensions: string[];
  source: { turn_id: string };
}

export interface AddClaimPayload {
  variant: 'add_claim';
  session_id: string;
  claim: ElicitationClaim;
}

export interface AddEvidencePayload {
  variant: 'add_evidence';
  session_id: string;
  evidence: {
    id: string;
    session_id: string;
    claim_id: string;
    source_type: 'app_research_support' | 'app_research_refutation';
    detail?: string;
    source: { turn_id: string };
  };
}

export interface SeedElicitationResult {
  sessionOpen: { session_id: string; coverage_schema: { dimensions: CoverageDimension[] } };
  claims: AddClaimPayload[];
}

export interface DraftOutcome {
  id: string;
  object: string;
  direction?: string;
  measure?: string;
  target?: unknown;
  gulf?: string;
  priority?: string;
  provenance: 'elicitation';
}

export interface JobDraft {
  id: string;
  trigger: string;
  motivation: string;
  outcome: string;
  desiredOutcomes: DraftOutcome[];
  provenance: 'elicitation';
  revision: number;
}

/** The elicitation session id seeded for one job. */
export function jtbdSessionId(jobId: string): string {
  return `job:${jobId}`;
}

/** Canonical identity for one desired outcome's claim. */
export function jtbdOutcomeClaimId(jobId: string, outcomeId: string): string {
  return `job:${jobId}/outcome:${outcomeId}`;
}

function jobIdOf(job: Record<string, any>): string {
  return text(job.id ?? job.name);
}

// ---------------------------------------------------------------------------
// (1) seedElicitation
// ---------------------------------------------------------------------------

function targetValue(target: unknown): ElicitationObject {
  if (isRecord(target)) {
    const parts = [text(target.op), text(target.value), text(target.unit)].filter(Boolean);
    return { kind: 'value', value: parts.join(' ') };
  }
  return { kind: 'value', value: text(target) };
}

/**
 * Seed an elicitation session from a job story. The coverage schema carries one
 * dimension per distinct job step stage plus one per desired outcome; the claim
 * payloads carry the job story and one hypothesis per desired outcome.
 */
export function seedElicitation(job: unknown): SeedElicitationResult {
  const record = isRecord(job) ? job : {};
  const jobId = jobIdOf(record);
  const sessionId = jtbdSessionId(jobId);

  const stages: string[] = [];
  for (const step of records(record.steps)) {
    const stage = text(step.stage ?? step.id);
    if (stage && !stages.includes(stage)) stages.push(stage);
  }
  const outcomes = records(record.desiredOutcomes);
  const dimensions: CoverageDimension[] = [
    ...stages.map((tag) => ({ tag, required: true })),
    ...outcomes.map((outcome) => ({ tag: text(outcome.id), required: true })).filter((d) => d.tag),
  ];

  const story = `When ${text(record.trigger)}, I want to ${text(record.motivation)}, so I can ${text(record.outcome)}`;
  const claims: AddClaimPayload[] = [
    {
      variant: 'add_claim',
      session_id: sessionId,
      claim: {
        id: `job:${jobId}/story`,
        session_id: sessionId,
        subject: { id: `job:${jobId}`, label: text(record.name ?? jobId) },
        predicate: 'job_story',
        object: { kind: 'value', value: story },
        polarity: 'positive',
        category: 'context',
        modality: 'goal',
        dimensions: [...stages],
        source: { turn_id: `job:${jobId}` },
      },
    },
  ];

  for (const outcome of outcomes) {
    const outcomeId = text(outcome.id);
    if (!outcomeId) continue;
    claims.push({
      variant: 'add_claim',
      session_id: sessionId,
      claim: {
        id: jtbdOutcomeClaimId(jobId, outcomeId),
        session_id: sessionId,
        subject: { id: `outcome:${jobId}/${outcomeId}`, label: text(outcome.object) || outcomeId },
        predicate: `${text(outcome.direction)}+${text(outcome.measure)}`,
        object: targetValue(outcome.target),
        polarity: 'positive',
        category: 'requirement',
        modality: 'goal',
        dimensions: [outcomeId],
        source: { turn_id: jtbdOutcomeClaimId(jobId, outcomeId) },
      },
    });
  }

  return { sessionOpen: { session_id: sessionId, coverage_schema: { dimensions } }, claims };
}

// ---------------------------------------------------------------------------
// (2) journeyEvidence
// ---------------------------------------------------------------------------

function isPassing(result: Record<string, any>): boolean | null {
  if (result.outcome !== undefined) return text(result.outcome) === 'ok';
  if (result.verdict !== undefined) return text(result.verdict) === 'passed';
  if (typeof result.passed === 'boolean') return result.passed;
  return null;
}

/**
 * Turn one jevitate journey result into elicitation evidence for the desired
 * outcomes the journey serves. A passing linked journey supports them; a
 * failing one refutes them. An unlinked or unverdictable result yields nothing.
 */
export function journeyEvidence(job: unknown, journeyResult: unknown): AddEvidencePayload[] {
  const record = isRecord(job) ? job : {};
  const result = isRecord(journeyResult) ? journeyResult : {};
  const jobId = jobIdOf(record);
  const metadata = isRecord(result.metadata) ? result.metadata : {};
  const linkedJob = text(metadata.job ?? result.job ?? result.jobId);
  if (!jobId || linkedJob !== jobId) return [];

  const passing = isPassing(result);
  if (passing === null) return [];

  const outcomeIds = records(record.desiredOutcomes).map((outcome) => text(outcome.id)).filter(Boolean);
  const served = asArray(metadata.serves ?? result.serves ?? result.outcomes).map(text).filter(Boolean);
  const covered = served.length > 0 ? served : outcomeIds;

  const sessionId = jtbdSessionId(jobId);
  const sourceType = passing ? 'app_research_support' : 'app_research_refutation';
  const journeyId = text(metadata.id ?? result.journeyId ?? result.id ?? jobId);
  return covered.map((outcomeId) => ({
    variant: 'add_evidence' as const,
    session_id: sessionId,
    evidence: {
      id: `evidence:${jtbdOutcomeClaimId(jobId, outcomeId)}:${sourceType}`,
      session_id: sessionId,
      claim_id: jtbdOutcomeClaimId(jobId, outcomeId),
      source_type: sourceType,
      detail: `journey ${journeyId} ${passing ? 'passed' : 'failed'}`,
      source: { turn_id: journeyId },
    },
  }));
}

// ---------------------------------------------------------------------------
// (3) draftJobsFromSpec
// ---------------------------------------------------------------------------

/** Only requirements whose hypothesis survived falsification are draftable. */
function survivedFalsification(requirement: Record<string, any>): boolean {
  const standing = text(requirement.standing);
  if (!standing) return true;
  return standing === 'withstood';
}

function capabilityPair(value: unknown): { direction: string; measure: string } {
  const parts = text(value).split('+');
  return { direction: text(parts[0]), measure: text(parts[1]) };
}

function existingJobsOf(existingJobs: unknown): Array<Record<string, any>> {
  if (Array.isArray(existingJobs)) return existingJobs.filter(isRecord);
  if (isRecord(existingJobs)) return records(existingJobs.jobs);
  return [];
}

function draftOutcomeFor(requirement: Record<string, any>): DraftOutcome | null {
  const id = text(requirement.id);
  if (!id || !survivedFalsification(requirement)) return null;
  const pair = capabilityPair(requirement.direction !== undefined && requirement.measure !== undefined
    ? `${text(requirement.direction)}+${text(requirement.measure)}`
    : requirement.capability);
  const outcome: DraftOutcome = {
    id,
    object: text(requirement.statement ?? requirement.capability ?? id),
    provenance: 'elicitation',
  };
  if (pair.direction) outcome.direction = pair.direction;
  if (pair.measure) outcome.measure = pair.measure;
  if (requirement.target !== undefined) outcome.target = requirement.target;
  if (requirement.gulf !== undefined) outcome.gulf = text(requirement.gulf);
  return outcome;
}

/**
 * Turn an exported elicitation spec into jevitate job drafts. Requirements that
 * survived falsification become desired outcomes; an existing job keeps its
 * story and gains a bumped revision. Drafts are never approved.
 */
export function draftJobsFromSpec(specExport: unknown, existingJobs: unknown): JobDraft[] {
  const spec = isRecord(specExport) ? specExport : {};
  const sessionId = text(spec.session_id ?? spec.sessionId ?? 'elicitation');
  const jobId = text(spec.jobId ?? spec.job_id ?? sessionId.replace(/^job:/, '')) || 'elicitation';
  const existing = existingJobsOf(existingJobs).find((job) => jobIdOf(job) === jobId);

  const outcomes = new Map<string, DraftOutcome>();
  for (const outcome of records(existing?.desiredOutcomes)) {
    const id = text(outcome.id);
    if (id) outcomes.set(id, { ...outcome, provenance: 'elicitation' } as DraftOutcome);
  }
  for (const requirement of records(spec.requirements)) {
    const outcome = draftOutcomeFor(requirement);
    if (outcome) outcomes.set(outcome.id, outcome);
  }

  const draft: JobDraft = {
    id: jobId,
    trigger: text(existing?.trigger) || `elicitation produced an aligned spec (${sessionId})`,
    motivation: text(existing?.motivation) || 'turn the requirements that survived falsification into a job',
    outcome: text(existing?.outcome) || 'build the validated behaviour',
    desiredOutcomes: [...outcomes.values()],
    provenance: 'elicitation',
    revision: existing ? (Number(existing.revision) || 0) + 1 : 1,
  };
  return [draft];
}

// ---------------------------------------------------------------------------
// CLI: `junior matrix jtbd <seed|evidence|draft>`
// ---------------------------------------------------------------------------

interface JtbdOptions {
  subcommand: string;
  hop?: string;
  dir: string;
  out?: string;
  job?: string;
  jobId?: string;
  result?: string;
  spec?: string;
  session?: string;
}

const JTBD_VALUE_FLAGS = ['--hop', '--dir', '--out', '--job', '--job-id', '--result', '--spec', '--session'];

export function parseJtbdArgs(argv: string[]): JtbdOptions {
  const subcommand = argv[0] ?? '';
  const values: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!JTBD_VALUE_FLAGS.includes(name)) throw new Error(`Unknown option for matrix jtbd: ${arg}`);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined) value = argv[++i];
    if (value === undefined || value === '') throw new Error(`Option ${name} requires a value`);
    values[name] = value;
  }
  return {
    subcommand,
    hop: values['--hop'],
    dir: values['--dir'] ?? process.cwd(),
    out: values['--out'],
    job: values['--job'],
    jobId: values['--job-id'],
    result: values['--result'],
    spec: values['--spec'],
    session: values['--session'],
  };
}

function catalogPath(options: JtbdOptions): string {
  return options.job ?? path.join(options.dir, '.jevitate', 'jobs.json');
}

function readCatalogFiles(options: JtbdOptions): Array<Record<string, any>> {
  const file = catalogPath(options);
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return existingJobsOf(parsed);
}

function selectJob(jobs: Array<Record<string, any>>, jobId?: string): Record<string, any> {
  if (jobId) {
    const job = jobs.find((entry) => jobIdOf(entry) === jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    return job;
  }
  if (jobs.length === 0) throw new Error('job catalog is empty');
  return jobs[0];
}

async function elicit(
  options: JtbdOptions,
  tool: 'session.open' | 'append',
  args: unknown,
): Promise<void> {
  if (!options.hop) throw new Error(`matrix jtbd ${options.subcommand} requires --hop <hop.json>`);
  const outcome = await callHop(options.hop, 'elicitation', { tool, arguments: args });
  if (!outcome.ok) {
    const detail = outcome.error?.message ?? outcome.note ?? 'unknown error';
    throw new Error(`elicitation ${tool} failed: ${detail}`);
  }
}

async function runSeed(options: JtbdOptions): Promise<number> {
  const job = selectJob(readCatalogFiles(options), options.jobId);
  const seed = seedElicitation(job);
  const sessionId = options.session ?? seed.sessionOpen.session_id;
  const sessionOpen = { ...seed.sessionOpen, session_id: sessionId };
  await elicit(options, 'session.open', sessionOpen);
  for (const payload of seed.claims) await elicit(options, 'append', { ...payload, session_id: sessionId });
  process.stdout.write(
    `${JSON.stringify({ session_id: sessionId, coverage_dimensions: sessionOpen.coverage_schema.dimensions.length, appended: seed.claims.length }, null, 2)}\n`,
  );
  return 0;
}

async function runEvidence(options: JtbdOptions): Promise<number> {
  if (!options.result) throw new Error('matrix jtbd evidence requires --result <result.json>');
  const job = selectJob(readCatalogFiles(options), options.jobId);
  const journeyResult = JSON.parse(fs.readFileSync(options.result, 'utf8'));
  const evidence = journeyEvidence(job, journeyResult);
  const sessionId = options.session ?? jtbdSessionId(jobIdOf(job));
  for (const payload of evidence) await elicit(options, 'append', { ...payload, session_id: sessionId });
  process.stdout.write(`${JSON.stringify({ session_id: sessionId, appended: evidence.length }, null, 2)}\n`);
  return 0;
}

function runDraft(options: JtbdOptions): number {
  if (!options.spec) throw new Error('matrix jtbd draft requires --spec <spec.json>');
  const specExport = JSON.parse(fs.readFileSync(options.spec, 'utf8'));
  const drafts = draftJobsFromSpec(specExport, readCatalogFiles(options));
  const out = options.out ?? path.join(options.dir, '.jevitate', 'jobs.draft.json');
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(drafts, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ out, drafts: drafts.length }, null, 2)}\n`);
  return 0;
}

/** Thin CLI shell for `junior matrix jtbd`; returns the process exit code. */
export async function runJtbd(argv: string[]): Promise<number> {
  try {
    const options = parseJtbdArgs(argv);
    if (options.subcommand === 'seed') return await runSeed(options);
    if (options.subcommand === 'evidence') return await runEvidence(options);
    if (options.subcommand === 'draft') return runDraft(options);
    throw new Error('Usage: junior matrix jtbd <seed|evidence|draft> [--hop <hop.json>] [--dir <project>]');
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
