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
import { readDataPolicy, type DataPolicy } from './data-policy.ts';
import { systemClock, type Clock } from './clock.ts';
import {
  requireHuman,
  recordBudgetApproval,
  type HumanApprovalOptions,
} from './human-approval.ts';

export const AUTH_USAGE = [
  'Usage: junior auth set <provider> [--verify]',
  '       junior auth remove <provider>',
  '       junior auth consent [grant] <provider> [--project <dir>]',
  '       junior auth consent remove <provider> [--project <dir>]',
  '       junior auth consent status [provider] [--project <dir>]',
  '       junior auth budget approve <contract-id> --tokens <n> [--project <dir>]',
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
  /** ADR 0017 R6: sha256 of the canonical policy at consent time. */
  dataPolicyHash?: string | null;
  /** ADR 0017 R6: one-line summary of the policy shown at consent time. */
  dataPolicySummary?: string | null;
  /** ADR 0017 R6: the policy itself, for a later widening comparison. */
  dataPolicy?: DataPolicy | null;
};

export type ExternalContextConsentStatus = {
  provider: string;
  required: true;
  granted: boolean;
  source: 'project' | null;
  token: string | null;
  record: ExternalContextConsentRecord | null;
  path: string;
  /** Why an existing consent no longer applies, if it was invalidated. */
  reason?: string | null;
};

export type RecordExternalContextConsentOptions = {
  destination?: string | null;
  model?: string | null;
  scope?: string[] | null;
  now?: Date;
  /** Time source when `now` is not given (default: the system clock). */
  clock?: Clock;
  dataPolicy?: DataPolicy | null;
};

export const WIDENED_POLICY_REASON = 'data policy widened since consent; run junior auth consent grant <provider> again';

function canonicalPolicyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalPolicyValue).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) out[key] = canonicalPolicyValue(entry);
    }
    return out;
  }
  return value;
}

/** ADR 0017 R6: hash the policy with sorted keys and sorted arrays. */
function hashDataPolicy(policy: DataPolicy | null | undefined): string | null {
  if (policy === null || policy === undefined) return null;
  return createHash('sha256').update(JSON.stringify(canonicalPolicyValue(policy))).digest('hex');
}

/** ADR 0017 R6: a compact, human-readable effective policy description. */
function summarizeDataPolicy(policy: DataPolicy | null | undefined): string | null {
  if (policy === null || policy === undefined) return null;
  const parts: string[] = [];
  if (policy.dataCollection !== undefined) parts.push(`dataCollection ${policy.dataCollection}`);
  if (policy.zdr !== undefined) parts.push(policy.zdr ? 'zdr' : 'zdr off');
  if (policy.providers?.only !== undefined) parts.push(`only ${[...policy.providers.only].sort().join(', ')}`);
  if (policy.providers?.ignore !== undefined) parts.push(`ignore ${[...policy.providers.ignore].sort().join(', ')}`);
  if (policy.regions !== undefined) parts.push(`regions ${[...policy.regions].sort().join(', ')}`);
  if (policy.allowUncovered !== undefined) parts.push(`allowUncovered ${[...policy.allowUncovered].sort().join(', ')}`);
  parts.push(policy.allowFallbacks === true ? 'fallbacks on' : 'fallbacks off');
  return parts.join('; ');
}

/**
 * ADR 0017 R6: whether `next` widens the destination relative to `previous`.
 * A widening removes a constraint (or leaves no policy); tightening is false.
 */
