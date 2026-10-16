// ---------------------------------------------------------------------------
// Prepare workflow: the deterministic brief for "do the legwork first and check
// back before acting".
//
// `prepare` runs as an analysis-only workflow. Its worker researches only what
// the graph slice and contract context name (both are supplied in the prompt),
// reproduces or measures when that is cheap, and writes two artifacts to the run
// directory:
//   * `brief.json` - the machine-readable brief validated by `validateBrief`
//   * `brief.md`   - the compact human-readable brief rendered by `renderBrief`
// It makes no production changes.
//
// This module owns the brief schema and the pure decision logic around it:
//   * `validateBrief` rejects malformed briefs before a manager relies on one;
//   * `renderBrief` renders a compact Markdown brief with the numbered
//     understanding items (U*) and assumptions (A*) before the options;
//   * `scoreOptions` scores the options with the existing categorical analysis
//     engine (`matrix-analyze.ts`) against fixed criteria and attaches the
//     ranked result to the brief;
//   * `shouldCheckBack` decides whether a handoff must prepare first, using the
//     Jev attention, the routed tool plan and the recorded correction history;
//   * `buildImplementationContract`/`chooseBrief` turn a chosen option into the
//     implementation contract and record the choice in
//     `.delivery/prepare-history.jsonl`.
// ---------------------------------------------------------------------------

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { analyze, type AnalysisCriterion, type AnalysisResult, type ScaleOption } from './matrix-analyze.ts';
import type { GateClassifier } from './worker.ts';
import type { ToolRoute } from './tool-routing.ts';

// ---------------------------------------------------------------------------
// Artifact paths
// ---------------------------------------------------------------------------

export const BRIEF_FILENAME = 'brief.json';
export const BRIEF_MD_FILENAME = 'brief.md';
/** The filename the prepare workflow writes and `--choose` reads. */
export function briefPath(dir: string): string {
  return join(dir, BRIEF_FILENAME);
}
export function briefMdPath(dir: string): string {
  return join(dir, BRIEF_MD_FILENAME);
}

// ---------------------------------------------------------------------------
// Brief schema
// ---------------------------------------------------------------------------

export type AssumptionStatus = 'verified' | 'guess';

export interface UnderstandingItem {
  id: string;
  text: string;
}

export interface AssumptionItem {
  id: string;
  text: string;
  status: AssumptionStatus;
  /** `path:line` evidence for a `verified` assumption. */
  evidence?: string;
}

export interface AcceptanceProof {
  acceptance: string;
  proof: string;
}

export interface BriefUnderstanding {
  scope: UnderstandingItem[];
  outOfScope: UnderstandingItem[];
  assumptions: AssumptionItem[];
  acceptanceProof: AcceptanceProof[];
}

export interface OptionEffort {
  optimistic: number;
  likely: number;
  pessimistic: number;
}

export interface BriefOption {
  id: string;
  title: string;
  approach: string;
  files: string[];
  effort: OptionEffort;
  risks: string[];
  tradeoffs: string;
  adrNotes?: string[];
  /** Path to a drafted `.cpm-planner` plan file, when one was drafted. */
  plan?: string;
}

export interface BriefRecommendation {
  option: string;
  why: string;
}

