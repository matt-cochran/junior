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
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import process from 'node:process';
import { checkCredentialsOnline, type SetupDeps } from './setup.ts';

export const AUTH_USAGE = [
  'Usage: junior auth set <provider> [--verify]',
  '       junior auth remove <provider>',
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
  return fail(`Unknown auth command: ${command}\n${AUTH_USAGE}`);
}