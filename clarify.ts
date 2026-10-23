// ---------------------------------------------------------------------------
// Clarification loop: turn an unclear contract into a ready spec.
//
// When the readiness gate calls for clarification (an unclear contract or an
// unresolved blocking assumption) or the routed playbooks include
// `vague-feature`, the deterministic thing to do is ask before implementing.
// This module:
//   * opens an elicitation session through the hop (`clarify:<contract id>`),
//     seeded from a named jevitate job (`jtbd-bridge.ts` `seedElicitation`) or
//     from the contract text (one claim per acceptance criterion and per stated
//     assumption);
//   * builds the ranked batch from `question.next`'s single signal plus the
//     `state.get` clarify/remediate signals (deduplicated, bounded) and writes
//     it to `clarify.json`/`clarify.md`, returning `needs_answers`;
//   * applies the manager's answers (`user_assent`/`user_refutation` evidence or
//     an amendment claim), re-assesses readiness, and either drafts a cpm plan
//     (a plan-sized routing) or a prepare brief (otherwise); an explicit
//     workflow instead receives a clarified contract with the answers recorded
//     as constraints;
//   * escalates to the manager with the open blockers after the bounded number
//     of unready rounds.
//
// App-research evidence is only ever recorded from a discover-workflow report
// that literally contains a `path:line` excerpt: nothing is invented.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { callHop } from './tools/tools.ts';
import {
  elicitationClaims,
  elicitationSignals,
  elicitationTopSignal,
  strictItems,
} from './companion-shapes.ts';
import { buildPlanFromSpec, type PlanDocument } from './spec-bridge.ts';
import { briefMdPath, briefPath, renderBrief, validateBrief, type Brief } from './prepare.ts';
import { seedElicitation } from './jtbd-bridge.ts';

export const CLARIFY_FILENAME = 'clarify.json';
export const CLARIFY_MD_FILENAME = 'clarify.md';
const CLARIFIED_CONTRACT_FILENAME = 'clarified-contract.json';
const CLARIFIED_ANSWERS_FILENAME = 'clarified-answers.json';
/** At most this many deduplicated questions are returned per batch. */
export const MAX_CLARIFY_QUESTIONS = 7;
/** At most this many unready rounds run before the loop escalates. */
export const MAX_CLARIFY_ROUNDS = 3;
/** Routings that warrant a cpm draft plan rather than an options brief. */
export const PLAN_SIZED_PLAYBOOKS = ['planned-change'] as const;

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

export function clarifyPath(dir: string): string {
  return join(dir, CLARIFY_FILENAME);
}

export function clarifyMdPath(dir: string): string {
  return join(dir, CLARIFY_MD_FILENAME);
}

/** The elicitation session id for one contract. */
export function clarifySessionId(contractId: string): string {
  return `clarify:${contractId}`;
}

export type ClarifyStance = 'assent' | 'refute' | 'amend';

export interface ClarifyAnswer {
  answer: string;
  stance: ClarifyStance;
}

export interface ClarifyQuestion {
  /** Stable `Q1`.. id used by the answers file and the artifacts. */
  id: string;
  question: string;
  /** The signal this question resolves. */
  why: string;
  /** The strongest existing evidence's answer, or null when none applies. */
  suggestedAnswer: string | null;
  claimIds: string[];
  /** The coverage dimension the signal concerns, when it names one. */
  dimension?: string;
}

export interface ClarifyBatch {
  outcome: 'needs_answers';
  sessionId: string;
  round: number;
  questions: ClarifyQuestion[];
  blockers: string[];
  playbooks: string[];
  artifactDir: string | null;
}

export type ClarifyContinuation =
  | ClarifyBatch
  | { outcome: 'plan_drafted'; sessionId: string; round: number; spec: unknown; plan: PlanDocument; planPath: string }
  | { outcome: 'brief'; sessionId: string; round: number; spec: unknown; brief: Brief; briefPath: string; briefMdPath: string }
  | { outcome: 'contract'; sessionId: string; round: number; spec: unknown; contract: any; contractPath: string }
  | { outcome: 'escalated'; sessionId: string; round: number; blockers: string[] };

