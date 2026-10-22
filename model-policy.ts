// ---------------------------------------------------------------------------
// Junior model policy.
//
// Junior must only ever execute on commodity / open-weight models and never on
// a frontier model. This module resolves a provider/model pair to a vendor and
// classifies it as 'commodity', 'frontier', or 'unknown'. Classification is
// pure and offline, case-insensitive, and fails closed: anything that is not a
// recognized commodity vendor is refused rather than attempted.
// ---------------------------------------------------------------------------

export type ModelClass = 'commodity' | 'frontier' | 'unknown';

export interface ModelVerdict {
  provider: string;
  id: string;
  vendor: string | null;
  class: ModelClass;
  reason: string;
}

/** Vendors whose open-weight models Junior may execute on. */
export const COMMODITY_VENDORS: readonly string[] = [
  'deepseek',
  'moonshotai',
  'z-ai',
  'qwen',
  'minimax',
  'meta-llama',
];

/** Vendors whose models Junior must never execute on. */
export const FRONTIER_VENDORS: readonly string[] = ['anthropic', 'openai', 'google', 'x-ai', 'xai'];

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function isFrontierVendor(vendor: string): boolean {
  return FRONTIER_VENDORS.includes(vendor);
}

function isCommodityVendor(vendor: string): boolean {
  return COMMODITY_VENDORS.includes(vendor);
}

/** The model name after any `vendor/` id prefix, lowercased. */
function modelName(id: string): string {
  const slash = id.indexOf('/');
  return normalize(slash >= 0 ? id.slice(slash + 1) : id);
}

/**
 * Resolve the vendor for a provider/model pair, or null when none can be
 * determined. An aggregator id segment before the first '/' names the vendor,
 * with one leading floating-alias '~' removed. For a direct provider the
 * provider name is the vendor (zai normalizes to z-ai), but an id that itself
 * carries a `vendor/` prefix wins.
 */
export function modelVendor(provider: string, id: string): string | null {
  const normalizedProvider = normalize(provider);
  const rawId = (id ?? '').trim();
  const slash = rawId.indexOf('/');
  if (slash > 0) {
    const prefix = normalize(rawId.slice(0, slash));
    const vendor = prefix.startsWith('~') ? prefix.slice(1) : prefix;
    return vendor.length > 0 ? vendor : null;
  }
  if (slash === 0 || normalizedProvider === '' || AGGREGATOR_PROVIDERS.includes(normalizedProvider)) return null;
  if (normalizedProvider === 'zai') return 'z-ai';
  return normalizedProvider;
}

/** Providers that route to many vendors; only for these does the id's
 * `vendor/` prefix decide the vendor. A direct provider is itself the host.
 * `litellm` is a Pi custom provider pointing at a LiteLLM proxy (ADR-0007), so
 * its ids must carry a `vendor/` prefix. */
export const AGGREGATOR_PROVIDERS: readonly string[] = ['openrouter', 'litellm'];

/** Classify a provider/model pair as commodity, frontier, or unknown. */
export function classifyModel(provider: string, id: string): ModelVerdict {
  const normalizedProvider = (provider ?? '').trim();
  const normalizedId = (id ?? '').trim();
  const vendor = modelVendor(normalizedProvider, normalizedId);
  const base = { provider: normalizedProvider, id: normalizedId, vendor };

  // A direct provider hosts the request whatever the id says, so a frontier
  // or unrecognized host is refused even when the id names a commodity vendor.
  const host = normalize(normalizedProvider) === 'zai' ? 'z-ai' : normalize(normalizedProvider);
  if (host !== '' && !AGGREGATOR_PROVIDERS.includes(host) && host !== vendor) {
    if (isFrontierVendor(host)) return { ...base, class: 'frontier', reason: `provider '${host}' is a frontier host` };
    return { ...base, class: 'unknown', reason: `provider '${host}' does not host vendor '${vendor}' models as a recognized commodity provider` };
  }

  if (normalizedProvider === '' || normalizedId === '' || vendor === null) {
    return {
      ...base,
      class: 'unknown',
      reason: `cannot determine a vendor for provider '${normalizedProvider}' id '${normalizedId}'`,
    };
  }

  if (vendor === 'openai' && modelName(normalizedId).startsWith('gpt-oss')) {
    return {
      ...base,
      class: 'commodity',
      reason: `vendor 'openai' model 'gpt-oss*' is open-weight and treated as commodity`,
    };
  }

  if (isFrontierVendor(vendor)) {
    return { ...base, class: 'frontier', reason: `vendor '${vendor}' is a frontier vendor` };
  }

  if (vendor === 'typesafe') {
    return {
      ...base,
      class: 'unknown',
      reason: `vendor 'typesafe' hosts Jev, a classifier, not an executor`,
    };
  }

  if (isCommodityVendor(vendor)) {
    return { ...base, class: 'commodity', reason: `vendor '${vendor}' is a recognized commodity vendor` };
  }

  return { ...base, class: 'unknown', reason: `vendor '${vendor}' is not a recognized commodity vendor` };
}

/** Whether a provider/model pair is eligible as a Junior executor. */
export function isCommodity(provider: string, id: string): boolean {
  return classifyModel(provider, id).class === 'commodity';
}

export class ModelPolicyError extends Error {
  code: 'frontier_model_refused' | 'unknown_model_refused';
  verdict: ModelVerdict;

  constructor(code: 'frontier_model_refused' | 'unknown_model_refused', verdict: ModelVerdict) {
    super(`${code}: provider/id '${verdict.provider}/${verdict.id}' refused (${verdict.class})`);
    this.name = 'ModelPolicyError';
    this.code = code;
    this.verdict = verdict;
  }
}

/**
 * Return the verdict when the pair is a commodity executor and throw a
 * ModelPolicyError otherwise. Frontier refusal and unknown refusal carry
 * distinct codes so the caller can distinguish them.
 */
export function assertCommodity(provider: string, id: string): ModelVerdict {
  const verdict = classifyModel(provider, id);
  if (verdict.class === 'commodity') return verdict;
  const code = verdict.class === 'frontier' ? 'frontier_model_refused' : 'unknown_model_refused';
  throw new ModelPolicyError(code, verdict);
}
