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
import { scorePlanContracts, vetPlanEdges, type PlanQualityReport } from './plan-quality.ts';
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

export interface CriticalPathStep {
  id: string;
  owner: string;
  manual: boolean;
  hours: number;
}

export interface CriticalPathLag {
  from: string;
  to: string;
  hours: number;
}

export interface CriticalPathFanOut {
  id: string;
  dependents: string[];
  consumes: string;
}

export interface CriticalPathDrift {
  detected: boolean;
  expected: string[];
  actual: string[];
  reason: string | null;
}

/** What actually sets the pace of the plan, with each documented risk class. */
export interface CriticalPathReport {
  path: string[];
  hours: number;
  ownerWork: CriticalPathStep[];
  manualWork: CriticalPathStep[];
  lags: CriticalPathLag[];
  longRunning: CriticalPathStep[];
  fanOut: CriticalPathFanOut[];
  drift: CriticalPathDrift;
  risks: PlanFinding[];
}

export interface JuniorPlanCheck {
  ok: boolean;
  findings: PlanFinding[];
  cohorts: string[][];
  criticalPath: CriticalPathReport;
}

export interface PlanCheckOptions {
  /** Likely-hours ceiling before a deliverable is TOO_LARGE. Default 4. */
  maxHours?: number;
  /** Files that serialize cohorts. Default HOT_FILES. */
  hotFiles?: readonly string[];
  /** Test files registered in package.json; enables the registration-scope rule. */
  registeredTests?: readonly string[];
  /** Known critical path (for example from plan.status) to compare against. */
  expectedCriticalPath?: readonly string[];
  /** A cpm plan.status snapshot to reconcile before execution. */
  status?: unknown;
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

/** metadata.junior.acceptance entries Junior can carry (ADR 0011): a non-empty
 * string, or an object with a non-empty string text, copied as is so its id,
 * when, checks and mitigates survive planning. Anything else is dropped. */
function acceptanceEntries(value: unknown): Array<string | Record<string, any>> {
  const out: Array<string | Record<string, any>> = [];
  for (const entry of asArray(value)) {
    if (typeof entry === 'string') {
      if (entry) out.push(entry);
      continue;
    }
    if (isRecord(entry) && typeof entry.text === 'string' && entry.text) out.push(entry);
  }
  return out;
}

/** Criterion ids that appear on more than one acceptance object. */
function duplicateAcceptanceIds(entries: Array<string | Record<string, any>>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    if (typeof entry === 'string') continue;
    const id = text(entry.id).trim();
    if (!id) continue;
    if (seen.has(id)) duplicates.add(id);
    else seen.add(id);
  }
  return [...duplicates];
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


function scheduledHours(deliverable: Record<string, any>): number {
  const duration = deliverable.duration_hours;
  if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) return duration;
  const likely = likelyHours(deliverable);
  return Number.isFinite(likely) && likely >= 0 ? likely : 0;
}

function realPathIds(path: readonly string[]): string[] {
  return path.filter((id) => id !== '__start__' && id !== '__finish__');
}

function sameIds(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((id, index) => id === second[index]);
}

function expectedCriticalPath(plan: unknown, opts: PlanCheckOptions): string[] | undefined {
  if (opts.expectedCriticalPath !== undefined) return [...opts.expectedCriticalPath];
  const sources = [isRecord(opts.status) ? opts.status : undefined, isRecord(plan) ? plan : undefined].filter(Boolean) as Array<Record<string, any>>;
  for (const source of sources) {
    if (Array.isArray(source.critical_path)) return source.critical_path.map(text);
    if (Array.isArray(source.critical_ids)) return source.critical_ids.map(text);
    if (Array.isArray(source.schedule)) {
      return source.schedule
        .filter((row) => isRecord(row) && row.critical === true && row.synthetic !== true)
        .map((row) => text(row.id));
    }
    if (isRecord(source.baseline)) {
      if (Array.isArray(source.baseline.critical_path)) return source.baseline.critical_path.map(text);
      if (Array.isArray(source.baseline.critical_ids)) return source.baseline.critical_ids.map(text);
    }
    const junior = isRecord(source.metadata?.junior) ? source.metadata.junior : {};
    if (Array.isArray(junior.criticalPath)) return junior.criticalPath.map(text);
  }
  return undefined;
}

/** Longest finish-to-start chain with prerequisite lags. Cycles are bounded by
 * the visiting set and fall back to the node itself rather than recursing. */
