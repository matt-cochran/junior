// ---------------------------------------------------------------------------
// cpm plan -> Junior execution optimization.
//
// A cpm plan is a JSON `{ deliverables: [...] }` document. Junior can execute
// the agent-owned, non-milestone deliverables as bounded handoffs, but only
// when the plan is split into safe cohorts: deliverables that share an owned
// file must be ordered by a prerequisite chain, hot registration files must be
// serialized, and every handoff needs its own acceptance criteria and checks.
//
// `checkPlanForJunior` is a pure linter with Kahn-layered cohorts.
// `planContracts` turns each agent deliverable into a Junior contract skeleton.
// `runPlanCommand` is the thin CLI shell for `junior plan check|contracts`.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { scorePlanContracts, type PlanQualityReport } from './plan-quality.ts';
import type { GateClassifier } from './worker.ts';

/** Registration files whose edits serialize otherwise independent cohorts. */
export const HOT_FILES: readonly string[] = [
  'package.json',
  'package-lock.json',
  'scripts/build.mjs',
  'CHANGELOG.md',
  'README.md',
];

/** Files that coordinate test and build registration across deliverables. */
export const REGISTRATION_FILES: readonly string[] = [
  'package.json',
  'package-lock.json',
  'scripts/build.mjs',
  'junior.ts',
  'cli.test.ts',
  'CHANGELOG.md',
  'README.md',
];

const TEST_FILE_PATTERN = /\.test\.(?:ts|mjs|js)$/;

export type FindingSeverity = 'error' | 'warning' | 'info';

export interface PlanFinding {
  code: string;
  severity: FindingSeverity;
  ids: string[];
  message: string;
}

export interface JuniorPlanCheck {
  ok: boolean;
  findings: PlanFinding[];
  cohorts: string[][];
}

export interface PlanCheckOptions {
  /** Likely-hours ceiling before a deliverable is TOO_LARGE. Default 4. */
  maxHours?: number;
  /** Files that serialize cohorts. Default HOT_FILES. */
  hotFiles?: readonly string[];
  /** Test files registered in package.json; enables the registration-scope rule. */
  registeredTests?: readonly string[];
}

export interface ContractOptions {
  cwd: string;
  /** Repo name -> absolute checkout, used for deliverables with metadata.repo. */
  repos?: Record<string, string>;
  provider?: string;
  model?: string;
}

