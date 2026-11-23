// ---------------------------------------------------------------------------
// `junior land` (#280, lane E2): apply reviewed lane handoffs to an integration
// worktree, reuse lane check evidence whose identity is unchanged, and run one
// compile-only check for the whole batch.
//
// The batch is validated before anything is written, so a lane that is not
// ready_for_review cannot leave a partial integration tree behind. Apply
// conflicts stop the batch after the earlier lanes and are named in the report.
// Nothing is ever committed or pushed.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, cpSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { applyHandoff, type ApplyHandoffResult } from './apply.ts';
import { admit, resolveMachineConfig, type AdmissionResult, type ResolvedMachineConfig } from './admission.ts';
import { systemClock, type Clock } from './clock.ts';
import { checkIdentity, classifyCheck, identityEqual, type CheckIdentityInput } from './evidence-identity.ts';
import type { EvidenceIdentity } from './worker-receipt.ts';
import { runSync } from './spawn-sync.ts';

export type LandCheckVerdict = 'reused' | 'stale';

export interface LandCheckReport {
  /** The check command as a single display string. */
  command: string;
  verdict: LandCheckVerdict;
  /** Identity fields that differ from the stored identity, for a stale check. */
  changed?: string[];
  /** Set for a check that has no usable stored identity. */
  reason?: string;
  /** The original argv, ready to re-run. */
  argv: string[];
}

export interface LandLaneReport {
  id: string;
  applied: boolean;
  checks: LandCheckReport[];
  /** Set when this lane stopped the batch. */
  error?: string;
  code?: string;
  /** Files the lane patch changed in the integration checkout. */
  files?: string[];
}

export interface LandCompileReport {
  command: string;
  argv: string[];
  exitCode: number | null;
  passed: boolean;
  error?: string;
  code?: string;
}

export interface LandReport {
  lanes: LandLaneReport[];
  compile: LandCompileReport | null;
  rerun: string[][];
  ok: boolean;
  dryRun: boolean;
  into: string;
  warnings?: string[];
  reportPath?: string;
  error?: string;
  code?: string;
}

export interface LandOptions {
  /** Caller checkout used to resolve ids, delivery.config.json and relative lanes. */
  cwd: string;
  /** Integration checkout (a branch worktree) that receives the lane patches. */
  into: string;
  /** Result file paths, artifact directories or deliverable ids, in apply order. */
  lanes: string[];
  /** Explicit compile argv, from `--compile <command...>`. */
  compile?: string[];
  dryRun?: boolean;
  clock?: Clock;
  /** Admission test overrides. */
  stateDir?: string;
  procRoot?: string;
}

/** Injectable seams for tests and callers that own the identity implementation. */
export interface LandDeps {
  applyHandoff?: typeof applyHandoff;
  checkIdentity?: (input: CheckIdentityInput) => EvidenceIdentity | null;
  identityEqual?: typeof identityEqual;
  admit?: typeof admit;
  resolveMachineConfig?: typeof resolveMachineConfig;
  runSync?: typeof runSync;
}

interface LaneInput {
  target: string;
  resultPath: string;
  artifactDir: string;
  result: any;
}

