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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { run, validate, contractWarnings, status, type GateDeps } from './worker.ts';
import { doctor, init, parseInitOptions, setupCompanions, summarizeInstall, checkCredentialsOnline, detectSlowMount, inspectSkill, type InitOptions } from './setup.ts';
import { inspectDataPolicy, renderDataPolicyPosture } from './doctor-data-policy.ts';
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
  '  apply   <id|result.json> [--dry-run] [--force] [--no-link] | validate <task.json> | status [<result.json>] [--full] | land <result.json|id>... --into <dir> [--compile <command...>] [--dry-run]   apply a reviewed handoff, validate, print a receipt or the review queue, or land reviewed lanes into an integration checkout',
  '  model status|list|upgrade ...; tools init|call|inspect ...; mcp register ...; matrix export --source code|tests|jevitate|cpm|fmeca; report-issue <tool> --title <t> [--file]; plan check <plan.json> [--jev] | contracts <plan.json> --out <dir>; routes [--json] [<query>] (which command for a job)',
  '  auth    set <provider> [--verify] | remove <provider>; auth consent [grant|remove|status] <provider> [--project <dir>]; doctor [--check-updates] [--online] [--harness <claude|cursor|codex>]   store a provider key; read-only readiness check',
  '  compact [--json] [--max-chars N] [--hop <hop.json>] [--capture] [--cursor]   print the session-start context block; --capture reads hook input on stdin; --cursor emits Cursor sessionStart JSON',
  '  note    add <text...> [--kind <kind>] | list [--json] | done|promote|dismiss <id>   manage local session notes; fmeca propose-verified <result.json|run id>   print verified-mitigation proposals',
  '  prune   [--older-than 24h] [--keep-last N] [--dry-run]   remove inactive clean retained worktrees; setup [--harness H] [--hop F] [--yes] [--dry-run] [--context-hooks [--scope local|project] [--remove]]',
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
 handoff: { flags: ['--mock', '--full', '--quiet'], valueFlags: ['--choose', '--correct', '--answers', '--approve-model'], min: 1, max: 1,
  help: 'Usage: junior handoff <task.json> [--answers <answers.json>] [--choose <option>] [--correct <id>=<text> ...] [--approve-model <key>] [--mock] [--full] [--quiet]\nAnswers JSON: {"Q1":{"stance":"assent","answer":"Your answer here"}} (stance: assent|refute|amend)' },
 qa: { flags: ['--mock', '--full', '--quiet'], valueFlags: [], min: 1, max: 1,
  help: 'Usage: junior qa <task.json> [--mock] [--full] [--quiet]' },
 run: { flags: ['--mock', '--full', '--quiet'], valueFlags: ['--approve-model'], min: 1, max: 1,
  help: 'Usage: junior run <task.json> [--approve-model <key>] [--mock] [--full] [--quiet]' },
 apply: { flags: ['--dry-run', '--force', '--no-link'], valueFlags: [], min: 1, max: 1,
  help: 'Usage: junior apply <id|result.json> [--dry-run] [--force]' },
 validate: { flags: [], valueFlags: [], min: 1, max: 1,
  help: 'Usage: junior validate <task.json>' },
 status: { flags: ['--full', '--live'], valueFlags: [], min: 0, max: 1,
  help: 'Usage: junior status [<result.json|artifactDir>] [--full] [--live]' },
 land: { flags: ['--dry-run'], valueFlags: ['--into', '--compile'], min: 1, max: Number.MAX_SAFE_INTEGER,
  help: 'Usage: junior land <result.json|id>... --into <dir> [--compile <command...>] [--dry-run]\n--compile takes every following argument up to a literal "--" or the end; lane ids after "--" are lanes.' },
 doctor: { flags: ['--check-updates', '--online'], valueFlags: ['--harness'], min: 0, max: 0,
  help: 'Usage: junior doctor [--check-updates] [--online] [--harness claude|cursor|codex]' },
 compact: { flags: ['--json', '--capture', '--cursor'], valueFlags: ['--max-chars', '--hop'], min: 0, max: 0,
  help: 'Usage: junior compact [--json] [--max-chars N] [--hop <hop.json>] [--capture] [--cursor]' },
 note: { flags: ['--json'], valueFlags: ['--kind'], min: 1, max: Number.MAX_SAFE_INTEGER,
  help: [
   'Usage: junior note add <text...> [--kind note|decision|question|risk|hypothesis|todo] [--json]',
   '       junior note list [--json]',
   '       junior note done|promote|dismiss <id>',
  ].join('\n') },
 fmeca: { flags: [], valueFlags: [], min: 2, max: 2,
  help: 'Usage: junior fmeca propose-verified <result.json|run id>' },
 setup: { flags: ['--yes', '--dry-run', '--context-hooks', '--remove'], valueFlags: ['--harness', '--hop', '--scope'], min: 0, max: 0,
  help: [
   'Usage: junior setup [--harness claude|cursor|codex] [--hop <hop.json>] [--yes] [--dry-run]',
   '       junior setup --context-hooks [--scope local|project] [--remove] [--harness claude|codex|cursor]',
  ].join('\n') },
 update: {
  flags: ['--user', '--project', '--with-triz', '--force', '--no-skill', '--no-companions', '--no-self', '--with-matrix'],
  valueFlags: ['--target', '--skill-root', '--scope'],
  min: 0,
  max: 0,
  help: 'Usage: junior update [--target codex|claude|both|none] [--user] [--with-triz] [--no-companions] [--with-matrix]',
 },
 prune: { flags: ['--dry-run'], valueFlags: ['--older-than', '--keep-last'], min: 0, max: 0,
  help: 'Usage: junior prune [--older-than 24h] [--keep-last N] [--dry-run]' },
 model: { flags: ['--online', '--offline', '--dry-run', '--yes'], valueFlags: ['--vendor', '--profile', '--to'], min: 1, max: 2,
  help: 'Usage: junior model status [--online] | list [--online] [--vendor v] | upgrade [--profile p] [--to id] [--online] [--dry-run] [--yes] | approve|revoke <key>' },
 plan: { flags: ['--jev'], valueFlags: ['--out', '--max-hours'], min: 1, max: 2,
  help: 'Usage: junior plan check <plan.json> [--max-hours N] [--jev] | contracts <plan.json> --out <dir>' },
 init: {
  flags: ['--install', '--no-install', '--no-companions', '--user', '--project', '--upgrade', '--update', '--with-triz', '--force', '--no-skill', '--no-matrix'],
  valueFlags: ['--target', '--skill-root', '--scope'],
  min: 0,
  max: 0,
  help: [
   'Usage: junior init [--no-install] [--no-companions] [--target codex|claude|both|none] [--user] [--project]',
   '                   [--upgrade] [--force] [--skill-root DIR] [--update] [--with-triz] [--no-matrix]',
  ].join('\n'),
 },
 routes: { flags: ['--json'], valueFlags: [], min: 0, max: 1,
  help: 'Usage: junior routes [--json] [<query>]' },
 adr: { flags: [], valueFlags: [], min: 0, max: Number.MAX_SAFE_INTEGER,
  help: 'Usage: junior adr <init|check|decide|check-tickets|new|lint|sync> [options]' },
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
   // `--compile` carries a whole argv. It runs up to a literal `--` or the end
   // of the arguments, so command flags such as `-e` belong to the compile
   // command; a lane after `--` stays a lane. Tokens are JSON-encoded to keep
   // their boundaries.
   if (command === 'land' && name === '--compile') {
    const compileArgv: string[] = [];
    if (inline !== undefined) {
     if (inline === '') throw Error('Option --compile requires a value');
     compileArgv.push(inline);
    }
    while (i + 1 < args.length && args[i + 1] !== '--') compileArgv.push(args[++i]);
    if (compileArgv.length === 0) throw Error('Option --compile requires a value');
    const encoded = JSON.stringify(compileArgv);
    values[name] = encoded;
    (multi[name] ??= []).push(encoded);
    continue;
   }
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

