import { assessPreflight, CONFIDENCE_THRESHOLD, resolveContext, type GateClassifier } from './worker.ts';

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
      const preflight = await assessPreflight(entry.contract, classify, { context: resolveContext(entry.contract) });
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

// ---------------------------------------------------------------------------
// Dependency-edge vetting (#122).
//
// `vetPlanEdges` is the static, offline pass: it records supporting evidence
// and a counterfactual challenge for every reviewed edge, never mutates the
// plan, and attaches ready `plan.fork` edits for the manager. `vetPlanEdgesWithClassifier`
// adds the two-sided model answers (positive: "what does B consume from A?",
// negative: "could B be built on a base without A?") through an injected seam.
// ---------------------------------------------------------------------------

export type EdgeVerdict = 'supported' | 'refuted' | 'uncertain';
export type VetEvidenceKind = 'static' | 'two-sided' | 'counterfactual';

export interface VetEvidence {
  kind: VetEvidenceKind;
  supports: boolean;
  detail: string;
}

export interface EdgeProposal {
  op: 'remove_edge';
  from: string;
  to: string;
}

export interface EdgeVetFinding {
  id: string;
  from: string;
  to: string;
  consumes: string;
  verdict: EdgeVerdict;
  supporting: VetEvidence[];
  counterfactual: VetEvidence[];
  proposals: EdgeProposal[];
}

export interface PlanVetReport {
  ok: boolean;
  applied: false;
  findings: EdgeVetFinding[];
  reviewed: number;
  supported: number;
  refuted: number;
  uncertain: number;
}

/** A two-sided answer: positive is p(B consumes something from A), negative is
 * p(B could be built on a base without A). Values are 0..1 probabilities. */
export type EdgeVetClassifier = (input: {
  edge: { from: string; to: string; consumes: string };
  producer: Record<string, any>;
  consumer: Record<string, any>;
  questions: { positive: string; negative: string };
}) => Promise<{ positive: number; negative: number; error?: string }>;

function vetIsRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function vetDeliverables(plan: unknown): Array<Record<string, any>> {
  if (Array.isArray(plan)) return plan.filter(vetIsRecord);
  if (vetIsRecord(plan) && Array.isArray(plan.deliverables)) return plan.deliverables.filter(vetIsRecord);
  return [];
}

function vetText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function vetFiles(deliverable: Record<string, any>): string[] {
  return (Array.isArray(deliverable.owned_files) ? deliverable.owned_files : [])
    .map((entry) => (typeof entry === 'string' ? entry : vetIsRecord(entry) && typeof entry.path === 'string' ? entry.path : ''))
    .filter(Boolean);
}

function edgeId(edge: unknown): string {
  if (typeof edge === 'string') return edge;
  return vetIsRecord(edge) ? vetText(edge.id) : '';
}

function edgeConsumes(edge: unknown): string {
  if (typeof edge === 'string') return '';
  return vetIsRecord(edge) ? vetText(edge.consumes) : '';
}

function edgeKind(edge: unknown): string {
  return vetIsRecord(edge) ? vetText(edge.kind) : '';
}

function contractSignals(producer: Record<string, any>, consumer: Record<string, any>): string[] {
  const producerId = vetText(producer.id);
  const producerArtifact = vetText(producer.metadata?.artifact);
  const producerFiles = vetFiles(producer);
  const haystack = [
    vetText(consumer.metadata?.artifact),
    JSON.stringify(vetIsRecord(consumer.metadata?.junior) ? consumer.metadata.junior : {}),
  ].join('\n').toLowerCase();
  return [producerId, producerArtifact, ...producerFiles]
    .filter((token) => token.length >= 2 && haystack.includes(token.toLowerCase()));
}

function recomputeVerdict(finding: EdgeVetFinding, hardRefuted: boolean): EdgeVerdict {
  if (hardRefuted) return 'refuted';
  const counterAgainst = finding.counterfactual.some((item) => !item.supports);
  if (finding.supporting.length > 0 && !counterAgainst) return 'supported';
  if (finding.supporting.length === 0) return 'refuted';
  return 'uncertain';
}

function proposalsFor(finding: EdgeVetFinding): EdgeProposal[] {
  if (finding.verdict === 'supported') return [];
  return [{ op: 'remove_edge', from: finding.from, to: finding.to }];
}

/** Statically vet every prerequisite edge: named consumption, skeleton
 * references, shared ownership and interface contracts are supporting evidence;
 * missing rationale, unknown producers, self-edges and non-contract interfaces
 * are counterfactual evidence. Never applies an edit. */
