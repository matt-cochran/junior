// ---------------------------------------------------------------------------
// Optional bounded authoritative OpenRouter generation billing capture.
//
// Pi's `usage.cost` is a catalog estimate, not a bill. When a task opts in with
// `billing: { mode: "openrouter" }`, the worker may look up each preserved
// `message.responseId` generation against OpenRouter's documented endpoint
// `GET https://openrouter.ai/api/v1/generation?id=<responseId>` and capture the
// authoritative `data.total_cost`.
//
// The lookup is opt-in and never runs for mock runs or runs without the config.
// It is bounded by the task's remaining deadline and the configured timeout,
// performs at most one request per unique generation id, never retries, and
// never exposes credentials, request headers, raw provider bodies or raw
// errors. Billing is an optional observation: an unavailable lookup leaves the
// primary run outcome untouched and records a concise reason instead.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The only supported billing mode. */
export const BILLING_MODES = ['openrouter'] as const;
export type BillingMode = typeof BILLING_MODES[number];

/** Official documented generation lookup endpoint. */
export const BILLING_ENDPOINT = 'https://openrouter.ai/api/v1/generation';
/** Upper bound accepted for `billing.timeoutMs`. */
export const BILLING_MAX_TIMEOUT_MS = 600000;
/** Default per-run billing budget when `timeoutMs` is omitted. */
export const BILLING_DEFAULT_TIMEOUT_MS = 10000;
/** Upper bound on unique generation ids looked up in one run. */
export const BILLING_MAX_GENERATIONS = 100;

export type BillingConfig = { mode: BillingMode; timeoutMs?: number };

/** Strict validation of the opt-in `billing` contract object. Unknown keys and
 * unknown modes are rejected before any paid call. */
export function validateBilling(b: any): void {
 if (!b || typeof b !== 'object' || Array.isArray(b)) throw Error('Invalid billing');
 for (const k of Object.keys(b)) if (k !== 'mode' && k !== 'timeoutMs') throw Error(`Unknown billing field: ${k}`);
 if (!BILLING_MODES.includes(b.mode)) throw Error('Invalid billing.mode (expected openrouter)');
 if (b.timeoutMs !== undefined) {
  if (typeof b.timeoutMs !== 'number' || !Number.isFinite(b.timeoutMs) || b.timeoutMs <= 0 || b.timeoutMs > BILLING_MAX_TIMEOUT_MS) {
   throw Error(`Invalid billing.timeoutMs (expected a finite positive number up to ${BILLING_MAX_TIMEOUT_MS})`);
  }
 }
}

/** One assistant generation preserved from the Pi event stream. `responseId`
 * is null when Pi did not report one for an OpenRouter message. */
export type BillingGeneration = { provider: string; model: string; responseId: string | null };
/** The receipt fields billing needs, kept structural so billing has no
 * dependency on the worker module. */
export type BillingReceipt = {
 generations?: BillingGeneration[];
 observed?: { provider: string; model: string }[];
 responseIds?: string[];
};

export type BillingResponse = { ok: boolean; status: number; json: () => Promise<any> };
export type BillingFetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<BillingResponse>;

export type BillingDeps = {
 /** Injected network seam. Tests always supply this; live runs default to the
  * global `fetch`. */
 fetch?: BillingFetch;
 /** Injected credential seam. Receives no arguments and returns a key or null.
  * The resolved key is never logged. */
 resolveApiKey?: () => string | null | Promise<string | null>;
 /** Injected clock for deterministic bounding. */
 now?: () => number;
};

export type BillingCapture = {
 /** Authoritative summed `total_cost`, or null when any generation could not
  * be accounted for. Zero is a valid captured bill. */
 billedUsd: number | null;
 /** Only `provider` when every generation was accounted for. */
 source: 'provider' | null;
 /** Concise, non-sensitive reason when `billedUsd` is null. */
 reason?: string;
 /** Number of unique generation ids selected for lookup. */
 generationCount: number;
 /** Number successfully captured before any failure. */
 capturedCount: number;
};

