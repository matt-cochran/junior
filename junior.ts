#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Junior handoff CLI.
//
// `handoff` is the compact manager entry point: it runs one bounded task and
// prints a small stable JSON object. `init`, `doctor`, `run`, `validate` and
// `status` are thin adapters over the existing worker/setup structures, so the
// legacy `node worker.ts ...` CLI keeps working unchanged.
//
// A handoff task defaults to `isolation: "worktree"` unless the task explicitly
// sets `isolation: "none"`. Worktree isolation refuses a dirty source checkout,
// so the default is safe (it never silently omits uncommitted work).
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { run, validate, status, type GateDeps } from './worker.ts';
import { doctor, init, parseInitOptions, summarizeInstall } from './setup.ts';
import { compactHandoff, isSuccessOutcome } from './handoff.ts';
import { isDirectEntry, readPackageVersion } from './cli-entry.ts';
import { parseDuration, pruneWorktrees } from './retention.ts';

function usage(): string {
 return [
  'Usage: junior <command> [args]',
  '  handoff <task.json> [--mock] [--full]   run a task and print the compact handoff (default isolation=worktree; qa defaults to none)',
  '  qa      <task.json> [--mock] [--full]   run the report-only QA review workflow in place (fresh reviewer session)',
  '  run     <task.json> [--mock]            run a task with the compact-default isolation',
  '  validate <task.json>                    validate a task contract',
  '  status  <result.json> [--full]          print a compact handoff, or the full status with --full',
  '  tools init|call|inspect ...            persistent FMECA / CPM / Crossmatrix handoff',
  '  doctor                                  read-only readiness check',
  '  prune   [--older-than 24h] [--keep-last N] [--dry-run]',
  '          remove inactive clean retained Junior worktrees',
  '  init    [--install] [--target codex|claude|both|none] [--user]',
  '          [--upgrade] [--force] [--skill-root DIR]   idempotent project setup + skill install',
 ].join('\n');
}

/** Task isolation defaults to `worktree` for the ergonomic handoff entry point;
 * an explicit value (including `none`) is always preserved. The report-only
 * `qa` workflow defaults to `none` so the reviewer sees the subject checkout
 * including uncommitted changes instead of a snapshot of the wrong HEAD. */
export function withHandoffIsolation(raw: any): any {
 if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
 if (raw.isolation === undefined) return { ...raw, isolation: (raw.workflow === 'qa' || (raw.workflow === 'auto' && raw.reviewFrom)) ? 'none' : 'worktree' };
 return raw;
}

// ---------------------------------------------------------------------------
// Strict per-command argument handling.
//
// Each subcommand declares exactly which options it accepts. Help is handled
// before any command-specific work (file writes, installs, provider calls),
// unknown options are rejected, options that require a value must receive one,
// and positional counts are bounded.
// ---------------------------------------------------------------------------

interface CommandSpec {
 flags: string[];
 valueFlags: string[];
 min: number;
 max: number;
 help: string;
}

const COMMANDS: Record<string, CommandSpec> = {
 handoff: { flags: ['--mock', '--full'], valueFlags: [], min: 1, max: 1,
  help: 'Usage: junior handoff <task.json> [--mock] [--full]' },
 qa: { flags: ['--mock', '--full'], valueFlags: [], min: 1, max: 1,
  help: 'Usage: junior qa <task.json> [--mock] [--full]' },
 run: { flags: ['--mock', '--full'], valueFlags: [], min: 1, max: 1,
  help: 'Usage: junior run <task.json> [--mock] [--full]' },
 validate: { flags: [], valueFlags: [], min: 1, max: 1,
  help: 'Usage: junior validate <task.json>' },
 status: { flags: ['--full'], valueFlags: [], min: 1, max: 1,
  help: 'Usage: junior status <result.json> [--full]' },
 doctor: { flags: [], valueFlags: [], min: 0, max: 0,
  help: 'Usage: junior doctor' },
 prune: { flags: ['--dry-run'], valueFlags: ['--older-than', '--keep-last'], min: 0, max: 0,
  help: 'Usage: junior prune [--older-than 24h] [--keep-last N] [--dry-run]' },
 init: {
  flags: ['--install', '--user', '--project', '--upgrade', '--update', '--with-triz', '--force', '--no-skill'],
  valueFlags: ['--target', '--skill-root', '--scope'],
  min: 0,
  max: 0,
  help: [
   'Usage: junior init [--install] [--target codex|claude|both|none] [--user] [--project]',
   '                   [--upgrade] [--force] [--skill-root DIR] [--update] [--with-triz]',
  ].join('\n'),
 },
};

const INIT_TARGETS = ['codex', 'claude', 'both', 'none'];
const INIT_SCOPES = ['user', 'project'];

/** True when the user asked for command help; checked before any side effects. */
function wantsHelp(args: string[]): boolean {
 return args.includes('--help') || args.includes('-h');
}

interface ParsedCommand {
 flags: Set<string>;
 values: Record<string, string>;
 files: string[];
}

