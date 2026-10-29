// Receipt parsing and estimated execution cost.
//
// Extracted from worker.ts without behavior change (ADR 0015 R7 seam X2). The
// `pi --mode json` JSONL event stream is aggregated into a verifiable receipt,
// and a separate estimate is derived only from observed usage plus explicit
// task pricing. Pi's catalog cost and any authoritative captured bill stay
// distinct from that estimate.
//
// The `Usage`/`Receipt` types remain in worker.ts (seam X1 owns that range), so
// they are imported here as types only: this module has no runtime dependency
// on worker.ts.

import type { BillingCapture } from './billing.ts';
import { type Receipt, type ReceiptModelSource, type Usage } from './worker-contract.ts';

/** Shared finite-number coercion, also used by worker.ts and the gate modules. */
export const num=(v:any)=>typeof v==='number' && Number.isFinite(v) ? v : 0;

export function emptyUsage():Usage {
 return {input:0,output:0,cacheRead:0,cacheWrite:0,cacheWrite1h:0,reasoning:0,totalTokens:0,
  available:false,
  cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0,available:false}};
}

/** Sum authoritative assistant `message_end` usage into `total`; exported so a
 * multi-segment run can aggregate its segment receipts. */
export function addUsage(total:Usage, u:any) {
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

/** At most this many malformed line numbers are retained; the running total
 * lives in `malformedCount` so a flood of bad lines cannot bloat the receipt. */
export const MALFORMED_LINE_LIMIT = 20;

function recordMalformed(receipt:Receipt, lineNumber:number):void {
 receipt.malformedCount++;
 if (receipt.malformedLines.length < MALFORMED_LINE_LIMIT) receipt.malformedLines.push(lineNumber);
}

/** Parse the `pi --mode json` JSONL event stream into a verifiable receipt.
 * Aggregation uses only authoritative assistant `message_end` records; turn_end,
 * agent_end and cumulative message_update usage are intentionally ignored.
 * When the captured output was cut by the accumulation cap, a non-blank final
 * line that is not valid JSON is reported as `truncatedTail`, not as a
 * malformed line. */
export function parseReceipt(eventsText:string, requested:{provider?:string;model?:string;source?:ReceiptModelSource} = {}, opts:{outputTruncated?:boolean} = {}):Receipt {
 const receipt:Receipt = {
  source:'pi_message_end',
  requested:{provider:requested.provider || 'unknown', model:requested.model || 'unknown',
   ...(requested.source ? {source:requested.source} : {})},
  sessionId:null,
  observed:[],
  observedUnknown:true,
  responseIds:[],
  generations:[],
  usage:emptyUsage(),
  assistantMessages:0,
  messageEnds:0,
  stopReasons:[],
  errored:false,
  aborted:false,
  settled:false,
  malformed:false,
  malformedLines:[],
  malformedCount:0,
  finalStopReason:null,
  recoveredErrors:0,
  outputLimited:false,
  truncatedTail:false,
  outputTruncated:!!opts.outputTruncated,
 };
 const seen = new Set<string>();
 // Stop reason per assistant message in stream order (null when Pi reported
 // none), used to decide recovery and the final outcome.
 const assistantStops:(string|null)[]=[];
 // Strict JSONL framing: split on LF only and strip an optional trailing CR.
 const lines = String(eventsText ?? '').split('\n');
 // Locate the last non-blank line so a cap-cut final record can be recognized.
 let lastContentIndex = -1;
 for (let i=lines.length-1;i>=0;i--) { if (lines[i].trim()) { lastContentIndex=i; break; } }
 for (let i=0;i<lines.length;i++) {
  let raw = lines[i];
  if (raw.endsWith('\r')) raw = raw.slice(0,-1);
  if (!raw.trim()) continue;
  let ev:any;
  try { ev = JSON.parse(raw); }
  catch {
   if (opts.outputTruncated && i === lastContentIndex) { receipt.truncatedTail = true; continue; }
   recordMalformed(receipt, i+1);
   continue;
  }
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) { recordMalformed(receipt, i+1); continue; }
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
  const responseId = typeof m.responseId === 'string' && m.responseId.trim() ? m.responseId.trim() : null;
  receipt.generations.push({ provider, model, responseId });
  if (responseId && !receipt.responseIds.includes(responseId)) receipt.responseIds.push(responseId);
  if (typeof m.stopReason === 'string') {
   receipt.stopReasons.push(m.stopReason);
   if (m.stopReason === 'aborted') receipt.aborted = true;
  }
  assistantStops.push(typeof m.stopReason === 'string' ? m.stopReason : null);
  addUsage(receipt.usage, m.usage);
 }
 // A transient error/length stop is recovered when a later assistant message
 // follows; only a final error invalidates the run, and a final length stop is
 // surfaced as outputLimited so it can drive a continuation instead.
 const lastStop = assistantStops.length ? assistantStops[assistantStops.length-1] : null;
 receipt.finalStopReason = lastStop;
 receipt.recoveredErrors = assistantStops.filter((s,i)=>i < assistantStops.length-1 && (s==='error'||s==='length')).length;
 receipt.outputLimited = lastStop === 'length';
 receipt.errored = lastStop === 'error';
 receipt.malformed = receipt.malformedCount > 0;
 receipt.observedUnknown = receipt.observed.length === 0;
 return receipt;
}