export interface Brief {
  understanding: BriefUnderstanding;
  options: BriefOption[];
  /** The ranked option scoring from `scoreOptions`, when it has been run. */
  scoring?: AnalysisResult;
  recommendation: BriefRecommendation;
  /** The routed playbooks that triggered this prepare run (recorded for the
   * correction-rate history). */
  playbooks?: string[];
}

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid brief: ${field} must be a non-empty string`);
  return value;
}

function validateUnderstandingItems(value: unknown, field: string): void {
  if (!Array.isArray(value)) throw new Error(`Invalid brief: ${field} must be an array`);
  for (const item of value) {
    if (!isRecord(item)) throw new Error(`Invalid brief: ${field} entries must be objects`);
    requireString(item.id, `${field}.id`);
    requireString(item.text, `${field}.text`);
  }
}

/**
 * Validate a brief, throwing a human-readable error on the first problem. The
 * most important rule is that every assumption declares a `verified` or `guess`
 * status, so the manager can tell proven facts from open guesses.
 */
export function validateBrief(brief: unknown): asserts brief is Brief {
  if (!isRecord(brief)) throw new Error('Invalid brief: expected an object');
  const understanding = brief.understanding;
  if (!isRecord(understanding)) throw new Error('Invalid brief: understanding must be an object');
  validateUnderstandingItems(understanding.scope, 'understanding.scope');
  validateUnderstandingItems(understanding.outOfScope, 'understanding.outOfScope');

  if (!Array.isArray(understanding.assumptions)) throw new Error('Invalid brief: understanding.assumptions must be an array');
  for (const assumption of understanding.assumptions) {
    if (!isRecord(assumption)) throw new Error('Invalid brief: understanding.assumptions entries must be objects');
    const id = requireString(assumption.id, 'understanding.assumptions.id');
    requireString(assumption.text, `understanding.assumptions.${id}.text`);
    if (assumption.status !== 'verified' && assumption.status !== 'guess') {
      throw new Error(`Invalid brief: assumption ${id} status must be verified or guess`);
    }
    if (assumption.evidence !== undefined) requireString(assumption.evidence, `understanding.assumptions.${id}.evidence`);
  }

  if (!Array.isArray(understanding.acceptanceProof)) throw new Error('Invalid brief: understanding.acceptanceProof must be an array');
  for (const entry of understanding.acceptanceProof) {
    if (!isRecord(entry)) throw new Error('Invalid brief: understanding.acceptanceProof entries must be objects');
    requireString(entry.acceptance, 'understanding.acceptanceProof.acceptance');
    requireString(entry.proof, 'understanding.acceptanceProof.proof');
  }

  if (!Array.isArray(brief.options) || brief.options.length === 0) throw new Error('Invalid brief: options must be a non-empty array');
  for (const option of brief.options) {
    if (!isRecord(option)) throw new Error('Invalid brief: options entries must be objects');
    const id = requireString(option.id, 'options.id');
    requireString(option.title, `options.${id}.title`);
    requireString(option.approach, `options.${id}.approach`);
    if (!Array.isArray(option.files) || option.files.some((f: unknown) => typeof f !== 'string')) {
      throw new Error(`Invalid brief: options.${id}.files must be an array of strings`);
    }
    if (!isRecord(option.effort)) throw new Error(`Invalid brief: options.${id}.effort must be an object`);
    for (const key of ['optimistic', 'likely', 'pessimistic']) {
      if (typeof option.effort[key] !== 'number' || !Number.isFinite(option.effort[key])) {
        throw new Error(`Invalid brief: options.${id}.effort.${key} must be a finite number`);
      }
    }
    if (!Array.isArray(option.risks) || option.risks.some((r: unknown) => typeof r !== 'string')) {
      throw new Error(`Invalid brief: options.${id}.risks must be an array of strings`);
    }
    requireString(option.tradeoffs, `options.${id}.tradeoffs`);
    if (option.adrNotes !== undefined && (!Array.isArray(option.adrNotes) || option.adrNotes.some((n: unknown) => typeof n !== 'string'))) {
      throw new Error(`Invalid brief: options.${id}.adrNotes must be an array of strings`);
    }
    if (option.plan !== undefined) requireString(option.plan, `options.${id}.plan`);
  }

  if (!isRecord(brief.recommendation)) throw new Error('Invalid brief: recommendation must be an object');
  requireString(brief.recommendation.option, 'recommendation.option');
  requireString(brief.recommendation.why, 'recommendation.why');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const itemLabel = (item: { id?: string }, prefix: string, index: number): string =>
  typeof item.id === 'string' && item.id.trim() ? item.id : `${prefix}${index + 1}`;

/**
 * Render a compact Markdown brief. The numbered understanding items (U*) and
 * assumptions (A*) always precede the options section so a manager reads what
 * is known and assumed before comparing approaches.
 */
export function renderBrief(brief: Brief): string {
  const lines: string[] = ['# Preparation brief', '', '## Understanding', '', '### In scope'];
  brief.understanding.scope.forEach((item, index) => lines.push(`- ${itemLabel(item, 'U', index)} ${item.text}`));
  lines.push('', '### Out of scope');
  if (brief.understanding.outOfScope.length === 0) lines.push('- (none recorded)');
  brief.understanding.outOfScope.forEach((item, index) => lines.push(`- ${itemLabel(item, 'U', brief.understanding.scope.length + index)} ${item.text}`));
  lines.push('', '### Assumptions');
  if (brief.understanding.assumptions.length === 0) lines.push('- (none recorded)');
  brief.understanding.assumptions.forEach((item, index) => {
    const label = itemLabel(item, 'A', index);
    const evidence = item.evidence ? ` - evidence: ${item.evidence}` : '';
    lines.push(`- ${label} [${item.status}]${evidence}: ${item.text}`);
  });
  lines.push('', '### Acceptance proof');
  if (brief.understanding.acceptanceProof.length === 0) lines.push('- (none recorded)');
  brief.understanding.acceptanceProof.forEach((entry) => lines.push(`- ${entry.acceptance}: ${entry.proof}`));

  lines.push('', '## Options');
  brief.options.forEach((option) => {
    lines.push(`### ${option.id} - ${option.title}`);
    lines.push(`- Approach: ${option.approach}`);
    lines.push(`- Files: ${option.files.length ? option.files.join(', ') : 'none recorded'}`);
    lines.push(`- Effort: optimistic ${option.effort.optimistic}, likely ${option.effort.likely}, pessimistic ${option.effort.pessimistic}`);
    lines.push(`- Risks: ${option.risks.length ? option.risks.join('; ') : 'none recorded'}`);
    lines.push(`- Tradeoffs: ${option.tradeoffs}`);
    if (option.adrNotes?.length) lines.push(`- ADR notes: ${option.adrNotes.join('; ')}`);
    if (option.plan) lines.push(`- Drafted plan: ${option.plan}`);
    lines.push('');
  });

  lines.push('## Recommendation', `- ${brief.recommendation.option}: ${brief.recommendation.why}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Option scoring
// ---------------------------------------------------------------------------

function threePoint(): ScaleOption[] {
  return [
    { id: 'none', label: 'None', score: 0 },
    { id: 'partial', label: 'Partial', score: 1 },
    { id: 'full', label: 'Full', score: 3 },
  ];
}

/** A "less is better" scale: the favourable option id scores highest. */
function inverseThreePoint(): ScaleOption[] {
  return [
    { id: 'high', label: 'High', score: 0 },
    { id: 'medium', label: 'Medium', score: 1 },
    { id: 'low', label: 'Low', score: 3 },
  ];
}

/** The fixed criteria every prepare brief is scored against. All criteria read
 * "higher is better" so the analysis ranking is directly actionable. */
export const OPTION_CRITERIA: AnalysisCriterion[] = [
  { id: 'risk', label: 'Risk contained', question: 'How well does this option contain downside risk?', weight: 3, scale: threePoint() },
  { id: 'effort', label: 'Effort', question: 'How little effort does this option require?', weight: 2, scale: inverseThreePoint() },
  { id: 'outcome_impact', label: 'Outcome impact', question: 'How much customer outcome does this option deliver?', weight: 3, scale: threePoint() },
  { id: 'adr_conformance', label: 'ADR conformance', question: 'How well does this option conform to the recorded decisions?', weight: 2, scale: threePoint() },
  { id: 'files_touched', label: 'Files touched', question: 'How few files does this option touch?', weight: 1, scale: inverseThreePoint() },
];

/**
 * Score the brief's options with the categorical analysis engine and attach the
 * ranked result to `brief.scoring`. Deterministic once the classifier answers.
 */
export async function scoreOptions(brief: Brief, classifier: GateClassifier): Promise<Brief> {
  const result = await analyze({
    input: {
      items: brief.options.map((option) => ({
        id: option.id,
        label: `${option.id}: ${option.title}`,
        description: option.approach,
      })),
      criteria: OPTION_CRITERIA,
    },
    classify: classifier,
  });
  brief.scoring = result;
  return brief;
}

// ---------------------------------------------------------------------------
// Check-back decision
// ---------------------------------------------------------------------------

export const PREPARE_HISTORY_FILENAME = 'prepare-history.jsonl';
/** Rerouted playbooks that always warrant a check-back. */
export const CHECKBACK_PLAYBOOKS = ['decision-evaluate', 'vague-feature', 'risky-migration', 'planned-change'] as const;

/** One recorded choice: which playbooks routed and whether the manager
 * corrected any understanding item. */
export interface PrepareHistoryEntry {
  playbooks: string[];
  corrected: boolean;
}

export function prepareHistoryPath(cwd: string): string {
  return join(cwd, '.delivery', PREPARE_HISTORY_FILENAME);
}

/** Read every recorded history line; malformed lines are ignored. */
export function loadPrepareHistory(cwd: string): PrepareHistoryEntry[] {
  const path = prepareHistoryPath(cwd);
  if (!existsSync(path)) return [];
  const entries: PrepareHistoryEntry[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (isRecord(parsed) && Array.isArray(parsed.playbooks)) {
        entries.push({ playbooks: parsed.playbooks.filter((p: unknown) => typeof p === 'string'), corrected: parsed.corrected === true });
      }
    } catch {
      // A corrupt history line must never block a handoff.
    }
  }
  return entries;
}

/** Append one choice to the correction history. */
export function recordPrepareHistory(cwd: string, entry: PrepareHistoryEntry): void {
  const path = prepareHistoryPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ playbooks: entry.playbooks, corrected: entry.corrected === true })}\n`);
}

