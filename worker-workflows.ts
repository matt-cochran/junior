// Deterministic workflow templates and contract-part helpers.
//
// Extracted from worker.ts without behavior change (ADR 0015 R7 seam X2). A
// workflow is a fixed, worker-readable prompt template, never model-authored
// prose. An explicit task `workflow` always wins; `auto` asks one Jev `choice`
// question and falls back to the inspect-first template. Selection stays
// separate from the gate pass/block status.

import { join } from 'node:path';
// The confidence threshold is still defined in worker.ts (seam X4 owns that
// range). It is imported as a live binding and only read when a workflow
// decision is made, after every module in the cycle has finished evaluating.
import { CONFIDENCE_THRESHOLD } from './worker-approval.ts';

// ---------------------------------------------------------------------------
// Deterministic workflow templates
//
// A workflow is a fixed, worker-readable prompt template, never model-authored
// prose. An explicit task `workflow` always wins. `auto` asks one Jev `choice`
// question (folded into the readiness classify call); a low-confidence answer,
// a classifier outage, or no classifier at all falls back to the inspect-first
// `checks_first` template and records the recommendation. Selection is kept
// separate from the gate pass/block status.
// ---------------------------------------------------------------------------

export const EXPLICIT_WORKFLOWS = ['recon','test_first','checks_first','fmeca','evaluate','discover','investigate','prepare','qa'] as const;
export type ExplicitWorkflow = typeof EXPLICIT_WORKFLOWS[number];
export type Workflow = ExplicitWorkflow | 'auto';

/** Analysis-only workflows produce a report and never implement production
 * changes. `recon` is inspect-first analysis; `fmeca` and `evaluate` are
 * structured risk/architecture reviews; `discover` is a requirements interview
 * and `investigate` runs one scientific-process experiment per handoff.
 * `prepare` researches the named graph slice and contract, then writes a brief
 * with options and checks back before any implementation. The analysis-only
 * scope is a contract boundary enforced through the required report and the
 * handback, not an OS sandbox. */
export const ANALYSIS_WORKFLOWS = ['recon','fmeca','evaluate','discover','investigate','prepare'] as const;
export function isAnalysisWorkflow(w:unknown):w is typeof ANALYSIS_WORKFLOWS[number] {
 return w === 'recon' || w === 'fmeca' || w === 'evaluate' || w === 'discover' || w === 'investigate' || w === 'prepare';
}

/** The report-only QA review workflow reviews a prior deliverable in a fresh
 * session. It is deliberately not part of ANALYSIS_WORKFLOWS: it has its own
 * review context, prompt contract and `reviewFrom` requirement. */
export function isQaWorkflow(w:unknown):w is 'qa' {
 return w === 'qa';
}
/** Any workflow that produces a deterministic report artifact and never
 * implements production changes on its own authority. */
export function isReportWorkflow(w:unknown):boolean {
 return isAnalysisWorkflow(w) || isQaWorkflow(w);
}

/** Deterministic analysis report filename inside a run's artifact directory. */
export const ANALYSIS_REPORT_FILENAME = 'analysis-report.md';
export function analysisReportPath(artifactDir:string):string {
 return join(artifactDir, ANALYSIS_REPORT_FILENAME);
}

/** Bounded report evidence supplied to the completion gate for report-only
 * workflows. The report itself is the deliverable, so its outline and a
 * line-bounded excerpt stand in for the absent code diff. */