/** The single plan file positional from `check <file>` plus allowed options. */
function planFileArg(args: string[]): string {
 for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--max-hours') { i++; continue; }
  if (arg.startsWith('-')) continue;
  return arg;
 }
 throw Error('Usage: junior plan check <plan.json> [--max-hours N] [--jev]');
}

/** Resolve a `fmeca propose-verified` argument to a result file and its
 * `<id>/<stamp>` run reference. A path that exists is read directly; anything
 * else is a run id resolved to the lexically greatest stamp directory under
 * `<cwd>/.delivery/<id>/` that holds a result.json (ADR 0011 R5). Returns
 * undefined when a run id has no result.json. */
function resolveResultArg(arg: string, cwd: string): { file: string; runRef: string } | undefined {
 if (existsSync(arg) && statSync(arg).isFile()) {
  const file = resolve(arg);
  const stampDir = join(file, '..');
  const atDelivery =
   basename(file) === 'result.json' &&
   basename(join(stampDir, '..', '..')) === '.delivery';
  return {
   file,
   runRef: atDelivery ? `${basename(join(stampDir, '..'))}/${basename(stampDir)}` : arg,
  };
 }
 const runDir = join(cwd, '.delivery', arg);
 let stamps: string[];
 try {
  stamps = readdirSync(runDir, { withFileTypes: true })
   .filter((entry) => entry.isDirectory())
   .map((entry) => entry.name)
   .sort();
 } catch {
  return undefined;
 }
 for (const stamp of stamps.reverse()) {
  const file = join(runDir, stamp, 'result.json');
  if (existsSync(file)) return { file, runRef: `${arg}/${stamp}` };
 }
 return undefined;
}