/** A mock run performs no Pi execution, so it claims no observed model. */
export function mockReceipt(requested:{provider?:string;model?:string;source?:ReceiptModelSource} = {}):Receipt {
 return {
  source:'mock',
  requested:{provider:requested.provider || 'unknown', model:requested.model || 'unknown',
   ...(requested.source ? {source:requested.source} : {})},
  sessionId:null,
  observed:[],
  observedUnknown:true,
  responseIds:[],
  generations:[],
  usage:emptyUsage(),
  assistantMessages:0,
  messageEnds:0,
  stopReasons:[],
  errored:false,
  aborted:false,
  settled:false,
  malformed:false,
  malformedLines:[],
  malformedCount:0,
  finalStopReason:null,
  recoveredErrors:0,
  outputLimited:false,
  truncatedTail:false,
 };
}

/** A receipt is only trustworthy when the stream parsed, at least one assistant
 * message completed, the assistant turns completed cleanly, and Pi reported
 * agent_settled. A settled stream with no assistant message is not a receipt. */
export function receiptValid(r:Receipt) {
 return r.source === 'pi_message_end' && r.assistantMessages > 0 && !r.malformed && !r.errored && !r.aborted && !r.outputLimited && r.settled && !r.outputTruncated && !r.truncatedTail;
}

// ---------------------------------------------------------------------------
// Estimated execution cost
//
// Pi's `usage.cost` is a catalog estimate reported by Pi, not a bill. When a
// task opts in to bounded OpenRouter billing capture, the authoritative summed
// `total_cost` is merged into `billedUsd`; otherwise it stays null. A separate
// estimate is computed only from independently observed token usage and explicit
// per-million-token task pricing; absent verified pricing the estimate is
// unknown, never a free zero.
// ---------------------------------------------------------------------------

export const PRICING_RATES = ['input','output','cacheRead','cacheWrite'] as const;
export type PricingRate = typeof PRICING_RATES[number];

export type CostEstimate = {
 /** Estimated USD from explicit task pricing and observed usage; null = unknown. */
 estimatedUsd:number|null;
 pricingSource:string|null;
 pricingDate:string|null;
 /** Authoritative captured provider bill (finite nonnegative USD), else null.
  * Never carries a Pi catalog estimate. */
 billedUsd:number|null;
 /** Concise, non-sensitive reason the authoritative bill is unavailable. */
 billingReason?:string;
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
 * multiple, or a nonzero usage bucket lacks a rate. An optional captured
 * billing result only sets `billedUsd`/`billingReason`; it never changes the
 * estimate and is never promoted from the estimate. */
export function estimateCost(receipt:Receipt, pricing:any, billing?:BillingCapture|null):CostEstimate {
 const out:CostEstimate = {
  estimatedUsd:null,
  pricingSource: pricing && typeof pricing.source === 'string' ? pricing.source : null,
  pricingDate: pricing && typeof pricing.date === 'string' ? pricing.date : null,
  billedUsd:null,
  piReported: receipt.usage.cost,
 };
 if (billing && typeof billing.billedUsd === 'number' && Number.isFinite(billing.billedUsd) && billing.billedUsd >= 0) out.billedUsd = billing.billedUsd;
 else if (billing?.reason) out.billingReason = billing.reason;
 const finish=(o:CostEstimate)=>{ if (out.billedUsd !== null) o.billedUsd = out.billedUsd; else if (out.billingReason) o.billingReason = out.billingReason; return o; };
 if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return finish({...out, unknownReason:'no verified task pricing supplied'});
 if (!receipt.usage.available) return finish({...out, unknownReason:'usage unavailable'});
 if (receipt.observed.length > 1) return finish({...out, unknownReason:'multiple observed models'});
 const only = receipt.observed[0];
 if (!only || only.provider === 'unknown' || only.model === 'unknown') return finish({...out, unknownReason:'observed model unknown'});
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
   return finish({...out, unknownReason:`missing pricing.${key} for nonzero usage`});
  }
  const r = typeof rate === 'number' && Number.isFinite(rate) ? rate : 0;
  total += (tokens / 1e6) * r;
 }
 return finish({...out, estimatedUsd:total});
}
