#!/usr/bin/env node
// ---------------------------------------------------------------------------
// `junior auth set|remove` — scriptable provider key management for Pi's
// `auth.json`.
//
// `set` reads the key from stdin only (never argv), so it cannot leak through a
// process listing or shell history. Writes are atomic: a 0600 temp file in the
// agent directory is renamed over `auth.json`, the file ends up 0600 and the
// directory 0700. Unrelated providers are preserved, and a malformed or
// non-object existing file is refused unchanged rather than silently replaced.
// ---------------------------------------------------------------------------

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { checkCredentialsOnline, type SetupDeps } from './setup.ts';

export const AUTH_USAGE = [
  'Usage: junior auth set <provider> [--verify]',
  '       junior auth remove <provider>',
  '       junior auth consent [grant] <provider> [--project <dir>]',
  '       junior auth consent remove <provider> [--project <dir>]',
  '       junior auth consent status [provider] [--project <dir>]',
].join('\n');

/** The agent directory that holds `auth.json`; mirrors setup.ts resolution. */
function agentDir(deps: SetupDeps = {}): string {
  const env = deps.env ?? process.env;
  const home = env.HOME || env.USERPROFILE || '';
  return env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent');
}

function readText(deps: SetupDeps, path: string): string {
  return (deps.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(path, 'utf8');
}

function pathExists(deps: SetupDeps, path: string): boolean {
  return (deps.exists ?? existsSync)(path);
}

/** Parse the existing auth file, refusing anything that is not a plain object. */
function readAuthObject(deps: SetupDeps): Record<string, unknown> {
  const dir = agentDir(deps);
  const path = join(dir, 'auth.json');
  if (!pathExists(deps, path)) return {};
  const raw = readText(deps, path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Error(`Refusing to update ${path}: existing file is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Error(`Refusing to update ${path}: existing file is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Atomically replace `auth.json` with `value`, tightening modes to 0600/0700. */
function writeAuthObject(deps: SetupDeps, value: Record<string, unknown>): string {
  const dir = agentDir(deps);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'auth.json');
  const tmp = join(dir, `.auth.json.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  chmodSync(dir, 0o700);
  return path;
}

// ---------------------------------------------------------------------------
// External-context consent
//
// A provider handoff can transmit repository source/context outside the local
// harness. Consent is scoped to one provider and one project; the token binds
// both. The record lives under the project's runtime-owned `.delivery/` tree so
// it is inspectable and is never mistaken for a credential.
// ---------------------------------------------------------------------------

export const EXTERNAL_CONTEXT_CONSENT_FILE = 'external-context-consent.json';
export const EXTERNAL_CONTEXT_CONSENT_VERSION = 1;

export type ExternalContextConsentRecord = {
  provider: string;
  token: string;
  destination: string | null;
  model: string | null;
  scope: string[] | null;
  recordedAt: string;
};

export type ExternalContextConsentStatus = {
  provider: string;
  required: true;
  granted: boolean;
  source: 'project' | null;
  token: string | null;
  record: ExternalContextConsentRecord | null;
  path: string;
};

export type RecordExternalContextConsentOptions = {
  destination?: string | null;
  model?: string | null;
  scope?: string[] | null;
  now?: Date;
};

/** The project-local consent file. The path itself contains no credential. */
export function externalContextConsentPath(cwd: string): string {
  return join(resolve(cwd), '.delivery', EXTERNAL_CONTEXT_CONSENT_FILE);
}

function consentToken(cwd: string, provider: string): string {
  const digest = createHash('sha256').update(`${resolve(cwd)}\u0000${provider}`).digest('hex');
  return `xctx_${digest.slice(0, 32)}`;
}

function readConsentDocument(cwd: string): { version: number; providers: Record<string, ExternalContextConsentRecord> } {
  const path = externalContextConsentPath(cwd);
  const empty = { version: EXTERNAL_CONTEXT_CONSENT_VERSION, providers: {} as Record<string, ExternalContextConsentRecord> };
  if (!existsSync(path)) return empty;
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
  const providers: Record<string, ExternalContextConsentRecord> = {};
  const raw = parsed.providers && typeof parsed.providers === 'object' && !Array.isArray(parsed.providers) ? parsed.providers : {};
  for (const [provider, value] of Object.entries(raw as Record<string, any>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (typeof value.token !== 'string' || !value.token) continue;
    providers[provider] = {
      provider,
      token: value.token,
      destination: typeof value.destination === 'string' ? value.destination : null,
      model: typeof value.model === 'string' ? value.model : null,
      scope: Array.isArray(value.scope) ? value.scope.filter((p: unknown): p is string => typeof p === 'string') : null,
      recordedAt: typeof value.recordedAt === 'string' ? value.recordedAt : '',
    };
  }
  return { version: EXTERNAL_CONTEXT_CONSENT_VERSION, providers };
}

function writeConsentDocument(cwd: string, providers: Record<string, ExternalContextConsentRecord>): string {
  const path = externalContextConsentPath(cwd);
  mkdirSync(join(resolve(cwd), '.delivery'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: EXTERNAL_CONTEXT_CONSENT_VERSION, providers }, null, 2)}\n`);
  return path;
}

/** Record project/provider consent and return the provider/project-bound token. */
export function recordExternalContextConsent(cwd: string, provider: string, options: RecordExternalContextConsentOptions = {}): ExternalContextConsentRecord {
  const key = String(provider ?? '').trim();
  if (!key) throw Error('External-context consent requires a provider');
  const document = readConsentDocument(cwd);
  const record: ExternalContextConsentRecord = {
    provider: key,
    token: consentToken(cwd, key),
    destination: typeof options.destination === 'string' && options.destination.trim() ? options.destination.trim() : null,
    model: typeof options.model === 'string' && options.model.trim() ? options.model.trim() : null,
    scope: Array.isArray(options.scope) ? options.scope.filter((p): p is string => typeof p === 'string') : null,
    recordedAt: (options.now ?? new Date()).toISOString(),
  };
  document.providers[key] = record;
  writeConsentDocument(cwd, document.providers);
  return record;
}

/** Remove project/provider consent; other providers stay untouched. */
export function removeExternalContextConsent(cwd: string, provider: string): string {
  const key = String(provider ?? '').trim();
  const document = readConsentDocument(cwd);
  delete document.providers[key];
  return writeConsentDocument(cwd, document.providers);
}

/** Read the recorded decision without granting anything. */
export function readExternalContextConsent(cwd: string, provider: string): ExternalContextConsentStatus {
  const key = String(provider ?? '').trim();
  const path = externalContextConsentPath(cwd);
  const record = readConsentDocument(cwd).providers[key] ?? null;
  return { provider: key, required: true, granted: !!record, source: record ? 'project' : null, token: record?.token ?? null, record, path };
}

/** True only when `token` was issued for this exact provider and project. */
export function verifyExternalContextConsentToken(cwd: string, provider: string, token: string): boolean {
  const key = String(provider ?? '').trim();
  if (!token || !key) return false;
  const record = readConsentDocument(cwd).providers[key];
  return !!record && record.token === token && token === consentToken(cwd, key);
}

const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  openrouter: ['OPENROUTER_API_KEY'],
  typesafe: ['TYPESAFE_JEV_API_KEY', 'TYPESAFE_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  zai: ['ZAI_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  qwen: ['QWEN_API_KEY'],
  'z-ai': ['ZAI_API_KEY'],
  litellm: ['LITELLM_API_KEY'],
};

/** Report only the credential source category, never a key value. */
export function externalContextCredentialSource(provider: string, deps: SetupDeps = {}): { category: 'env' | 'auth' | 'none'; name: string | null } {
  const env = deps.env ?? process.env;
  for (const name of PROVIDER_ENV_KEYS[provider] ?? [`${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`]) {
    if (typeof env[name] === 'string' && env[name]) return { category: 'env', name };
  }
  let auth: Record<string, unknown> = {};
  try { auth = readAuthObject(deps); } catch { auth = {}; }
  if (Object.prototype.hasOwnProperty.call(auth, provider)) return { category: 'auth', name: 'auth.json' };
  return { category: 'none', name: null };
}

export type ExternalContextAuthorizationReadiness = {
  provider: string;
  project: string;
  /** Whether the local runtime/provider prerequisites are satisfied. */
  runtimeReady: boolean;
  /** Whether the manager authorized repository-context egress for this provider/project. */
  authorized: boolean;
  /** True only when runtime readiness and authorization both hold. */
  readyForDelegation: boolean;
  authorization: ExternalContextConsentStatus;
  reason: string;
};

/** Doctor-facing separation of runtime readiness from external-context
 * authorization. Doctor's existing runtime checks decide `runtimeReady`; this
 * function never upgrades it or grants consent. */
export function doctorExternalContextAuthorization(project: string, provider: string, runtimeReady: boolean): ExternalContextAuthorizationReadiness {
  const authorization = readExternalContextConsent(project, provider);
  const authorized = authorization.granted;
  return {
    provider,
    project: resolve(project),
    runtimeReady,
    authorized,
    readyForDelegation: runtimeReady && authorized,
    authorization,
    reason: !runtimeReady ? 'runtime is not ready' : (authorized ? 'runtime ready and external-context egress authorized' : 'runtime ready but external-context egress is not authorized; run `junior auth consent <provider>`'),
  };
}

/** Alias with the shorter name used by doctor integrations. */
export const inspectExternalContextAuthorization = doctorExternalContextAuthorization;

/** Store `key` as `<provider>`'s api_key credential, preserving other entries. */
export function setProviderKey(provider: string, key: string, deps: SetupDeps = {}): string {
  const auth = readAuthObject(deps);
  auth[provider] = { type: 'api_key', key };
  return writeAuthObject(deps, auth);
}

/** Delete `<provider>`'s entry, preserving every other entry. */
export function removeProviderKey(provider: string, deps: SetupDeps = {}): string {
  const auth = readAuthObject(deps);
  delete auth[provider];
  return writeAuthObject(deps, auth);
}

/** Read one line from piped stdin, or a no-echo line when stdin is a TTY. */
async function readKeyFromStdin(): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    process.stderr.write('Enter API key: ');
    return await new Promise<string>((resolve) => {
      const wasRaw = stdin.isRaw === true;
      stdin.setRawMode?.(true);
      stdin.setEncoding('utf8');
      stdin.resume();
      let buffer = '';
      const finish = () => {
        stdin.setRawMode?.(wasRaw);
        stdin.off('data', onData);
        stdin.pause();
        process.stderr.write('\n');
        resolve(buffer.trim());
      };
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') {
            finish();
            return;
          }
          if (ch === '\u0003') {
            stdin.setRawMode?.(wasRaw);
            process.exit(130);
          }
          if (ch === '\u007f' || ch === '\b') {
            buffer = buffer.slice(0, -1);
            continue;
          }
          buffer += ch;
        }
      };
      stdin.on('data', onData);
    });
  }
  return await new Promise<string>((resolve, reject) => {
    let data = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onError);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      data += chunk;
      const newline = data.indexOf('\n');
      if (newline !== -1) {
        cleanup();
        resolve(data.slice(0, newline).replace(/\r$/, '').trim());
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(data.trim());
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    stdin.resume();
  });
}