export interface ClarifyDeps {
  /** Artifact directory for `clarify.json`/`clarify.md`. */
  dir?: string;
  /** The hop manifest the elicitation session is recorded through. */
  hopPath?: string;
  /** Injectable hop call seam for offline tests. */
  callHop?: typeof callHop;
  /** Optional discover-workflow report whose `path:line` excerpts support claims. */
  discoverReport?: string;
  /** The routed playbook ids that decide the plan/brief continuation. */
  playbooks?: string[];
  maxQuestions?: number;
  maxRounds?: number;
}

/** `questionBatch` also carries the next round and its blockers. */
export interface QuestionBatchDeps extends ClarifyDeps {
  round?: number;
  blockers?: string[];
}

// ---------------------------------------------------------------------------
// Applicability and sizing
// ---------------------------------------------------------------------------

/** True when the readiness signal or the routed playbooks call for clarification. */
export function clarificationApplies(
  attention: { decision?: string; trigger?: string } | null | undefined,
  plan: { playbooks?: Array<{ id?: string }> } | null | undefined,
): boolean {
  const trigger = attention?.trigger;
  if (attention?.decision === 'clarify' && (trigger === 'contract_clear' || trigger === 'blocking_assumptions')) {
    return true;
  }
  const ids = asArray(plan?.playbooks).map((playbook) => text(playbook?.id)).filter(Boolean);
  return ids.includes('vague-feature');
}

