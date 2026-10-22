// ---------------------------------------------------------------------------
// Named gateways for Jev (ADR-0006).
//
// One per-kind table resolves the base URL, the ordered key sources and the
// Jev model-id mapping. `openrouter` keeps the Pi `registry.classify` transport
// that Junior uses today; `typesafe` calls the TypeSafe systemone endpoint
// directly. Adding a kind (for example `litellm`) is a table row plus its
// model-id mapping; call sites do not change.
//
// No key value is ever included in an error, receipt, run record, doctor
// output or log (ADR-0006 R5). Resolution reads the environment first and the
// Pi `auth.json` entry second, never throws on a missing or malformed file.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { openRouterAuthPath } from './billing.ts';

export type GatewayKind = 'openrouter' | 'typesafe';

export const GATEWAY_KINDS: readonly GatewayKind[] = ['openrouter', 'typesafe'];

export type Gateway = {
  baseUrl: string;
  /** Environment variable consulted first for this gateway's key. */
  keyEnv: string;
  /** Entry name under the Pi `auth.json` document consulted second. */
  authKey: string;
  /** Jev model id sent to this gateway. */
  jevModel: string;
  /** `pi` uses the Pi registry classifier; `http` calls the gateway directly. */
  jevTransport: 'pi' | 'http';
};

export const GATEWAYS: Record<GatewayKind, Gateway> = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api',
    keyEnv: 'OPENROUTER_API_KEY',
    authKey: 'openrouter',
    jevModel: 'typesafe/jev-1.13',
    jevTransport: 'pi',
  },
  typesafe: {
    baseUrl: 'https://api.typesafe.ai',
    keyEnv: 'TYPESAFE_JEV_API_KEY',
    authKey: 'typesafe',
    jevModel: 'jev-latest',
    jevTransport: 'http',
  },
};

/** Reject any kind not in the table, naming the allowed kinds (R2). */
export function validateGatewayKind(kind: unknown): GatewayKind {
  if (typeof kind !== 'string' || !(GATEWAY_KINDS as readonly string[]).includes(kind)) {
    throw Error(`Invalid gateway kind ${String(kind)} (expected ${GATEWAY_KINDS.join(' or ')})`);
  }
  return kind as GatewayKind;
}

export type GatewayDeps = {
  /** Injected environment; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injected auth-file reader; defaults to `fs.readFileSync(path, 'utf8')`. */
  readAuthFile?: (path: string) => string;
  /** Injected auth path; defaults to `openRouterAuthPath(env)`. */
  authPath?: string;
};

/** Read one `auth.json` entry using the same shape rules as billing.ts's
 * `readOpenRouterAuthFile` (`api_key`/`api` with `key`, or `oauth` with
 * `access`). Never throws on a missing, unreadable or malformed file. */
function readAuthEntry(authPath: string, authKey: string, readFile: (path: string) => string): string | null {
  try {
    const parsed = JSON.parse(readFile(authPath));
    const c = parsed?.[authKey];
    if (!c || typeof c !== 'object') return null;
    if ((c.type === 'api_key' || c.type === 'api') && typeof c.key === 'string' && c.key.trim()) return c.key.trim();
    if (c.type === 'oauth' && typeof c.access === 'string' && c.access.trim()) return c.access.trim();
  } catch { /* absent, unreadable or malformed auth is simply no key */ }
  return null;
}

/** Resolve one gateway's key: environment first (trimmed, non-blank), then the
 * Pi `auth.json` entry. Returns null when neither source yields a key. */
export function resolveGatewayKey(kind: GatewayKind, deps: GatewayDeps = {}): string | null {
  const gateway = GATEWAYS[validateGatewayKind(kind)];
  const env = deps.env ?? process.env;
  const fromEnv = env[gateway.keyEnv];
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  const readFile = deps.readAuthFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const authPath = deps.authPath ?? openRouterAuthPath(env);
  return readAuthEntry(authPath, gateway.authKey, readFile);
}

export type JevProvider = 'auto' | 'openrouter' | 'typesafe';

export function validateJevProvider(v: unknown): JevProvider {
  if (v !== 'auto' && v !== 'openrouter' && v !== 'typesafe') {
    throw Error(`Invalid jev.provider ${String(v)} (expected auto, openrouter or typesafe)`);
  }
  return v;
}

/** An explicit Jev provider whose key is missing (R4). The message names the
 * provider and its key environment variable, never a key value (R5). */
export class GatewayError extends Error {
  readonly code = 'jev_provider_key_missing' as const;
  constructor(provider: JevProvider, keyEnv: string) {
    super(`Jev provider ${provider} requires ${keyEnv} to be configured`);
    this.name = 'GatewayError';
  }
}

export type ResolvedJevGateway = {
  kind: GatewayKind;
  baseUrl: string;
  model: string;
  transport: 'pi' | 'http';
  key: string;
};

function build(kind: GatewayKind, key: string): ResolvedJevGateway {
  const gateway = GATEWAYS[kind];
  return { kind, baseUrl: gateway.baseUrl, model: gateway.jevModel, transport: gateway.jevTransport, key };
}

/** Resolve the Jev gateway. `auto` prefers `typesafe` when its key resolves,
 * otherwise `openrouter`, otherwise null. An explicit provider without its key
 * throws GatewayError rather than silently switching paid paths (R4). */
export function resolveJevGateway(provider: JevProvider = 'auto', deps: GatewayDeps = {}): ResolvedJevGateway | null {
  if (provider === 'auto') {
    const typesafe = resolveGatewayKey('typesafe', deps);
    if (typesafe) return build('typesafe', typesafe);
    const openrouter = resolveGatewayKey('openrouter', deps);
    return openrouter ? build('openrouter', openrouter) : null;
  }
  const key = resolveGatewayKey(provider, deps);
  if (!key) throw new GatewayError(provider, GATEWAYS[provider].keyEnv);
  return build(provider, key);
}

/** Environment overrides a companion spawn inherits: the OpenRouter key and,
 * when it resolves, the TypeSafe key. Empty when no gateway key resolves. */
export function companionGatewayEnv(deps: GatewayDeps = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const openrouter = resolveGatewayKey('openrouter', deps);
  if (openrouter) out.OPENROUTER_API_KEY = openrouter;
  const typesafe = resolveGatewayKey('typesafe', deps);
  if (typesafe) out.TYPESAFE_JEV_API_KEY = typesafe;
  return out;
}
