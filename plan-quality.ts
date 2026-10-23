import { assessPreflight, CONFIDENCE_THRESHOLD, type GateClassifier } from './worker.ts';

/** Quality verdict for one planned Junior contract. */
export type ContractScore = {
  id: string;
  status: 'clear' | 'flagged' | 'unscored';
  trigger: string | null;
  probability: number | null;
  part: { name: string; probability: number | null } | null;
  questions: string[];
  reason: string | null;
};

/** Aggregate quality report for a plan's contracts. */
export type PlanQualityReport = {
  threshold: number;
  scores: ContractScore[];
  flagged: number;
  unscored: number;
};

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;

function validatedConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CONCURRENCY;
  if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
    throw new Error(`concurrency must be an integer 1..${MAX_CONCURRENCY}, got ${String(value)}`);
  }
  return value;
}

function scoreOne(id: string, preflight: Awaited<ReturnType<typeof assessPreflight>>): ContractScore {
  const attention = preflight.attention;
  if (preflight.error || attention.trigger === 'error') {
    return {
      id,
      status: 'unscored',
      trigger: attention.trigger,
      probability: attention.probability,
      part: attention.part ?? null,
      questions: attention.questions ?? [],
      reason: preflight.error ?? attention.reason,
    };
  }
  // Flag what the run-time gate or the manager would stop: an unclear contract
  // (ADR 0009) or a frontier-required / uncertain readiness. A clarify on
  // blocking_assumptions alone is not flagged: it fires on almost every
  // contract and does not separate problem runs (H16).
  const unclear = attention.decision === 'clarify' && attention.trigger === 'contract_clear';
  if (unclear || attention.decision === 'frontier_required' || attention.decision === 'uncertain') {
    return {
      id,
      status: 'flagged',
      trigger: attention.trigger,
      probability: attention.probability,
      part: attention.part ?? null,
      questions: attention.questions ?? [],
      reason: attention.reason,
    };
  }
  return {
    id,
    status: 'clear',
    trigger: null,
    probability: null,
    part: null,
    questions: [],
    reason: null,
  };
}

/** Score each planned contract's readiness through the worker's own preflight
 * gate, in bounded concurrent batches while preserving input order.
 *
 * `MAX_GATE_QUESTIONS` is enforced by `assessPreflight`; this module imports the
 * worker threshold and readiness implementation rather than copying them. */
export async function scorePlanContracts(
  contracts: ReadonlyArray<{ id: string; contract: any }>,
  classify: GateClassifier,
  opts: { concurrency?: number } = {},
): Promise<PlanQualityReport> {
  const concurrency = validatedConcurrency(opts.concurrency);
  const scores = new Array<ContractScore>(contracts.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < contracts.length) {
      const index = next;
      next += 1;
      const entry = contracts[index];
      const preflight = await assessPreflight(entry.contract, classify);
      scores[index] = scoreOne(entry.id, preflight);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, contracts.length) }, () => worker());
  await Promise.all(workers);

  return {
    threshold: CONFIDENCE_THRESHOLD,
    scores,
    flagged: scores.filter((score) => score.status === 'flagged').length,
    unscored: scores.filter((score) => score.status === 'unscored').length,
  };
}