/** Inputs that decide whether the clarification gate runs for one task. */
export interface ClarityGateInput {
  attention: { decision?: string; trigger?: string } | null | undefined;
  workflow?: string;
  checkBack?: string;
  preparedFrom?: unknown;
  clarifiedFrom?: unknown;
  playbooks?: Array<{ id?: string }>;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * True when the clarification gate should run. `checkBack: 'off'` and a task
 * already prepared from a brief or previously clarified never re-enter. An
 * auto (or unspecified) workflow keeps the readiness and vague-feature rules;
 * an explicit workflow only clarifies for an unclear contract (the
 * contract_clear trigger), never for a blocking assumption or the
 * vague-feature routing alone.
 */
export function clarityGateApplies(input: ClarityGateInput): boolean {
  if (input.checkBack === 'off') return false;
  if (nonEmptyString(input.preparedFrom) || nonEmptyString(input.clarifiedFrom)) return false;
  if (input.workflow === undefined || input.workflow === 'auto') {
    return clarificationApplies(input.attention, { playbooks: input.playbooks });
  }
  // Only an unclear contract gates an explicit workflow. blocking_assumptions
  // is at or above 0.6 on 94% of runs that came back clean, so it does not
  // separate problem contracts (ADR 0009, session junior-pi-hub-value H16).
  return input.attention?.decision === 'clarify' && input.attention?.trigger === 'contract_clear';
}

/** True when a routing's work is large enough to warrant a cpm draft plan. */
export function isPlanSized(playbooks: string[] = []): boolean {
  return playbooks.some((id) => (PLAN_SIZED_PLAYBOOKS as readonly string[]).includes(id));
}

// ---------------------------------------------------------------------------
// Hop access
// ---------------------------------------------------------------------------

function hopCaller(deps: ClarifyDeps): { call: typeof callHop; hop: string } | null {
  if (!deps.callHop && !deps.hopPath) return null;
  return { call: deps.callHop ?? callHop, hop: deps.hopPath ?? 'hop.json' };
}

async function elicit(deps: ClarifyDeps, tool: string, args: unknown): Promise<any> {
  const caller = hopCaller(deps);
  if (!caller) throw new Error('clarification requires a hop path (task.hopFrom) or an injected callHop');
  const outcome = await caller.call(caller.hop, 'elicitation', { tool, arguments: args });
  if (!outcome.ok) {
    throw new Error(`elicitation ${tool} failed: ${outcome.error?.message ?? outcome.note ?? 'unknown error'}`);
  }
  return outcome.result;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

interface Seed {
  sessionOpen: { session_id: string; coverage_schema: { dimensions: Array<{ tag: string; required: boolean }> } };
  claims: any[];
}

function claimPayload(
  sessionId: string,
  claimId: string,
  predicate: string,
  value: string,
  category: string,
  modality: string,
  dimension: string,
  label: string,
): any {
  return {
    variant: 'add_claim',
    session_id: sessionId,
    claim: {
      id: claimId,
      session_id: sessionId,
      subject: { id: sessionId, label },
      predicate,
      object: { kind: 'value', value },
      polarity: 'positive',
      category,
      modality,
      dimensions: dimension ? [dimension] : [],
      source: { turn_id: claimId },
    },
  };
}

/** One claim per acceptance criterion and per stated assumption. */
export function seedFromContract(task: any, sessionId: string): Seed {
  const acceptance = asArray(task?.acceptance);
  const assumptions = asArray(task?.assumptions);
  const label = text(task?.deliverable) || text(task?.id) || 'clarification';
  const dimensions = [
    { tag: 'acceptance', required: true },
    ...(assumptions.length > 0 ? [{ tag: 'assumptions', required: false }] : []),
  ];
  const claims: any[] = [];
  acceptance.forEach((criterion, index) => {
    const value = isRecord(criterion) ? text(criterion.text ?? criterion.statement ?? criterion) : text(criterion);
    claims.push(claimPayload(
      sessionId,
      `clarify:${text(task?.id)}/acceptance:${index}`,
      `acceptance_${index + 1}`,
      value,
      'requirement',
      'goal',
      'acceptance',
      label,
    ));
  });
  assumptions.forEach((assumption, index) => {
    const value = isRecord(assumption) ? text(assumption.text ?? assumption.statement ?? assumption) : text(assumption);
    claims.push(claimPayload(
      sessionId,
      `clarify:${text(task?.id)}/assumption:${index}`,
      `assumption_${index + 1}`,
      value,
      'constraint',
      'assumption',
      'assumptions',
      label,
    ));
  });
  return { sessionOpen: { session_id: sessionId, coverage_schema: { dimensions } }, claims };
}

/** Turn the contract's named jevitate job into a session seed. */
export function seedFromJob(job: unknown, sessionId: string): Seed {
  const base = seedElicitation(job);
  return {
    sessionOpen: { ...base.sessionOpen, session_id: sessionId },
    claims: base.claims.map((payload) => ({
      ...payload,
      session_id: sessionId,
      claim: { ...payload.claim, session_id: sessionId },
    })),
  };
}

// ---------------------------------------------------------------------------
// App-research evidence (never invented)
// ---------------------------------------------------------------------------

const FILE_LINE = /[A-Za-z0-9_./-]+\.[A-Za-z0-9]+:\d+/g;

/**
 * The discover-workflow report to draw checkable excerpts from: a context path
 * under the checkout, else the most recent `analysis-report.md` written for the
 * contract. Returns null when no report exists (evidence is never invented).
 */
export function resolveDiscoverReport(task: any, cwd: string): string | null {
  const fromContext = asArray(task?.context)
    .map((entry) => (isRecord(entry) ? text(entry.path) : text(entry)))
    .find((path) => path.endsWith('analysis-report.md'));
  if (fromContext) {
    const abs = resolve(cwd, fromContext);
    if (existsSync(abs)) return abs;
  }
  const base = join(cwd, '.delivery', text(task?.id));
  if (!existsSync(base)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(base, entry.name, 'analysis-report.md');
    if (!existsSync(candidate)) continue;
    const mtime = statSync(candidate).mtimeMs;
    if (!best || mtime > best.mtime) best = { path: candidate, mtime };
  }
  return best?.path ?? null;
}

/**
 * Evidence for claims the run can check in code: only `path:line` excerpts that
 * literally appear in a discover-workflow report are recorded. A report without
 * an excerpt (or a claim list without a target) yields nothing.
 */
export function discoverEvidenceFromReport(report: unknown, claimIds: string[]): any[] {
  const excerpts = String(report ?? '').match(FILE_LINE) ?? [];
  const target = claimIds.find((id) => !!text(id));
  if (excerpts.length === 0 || !target) return [];
  const excerpt = excerpts[0];
  const id = `evidence:${target}:app_research_support`;
  return [{
    variant: 'add_evidence',
    session_id: null,
    evidence: {
      id,
      session_id: null,
      claim_id: target,
      source_type: 'app_research_support',
      detail: `excerpt ${excerpt}`,
      source: { turn_id: id },
    },
  }];
}

// ---------------------------------------------------------------------------
// Question batches
// ---------------------------------------------------------------------------

interface ElicitationClaimView {
  id: string;
  value: string;
  label: string;
}

function claimView(claim: Record<string, any>): ElicitationClaimView {
  const object = isRecord(claim.object) ? claim.object : null;
  const value = object ? text(object.value ?? object.id) : text(claim.object ?? claim.value ?? claim.statement);
  const subject = isRecord(claim.subject) ? claim.subject : null;
  const label = subject ? text(subject.label ?? subject.id) : text(claim.subject);
  return { id: text(claim.id), value, label };
}

/** The claims `state.get` returns, keyed by claim id (array or map shape). */
function stateClaims(state: unknown): Map<string, ElicitationClaimView> {
  const map = new Map<string, ElicitationClaimView>();
  for (const claim of strictItems(elicitationClaims(state), 'elicitation', 'state.get', state)) {
    if (!isRecord(claim)) continue;
    const id = text(claim.id);
    if (id) map.set(id, claimView(claim));
  }
  return map;
}

/** The clarify/remediate signals `state.get` returns, in server order. */
function stateSignals(state: unknown): Array<Record<string, any>> {
  return strictItems(elicitationSignals(state), 'elicitation', 'state.get', state)
    .filter(isRecord)
    .filter((signal) => {
      const kind = text(signal.kind);
      return kind === 'clarify' || kind === 'remediate';
    });
}

/** The single top signal `question.next` returns, or null. */
function topSignal(result: unknown): Record<string, any> | null {
  const raw = elicitationTopSignal(result);
  if (!raw) return null;
  const kind = text(raw.kind);
  if (kind !== 'clarify' && kind !== 'remediate') return null;
  return raw;
}

function signalClaims(signal: Record<string, any>): string[] {
  return asArray(signal.claims).map(text).filter(Boolean);
}

function signalKey(signal: Record<string, any>): string {
  return `${text(signal.code)}|${text(signal.dimension)}|${[...signalClaims(signal)].sort().join(',')}`;
}

/** One `ClarifyQuestion` from a real elicitation signal. */
/** Longest claim label quoted as question context. The label is usually the
 * whole deliverable, so quoting it in full repeats the contract in every
 * question of a batch. */
export const MAX_QUESTION_CONTEXT_CHARS = 160;

/** Collapse whitespace and cut `value` to `max` characters with an ellipsis. */
function boundedExcerpt(value: string, max = MAX_QUESTION_CONTEXT_CHARS): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function questionForSignal(
  signal: Record<string, any>,
  claims: Map<string, ElicitationClaimView>,
  index: number,
): ClarifyQuestion {
  const claimIds = signalClaims(signal);
  let question = text(signal.suggested_question);
  if (text(signal.code) === 'open_hypothesis' && claimIds.length === 1) {
    const claim = claims.get(claimIds[0]);
    if (claim && claim.value) {
      question = claim.label
        ? `Confirm or refute: ${claim.value} (context: ${boundedExcerpt(claim.label)})`
        : `Confirm or refute: ${claim.value}`;
    }
  }
  const message = text(signal.message);
  const code = text(signal.code);
  const why = message ? `${message} (${code})` : code;
  const suggested = signal.suggested_answer ?? signal.suggestedAnswer;
  const suggestedAnswer = suggested === undefined || suggested === null || suggested === '' ? null : String(suggested);
  const dimension = text(signal.dimension);
  return { id: `Q${index + 1}`, question, why, suggestedAnswer, claimIds, ...(dimension ? { dimension } : {}) };
}

/** Render the ranked question batch as compact Markdown. */
export function renderClarifyMd(batch: ClarifyBatch): string {
  const lines = [`# Clarification questions (${batch.sessionId})`, '', `Round ${batch.round}`, '', '## Ranked questions', ''];
  if (batch.questions.length === 0) lines.push('- (none)');
  for (const q of batch.questions) {
    lines.push(`- ${q.id}: ${q.question}`);
    lines.push(`  - why: ${q.why}`);
    lines.push(`  - suggested answer: ${q.suggestedAnswer ?? '(none)'}`);
    if (q.claimIds.length) lines.push(`  - claims: ${q.claimIds.join(', ')}`);
  }
  if (batch.blockers.length) {
    lines.push('', '## Blockers');
    for (const blocker of batch.blockers) lines.push(`- ${blocker}`);
  }
  return lines.join('\n');
}

function writeClarifyArtifacts(dir: string, batch: ClarifyBatch): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(clarifyPath(dir), JSON.stringify(batch, null, 2));
  writeFileSync(clarifyMdPath(dir), renderClarifyMd(batch));
}

/**
 * Build the ranked clarification batch from the real elicitation responses:
 * `question.next`'s single signal first, then the remaining `state.get` clarify
 * or remediate signals in server order, deduplicated by (code, dimension,
 * claims) and capped at `maxQuestions`. The batch is written to
 * `clarify.json`/`clarify.md` and returned as `needs_answers`.
 */
export async function questionBatch(sessionId: string, deps: QuestionBatchDeps = {}): Promise<ClarifyBatch> {
  const max = deps.maxQuestions ?? MAX_CLARIFY_QUESTIONS;
  const nextResult = await elicit(deps, 'question.next', { session_id: sessionId });
  const state = await elicit(deps, 'state.get', { session_id: sessionId });
  const claims = stateClaims(state);
  const ranked: Array<Record<string, any>> = [];
  const top = topSignal(nextResult);
  if (top) ranked.push(top);
  for (const signal of stateSignals(state)) ranked.push(signal);
  const seen = new Set<string>();
  const questions: ClarifyQuestion[] = [];
  for (const signal of ranked) {
    if (questions.length >= max) break;
    const key = signalKey(signal);
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push(questionForSignal(signal, claims, questions.length));
  }
  const batch: ClarifyBatch = {
    outcome: 'needs_answers',
    sessionId,
    round: deps.round ?? 1,
    questions,
    blockers: deps.blockers ?? [],
    playbooks: deps.playbooks ?? [],
    artifactDir: deps.dir ?? null,
  };
  if (deps.dir) writeClarifyArtifacts(deps.dir, batch);
  return batch;
}

/**
 * Open the elicitation session for a contract, seed it, record any checkable
 * app-research evidence and hand back the first ranked question batch.
 */
export async function startClarification(task: any, deps: ClarifyDeps = {}): Promise<ClarifyBatch> {
  const sessionId = clarifySessionId(text(task?.id) || 'contract');
  const seed = isRecord(task?.job) ? seedFromJob(task.job, sessionId) : seedFromContract(task, sessionId);
  await elicit(deps, 'session.open', seed.sessionOpen);
  for (const payload of seed.claims) await elicit(deps, 'append', payload);
  if (deps.discoverReport && existsSync(deps.discoverReport)) {
    const report = readFileSync(deps.discoverReport, 'utf8');
    const evidence = discoverEvidenceFromReport(report, seed.claims.map((payload) => text(payload?.claim?.id)).filter(Boolean));
    for (const payload of evidence) {
      payload.session_id = sessionId;
      payload.evidence.session_id = sessionId;
      await elicit(deps, 'append', payload);
    }
  }
  return questionBatch(sessionId, {
    ...deps,
    round: 1,
    playbooks: deps.playbooks ?? [],
  });
}

// ---------------------------------------------------------------------------
// Continuation
// ---------------------------------------------------------------------------

/** Read the most recent clarification batch written for a contract id. */
export function readLatestClarify(cwd: string, contractId: string): { batch: ClarifyBatch; dir: string } | null {
  const base = join(cwd, '.delivery', contractId);
  if (!existsSync(base)) return null;
  let best: { dir: string; mtime: number } | null = null;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(base, entry.name);
    if (!existsSync(clarifyPath(dir))) continue;
    const mtime = statSync(dir).mtimeMs;
    if (!best || mtime > best.mtime) best = { dir, mtime };
  }
  if (!best) return null;
  return { batch: JSON.parse(readFileSync(clarifyPath(best.dir), 'utf8')) as ClarifyBatch, dir: best.dir };
}