export type ReportEvidence = { path:string; outline:string[]; excerpt:string; bytes:number; truncated:boolean };
export function reportEvidence(text:string, path:string, limits?:{maxExcerptBytes?:number;maxHeadings?:number}):ReportEvidence {
 const source=String(text ?? '');
 const maxBytes=limits?.maxExcerptBytes ?? 24000;
 const maxHeadings=limits?.maxHeadings ?? 200;
 const outline=source.split(/\r?\n/).filter((line)=>/^#{1,6}(?:\s|$)/.test(line)).slice(0,maxHeadings);
 const bytes=Buffer.byteLength(source);
 let excerpt=source, truncated=false;
 if (bytes>maxBytes) {
  truncated=true;
  let cut=source.slice(0,maxBytes);
  while (cut && Buffer.byteLength(cut)>maxBytes) cut=cut.slice(0,-1);
  const lineEnd=cut.lastIndexOf('\n');
  excerpt=lineEnd>=0 ? cut.slice(0,lineEnd+1) : cut;
 }
 return { path, outline, excerpt, bytes, truncated };
}

/** Recognize the fixed criteria that a run's change set alone can settle:
 * report-only changes, or no changed files at all. */
export function deterministicCriterion(text:string, evidence:{changedFiles:any[];allowed:string[]}):'met'|'gap'|null {
 const s=String(text ?? '');
 const recognized = /\bno\s+(?:other\s+)?files?\b[^.]*\bchang(?:e|ed|es)\b/i.test(s)
  || /\bno\s+files?\s+(?:is|are|was|were|has|have)?\s*changed\b/i.test(s)
  || /\bchang(?:e|es|ed|ing)\s+no\s+files?\b/i.test(s)
  || /\b(?:does|do|did)\s+not\s+change\s+production\s+code\b/i.test(s)
  || /\bno\s+production\s+code\s+(?:is|was|has been)?\s*changed\b/i.test(s);
 if (!recognized) return null;
 const norm=(p:string)=>p.replace(/\\/g,'/').replace(/^\.\//,'');
 const allowed=new Set((evidence.allowed ?? []).map(norm));
 const changed=(evidence.changedFiles ?? []).map((f:any)=>typeof f === 'string' ? f : f?.path).filter((p:any)=>typeof p === 'string' && p).map(norm);
 return changed.every((p:string)=>allowed.has(p)) ? 'met' : 'gap';
}

/** Stable identifiers saved as artifacts so a run's prompt is reproducible. */
export const WORKFLOW_TEMPLATE_IDS = {
 common:'delivery-common-2',
 recon:'delivery-recon-1',
 test_first:'delivery-test-first-1',
 checks_first:'delivery-checks-first-1',
 fmeca:'delivery-fmeca-1',
 evaluate:'delivery-evaluate-1',
 discover:'delivery-discover-1',
 investigate:'delivery-investigate-1',
 prepare:'delivery-prepare-1',
 qa:'delivery-qa-1',
} as const;

/** Descriptions passed verbatim to Jev as the `choice` question criteria and
 * used as the fallback recommendation text. They contain no task content. */
export const WORKFLOW_DESCRIPTIONS:Record<ExplicitWorkflow,string> = {
 recon:'Inspect first and report tested/inferred/unknown findings plus a recommended strategy, retaining no production changes.',
 test_first:'Write a failing behavior test first, then implement until it passes, then run focused checks.',
 checks_first:'Run the existing checks to inspect current behavior before changing anything; suited to setup and documentation work.',
 fmeca:'Analysis-only qualitative FMECA across UX, runtime, architecture and delivery: bounded high-impact failure modes with evidence labels, prevention-first mitigation, production observability and conditional residual risk; no production changes.',
 evaluate:'Analysis-only architecture validity review first (classification, simpler alternatives, removal/demotion proposals) then FMECA plus calibration, observability, over-engineering and incremental-delivery reality checks; no production changes.',
 discover:'Analysis-only requirements interview backed by the elicitation tool: research the repository first, record established claims with evidence, rank open questions by leverage with suggested answers, record contradictions and the readiness.assess result; no production changes.',
 investigate:'Analysis-only scientific-process experiment per handoff: state or resume a hypothesis, design the smallest refuting experiment, record the observation with raw evidence, and recommend the next experiment; never concludes Supported without supporting observations and makes no production changes.',
 prepare:'Analysis-only preparation first: research only what the graph slice and contract context name, reproduce or measure when cheap, and write brief.json plus brief.md with numbered understanding items, options and a recommendation so the manager can choose before any implementation; no production changes.',
 qa:'Report-only independent review of a prior deliverable from its result.json: compare acceptance with the complete tracked/staged/untracked changes and checks, report missing coverage and regressions with severity, file references and acceptance IDs; no production changes.',
};

/** The fixed common block, identical for every workflow. */
export const COMMON_PROMPT_BLOCK = [
 'Work in stages: inspect readiness, outline a brief approach, implement, verify with bounded repairs, and report evidence.',
 'If an assumption invalidates the contract, report a blocker rather than changing requirements.',
 'Whenever you create or change tests, use atomic scenarios with declarative names and exactly one behavioral assertion per test. Each test verifies one observable outcome of the deliverable through a public interface.',
 'Test capabilities and acceptance criteria, not private implementation details, incidental call sequences, internal data structures, or source-code text. Do not bundle unrelated assertions into a composite assertion to evade the one-assertion rule.',
 'Use a proportionate testing pyramid: many fast focused behavioral tests, fewer integration tests for real boundaries, and only essential end-to-end acceptance tests. Do not create tests at every layer by quota or duplicate the same behavior across layers.',
 'In TDD, express one required behavior, verify that its test fails for the intended missing behavior, implement the smallest correct change, then refactor while keeping it green. Preserve existing tests; apply these conventions to newly written or changed tests without unrelated suite rewrites.',
 'Implement this deliverable within its constraints. Run checks and report gaps. Do not commit or push.',
 'Restrict file reads and searches to the execution checkout and to context/dependency paths named in the task; stop and report a blocker instead of widening the search.',
 'Do not perform a broad filesystem search. This is an instruction, not a sandbox guarantee.',
].join('\n');

/** The fixed per-workflow blocks. Nothing here is generated by Jev. */
export const WORKFLOW_PROMPT_BLOCKS:Record<ExplicitWorkflow,string> = {
 recon:[
  'Workflow (recon): inspect the repository and report findings before any change.',
  'Classify every finding as tested, inferred, or unknown, and state the evidence for it.',
  'Evidence discipline: before labelling a claim tested/proven-here, open the cited file and quote the cited span (a few lines, with path:line) in the report; a claim whose span was not opened and quoted is labelled inferred, not proven-here. The report is a set of leads for the manager to verify, not findings.',
  'End with a recommended strategy for a follow-up run. The recommendation is not authorization to change production code.',
  'Keep experiments in the .delivery scratch directory and retain no production changes. This is an instruction, not a sandbox guarantee.',
 ].join('\n'),
 test_first:[
  'Workflow (test_first): write a failing behavior test for the requested behavior before implementing.',
  'Confirm the test fails for the expected reason, implement the smallest change that makes it pass, then run focused checks.',
 ].join('\n'),
 checks_first:[
  'Workflow (checks_first): run the existing checks to inspect current behavior before changing anything.',
  'This inspect-first template is the fallback for setup and documentation work.',
 ].join('\n'),
 fmeca:[
  'Workflow (fmeca): analysis-only qualitative risk review. Do not modify production code; removal or demotion of any component is a proposal only. This is an instruction to the worker, not a sandbox guarantee.',
  'Review failure modes across four domains: UX / user interaction, runtime behavior, technical architecture, and project / delivery design.',
  'Evidence discipline: before labelling a claim tested/proven-here, open the cited file and quote the cited span (a few lines, with path:line) in the report; a claim whose span was not opened and quoted is labelled inferred, not proven-here. Label every claim as tested/proven-here (cite the concrete file, function or test), adapted (a reasonable but unproven-here assumption) or speculation (unvalidated). Mark missing evidence as unknown; never fabricate specificity. The report is a set of leads for the manager to verify, not findings.',
  'Bounds: at most 3 iterations and 8-15 highest-impact failure modes where the scope warrants; do not invent failure modes to meet a quota. Stop early when no meaningful Severity or Probability reduction is possible, a constraint would be violated, or the deadline is reached, and report the honest unresolved outcome.',
  'Prioritize every High severity risk (including Low probability), then Medium. Mitigation order: prevention, then early detection, then fail-fast with actionable diagnostics. Use TRIZ only for a real trade-off and select one practical resolution principle. If the `triz` CLI is on PATH, `triz catalog` lists the principles offline; `triz analyze` is a paid classification call, so do not run it unless the contract authorizes it, and otherwise state the contradiction for the manager.',
  'For every failure mode include: domain, failure mode, cause, effect, qualitative Severity and Probability (Low/Medium/High), mitigation, justification for why it reduces risk, production observability (the metric/log/trace that reveals the failure), and residual Severity and Probability.',
  'Separate existing verified controls from proposed mitigation and state residual risk as conditional (what must hold). Proposing a fix does not eliminate a risk: keep the residual score unless the control is verified in this run. Preserve essential capabilities and explicit user constraints.',
 ].join('\n'),
 evaluate:[
  'Workflow (evaluate): analysis-only. Establish architecture validity first, then review risk. Do not modify production code; removal or demotion of any component is a proposal only. This is an instruction to the worker, not a sandbox guarantee.',
  'Phase 1 - architecture validity (before risk review): for each major component record purpose, classification (Essential, Useful, Speculative or Unjustified), justification, a simpler alternative, the risk if removed, and evidence level (tested/proven-here, adapted or speculation). Propose a revised architecture (retained, simplified, removed, demoted); removal and demotion are proposals only.',
  'Phase 2 - risk review: apply the fmeca discipline across UX / user interaction, runtime behavior, technical architecture and project / delivery design. For every failure mode include domain, failure mode, cause, effect, qualitative Severity and Probability (Low/Medium/High), mitigation, justification, production observability, and residual Severity and Probability. Separate existing verified controls from proposed mitigation and state residual risk as conditional. Proposing a fix does not eliminate a risk.',
  'Phase 3 - reality check: explicitly assess calibration risk (are confidence or scoring signals trustworthy, and how will they be validated), observability risk (can bad decisions, incorrect extraction, premature completion and policy regressions be detected in production), over-engineering risk (does complexity exceed demonstrated value; what is the simplest viable version) and incremental-delivery risk (can this be built in phases with clean migration and rollback).',
  'Bounds and evidence discipline: at most 3 iterations and 8-15 highest-impact failure modes where the scope warrants; do not invent failure modes to meet a quota. Stop early on no improvement, a constraint violation or the deadline and report the honest unresolved outcome. Prioritize every High severity risk (including Low probability), then Medium; mitigation order prevention, then early detection, then fail-fast. Use TRIZ only for a real trade-off. If the `triz` CLI is on PATH, `triz catalog` lists the principles offline; `triz analyze` is a paid classification call, so do not run it unless the contract authorizes it, and otherwise state the contradiction for the manager. Before labelling a claim tested/proven-here, open the cited file and quote the cited span (a few lines, with path:line) in the report; a claim whose span was not opened and quoted is labelled inferred, not proven-here. Label evidence tested/proven-here (with concrete file/function/test), adapted or speculation; mark unknown rather than fabricate. The report is a set of leads for the manager to verify, not findings. Preserve essential capabilities and explicit user constraints.',
 ].join('\n'),
 discover:[
  'Workflow (discover): requirements interview backed by the elicitation tool. Do not modify production code. This is an instruction to the worker, not a sandbox guarantee.',
  'Research the repository first and record what you can establish as claims with app_research evidence. Never invent user answers.',
  'Open or resume an elicitation session (session_id = the contract id) through the Junior CLI: `junior tools call <hop> elicitation <request.json>`, where `<hop>` is the hop handoff path stated in this prompt. When the contract does not supply hopFrom, still produce the report and state that the tool session was not recorded.',
  'Write analysis-report.md with: the established claims and their evidence; the open questions ranked by leverage (from question.next), each with a suggested answer and why; the contradictions found; and the readiness.assess result.',
 ].join('\n'),
 investigate:[
  'Workflow (investigate): one scientific-process experiment per handoff. Do not modify production code. This is an instruction to the worker, not a sandbox guarantee.',
  'State or resume the hypothesis (session_id = the contract id) through the Junior CLI: `junior tools call <hop> scientific-process <request.json>`, where `<hop>` is the hop handoff path stated in this prompt. When the contract does not supply hopFrom, still produce the report and state that the tool session was not recorded.',
  'Design the smallest experiment that could refute the hypothesis, run it in the .delivery scratch area, and record the observation with raw evidence through the same scientific-process tool call.',
  'Never conclude Supported without supporting observations; a hypothesis with no supporting observation is unresolved. Write analysis-report.md with the hypothesis, experiment, prediction, observation, evidence, and the recommended next experiment or conclusion.',
 ].join('\n'),
 prepare:[
  'Workflow (prepare): do the legwork first and check back before acting. Do not modify production code. This is an instruction to the worker, not a sandbox guarantee.',
  'Research only what the graph slice and contract context supplied in this prompt name; do not widen the search beyond them.',
  'Reproduce or measure when that is cheap and safe; otherwise label the claim inferred.',
  'Write brief.json to the artifact directory with the schema: understanding.scope/outOfScope/assumptions (each assumption status verified or guess, with path:line evidence when verified)/acceptanceProof; options with id, title, approach, files, effort (optimistic/likely/pessimistic), risks and tradeoffs (plus adrNotes and a drafted plan path when relevant); and a recommendation naming the option and why.',
  'Write brief.md with the numbered U and A items first, then the options. The handback is needs_choice until brief.json exists.',
 ].join('\n'),
 qa:[
  'Workflow (qa): report-only independent review of a prior deliverable. Do not modify production code, commit, push, repair, or start nested workers or paid calls. This is an instruction to the worker, not a sandbox guarantee.',
  'Review only the grounded context provided: the prior result, the original prompt/contract evidence and the complete tracked, staged and untracked change evidence. Do not load the full transcript by default.',
  'Compare every acceptance criterion in the original contract with the complete change evidence and the prior independent check results. Identify missing behavioral coverage and regressions, not just restate the implementer summary.',
  'For every finding state the severity (High/Medium/Low), the concrete file reference and the affected acceptance ID, the evidence, and the recommended check that would confirm or refute it.',
  'Separate confirmed findings from uncertainties. State what you could not verify and the exact follow-up check needed.',
  'The report is a completed review, not an acceptance decision and not authorization to fix. Do not claim the deliverable is accepted and do not perform remediation.',
 ].join('\n'),
};

export function taskWorkflow(t:any):Workflow {
 const w=t?.workflow;
 return w === 'recon' || w === 'test_first' || w === 'checks_first' || w === 'fmeca' || w === 'evaluate' || w === 'discover' || w === 'investigate' || w === 'prepare' || w === 'qa' || w === 'auto' ? w : 'auto';
}

export type WorkflowDecision = {
 /** What the contract asked for (explicit value or `auto`). */
 requested:Workflow;
 selected:ExplicitWorkflow;
 source:'explicit'|'choice'|'default';
 recommended:ExplicitWorkflow|null;
 confidence:number|null;
 note?:string;
};

/** Read a Jev `choice` answer for the workflow question. */
export function choiceVerdict(answer:any):{choice:ExplicitWorkflow|null; confidence:number|null} {
 if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string') return {choice:null, confidence:null};
 const choice=(EXPLICIT_WORKFLOWS as readonly string[]).includes(answer.choice) ? answer.choice as ExplicitWorkflow : null;
 const confidence=typeof answer.confidence === 'number' && Number.isFinite(answer.confidence) ? answer.confidence : null;
 return {choice, confidence};
}

/** The contract parts Jev can name as least clear on a clarify. */
export const CONTRACT_PARTS = ['deliverable','acceptance','constraints','checks','context'] as const;
export type ContractPart = typeof CONTRACT_PARTS[number];
/** One fixed sentence per part, used as the `contract_part` choice criteria. */
export const CONTRACT_PART_DESCRIPTIONS: Record<ContractPart,string> = {
 deliverable: 'The deliverable itself is least clear or rests on an unstated assumption.',
 acceptance: 'The acceptance criteria are least clear or rest on an unstated assumption.',
 constraints: 'The constraints are least clear or rest on an unstated assumption.',
 checks: 'The independent checks are least clear or rest on an unstated assumption.',
 context: 'The provided context is least clear or rests on an unstated assumption.',
};

/** Read a Jev `choice` answer for the contract-part question. */
export function contractPartVerdict(answer:any):{name:ContractPart|null; probability:number|null} {
 if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string') return {name:null, probability:null};
 const name=(CONTRACT_PARTS as readonly string[]).includes(answer.choice) ? answer.choice as ContractPart : null;
 const probability=typeof answer.confidence === 'number' && Number.isFinite(answer.confidence) ? answer.confidence : null;
 return {name, probability};
}

/** Render one part of the readiness state as the text Junior sent to Jev. */
function contractPartText(state:{deliverable:any; acceptance:string[]; constraints:string[]; checks:{command:string;args?:string[]}[]; context:any}, name:ContractPart):string {
 if (name === 'deliverable') return typeof state.deliverable === 'string' ? state.deliverable : String(state.deliverable ?? '');
 if (name === 'acceptance') return (Array.isArray(state.acceptance) ? state.acceptance : []).join('; ');
 if (name === 'constraints') return (Array.isArray(state.constraints) ? state.constraints : []).join('; ');
 if (name === 'checks') return (Array.isArray(state.checks) ? state.checks : [])
  .map((c)=>[c?.command, ...(Array.isArray(c?.args) ? c.args : [])].filter((v)=>typeof v === 'string' && v.length > 0).join(' '))
  .filter(Boolean).join('; ');
 return (Array.isArray(state.context) ? state.context : [])
  .map((c)=>typeof c === 'string' ? c : String(c?.path ?? ''))
  .filter(Boolean).join('; ');
}

/** Build the deterministic clarify detail for a contract part: the named part,
 * its bounded excerpt, and at least one template question that quotes it. */
export function clarifyDetail(state:{deliverable:any; acceptance:string[]; constraints:string[]; checks:{command:string;args?:string[]}[]; context:any}, part:{name:ContractPart|null; probability:number|null}):{part:{name:ContractPart; probability:number|null}; excerpt:string; questions:string[]} {
 const name=part.name ?? 'acceptance';
 const excerpt=contractPartText(state,name).slice(0,600);
 const subject=excerpt || `the ${name} part of the contract`;
 const templates:Record<ContractPart,string>={
  deliverable:`What exactly must the deliverable contain that this description leaves unstated: ${subject}?`,
  acceptance:`Which of these acceptance criteria can't be checked as written: ${subject}?`,
  constraints:`Which of these constraints is incomplete or conflicts with the deliverable: ${subject}?`,
  checks:`Which of these checks would not catch the failure this contract cares about: ${subject}?`,
  context:`Which of these context paths is missing or insufficient to implement the contract: ${subject}?`,
 };
 return {part:{name, probability:part.probability}, excerpt, questions:[templates[name]]};
}

/** Resolve the workflow from the explicit contract, otherwise from a Jev choice
 * answer, otherwise deterministically to the inspect-first `checks_first`. */
export function decideWorkflow(t:any, workflowAnswer:any, classifier:boolean, classifierError?:string):WorkflowDecision {
 const requested=taskWorkflow(t);
 if (requested !== 'auto') return {requested, selected:requested, source:'explicit', recommended:null, confidence:null};
 if (!classifier) return {requested, selected:'checks_first', source:'default', recommended:'checks_first', confidence:null,
  note: classifierError ? `classifier unavailable (${classifierError}); defaulted to inspect-first checks_first` : 'no Jev classifier for auto workflow; defaulted to inspect-first checks_first'};
 const v=choiceVerdict(workflowAnswer);
 if (v.choice && v.confidence !== null && v.confidence >= CONFIDENCE_THRESHOLD) {
  return {requested, selected:v.choice, source:'choice', recommended:v.choice, confidence:v.confidence};
 }
 if (v.choice) return {requested, selected:'checks_first', source:'default', recommended:v.choice, confidence:v.confidence,
  note:'workflow recommendation below confidence threshold; defaulted to inspect-first checks_first'};
 return {requested, selected:'checks_first', source:'default', recommended:'checks_first', confidence:null,
  note:'classifier returned no usable workflow choice; defaulted to inspect-first checks_first'};
}