type Resolved = { lane?: LaneInput; error?: string };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Read `delivery.config.json`; a missing file is an empty config. */
export function readDeliveryConfig(cwd: string): any {
  const path = join(cwd, 'delivery.config.json');
  if (!existsSync(path)) return {};
  let parsed: any;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw Error(`delivery.config.json is not valid JSON: ${message(e)}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('delivery.config.json must contain a JSON object');
  return parsed;
}

/** Resolve a lane target to its result.json. A file or artifact directory is
 * used directly; anything else is an id under `<cwd>/.delivery/<id>/`, newest
 * numeric timestamp first. */
function resolveLane(target: string, cwd: string): Resolved {
  const candidate = isAbsolute(target) ? target : resolve(cwd, target);
  try {
    const st = statSync(candidate);
    if (st.isFile()) {
      const resultPath = candidate;
      return readLane(target, resultPath, dirname(resultPath));
    }
    if (st.isDirectory() && existsSync(join(candidate, 'result.json'))) {
      return readLane(target, join(candidate, 'result.json'), candidate);
    }
  } catch { /* not a path; fall through to id resolution */ }

  const base = join(cwd, '.delivery', target);
  let entries: string[];
  try { entries = readdirSync(base); }
  catch { return { error: `lane target not found: ${target}` }; }
  const stamps = entries
    .filter((entry) => /^\d+$/.test(entry) && existsSync(join(base, entry, 'result.json')))
    .sort((a, b) => Number(b) - Number(a));
  if (stamps.length === 0) return { error: `no run with result.json for lane: ${target}` };
  const artifactDir = join(base, stamps[0]);
  return readLane(target, join(artifactDir, 'result.json'), artifactDir);
}

function readLane(target: string, resultPath: string, artifactDir: string): Resolved {
  let result: any;
  try { result = JSON.parse(readFileSync(resultPath, 'utf8')); }
  catch (e) { return { error: `could not read ${resultPath}: ${message(e)}` }; }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { error: `malformed lane result: ${resultPath}` };
  return { lane: { target, resultPath, artifactDir, result } };
}

function gitStatus(cwd: string): { clean: boolean; error?: string; output: string } {
  const r = runSync('git', ['status', '--porcelain'], { cwd, maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0) return { clean: false, output: r.stdout ?? '', error: r.error?.message || (r.stderr ?? '').trim() || `git status exited ${r.status}` };
  const output = (r.stdout ?? '').trim();
  return { clean: output === '', output };
}

/** Normalize `land.compile`: an argv array, or `{command,args}`. */
function compileArgv(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    if (value.length === 0 || value.some((part) => typeof part !== 'string' || !part)) {
      throw Error('delivery.config.json land.compile must be a non-empty argv array of strings');
    }
    return [...value];
  }
  if (typeof value === 'object') {
    const command = (value as any).command;
    const args = (value as any).args ?? [];
    if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some((part) => typeof part !== 'string')) {
      throw Error('delivery.config.json land.compile must be {command,args} with string args');
    }
    return [command, ...args];
  }
  throw Error('delivery.config.json land.compile must be an argv array or {command,args}');
}

function checkArgv(check: any): string[] {
  return [String(check?.command ?? ''), ...(Array.isArray(check?.args) ? check.args.map(String) : [])].filter((part) => part !== '');
}

/** First build check from the lanes' landed check evidence. */
function buildCheckFromLanes(lanes: LaneInput[]): string[] | null {
  for (const { result } of lanes) {
    if (!Array.isArray(result?.checks)) continue;
    for (const check of result.checks) {
      const argv = checkArgv(check);
      if (argv.length === 0) continue;
      const phase = check?.phase ?? classifyCheck(argv);
      if (phase === 'build') return argv;
    }
  }
  return null;
}

/** The project's `land` block; the caller checkout wins over the integration
 * checkout when both define a key. */
function landConfig(opts: LandOptions, into: string): any {
  const caller = readDeliveryConfig(opts.cwd)?.land ?? {};
  const integration = into === resolve(opts.cwd) ? {} : (readDeliveryConfig(into)?.land ?? {});
  return { ...integration, ...caller };
}

function chosenCompile(opts: LandOptions, lanes: LaneInput[], into: string): string[] | null {
  if (opts.compile && opts.compile.length > 0) return [...opts.compile];
  const fromConfig = compileArgv(landConfig(opts, into)?.compile);
  if (fromConfig) return fromConfig;
  return buildCheckFromLanes(lanes);
}

function compileTimeoutMs(opts: LandOptions, into: string): number {
  const value = landConfig(opts, into)?.compileTimeoutMs;
  if (value === undefined) return 600_000;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw Error('delivery.config.json land.compileTimeoutMs must be a positive number');
  }
  return value;
}

function incompleteChecks(lane: LaneInput): LandCheckReport[] {
  const checks = Array.isArray(lane.result?.checks) ? lane.result.checks : [];
  return checks.map((check) => {
    const argv = checkArgv(check);
    return { command: argv.join(' '), verdict: 'stale', reason: 'batch incomplete', argv };
  });
}

function changedFields(stored: EvidenceIdentity, recomputed: EvidenceIdentity): string[] {
  const keys: (keyof EvidenceIdentity)[] = ['schema_version', 'tree', 'projects', 'command', 'filter', 'dependencyLock', 'toolchain'];
  return keys.filter((key) => JSON.stringify(stored[key]) !== JSON.stringify(recomputed[key]));
}

/** Recompute a lane check's identity on the integration checkout. The touched
 * files are the exact files the patch changed. */
function verifyChecks(
  lane: LaneInput,
  apply: ApplyHandoffResult,
  into: string,
  deps: Required<Pick<LandDeps, 'checkIdentity' | 'identityEqual'>>,
): LandCheckReport[] {
  const checks = Array.isArray(lane.result?.checks) ? lane.result.checks : [];
  const touchedFiles = Array.isArray(apply.files) ? apply.files : [];
  const out: LandCheckReport[] = [];
  for (const check of checks) {
    const argv = checkArgv(check);
    const stored = check?.identity as EvidenceIdentity | null | undefined;
    if (!stored) {
      out.push({ command: argv.join(' '), verdict: 'stale', reason: 'no identity', argv });
      continue;
    }
    const recomputed = deps.checkIdentity({
      cwd: into,
      check: { command: String(check.command), ...(check.args !== undefined ? { args: check.args } : {}), ...(check.cwd !== undefined ? { cwd: check.cwd } : {}) },
      touchedFiles,
    });
    if (recomputed && deps.identityEqual(stored, recomputed)) {
      out.push({ command: argv.join(' '), verdict: 'reused', argv });
      continue;
    }
    const changed = recomputed ? changedFields(stored, recomputed) : ['identity'];
    out.push({ command: argv.join(' '), verdict: 'stale', changed, argv });
  }
  return out;
}

function stampFor(clock: Clock): string {
  return clock.iso().replace(/[:.]/g, '-');
}

async function runCompile(
  argv: string[],
  into: string,
  opts: LandOptions,
  deps: Required<Pick<LandDeps, 'admit' | 'resolveMachineConfig' | 'runSync'>>,
  holder: string,
  timeoutMs: number,
): Promise<LandCompileReport> {
  const command = argv.join(' ');
  let config: ResolvedMachineConfig;
  try { config = deps.resolveMachineConfig(into); }
  catch (e) { return { command, argv, exitCode: null, passed: false, error: message(e), code: 'E_LAND_COMPILE' }; }
  let admitted: AdmissionResult;
  try {
    admitted = await deps.admit({
      kind: 'check',
      holder,
      argv,
      config,
      ...(opts.clock ? { clock: opts.clock } : {}),
      ...(opts.stateDir ? { stateDir: opts.stateDir } : {}),
      ...(opts.procRoot ? { procRoot: opts.procRoot } : {}),
    });
  } catch (e) {
    return { command: argv.join(' '), argv, exitCode: null, passed: false, error: message(e), code: 'E_LAND_COMPILE' };
  }
  if (!admitted.ok) {
    const detail = admitted.wait?.detail ? `: ${admitted.wait.detail}` : '';
    return { command: argv.join(' '), argv, exitCode: null, passed: false, error: `${admitted.error}${detail}`, code: 'E_LAND_COMPILE' };
  }
  try {
    const r = deps.runSync(argv[0], argv.slice(1), { cwd: into, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    const exitCode = typeof r.status === 'number' ? r.status : null;
    const timedOut = r.error?.code === 'ETIMEDOUT';
    const error = timedOut
      ? 'compile timed out'
      : r.error?.message || (r.status === null ? (r.stderr ?? '').trim() || 'compile did not exit' : undefined);
    return { command, argv, exitCode, passed: exitCode === 0 && !r.error, ...(error ? { error } : {}) };
  } finally {
    admitted.grant.release();
  }
}

function writeReport(into: string, stamp: string, report: LandReport): LandReport {
  const dir = join(into, '.delivery', 'land', stamp);
  try {
    mkdirSync(dir, { recursive: true });
    const reportPath = join(dir, 'land-report.json');
    writeFileSync(reportPath, JSON.stringify({ ...report, reportPath }, null, 2) + '\n');
    return { ...report, reportPath };
  } catch (e) {
    return { ...report, error: report.error ? `${report.error}; could not write land-report.json: ${message(e)}` : `could not write land-report.json: ${message(e)}` };
  }
}

type ResolvedLandDeps = Required<LandDeps>;

/** Everything one `land` invocation shares across its phases. */
interface LandRun {
  opts: LandOptions;
  cwd: string;
  into: string;
  stamp: string;
  dryRun: boolean;
  clock: Clock;
  deps: ResolvedLandDeps;
  base: (extra: Partial<LandReport>) => LandReport;
}

type LandStop = { error: string; code: string };

interface ApplyOutcome {
  laneReports: LandLaneReport[];
  attempted: { lane: LaneInput; apply: ApplyHandoffResult }[];
  stop?: LandStop;
}

interface CompileOutcome {
  argv: string[] | null;
  compile: LandCompileReport | null;
}

function resolveLandDeps(deps: LandDeps): ResolvedLandDeps {
  return {
    applyHandoff: deps.applyHandoff ?? applyHandoff,
    checkIdentity: deps.checkIdentity ?? checkIdentity,
    identityEqual: deps.identityEqual ?? identityEqual,
    admit: deps.admit ?? admit,
    resolveMachineConfig: deps.resolveMachineConfig ?? resolveMachineConfig,
    runSync: deps.runSync ?? runSync,
  };
}

function laneId(lane: LaneInput): string {
  return String(lane.result?.id ?? lane.target);
}

/** Refuse a missing, non-directory or dirty integration checkout. */
function checkInto(run: LandRun, intoValue: string): LandReport | null {
  if (!intoValue) return run.base({ error: 'missing --into integration checkout', code: 'E_LAND_INTO' });
  if (!existsSync(run.into) || !statSync(run.into).isDirectory()) {
    return run.base({ error: `integration checkout is not a directory: ${run.into}`, code: 'E_LAND_INTO' });
  }
  const status = gitStatus(run.into);
  if (status.error) return writeReport(run.into, run.stamp, run.base({ error: `could not check the integration checkout: ${status.error}`, code: 'E_LAND_INTO' }));
  if (!status.clean) return writeReport(run.into, run.stamp, run.base({ error: `integration checkout is not clean: ${run.into}`, code: 'E_LAND_DIRTY' }));
  return null;
}

/** Resolve every lane and require all of them ready_for_review, before
 * anything is written. */
function resolveBatch(run: LandRun): { inputs: LaneInput[] } | { report: LandReport } {
  const inputs: LaneInput[] = [];
  for (const target of run.opts.lanes) {
    const resolved = resolveLane(target, run.cwd);
    if (!resolved.lane) return { report: writeReport(run.into, run.stamp, run.base({ error: resolved.error, code: 'E_LAND_LANE' })) };
    inputs.push(resolved.lane);
  }

  const notReady = inputs.find(({ result }) => result?.status !== 'ready_for_review');
  if (!notReady) return { inputs };
  const id = laneId(notReady);
  return {
    report: writeReport(run.into, run.stamp, run.base({
      lanes: [{ id, applied: false, checks: [], error: `lane status is "${notReady.result?.status ?? 'unknown'}"; expected "ready_for_review"`, code: 'E_LAND_NOT_READY' }],
      error: `lane ${id} is not ready_for_review`,
      code: 'E_LAND_NOT_READY',
    })),
  };
}

/** A result that records the lane's own source checkout is redirected to the
 * integration checkout: land applies to --into, never back into the lane. */
function redirectedTarget(lane: LaneInput, run: LandRun, scratch: string, index: number): string {
  const sourceCwd = lane.result?.sourceCwd;
  if (typeof sourceCwd !== 'string' || !sourceCwd.trim()) return lane.resultPath;
  if (resolve(run.cwd, sourceCwd) === run.into) return lane.resultPath;
  const artifact = join(scratch, `lane-${index}`);
  mkdirSync(artifact, { recursive: true });
  writeFileSync(join(artifact, 'result.json'), JSON.stringify({ ...lane.result, sourceCwd: run.into }));
  return join(artifact, 'result.json');
}

function applyLane(lane: LaneInput, target: string, run: LandRun): ApplyHandoffResult {
  try {
    return run.deps.applyHandoff(target, { cwd: run.into, dryRun: run.dryRun, noLink: true, clock: run.clock });
  } catch (e) {
    return { applied: false, dryRun: run.dryRun, files: [], artifactDir: lane.artifactDir, error: message(e) };
  }
}

/** Keep the applied record beside the original lane artifact when a
 * redirected result was used. */
function keepAppliedRecord(target: string, lane: LaneInput): void {
  try { cpSync(join(dirname(target), 'applied.json'), join(lane.artifactDir, 'applied.json')); }
  catch { /* best effort; the apply itself already succeeded */ }
}

/** Apply lanes in order; the first failed apply stops the batch. */
function applyLanes(inputs: LaneInput[], run: LandRun): ApplyOutcome {
  const scratch = mkdtempSync(join(tmpdir(), 'junior-land-'));
  const outcome: ApplyOutcome = { laneReports: [], attempted: [] };
  try {
    for (const lane of inputs) {
      const id = laneId(lane);
      const target = redirectedTarget(lane, run, scratch, outcome.laneReports.length);
      const applied = applyLane(lane, target, run);
      outcome.attempted.push({ lane, apply: applied });
      if (applied.error) {
        const code = applied.conflicts?.length ? 'E_LAND_CONFLICT' : 'E_LAND_APPLY';
        outcome.laneReports.push({ id, applied: false, checks: [], error: applied.error, code });
        outcome.stop = { error: `lane ${id}: ${applied.error}`, code };
        break;
      }
      if (target !== lane.resultPath) keepAppliedRecord(target, lane);
      outcome.laneReports.push({ id, applied: applied.applied, checks: [] });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return outcome;
}

/** Identity is a property of the final integration tree: verify every lane
 * only after the whole batch applied. A stopped batch proves nothing. */
function attachChecks(outcome: ApplyOutcome, run: LandRun): void {
  outcome.laneReports.forEach((laneReport, i) => {
    const { lane, apply } = outcome.attempted[i];
    laneReport.checks = outcome.stop ? incompleteChecks(lane) : verifyChecks(lane, apply, run.into, run.deps);
  });
}

/** Run the batch's one compile check, unless the batch stopped or is a dry run. */
async function compileBatch(inputs: LaneInput[], outcome: ApplyOutcome, run: LandRun): Promise<CompileOutcome | { report: LandReport }> {
  if (outcome.stop || run.dryRun) return { argv: null, compile: null };
  let argv: string[] | null;
  let timeoutMs: number;
  try {
    argv = chosenCompile(run.opts, inputs, run.into);
    timeoutMs = compileTimeoutMs(run.opts, run.into);
  } catch (e) {
    return { report: writeReport(run.into, run.stamp, run.base({ lanes: outcome.laneReports, error: message(e), code: 'E_LAND_COMPILE' })) };
  }
  const compile = argv ? await runCompile(argv, run.into, run.opts, run.deps, `land/${run.stamp}:compile`, timeoutMs) : null;
  return { argv, compile };
}

function finalReport(inputs: LaneInput[], outcome: ApplyOutcome, compiled: CompileOutcome, run: LandRun): LandReport {
  const { laneReports, stop } = outcome;
  const { argv, compile } = compiled;
  const rerun = laneReports.flatMap((laneReport) => laneReport.checks.filter((check) => check.verdict === 'stale').map((check) => check.argv));
  const allApplied = laneReports.length === inputs.length && laneReports.every((laneReport) => laneReport.applied);
  const ok = run.dryRun
    ? !stop && laneReports.length === inputs.length
    : !stop && allApplied && (compile === null || compile.passed);
  const warnings = !stop && !run.dryRun && argv === null
    ? ['no compile check configured; the batch was not compiled']
    : undefined;
  return run.base({
    lanes: laneReports,
    compile,
    rerun,
    ok,
    ...(warnings ? { warnings } : {}),
    ...(stop ? { error: stop.error, code: stop.code } : {}),
    ...(compile && !compile.passed ? { error: `compile failed: ${compile.error ?? compile.argv.join(' ')}`, code: compile.code ?? 'E_LAND_COMPILE' } : {}),
  });
}

/** Apply lanes in order, verify their stored evidence on the final tree, run one
 * compile check and write `land-report.json` into the integration checkout.
 * Never commits. */
export async function land(opts: LandOptions, deps: LandDeps = {}): Promise<LandReport> {
  const clock = opts.clock ?? systemClock;
  const cwd = resolve(opts.cwd);
  const intoValue = typeof opts.into === 'string' ? opts.into.trim() : '';
  const into = intoValue ? resolve(cwd, intoValue) : '';
  const dryRun = opts.dryRun === true;
  const run: LandRun = {
    opts, cwd, into, dryRun, clock,
    stamp: stampFor(clock),
    deps: resolveLandDeps(deps),
    base: (extra) => ({ lanes: [], compile: null, rerun: [], ok: false, dryRun, into, ...extra }),
  };

  const refused = checkInto(run, intoValue);
  if (refused) return refused;
  const batch = resolveBatch(run);
  if ('report' in batch) return batch.report;

  const outcome = applyLanes(batch.inputs, run);
  attachChecks(outcome, run);
  const compiled = await compileBatch(batch.inputs, outcome, run);
  if ('report' in compiled) return compiled.report;
  return writeReport(into, run.stamp, finalReport(batch.inputs, outcome, compiled, run));
}