async function appendAnswer(
  deps: ClarifyDeps,
  sessionId: string,
  question: ClarifyQuestion,
  answer: ClarifyAnswer,
): Promise<void> {
  if (answer.stance === 'amend') {
    const id = `clarify:${sessionId}/amendment:${question.id}`;
    await elicit(deps, 'append', {
      variant: 'add_claim',
      session_id: sessionId,
      claim: {
        id,
        session_id: sessionId,
        subject: { id: sessionId, label: 'clarification' },
        predicate: 'amendment',
        object: { kind: 'value', value: text(answer.answer) },
        polarity: 'positive',
        category: 'requirement',
        modality: 'fact',
        dimensions: question.dimension ? [question.dimension] : [],
        source: { turn_id: id },
      },
    });
    return;
  }
  // A question tied to no claim (e.g. a coverage gap) has nothing to attach
  // assent or refutation evidence to; its dimension's own claims are asked
  // individually. Only an amendment adds a claim for it (above).
  if (!question.claimIds.length) return;
  const source_type = answer.stance === 'refute' ? 'user_refutation' : 'user_assent';
  const claimId = question.claimIds[0];
  const id = `evidence:${claimId}:${source_type}:${question.id}`;
  await elicit(deps, 'append', {
    variant: 'add_evidence',
    session_id: sessionId,
    evidence: {
      id,
      session_id: sessionId,
      claim_id: claimId,
      source_type,
      detail: text(answer.answer),
      source: { turn_id: id },
    },
  });
}