interface CommandContext {
 command: string;
 rest: string[];
 parsed: ParsedCommand;
 updateCheck?: any;
}

type CommandHandler = (ctx: CommandContext) => Promise<void>;

async function modelCommand({ rest }: CommandContext): Promise<void> {
 const modelCli = await import('./model-cli.ts');
 const { exitCode, result } = await modelCli.runModelCommand(rest, { cwd: process.cwd(), env: process.env });
 console.log(JSON.stringify(result, null, 2));
 process.exitCode = exitCode;
}

async function planCommand({ rest }: CommandContext): Promise<void> {
 const planCli = await import('./plan-junior.ts');
 const withJev = rest.includes('--jev');
 if (withJev) {
  const args = rest.filter((arg) => arg !== '--jev');
  if (args[0] !== 'check') throw Error('--jev is only valid for junior plan check');
  const captured = planCli.runPlanCommand(args, { cwd: process.cwd(), out: () => {} });
  const planFile = planFileArg(args);
  const { createPiClassifier } = await import('./worker.ts');
  const quality = await planCli.scorePlanFile(planFile, await createPiClassifier(), { cwd: process.cwd() });
  console.log(JSON.stringify({ ...captured.result, quality }, null, 2));
  process.exitCode = captured.exitCode;
  return;
 }
 const { exitCode } = planCli.runPlanCommand(rest, { cwd: process.cwd() });
 process.exitCode = exitCode;
}

async function routesCommand({ rest }: CommandContext): Promise<void> {
 const routes = await import('./routes.ts');
 process.exitCode = await routes.main(rest);
}

/** Commands handled before the best-effort upgrade notice. */
const PRE_NOTICE_COMMANDS = new Map<string, CommandHandler>([
 ['model', modelCommand],
 ['plan', planCommand],
 ['routes', routesCommand],
]);

