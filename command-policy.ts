// ---------------------------------------------------------------------------
// Contract command placement (ADR 0015 R6, CMD1a).
//
// A contract may declare where commands are allowed to run. Remote-only rules
// are the security boundary: a matching command is allowed only when argv[0]
// is the configured wrapper. This module is pure and offline. It parses the
// contract policy and its manifest adapter, normalizes direct argv (prefixes
// and chains), matches ordered rules, and checks wrapper identity.
//
// CMD1a intentionally does not resolve shell -c scripts, package-manager
// scripts, npx, or dynamic evaluation; CMD1b adds those resolvers. Anything
// this module cannot prove is refused when `enforce` is true.
// ---------------------------------------------------------------------------

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

/** Recorded on a refused command/tool/check result. */
export const COMMAND_PLACEMENT_ERROR = 'E_COMMAND_PLACEMENT';

export type CommandPlacement = 'local' | 'remote' | 'unknown';
export type CommandVerdict = 'allow' | 'refuse';

export interface CommandRule {
  match: string[];
  placement: 'local' | 'remote';
  wrapper?: string;
}

export interface CommandPolicy {
  enforce: boolean;
  rules: CommandRule[];
}

export interface CommandDecision {
  decision: CommandVerdict;
  placement: CommandPlacement;
  rule?: CommandRule;
  wrapper?: string;
  reason?: string;
}

/** Contract-policy validation failures are ordinary errors so the contract
 * validator can surface the message before any paid work starts. */
export class CommandPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandPolicyError';
  }
}

const CONTRACT_FIELDS = ['enforce', 'manifest', 'rules'];
const MANIFEST_FIELDS = ['version', 'rules'];
const RULE_FIELDS = ['match', 'placement', 'wrapper'];
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The cwd a parsed policy resolves relative wrapper paths against. Kept out
 * of the public shape so a policy stays a plain `{enforce, rules}` value. */
const policyCwds = new WeakMap<CommandPolicy, string>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new CommandPolicyError(message);
}

function assertKnownFields(value: Record<string, unknown>, allowed: string[], source: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${source}: unknown field "${key}"`);
  }
}

function stringArray(value: unknown, source: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${source}: expected a non-empty string array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      fail(`${source}[${index}]: expected a non-empty string`);
    }
    return entry.trim();
  });
}

function assertWrapperInsideCwd(wrapper: string, cwd: string, source: string): void {
  if (wrapper.startsWith('~') || isAbsolute(wrapper)) return;
  const root = resolve(cwd);
  const target = resolve(root, wrapper);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    fail(`${source}: wrapper "${wrapper}" escapes the contract cwd`);
  }
}

function validateRule(raw: unknown, source: string, cwd?: string): CommandRule {
  if (!isPlainObject(raw)) fail(`${source}: expected an object`);
  assertKnownFields(raw, RULE_FIELDS, source);

  const match = stringArray(raw.match, `${source}.match`);
  if (raw.placement !== 'local' && raw.placement !== 'remote') {
    fail(`${source}.placement: expected "local" or "remote"`);
  }

  if (raw.placement === 'remote') {
    if (typeof raw.wrapper !== 'string' || !raw.wrapper.trim()) {
      fail(`${source}.wrapper: required for a remote rule`);
    }
    const wrapper = raw.wrapper.trim();
    if (cwd) assertWrapperInsideCwd(wrapper, cwd, source);
    return { match, placement: 'remote', wrapper };
  }

  if ('wrapper' in raw) fail(`${source}.wrapper: only valid for a remote rule`);
  return { match, placement: 'local' };
}

/** Validate the pinned `scripts/devbox/command-placement.json` schema. */
export function parseCommandManifest(
  value: unknown,
  source = 'command-placement manifest',
  cwd?: string,
): CommandRule[] {
  if (!isPlainObject(value)) fail(`${source}: expected an object`);
  assertKnownFields(value, MANIFEST_FIELDS, source);
  if ('version' in value && value.version !== 1) {
    fail(`${source}.version: expected 1`);
  }
  if (!Array.isArray(value.rules) || value.rules.length === 0) {
    fail(`${source}.rules: expected a non-empty array`);
  }
  return value.rules.map((rule, index) => validateRule(rule, `${source}.rules[${index}]`, cwd));
}

/** Read a manifest path relative to the contract cwd. Absolute paths and
 * `..` escapes are rejected; a malformed manifest is never a silent no-op. */
export function readCommandManifest(manifestPath: string, cwd: string): CommandRule[] {
  if (typeof manifestPath !== 'string' || !manifestPath.trim()) {
    fail('commandPolicy.manifest: expected a non-empty string');
  }
  const path = manifestPath.trim();
  if (isAbsolute(path)) fail(`commandPolicy.manifest: "${path}" must be relative to the contract cwd`);

  const root = resolve(cwd);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    fail(`commandPolicy.manifest: "${path}" escapes the contract cwd`);
  }

  let text: string;
  try {
    text = readFileSync(target, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`commandPolicy.manifest: cannot read "${path}": ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`commandPolicy.manifest: invalid JSON in "${path}": ${message}`);
  }
  return parseCommandManifest(parsed, `commandPolicy.manifest "${path}"`, cwd);
}