/** Draft a valid prepare brief from an exported elicitation spec. */
export function briefFromSpec(spec: unknown, task: any): Brief {
  const requirements = asArray((spec as any)?.requirements).filter(isRecord);
  const effective = requirements.length > 0
    ? requirements
    : [{ id: 'default', statement: text(task?.deliverable) || 'Implement the clarified work', acceptance_criteria: [] }];
  const scope = effective
    .map((requirement, index) => ({ id: `U${index + 1}`, text: text(requirement.statement ?? requirement.capability ?? requirement.id) }))
    .filter((item) => item.text);
  if (scope.length === 0) scope.push({ id: 'U1', text: 'Deliverable' });
  const options = effective.map((requirement, index) => ({
    id: `R${index + 1}`,
    title: text(requirement.id ?? `Option ${index + 1}`),
    approach: text(requirement.statement ?? requirement.capability ?? requirement.id),
    files: [] as string[],
    effort: { optimistic: 2, likely: 4, pessimistic: 8 },
    risks: [] as string[],
    tradeoffs: 'Derived from the clarified elicitation spec.',
  }));
  const acceptanceProof = effective
    .flatMap((requirement) => asArray(requirement.acceptance_criteria).map(text))
    .filter(Boolean)
    .map((acceptance) => ({ acceptance, proof: 'clarified spec acceptance criterion' }));
  const brief: Brief = {
    understanding: { scope, outOfScope: [], assumptions: [], acceptanceProof },
    options,
    recommendation: { option: options[0].id, why: 'The first clarified requirement' },
  };
  return brief;
}