function printNoteList(open: any): void {
 const noteLines = [...open.notes]
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  .map((note) => `- [${note.kind}] ${note.text} (${note.id})`);
 const proposalLines = [...open.proposals]
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  .map((note) => `- [${note.kind}] ${note.text} (${note.id}, ${note.captureId ?? ''})`);
 console.log('### Open notes');
 console.log(noteLines.length ? noteLines.join('\n') : 'none');
 console.log('### Capture proposals');
 console.log(proposalLines.length ? proposalLines.join('\n') : 'none');
}

async function noteCommand({ parsed }: CommandContext): Promise<void> {
 const [sub, ...words] = parsed.files;
 const notes = await import('./notes.ts');
 const kinds = ['note', 'decision', 'question', 'risk', 'hypothesis', 'todo'];
 const kind = parsed.values['--kind'];
 if (kind !== undefined && !kinds.includes(kind)) {
  throw Error(`Invalid --kind value: ${kind} (expected ${kinds.join(', ')})`);
 }
 const root = process.cwd();
 if (sub === 'add') {
  const text = words.join(' ');
  if (!text) throw Error(COMMANDS.note.help);
  const note = notes.addNote(root, { text, ...(kind !== undefined ? { kind: kind as any } : {}) });
  console.log(parsed.flags.has('--json') ? JSON.stringify(note, null, 2) : `added ${note.id}`);
  return;
 }
 if (sub === 'list') {
  if (words.length > 0) throw Error(COMMANDS.note.help);
  const open = notes.listOpen(root);
  if (parsed.flags.has('--json')) {
   console.log(JSON.stringify(open, null, 2));
   return;
  }
  printNoteList(open);
  return;
 }
 if (sub === 'done' || sub === 'promote' || sub === 'dismiss') {
  if (words.length !== 1) throw Error(COMMANDS.note.help);
  const id = words[0];
  const changed = sub === 'done' ? notes.markDone(root, id) : notes[sub](root, id);
  if (!changed) {
   console.error(`no matching open note or proposal: ${id}`);
   process.exitCode = 1;
   return;
  }
  console.log(`${sub} ${id}`);
  return;
 }
 throw Error(COMMANDS.note.help);
}

async function fmecaCommand({ parsed }: CommandContext): Promise<void> {
 const [sub, target] = parsed.files;
 if (sub !== 'propose-verified') throw Error(COMMANDS.fmeca.help);
 const cwd = process.cwd();
 const resolved = resolveResultArg(target, cwd);
 if (!resolved) {
  console.error(`no result.json found: ${join(cwd, '.delivery', target)}`);
  process.exitCode = 1;
  return;
 }
 let result: unknown;
 try {
  result = JSON.parse(readFileSync(resolved.file, 'utf8'));
 } catch {
  console.error(`invalid result.json: ${resolved.file}`);
  process.exitCode = 1;
  return;
 }
 const { proposeVerified } = await import('./fmeca-verify.ts');
 console.log(JSON.stringify(proposeVerified(result, resolved.runRef), null, 2));
}

async function compactCapture(): Promise<void> {
 try {
  let input: any = {};
  try {
   const rawInput = readFileSync(0, 'utf8');
   if (rawInput.trim()) {
    const parsedInput = JSON.parse(rawInput);
    if (parsedInput && typeof parsedInput === 'object' && !Array.isArray(parsedInput)) input = parsedInput;
   }
  } catch { /* empty or invalid hook input becomes {} */ }
  const { runCapture } = await import('./precompact.ts');
  const record = await runCapture(input, {
   root: typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd(),
  });
  const suffix = record.error ? ` (${record.error})` : '';
  console.error(`junior capture: ${record.proposals} proposals, ${record.duplicates} duplicates${suffix}`);
 } catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`junior capture: 0 proposals, 0 duplicates (${message})`);
 }
 process.exitCode = 0;
}