export interface JuniorContract {
  id: string;
  contract: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function deliverablesOf(plan: unknown): Array<Record<string, any>> {
  if (Array.isArray(plan)) return plan.filter(isRecord);
  if (isRecord(plan) && Array.isArray(plan.deliverables)) return plan.deliverables.filter(isRecord);
  return [];
}

/** Plan-level `metadata.junior` block, shared by the linter and the contract
 * builder. A bare deliverables array has none. */
function planJunior(plan: unknown): Record<string, any> {
  return isRecord(plan) && isRecord(plan.metadata?.junior) ? plan.metadata.junior : {};
}

/** Plan-level approved model profile ids, trimmed and de-duplicated. */
function approvedProfilesOf(plan: unknown): string[] {
  const out: string[] = [];
  for (const entry of asArray(planJunior(plan).approvedProfiles)) {
    const profile = text(entry).trim();
    if (profile && !out.includes(profile)) out.push(profile);
  }
  return out;
}

/** Deliverables Junior can execute: not a milestone, not manager/owner-run and
 * not a manual `kind`. `metadata.kind === 'manual'` and owner `manager`/`owner`
 * are manager-controlled, so the linter leaves them alone. */
function isAgentDeliverable(deliverable: Record<string, any>): boolean {
  if (deliverable.milestone === true) return false;
  const owner = text(deliverable.metadata?.owner).toLowerCase();
  if (owner === 'manager' || owner === 'owner') return false;
  if (text(deliverable.metadata?.kind).toLowerCase() === 'manual') return false;
  return true;
}

function ownedFiles(deliverable: Record<string, any>): string[] {
  return asArray(deliverable.owned_files)
    .map((entry) => (typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.path === 'string' ? entry.path : ''))
    .filter(Boolean);
}

/** Test file tokens (`.test.ts`, `.test.mjs`, `.test.js`) from `scripts.test`. */
export function registeredTestFiles(packageJson: unknown): string[] {
  const scripts = isRecord(packageJson) ? packageJson.scripts : undefined;
  const test = isRecord(scripts) ? scripts.test : undefined;
  if (typeof test !== 'string') return [];
  return test.split(/\s+/).filter((token) => TEST_FILE_PATTERN.test(token));
}

/** Some plans use string prerequisites, some `{id, consumes}` edges. */
function prerequisiteIds(deliverable: Record<string, any>): string[] {
  return asArray(deliverable.prerequisites)
    .map((edge) => (typeof edge === 'string' ? edge : isRecord(edge) ? edge.id : ''))
    .map(text)
    .filter(Boolean);
}

function edgeConsumes(edge: unknown): string {
  if (typeof edge === 'string') return '';
  return isRecord(edge) ? text(edge.consumes) : '';
}

/** Load in hours, preferring the cpm `estimate.likely` over the coarse field. */
function likelyHours(deliverable: Record<string, any>): number {
  const likely = deliverable.estimate?.likely;
  if (typeof likely === 'number' && Number.isFinite(likely)) return likely;
  const coarse = deliverable.estimated_effort_hours;
  return typeof coarse === 'number' && Number.isFinite(coarse) ? coarse : NaN;
}

/** True when a deliverable transitively lists `id` as a prerequisite and owns package.json. */
function hasPackageJsonDescendant(byId: Map<string, Record<string, any>>, id: string): boolean {
  for (const candidate of byId.values()) {
    const candidateId = text(candidate.id);
    if (candidateId === id) continue;
    if (!ownedFiles(candidate).includes('package.json')) continue;
    if (isAncestor(byId, id, candidateId)) return true;
  }
  return false;
}

/** True when `ancestorId` appears in the transitive prerequisites of `id`. */
function isAncestor(byId: Map<string, Record<string, any>>, ancestorId: string, id: string): boolean {
  const seen = new Set<string>();
  const stack = [...prerequisiteIds(byId.get(id) ?? {})];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === ancestorId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const dependency = byId.get(current);
    if (dependency) stack.push(...prerequisiteIds(dependency));
  }
  return false;
}

function finding(code: string, severity: FindingSeverity, ids: string[], message: string): PlanFinding {
  return { code, severity, ids, message };
}

/** Kahn layers of agent deliverables (ids sorted), each split greedily so no
 * cohort holds two deliverables that share an owned file. A manager-owned or
 * milestone deliverable is not itself in a cohort, but the agent deliverables
 * behind it still constrain the ones that depend on it. */
function agentCohorts(agent: Array<Record<string, any>>, all: Array<Record<string, any>>): string[][] {
  const byId = new Map(agent.map((deliverable) => [text(deliverable.id), deliverable]));
  const ids = [...byId.keys()].sort();
  const agentIds = new Set(ids);
  const dependencies = new Map<string, Set<string>>();
  const allById = new Map(all.map((deliverable) => [text(deliverable.id), deliverable]));
  // The nearest agent ancestors of `id`, walking through non-agent deliverables.
  const agentAncestors = (id: string): Set<string> => {
    const found = new Set<string>();
    const seen = new Set<string>();
    const stack = [...prerequisiteIds(allById.get(id) ?? {})];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      if (agentIds.has(current)) { found.add(current); continue; }
      stack.push(...prerequisiteIds(allById.get(current) ?? {}));
    }
    return found;
  };
  for (const id of ids) dependencies.set(id, agentAncestors(id));

  const remaining = new Set(ids);
  const layers: string[][] = [];
  while (remaining.size > 0) {
    let ready = [...remaining]
      .filter((id) => [...(dependencies.get(id) as Set<string>)].every((dep) => !remaining.has(dep)))
      .sort();
    // A cycle cannot be layered; keep every remaining id in one layer so none
    // silently disappears from the report.
    if (ready.length === 0) ready = [...remaining].sort();
    for (const id of ready) remaining.delete(id);
    layers.push(ready);
  }

  const cohorts: string[][] = [];
  for (const layer of layers) {
    const bins: Array<{ files: Set<string>; ids: string[] }> = [];
    for (const id of layer) {
      const files = ownedFiles(byId.get(id) as Record<string, any>);
      let bin = bins.find((candidate) => files.every((file) => !candidate.files.has(file)));
      if (!bin) {
        bin = { files: new Set<string>(), ids: [] };
        bins.push(bin);
      }
      for (const file of files) bin.files.add(file);
      bin.ids.push(id);
    }
    for (const bin of bins) cohorts.push(bin.ids);
  }
  return cohorts;
}