function criticalPathOf(deliverables: Array<Record<string, any>>): { path: string[]; hours: number } {
  const byId = new Map(deliverables.map((deliverable) => [text(deliverable.id), deliverable]));
  const memo = new Map<string, { path: string[]; hours: number }>();
  const visiting = new Set<string>();

  const bestTo = (id: string): { path: string[]; hours: number } => {
    const cached = memo.get(id);
    if (cached) return cached;
    const deliverable = byId.get(id) ?? {};
    const duration = scheduledHours(deliverable);
    let best = { path: [id], hours: duration };
    if (visiting.has(id)) return best;
    visiting.add(id);
    for (const edge of asArray(deliverable.prerequisites)) {
      const dependency = text(typeof edge === 'string' ? edge : isRecord(edge) ? edge.id : '');
      if (!dependency || dependency === id || !byId.has(dependency)) continue;
      const lagRaw = isRecord(edge) ? edge.lag_hours : undefined;
      const lag = typeof lagRaw === 'number' && Number.isFinite(lagRaw) && lagRaw > 0 ? lagRaw : 0;
      const candidate = bestTo(dependency);
      const hours = candidate.hours + lag + duration;
      if (hours > best.hours || (hours === best.hours && candidate.path.concat(id).join('\u0000') > best.path.join('\u0000'))) {
        best = { path: candidate.path.concat(id), hours };
      }
    }
    visiting.delete(id);
    memo.set(id, best);
    return best;
  };

  let longest = { path: [] as string[], hours: 0 };
  for (const id of [...byId.keys()].sort()) {
    const candidate = bestTo(id);
    if (candidate.hours > longest.hours || (candidate.hours === longest.hours && candidate.path.join('\u0000') > longest.path.join('\u0000'))) longest = candidate;
  }
  return longest;
}