async function compactCommand({ parsed }: CommandContext): Promise<void> {
 if (parsed.flags.has('--capture')) {
  await compactCapture();
  return;
 }
 const raw = parsed.values['--max-chars'];
 let maxChars: number | undefined;
 if (raw !== undefined) {
  maxChars = Number(raw);
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
   throw Error(`Invalid --max-chars value: ${raw} (expected a positive integer)`);
  }
 }
 const rawHop = parsed.values['--hop'];
 let hopPath: string | undefined;
 if (rawHop !== undefined) {
  const { loadHop } = await import('./tools/tools.ts');
  hopPath = resolve(process.cwd(), rawHop);
  loadHop(hopPath);
 }
 const { buildCompactBlock } = await import('./compact.ts');
 const block = await buildCompactBlock({ cwd: process.cwd(), ...(hopPath !== undefined ? { hopPath } : {}), ...(maxChars !== undefined ? { maxChars } : {}) });
 if (parsed.flags.has('--cursor')) {
  console.log(JSON.stringify({ additional_context: block.markdown }));
  return;
 }
 console.log(parsed.flags.has('--json') ? JSON.stringify(block, null, 2) : block.markdown);
}

async function setupContextHooks(parsed: ParsedCommand): Promise<void> {
 const harness = parsed.values['--harness'];
 if (harness !== undefined && !['claude', 'codex', 'cursor'].includes(harness)) {
  throw Error(`Invalid --harness value: ${harness} (expected claude, codex or cursor)`);
 }
 const scope = parsed.values['--scope'];
 if (scope !== undefined && scope !== 'local' && scope !== 'project') {
  throw Error(`Invalid --scope value: ${scope} (expected local or project)`);
 }
 const contextHooks = await import('./context-hooks.ts');
 if (harness === 'codex' || harness === 'cursor') {
  const result = contextHooks.installHarnessHooks({
   projectDir: process.cwd(),
   harness,
   remove: parsed.flags.has('--remove'),
  });
  console.log(JSON.stringify(result, null, 2));
  for (const note of result.notes) console.error(note);
  return;
 }
 const result = contextHooks.installContextHooks({
  projectDir: process.cwd(),
  ...(scope !== undefined ? { scope: scope as 'local' | 'project' } : {}),
  remove: parsed.flags.has('--remove'),
 });
 console.log(JSON.stringify(result, null, 2));
}

async function setupCommand({ parsed }: CommandContext): Promise<void> {
 if (parsed.flags.has('--context-hooks')) {
  await setupContextHooks(parsed);
  return;
 }
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
}