/** Lint a cpm plan for safe Junior execution and describe its cohorts. */
export function checkPlanForJunior(plan: unknown, opts: PlanCheckOptions = {}): JuniorPlanCheck {
  const maxHours = typeof opts.maxHours === 'number' && Number.isFinite(opts.maxHours) ? opts.maxHours : 4;
  const hotFiles = opts.hotFiles ?? HOT_FILES;
  const registeredTests = opts.registeredTests;
  const deliverables = deliverablesOf(plan);
  const agent = deliverables.filter(isAgentDeliverable);
  // Ancestry spans every deliverable, so an order through a manager-owned step still counts.
  const byId = new Map(deliverables.map((deliverable) => [text(deliverable.id), deliverable]));
  const planApprovedProfiles = approvedProfilesOf(plan);
  const findings: PlanFinding[] = [];

  for (const deliverable of agent) {
    const id = text(deliverable.id);
    const files = ownedFiles(deliverable);

    if (files.length === 0) {
      findings.push(finding('NO_OWNED_FILES', 'warning', [id], `${id} owns no files and cannot be parallelized safely`));
    }

    const hours = likelyHours(deliverable);
    if (Number.isFinite(hours) && hours > maxHours) {
      findings.push(finding('TOO_LARGE', 'warning', [id], `${id} likely takes ${hours}h (> ${maxHours}h); split it into chained handoffs`));
    }

    const junior = isRecord(deliverable.metadata?.junior) ? deliverable.metadata.junior : {};
    if (asArray(junior.acceptance).map(text).filter(Boolean).length === 0) {
      findings.push(finding('NO_ACCEPTANCE', 'warning', [id], `${id} has no metadata.junior.acceptance`));
    }
    if (asArray(junior.checks).length === 0) {
      findings.push(finding('NO_CHECKS', 'warning', [id], `${id} has no metadata.junior.checks; a deliverable needs an independent check`));
    }

    const hot = files.filter((file) => hotFiles.includes(file));
    if (hot.length > 0) {
      findings.push(finding('HOT_FILE', 'info', [id, ...hot], `${id} owns hot file(s) ${hot.join(', ')}; prefer one final registration deliverable`));
    }

    const requestedProfile = text(junior.profile).trim();
    if (requestedProfile && requestedProfile !== 'general' && !planApprovedProfiles.includes(requestedProfile)) {
      findings.push(finding(
        'NEEDS_MODEL_APPROVAL',
        'warning',
        [id, requestedProfile],
        `${id} pins model profile '${requestedProfile}'; split or tighten it to fit the default model, or record the approval in plan.metadata.junior.approvedProfiles`,
      ));
    }

    if (registeredTests !== undefined) {
      const unregistered = files.filter((file) => TEST_FILE_PATTERN.test(file) && !registeredTests.includes(file));
      if (unregistered.length > 0 && !files.includes('package.json') && !hasPackageJsonDescendant(byId, id)) {
        findings.push(finding(
          'REGISTRATION_OUTSIDE_SCOPE',
          'warning',
          [id, ...unregistered],
          `${id} owns test file(s) ${unregistered.join(', ')} not registered in package.json; workers then edit package.json outside their owned files (observed in 22 of 79 plan-backed runs, H2)`,
        ));
      }
    }

    for (const edge of asArray(deliverable.prerequisites)) {
      if (edgeConsumes(edge).trim()) continue;
      const dependencyId = (typeof edge === 'string' ? edge : isRecord(edge) ? edge.id : '') as string;
      const dependency = text(dependencyId);
      findings.push(finding(
        'INTERFACE_UNSPECIFIED',
        'warning',
        [id, dependency].filter(Boolean),
        `${id} depends on ${dependency || 'a prerequisite'} without consumes text`,
      ));
    }
  }

  for (let i = 0; i < agent.length; i++) {
    for (let j = i + 1; j < agent.length; j++) {
      const first = agent[i];
      const second = agent[j];
      const firstId = text(first.id);
      const secondId = text(second.id);
      const secondFiles = new Set(ownedFiles(second));
      const shared = ownedFiles(first).filter((file) => secondFiles.has(file));
      if (shared.length === 0) continue;
      if (isAncestor(byId, firstId, secondId) || isAncestor(byId, secondId, firstId)) continue;
      findings.push(finding(
        'SHARED_FILE_PARALLEL',
        'error',
        [firstId, secondId],
        `${firstId} and ${secondId} own ${shared.join(', ')} without a prerequisite relation`,
      ));
    }
  }

  return {
    ok: !findings.some((entry) => entry.severity === 'error'),
    findings,
    cohorts: agentCohorts(agent, deliverables),
  };
}

