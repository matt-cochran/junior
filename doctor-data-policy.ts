// ---------------------------------------------------------------------------
// Doctor data-destination posture (ADR 0017 R7).
//
// Reports the routing preferences Junior will send, every candidate provider
// for the approved models with its headquarters and datacenters, which ones
// the policy keeps and why the others are dropped, and the account-level
// privacy settings Junior cannot verify. Metadata reads are injected so tests
// never touch the network. This module is read-only and does not wire itself
// into the doctor command (CLI17 does that).
// ---------------------------------------------------------------------------

import {
  readDataPolicy,
  toRoutingPreferences,
  type DataPolicy,
  type RegionResolutionDeps,
} from './data-policy.ts';

export interface DataPolicyCandidate {
  tag: string;
  provider: string;
  headquarters: string | null;
  datacenters: string[];
  kept: boolean;
  reason?: string;
}

export interface DataPolicyModelPosture {
  model: string;
  candidates: DataPolicyCandidate[];
}

/** ADR 0017 R7: the honest data-destination posture shown by `junior doctor`. */
export interface DataPolicyPosture {
  policy: DataPolicy | null;
  routing: Record<string, unknown> | null;
  models: DataPolicyModelPosture[];
  accountSettings: {
    verifiable: false;
    link: 'https://openrouter.ai/settings/privacy';
  };
  warnings: string[];
  remediation: string[];
}

export const DATA_POLICY_SETTINGS_LINK = 'https://openrouter.ai/settings/privacy' as const;
export const NO_DATA_POLICY_WARNING =
  'No models.dataPolicy is set; OpenRouter may route requests to any provider and fall back between them.';

const NO_DATA_POLICY_REMEDIATION =
  'Set models.dataPolicy in delivery.config.json to constrain where repository text is processed; see docs/data-destination.md.';