async function doctorCommand({ parsed, updateCheck }: CommandContext): Promise<void> {
 const result:any = doctor({}, { harness: parsed.values['--harness'] });
 if (parsed.flags.has('--online')) {
  result.credentialsOnline = await checkCredentialsOnline();
  const posture = await inspectDataPolicy({ cwd: process.cwd(), models: [result.model.id] });
  result.dataPolicy = posture;
  result.warnings.push(...renderDataPolicyPosture(posture).split('\n'));
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
}

async function pruneCommand({ parsed }: CommandContext): Promise<void> {
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
}

/** #271: the hop synced from the install state alone; a missing binary is skipped, never downloaded. */
async function syncHopFromInstalledTools(): Promise<{ hopPath?: string; created?: boolean; updated?: string[]; missing?: string[]; error?: string }> {
 try {
  const state = await import('./installer-state.ts');
  const fs = await import('node:fs');
  const recorded = state.readInstallState().tools;
  const installed: typeof recorded = {};
  const missing: string[] = [];
  for (const [tool, entry] of Object.entries(recorded)) {
   if (entry && fs.existsSync(entry.path)) (installed as any)[tool] = entry;
   else missing.push(tool);
  }
  const synced = await state.syncHopWithTools(installed, { cwd: process.cwd() }, installed);
  return { hopPath: synced.hopPath, created: synced.created, updated: synced.updated, ...(missing.length ? { missing } : {}) };
 } catch (err) {
  return { error: err instanceof Error ? err.message : String(err) };
 }
}

async function installInitTools(result: any, opts: InitOptions): Promise<void> {
 if (installationDisabled(process.env)) {
  // #271: JUNIOR_NO_INSTALL skips the installers, not project setup. Point the hop at the tools that
  // are already installed (no download, no network), so `junior tools call` works after init.
  result.tools = { skipped: 'JUNIOR_NO_INSTALL', ok: true, hop: await syncHopFromInstalledTools() };
 } else {
  const installer = await import('./installer.ts');
  const report = await installer.installTools({ update: opts.update, withTriz: opts.withTriz });
  result.tools = report;
  // Distinguish the Pi and prebuilt-tools attempts and report combined truthfully.
  result.installSummary = summarizeInstall(result.install, report);
 }
}

function setupInitCompanions(result: any, opts: InitOptions): void {
 result.companions = setupCompanions({}, { target: opts.target, scope: opts.scope, install: opts.install, update: opts.update });
 if (!result.companions.ok) result.instructions = [...(result.instructions ?? []), 'A companion tool or skill install failed; see `companions` and rerun `junior update`.'];
 if (result.companions.modifiedTracked.length) result.instructions = [...(result.instructions ?? []), `Companion skill installers edited tracked files (${result.companions.modifiedTracked.join(', ')}); review and commit them before a worktree handoff.`];
}

async function initCommand({ command, rest, parsed }: CommandContext): Promise<void> {
 const target = parsed.values['--target'];
 if (target !== undefined && !INIT_TARGETS.includes(target)) throw Error(`Invalid --target value: ${target}`);
 const scope = parsed.values['--scope'];
 if (scope !== undefined && !INIT_SCOPES.includes(scope)) throw Error(`Invalid --scope value: ${scope}`);
 const opts:InitOptions = parseInitOptions(rest);
 // `update` adopts newer releases and replaces only skills Junior itself wrote.
 if (command === 'update') Object.assign(opts, { install: true, update: true, upgrade: true, command: 'update' });
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
 if (opts.install) await installInitTools(result, opts);
 if (opts.companions !== false) setupInitCompanions(result, opts);
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
}

async function validateCommand({ parsed }: CommandContext): Promise<void> {
 const path = parsed.files[0];
 const t = validate(JSON.parse(readFileSync(path, 'utf8')));
 console.log(JSON.stringify({ valid: true, id: t.id, warnings: contractWarnings(t) }, null, 2));
}

async function readReviewQueueConfig(cwd: string): Promise<any | undefined> {
 const { readDeliveryConfig } = await import('./land.ts');
 const config = readDeliveryConfig(cwd).reviewQueue;
 if (config === undefined) return undefined;
 const { validateReviewQueueConfig } = await import('./review-queue.ts');
 validateReviewQueueConfig(config);
 return config;
}

async function statusCommand({ parsed }: CommandContext): Promise<void> {
 const path = parsed.files[0];
 if (!path) {
  const { reviewQueue } = await import('./review-queue.ts');
  const config = await readReviewQueueConfig(process.cwd());
  const report = reviewQueue({ cwd: process.cwd(), ...(config !== undefined ? { config } : {}) });
  console.log(JSON.stringify(report, null, 2));
  return;
 }
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
 const { reviewQueue } = await import('./review-queue.ts');
 const config = await readReviewQueueConfig(process.cwd());
 const queue = reviewQueue({ cwd: process.cwd(), ...(config !== undefined ? { config } : {}) });
 if (queue.aging.length > 0) {
  console.error('Aged reviews:');
  for (const review of queue.aging) console.error(`- ${review.id} (${review.ageMinutes}m): ${review.next}`);
 }
}

async function landCommand({ parsed }: CommandContext): Promise<void> {
 const into = parsed.values['--into'] ?? '';
 const rawCompile = parsed.values['--compile'];
 let compile: string[] | undefined;
 if (rawCompile !== undefined) {
  try {
   const parsedCompile = JSON.parse(rawCompile);
   compile = Array.isArray(parsedCompile) ? parsedCompile.map(String) : [String(parsedCompile)];
  } catch {
   compile = [rawCompile];
  }
  if (compile.length === 0) throw Error('Option --compile requires a value');
 }
 const { land } = await import('./land.ts');
 const report = await land({
  cwd: process.cwd(),
  into,
  lanes: parsed.files,
  ...(compile !== undefined ? { compile } : {}),
  dryRun: parsed.flags.has('--dry-run'),
 });
 console.log(JSON.stringify(report, null, 2));
 if (!report.ok) process.exitCode = 1;
}

async function applyCommand({ parsed }: CommandContext): Promise<void> {
 const { applyHandoff } = await import('./apply.ts');
 const result = applyHandoff(parsed.files[0], { cwd: process.cwd(), dryRun: parsed.flags.has('--dry-run'), force: parsed.flags.has('--force'), noLink: parsed.flags.has('--no-link') });
 console.log(JSON.stringify(result, null, 2));
 if (result.error) process.exitCode = 1;
}

async function applyClarificationAnswers(task: any, taskCwd: string, answersArg: string): Promise<void> {
 const answersPath = resolve(process.cwd(), answersArg);
 let answers: unknown;
 try { answers = JSON.parse(readFileSync(answersPath, 'utf8')); }
 catch { const error: any = new Error('Invalid clarification answers: answers file must contain JSON.'); error.exitCode = 64; throw error; }
 const clarifyDeps = typeof task.hopFrom === 'string' && task.hopFrom.trim() ? { hopPath: resolve(taskCwd, task.hopFrom) } : {};
 const { applyAnswers } = await import('./clarify.ts');
 const outcome = await applyAnswers({ cwd: taskCwd, task, answers, deps: clarifyDeps });
 console.log(JSON.stringify(outcome, null, 2));
 if (outcome.outcome === 'escalated') process.exitCode = 3;
}

/** Run a plan-backed task under its plan lease; returns undefined when the lease is refused. */
async function runWithPlanLease(task: any, taskCwd: string, mock: boolean, deps: GateDeps): Promise<{ result: any; plan: any } | undefined> {
 validate(task);
 const { withPlanLease, isHoldOutcome, runNeverStarted } = await import('./plan-handoff.ts');
 const { callHop } = await import('./tools/tools.ts');
 const hopPath = resolve(taskCwd, String(task.hopFrom));
 const lease = await withPlanLease(task, () => run(task, mock, deps), {
  callHop: (tool, request) => callHop(hopPath, tool, request),
  deadlineMs: task.deadlineMs ?? task.execution?.deadlineMs ?? 600000,
  summarize: (r: any) => ({ success: isSuccessOutcome(r.status), hold: isHoldOutcome(r.status) || runNeverStarted(r), artifactDir: r.artifactDir, outcome: r.status, model: compactHandoff(r).model?.observed?.[0]?.model, reason: r.status }),
 });
 if (!lease.plan.leased) {
  console.log(JSON.stringify({ status: 'plan_lease_refused', plan: lease.plan }, null, 2));
  process.exitCode = 1;
  return undefined;
 }
 return { result: lease.result, plan: lease.plan };
}

async function runTaskCommand({ command, parsed }: CommandContext): Promise<void> {
 if (parsed.values['--choose'] !== undefined && command !== 'handoff') throw Error('--choose is only valid for junior handoff');
 const path = parsed.files[0];
 const raw = JSON.parse(readFileSync(path, 'utf8'));
 let task = withHandoffIsolation(command === 'qa' ? { ...raw, workflow: 'qa' } : raw);
 if (parsed.values['--approve-model'] !== undefined) task = { ...task, approveModel: parsed.values['--approve-model'] };
 const mock = parsed.flags.has('--mock');
 const deps: GateDeps = {};
 if (!parsed.flags.has('--quiet')) deps.progress = (line: string) => { process.stderr.write(`junior: ${line}\n`); };
 const taskCwd = resolve(process.cwd(), typeof task.cwd === 'string' && task.cwd.trim() ? task.cwd : '.');
 if (parsed.values['--answers'] !== undefined) {
  await applyClarificationAnswers(task, taskCwd, parsed.values['--answers']);
  return;
 }
 if (parsed.values['--choose'] !== undefined) task = applyChooseOption(task, taskCwd, parsed);
 const slowMount = detectSlowMount(taskCwd);
 if (slowMount) deps.progress?.(slowMount);
 let result: any;
 let plan: any;
 if (task.plan !== undefined && command !== 'qa') {
  const leased = await runWithPlanLease(task, taskCwd, mock, deps);
  if (!leased) return;
  result = leased.result;
  plan = leased.plan;
 } else {
  result = await run(task, mock, deps);
 }
 const receipt = parsed.flags.has('--full') ? result : compactHandoff(result);
 console.log(JSON.stringify(plan ? { ...receipt, plan } : receipt, null, 2));
 if (!isSuccessOutcome(result.status)) process.exitCode = 1;
}

/** Commands handled after the best-effort upgrade notice. */
const COMMAND_HANDLERS = new Map<string, CommandHandler>([
 ['note', noteCommand],
 ['fmeca', fmecaCommand],
 ['compact', compactCommand],
 ['setup', setupCommand],
 ['doctor', doctorCommand],
 ['prune', pruneCommand],
 ['init', initCommand],
 ['update', initCommand],
 ['validate', validateCommand],
 ['status', statusCommand],
 ['land', landCommand],
 ['apply', applyCommand],
 ['run', runTaskCommand],
 ['handoff', runTaskCommand],
 ['qa', runTaskCommand],
]);

async function main(argv: string[]): Promise<void> {
 const command = argv[0];
 const rest = argv.slice(1);
 if (!command || command === '--help' || command === '-h' || command === 'help') { console.log(usage()); return; }
 if (command === '--version' || command === '-v' || command === 'version') { console.log(readPackageVersion(import.meta.url)); return; }
 if (command === 'tools') { const tools = await import('./tools/tools.ts'); process.exitCode = await tools.main(rest); return; }
 if (command === 'mcp') { const mcp = await import('./mcp.ts'); process.exitCode = await mcp.main(rest); return; }
 if (command === 'auth') { const auth = await import('./auth.ts'); process.exitCode = await auth.main(rest); return; }
 if (command === 'matrix') { const matrix = await import('./matrix.ts'); process.exitCode = await matrix.main(rest); return; }
 if (command === 'adr') { const { runAdrCli } = await import('./adr-cli.ts'); process.exitCode = await runAdrCli(rest); return; }
 if (command === 'report-issue') { const reportIssue = await import('./report-issue.ts'); process.exitCode = await reportIssue.main(rest); return; }

 const spec = COMMANDS[command];
 if (!spec) throw Error(usage());
 if (wantsHelp(rest)) { console.log(spec.help); return; }
 const parsed = parseCommand(command, spec, rest);

 const preNotice = PRE_NOTICE_COMMANDS.get(command);
 if (preNotice) { await preNotice({ command, rest, parsed }); return; }

 // Best-effort upgrade notice: must never throw and must never change the exit
 // code. It is skipped entirely for commands where an upgrade is not useful.
 const updateCheck = await import('./update-check.ts');
 await updateCheck.startupNotice(command, {
  env: process.env,
  checkUpdates: parsed.flags.has('--check-updates'),
  localOutdated: () => {
   const managers = inspectSkill().targets.filter((t) => t.status === 'outdated').map((t) => t.manager).sort();
   return managers.length ? [`junior skill (${managers.join(', ')})`] : [];
  },
 });

 const handler = COMMAND_HANDLERS.get(command);
 if (handler) { await handler({ command, rest, parsed, updateCheck }); return; }
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
 main(process.argv.slice(2)).catch((e: any) => { console.error(String(e)); process.exitCode = e?.exitCode === 64 || String(e).startsWith('Error: Invalid clarification answer') ? 64 : 1; });
}