/** One Junior contract skeleton per agent deliverable; provider/model are only
 * included when explicitly given so Jev routing applies by default. */
export function planContracts(plan: unknown, opts: ContractOptions): JuniorContract[] {
  const planApprovedProfiles = approvedProfilesOf(plan);
  return deliverablesOf(plan).filter(isAgentDeliverable).map((deliverable) => {
    const id = text(deliverable.id);
    const junior = isRecord(deliverable.metadata?.junior) ? deliverable.metadata.junior : {};
    const repo = text(deliverable.metadata?.repo).trim();
    const repoCwd = repo ? opts.repos?.[repo] : undefined;
    // A plan may address files in another checkout with a `<repo>:` prefix.
    // Strip it before scope/constraint/registration rules see the path.
    const files = ownedFiles(deliverable).map((file) =>
      repo && file.startsWith(`${repo}:`) ? file.slice(repo.length + 1) : file,
    );
    const checks = asArray(junior.checks);
    const requestedProfile = text(junior.profile).trim();
    const cargoCheck = checks.some((check) => isRecord(check) && text(check.command) === 'cargo');
    const unownedRegistrations = REGISTRATION_FILES.filter((file) => !files.includes(file));
    const constraints = [
      `Only modify ${files.join(', ')}`,
      'Work only inside the current working directory; no commits or pushes; no nested workers',
      ...(unownedRegistrations.length > 0
        ? [`Do not edit registration files you do not own (${unownedRegistrations.join(', ')}); if your change needs registering there, say so in your final message instead`]
        : []),
    ];
    for (const entry of asArray(junior.constraints)) {
      const constraint = text(entry);
      if (constraint && !constraints.includes(constraint)) constraints.push(constraint);
    }
    const contract: Record<string, unknown> = {
      id,
      deliverable: text(deliverable.metadata?.artifact),
      cwd: repoCwd || opts.cwd,
      workflow: text(junior.workflow) || 'test_first',
      acceptance: asArray(junior.acceptance).map(text).filter(Boolean),
      constraints,
      checks,
      scope: { owned: files },
      isolation: 'worktree',
      jev: { mode: 'shadow' },
      modelProfile: requestedProfile || 'general',
      execution: {
        deadlineMs: 1500000,
        ...(cargoCheck ? { checkTimeoutMs: 900000 } : {}),
        ...(isRecord(junior.execution) ? junior.execution : {}),
      },
    };
    if (Array.isArray(junior.context)) contract.context = junior.context;
    if (planApprovedProfiles.length > 0) contract.approvedProfiles = planApprovedProfiles;
    if (opts.provider !== undefined) contract.provider = opts.provider;
    if (opts.model !== undefined) contract.model = opts.model;
    return { id, contract };
  });
}

