import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { doctor, init, loadDefaults } from './setup.ts';

export function validate(t: any) {
 for (const k of ['id','deliverable','cwd']) if (typeof t[k] !== 'string' || !t[k].trim()) throw Error(`Missing ${k}`);
 if (!/^[a-zA-Z0-9_-]+$/.test(t.id)) throw Error('Invalid id');
 if (!Array.isArray(t.acceptance) || !t.acceptance.length || t.acceptance.some((x:any)=>typeof x !== 'string' || !x.trim())) throw Error('Missing acceptance');
 if (!Array.isArray(t.checks) || !t.checks.length) throw Error('Missing checks');
 for (const c of t.checks) if (typeof c.command !== 'string' || !Array.isArray(c.args) || c.args.some((x:any)=>typeof x !== 'string')) throw Error('Invalid check');
 if (t.pricing !== undefined && t.pricing !== null) validatePricing(t.pricing);
 if (t.workflow !== undefined && !['recon','test_first','checks_first','auto'].includes(t.workflow)) throw Error('Invalid workflow (expected recon, test_first, checks_first or auto)');
 if (t.resumeFrom !== undefined && (typeof t.resumeFrom !== 'string' || !t.resumeFrom.trim())) throw Error('Invalid resumeFrom (expected path to a prior result.json)');
 if (t.jev !== undefined) {
  if (!t.jev || typeof t.jev !== 'object' || Array.isArray(t.jev)) throw Error('Invalid jev config');
  if (t.jev.mode !== undefined && !['off','shadow','enforce'].includes(t.jev.mode)) throw Error('Invalid jev.mode (expected off, shadow or enforce)');
 }
 return t;
}

export type Usage = {
 input:number; output:number; cacheRead:number; cacheWrite:number;
 cacheWrite1h:number; reasoning:number; totalTokens:number;
 /** True only when at least one authoritative message_end reported usage. */
 available:boolean;
 cost:{
  input:number;output:number;cacheRead:number;cacheWrite:number;total:number;
  /** True only when a message_end reported a numeric cost. `available:false`
   * means cost is unknown, not that it was free. */
  available:boolean;
 };
};

export type ObservedPair = { provider:string; model:string };

export type Receipt = {
 /** Where the metadata came from. Pi-reported, never independent upstream attestation. */
 source:'pi_message_end' | 'mock';
 requested:{ provider:string; model:string };
 sessionId:string | null;
 observed:ObservedPair[];
 observedUnknown:boolean;
 usage:Usage;
 assistantMessages:number;
 messageEnds:number;
 stopReasons:string[];
 errored:boolean;
 aborted:boolean;
 settled:boolean;
 malformed:boolean;
 malformedLines:number[];
};

export function emptyUsage():Usage {
 return {input:0,output:0,cacheRead:0,cacheWrite:0,cacheWrite1h:0,reasoning:0,totalTokens:0,
  available:false,
  cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0,available:false}};
}

const num=(v:any)=>typeof v==='number' && Number.isFinite(v) ? v : 0;
const msg=(e:unknown)=>e instanceof Error ? e.message : String(e);

function addUsage(total:Usage, u:any) {
 if (!u || typeof u !== 'object') return;
 total.available = true;
 total.input += num(u.input);
 total.output += num(u.output);
 total.cacheRead += num(u.cacheRead);
 total.cacheWrite += num(u.cacheWrite);
 total.cacheWrite1h += num(u.cacheWrite1h);
 // reasoning is already included in output; recorded for visibility only.
 total.reasoning += num(u.reasoning);
 total.totalTokens += num(u.totalTokens);
 const c = u.cost && typeof u.cost === 'object' ? u.cost : null;
 // A cost object only counts when it carries at least one finite number, so an
 // empty `{}` cannot masquerade as a reported zero cost.
 const reported = !!c && ['input','output','cacheRead','cacheWrite','total'].some((k)=>typeof c[k]==='number' && Number.isFinite(c[k]));
 if (reported) {
  total.cost.available = true;
  total.cost.input += num(c.input);
  total.cost.output += num(c.output);
  total.cost.cacheRead += num(c.cacheRead);
  total.cost.cacheWrite += num(c.cacheWrite);
  total.cost.total += num(c.total);
 }
}

/** Parse the `pi --mode json` JSONL event stream into a verifiable receipt.
 * Aggregation uses only authoritative assistant `message_end` records; turn_end,
 * agent_end and cumulative message_update usage are intentionally ignored. */