function slugify(value: unknown): string {
  const slug = text(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'clarified';
}

function writeDraftPlan(cwd: string, contractId: string, plan: PlanDocument): string {
  const out = join(cwd, '.cpm-planner', 'plans', slugify(contractId), 'main.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);
  return out;
}

/** One `Clarified Qn: ... -> stance: answer` line per answered batch question. */
function clarifiedLines(batch: ClarifyBatch, answers: Record<string, ClarifyAnswer>): string[] {
  const lines: string[] = [];
  for (const question of asArray(batch.questions)) {
    const answer = answers[question.id];
    if (!answer) continue;
    lines.push(`Clarified ${question.id}: ${question.question} -> ${answer.stance}: ${answer.answer}`);
  }
  return lines;
}

/** Append this round's clarified lines to the session's running record, so a
 * multi-round clarification keeps every earlier answer, and return them all. */
function recordClarifiedLines(dir: string, lines: string[]): string[] {
  const path = join(dir, CLARIFIED_ANSWERS_FILENAME);
  let recorded: string[] = [];
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed) || parsed.some((line) => typeof line !== 'string')) {
      throw new Error(`${path} is not a JSON array of strings`);
    }
    recorded = parsed;
  }
  const all = [...recorded, ...lines.filter((line) => !recorded.includes(line))];
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`);
  return all;
}

export interface ApplyAnswersOptions {
  cwd: string;
  task: any;
  answers: Record<string, ClarifyAnswer>;
  deps?: ClarifyDeps;
  /** The batch to continue (defaults to the latest on disk). */
  batch?: ClarifyBatch;
}

/**
 * Apply the manager's answers, re-assess readiness and either write the
 * clarified contract (an explicit workflow), hand the exported spec to the cpm
 * plan bridge (plan-sized routing) or to the prepare brief, or return the next
 * question batch / escalate after the bounded rounds.
 */
export async function applyAnswers(options: ApplyAnswersOptions): Promise<ClarifyContinuation> {
  const { cwd, task } = options;
  const found = options.batch
    ? { batch: options.batch, dir: options.batch.artifactDir ?? join(cwd, '.delivery', text(task?.id), String(Date.now())) }
    : readLatestClarify(cwd, text(task?.id));
  if (!found) throw new Error(`No clarification session found for ${text(task?.id)}; run the handoff first.`);
  const batch = found.batch;
  const sessionId = batch.sessionId;

  // The resolution order for the artifact dir and routing is: explicit deps,
  // then the batch recorded at start.
  const deps: ClarifyDeps = {
    ...options.deps,
    dir: options.deps?.dir ?? found.dir,
    hopPath: options.deps?.hopPath
      ?? (typeof task?.hopFrom === 'string' && task.hopFrom.trim() ? resolve(cwd, task.hopFrom) : undefined),
    playbooks: options.deps?.playbooks ?? batch.playbooks,
  };

  for (const [id, answer] of Object.entries(options.answers ?? {})) {
    const question = batch.questions.find((candidate) => candidate.id === id);
    if (!question) continue;
    await appendAnswer(deps, sessionId, question, answer);
  }
  const explicitWorkflow = typeof task?.workflow === 'string' && task.workflow !== 'auto';
  const clarified = explicitWorkflow
    ? recordClarifiedLines(deps.dir as string, clarifiedLines(batch, options.answers ?? {}))
    : [];

  const readiness = await elicit(deps, 'readiness.assess', { session_id: sessionId });
  const ready = readiness?.ready === true;
  const blockers = asArray(readiness?.blockers).map(text).filter(Boolean);
  const round = batch.round ?? 1;

  if (ready) {
    if (explicitWorkflow) {
      const dir = deps.dir as string;
      const contract = { ...task, constraints: [...asArray(task?.constraints), ...clarified], clarifiedFrom: clarifyPath(dir) };
      const contractPath = join(dir, CLARIFIED_CONTRACT_FILENAME);
      writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
      return { outcome: 'contract', sessionId, round, spec: null, contract, contractPath };
    }
    const exported = await elicit(deps, 'spec.export', { session_id: sessionId });
    const spec = isRecord(exported) && 'spec' in exported ? exported.spec : exported;
    if (isPlanSized(deps.playbooks ?? [])) {
      const plan = buildPlanFromSpec(spec);
      const planPath = writeDraftPlan(cwd, text(task?.id), plan);
      return { outcome: 'plan_drafted', sessionId, round, spec, plan, planPath };
    }
    const brief = briefFromSpec(spec, task);
    validateBrief(brief);
    const dir = deps.dir as string;
    mkdirSync(dir, { recursive: true });
    writeFileSync(briefPath(dir), JSON.stringify(brief, null, 2));
    writeFileSync(briefMdPath(dir), renderBrief(brief));
    return { outcome: 'brief', sessionId, round, spec, brief, briefPath: briefPath(dir), briefMdPath: briefMdPath(dir) };
  }

  const maxRounds = deps.maxRounds ?? MAX_CLARIFY_ROUNDS;
  if (round < maxRounds) {
    return questionBatch(sessionId, {
      ...deps,
      round: round + 1,
      blockers,
      playbooks: deps.playbooks ?? [],
    });
  }
  return { outcome: 'escalated', sessionId, round, blockers };
}