/** Score a plan file's contracts at plan-check time through the worker's own
 * preflight gate. The caller supplies the classifier seam so tests and the CLI
 * can keep Jev calls explicit. */
export async function scorePlanFile(
  planPath: string,
  classify: GateClassifier,
  opts: { cwd: string },
): Promise<PlanQualityReport> {
  const plan = JSON.parse(fs.readFileSync(path.resolve(opts.cwd, planPath), 'utf8'));
  const repos = planReposIn(opts.cwd);
  return scorePlanContracts(planContracts(plan, { cwd: opts.cwd, ...(repos !== undefined ? { repos } : {}) }), classify);
}

export interface PlanCommandDeps {
  cwd?: string;
  out?: (s: string) => void;
}

/** Read `scripts.test` from a project package.json when present. A malformed
 * package.json fails fast rather than silently skipping the registration rule. */
function registeredTestsIn(cwd: string): string[] | undefined {
  const packagePath = path.join(cwd, 'package.json');
  if (!fs.existsSync(packagePath)) return undefined;
  try {
    return registeredTestFiles(JSON.parse(fs.readFileSync(packagePath, 'utf8')));
  } catch (error) {
    throw new Error(`${packagePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Read `plan.repos` (repo name -> absolute checkout) from delivery.config.json.
 * A malformed config fails fast, like package.json. */
function planReposIn(cwd: string): Record<string, string> | undefined {
  const configPath = path.join(cwd, 'delivery.config.json');
  if (!fs.existsSync(configPath)) return undefined;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const repos = isRecord(config.plan) && isRecord(config.plan.repos) ? config.plan.repos : undefined;
    if (!repos) return undefined;
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(repos)) {
      if (typeof value === 'string' && value) out[name] = value;
    }
    return out;
  } catch (error) {
    throw new Error(`${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Thin CLI shell for `junior plan check|contracts`; prints its own JSON. */
export function runPlanCommand(argv: string[], deps: PlanCommandDeps = {}): { exitCode: number; result: any } {
  const out = deps.out ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const cwd = deps.cwd ?? process.cwd();
  const args = argv[0] === 'plan' ? argv.slice(1) : argv;
  const sub = args[0];

  const positional: string[] = [];
  let maxHours = 4;
  let outDir = '';
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (name === '--max-hours') {
      maxHours = Number(inline ?? args[++i]);
      continue;
    }
    if (name === '--out') {
      outDir = String(inline ?? args[++i]);
      continue;
    }
    if (name === '--jev') {
      if (inline !== undefined) throw new Error('Option --jev does not take a value');
      continue;
    }
    positional.push(arg);
  }

  if (sub === 'check') {
    const file = positional[0];
    if (!file) throw new Error('Usage: junior plan check <plan.json> [--max-hours N]');
    const plan = JSON.parse(fs.readFileSync(path.resolve(cwd, file), 'utf8'));
    const registeredTests = registeredTestsIn(cwd);
    const result = checkPlanForJunior(plan, { maxHours, ...(registeredTests !== undefined ? { registeredTests } : {}) });
    out(JSON.stringify(result, null, 2));
    return { exitCode: result.ok ? 0 : 1, result };
  }

  if (sub === 'contracts') {
    const file = positional[0];
    if (!file) throw new Error('Usage: junior plan contracts <plan.json> --out <dir>');
    if (!outDir) throw new Error('plan contracts requires --out <dir>');
    const plan = JSON.parse(fs.readFileSync(path.resolve(cwd, file), 'utf8'));
    const dir = path.resolve(cwd, outDir);
    const written: string[] = [];
    const repos = planReposIn(cwd);
    for (const item of planContracts(plan, { cwd, ...(repos !== undefined ? { repos } : {}) })) {
      const target = path.join(dir, `${item.id}.json`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(item.contract, null, 2)}\n`);
      written.push(target);
    }
    const result = { written };
    out(JSON.stringify(result, null, 2));
    return { exitCode: 0, result };
  }

  throw new Error(`Unknown plan subcommand: ${sub || '(none)'}`);
}
