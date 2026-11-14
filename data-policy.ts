// ---------------------------------------------------------------------------
// Data-destination policy (ADR 0017).
//
// `models.dataPolicy` constrains who processes a model request and where. The
// policy is validated before any paid call (R1), mapped to OpenRouter's
// provider routing object (R2), and carried on every path that can express it
// (R3). Region allow-lists are resolved here to an explicit provider `only`
// list because OpenRouter has no region request field (R2, R4).
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type DataCollection = 'allow' | 'deny';
export type UncoveredPath = 'typesafe' | 'companions';

/** ADR 0017 R1: the validated `models.dataPolicy` document. */
export interface DataPolicy {
  dataCollection?: DataCollection;
  zdr?: boolean;
  providers?: {
    only?: string[];
    ignore?: string[];
  };
  /** ISO 3166-1 alpha-2 country codes (two upper-case letters). */
  regions?: string[];
  allowFallbacks?: boolean;
  allowUncovered?: UncoveredPath[];
}

const POLICY_FIELDS = new Set([
  'dataCollection',
  'zdr',
  'providers',
  'regions',
  'allowFallbacks',
  'allowUncovered',
]);
const PROVIDER_FIELDS = new Set(['only', 'ignore']);
const UNCOVERED_PATHS: readonly UncoveredPath[] = ['typesafe', 'companions'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function policyError(field: string, expected: string): Error {
  return new Error(`models.dataPolicy.${field} ${expected}`);
}

function validateStringList(field: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw policyError(field, 'must be an array of strings');
  }
  return [...value];
}

/** Validate one raw `models.dataPolicy` value (ADR 0017 R1). */
function validatePolicy(raw: unknown): DataPolicy {
  if (!isRecord(raw)) throw new Error('models.dataPolicy must be an object');
  for (const key of Object.keys(raw)) {
    if (!POLICY_FIELDS.has(key)) throw policyError(key, 'is not a recognized field');
  }

  const out: DataPolicy = {};

  if (raw.dataCollection !== undefined) {
    if (raw.dataCollection !== 'allow' && raw.dataCollection !== 'deny') {
      throw policyError('dataCollection', "must be 'allow' or 'deny'");
    }
    out.dataCollection = raw.dataCollection;
  }

  if (raw.zdr !== undefined) {
    if (typeof raw.zdr !== 'boolean') throw policyError('zdr', 'must be a boolean');
    out.zdr = raw.zdr;
  }

  if (raw.allowFallbacks !== undefined) {
    if (typeof raw.allowFallbacks !== 'boolean') throw policyError('allowFallbacks', 'must be a boolean');
    out.allowFallbacks = raw.allowFallbacks;
  }

  if (raw.regions !== undefined) {
    if (!Array.isArray(raw.regions) || raw.regions.some((region) => typeof region !== 'string' || !/^[A-Z]{2}$/.test(region))) {
      throw policyError('regions', 'must be an array of two upper-case letter country codes');
    }
    out.regions = [...raw.regions];
  }

  if (raw.allowUncovered !== undefined) {
    if (!Array.isArray(raw.allowUncovered) || raw.allowUncovered.some((entry) => !UNCOVERED_PATHS.includes(entry as UncoveredPath))) {
      throw policyError('allowUncovered', "must contain only 'typesafe' or 'companions'");
    }
    out.allowUncovered = [...raw.allowUncovered] as UncoveredPath[];
  }

  if (raw.providers !== undefined) {
    if (!isRecord(raw.providers)) throw policyError('providers', 'must be an object');
    for (const key of Object.keys(raw.providers)) {
      if (!PROVIDER_FIELDS.has(key)) throw policyError(`providers.${key}`, 'is not a recognized field');
    }
    const only = validateStringList('providers.only', raw.providers.only);
    const ignore = validateStringList('providers.ignore', raw.providers.ignore);
    out.providers = {};
    if (only !== undefined) out.providers.only = only;
    if (ignore !== undefined) out.providers.ignore = ignore;
  }

  return out;
}

/** Read and validate `models.dataPolicy` from `<root>/delivery.config.json`.
 * Returns null when the policy is absent (ADR 0017 R1). */
export function readDataPolicy(root: string): DataPolicy | null {
  const path = join(root, 'delivery.config.json');
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed) || !isRecord(parsed.models)) return null;
  const raw = parsed.models.dataPolicy;
  if (raw === undefined) return null;
  return validatePolicy(raw);
}

/**
 * Map a validated policy to OpenRouter's `provider` request object (ADR 0017
 * R2). A resolved region allow-list replaces `providers.only`; an empty list
 * is preserved so preflight can fail closed (R4). `allow_fallbacks` defaults
 * to false whenever a policy exists.
 */