export function parseReceipt(eventsText:string, requested:{provider?:string;model?:string} = {}):Receipt {
 const receipt:Receipt = {
  source:'pi_message_end',
  requested:{provider:requested.provider || 'unknown', model:requested.model || 'unknown'},
  sessionId:null,
  observed:[],
  observedUnknown:true,
  usage:emptyUsage(),
  assistantMessages:0,
  messageEnds:0,
  stopReasons:[],
  errored:false,
  aborted:false,
  settled:false,
  malformed:false,
  malformedLines:[],
 };
 const seen = new Set<string>();
 // Strict JSONL framing: split on LF only and strip an optional trailing CR.
 const lines = String(eventsText ?? '').split('\n');
 for (let i=0;i<lines.length;i++) {
  let raw = lines[i];
  if (raw.endsWith('\r')) raw = raw.slice(0,-1);
  if (!raw.trim()) continue;
  let ev:any;
  try { ev = JSON.parse(raw); }
  catch { receipt.malformedLines.push(i+1); continue; }
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) { receipt.malformedLines.push(i+1); continue; }
  if (ev.type === 'session') {
   if (receipt.sessionId === null && typeof ev.id === 'string' && ev.id.trim()) receipt.sessionId = ev.id;
   continue;
  }
  if (ev.type === 'agent_settled') { receipt.settled = true; continue; }
  if (ev.type !== 'message_end') continue;
  receipt.messageEnds++;
  const m = ev.message;
  if (!m || typeof m !== 'object' || m.role !== 'assistant') continue;
  receipt.assistantMessages++;
  const provider = typeof m.provider === 'string' && m.provider.trim() ? m.provider : 'unknown';
  const model = typeof m.model === 'string' && m.model.trim() ? m.model : 'unknown';
  const key = `${provider}\u0000${model}`;
  if (!seen.has(key)) { seen.add(key); receipt.observed.push({provider,model}); }
  if (typeof m.stopReason === 'string') {
   receipt.stopReasons.push(m.stopReason);
   if (m.stopReason === 'error') receipt.errored = true;
   if (m.stopReason === 'aborted') receipt.aborted = true;
  }
  addUsage(receipt.usage, m.usage);
 }
 receipt.malformed = receipt.malformedLines.length > 0;
 receipt.observedUnknown = receipt.observed.length === 0;
 return receipt;
}

/** A mock run performs no Pi execution, so it claims no observed model. */
export function mockReceipt(requested:{provider?:string;model?:string} = {}):Receipt {
 return {
  source:'mock',
  requested:{provider:requested.provider || 'unknown', model:requested.model || 'unknown'},
  sessionId:null,
  observed:[],
  observedUnknown:true,
  usage:emptyUsage(),
  assistantMessages:0,
  messageEnds:0,
  stopReasons:[],
  errored:false,
  aborted:false,
  settled:false,
  malformed:false,
  malformedLines:[],
 };
}

/** A receipt is only trustworthy when the stream parsed, at least one assistant
 * message completed, the assistant turns completed cleanly, and Pi reported
 * agent_settled. A settled stream with no assistant message is not a receipt. */
export function receiptValid(r:Receipt) {
 return r.source === 'pi_message_end' && r.assistantMessages > 0 && !r.malformed && !r.errored && !r.aborted && r.settled;
}

// ---------------------------------------------------------------------------
// Estimated execution cost
//
// Pi's `usage.cost` is a catalog estimate reported by Pi, not a bill. This
// worker never observes actual billing, so `billedUsd` is always null. A
// separate estimate is computed only from independently observed token usage
// and explicit per-million-token task pricing; absent verified pricing the
// estimate is unknown, never a free zero.
// ---------------------------------------------------------------------------

export const PRICING_RATES = ['input','output','cacheRead','cacheWrite'] as const;
export type PricingRate = typeof PRICING_RATES[number];

export type CostEstimate = {
 /** Estimated USD from explicit task pricing and observed usage; null = unknown. */
 estimatedUsd:number|null;
 pricingSource:string|null;
 pricingDate:string|null;
 /** Always null: actual billing is never observed by this worker. */
 billedUsd:null;
 /** Raw Pi catalog cost, kept separate from the estimate. */
 piReported:Usage['cost'];
 /** Why the estimate is unknown, when it is. */
 unknownReason?:string;
};

/** Validate optional explicit pricing. Rates are optional individually, but any
 * supplied rate must be a finite nonnegative number; `source` and `date` are
 * required so every estimate is attributable. */
export function validatePricing(p:any):void {
 if (!p || typeof p !== 'object' || Array.isArray(p)) throw Error('Invalid pricing');
 for (const k of PRICING_RATES) {
  const v = p[k];
  if (v === undefined) continue;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw Error(`Invalid pricing.${k} (expected finite nonnegative number)`);
 }
 for (const k of ['source','date']) {
  const v = p[k];
  if (typeof v !== 'string' || !v.trim()) throw Error(`Missing pricing.${k}`);
 }
}

/** Compute an estimated cost from independently observed usage and explicit
 * task pricing (USD per million tokens). Reasoning is excluded because Pi
 * already includes it in output tokens. The estimate is unknown (null) when
 * pricing is absent, usage is unavailable, the observed model is unknown or
 * multiple, or a nonzero usage bucket lacks a rate. */
export function estimateCost(receipt:Receipt, pricing:any):CostEstimate {
 const out:CostEstimate = {
  estimatedUsd:null,
  pricingSource: pricing && typeof pricing.source === 'string' ? pricing.source : null,
  pricingDate: pricing && typeof pricing.date === 'string' ? pricing.date : null,
  billedUsd:null,
  piReported: receipt.usage.cost,
 };
 if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return {...out, unknownReason:'no verified task pricing supplied'};
 if (!receipt.usage.available) return {...out, unknownReason:'usage unavailable'};
 if (receipt.observed.length > 1) return {...out, unknownReason:'multiple observed models'};
 const only = receipt.observed[0];
 if (!only || only.provider === 'unknown' || only.model === 'unknown') return {...out, unknownReason:'observed model unknown'};
 const buckets:[PricingRate,number][] = [
  ['input', receipt.usage.input],
  ['output', receipt.usage.output],
  ['cacheRead', receipt.usage.cacheRead],
  ['cacheWrite', receipt.usage.cacheWrite],
 ];
 let total = 0;
 for (const [key, tokens] of buckets) {
  const rate = pricing[key];
  if (tokens > 0 && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)) {
   return {...out, unknownReason:`missing pricing.${key} for nonzero usage`};
  }
  const r = typeof rate === 'number' && Number.isFinite(rate) ? rate : 0;
  total += (tokens / 1e6) * r;
 }
 return {...out, estimatedUsd:total};
}

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