const REASONS = {
 notEnabled: 'billing not enabled',
 noGenerations: 'no OpenRouter generations to bill',
 mixedProviders: 'mixed providers; cannot capture one authoritative OpenRouter bill',
 missingId: 'OpenRouter generation missing a response id',
 missingModel: 'OpenRouter generation missing an observed model',
 tooMany: `more than ${BILLING_MAX_GENERATIONS} unique generations`,
 noKey: 'no OpenRouter API key available',
 deadline: 'billing lookup deadline exceeded',
 timeout: 'billing lookup timed out',
 requestFailed: 'generation lookup request failed',
 badResponse: 'generation lookup returned an unreadable response',
 idMismatch: 'generation lookup id mismatch',
 modelMismatch: 'generation lookup model mismatch',
 invalidCost: 'generation lookup total_cost missing or invalid',
} as const;

function fail(reason: string, generationCount = 0, capturedCount = 0): BillingCapture {
 return { billedUsd: null, source: null, reason, generationCount, capturedCount };
}

function finiteNonnegative(v: any): v is number {
 return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** Race `p` against an absolute deadline. The timer is unref'd so a completed
 * lookup never holds the process open. */
function withDeadline<T>(p: Promise<T>, endAt: number, now: () => number): Promise<T> {
 const remaining = endAt - now();
 if (remaining <= 0) return Promise.reject(Error('deadline'));
 return new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('deadline')), remaining);
  p.then(
   (v) => { clearTimeout(timer); resolve(v); },
   (e) => { clearTimeout(timer); reject(e); },
  );
 });
}

/** Environment-only fallback credential resolution. The live worker supplies a
 * Pi SDK AuthStorage-backed resolver instead. Never returns or logs more than
 * the key string itself, and never throws on a malformed auth file. */
export function resolveApiKeyFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | null {
 const value = env.OPENROUTER_API_KEY;
 return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Read the stored OpenRouter credential from a Pi `auth.json` directly. This
 * mirrors the SDK AuthStorage shape (`api_key`/`api` with `key`, or `oauth`
 * with `access`) and is exported for the worker's SDK-backed resolver fallback. */
export function readOpenRouterAuthFile(authPath: string, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): string | null {
 try {
  const parsed = JSON.parse(readFile(authPath));
  const c = parsed?.openrouter;
  if (!c || typeof c !== 'object') return null;
  if ((c.type === 'api_key' || c.type === 'api') && typeof c.key === 'string' && c.key.trim()) return c.key.trim();
  if (c.type === 'oauth' && typeof c.access === 'string' && c.access.trim()) return c.access.trim();
 } catch { /* absent, unreadable or malformed auth is simply no key */ }
 return null;
}

/** Resolve the Pi agent auth path from the environment, matching the setup
 * module's rules (`PI_CODING_AGENT_DIR`, else `~/.pi/agent/auth.json`). */
export function openRouterAuthPath(env: NodeJS.ProcessEnv = process.env): string {
 const home = env.HOME || env.USERPROFILE || '';
 const dir = env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent');
 return join(dir, 'auth.json');
}

/** Environment-then-auth.json resolver used when no SDK-backed resolver is
 * supplied. Bounded by the caller's deadline through `captureBilling`. */
export function resolveOpenRouterApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
 const fromEnv = resolveApiKeyFromEnvironment(env);
 if (fromEnv) return fromEnv;
 const authPath = openRouterAuthPath(env);
 if (!existsSync(authPath)) return null;
 return readOpenRouterAuthFile(authPath);
}

/** Select the unique OpenRouter generations or return the decisive failure.
 * Exhaustive accounting is required: any missing id, unknown model, mixed
 * provider, or excessive id count refuses the bill. */
function selectGenerations(receipt: BillingReceipt): { ids: string[]; modelById: Map<string, string> } | BillingCapture {
 const generations = Array.isArray(receipt?.generations)
  ? receipt.generations
  : (Array.isArray(receipt?.responseIds) ? receipt.responseIds.map((id) => ({
     provider: receipt.observed?.[0]?.provider ?? 'unknown',
     model: receipt.observed?.[0]?.model ?? 'unknown',
     responseId: id,
    })) : []);
 if (!generations.length) return fail(REASONS.noGenerations);
 if (generations.some((g) => g.provider !== 'openrouter')) {
  // A run that used any other provider is not an OpenRouter-only bill.
  return generations.some((g) => g.provider === 'openrouter') ? fail(REASONS.mixedProviders) : fail(REASONS.noGenerations);
 }
 if (generations.some((g) => !g.responseId)) return fail(REASONS.missingId);
 if (generations.some((g) => !g.model || g.model === 'unknown')) return fail(REASONS.missingModel);
 const ids: string[] = [];
 const modelById = new Map<string, string>();
 for (const g of generations) {
  const id = g.responseId as string;
  if (!/^gen-[A-Za-z0-9_-]+$/.test(id)) return fail(REASONS.missingId);
  if (modelById.has(id) && modelById.get(id) !== g.model) return fail(REASONS.modelMismatch);
  if (!modelById.has(id)) { ids.push(id); modelById.set(id, g.model); }
 }
 if (ids.length > BILLING_MAX_GENERATIONS) return fail(REASONS.tooMany, ids.length);
 return { ids, modelById };
}