interface SetArgs {
  provider: string;
  verify: boolean;
  error?: string;
}

function parseSetArgs(args: string[]): SetArgs {
  let verify = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === '--verify') {
      verify = true;
      continue;
    }
    if (arg.startsWith('-')) return { provider: '', verify, error: `Unknown option for auth set: ${arg}` };
    positional.push(arg);
  }
  if (positional.length !== 1) return { provider: '', verify, error: 'auth set requires exactly one provider' };
  return { provider: positional[0], verify };
}

function fail(message: string): number {
  process.stdout.write(`${message}\n`);
  return 1;
}

export async function main(argv: string[], deps: SetupDeps = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${AUTH_USAGE}\n`);
    return 0;
  }
  if (command === 'set') {
    const parsed = parseSetArgs(rest);
    if (parsed.error) return fail(`${parsed.error}\n${AUTH_USAGE}`);
    const key = await readKeyFromStdin();
    if (!key) return fail('No key provided on stdin');
    try {
      setProviderKey(parsed.provider, key, deps);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (parsed.verify) {
      // Only OpenRouter exposes a key-status endpoint; never probe another
      // provider's key against it.
      if (parsed.provider !== 'openrouter') {
        process.stdout.write(`${JSON.stringify({ provider: parsed.provider, updated: true, verified: null, error: 'online verification is only available for openrouter' }, null, 2)}\n`);
        return 0;
      }
      const result = await checkCredentialsOnline(deps);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(`${JSON.stringify({ provider: parsed.provider, updated: true }, null, 2)}\n`);
    return 0;
  }
  if (command === 'remove') {
    if (rest.length !== 1 || rest[0].startsWith('-')) return fail(AUTH_USAGE);
    const provider = rest[0];
    try {
      removeProviderKey(provider, deps);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    process.stdout.write(`${JSON.stringify({ provider, removed: true }, null, 2)}\n`);
    return 0;
  }
  if (command === 'consent' || command === 'approve' || command === 'authorize') {
    let project = process.cwd();
    let token: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--project') { project = rest[++i] ?? ''; continue; }
      if (arg.startsWith('--project=')) { project = arg.slice('--project='.length); continue; }
      if (arg === '--token') { token = rest[++i]; continue; }
      if (arg.startsWith('--token=')) { token = arg.slice('--token='.length); continue; }
      if (arg.startsWith('-')) return fail(`Unknown option for auth consent: ${arg}\n${AUTH_USAGE}`);
      positional.push(arg);
    }
    if (!project) return fail(AUTH_USAGE);
    const first = positional[0];
    let resolvedAction: 'set' | 'remove' | 'status' = 'set';
    if (first === 'remove' || first === 'revoke' || first === 'deny') { resolvedAction = 'remove'; positional.shift(); }
    else if (first === 'status') { resolvedAction = 'status'; positional.shift(); }
    else if (first === 'set' || first === 'grant' || first === 'approve' || first === 'authorize') { resolvedAction = 'set'; positional.shift(); }
    const provider = positional[0] ?? '';
    if (resolvedAction === 'status') {
      if (provider) {
        process.stdout.write(`${JSON.stringify(readExternalContextConsent(project, provider), null, 2)}\n`);
      } else {
        const document = readConsentDocument(project);
        process.stdout.write(`${JSON.stringify({ path: externalContextConsentPath(project), providers: Object.keys(document.providers).sort() }, null, 2)}\n`);
      }
      return 0;
    }
    if (positional.length !== 1 || !provider) return fail(AUTH_USAGE);
    try {
      if (resolvedAction === 'remove') removeExternalContextConsent(project, provider);
      else recordExternalContextConsent(project, provider, token ? { scope: [token] } : {});
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const status = readExternalContextConsent(project, provider);
    process.stdout.write(`${JSON.stringify({ ...status, removed: resolvedAction === 'remove' }, null, 2)}\n`);
    return 0;
  }
  return fail(`Unknown auth command: ${command}\n${AUTH_USAGE}`);
}