/**
 * True when a playbook's recorded correction rate over at least ten prior briefs
 * is below 5%: the manager usually accepts this playbook without changes, so a
 * check-back is not worth the interruption. Fewer than ten recorded briefs never
 * suppresses.
 */
function correctionRateSuppressed(playbookId: string, history: PrepareHistoryEntry[]): boolean {
  const relevant = history.filter((entry) => entry.playbooks.includes(playbookId));
  if (relevant.length < 10) return false;
  const corrected = relevant.filter((entry) => entry.corrected).length;
  return corrected / relevant.length < 0.05;
}

/**
 * Decide whether a handoff must run the prepare workflow and check back before
 * acting.
 *
 * True when Jev flags an unclear contract or a blocking assumption, or when the
 * routed playbooks include a decision/plan playbook. A plain-change routing
 * never checks back, and a triggered playbook whose recorded correction rate is
 * below 5% over at least ten briefs is trusted and does not check back.
 */
export function shouldCheckBack(
  attention: { decision?: string; trigger?: string } | null | undefined,
  plan: Pick<ToolRoute, 'playbooks'> | null | undefined,
  history: PrepareHistoryEntry[] = [],
): boolean {
  const ids = (plan?.playbooks ?? []).map((playbook) => playbook.id);
  // A small, well-specified change is never worth a check-back.
  if (ids.length > 0 && ids.every((id) => id === 'plain-change')) return false;

  const triggered = ids.filter((id) => (CHECKBACK_PLAYBOOKS as readonly string[]).includes(id));
  if (triggered.some((id) => !correctionRateSuppressed(id, history))) return true;

  const unclear = !!attention
    && (attention.decision === 'clarify' || attention.trigger === 'contract_clear' || attention.trigger === 'blocking_assumptions');
  return unclear;
}