/** Look up authoritative OpenRouter generation billing, bounded by the task's
 * remaining deadline and the configured timeout. At most one request is made
 * per unique generation id and there are no retries. Any incomplete accounting
 * returns `billedUsd: null` with a concise reason; a complete lookup returns the
 * summed `total_cost` with `source: 'provider'`. */
export async function captureBilling(
 receipt: BillingReceipt,
 config: BillingConfig,
 budget: { timeoutMs: number; deadlineAt: number },
 deps: BillingDeps = {},
): Promise<BillingCapture> {
 if (!config || config.mode !== 'openrouter') return fail(REASONS.notEnabled);
 const now = deps.now ?? (() => Date.now());
 const selected = selectGenerations(receipt ?? {});
 if ('billedUsd' in selected && 'generationCount' in selected) return selected;
 const { ids, modelById } = selected;

 const remaining = budget.deadlineAt - now();
 if (remaining <= 0) return fail(REASONS.deadline, ids.length);
 const endAt = now() + Math.max(1, Math.min(budget.timeoutMs, remaining));

 let key: string | null;
 try {
  const resolver = deps.resolveApiKey ?? (() => resolveOpenRouterApiKey());
  key = await withDeadline(Promise.resolve().then(() => resolver()), endAt, now);
 } catch {
  return fail(REASONS.deadline, ids.length);
 }
 if (!key) return fail(REASONS.noKey, ids.length);

 const doFetch: BillingFetch = deps.fetch ?? ((url, init) => (globalThis.fetch as any)(url, init));
 let sum = 0;
 let captured = 0;
 for (const id of ids) {
  if (endAt - now() <= 0) return fail(REASONS.deadline, ids.length, captured);
  // One request per unique id, bounded by the remaining total budget. On
  // timeout the request is aborted and no second attempt is made.
  const controller = new AbortController();
  const outcome = await new Promise<{ response?: BillingResponse; timeout: boolean; failed: boolean }>((resolve) => {
   let settled = false;
   const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    controller.abort();
    resolve({ timeout: true, failed: false });
   }, Math.max(1, endAt - now()));
    doFetch(`${BILLING_ENDPOINT}?id=${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: controller.signal,
   }).then(
    (response) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ response, timeout: false, failed: false }); } },
    () => { if (!settled) { settled = true; clearTimeout(timer); resolve({ timeout: controller.signal.aborted, failed: true }); } },
   );
  });
  if (outcome.timeout || (outcome.failed && controller.signal.aborted)) return fail(REASONS.timeout, ids.length, captured);
  const response = outcome.response;
  if (!response || response.ok !== true) return fail(REASONS.requestFailed, ids.length, captured);
  let body: any;
  try { body = await withDeadline(Promise.resolve().then(() => response.json()), endAt, now); } catch { controller.abort(); return fail(endAt <= now() ? REASONS.timeout : REASONS.badResponse, ids.length, captured); }
  const data = body?.data;
  if (!data || data.id !== id) return fail(REASONS.idMismatch, ids.length, captured);
  if (data.model !== modelById.get(id)) return fail(REASONS.modelMismatch, ids.length, captured);
  if (!finiteNonnegative(data.total_cost)) return fail(REASONS.invalidCost, ids.length, captured);
  sum += data.total_cost;
  if (!Number.isFinite(sum)) return fail(REASONS.invalidCost, ids.length, captured);
  captured++;
 }
 return { billedUsd: sum, source: 'provider', generationCount: ids.length, capturedCount: captured };
}