export function vetPlanEdges(plan: unknown): PlanVetReport {
  const deliverables = vetDeliverables(plan);
  const byId = new Map(deliverables.map((deliverable) => [vetText(deliverable.id), deliverable]));
  const findings: EdgeVetFinding[] = [];

  for (const consumer of deliverables) {
    const to = vetText(consumer.id);
    const prerequisites = Array.isArray(consumer.prerequisites) ? consumer.prerequisites : [];
    for (const edge of prerequisites) {
      const from = edgeId(edge);
      const consumes = edgeConsumes(edge);
      const producer = byId.get(from);
      const finding: EdgeVetFinding = {
        id: `${from}->${to}`,
        from,
        to,
        consumes,
        verdict: 'uncertain',
        supporting: [{ kind: 'static', supports: true, detail: `${to} declares ${from || '(no id)'} as a prerequisite` }],
        counterfactual: [],
        proposals: [],
      };
      let hardRefuted = false;

      if (!from || from === to || !producer) {
        hardRefuted = true;
        finding.counterfactual.push({
          kind: 'static',
          supports: false,
          detail: !from ? 'the edge names no producer' : from === to ? `${to} depends on itself` : `producer '${from}' is not in the plan`,
        });
      }

      if (consumes.trim()) {
        finding.supporting.push({ kind: 'static', supports: true, detail: `edge names the consumed artifact '${consumes}'` });
      } else {
        hardRefuted = true;
        finding.counterfactual.push({ kind: 'static', supports: false, detail: 'edge names nothing consumed' });
      }

      if (producer) {
        const signals = contractSignals(producer, consumer);
        if (signals.length > 0) {
          finding.supporting.push({
            kind: 'static',
            supports: true,
            detail: `${to}'s skeleton references ${signals.join(', ')} from ${from}`,
          });
        }
        const shared = vetFiles(consumer).filter((file) => vetFiles(producer).includes(file));
        if (shared.length > 0) {
          finding.supporting.push({ kind: 'static', supports: true, detail: `${from} and ${to} both own ${shared.join(', ')}` });
        }
        if (edgeKind(edge) === 'interface') {
          if (producer.metadata?.contract === true) {
            finding.supporting.push({ kind: 'static', supports: true, detail: `${from} is an explicit contract for the interface edge` });
          } else {
            hardRefuted = true;
            finding.counterfactual.push({ kind: 'static', supports: false, detail: `${from} is not marked metadata.contract for the interface edge` });
          }
        }
        // The counterfactual challenge is recorded even when it survives: the
        // report says what was checked, not only what failed.
        finding.counterfactual.push({
          kind: 'counterfactual',
          supports: signals.length > 0,
          detail: signals.length > 0
            ? `${to}'s skeleton would not stand on a base without ${from}`
            : `${to}'s skeleton references none of ${from}'s outputs; a base without ${from} may suffice`,
        });
      }

      finding.verdict = recomputeVerdict(finding, hardRefuted);
      finding.proposals = proposalsFor(finding);
      findings.push(finding);
    }
  }

  return {
    ok: findings.every((finding) => finding.verdict !== 'refuted'),
    applied: false,
    findings,
    reviewed: findings.length,
    supported: findings.filter((finding) => finding.verdict === 'supported').length,
    refuted: findings.filter((finding) => finding.verdict === 'refuted').length,
    uncertain: findings.filter((finding) => finding.verdict === 'uncertain').length,
  };
}

/** Add the two-sided classifier answers to the static report. Positive support
 * and a negative answer that B can stand alone are contradictory, so the edge
 * stays uncertain instead of being silently accepted. */
export async function vetPlanEdgesWithClassifier(
  plan: unknown,
  classify: EdgeVetClassifier,
): Promise<PlanVetReport> {
  const report = vetPlanEdges(plan);
  const deliverables = vetDeliverables(plan);
  const byId = new Map(deliverables.map((deliverable) => [vetText(deliverable.id), deliverable]));

  for (const finding of report.findings) {
    const producer = byId.get(finding.from);
    const consumer = byId.get(finding.to);
    if (!producer || !consumer) continue;
    const answer = await classify({
      edge: { from: finding.from, to: finding.to, consumes: finding.consumes },
      producer,
      consumer,
      questions: {
        positive: `What does ${finding.to} consume from ${finding.from}?`,
        negative: `Could ${finding.to} be built on a base without ${finding.from}?`,
      },
    });
    if (answer.error) {
      finding.counterfactual.push({ kind: 'two-sided', supports: false, detail: `two-sided check unavailable: ${answer.error}` });
      continue;
    }
    const positiveSupports = Number.isFinite(answer.positive) && answer.positive >= 0.6;
    const negativeSupports = Number.isFinite(answer.negative) && answer.negative >= 0.6;
    finding.supporting.push({
      kind: 'two-sided',
      supports: positiveSupports,
      detail: `positive answer p=${String(answer.positive)} that ${finding.to} consumes ${finding.consumes || 'the named artifact'} from ${finding.from}`,
    });
    finding.counterfactual.push({
      kind: 'two-sided',
      supports: !negativeSupports,
      detail: `negative answer p=${String(answer.negative)} that ${finding.to} could stand on a base without ${finding.from}`,
    });
    const hardRefuted = finding.counterfactual.some((item) => item.kind === 'static' && !item.supports);
    finding.verdict = recomputeVerdict(finding, hardRefuted);
    finding.proposals = proposalsFor(finding);
  }

  return {
    ...report,
    ok: report.findings.every((finding) => finding.verdict !== 'refuted'),
    supported: report.findings.filter((finding) => finding.verdict === 'supported').length,
    refuted: report.findings.filter((finding) => finding.verdict === 'refuted').length,
    uncertain: report.findings.filter((finding) => finding.verdict === 'uncertain').length,
  };
}
