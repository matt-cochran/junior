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
import { join, resolve } from 'node:path';
import { run, validate, contractWarnings, status, type GateDeps } from './worker.ts';
import { doctor, init, parseInitOptions, setupCompanions, summarizeInstall, checkCredentialsOnline, detectSlowMount, type InitOptions } from './setup.ts';
import { installationDisabled } from './companions.ts';
import { compactHandoff, isSuccessOutcome } from './handoff.ts';
import { refreshUpdateCache } from './update-check.ts';
import { isDirectEntry, readPackageVersion } from './cli-entry.ts';
import { parseDuration, pruneWorktrees } from './retention.ts';
import { chooseBrief, readLatestBrief } from './prepare.ts';

function usage(): string {
 return [
  'Usage: junior <command> [args]',
  '  handoff <task.json> [--mock] [--full]   run a task and print the compact handoff (default isolation=worktree; qa defaults to none)',
  '  qa      <task.json> [--mock] [--full]   run the report-only QA review workflow in place (fresh reviewer session)',
  '  run     <task.json> [--mock]            run a task with the compact-default isolation',
  '  validate <task.json>                    validate a task contract',
  '  status  <result.json> [--full]          print a compact handoff, or the full status with --full',
  '  model status|list|upgrade ...; tools init|call|inspect ...; mcp register ...; matrix export --source code|tests|jevitate|cpm|fmeca; report-issue <tool> --title <t> [--file]',
  '  auth    set <provider> [--verify] | remove <provider>   store a provider key from stdin',
  '  doctor  [--check-updates] [--online] [--harness <claude|cursor|codex>]   read-only readiness check (--check-updates asks npm/GitHub; --online verifies provider credit)',
  '  prune   [--older-than 24h] [--keep-last N] [--dry-run]   remove inactive clean retained worktrees; setup [--harness H] [--hop F] [--yes] [--dry-run]',
  '  init    [--no-install] [--no-companions] [--target ...]   project setup; installs Pi, tools, companions, skills',
  '  update  [--target ...] [--with-triz]    adopt newer managed + companion tools and unmodified skills',
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
 handoff: { flags: ['--mock', '--full', '--quiet'], valueFlags: ['--choose', '--correct', '--answers'], min: 1, max: 1,
  help: 'Usage: junior handoff <task.json> [--answers <answers.json>] [--choose <option>] [--correct <id>=<text> ...] [--mock] [--full] [--quiet]' },
 qa: { flags: ['--mock', '--full', '--quiet'], valueFlags: [], min: 1, max: 1,
  help: 'Usage: junior qa <task.json> [--mock] [--full] [--quiet]' },
 run: { flags: ['--mock', '--full', '--quiet'], valueFlags: [], min: 1, max: 1,
  help: 'Usage: junior run <task.json> [--mock] [--full] [--quiet]' },
 validate: { flags: [], valueFlags: [], min: 1, max: 1,
  help: 'Usage: junior validate <task.json>' },
 status: { flags: ['--full', '--live'], valueFlags: [], min: 1, max: 1,
  help: 'Usage: junior status <result.json|artifactDir> [--full] [--live]' },
 doctor: { flags: ['--check-updates', '--online'], valueFlags: ['--harness'], min: 0, max: 0,
  help: 'Usage: junior doctor [--check-updates] [--online] [--harness claude|cursor|codex]' },
 setup: { flags: ['--yes', '--dry-run'], valueFlags: ['--harness', '--hop'], min: 0, max: 0,
  help: 'Usage: junior setup [--harness claude|cursor|codex] [--hop <hop.json>] [--yes] [--dry-run]' },
 update: {
  flags: ['--user', '--project', '--with-triz', '--force', '--no-skill', '--no-companions', '--no-self'],
  valueFlags: ['--target', '--skill-root', '--scope'],
  min: 0,
  max: 0,
  help: 'Usage: junior update [--target codex|claude|both|none] [--user] [--with-triz] [--no-companions]',
 },
 prune: { flags: ['--dry-run'], valueFlags: ['--older-than', '--keep-last'], min: 0, max: 0,
  help: 'Usage: junior prune [--older-than 24h] [--keep-last N] [--dry-run]' },
 model: { flags: ['--online', '--dry-run', '--yes'], valueFlags: ['--vendor', '--profile', '--to'], min: 1, max: 1,
  help: 'Usage: junior model status [--online] | list [--online] [--vendor v] | upgrade [--profile p] [--to id] [--online] [--dry-run] [--yes]' },
 init: {
  flags: ['--install', '--no-install', '--no-companions', '--user', '--project', '--upgrade', '--update', '--with-triz', '--force', '--no-skill'],
  valueFlags: ['--target', '--skill-root', '--scope'],
  min: 0,
  max: 0,
  help: [
   'Usage: junior init [--no-install] [--no-companions] [--target codex|claude|both|none] [--user] [--project]',
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
 /** Every value for a repeatable value flag, in order (e.g. --correct). */
 multi: Record<string, string[]>;
 files: string[];
}

function parseCommand(command: string, spec: CommandSpec, args: string[]): ParsedCommand {
 const flags = new Set<string>();
 const values: Record<string, string> = {};
 const multi: Record<string, string[]> = {};
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
    (multi[name] ??= []).push(value);
    continue;
   }
   throw Error(`Unknown option for ${command}: ${name}`);
  }
  if (arg.startsWith('-') && arg !== '-') throw Error(`Unknown option for ${command}: ${arg}`);
  files.push(arg);
 }
 if (files.length < spec.min) throw Error(spec.help);
 if (files.length > spec.max) throw Error(`Too many arguments for ${command}: expected at most ${spec.max}`);
 return { flags, values, multi, files };
}