/**
 * Validate a contract `commandPolicy`. Contract rules come first; manifest
 * rules follow. `null`/`undefined` means the contract has no policy and the
 * caller should pass `null` to `decideCommand`.
 */
export function parseCommandPolicy(value: unknown, cwd: string): CommandPolicy | null {
  if (value === undefined || value === null) return null;

  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(`commandPolicy: invalid JSON: ${message}`);
    }
  }
  if (!isPlainObject(raw)) fail('commandPolicy: expected an object');
  assertKnownFields(raw, CONTRACT_FIELDS, 'commandPolicy');

  if (typeof raw.enforce !== 'boolean') {
    fail('commandPolicy.enforce: expected a boolean');
  }

  const contractRules: CommandRule[] = [];
  if ('rules' in raw) {
    if (!Array.isArray(raw.rules) || raw.rules.length === 0) {
      fail('commandPolicy.rules: expected a non-empty array');
    }
    raw.rules.forEach((rule, index) => {
      contractRules.push(validateRule(rule, `commandPolicy.rules[${index}]`, cwd));
    });
  }

  let manifestRules: CommandRule[] = [];
  if ('manifest' in raw) {
    if (typeof raw.manifest !== 'string' || !raw.manifest.trim()) {
      fail('commandPolicy.manifest: expected a non-empty string');
    }
    manifestRules = readCommandManifest(raw.manifest, cwd);
  }

  if (contractRules.length === 0 && manifestRules.length === 0) {
    fail('commandPolicy: expected rules or a manifest');
  }

  const policy: CommandPolicy = {
    enforce: raw.enforce,
    rules: [...contractRules, ...manifestRules],
  };
  policyCwds.set(policy, resolve(cwd));
  return policy;
}

// ---------------------------------------------------------------------------
// Direct argv normalization
// ---------------------------------------------------------------------------

interface PrefixResult {
  argv: string[];
  opaque?: string;
}