export const EXPLICIT_WORKFLOWS = ['recon','test_first','checks_first'] as const;
export type ExplicitWorkflow = typeof EXPLICIT_WORKFLOWS[number];
export type Workflow = ExplicitWorkflow | 'auto';

/** Stable identifiers saved as artifacts so a run's prompt is reproducible. */
export const WORKFLOW_TEMPLATE_IDS = {
 common:'delivery-common-1',
 recon:'delivery-recon-1',
 test_first:'delivery-test-first-1',
 checks_first:'delivery-checks-first-1',
} as const;

/** Descriptions passed verbatim to Jev as the `choice` question criteria and
 * used as the fallback recommendation text. They contain no task content. */
export const WORKFLOW_DESCRIPTIONS:Record<ExplicitWorkflow,string> = {
 recon:'Inspect first and report tested/inferred/unknown findings plus a recommended strategy, retaining no production changes.',
 test_first:'Write a failing behavior test first, then implement until it passes, then run focused checks.',
 checks_first:'Run the existing checks to inspect current behavior before changing anything; suited to setup and documentation work.',
};

/** The fixed common block, identical for every workflow. */
export const COMMON_PROMPT_BLOCK = [
 'Work in stages: inspect readiness, outline a brief approach, implement, verify with bounded repairs, and report evidence.',
 'If an assumption invalidates the contract, report a blocker rather than changing requirements.',
 'Implement this deliverable within its constraints. Run checks and report gaps. Do not commit or push.',
].join('\n');