export function toRoutingPreferences(policy: DataPolicy, resolvedOnly?: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (policy.dataCollection !== undefined) out.data_collection = policy.dataCollection;
  if (policy.zdr === true) out.zdr = true;
  const only = resolvedOnly !== undefined ? resolvedOnly : policy.providers?.only;
  if (only !== undefined) out.only = [...only];
  if (policy.providers?.ignore !== undefined) out.ignore = [...policy.providers.ignore];
  out.allow_fallbacks = policy.allowFallbacks ?? false;
  return out;
}

export interface RegionResolutionDeps {
  fetch: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
}

export interface RegionResolution {
  /** Endpoint tags whose provider datacenters all lie in the allowed regions. */
  only: string[];
  /** Matched providers that expose no datacenter data at all. */
  unresolved: string[];
}

/** Accept both `[...]` and OpenRouter's `{data: ...}` envelopes, including
 * the endpoints response whose payload is `{data: {endpoints: [...]}}`. */
function rows(body: unknown, nested?: string): Record<string, unknown>[] {
  const candidates: unknown[] = [body];
  if (isRecord(body)) {
    candidates.push(body.data);
    if (nested) candidates.push(body[nested]);
    if (isRecord(body.data)) {
      candidates.push(body.data[nested ?? '']);
      candidates.push(body.data.endpoints);
    }
  }
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

function fetchCache(deps: RegionResolutionDeps): Map<string, Promise<unknown>> {
  const key = deps as object;
  let cache = regionCaches.get(key);
  if (!cache) {
    cache = new Map();
    regionCaches.set(key, cache);
  }
  return cache;
}

const regionCaches = new WeakMap<object, Map<string, Promise<unknown>>>();

async function cachedJson(url: string, deps: RegionResolutionDeps): Promise<unknown> {
  const cache = fetchCache(deps);
  let pending = cache.get(url);
  if (!pending) {
    pending = (async () => {
      const response = await deps.fetch(url);
      if (!response.ok) throw new Error(`data policy metadata request failed for ${url}`);
      return response.json();
    })();
    cache.set(url, pending);
  }
  return pending;
}

function providerFor(endpoint: Record<string, unknown>, providers: Record<string, unknown>[]): Record<string, unknown> | undefined {
  const name = endpoint.provider_name;
  const tag = endpoint.tag;
  if (typeof name === 'string') {
    const byName = providers.find((provider) => provider.name === name);
    if (byName) return byName;
  }
  if (typeof tag === 'string') {
    return providers.find((provider) => {
      const slug = provider.slug;
      return typeof slug === 'string' && (tag === slug || tag.startsWith(`${slug}/`));
    });
  }
  return undefined;
}

/**
 * Resolve a region allow-list to OpenRouter provider tags (ADR 0017 R2). Reads
 * the model's endpoints and the provider directory through the injected fetch,
 * caching both per deps object. A matched provider with no datacenter data is
 * reported in `unresolved`; the caller fails closed when no tag survives (R4).
 */
export async function resolveRegionProviders(
  model: string,
  regions: string[],
  deps: RegionResolutionDeps,
): Promise<RegionResolution> {
  const endpointsUrl = `https://openrouter.ai/api/v1/models/${model}/endpoints`;
  const providersUrl = 'https://openrouter.ai/api/v1/providers';
  const [endpointsBody, providersBody] = await Promise.all([
    cachedJson(endpointsUrl, deps),
    cachedJson(providersUrl, deps),
  ]);
  const endpoints = rows(endpointsBody, 'endpoints');
  const providers = rows(providersBody, 'providers');
  const only: string[] = [];
  const unresolved: string[] = [];

  for (const endpoint of endpoints) {
    const tag = endpoint.tag;
    if (typeof tag !== 'string') continue;
    const provider = providerFor(endpoint, providers);
    if (!provider) continue;
    const datacenters = Array.isArray(provider.datacenters)
      ? provider.datacenters.filter((code): code is string => typeof code === 'string')
      : [];
    if (datacenters.length === 0) {
      const name = typeof provider.name === 'string'
        ? provider.name
        : (typeof provider.slug === 'string' ? provider.slug : tag);
      if (!unresolved.includes(name)) unresolved.push(name);
      continue;
    }
    if (datacenters.every((code) => regions.includes(code)) && !only.includes(tag)) only.push(tag);
  }

  return { only, unresolved };
}

function cloneJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Return a copy of a Pi `models.json` document whose OpenRouter provider
 * carries `compat.openRouterRouting` (ADR 0017 R3). Every other field is kept.
 */
export function applyRoutingToModelsJson(modelsJson: unknown, routing: Record<string, unknown>): Record<string, unknown> {
  const cloned = cloneJson(modelsJson);
  const doc: Record<string, unknown> = isRecord(cloned) ? cloned : {};
  const providers = isRecord(doc.providers) ? doc.providers : (doc.providers = {});
  const openrouter = isRecord(providers.openrouter) ? providers.openrouter : (providers.openrouter = {});
  const compat = isRecord(openrouter.compat) ? openrouter.compat : (openrouter.compat = {});
  compat.openRouterRouting = routing;
  return doc;
}