function parseCommand(command: string, spec: CommandSpec, args: string[]): ParsedCommand {
 const flags = new Set<string>();
 const values: Record<string, string> = {};
 const files: string[] = [];
 for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--') {
   files.push(...args.slice(i + 1));
   break;
  }
  if (arg.startsWith('--')) {
   const eq = arg.indexOf('=');
   const name = eq === -1 ? arg : arg.slice(0, eq);
   const inline = eq === -1 ? undefined : arg.slice(eq + 1);
   if (spec.flags.includes(name)) {
    if (inline !== undefined) throw Error(`Option ${name} does not take a value`);
    flags.add(name);
    continue;
   }
   if (spec.valueFlags.includes(name)) {
    let value = inline;
    if (value === undefined) value = args[++i];
    if (value === undefined || value === '' || value.startsWith('-')) throw Error(`Option ${name} requires a value`);
    values[name] = value;
    continue;
   }
   throw Error(`Unknown option for ${command}: ${name}`);
  }
  if (arg.startsWith('-') && arg !== '-') throw Error(`Unknown option for ${command}: ${arg}`);
  files.push(arg);
 }
 if (files.length < spec.min) throw Error(spec.help);
 if (files.length > spec.max) throw Error(`Too many arguments for ${command}: expected at most ${spec.max}`);
 return { flags, values, files };
}

async function main(argv: string[]): Promise<void> {
 const command = argv[0];
 const rest = argv.slice(1);
 if (!command || command === '--help' || command === '-h' || command === 'help') { console.log(usage()); return; }
 if (command === '--version' || command === '-v' || command === 'version') { console.log(readPackageVersion(import.meta.url)); return; }
 if (command === 'tools') { const tools = await import('./tools/tools.ts'); process.exitCode = await tools.main(rest); return; }

 const spec = COMMANDS[command];
 if (!spec) throw Error(usage());
 if (wantsHelp(rest)) { console.log(spec.help); return; }
 const parsed = parseCommand(command, spec, rest);

 if (command === 'doctor') {
  const result = doctor();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
  return;
 }
 if (command === 'prune') {
  const olderRaw = parsed.values['--older-than'];
  let olderThanMs: number | undefined;
  if (olderRaw !== undefined) {
   const parsedMs = parseDuration(olderRaw);
   if (parsedMs === null) throw Error(`Invalid --older-than duration: ${olderRaw} (use e.g. 30m, 24h, 7d)`);
   olderThanMs = parsedMs;
  }
  const keepRaw = parsed.values['--keep-last'];
  let keepLast: number | undefined;
  if (keepRaw !== undefined) {
   keepLast = Number(keepRaw);
   if (!Number.isInteger(keepLast) || keepLast < 0) throw Error(`Invalid --keep-last count: ${keepRaw}`);
  }
  const result = pruneWorktrees(process.cwd(), { olderThanMs, keepLast, dryRun: parsed.flags.has('--dry-run') });
  console.log(JSON.stringify(result, null, 2));
  return;
 }
 if (command === 'init') {
  const target = parsed.values['--target'];
  if (target !== undefined && !INIT_TARGETS.includes(target)) throw Error(`Invalid --target value: ${target}`);
  const scope = parsed.values['--scope'];
  if (scope !== undefined && !INIT_SCOPES.includes(scope)) throw Error(`Invalid --scope value: ${scope}`);
  const opts = parseInitOptions(rest);
  const result:any = init({}, opts);
  if (opts.install) {
   const installer = await import('./installer.ts');
   const report = await installer.installTools({ update: opts.update, withTriz: opts.withTriz });
   result.tools = report;
   // Distinguish the Pi and prebuilt-tools attempts and report combined truthfully.
   result.installSummary = summarizeInstall(result.install, report);
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.installSummary && !result.installSummary.ok) process.exitCode = 1;
  return;
 }
 if (command === 'validate') {
  const path = parsed.files[0];
  const t = validate(JSON.parse(readFileSync(path, 'utf8')));
  console.log(JSON.stringify({ valid: true, id: t.id }, null, 2));
  return;
 }
 if (command === 'status') {
  const path = parsed.files[0];
  if (parsed.flags.has('--full')) {
   console.log(JSON.stringify(status(path), null, 2));
  } else {
   status(path); // Validate the full saved result before projecting a compact receipt.
   const raw = JSON.parse(readFileSync(path, 'utf8'));
   console.log(JSON.stringify(compactHandoff(raw), null, 2));
  }
  return;
 }
 if (command === 'run' || command === 'handoff' || command === 'qa') {
  const path = parsed.files[0];
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const task = withHandoffIsolation(command === 'qa' ? { ...raw, workflow: 'qa' } : raw);
  const mock = parsed.flags.has('--mock');
  const deps: GateDeps = {};
  const result = await run(task, mock, deps);
  console.log(JSON.stringify(parsed.flags.has('--full') ? result : compactHandoff(result), null, 2));
  if (!isSuccessOutcome(result.status)) process.exitCode = 1;
  return;
 }
 throw Error(usage());
}

if (isDirectEntry(import.meta.url)) {
 main(process.argv.slice(2)).catch((e) => { console.error(String(e)); process.exitCode = 1; });
}