function stripEnv(rest: string[]): PrefixResult {
  let index = 0;
  while (index < rest.length) {
    const token = rest[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (
      token === '-i' ||
      token === '--ignore-environment' ||
      token === '-0' ||
      token === '--null' ||
      token === '--debug' ||
      token === '-v' ||
      token === '--verbose'
    ) {
      index += 1;
      continue;
    }
    if (token === '-u' || token === '--unset' || token === '-C' || token === '--chdir') {
      if (index + 1 >= rest.length) {
        return { argv: rest.slice(index), opaque: `env option ${token} without a value` };
      }
      index += 2;
      continue;
    }
    if (token.startsWith('--unset=') || token.startsWith('--chdir=')) {
      index += 1;
      continue;
    }
    if (token === '-S' || token === '--split-string' || token.startsWith('--split-string=')) {
      return { argv: rest.slice(index), opaque: 'env split-string' };
    }
    if (/^-[i0v]+$/.test(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      return { argv: rest.slice(index), opaque: `env option ${token}` };
    }
    break;
  }
  while (index < rest.length && ASSIGNMENT.test(rest[index])) index += 1;
  return { argv: rest.slice(index) };
}

function stripCommand(rest: string[]): PrefixResult {
  let index = 0;
  while (index < rest.length) {
    const token = rest[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (token === '-p') {
      index += 1;
      continue;
    }
    if (token === '-v' || token === '-V') {
      return { argv: rest.slice(index), opaque: 'command lookup' };
    }
    if (token.startsWith('-') && token !== '-') {
      return { argv: rest.slice(index), opaque: `command option ${token}` };
    }
    break;
  }
  return { argv: rest.slice(index) };
}

function stripExec(rest: string[]): PrefixResult {
  let index = 0;
  while (index < rest.length) {
    const token = rest[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (token === '-c' || token === '-l' || token === '--login' || /^-[cl]+$/.test(token)) {
      index += 1;
      continue;
    }
    if (token === '-a') {
      if (index + 1 >= rest.length) {
        return { argv: rest.slice(index), opaque: 'exec -a without a name' };
      }
      index += 2;
      continue;
    }
    if (token.startsWith('-a') && token.length > 2) {
      index += 1;
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      return { argv: rest.slice(index), opaque: `exec option ${token}` };
    }
    break;
  }
  return { argv: rest.slice(index) };
}

function stripTimeout(rest: string[]): PrefixResult {
  let index = 0;
  while (index < rest.length) {
    const token = rest[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (token === '--foreground' || token === '--preserve-status' || token === '--verbose' || token === '-v') {
      index += 1;
      continue;
    }
    if (token === '-k' || token === '--kill-after' || token === '-s' || token === '--signal') {
      if (index + 1 >= rest.length) {
        return { argv: rest.slice(index), opaque: `timeout option ${token} without a value` };
      }
      index += 2;
      continue;
    }
    if (token.startsWith('--kill-after=') || token.startsWith('--signal=')) {
      index += 1;
      continue;
    }
    if ((token.startsWith('-k') || token.startsWith('-s')) && token.length > 2) {
      index += 1;
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      return { argv: rest.slice(index), opaque: `timeout option ${token}` };
    }
    break;
  }
  if (index >= rest.length) {
    return { argv: rest.slice(index), opaque: 'timeout without a duration' };
  }
  index += 1; // the duration
  return { argv: rest.slice(index) };
}

function stripNice(rest: string[]): PrefixResult {
  let index = 0;
  while (index < rest.length) {
    const token = rest[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (token === '-n' || token === '--adjustment') {
      if (index + 1 >= rest.length) {
        return { argv: rest.slice(index), opaque: `nice option ${token} without a value` };
      }
      index += 2;
      continue;
    }
    if (token.startsWith('--adjustment=') || /^-n\d+$/.test(token) || /^-\d+$/.test(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      return { argv: rest.slice(index), opaque: `nice option ${token}` };
    }
    break;
  }
  return { argv: rest.slice(index) };
}

/** Strip leading assignments and transparent env/command/exec/timeout/nice
 * prefixes. Unrecognized prefix options are opaque, not silently ignored. */
function stripPrefixes(argv: string[]): PrefixResult {
  let tokens = argv.slice();
  let opaque: string | undefined;
  for (let guard = 0; guard < 64; guard += 1) {
    if (tokens.length === 0) break;
    if (ASSIGNMENT.test(tokens[0])) {
      tokens = tokens.slice(1);
      continue;
    }

    const program = basename(tokens[0]);
    let result: PrefixResult | null = null;
    if (program === 'env') result = stripEnv(tokens.slice(1));
    else if (program === 'command') result = stripCommand(tokens.slice(1));
    else if (program === 'exec') result = stripExec(tokens.slice(1));
    else if (program === 'timeout') result = stripTimeout(tokens.slice(1));
    else if (program === 'nice') result = stripNice(tokens.slice(1));

    if (!result) break;
    tokens = result.argv;
    if (result.opaque) {
      opaque = result.opaque;
      break;
    }
  }
  return { argv: tokens, opaque };
}

// ---------------------------------------------------------------------------
// Tokenization and chain splitting (string input only)
// ---------------------------------------------------------------------------

interface Tokenized {
  segments: string[][];
  opaque?: string;
}

function tokenize(input: string): Tokenized {
  const segments: string[][] = [];
  let current: string[] = [];
  let token = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  let opaque: string | undefined;

  const pushToken = (): void => {
    if (started) {
      current.push(token);
      token = '';
      started = false;
    }
  };
  const pushSegment = (): void => {
    pushToken();
    if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quote) {
      if (char === quote) {
        quote = null;
        started = true;
        continue;
      }
      if (quote === '"' && char === '\\') {
        const next = input[index + 1];
        if (next === '$' || next === '`' || next === '"' || next === '\\' || next === '\n') {
          token += next;
          started = true;
          index += 1;
          continue;
        }
      }
      // Double quotes still perform command substitution; single quotes do not.
      if (quote === '"' && char === '`') opaque = 'command substitution';
      if (quote === '"' && char === '$' && input[index + 1] === '(') {
        opaque = 'command substitution';
      }
      token += char;
      started = true;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === '\\') {
      const next = input[index + 1];
      if (next === undefined) {
        opaque = 'trailing escape';
        started = true;
        continue;
      }
      token += next;
      started = true;
      index += 1;
      continue;
    }
    if (char === '`') {
      opaque = 'command substitution';
      token += char;
      started = true;
      continue;
    }
    if (char === '$' && input[index + 1] === '(') {
      opaque = 'command substitution';
      token += char;
      started = true;
      continue;
    }
    if ((char === '<' || char === '>') && input[index + 1] === '(') {
      opaque = 'process substitution';
      token += char;
      started = true;
      continue;
    }

    if (char === ' ' || char === '\t' || char === '\r') {
      pushToken();
      continue;
    }
    if (char === '\n' || char === ';') {
      pushSegment();
      continue;
    }
    if (char === '&') {
      const next = input[index + 1];
      // `2>&1`, `&>file`: a redirection, not a background separator.
      if (next === '>' || ((token.endsWith('>') || token.endsWith('<')) && /[0-9-]/.test(next ?? ''))) {
        token += char;
        started = true;
        continue;
      }
      pushSegment();
      if (next === '&') index += 1;
      continue;
    }
    if (char === '|') {
      pushSegment();
      if (input[index + 1] === '|') index += 1;
      continue;
    }

    token += char;
    started = true;
  }

  if (quote) return { segments, opaque: 'unterminated quote' };
  pushSegment();
  return { segments, opaque };
}

// ---------------------------------------------------------------------------
// Matching and wrapper identity
// ---------------------------------------------------------------------------

function homeDir(): string {
  const home = process.env.HOME;
  return typeof home === 'string' && home.trim() ? home : homedir();
}

function expandHome(path: string): string {
  if (path === '~') return homeDir();
  if (path.startsWith('~/')) return join(homeDir(), path.slice(2));
  return path;
}

/** Expand `~` against the child HOME, resolve against the contract cwd, and
 * canonicalise symlinks when the path exists. */
function canonicalPath(path: string, cwd: string): string {
  const expanded = expandHome(path.trim());
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

interface WrapperMatch {
  configured: string;
  canonical: string;
}

function findWrapper(policy: CommandPolicy, token: string, cwd: string): WrapperMatch | undefined {
  const canonical = canonicalPath(token, cwd);
  for (const rule of policy.rules) {
    if (rule.placement !== 'remote' || !rule.wrapper) continue;
    const wrapper = canonicalPath(rule.wrapper, cwd);
    if (wrapper === canonical) return { configured: rule.wrapper, canonical: wrapper };
  }
  return undefined;
}

function matchesRule(rule: CommandRule, argv: string[]): boolean {
  return rule.match.some((entry) => {
    const prefix = entry.trim().split(/\s+/).filter(Boolean);
    if (prefix.length === 0 || prefix.length > argv.length) return false;
    return prefix.every((token, index) => token === argv[index]);
  });
}

function firstMatchingRule(policy: CommandPolicy, argv: string[]): CommandRule | undefined {
  return policy.rules.find((rule) => matchesRule(rule, argv));
}

function refusal(
  placement: CommandPlacement,
  reason: string,
  rule?: CommandRule,
  wrapper?: string,
): CommandDecision {
  return {
    decision: 'refuse',
    placement,
    ...(rule ? { rule } : {}),
    ...(wrapper ? { wrapper } : {}),
    reason: `${COMMAND_PLACEMENT_ERROR}: ${reason}`,
  };
}

function allow(
  placement: CommandPlacement,
  rule?: CommandRule,
  wrapper?: string,
): CommandDecision {
  return {
    decision: 'allow',
    placement,
    ...(rule ? { rule } : {}),
    ...(wrapper ? { wrapper } : {}),
  };
}

function decideSegment(policy: CommandPolicy, tokens: string[], enforce: boolean): CommandDecision {
  const normalized = stripPrefixes(tokens);
  if (normalized.opaque) {
    if (enforce) return refusal('unknown', `cannot prove placement for ${normalized.opaque}`);
    return allow('unknown');
  }

  const argv = normalized.argv;
  if (argv.length === 0) {
    if (enforce) return refusal('unknown', 'empty command cannot be placed');
    return allow('unknown');
  }

  const cwd = policyCwds.get(policy) ?? process.cwd();
  const invoked = findWrapper(policy, argv[0], cwd);
  const command = invoked ? argv.slice(1) : argv;
  if (command.length === 0) {
    if (enforce) return refusal('unknown', `wrapper ${argv[0]} was invoked without a command`);
    return allow('unknown');
  }

  const rule = firstMatchingRule(policy, command);
  if (!rule) {
    if (enforce) {
      return refusal('unknown', `no rule matches "${command.join(' ')}" under enforce`);
    }
    return allow('unknown');
  }

  if (rule.placement === 'local') {
    if (invoked) {
      if (enforce) {
        return refusal('local', `wrapper ${invoked.configured} is only valid for a remote command`, rule);
      }
      return allow('local', rule);
    }
    return allow('local', rule);
  }

  const expected = canonicalPath(rule.wrapper as string, cwd);
  if (invoked && invoked.canonical === expected) {
    return allow('remote', rule, rule.wrapper);
  }

  if (enforce) {
    const configured = rule.wrapper as string;
    const expanded = canonicalPath(configured, cwd);
    const label = expanded === configured ? configured : `${configured} (${expanded})`;
    return refusal(
      'remote',
      `remote command "${command.join(' ')}" must run through ${label}`,
      rule,
      configured,
    );
  }
  return allow('remote', rule, rule.wrapper);
}

/**
 * Decide a direct argv (or a shell-like command string). Without a policy
 * every command is allowed with placement `unknown`. Under `enforce: true`,
 * unmatched commands and opaque constructs are refused.
 */
export function decideCommand(
  policy: CommandPolicy | null,
  argv: string[] | string,
): CommandDecision {
  if (!policy) return allow('unknown');

  const enforce = policy.enforce === true;
  let segments: string[][];
  let opaque: string | undefined;

  if (typeof argv === 'string') {
    const tokenized = tokenize(argv);
    segments = tokenized.segments;
    opaque = tokenized.opaque;
  } else {
    segments = [argv.slice()];
  }

  if (opaque) {
    if (enforce) return refusal('unknown', `cannot prove placement for ${opaque}`);
    return allow('unknown');
  }

  if (segments.length === 0) {
    if (enforce) return refusal('unknown', 'empty command cannot be placed');
    return allow('unknown');
  }

  const results = segments.map((segment) => decideSegment(policy, segment, enforce));
  const refusals = results.filter((result) => result.decision === 'refuse');

  if (refusals.length > 0) {
    // Prefer a refusal that names a real placement over an unmatched segment,
    // so `echo ok && npm test` reports the remote rule that refused it.
    return refusals.find((result) => result.placement !== 'unknown') ?? refusals[0];
  }

  const remote = results.find((result) => result.placement === 'remote');
  if (remote) return allow('remote', remote.rule, remote.wrapper);

  const local = results.find((result) => result.placement === 'local');
  if (local) return allow('local', local.rule);

  return allow('unknown');
}