function criticalPathReport(
  plan: unknown,
  deliverables: Array<Record<string, any>>,
  agentCount: number,
  maxHours: number,
  opts: PlanCheckOptions,
): CriticalPathReport {
  const byId = new Map(deliverables.map((deliverable) => [text(deliverable.id), deliverable]));
  const longest = criticalPathOf(deliverables);
  const path = ['__start__', ...longest.path, '__finish__'];
  const real = realPathIds(path);
  const ownerWork: CriticalPathStep[] = [];
  const manualWork: CriticalPathStep[] = [];
  const longRunning: CriticalPathStep[] = [];
  for (const id of real) {
    const deliverable = byId.get(id) ?? {};
    const owner = text(deliverable.metadata?.owner).trim().toLowerCase() || 'agent';
    const manual = text(deliverable.metadata?.kind).trim().toLowerCase() === 'manual';
    const step = { id, owner, manual, hours: scheduledHours(deliverable) };
    if (manual) manualWork.push(step);
    else if (owner !== 'agent' && owner !== 'worker') ownerWork.push(step);
    if (step.hours > maxHours) longRunning.push(step);
  }

  const lags: CriticalPathLag[] = [];
  for (let i = 1; i < real.length; i++) {
    const from = real[i - 1];
    const to = real[i];
    const edge = asArray(byId.get(to)?.prerequisites).find((candidate) => text(typeof candidate === 'string' ? candidate : isRecord(candidate) ? candidate.id : '') === from);
    const raw = isRecord(edge) ? edge.lag_hours : undefined;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) lags.push({ from, to, hours: raw });
  }

  const dependents = new Map<string, Array<{ id: string; consumes: string }>>();
  for (const deliverable of deliverables) {
    const to = text(deliverable.id);
    for (const edge of asArray(deliverable.prerequisites)) {
      const from = text(typeof edge === 'string' ? edge : isRecord(edge) ? edge.id : '');
      if (!from) continue;
      const list = dependents.get(from) ?? [];
      list.push({ id: to, consumes: edgeConsumes(edge).trim() });
      dependents.set(from, list);
    }
  }
  const fanOut: CriticalPathFanOut[] = [];
  for (const [id, list] of dependents) {
    const groups = new Map<string, string[]>();
    for (const item of list) {
      if (!item.consumes) continue;
      const ids = groups.get(item.consumes) ?? [];
      ids.push(item.id);
      groups.set(item.consumes, ids);
    }
    for (const [consumes, ids] of groups) {
      if (ids.length >= 3) fanOut.push({ id, dependents: ids.sort(), consumes });
    }
  }

  const expected = expectedCriticalPath(plan, opts);
  let drift: CriticalPathDrift = { detected: false, expected: [], actual: real, reason: null };
  if ((isRecord(plan) && plan.definition_drift === true) || (isRecord(opts.status) && opts.status.definition_drift === true)) {
    drift = { detected: true, expected: expected ?? [], actual: real, reason: 'definition_drift is true: the plan file and stored head disagree' };
  } else if (expected !== undefined) {
    const expectedReal = realPathIds(expected.map(text));
    if (!sameIds(expectedReal, real)) {
      drift = {
        detected: true,
        expected: expectedReal,
        actual: real,
        reason: `critical path changed: expected ${expectedReal.join(' -> ') || '(none)'}, computed ${real.join(' -> ') || '(none)'}`,
      };
    } else {
      drift = { detected: false, expected: expectedReal, actual: real, reason: null };
    }
  }
  if (!drift.detected) {
    const statuses = new Map(deliverables.map((deliverable) => [text(deliverable.id), text(deliverable.status).toLowerCase()]));
    for (const deliverable of deliverables) {
      if (text(deliverable.status).toLowerCase() !== 'complete') continue;
      const incomplete = prerequisiteIds(deliverable).filter((id) => statuses.get(id) !== 'complete');
      if (incomplete.length > 0) {
        drift = {
          detected: true,
          expected: incomplete,
          actual: [text(deliverable.id)],
          reason: `${text(deliverable.id)} is complete before ${incomplete.join(', ')}; reconcile the plan with the real order`,
        };
        break;
      }
    }
  }

  const risks: PlanFinding[] = [];
  if (agentCount > 0) {
    for (const step of ownerWork) {
      risks.push(finding('OWNER_ON_CRITICAL_PATH', 'warning', [step.id], `${step.id} is ${step.owner} work on the critical path; front-load this decision`));
    }
    for (const step of manualWork) {
      risks.push(finding('MANUAL_ON_CRITICAL_PATH', 'warning', [step.id], `${step.id} is manual work on the critical path; front-load this sign-off`));
    }
  }
  for (const lag of lags) {
    risks.push(finding('LAG_ON_CRITICAL_PATH', 'warning', [lag.from, lag.to], `${lag.from} -> ${lag.to} carries a ${lag.hours}h lag on the critical path; protect or shorten it`));
  }
  for (const step of longRunning) {
    risks.push(finding('LONG_RUNNING_ON_CRITICAL_PATH', 'warning', [step.id], `${step.id} is a ${step.hours}h step on the critical path; make its pool or wall-clock duration explicit`));
  }
  for (const item of fanOut) {
    risks.push(finding('FAN_OUT', 'warning', [item.id, ...item.dependents], `${item.id} fans out to ${item.dependents.length} dependents with identical consumes '${item.consumes}'; prefer pair ordering`));
  }
  if (drift.detected) {
    risks.push(finding('PLAN_DRIFT', 'error', [ ...drift.expected, ...drift.actual ].filter(Boolean), drift.reason ?? 'plan drift detected'));
  }

  return { path, hours: longest.hours, ownerWork, manualWork, lags, longRunning, fanOut, drift, risks };
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
    const acceptance = acceptanceEntries(junior.acceptance);
    if (acceptance.length === 0) {
      findings.push(finding('NO_ACCEPTANCE', 'warning', [id], `${id} has no metadata.junior.acceptance`));
    }
    for (const duplicateId of duplicateAcceptanceIds(acceptance)) {
      findings.push(finding(
        'DUPLICATE_ACCEPTANCE_ID',
        'warning',
        [id],
        `${id} has more than one acceptance criterion with id '${duplicateId}'`,
      ));
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

  const criticalPath = criticalPathReport(plan, deliverables, agent.length, maxHours, opts);
  findings.push(...criticalPath.risks);

  return {
    ok: !findings.some((entry) => entry.severity === 'error'),
    findings,
    cohorts: agentCohorts(agent, deliverables),
    criticalPath,
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
      acceptance: acceptanceEntries(junior.acceptance),
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
  let statusFile = '';
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
    if (name === '--status') {
      statusFile = String(inline ?? args[++i]);
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
    const status = statusFile ? JSON.parse(fs.readFileSync(path.resolve(cwd, statusFile), 'utf8')) : undefined;
    const result = checkPlanForJunior(plan, {
      maxHours,
      ...(registeredTests !== undefined ? { registeredTests } : {}),
      ...(status !== undefined ? { status } : {}),
    });
    out(JSON.stringify(result, null, 2));
    return { exitCode: result.ok ? 0 : 1, result };
  }

  if (sub === 'vet') {
    const file = positional[0];
    if (!file) throw new Error('Usage: junior plan vet <plan.json>');
    const plan = JSON.parse(fs.readFileSync(path.resolve(cwd, file), 'utf8'));
    const result = vetPlanEdges(plan);
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
