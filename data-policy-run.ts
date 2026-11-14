// ---------------------------------------------------------------------------
// Run-level data-destination policy (ADR 0017 R4, R5).
//
// Preflight resolves the policy before any worker spend and fails closed when
// no upstream provider survives it (R4). After the run the served providers
// captured from authoritative billing are checked against the same policy and
// directory, and any violation marks the run failed (R5).
// ---------------------------------------------------------------------------

import {
  readDataPolicy,
  resolveRegionProviders,
  toRoutingPreferences,
  type DataPolicy,
  type RegionResolutionDeps,
} from './data-policy.ts';

const PROVIDERS_URL = 'https://openrouter.ai/api/v1/providers';

export interface DataPolicyPreflightOptions {
  cwd: string;
  provider: string;
  model: string;
  fetch?: RegionResolutionDeps['fetch'];
}

export type DataPolicyPreflightResult =
  | { ok: true; routing: Record<string, unknown> | null; policy: DataPolicy | null; directory?: unknown[] }
  | { ok: false; reason: string };

export interface ServedProvider {
  provider: string | null;
}

export interface ProviderDirectoryEntry {
  name?: string;
  slug?: string;
  headquarters?: unknown;
  datacenters?: unknown;
  [key: string]: unknown;
}

export interface VerifiedProvider {
  provider: string | null;
  headquarters: unknown;
  datacenters: string[];
  allowed: boolean;
  reason?: string;
}

export interface ServedVerification {
  ok: boolean;
  providers: VerifiedProvider[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accept both `[...]` and OpenRouter's `{data: ...}` envelopes, including the
 * provider directory whose payload is `{data: [...]}`. */
function rows(body: unknown, nested?: string): Record<string, unknown>[] {
  const candidates: unknown[] = [body];
  if (isRecord(body)) {
    candidates.push(body.data);
    if (nested) candidates.push(body[nested]);
    if (isRecord(body.data)) candidates.push(body.data[nested ?? '']);
  }
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

function datacentersOf(entry: ProviderDirectoryEntry | undefined): string[] {
  return Array.isArray(entry?.datacenters)
    ? entry.datacenters.filter((code): code is string => typeof code === 'string')
    : [];
}

function directoryEntryFor(served: string | null, directory: ProviderDirectoryEntry[]): ProviderDirectoryEntry | undefined {
  if (!served) return undefined;
  return directory.find((entry) => entry.name === served || entry.slug === served);
}

function matchesProviderList(served: string | null, entry: ProviderDirectoryEntry | undefined, list: string[]): boolean {
  if (!served && !entry) return false;
  const values = [served, entry?.name, entry?.slug]
    .filter((value): value is string => typeof value === 'string' && !!value);
  return list.some((allowed) => {
    if (typeof allowed !== 'string') return false;
    if (values.includes(allowed)) return true;
    const slug = typeof entry?.slug === 'string' ? entry.slug : null;
    return !!slug && (allowed === slug || allowed.startsWith(`${slug}/`));
  });
}

function regionMatches(datacenters: string[], regions: string[]): boolean {
  return datacenters.length > 0 && datacenters.every((code) => regions.includes(code));
}

/**
 * Resolve and validate the data policy before spend (ADR 0017 R4). A policy
 * without regions maps straight to routing preferences. A regions policy is
 * resolved through the unauthenticated metadata endpoints, cached for this
 * call, and an empty provider set after `providers.ignore` fails closed with a
 * reason that names the model and the constraint that emptied it.
 */
export async function dataPolicyPreflight(opts: DataPolicyPreflightOptions): Promise<DataPolicyPreflightResult> {
  const policy = readDataPolicy(opts.cwd);
  if (!policy) return { ok: true, routing: null, policy: null };
  if (opts.provider !== 'openrouter') return { ok: true, routing: null, policy };
  if (!policy.regions || policy.regions.length === 0) {
    return { ok: true, routing: toRoutingPreferences(policy), policy };
  }

  const regions = policy.regions;
  const fetchImpl: RegionResolutionDeps['fetch'] = opts.fetch
    ?? ((url) => globalThis.fetch(url) as any);
  // One wrapped fetch serves both the region resolver and the directory read,
  // so the unauthenticated metadata lookups are made once per preflight (R2).
  const cache = new Map<string, Promise<{ ok: boolean; json: () => Promise<unknown> }>>();
  const cachedFetch: RegionResolutionDeps['fetch'] = async (url) => {
    let pending = cache.get(url);
    if (!pending) {
      pending = fetchImpl(url);
      cache.set(url, pending);
    }
    const response = await pending;
    if (!response.ok) throw new Error(`data policy metadata request failed for ${url}`);
    return response;
  };

  let resolution;
  let directory: Record<string, unknown>[];
  try {
    resolution = await resolveRegionProviders(opts.model, regions, { fetch: cachedFetch });
    directory = rows(await (await cachedFetch(PROVIDERS_URL)).json(), 'providers');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `data_policy_unsatisfied: model ${opts.model}: ${message}` };
  }

  const ignore = policy.providers?.ignore ?? [];
  const only = resolution.only.filter((tag) => {
    if (ignore.includes(tag)) return false;
    return !ignore.some((provider) => tag.startsWith(`${provider}/`));
  });

  if (only.length === 0) {
    const regionText = regions.join(', ');
    const constraint = resolution.only.length === 0
      ? `no endpoint in the allowed regions ${regionText}`
      : 'all region-matched providers are ignored by providers.ignore';
    const unresolved = resolution.unresolved.length > 0
      ? `; providers with no datacenter data: ${resolution.unresolved.join(', ')}`
      : '';
    return {
      ok: false,
      reason: `data_policy_unsatisfied: model ${opts.model}: ${constraint}${unresolved}`,
    };
  }

  return {
    ok: true,
    routing: toRoutingPreferences(policy, only),
    policy,
    directory,
  };
}

/**
 * Verify the upstream providers that actually served the run (ADR 0017 R5).
 * A provider is refused when it is ignored, outside the explicit `only` list
 * (or the region-resolved list), or, under a regions policy, has a datacenter
 * outside the allowed regions or no datacenter data at all.
 */
export function verifyServedProviders(
  policy: DataPolicy,
  served: ServedProvider[],
  directory: ProviderDirectoryEntry[],
  resolvedOnly?: string[],
): ServedVerification {
  const only = resolvedOnly ?? policy.providers?.only;
  const ignore = policy.providers?.ignore;
  const regions = policy.regions;

  const providers = served.map(({ provider }) => {
    const entry = directoryEntryFor(provider, directory);
    const datacenters = datacentersOf(entry);
    const base = {
      provider,
      headquarters: entry?.headquarters ?? null,
      datacenters,
    };

    if (ignore && matchesProviderList(provider, entry, ignore)) {
      return { ...base, allowed: false, reason: 'listed in providers.ignore' };
    }
    if (only && !matchesProviderList(provider, entry, only)) {
      return { ...base, allowed: false, reason: 'not in the allowed provider list' };
    }
    if (regions && regions.length > 0 && !regionMatches(datacenters, regions)) {
      return {
        ...base,
        allowed: false,
        reason: datacenters.length === 0
          ? 'provider has no datacenter data under a regions policy'
          : `datacenter outside the allowed regions ${regions.join(', ')}`,
      };
    }
    if (!entry) {
      return { ...base, allowed: false, reason: 'provider is not in the provider directory' };
    }
    return { ...base, allowed: true };
  });

  return { ok: providers.every((entry) => entry.allowed), providers };
}
