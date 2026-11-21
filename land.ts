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

/** Apply lanes in order, verify their stored evidence on the final tree, run one
 * compile check and write `land-report.json` into the integration checkout.
 * Never commits. */
export async function land(opts: LandOptions, deps: LandDeps = {}): Promise<LandReport> {
  const clock = opts.clock ?? systemClock;
  const cwd = resolve(opts.cwd);
  const intoValue = typeof opts.into === 'string' ? opts.into.trim() : '';
  const into = intoValue ? resolve(cwd, intoValue) : '';
  const stamp = stampFor(clock);
  const resolvedDeps = {
    applyHandoff: deps.applyHandoff ?? applyHandoff,
    checkIdentity: deps.checkIdentity ?? checkIdentity,
    identityEqual: deps.identityEqual ?? identityEqual,
    admit: deps.admit ?? admit,
    resolveMachineConfig: deps.resolveMachineConfig ?? resolveMachineConfig,
    runSync: deps.runSync ?? runSync,
  };
  const dryRun = opts.dryRun === true;

  const base = (extra: Partial<LandReport>): LandReport => ({
    lanes: [], compile: null, rerun: [], ok: false, dryRun, into, ...extra,
  });

  if (!intoValue) return base({ error: 'missing --into integration checkout', code: 'E_LAND_INTO' });
  if (!existsSync(into) || !statSync(into).isDirectory()) {
    return base({ error: `integration checkout is not a directory: ${into}`, code: 'E_LAND_INTO' });
  }
  const status = gitStatus(into);
  if (status.error) return writeReport(into, stamp, base({ error: `could not check the integration checkout: ${status.error}`, code: 'E_LAND_INTO' }));
  if (!status.clean) return writeReport(into, stamp, base({ error: `integration checkout is not clean: ${into}`, code: 'E_LAND_DIRTY' }));

  const inputs: LaneInput[] = [];
  for (const target of opts.lanes) {
    const resolved = resolveLane(target, cwd);
    if (!resolved.lane) return writeReport(into, stamp, base({ error: resolved.error, code: 'E_LAND_LANE' }));
    inputs.push(resolved.lane);
  }

  const notReady = inputs.find(({ result }) => result?.status !== 'ready_for_review');
  if (notReady) {
    const id = String(notReady.result?.id ?? notReady.target);
    return writeReport(into, stamp, base({
      lanes: [{ id, applied: false, checks: [], error: `lane status is "${notReady.result?.status ?? 'unknown'}"; expected "ready_for_review"`, code: 'E_LAND_NOT_READY' }],
      error: `lane ${id} is not ready_for_review`,
      code: 'E_LAND_NOT_READY',
    }));
  }

  // A result that records the lane's own source checkout is redirected to the
  // integration checkout: land applies to --into, never back into the lane.
  const scratch = mkdtempSync(join(tmpdir(), 'junior-land-'));
  const laneReports: LandLaneReport[] = [];
  const attempted: { lane: LaneInput; apply: ApplyHandoffResult }[] = [];
  let stop: { error: string; code: string } | undefined;
  try {
    for (const laneInput of inputs) {
      const id = String(laneInput.result?.id ?? laneInput.target);
      let target = laneInput.resultPath;
      if (typeof laneInput.result?.sourceCwd === 'string' && laneInput.result.sourceCwd.trim()) {
        const recorded = resolve(cwd, laneInput.result.sourceCwd);
        if (recorded !== into) {
          const artifact = join(scratch, `lane-${laneReports.length}`);
          mkdirSync(artifact, { recursive: true });
          writeFileSync(join(artifact, 'result.json'), JSON.stringify({ ...laneInput.result, sourceCwd: into }));
          target = join(artifact, 'result.json');
        }
      }
      let applied: ApplyHandoffResult;
      try {
        applied = resolvedDeps.applyHandoff(target, { cwd: into, dryRun, noLink: true, clock });
      } catch (e) {
        applied = { applied: false, dryRun, files: [], artifactDir: laneInput.artifactDir, error: message(e) };
      }
      if (applied.error) {
        laneReports.push({
          id,
          applied: false,
          checks: [],
          error: applied.error,
          code: applied.conflicts?.length ? 'E_LAND_CONFLICT' : 'E_LAND_APPLY',
        });
        attempted.push({ lane: laneInput, apply: applied });
        stop = { error: `lane ${id}: ${applied.error}`, code: applied.conflicts?.length ? 'E_LAND_CONFLICT' : 'E_LAND_APPLY' };
        break;
      }
      // Keep the applied record beside the original lane artifact when a
      // redirected result was used.
      if (target !== laneInput.resultPath) {
        try { cpSync(join(dirname(target), 'applied.json'), join(laneInput.artifactDir, 'applied.json')); }
        catch { /* best effort; the apply itself already succeeded */ }
      }
      laneReports.push({ id, applied: applied.applied, checks: [] });
      attempted.push({ lane: laneInput, apply: applied });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // Identity is a property of the final integration tree: verify every lane
  // only after the whole batch applied. A stopped batch proves nothing.
  for (let i = 0; i < laneReports.length; i++) {
    laneReports[i].checks = stop
      ? incompleteChecks(attempted[i].lane)
      : verifyChecks(attempted[i].lane, attempted[i].apply, into, resolvedDeps);
  }

  let argv: string[] | null = null;
  let timeoutMs = 600_000;
  let compile: LandCompileReport | null = null;
  if (!stop && !dryRun) {
    try {
      argv = chosenCompile(opts, inputs, into);
      timeoutMs = compileTimeoutMs(opts, into);
    } catch (e) {
      return writeReport(into, stamp, base({ lanes: laneReports, error: message(e), code: 'E_LAND_COMPILE' }));
    }
    if (argv) compile = await runCompile(argv, into, opts, resolvedDeps, `land/${stamp}:compile`, timeoutMs);
  }

  const rerun = laneReports.flatMap((laneReport) => laneReport.checks.filter((check) => check.verdict === 'stale').map((check) => check.argv));
  const allApplied = laneReports.length === inputs.length && laneReports.every((laneReport) => laneReport.applied);
  const ok = dryRun
    ? !stop && laneReports.length === inputs.length
    : !stop && allApplied && (compile === null || compile.passed);
  const warnings = !stop && !dryRun && argv === null
    ? ['no compile check configured; the batch was not compiled']
    : undefined;
  const report = base({
    lanes: laneReports,
    compile,
    rerun,
    ok,
    ...(warnings ? { warnings } : {}),
    ...(stop ? { error: stop.error, code: stop.code } : {}),
    ...(compile && !compile.passed ? { error: `compile failed: ${compile.error ?? compile.argv.join(' ')}`, code: compile.code ?? 'E_LAND_COMPILE' } : {}),
  });
  return writeReport(into, stamp, report);
}