// ---------------------------------------------------------------------------
// Choice: brief -> implementation contract
// ---------------------------------------------------------------------------

export interface BriefChoice {
  option: string;
  corrections?: Record<string, string>;
}

/**
 * Build the implementation contract for a chosen option: the option's approach
 * into the deliverable, its files into the context and constraints, and each
 * correction replacing the matching understanding item and recorded as a
 * constraint. The result carries `preparedFrom` so the prepare gate does not
 * fire again.
 */
export function buildImplementationContract(task: any, brief: Brief, choice: BriefChoice): any {
  validateBrief(brief);
  const option = brief.options.find((entry) => entry.id === choice.option);
  if (!option) throw new Error(`Unknown prepare option: ${choice.option}`);
  const corrections = choice.corrections ?? {};

  const understanding: BriefUnderstanding = JSON.parse(JSON.stringify(brief.understanding));
  const correctionConstraints: string[] = [];
  for (const [id, text] of Object.entries(corrections)) {
    for (const group of ['scope', 'outOfScope'] as const) {
      const item = understanding[group].find((entry) => entry.id === id);
      if (item) item.text = text;
    }
    const assumption = understanding.assumptions.find((entry) => entry.id === id);
    if (assumption) assumption.text = text;
    correctionConstraints.push(`${id} corrected: ${text}`);
  }

  const constraints = [...(Array.isArray(task.constraints) ? task.constraints : []), ...correctionConstraints];
  for (const file of option.files) if (!constraints.includes(`files: ${file}`)) constraints.push(`files: ${file}`);
  if (option.plan && !constraints.includes(`drafted plan: ${option.plan}`)) constraints.push(`drafted plan: ${option.plan}`);

  const deliverable = `${task.deliverable}\n\nApproach (option ${option.id} - ${option.title}):\n${option.approach}`;
  const contract: any = { ...task, deliverable, constraints, preparedFrom: task.id };

  const context = Array.isArray(task.context) ? [...task.context] : [];
  for (const file of option.files) {
    const relativeFile = typeof file === 'string' && !file.startsWith('/') && !file.startsWith('..');
    if (relativeFile && !context.some((entry: any) => entry?.path === file)) context.push({ path: file });
  }
  if (context.length) contract.context = context;

  if (task.workflow === undefined || task.workflow === 'auto' || task.workflow === 'prepare') contract.workflow = 'test_first';
  return contract;
}