/** Apply `--choose <option>` to a handoff: read the latest prepare brief for the
 * contract, build the implementation contract with any `--correct` replacements
 * and record the choice in the prepare history. */
function applyChooseOption(task: any, cwd: string, parsed: ParsedCommand): any {
 const latest = readLatestBrief(cwd, String(task?.id));
 if (!latest) throw Error(`No prepare brief found for ${String(task?.id)}; run the prepare workflow first.`);
 const corrections: Record<string, string> = {};
 for (const raw of parsed.multi['--correct'] ?? []) {
  const eq = raw.indexOf('=');
  if (eq <= 0) throw Error(`Invalid --correct value (expected <id>=<text>): ${raw}`);
  corrections[raw.slice(0, eq)] = raw.slice(eq + 1);
 }
 const { contract } = chooseBrief({ cwd, task, brief: latest.brief, choice: { option: parsed.values['--choose'], corrections } });
 return contract;
}

async function main(argv: string[]): Promise<void> {
 const command = argv[0];
 const rest = argv.slice(1);
 if (!command || command === '--help' || command === '-h' || command === 'help') { console.log(usage()); return; }
 if (command === '--version' || command === '-v' || command === 'version') { console.log(readPackageVersion(import.meta.url)); return; }
 if (command === 'tools') { const tools = await import('./tools/tools.ts'); process.exitCode = await tools.main(rest); return; }
 if (command === 'mcp') { const mcp = await import('./mcp.ts'); process.exitCode = await mcp.main(rest); return; }
 if (command === 'auth') { const auth = await import('./auth.ts'); process.exitCode = await auth.main(rest); return; }
 if (command === 'matrix') { const matrix = await import('./matrix.ts'); process.exitCode = await matrix.main(rest); return; }
 if (command === 'report-issue') { const reportIssue = await import('./report-issue.ts'); process.exitCode = await reportIssue.main(rest); return; }

 const spec = COMMANDS[command];
 if (!spec) throw Error(usage());
 if (wantsHelp(rest)) { console.log(spec.help); return; }
 const parsed = parseCommand(command, spec, rest);

 if (command === 'model') {
  const modelCli = await import('./model-cli.ts');
  const { exitCode, result } = await modelCli.runModelCommand(rest, { cwd: process.cwd(), env: process.env });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = exitCode;
  return;
 }

 // Best-effort upgrade notice: must never throw and must never change the exit
 // code. It is skipped entirely for commands where an upgrade is not useful.
 const updateCheck = await import('./update-check.ts');
 await updateCheck.startupNotice(command, { env: process.env, checkUpdates: parsed.flags.has('--check-updates') });

 if (command === 'setup') {
  const setup = await import('./readiness.ts');
  const result = await setup.runSetup({}, {
   cwd: process.cwd(),
   harness: parsed.values['--harness'],
   hopPath: parsed.values['--hop'],
   yes: parsed.flags.has('--yes'),
   dryRun: parsed.flags.has('--dry-run'),
   juniorCommand: [process.execPath, process.argv[1]],
  });
  process.exitCode = result.exitCode;
  return;
 }
 if (command === 'doctor') {
  const result:any = doctor({}, { harness: parsed.values['--harness'] });
  if (parsed.flags.has('--online')) {
   result.credentialsOnline = await checkCredentialsOnline();
  }
  if (parsed.flags.has('--check-updates')) {
   const collected = await updateCheck.collectUpdateCheck({
    moduleUrl: import.meta.url,
    onCompanions: (report:any) => { result.companions = report; },
   });
   result.updates = collected.updates;
  }
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
 if (command === 'init' || command === 'update') {
  const target = parsed.values['--target'];
  if (target !== undefined && !INIT_TARGETS.includes(target)) throw Error(`Invalid --target value: ${target}`);
  const scope = parsed.values['--scope'];
  if (scope !== undefined && !INIT_SCOPES.includes(scope)) throw Error(`Invalid --scope value: ${scope}`);
  const opts:InitOptions = parseInitOptions(rest);
  // `update` adopts newer releases and replaces only skills Junior itself wrote.
  if (command === 'update') Object.assign(opts, { install: true, update: true, upgrade: true });
  // Adopt a newer Junior first, so the new release's own update logic runs.
  let self: any | undefined;
  if (command === 'update') {
   const selfUpdate = await import('./self-update.ts');
   const outcome = selfUpdate.selfUpdate({ argv: rest, deps: { moduleUrl: import.meta.url } });
   if (outcome.exitCode !== undefined) { process.exitCode = outcome.exitCode; return; }
   self = outcome.self;
  }
  const result:any = init({}, opts);
  if (self) result.self = self;
  if (opts.install) {
   if (installationDisabled(process.env)) {
    result.tools = { skipped: 'JUNIOR_NO_INSTALL', ok: true };
   } else {
    const installer = await import('./installer.ts');
    const report = await installer.installTools({ update: opts.update, withTriz: opts.withTriz });
    result.tools = report;
    // Distinguish the Pi and prebuilt-tools attempts and report combined truthfully.
    result.installSummary = summarizeInstall(result.install, report);
   }
  }
  if (opts.companions !== false) {
   result.companions = setupCompanions({}, { target: opts.target, scope: opts.scope, install: opts.install, update: opts.update });
   if (!result.companions.ok) result.instructions = [...(result.instructions ?? []), 'A companion tool or skill install failed; see `companions` and rerun `junior update`.'];
   if (result.companions.modifiedTracked.length) result.instructions = [...(result.instructions ?? []), `Companion skill installers edited tracked files (${result.companions.modifiedTracked.join(', ')}); review and commit them before a worktree handoff.`];
  }
  // Adopt newer commodity models when the project opted in. A model-config
  // failure must never fail the update.
  if (command === 'update') {
   try {
    const modelCli = await import('./model-cli.ts');
    result.models = await modelCli.adoptModelUpdates(process.cwd(), {});
   } catch (e) {
    result.models = { error: String(e) };
   }
  }
  // Drop the stale update summary so the next startup notice stops reporting
  // the components just adopted. Never fail an update because of the cache.
  if (command === 'update') await refreshUpdateCache({});
  console.log(JSON.stringify(result, null, 2));
  if (result.installSummary && !result.installSummary.ok) process.exitCode = 1;
  return;
 }
 if (command === 'validate') {
  const path = parsed.files[0];
  const t = validate(JSON.parse(readFileSync(path, 'utf8')));
  console.log(JSON.stringify({ valid: true, id: t.id, warnings: contractWarnings(t) }, null, 2));
  return;
 }
 if (command === 'status') {
  const path = parsed.files[0];
  if (parsed.flags.has('--live')) {
   const snapshot = readRuntimeSnapshot(path);
   console.log(JSON.stringify(snapshot, null, 2));
   return;
  }
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
  if (parsed.values['--choose'] !== undefined && command !== 'handoff') throw Error('--choose is only valid for junior handoff');
  const path = parsed.files[0];
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  let task = withHandoffIsolation(command === 'qa' ? { ...raw, workflow: 'qa' } : raw);
  const mock = parsed.flags.has('--mock');
  const deps: GateDeps = {};
  if (!parsed.flags.has('--quiet')) deps.progress = (line: string) => { process.stderr.write(`junior: ${line}\n`); };
  const taskCwd = resolve(process.cwd(), typeof task.cwd === 'string' && task.cwd.trim() ? task.cwd : '.');
  if (parsed.values['--answers'] !== undefined) {
   const answersPath = resolve(process.cwd(), parsed.values['--answers']);
   const answers = JSON.parse(readFileSync(answersPath, 'utf8'));
   const clarifyDeps = typeof task.hopFrom === 'string' && task.hopFrom.trim() ? { hopPath: resolve(taskCwd, task.hopFrom) } : {};
   const { applyAnswers } = await import('./clarify.ts');
   const outcome = await applyAnswers({ cwd: taskCwd, task, answers, deps: clarifyDeps });
   console.log(JSON.stringify(outcome, null, 2));
   if (outcome.outcome === 'escalated') process.exitCode = 3;
   return;
  }
  if (parsed.values['--choose'] !== undefined) task = applyChooseOption(task, taskCwd, parsed);
  const slowMount = detectSlowMount(taskCwd);
  if (slowMount) deps.progress?.(slowMount);
  const result = await run(task, mock, deps);
  console.log(JSON.stringify(parsed.flags.has('--full') ? result : compactHandoff(result), null, 2));
  if (!isSuccessOutcome(result.status)) process.exitCode = 1;
  return;
 }
 throw Error(usage());
}

/** Read the live runtime.json snapshot for an artifact directory (or a direct
 * runtime.json path) without requiring result.json. */
function readRuntimeSnapshot(path:string):any {
 let raw:string;
 try {
  try { raw=readFileSync(join(path,'runtime.json'),'utf8'); }
  catch { raw=readFileSync(path,'utf8'); }
 } catch { throw Error(`Cannot read runtime snapshot: ${path}`); }
 let snap:any;
 try { snap=JSON.parse(raw); } catch { throw Error(`Invalid JSON in runtime snapshot: ${path}`); }
 if (!snap || typeof snap !== 'object' || Array.isArray(snap)) throw Error('Malformed runtime snapshot: expected an object');
 return { phase:snap.phase, state:snap.state, elapsedMs:snap.elapsedMs, remainingMs:snap.remainingMs, currentTool:snap.currentTool };
}

if (isDirectEntry(import.meta.url)) {
 main(process.argv.slice(2)).catch((e) => { console.error(String(e)); process.exitCode = 1; });
}
