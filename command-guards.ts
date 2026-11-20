// ---------------------------------------------------------------------------
// Default command guards (#281).
//
// The guards are policy defaults, not placement rules: they apply even when a
// contract has no `commandPolicy` at all. `guardCommand` is pure and decides
// only from the argv it is given and the run's last build state. Callers record
// the returned event and act on `action`.
// ---------------------------------------------------------------------------

import { basename } from 'node:path';
import type { PolicyEvent } from './policy-events.ts';
import {
  DEFAULT_COMMAND_GUARDS,
  stripCommandPrefixes,
  type ResolvedGuards,
} from './command-policy.ts';

export { DEFAULT_COMMAND_GUARDS };
export type { ResolvedGuards };

/** Recorded on a check refused by a default command guard. */
export const POLICY_GUARD_ERROR = 'E_POLICY_GUARD';
/** Recorded on a check that ran but its evidence is stale. */
export const STALE_EVIDENCE_ERROR = 'E_STALE_EVIDENCE';

export type BuildState = 'ok' | 'failed' | 'none';

export interface GuardContext {
  source: PolicyEvent['source'];
  lastBuild: BuildState;
  guards: ResolvedGuards;
}

export interface GuardDecision {
  action: 'refuse' | 'flag_stale';
  event: PolicyEvent;
}

const HOOK_BYPASS_ENV: Record<string, string[]> = {
  HUSKY: ['0'],
  HUSKY_SKIP_HOOKS: ['1', 'true'],
  SKIP_HOOKS: ['1', 'true'],
  LEFTHOOK: ['0'],
};

const TEST_GOALS = new Set(['test', 'verify', 'integration-test']);

/** The first token that is not an option, ignoring `--`. */
function firstNonOption(tokens: string[]): string | undefined {
  for (const token of tokens) {
    if (token === '--') continue;
    if (!token.startsWith('-')) return token;
  }
  return undefined;
}

function isPackageManager(program: string): boolean {
  return program === 'npm' || program === 'pnpm' || program === 'yarn';
}

function packageScript(tokens: string[]): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === '--') return tokens[index + 1];
    if (!tokens[index].startsWith('-')) return tokens[index];
  }
  return undefined;
}

/** True when argv builds the project, so its exit code can set `lastBuild`. */
export function isBuildCommand(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  const normalized = stripCommandPrefixes([...argv]);
  if (normalized.opaque || normalized.argv.length === 0) return false;

  const program = basename(normalized.argv[0]);
  const rest = normalized.argv.slice(1);

  if (program === 'tsc') return true;
  if (program === 'dotnet' || program === 'cargo' || program === 'go') {
    return firstNonOption(rest) === 'build';
  }
  if (program === 'mvn' || program === 'mvnw') {
    return rest.some((token) => !token.startsWith('-') && token === 'compile');
  }
  if (program === 'gradle' || program === 'gradlew') {
    return rest.some((token) => !token.startsWith('-') && token === 'build');
  }
  if (program === 'npx') return firstNonOption(rest) === 'tsc';
  if (isPackageManager(program)) {
    if (rest[0] === 'run' || rest[0] === 'run-script') {
      return packageScript(rest.slice(1)) === 'build';
    }
    return firstNonOption(rest) === 'build';
  }
  return false;
}

/** True when argv is a test command that can suppress its build step. */
function isNoBuildTest(argv: string[]): boolean {
  if (argv.length === 0) return false;
  const program = basename(argv[0]);
  const rest = argv.slice(1);

  if (program === 'dotnet') {
    return firstNonOption(rest) === 'test' && rest.includes('--no-build');
  }
  if (program === 'mvn' || program === 'mvnw') {
    const goal = firstNonOption(rest);
    const skipsBuild = rest.some(
      (token) => token === '-Dmaven.main.skip' || token.startsWith('-Dmaven.main.skip='),
    );
    return goal !== undefined && TEST_GOALS.has(goal) && skipsBuild;
  }
  return false;
}

function assignmentValue(token: string): { key: string; value: string } | null {
  const equals = token.indexOf('=');
  if (equals <= 0) return null;
  return { key: token.slice(0, equals), value: token.slice(equals + 1) };
}

function envHookBypass(assignments: readonly string[]): string | null {
  for (const token of assignments) {
    const parsed = assignmentValue(token);
    if (!parsed) continue;
    const allowed = HOOK_BYPASS_ENV[parsed.key];
    if (allowed?.includes(parsed.value)) {
      return `environment prefix ${parsed.key}=${parsed.value}`;
    }
  }
  return null;
}

function gitHookBypass(tokens: string[]): string | null {
  if (tokens.length === 0 || basename(tokens[0]) !== 'git') return null;
  const args = tokens.slice(1);

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--no-verify') return '--no-verify';
    if (token === '-c' && /^core\.hooksPath=/i.test(args[index + 1] ?? '')) {
      return `-c ${args[index + 1]}`;
    }
    if (/^-ccore\.hooksPath=/i.test(token)) return token;
  }

  const config = args.indexOf('config');
  if (config !== -1 && args.slice(config + 1).some((token) => token.toLowerCase() === 'core.hookspath')) {
    return 'config core.hooksPath';
  }
  return null;
}

/**
 * Apply the default guards to one command. Returns null when the command is
 * allowed. A `refuse` decision must not run; a `flag_stale` decision runs but
 * its evidence is not trustworthy.
 */
export function guardCommand(argv: string[], ctx: GuardContext): GuardDecision | null {
  if (argv.length === 0) return null;
  const command = argv.join(' ');
  const normalized = stripCommandPrefixes(argv.slice());
  if (normalized.opaque || normalized.argv.length === 0) return null;

  const guards = ctx.guards ?? DEFAULT_COMMAND_GUARDS;

  if (guards.noBuild !== 'off' && ctx.lastBuild !== 'ok' && isNoBuildTest(normalized.argv)) {
    const kind = ctx.lastBuild === 'failed' ? 'no_build_after_failed_build' : 'no_build_without_build';
    const reason = ctx.lastBuild === 'failed'
      ? `${command} runs tests with --no-build after a failed build in this run`
      : `${command} runs tests with --no-build without any build in this run`;
    const action = guards.noBuild === 'stale' ? 'flag_stale' : 'refuse';
    return {
      action,
      event: {
        kind,
        action: action === 'refuse' ? 'refused' : 'flagged_stale',
        source: ctx.source,
        command,
        reason: `${POLICY_GUARD_ERROR}: ${reason}`,
      },
    };
  }

  if (guards.hookBypass !== 'off') {
    const hookReason =
      envHookBypass(normalized.assignments ?? []) ?? gitHookBypass(normalized.argv);
    if (hookReason) {
      return {
        action: 'refuse',
        event: {
          kind: 'hook_bypass',
          action: 'refused',
          source: ctx.source,
          command,
          reason: `${POLICY_GUARD_ERROR}: ${command} bypasses git hooks (${hookReason})`,
        },
      };
    }
  }

  return null;
}