/**
 * Choose an option: build the implementation contract and record the choice
 * (which playbooks routed and whether the manager corrected anything) in the
 * prepare history.
 */
export function chooseBrief(opts: {
  cwd: string;
  task: any;
  brief: Brief;
  choice: BriefChoice;
  playbooks?: string[];
}): { contract: any; history: PrepareHistoryEntry } {
  const contract = buildImplementationContract(opts.task, opts.brief, opts.choice);
  const history: PrepareHistoryEntry = {
    playbooks: opts.playbooks ?? opts.brief.playbooks ?? [],
    corrected: Object.keys(opts.choice.corrections ?? {}).length > 0,
  };
  recordPrepareHistory(opts.cwd, history);
  return { contract, history };
}

/** Read the most recently written brief for a contract id, or null. */
export function readLatestBrief(cwd: string, contractId: string): { brief: Brief; dir: string } | null {
  const base = join(cwd, '.delivery', contractId);
  if (!existsSync(base)) return null;
  let best: { dir: string; mtime: number } | null = null;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(base, entry.name);
    if (!existsSync(briefPath(dir))) continue;
    const mtime = statSync(dir).mtimeMs;
    if (!best || mtime > best.mtime) best = { dir, mtime };
  }
  if (!best) return null;
  return { brief: JSON.parse(readFileSync(briefPath(best.dir), 'utf8')) as Brief, dir: best.dir };
}

// ---------------------------------------------------------------------------
// Mock/placeholder brief
// ---------------------------------------------------------------------------

/** A minimal valid brief for a mock prepare run: no classifier or worker runs,
 * but the handback still carries a well-formed brief for the manager to fill in
 * during a live run. */
export function buildPlaceholderBrief(task: any): Brief {
  const acceptance = Array.isArray(task?.acceptance) ? task.acceptance : [];
  return {
    understanding: {
      scope: [{ id: 'U1', text: typeof task?.deliverable === 'string' ? task.deliverable : 'Deliverable' }],
      outOfScope: [],
      assumptions: [],
      acceptanceProof: acceptance.map((entry: any) => ({
        acceptance: typeof entry === 'string' ? entry : String(entry?.text ?? ''),
        proof: 'independent checks',
      })),
    },
    options: [
      {
        id: 'A',
        title: 'Prepared approach (placeholder)',
        approach: 'The prepare workflow has not run a live model in mock mode; inspect the contract and draft the real options.',
        files: [],
        effort: { optimistic: 0, likely: 0, pessimistic: 0 },
        risks: [],
        tradeoffs: 'Placeholder generated for a mock prepare run.',
      },
    ],
    recommendation: { option: 'A', why: 'Only a placeholder is available in mock mode.' },
  };
}