export function policyWidens(previous: DataPolicy | null, next: DataPolicy | null): boolean {
  if (!previous) return false;
  if (!next) return true;
  if (previous.dataCollection === 'deny' && next.dataCollection !== 'deny') return true;
  if (previous.zdr === true && next.zdr !== true) return true;
  if (previous.regions) {
    if (!next.regions) return true;
    if (next.regions.some((region) => !previous.regions!.includes(region))) return true;
  }
  const previousOnly = previous.providers?.only;
  const nextOnly = next.providers?.only;
  if (previousOnly) {
    if (!nextOnly) return true;
    if (nextOnly.some((provider) => !previousOnly.includes(provider))) return true;
  }
  const previousIgnore = previous.providers?.ignore;
  const nextIgnore = next.providers?.ignore;
  if (previousIgnore) {
    if (!nextIgnore) {
      if (previousIgnore.length > 0) return true;
    } else if (previousIgnore.some((provider) => !nextIgnore.includes(provider))) {
      return true;
    }
  }
  if (previous.allowFallbacks !== true && next.allowFallbacks === true) return true;
  // Letting another path run uncovered (TypeSafe direct, companions) sends
  // repository text somewhere the policy cannot constrain.
  if ((next.allowUncovered ?? []).some((path) => !(previous.allowUncovered ?? []).includes(path))) return true;
  return false;
}

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
      dataPolicyHash: typeof value.dataPolicyHash === 'string' ? value.dataPolicyHash : null,
      dataPolicySummary: typeof value.dataPolicySummary === 'string' ? value.dataPolicySummary : null,
      dataPolicy: value.dataPolicy && typeof value.dataPolicy === 'object' && !Array.isArray(value.dataPolicy)
        ? value.dataPolicy as DataPolicy
        : null,
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
  const dataPolicy = options.dataPolicy ?? null;
  const record: ExternalContextConsentRecord = {
    provider: key,
    token: consentToken(cwd, key),
    destination: typeof options.destination === 'string' && options.destination.trim() ? options.destination.trim() : null,
    model: typeof options.model === 'string' && options.model.trim() ? options.model.trim() : null,
    scope: Array.isArray(options.scope) ? options.scope.filter((p): p is string => typeof p === 'string') : null,
    recordedAt: (options.now ?? (options.clock ?? systemClock).date()).toISOString(),
    dataPolicyHash: hashDataPolicy(dataPolicy),
    dataPolicySummary: summarizeDataPolicy(dataPolicy),
    dataPolicy: dataPolicy === null ? null : JSON.parse(JSON.stringify(dataPolicy)),
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
export function readExternalContextConsent(
  cwd: string,
  provider: string,
  options: { dataPolicy?: DataPolicy | null } = {},
): ExternalContextConsentStatus {
  const key = String(provider ?? '').trim();
  const path = externalContextConsentPath(cwd);
  const record = readConsentDocument(cwd).providers[key] ?? null;
  let granted = !!record;
  let reason: string | null = null;
  if (record?.dataPolicyHash) {
    // ADR 0017 R6: compare against the current project policy unless the
    // caller injects one explicitly. A tightening or unchanged policy keeps
    // consent; a widening policy requires a fresh grant.
    const current = options.dataPolicy !== undefined ? options.dataPolicy : readDataPolicy(cwd);
    if (hashDataPolicy(current) !== record.dataPolicyHash && policyWidens(record.dataPolicy ?? null, current)) {
      granted = false;
      reason = WIDENED_POLICY_REASON;
    }
  }
  return { provider: key, required: true, granted, source: record ? 'project' : null, token: record?.token ?? null, record, path, reason };
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

async function runSet(rest: string[], deps: SetupDeps): Promise<number> {
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

function runRemove(rest: string[], deps: SetupDeps): number {
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

interface ConsentArgs {
  project: string;
  token?: string;
  positional: string[];
  error?: string;
}

function parseConsentArgs(rest: string[]): ConsentArgs {
  let project = process.cwd();
  let token: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--project') { project = rest[++i] ?? ''; continue; }
    if (arg.startsWith('--project=')) { project = arg.slice('--project='.length); continue; }
    if (arg === '--token') { token = rest[++i]; continue; }
    if (arg.startsWith('--token=')) { token = arg.slice('--token='.length); continue; }
    if (arg.startsWith('-')) return { project, token, positional, error: `Unknown option for auth consent: ${arg}\n${AUTH_USAGE}` };
    positional.push(arg);
  }
  return { project, token, positional };
}

function consentAction(positional: string[]): 'set' | 'remove' | 'status' {
  const first = positional[0];
  let resolvedAction: 'set' | 'remove' | 'status' = 'set';
  if (first === 'remove' || first === 'revoke' || first === 'deny') { resolvedAction = 'remove'; positional.shift(); }
  else if (first === 'status') { resolvedAction = 'status'; positional.shift(); }
  else if (first === 'set' || first === 'grant' || first === 'approve' || first === 'authorize') { resolvedAction = 'set'; positional.shift(); }
  return resolvedAction;
}

function printConsentStatus(project: string, provider: string): number {
  if (provider) {
    process.stdout.write(`${JSON.stringify(readExternalContextConsent(project, provider), null, 2)}\n`);
  } else {
    const document = readConsentDocument(project);
    process.stdout.write(`${JSON.stringify({ path: externalContextConsentPath(project), providers: Object.keys(document.providers).sort() }, null, 2)}\n`);
  }
  return 0;
}

function humanApprovalOptions(deps: SetupDeps): HumanApprovalOptions {
  const injected = (deps as any).humanApproval ?? {};
  return { ...injected, env: injected.env ?? deps.env ?? process.env };
}

async function runConsent(rest: string[], deps: SetupDeps = {}): Promise<number> {
  const parsed = parseConsentArgs(rest);
  if (parsed.error) return fail(parsed.error);
  const { project, token, positional } = parsed;
  if (!project) return fail(AUTH_USAGE);
  const resolvedAction = consentAction(positional);
  const provider = positional[0] ?? '';
  if (resolvedAction === 'status') return printConsentStatus(project, provider);
  if (positional.length !== 1 || !provider) return fail(AUTH_USAGE);
  let dataPolicy: DataPolicy | null = null;
  try {
    if (resolvedAction === 'remove') {
      removeExternalContextConsent(project, provider);
    } else {
      // A grant changes where repository text may go; an agent cannot grant it
      // for the human. A refusal records nothing.
      const action = `junior auth consent grant ${provider} --project ${project}`;
      await requireHuman(action, humanApprovalOptions(deps));
      dataPolicy = readDataPolicy(project);
      recordExternalContextConsent(project, provider, { ...(token ? { scope: [token] } : {}), dataPolicy });
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const status = readExternalContextConsent(project, provider, { dataPolicy });
  process.stdout.write(`${JSON.stringify({ ...status, dataPolicySummary: status.record?.dataPolicySummary ?? null, removed: resolvedAction === 'remove' }, null, 2)}\n`);
  return 0;
}

interface BudgetArgs {
  id: string;
  tokens: number | null;
  project: string;
  error?: string;
}

function parseBudgetArgs(rest: string[]): BudgetArgs {
  let project = process.cwd();
  let tokens: number | null = null;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--project') { project = rest[++i] ?? ''; continue; }
    if (arg.startsWith('--project=')) { project = arg.slice('--project='.length); continue; }
    if (arg === '--tokens') {
      const raw = rest[++i];
      tokens = raw === undefined ? NaN : Number(raw);
      continue;
    }
    if (arg.startsWith('--tokens=')) {
      tokens = Number(arg.slice('--tokens='.length));
      continue;
    }
    if (arg.startsWith('-')) return { id: '', tokens, project, error: `Unknown option for auth budget: ${arg}\n${AUTH_USAGE}` };
    positional.push(arg);
  }
  if (positional[0] !== 'approve') return { id: '', tokens, project, error: `auth budget requires the 'approve' action\n${AUTH_USAGE}` };
  const id = positional[1] ?? '';
  if (positional.length !== 2 || !id.trim()) return { id: '', tokens, project, error: `auth budget approve requires exactly one contract id\n${AUTH_USAGE}` };
  if (!project) return { id, tokens, project, error: AUTH_USAGE };
  if (tokens === null || !Number.isInteger(tokens) || tokens <= 0) {
    return { id, tokens, project, error: 'auth budget approve requires --tokens <positive integer>' };
  }
  return { id: id.trim(), tokens, project };
}

async function runBudget(rest: string[], deps: SetupDeps = {}): Promise<number> {
  const parsed = parseBudgetArgs(rest);
  if (parsed.error) return fail(parsed.error);
  const action = `junior auth budget approve ${parsed.id} --tokens ${parsed.tokens} --project ${parsed.project}`;
  let token: string;
  try {
    token = await requireHuman(action, humanApprovalOptions(deps));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const clock: Clock = (deps as any).clock ?? systemClock;
  let stored;
  try {
    stored = recordBudgetApproval(parsed.project, {
      id: parsed.id,
      maxTotalTokens: parsed.tokens as number,
      token,
    }, clock);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  process.stdout.write(`${JSON.stringify({ ...stored.approval, path: stored.path }, null, 2)}\n`);
  return 0;
}

export async function main(argv: string[], deps: SetupDeps = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${AUTH_USAGE}\n`);
    return 0;
  }
  if (command === 'set') return runSet(rest, deps);
  if (command === 'remove') return runRemove(rest, deps);
  if (command === 'consent' || command === 'approve' || command === 'authorize') return runConsent(rest, deps);
  if (command === 'budget') return runBudget(rest, deps);
  return fail(`Unknown auth command: ${command}\n${AUTH_USAGE}`);
}