const ACCOUNT_SETTINGS = {
  verifiable: false as const,
  link: DATA_POLICY_SETTINGS_LINK,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accept `[...]` and OpenRouter's `{data: ...}` envelopes, including the
 * endpoints payload `{data: {endpoints: [...]}}` (same shape as data-policy.ts). */
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

function metadataReader(fetchFn: RegionResolutionDeps['fetch']) {
  const cache = new Map<string, Promise<unknown>>();
  return (url: string): Promise<unknown> => {
    let pending = cache.get(url);
    if (!pending) {
      pending = (async () => {
        const response = await fetchFn(url);
        if (!response.ok) throw new Error(`data policy metadata request failed for ${url}`);
        return response.json();
      })();
      cache.set(url, pending);
    }
    return pending;
  };
}

function providerFor(
  endpoint: Record<string, unknown>,
  providers: Record<string, unknown>[],
): Record<string, unknown> | undefined {
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

function matchesProviderList(
  entries: string[],
  tag: string,
  provider: Record<string, unknown> | undefined,
): boolean {
  const slug = provider && typeof provider.slug === 'string' ? provider.slug : undefined;
  const name = provider && typeof provider.name === 'string' ? provider.name : undefined;
  return entries.some((entry) =>
    entry === tag
    || entry === slug
    || entry === name
    || (slug !== undefined && tag.startsWith(`${entry}/`)),
  );
}

/** ADR 0017 R2/R4: evaluate one endpoint against every enforceable policy
 * constraint. Retention terms beyond data_collection/zdr are not knowable
 * from the metadata API, so they are never claimed here. */
function evaluateCandidate(
  policy: DataPolicy,
  tag: string,
  provider: Record<string, unknown> | undefined,
  datacenters: string[],
): { kept: boolean; reason?: string } {
  if (policy.providers?.ignore !== undefined && matchesProviderList(policy.providers.ignore, tag, provider)) {
    return { kept: false, reason: 'ignored' };
  }
  if (policy.providers?.only !== undefined && !matchesProviderList(policy.providers.only, tag, provider)) {
    return { kept: false, reason: 'outside only' };
  }
  if (policy.regions !== undefined) {
    if (datacenters.length === 0) return { kept: false, reason: 'no datacenter data' };
    if (!datacenters.every((code) => policy.regions!.includes(code))) {
      return { kept: false, reason: 'outside regions' };
    }
  }
  return { kept: true };
}

function candidateFor(
  policy: DataPolicy,
  endpoint: Record<string, unknown>,
  providers: Record<string, unknown>[],
): DataPolicyCandidate | null {
  const tag = endpoint.tag;
  if (typeof tag !== 'string') return null;
  const provider = providerFor(endpoint, providers);
  const datacenters = provider && Array.isArray(provider.datacenters)
    ? provider.datacenters.filter((code): code is string => typeof code === 'string')
    : [];
  const providerLabel = provider && typeof provider.name === 'string'
    ? provider.name
    : (typeof endpoint.provider_name === 'string'
      ? endpoint.provider_name
      : (provider && typeof provider.slug === 'string' ? provider.slug : tag));
  const headquarters = provider && typeof provider.headquarters === 'string'
    ? provider.headquarters
    : null;
  return {
    tag,
    provider: providerLabel,
    headquarters,
    datacenters,
    ...evaluateCandidate(policy, tag, provider, datacenters),
  };
}

/**
 * Build the data-destination posture for `opts.models` (ADR 0017 R7). With no
 * policy it returns immediately and makes no metadata request (R1). With a
 * policy it joins every endpoint with the provider directory through the
 * injected fetch (R2), marks each candidate kept or dropped, and warns when a
 * model has no survivor (R4) or fallbacks may leave the allowed set.
 */
export async function inspectDataPolicy(opts: {
  cwd: string;
  models: string[];
  fetch?: RegionResolutionDeps['fetch'];
}): Promise<DataPolicyPosture> {
  const policy = readDataPolicy(opts.cwd);
  if (!policy) {
    return {
      policy: null,
      routing: null,
      models: [],
      accountSettings: { ...ACCOUNT_SETTINGS },
      warnings: [NO_DATA_POLICY_WARNING],
      remediation: [NO_DATA_POLICY_REMEDIATION],
    };
  }

  const warnings: string[] = [];
  const remediation: string[] = [];
  const models: DataPolicyModelPosture[] = [];
  const regionOnly: string[] = [];

  if (policy.allowFallbacks === true) {
    warnings.push(
      'models.dataPolicy.allowFallbacks is true; requests may leave the allowed set and fall back to another provider.',
    );
  }

  if (opts.models.length > 0) {
    const fetchFn = opts.fetch ?? ((url: string) => fetch(url));
    const readJson = metadataReader(fetchFn);
    let providers: Record<string, unknown>[] = [];
    try {
      providers = rows(await readJson('https://openrouter.ai/api/v1/providers'), 'providers');
    } catch (error) {
      warnings.push(`Could not read the OpenRouter provider directory: ${(error as Error).message}`);
    }

    for (const model of opts.models) {
      const candidates: DataPolicyCandidate[] = [];
      try {
        const body = await readJson(`https://openrouter.ai/api/v1/models/${model}/endpoints`);
        for (const endpoint of rows(body, 'endpoints')) {
          const candidate = candidateFor(policy, endpoint, providers);
          if (candidate) candidates.push(candidate);
        }
      } catch (error) {
        warnings.push(`Could not read OpenRouter endpoints for ${model}: ${(error as Error).message}`);
      }
      models.push({ model, candidates });

      if (policy.regions !== undefined) {
        for (const candidate of candidates) {
          if (candidate.kept && !regionOnly.includes(candidate.tag)) regionOnly.push(candidate.tag);
        }
      }

      if (!candidates.some((candidate) => candidate.kept)) {
        warnings.push(
          `Model ${model} has no candidate providers that satisfy models.dataPolicy; runs on it will stop with data_policy_unsatisfied.`,
        );
        remediation.push(
          `Widen models.dataPolicy for ${model} or approve another model; see docs/data-destination.md.`,
        );
      }
    }
  }

  // ADR 0017 R2: regions have no OpenRouter field; the resolved provider tags
  // are sent as `only`. An empty resolution is preserved so preflight fails
  // closed (R4).
  const routing = policy.regions !== undefined
    ? toRoutingPreferences(policy, regionOnly)
    : toRoutingPreferences(policy);

  return {
    policy,
    routing,
    models,
    accountSettings: { ...ACCOUNT_SETTINGS },
    warnings,
    remediation,
  };
}

/** ADR 0017 R7: concise text lines for `junior doctor`. Account settings are
 * always reported as unverifiable, with OpenRouter's privacy-settings link. */
export function renderDataPolicyPosture(posture: DataPolicyPosture): string {
  const lines: string[] = [];
  lines.push(posture.policy
    ? `Data destination routing: ${JSON.stringify(posture.routing)}`
    : 'Data destination: no models.dataPolicy is set.');

  for (const entry of posture.models) {
    lines.push(`  model ${entry.model}:`);
    for (const candidate of entry.candidates) {
      const headquarters = candidate.headquarters ?? 'unknown';
      const datacenters = candidate.datacenters.length > 0 ? candidate.datacenters.join(', ') : 'unknown';
      const verdict = candidate.kept ? 'kept' : `dropped: ${candidate.reason ?? 'outside policy'}`;
      lines.push(
        `    ${candidate.tag} (${candidate.provider}) headquarters ${headquarters}; datacenters ${datacenters}; ${verdict}`,
      );
    }
  }

  for (const warning of posture.warnings) lines.push(`warning: ${warning}`);
  for (const item of posture.remediation) lines.push(`remediation: ${item}`);
  lines.push(
    `account privacy settings: cannot be verified; check ${posture.accountSettings.link}`,
  );
  return lines.join('\n');
}