/** The fixed per-workflow blocks. Nothing here is generated by Jev. */
export const WORKFLOW_PROMPT_BLOCKS:Record<ExplicitWorkflow,string> = {
 recon:[
  'Workflow (recon): inspect the repository and report findings before any change.',
  'Classify every finding as tested, inferred, or unknown, and state the evidence for it.',
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
};

export function taskWorkflow(t:any):Workflow {
 const w=t?.workflow;
 return w === 'recon' || w === 'test_first' || w === 'checks_first' || w === 'auto' ? w : 'auto';
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

// ---------------------------------------------------------------------------
// Explicit Pi session continuation
//
// A task may set `resumeFrom` to a prior result.json. The worker validates the
// prior run (same resolved cwd, same requested provider/model, a valid prior Pi
// session ID) and then passes an explicit `--session <id>` to Pi. It never uses
// `--continue`. The new contract is appended to the prior session; a prior
// recon recommendation is not treated as approval to change production code.
// ---------------------------------------------------------------------------

/** Pi session IDs start and end with a letter or number. */
export const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export type ResumeInfo = {
 from:string;
 parentResult:{ path:string; artifactDir:string|null; status:string|null };
 parentSessionId:string;
 parentRequested:{ provider:string; model:string };
 parentWorkflow:string|null;
 sessionId:string;
};

function priorCwd(prior:any):string|null {
 if (prior && typeof prior.cwd === 'string' && prior.cwd.trim()) return resolve(prior.cwd);
 if (prior && typeof prior.artifactDir === 'string' && prior.artifactDir.trim()) {
  const normalized=prior.artifactDir.replace(/\\/g,'/');
  const idx=normalized.lastIndexOf('/.delivery/');
  if (idx > 0) return resolve(normalized.slice(0, idx));
 }
 return null;
}

export function resolveResume(prior:any, requested:{provider:string;model:string}, resolvedCwd:string, from:string):{ info?:ResumeInfo; error?:string } {
 if (!prior || typeof prior !== 'object' || Array.isArray(prior)) return {error:'resume prior result is not an object'};
 const receipt=prior.receipt;
 if (!receipt || typeof receipt !== 'object') return {error:'resume prior result has no receipt; cannot confirm a Pi session'};
 const sessionId=typeof receipt.sessionId === 'string' ? receipt.sessionId.trim() : '';
 if (!sessionId) return {error:'resume prior result has no Pi session ID'};
 if (!SESSION_ID_RE.test(sessionId)) return {error:`resume prior session ID is not valid: ${sessionId}`};
 const priorReq=receipt.requested && typeof receipt.requested === 'object' ? receipt.requested : null;
 if (!priorReq || typeof priorReq.provider !== 'string' || typeof priorReq.model !== 'string') return {error:'resume prior result has no requested provider/model'};
 if (priorReq.provider !== requested.provider || priorReq.model !== requested.model) {
  return {error:`resume provider/model mismatch (prior ${priorReq.provider}/${priorReq.model}, requested ${requested.provider}/${requested.model})`};
 }
 const cwd=priorCwd(prior);
 if (!cwd) return {error:'resume prior result has no resolved cwd to compare'};
 if (cwd !== resolvedCwd) return {error:`resume cwd mismatch (prior ${cwd}, requested ${resolvedCwd})`};
 const parentWorkflow=prior.workflow && typeof prior.workflow === 'object' ? (typeof prior.workflow.selected === 'string' ? prior.workflow.selected : null) : (typeof prior.workflow === 'string' ? prior.workflow : null);
 return {info:{
  from,
  parentResult:{ path:from, artifactDir:typeof prior.artifactDir === 'string' ? prior.artifactDir : null, status:typeof prior.status === 'string' ? prior.status : null },
  parentSessionId:sessionId,
  parentRequested:{ provider:priorReq.provider, model:priorReq.model },
  parentWorkflow,
  sessionId,
 }};
}

/** Resolve `resumeFrom` relative to the target checkout and validate it. */
export function loadResume(t:any, requested:{provider:string;model:string}, resolvedCwd:string):{ info?:ResumeInfo; error?:string } {
 if (typeof t.resumeFrom !== 'string' || !t.resumeFrom.trim()) return {};
 const path=resolve(resolvedCwd, t.resumeFrom);
 let raw:string;
 try { raw=readFileSync(path,'utf8'); } catch { return {error:`resumeFrom not readable: ${path}`}; }
 let prior:any;
 try { prior=JSON.parse(raw); } catch { return {error:`resumeFrom is not valid JSON: ${path}`}; }
 return resolveResume(prior, requested, resolvedCwd, path);
}

/** Build the fixed prompt blocks for a workflow. The only variable content is
 * the task contract JSON; no Jev-generated prose is inserted. */
export function promptParts(workflow:ExplicitWorkflow, resume?:ResumeInfo|null):{ common:string; workflow:string; resume:string|null } {
 let resumeBlock:string|null=null;
 if (resume) {
  resumeBlock=[
   `Resume context: this run continues the prior Pi session ${resume.sessionId}.`,
   'The new task contract below is appended to that session.',
   'Do not treat any prior recommendation as authorization to modify production code.',
  ].join('\n');
 }
 return {common:COMMON_PROMPT_BLOCK, workflow:WORKFLOW_PROMPT_BLOCKS[workflow], resume:resumeBlock};
}

export function buildPrompt(t:any, workflow:ExplicitWorkflow, resume?:ResumeInfo|null):string {
 const parts=promptParts(workflow, resume);
 const blocks=[parts.common, parts.workflow];
 if (parts.resume) blocks.push(parts.resume);
 blocks.push(`Task contract (JSON):\n${JSON.stringify(t)}`);
 return blocks.join('\n\n');
}

/** Build Pi argv for a run. Resume passes an explicit `--session <id>` and
 * never `--continue`, so continuation cannot silently pick the wrong session. */
export function buildPiArgs(requested:{provider:string;model:string}, sessionId?:string|null):string[] {
 const args=['--provider',requested.provider,'--model',requested.model,'--mode','json'];
 if (sessionId) args.push('--session',sessionId);
 return args;
}

// ---------------------------------------------------------------------------
// Optional Jev readiness/completion gates
//
// Jev is TypeSafe's classifier family. Gates never call a premium chat model;
// they ask a classifier typed yes/no questions. Gate failures are advisory:
// in `shadow` mode they are recorded only, in `enforce` mode they block
// readiness (worker_failed/checks_failed can never be upgraded by a gate).
// ---------------------------------------------------------------------------

export const DEFAULT_JEV = { provider:'openrouter', id:'typesafe/jev-1.13' };
/** Below this self-reported confidence a gate answer is uncertain. */
export const CONFIDENCE_THRESHOLD = 0.6;

export type JevMode = 'off'|'shadow'|'enforce';

export function jevMode(t:any):JevMode {
 const m = t?.jev?.mode;
 return m === 'shadow' || m === 'enforce' ? m : 'off';
}

export type GateQuestion = { type:'bool'|'choice'|'score'; instructions:string; criteria?:any };
export type GateAnswer = any;
export type GateClassifierResult = {
 provider?:string; model?:string;
 answers?:Record<string,GateAnswer>;
 usage?:any;
 stopReason?:string;
 errorMessage?:string;
 explicitModel?:boolean;
};
/** Injectable classifier seam. Tests supply offline mocks; live runs use the
 * installed Pi SDK (`modelRegistry.classify`). */
export type GateClassifier = (
 context:{ state:Record<string,unknown>; questions:Record<string,GateQuestion> },
 options?:{ signal?:AbortSignal },
)=>Promise<GateClassifierResult>;

export type GateUsage = {
 input:number; output:number; totalTokens:number;
 available:boolean;
 cost:{ total:number; available:boolean };
};

export type GitEvidence = { stat:string; diff:string; truncated:boolean; unavailable?:string };

export type JevPreflight = {
 status:'pass'|'block'|'uncertain';
 answers:Record<string,GateAnswer>;
 confidence:Record<string,number|null>;
 usage:GateUsage|null;
 reportedProvider?:string;
 reportedModel?:string;
 error?:string;
};

export type JevCriterion = {
 id:string; index:number; text:string;
 verdict:'met'|'gap'|'uncertain';
 probability:number|null;
 answer?:GateAnswer;
};

export type JevPostflight = {
 status:'pass'|'gaps'|'uncertain';
 criteria:JevCriterion[];
 answers:Record<string,GateAnswer>;
 /** Actionable acceptance criterion IDs for parent review. */
 gapIds:string[];
 uncertainIds:string[];
 usage:GateUsage|null;
 reportedProvider?:string;
 reportedModel?:string;
 error?:string;
};

export type JevGateRecord = {
 mode:JevMode;
 model:{ provider:string; id:string; explicit:boolean };
 attempted:boolean;
 enforced:boolean;
 skipped?:string;
 error?:string;
 preflight?:JevPreflight;
 postflight?:JevPostflight;
};

function normalizeGateUsage(u:any):GateUsage|null {
 if (!u || typeof u !== 'object') return null;
 const c = u.cost && typeof u.cost === 'object' ? u.cost : null;
 const costAvailable = !!c && typeof c.total === 'number' && Number.isFinite(c.total);
 return { input:num(u.input), output:num(u.output), totalTokens:num(u.totalTokens), available:true,
  cost:{ total: costAvailable ? num(c.total) : 0, available: costAvailable } };
}

function answerConfidence(a:GateAnswer):number|null {
 if (!a || typeof a !== 'object') return null;
 if (a.type === 'bool' && typeof a.probability === 'number' && Number.isFinite(a.probability)) return Math.max(a.probability, 1-a.probability);
 if (typeof a.confidence === 'number' && Number.isFinite(a.confidence)) return a.confidence;
 return null;
}

function boolVerdict(a:GateAnswer):{verdict:'true'|'false'|'uncertain'; probability:number|null} {
 if (!a || a.type !== 'bool' || typeof a.probability !== 'number' || !Number.isFinite(a.probability)) return {verdict:'uncertain',probability:null};
 const p = a.probability;
 if (p >= CONFIDENCE_THRESHOLD) return {verdict:'true',probability:p};
 if (p <= 1 - CONFIDENCE_THRESHOLD) return {verdict:'false',probability:p};
 return {verdict:'uncertain',probability:p};
}

/** Bounded representation of the target checkout's uncommitted work. */
export function boundedGitEvidence(cwd:string, maxChars=20000):GitEvidence {
 const opts = {cwd, encoding:'utf8' as const, timeout:30000, maxBuffer:32*1024*1024};
 const stat = spawnSync('git',['diff','--stat'],opts);
 const diff = spawnSync('git',['diff'],opts);
 const error = stat.error?.message || diff.error?.message;
 // A non-zero git exit (e.g. 128 outside a repository) is evidence that is
 // unavailable, not evidence of an empty diff.
 if (error || stat.status !== 0 || diff.status !== 0) {
  return boundEvidence(stat.stdout || '', diff.stdout || '', maxChars, error || 'git diff unavailable');
 }
 return boundEvidence(stat.stdout || '', diff.stdout || '', maxChars);
}

/** Pure, testable bounding so diff evidence cannot grow without limit. */
export function boundEvidence(statText:string, diffText:string, maxChars=20000, unavailable?:string):GitEvidence {
 const stat = String(statText ?? '').slice(0, 2000);
 let diff = String(diffText ?? '');
 let truncated = false;
 if (diff.length > maxChars) { diff = diff.slice(0, maxChars); truncated = true; }
 return { stat, diff, truncated, ...(unavailable ? {unavailable} : {}) };
}

/** Upper bound for a single classifier answer; a hung classifier cannot stall
 * a run indefinitely. Aborts the request and rejects the race. */
export const CLASSIFIER_TIMEOUT_MS = 45000;

async function invokeClassifier(
 classify:GateClassifier,
 state:Record<string,unknown>,
 questions:Record<string,GateQuestion>,
 timeoutMs:number=CLASSIFIER_TIMEOUT_MS,
):Promise<{ result?:GateClassifierResult; error?:string }> {
 const controller=new AbortController();
 let timer:ReturnType<typeof setTimeout>|undefined;
 const timeout=new Promise<never>((_resolve,reject)=>{
  timer=setTimeout(()=>{ controller.abort(); reject(new Error(`classifier timed out after ${timeoutMs}ms`)); }, timeoutMs);
 });
 try {
  const result = await Promise.race([
   classify({ state, questions }, { signal:controller.signal }),
   timeout,
  ]);
  if (!result || typeof result !== 'object') return { error:'classifier returned no result' };
  if (typeof result.stopReason === 'string' && result.stopReason !== 'stop') {
   return { result, error: result.errorMessage || `classifier stopReason=${result.stopReason}` };
  }
  if (result.errorMessage) return { result, error: result.errorMessage };
  if (!result.answers || typeof result.answers !== 'object') return { result, error:'classifier returned no answers' };
  return { result };
 } catch (e) {
  return { error: msg(e) };
 } finally {
  if (timer) clearTimeout(timer);
 }
}

/** Readiness gate: is the contract clear and free of unresolved assumptions? */
export async function assessPreflight(t:any, classify:GateClassifier, opts:{ workflowQuestion?:boolean; timeoutMs?:number } = {}):Promise<JevPreflight> {
 const state = {
  deliverable: t.deliverable,
  acceptance: t.acceptance,
  constraints: Array.isArray(t.constraints) ? t.constraints : [],
  checks: (t.checks || []).map((c:any)=>({ command:c.command, args:c.args })),
 };
 const questions:Record<string,GateQuestion> = {
  contract_clear: {
   type:'bool',
   instructions:'Is the contract (deliverable, acceptance criteria, constraints, checks) clear and unambiguous enough to implement without guessing?',
   criteria:{ true:'Clear and implementable', false:'Ambiguous or underspecified' },
  },
  blocking_assumptions: {
   type:'bool',
   instructions:'Does the contract leave unresolved assumptions that could change the implementation or make acceptance unreliable?',
   criteria:{ true:'Unresolved assumptions present', false:'No unresolved assumptions' },
  },
 };
 // `auto` asks exactly one Jev `choice` question, in the same readiness call.
 // The descriptions are fixed constants, not task or model prose.
 if (opts.workflowQuestion) {
  questions.workflow = {
   type:'choice',
   instructions:'Which deterministic workflow template should this delivery run use?',
   criteria:{ ...WORKFLOW_DESCRIPTIONS },
  };
 }
 const { result, error } = await invokeClassifier(classify, state, questions, opts.timeoutMs);
 const answers = result?.answers ?? {};
 const confidence:Record<string,number|null> = {};
 for (const k of Object.keys(questions)) confidence[k] = answerConfidence(answers[k]);
 const usage = normalizeGateUsage(result?.usage);
 const base = { answers, confidence, usage, reportedProvider:result?.provider, reportedModel:result?.model };
 // A gate error is not a pass or a definite block: it is uncertain.
 if (error) return { status:'uncertain', ...base, error };
 const clear = boolVerdict(answers.contract_clear);
 const assumptions = boolVerdict(answers.blocking_assumptions);
 if (clear.verdict === 'uncertain' || assumptions.verdict === 'uncertain') return { status:'uncertain', ...base };
 if (clear.verdict === 'true' && assumptions.verdict === 'false') return { status:'pass', ...base };
 return { status:'block', ...base };
}

/** Completion gate: is each acceptance criterion satisfied by independent
 * check results and bounded git diff evidence? */
export async function assessPostflight(t:any, classify:GateClassifier, checks:any[], git:GitEvidence, timeoutMs?:number):Promise<JevPostflight> {
 const criteria = (t.acceptance || []).map((text:string, index:number)=>({ id:`AC${index+1}`, index, text }));
 const questions:Record<string,GateQuestion> = {};
 for (const c of criteria) {
  questions[c.id] = {
   type:'bool',
   instructions:`Acceptance criterion ${c.id}: "${c.text}". Is it satisfied, based only on the independent check results and the bounded git diff evidence?`,
   criteria:{ true:'Satisfied', false:'Not satisfied' },
  };
 }
 const state = {
  deliverable: t.deliverable,
  acceptance: t.acceptance,
  constraints: Array.isArray(t.constraints) ? t.constraints : [],
  checks: (checks || []).map((c:any)=>({ command:c.command, args:c.args, exitCode:c.exitCode, passed:c.exitCode === 0 })),
  git: { stat:git.stat, diff:git.diff, truncated:git.truncated, unavailable:git.unavailable },
 };
 const { result, error } = await invokeClassifier(classify, state, questions, timeoutMs);
 const answers = result?.answers ?? {};
 const usage = normalizeGateUsage(result?.usage);
 const out:JevCriterion[] = criteria.map((c)=>{
  const v = boolVerdict(answers[c.id]);
  return { id:c.id, index:c.index, text:c.text,
   verdict: v.verdict === 'true' ? 'met' : v.verdict === 'false' ? 'gap' : 'uncertain',
   probability: v.probability, answer: answers[c.id] };
 });
 const gapIds = out.filter((c)=>c.verdict === 'gap').map((c)=>c.id);
 const uncertainIds = out.filter((c)=>c.verdict === 'uncertain').map((c)=>c.id);
 let status:'pass'|'gaps'|'uncertain';
 if (error) status = 'uncertain';
 else if (gapIds.length) status = 'gaps';
 else if (uncertainIds.length) status = 'uncertain';
 else status = 'pass';
 return { status, criteria:out, answers, gapIds, uncertainIds, usage, reportedProvider:result?.provider, reportedModel:result?.model, error };
}

/** Resolve the installed Pi SDK entry. Explicit path first (`PI_SDK_MODULE`,
 * then `PI_SDK_PATH`), then the global node_modules beside the running node,
 * then normal package resolution. No dependency install. */
async function loadPiSdk():Promise<any> {
 const explicit = process.env.PI_SDK_MODULE || process.env.PI_SDK_PATH;
 const candidates:string[] = [];
 if (explicit) candidates.push(explicit);
 candidates.push(pathToFileURL(join(dirname(process.execPath), '..', 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js')).href);
 candidates.push('@earendil-works/pi-coding-agent');
 let lastErr:unknown;
 for (const c of candidates) {
  try { return await import(c); } catch (e) { lastErr = e; }
 }
 throw Error(`Pi SDK could not be loaded. Set PI_SDK_MODULE to the installed SDK entry point. Last error: ${msg(lastErr)}`);
}

/** Build a live classifier backed by the installed Pi SDK. Uses
 * `modelRegistry.classify` with normal Pi AuthStorage; the classifier makes no
 * premium chat call. If the catalog lacks the entry, an explicit
 * `{ provider, id }` model is supplied (classify uses only those fields). */
export async function createPiClassifier(modelDef:{provider:string;id:string} = DEFAULT_JEV):Promise<GateClassifier> {
 const sdk = await loadPiSdk();
 const runtime = await sdk.ModelRuntime.create();
 const registry = new sdk.ModelRegistry(runtime);
 const { model, explicit } = resolveClassifierModel(registry, modelDef);
 const classifier:GateClassifier = async (context, options) => {
  const result:any = await registry.classify(model, context, options);
  return { ...result, explicitModel: explicit };
 };
 (classifier as any).explicitModel = explicit;
 return classifier;
}

/** Select a classifier catalog entry, falling back to an explicit
 * `{ provider, id }` model. `classify()` uses only those fields, so the
 * fallback works when the local catalog lacks the entry. */
export function resolveClassifierModel(registry:any, modelDef:{provider:string;id:string} = DEFAULT_JEV):{model:any; explicit:boolean} {
 const found = registry?.getModelOfType?.('classifier', modelDef.provider, modelDef.id);
 if (found) return { model:found, explicit:false };
 return { model:{ provider:modelDef.provider, id:modelDef.id }, explicit:true };
}

export type SpawnResult = { status:number|null; stdout?:string; stderr?:string; error?:Error };
export type GateDeps = {
 classify?:GateClassifier;
 git?:GitEvidence;
 /** Injectable Pi spawn seam for offline argv/prompt tests. */
 spawnPi?:(command:string, args:string[], options:any)=>SpawnResult;
 /** Override the bounded classifier timeout (default CLASSIFIER_TIMEOUT_MS). */
 classifierTimeoutMs?:number;
};

export async function run(t:any, mock=false, deps:GateDeps = {}) {
 validate(t);
 const cwd=resolve(t.cwd), dir=join(cwd,'.delivery',t.id,String(Date.now()));
 mkdirSync(dir,{recursive:true});
 const defaults=loadDefaults(cwd);
 const provider=typeof t.provider==='string' && t.provider.trim() ? t.provider : defaults.provider;
 const model=typeof t.model==='string' && t.model.trim() ? t.model : defaults.model;
 const requested={provider,model};
 const mode=jevMode(t);
 const jev:JevGateRecord|undefined = mode === 'off' ? undefined : {
  mode,
  model:{ provider:DEFAULT_JEV.provider, id:DEFAULT_JEV.id, explicit:false },
  attempted:false,
  enforced:false,
 };

 // Resolve an explicit continuation before spending any classifier or worker cost.
 let resume:ResumeInfo|undefined;
 if (typeof t.resumeFrom === 'string' && t.resumeFrom.trim()) {
  const loaded=loadResume(t, requested, cwd);
  if (loaded.error) {
   const blocked:any={ id:t.id, simulated:mock, status:'needs_review', workerExitCode:null,
    workerError:`resumeFrom rejected: ${loaded.error}`, checks:[], artifactDir:dir,
    resume:{ from:resolve(cwd,t.resumeFrom), error:loaded.error } };
   writeFileSync(join(dir,'result.json'),JSON.stringify(blocked,null,2));
   return blocked;
  }
  resume=loaded.info;
 }

 // Resolve the classifier for the readiness gate before any worker is started.
 let classify:GateClassifier|undefined = deps.classify;
 if (mode !== 'off' && !classify) {
  if (mock) {
   jev!.skipped = 'mock run without an injected classifier';
  } else {
   try {
    classify = await createPiClassifier(jev!.model);
    if ((classify as any).explicitModel) jev!.model.explicit = true;
   } catch (e) {
    jev!.error = `classifier unavailable: ${msg(e)}`;
   }
  }
 }

 // Preflight (readiness) gate runs before the worker. `auto` runs exactly one
 // extra Jev choice question inside this call.
 const explicitWorkflow=taskWorkflow(t);
 if (mode !== 'off' && classify) {
  jev!.attempted = true;
  const preflight = await assessPreflight(t, classify, { workflowQuestion: explicitWorkflow === 'auto', timeoutMs: deps.classifierTimeoutMs });
  jev!.preflight = preflight;
  if (preflight.error) jev!.error = preflight.error;
 }

 // Workflow selection is deterministic and kept separate from gate status.
 const classifierRan = mode !== 'off' && !!classify && !!jev!.preflight && !jev!.preflight.error;
 let decision = decideWorkflow(t, jev?.preflight?.answers?.workflow, classifierRan, jev?.error || jev?.preflight?.error);
 // A prior recon recommendation is never an automatic approval to change code.
 if (resume && resume.parentWorkflow === 'recon' && decision.selected === 'test_first' && explicitWorkflow === 'auto') {
  decision = {...decision, selected:'checks_first', source:'default', recommended:'test_first',
   note:'prior run was recon; test_first requires an explicit workflow in the new contract'};
 }
 const templates={ common:WORKFLOW_TEMPLATE_IDS.common, workflow:WORKFLOW_TEMPLATE_IDS[decision.selected] };
 writeFileSync(join(dir,'workflow.json'),JSON.stringify({ promptTemplateId:WORKFLOW_TEMPLATE_IDS.common, common:templates.common, selected:decision.selected, workflowTemplateId:templates.workflow, decision },null,2));

 // Enforce preflight: block before spending worker cost.
 if (mode === 'enforce' && (!jev!.preflight || jev!.preflight.status !== 'pass')) {
  jev!.enforced = true;
  const preReceipt = mock ? mockReceipt(requested) : undefined;
  const blocked:any={ id:t.id, simulated:mock, status:'needs_review', workerExitCode:null,
   workerError:'Jev preflight did not pass; worker not started.', receipt:preReceipt,
   cost: preReceipt ? estimateCost(preReceipt, t.pricing) : undefined,
   checks:[], artifactDir:dir, jev, workflow:decision, templates };
  writeFileSync(join(dir,'result.json'),JSON.stringify(blocked,null,2));
  return blocked;
 }

 const prompt=buildPrompt(t, decision.selected, resume);
 writeFileSync(join(dir,'prompt.txt'),prompt);
 const spawnPi = deps.spawnPi ?? spawnSync;
 const worker:any=mock ? {status:0,stdout:'Simulation only; no implementation performed.',stderr:''} : spawnPi('pi',[...buildPiArgs(requested, resume?.parentSessionId ?? null),prompt],{cwd,encoding:'utf8',timeout:600000,maxBuffer:33554432});
 const stdout=worker.stdout || '', stderr=worker.stderr || '';
 if (!mock) {
  // Keep stream and diagnostics separate so malformed JSONL is auditable.
  writeFileSync(join(dir,'events.jsonl'),stdout);
  writeFileSync(join(dir,'worker.log'),stderr);
 }
 const receipt=mock ? mockReceipt(requested) : parseReceipt(stdout,requested);
 const receiptOk=mock || receiptValid(receipt);
 const workerRan=mock || (worker.status === 0 && receiptOk);
 const checks=worker.status !== 0 || !receiptOk ? [] : t.checks.map((c:any,i:number)=>{
  const r=spawnSync(c.command,c.args,{cwd,encoding:'utf8',timeout:120000,maxBuffer:8388608});
  writeFileSync(join(dir,`check-${i}.log`),`${r.stdout || ''}\n${r.stderr || ''}`);
  return {...c,exitCode:r.status,error:r.error?.message};
 });
 let workerError=worker.error?.message;
 if (!workerError && worker.status !== 0) workerError=String(stderr).includes('No API key found for openrouter') ? 'OpenRouter authentication missing. Start pi and use /login to configure OpenRouter, then retry.' : 'Pi failed; inspect worker.log.';
 if (!workerError && !receiptOk) workerError = receipt.malformed ? 'Pi event stream contained malformed JSONL; inspect events.jsonl.' : receipt.errored || receipt.aborted ? 'Pi assistant message did not complete cleanly.' : receipt.assistantMessages === 0 ? 'Pi settled with no assistant messages.' : 'Pi never reported agent_settled; inspect events.jsonl.';
 let status=worker.status !== 0 ? 'worker_failed' : !receiptOk ? 'receipt_failed' : checks.some((c:any)=>c.exitCode !== 0) ? 'checks_failed' : mock ? 'simulation_passed' : 'ready_for_review';

 // Postflight (completion) gate runs against the independent checks and diff.
 if (mode !== 'off' && classify && workerRan) {
  const git = deps.git ?? boundedGitEvidence(cwd);
  const postflight = await assessPostflight(t, classify, checks, git, deps.classifierTimeoutMs);
  jev!.postflight = postflight;
  if (postflight.error) jev!.error = postflight.error;
 }

 // Enforce can only downgrade an otherwise-passing run; it never upgrades
 // worker/checks failures.
 if (mode === 'enforce' && (status === 'simulation_passed' || status === 'ready_for_review')) {
  const bad = !jev!.preflight || jev!.preflight.status !== 'pass' || !jev!.postflight || jev!.postflight.status !== 'pass';
  if (bad) { status = 'needs_review'; jev!.enforced = true; }
 }

 const result:any={id:t.id,simulated:mock,status,workerExitCode:worker.status,workerError,receipt,cost:estimateCost(receipt,t.pricing),checks,artifactDir:dir,workflow:decision,templates};
 result.cache={ reuse:'best effort', guaranteed:false,
  note:'Pi session/prompt cache reuse is best effort and never guaranteed. Observed cacheRead counters and requested/observed model stay in the receipt; no actual billing is claimed.' };
 if (resume) result.resume={ from:resume.from, parentResult:resume.parentResult, parentSessionId:resume.parentSessionId,
  parentWorkflow:resume.parentWorkflow, sessionId:receipt.sessionId || resume.parentSessionId, requested };
 if (mode !== 'off') result.jev=jev;
 writeFileSync(join(dir,'result.json'),JSON.stringify(result,null,2));
 return result;
}
export function status(path:string) {
 let raw:string;
 try { raw=readFileSync(path,'utf8'); } catch { throw Error(`Cannot read result file: ${path}`); }
 let result:any;
 try { result=JSON.parse(raw); } catch { throw Error(`Invalid JSON in result file: ${path}`); }
 if (!result || typeof result!=='object' || Array.isArray(result)) throw Error('Malformed result: expected an object');
 if (typeof result.id!=='string' || !result.id.trim()) throw Error('Malformed result: missing id');
 if (typeof result.status!=='string' || !result.status.trim()) throw Error('Malformed result: missing status');
 if (!Array.isArray(result.checks)) throw Error('Malformed result: missing checks');
 if (typeof result.artifactDir!=='string' || !result.artifactDir.trim()) throw Error('Malformed result: missing artifactDir');
 const out:any={id:result.id,outcome:result.status,checks:result.checks,artifactDir:result.artifactDir};
 // Old result files have no receipt; expose it only when present.
 if (result.receipt && typeof result.receipt === 'object') out.receipt=result.receipt;
 // Estimated cost is optional and only present on results that carry it.
 if (result.cost && typeof result.cost === 'object') out.cost=result.cost;
 // Jev gate records are optional and only present for jev-enabled tasks.
 if (result.jev && typeof result.jev === 'object') out.jev=result.jev;
 // Workflow selection, template IDs, continuation and cache note are optional.
 if (result.workflow && typeof result.workflow === 'object') out.workflow=result.workflow;
 if (result.templates && typeof result.templates === 'object') out.templates=result.templates;
 if (result.resume && typeof result.resume === 'object') out.resume=result.resume;
 if (result.cache && typeof result.cache === 'object') out.cache=result.cache;
 return out;
}
if (process.argv[1]?.endsWith('/worker.ts')) {
 try {
 const argv=process.argv.slice(2);
 const command=argv[0];
 if (command==='doctor') {
 const result=doctor();
 console.log(JSON.stringify(result,null,2));
 if (!result.ok) process.exitCode=1;
 } else if (command==='init') {
 const result=init({}, {install:argv.includes('--install')});
 console.log(JSON.stringify(result,null,2));
 if (result.install && !result.install.ok) process.exitCode=1;
 } else {
 const path=argv[1], flag=argv[2];
 if (!path || !['validate','run','status'].includes(command)) throw Error('Usage: node worker.ts doctor | init [--install] | validate|run|status task.json [--mock]');
 if (command==='status') {
 const result=status(path);
 console.log(JSON.stringify(result,null,2));
 } else {
 const t=validate(JSON.parse(readFileSync(path,'utf8')));
 const result=command==='validate' ? {valid:true,id:t.id} : await run(t,flag==='--mock');
 console.log(JSON.stringify(result,null,2));
 if(result.status && !['simulation_passed','ready_for_review'].includes(result.status)) process.exitCode=1;
 }
 }
 } catch(e) {console.error(String(e));process.exitCode=1;}
}
