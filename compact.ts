// ---------------------------------------------------------------------------
// Compact session-start context.
//
// The block is rebuilt from local companion stores and HOP state only: no
// model call, no network call. Every section fails soft because this runs
// inside a session-start hook, where an exception would lose the whole block.
// When the block is too large, low-priority detail is dropped first while the
// active-plan section is never cut.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  buildToolEnv,
  callHop as defaultCallHop,
  inspectHop,
  loadHop,
  type HopManifest,
} from './tools/tools.ts';
import { planStatusRows, spHypotheses } from './companion-shapes.ts';

/** Availability of one compact-context section. */
export type CompactSectionStatus = 'ok' | 'none' | 'unavailable';

/** Inputs for `buildCompactBlock`; filesystem and companion access are injectable. */
export type CompactDeps = {
  cwd: string;
  hopPath?: string;
  callHop?: typeof defaultCallHop;
  maxChars?: number;
  /** Runs whose latest attempt started longer ago than this are not in flight. Default 48. */
  inFlightMaxAgeHours?: number;
  now?: () => Date;
  readDir?: (p: string) => string[];
  readFile?: (p: string) => string;
  exists?: (p: string) => boolean;
  /** Deliverable ids that cpm reports complete; failures resolve to an empty set. */
  completedDeliverables?: () => Promise<Set<string>>;
};

/** Rendered block plus per-section availability and truncation state. */
export type CompactBlock = {
  markdown: string;
  truncated: boolean;
  sections: Record<string, CompactSectionStatus>;
};

const DEFAULT_MAX_CHARS = 6000;
const DEFAULT_IN_FLIGHT_MAX_AGE_HOURS = 48;
const SUCCESS_STATUSES = new Set(['ready_for_review', 'simulation_passed']);
const FOLLOW_UP_SUFFIXES = ['-repair', '-resume'];
const PLAN_HEADING = 'Active plan';
const RISK_HEADING = 'Risk';
const HYPOTHESES_HEADING = 'Open hypotheses';
const RUNS_HEADING = 'In-flight runs';

type JsonObject = Record<string, any>;

type Block = {
  key: 'plan' | 'risk' | 'hypotheses' | 'runs';
  heading: string;
  status: CompactSectionStatus;
  lines: string[];
  removable: boolean;
};

type Run = { id: string; stamp: string; status: string };

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  if (!isObject(error)) return false;
  return error.code === 'ENOENT' || /ENOENT|no such file/i.test(errorMessage(error));
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (isObject(item) ? text(item.id ?? item.name) : text(item))).filter(Boolean);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function statusMark(row: unknown): string {
  if (Array.isArray(row)) {
    const raw = row.length >= 2 ? row[1] : undefined;
    return isObject(raw) ? text(raw.status ?? raw.mark_status).toLowerCase() : text(raw).toLowerCase();
  }
  if (isObject(row)) {
    const raw = row.status ?? row.mark_status ?? row.markStatus;
    return isObject(raw) ? text(raw.status ?? raw.mark_status).toLowerCase() : text(raw).toLowerCase();
  }
  return '';
}

function planRecord(result: unknown): JsonObject | null {
  if (!isObject(result)) return null;
  if (isObject(result.plan)) return result.plan;
  if (isObject(result.active_plan)) return result.active_plan;
  if (result.plan_id !== undefined || result.name !== undefined || result.deliverables !== undefined) return result;
  return null;
}

function planLines(plan: JsonObject): string[] {
  const lines: string[] = [];
  if (plan.name !== undefined) lines.push(`- name: ${text(plan.name)}`);
  if (plan.variant !== undefined) lines.push(`- variant: ${text(plan.variant)}`);
  if (plan.plan_id !== undefined) lines.push(`- plan_id: ${text(plan.plan_id)}`);
  const baseline =
    numberOrNull(plan.baseline_number) ??
    (isObject(plan.baseline) ? numberOrNull(plan.baseline.baseline_number) : null);
  if (baseline !== null) lines.push(`- baseline: ${baseline}`);

  const rows = Array.isArray(plan.deliverables)
    ? plan.deliverables
    : Array.isArray(plan.rows)
      ? plan.rows
      : Array.isArray(plan.statuses)
        ? plan.statuses
        : null;
  const explicitTotal = numberOrNull(plan.total) ?? numberOrNull(plan.deliverable_count);
  const explicitComplete = numberOrNull(plan.complete) ?? numberOrNull(plan.complete_count);
  const total = rows !== null ? rows.length : explicitTotal;
  let complete = explicitComplete;
  if (rows !== null) {
    complete = rows.filter((row) => {
      const mark = statusMark(row);
      return mark === 'complete' || mark === 'completed' || mark === 'done';
    }).length;
  } else if (complete === null && plan.plan_complete === true && total !== null) {
    complete = total;
  }
  if (complete !== null && total !== null) lines.push(`- complete: ${complete}/${total}`);

  const critical = stringList(plan.critical_ids ?? plan.critical_path).filter(
    (id) => id !== '__start__' && id !== '__finish__',
  );
  if (critical.length > 0) lines.push(`- critical path: ${critical.join(', ')}`);
  const ready = stringList(plan.ready);
  if (ready.length > 0) lines.push(`- ready: ${ready.join(', ')}`);
  return lines;
}

function sessionItems(result: unknown): JsonObject[] {
  if (Array.isArray(result)) return result.filter(isObject);
  if (!isObject(result)) return [];
  for (const key of ['sessions', 'items', 'results']) {
    if (Array.isArray(result[key])) return result[key].filter(isObject);
    if (isObject(result[key])) {
      return Object.entries(result[key])
        .filter(([, item]) => isObject(item))
        .map(([id, item]) => ({ ...(item as JsonObject), id: (item as JsonObject).id ?? id }));
    }
  }
  return [];
}

function blockerCount(session: JsonObject): number {
  for (const key of ['blockers', 'blocking', 'blocked']) {
    if (Array.isArray(session[key])) return session[key].length;
    const count = numberOrNull(session[key]);
    if (count !== null) return count;
  }
  for (const key of ['blocker_count', 'blockerCount', 'blocked_count', 'open_blockers']) {
    const count = numberOrNull(session[key]);
    if (count !== null) return count;
  }
  if (isObject(session.readiness)) return blockerCount(session.readiness);
  return 0;
}

function sessionReady(session: JsonObject): boolean {
  const raw = session.ready ?? (isObject(session.readiness) ? session.readiness.ready : undefined);
  if (typeof raw === 'boolean') return raw;
  return raw === 'ready' || raw === 'yes' || raw === 'true';
}

function acceptedRiskCount(session: JsonObject): number | null {
  for (const key of [
    'accepted_risks',
    'acceptedRisks',
    'accepted_risk_count',
    'acceptedRiskCount',
    'accepted',
    'accepted_count',
    'risks_accepted',
  ]) {
    const value = session[key];
    if (Array.isArray(value)) return value.length;
    const count = numberOrNull(value);
    if (count !== null) return count;
  }
  if (Array.isArray(session.risks)) {
    return session.risks.filter(
      (risk) =>
        isObject(risk) &&
        (risk.accepted === true || ['accepted', 'acceptable'].includes(text(risk.standing ?? risk.disposition).toLowerCase())),
    ).length;
  }
  return null;
}

function riskLines(result: unknown): string[] {
  return sessionItems(result).map((session) => {
    const id = text(session.id ?? session.session_id ?? session.sessionId);
    const accepted = acceptedRiskCount(session);
    const detail = [`ready=${sessionReady(session) ? 'yes' : 'no'}`, `blockers=${blockerCount(session)}`];
    if (accepted !== null) detail.push(`accepted risks: ${accepted}`);
    return `- ${id || '(unnamed session)'}: ${detail.join(' ')}`;
  });
}

function openHypotheses(result: unknown): JsonObject[] {
  const parsed = spHypotheses(result);
  return parsed.items.filter((hypothesis) => text(hypothesis.status).trim().toLowerCase() === 'open');
}

function hypothesisLines(hypotheses: Array<{ session: string; hypothesis: JsonObject }>): string[] {
  return hypotheses.map(({ session, hypothesis }) => {
    const id = text(hypothesis.id ?? hypothesis.hypothesis_id) || '(unnamed)';
    const statement = text(hypothesis.statement ?? hypothesis.claim ?? hypothesis.title);
    return `- ${id}${statement ? `: ${statement}` : ''} (session ${session})`;
  });
}

function runStatus(resultPath: string, readFile: (p: string) => string, exists: (p: string) => boolean): string {
  if (!exists(resultPath)) return 'running';
  const parsed = JSON.parse(readFile(resultPath));
  return isObject(parsed) && typeof parsed.status === 'string' && parsed.status.trim()
    ? parsed.status
    : 'unknown';
}

function planIds(result: unknown): string[] {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isObject(value)) return;
    for (const key of ['plan_id', 'planId']) {
      const id = value[key];
      if (typeof id === 'string' && id.trim()) ids.add(id);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'plan_id' && key !== 'planId') visit(child);
    }
  };
  visit(result);
  return [...ids];
}

async function defaultCompletedDeliverables(
  hopPath: string,
  hopExists: boolean,
  callHop: typeof defaultCallHop,
): Promise<Set<string>> {
  const completed = new Set<string>();
  if (!hopExists) return completed;
  try {
    const listing = await callHop(hopPath, 'cpm', { tool: 'plan.list', arguments: {} });
    if (!listing.ok || listing.isError) return completed;
    for (const planId of planIds(listing.result)) {
      const status = await callHop(hopPath, 'cpm', { tool: 'plan.status', arguments: { plan_id: planId } });
      if (!status.ok || status.isError) return new Set();
      for (const row of planStatusRows(status.result).items) {
        if (row.id && (row.status === 'complete' || row.status === 'completed')) completed.add(row.id);
      }
    }
  } catch {
    return new Set();
  }
  return completed;
}

function runItems(
  cwd: string,
  readDir: (p: string) => string[],
  readFile: (p: string) => string,
  exists: (p: string) => boolean,
  cutoffMs: number,
  completed: ReadonlySet<string>,
): Run[] {
  const root = join(cwd, '.delivery');
  if (!exists(root)) return [];
  let ids: string[];
  try {
    ids = readDir(root);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const latest: Run[] = [];
  for (const id of ids) {
    if (id.startsWith('.') || id === 'setup') continue;
    let entries: string[];
    try {
      entries = readDir(join(root, id));
    } catch {
      continue;
    }
    const stamps = entries
      .filter((name) => !name.startsWith('.') && !/\.[A-Za-z0-9]+$/.test(name))
      .sort((a, b) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b)))
      .reverse();
    const stamp = stamps[0];
    if (stamp === undefined) continue;
    latest.push({ id, stamp, status: runStatus(join(root, id, stamp, 'result.json'), readFile, exists) });
  }

  // A later successful `<id>-repair` or `<id>-resume` run resolves the original.
  const statusById = new Map(latest.map((run) => [run.id, run.status]));
  const resolved = (id: string): boolean =>
    FOLLOW_UP_SUFFIXES.some((suffix) => SUCCESS_STATUSES.has(statusById.get(`${id}${suffix}`) ?? ''));
  const recent = (stamp: string): boolean => !/^\d+$/.test(stamp) || Number(stamp) >= cutoffMs;
  return latest
    .filter(
      (run) =>
        !SUCCESS_STATUSES.has(run.status) &&
        !resolved(run.id) &&
        recent(run.stamp) &&
        !completed.has(run.id) &&
        !run.id.startsWith('live-check-'),
    )
    .sort((a, b) => b.stamp.localeCompare(a.stamp) || a.id.localeCompare(b.id));
}

async function planBlock(
  hopPath: string,
  hopExists: boolean,
  callHop: typeof defaultCallHop,
): Promise<Block> {
  const block: Block = { key: 'plan', heading: PLAN_HEADING, status: 'none', lines: [], removable: false };
  if (!hopExists) return block;
  try {
    const outcome = await callHop(hopPath, 'cpm', { tool: 'plan.status', arguments: { active: true } });
    if (!outcome.ok || outcome.isError) {
      const message = outcome.error?.message ?? outcome.note ?? 'plan.status failed';
      if (/NO_ACTIVE_PLAN|no active plan/i.test(`${outcome.error?.code ?? ''} ${message}`)) return block;
      return { ...block, status: 'unavailable', lines: [`unavailable: ${message}`] };
    }
    const plan = planRecord(outcome.result);
    if (plan === null) return block;
    const lines = planLines(plan);
    if (lines.length === 0) return block;
    return { ...block, status: 'ok', lines };
  } catch (error) {
    if (/NO_ACTIVE_PLAN|no active plan/i.test(errorMessage(error))) return block;
    return { ...block, status: 'unavailable', lines: [`unavailable: ${errorMessage(error)}`] };
  }
}

async function riskBlock(
  hopPath: string,
  hopExists: boolean,
  callHop: typeof defaultCallHop,
): Promise<Block> {
  const block: Block = { key: 'risk', heading: RISK_HEADING, status: 'none', lines: [], removable: true };
  if (!hopExists) return block;
  try {
    const outcome = await callHop(hopPath, 'fmeca', { tool: 'session.list', arguments: {} });
    if (!outcome.ok || outcome.isError) {
      return {
        ...block,
        status: 'unavailable',
        lines: [`unavailable: ${outcome.error?.message ?? outcome.note ?? 'session.list failed'}`],
      };
    }
    const lines = riskLines(outcome.result);
    if (lines.length === 0) return block;
    return { ...block, status: 'ok', lines };
  } catch (error) {
    return { ...block, status: 'unavailable', lines: [`unavailable: ${errorMessage(error)}`] };
  }
}

async function hypothesesBlock(
  hopPath: string,
  hopExists: boolean,
  callHop: typeof defaultCallHop,
  readDir: (p: string) => string[],
  readFile: (p: string) => string,
  exists: (p: string) => boolean,
): Promise<Block> {
  const block: Block = { key: 'hypotheses', heading: HYPOTHESES_HEADING, status: 'none', lines: [], removable: true };
  if (!hopExists) return block;

  let manifest: HopManifest;
  try {
    manifest = loadHop(hopPath);
  } catch (error) {
    return { ...block, status: 'unavailable', lines: [`unavailable: ${errorMessage(error)}`] };
  }

  let stateDir: string | undefined;
  try {
    stateDir = buildToolEnv(hopPath, 'scientific-process', manifest).SCIENTIFIC_PROCESS_STATE_DIR;
  } catch (error) {
    return { ...block, status: 'unavailable', lines: [`unavailable: ${errorMessage(error)}`] };
  }
  if (!stateDir) {
    return { ...block, status: 'unavailable', lines: ['unavailable: SCIENTIFIC_PROCESS_STATE_DIR is not set'] };
  }

  let entries: string[];
  try {
    entries = readDir(stateDir);
  } catch (error) {
    if (isMissing(error)) return block;
    return { ...block, status: 'unavailable', lines: [`unavailable: ${errorMessage(error)}`] };
  }
  const sessions = entries
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => basename(name, '.jsonl'))
    .sort();
  if (sessions.length === 0) return block;

  const found: Array<{ session: string; hypothesis: JsonObject }> = [];
  let firstError: unknown = null;
  let loaded = 0;
  for (const session of sessions) {
    try {
      const outcome = await callHop(hopPath, 'scientific-process', {
        tool: 'state.get',
        arguments: { session_id: session },
      });
      if (!outcome.ok || outcome.isError) {
        throw new Error(outcome.error?.message ?? outcome.note ?? `state.get failed for ${session}`);
      }
      loaded += 1;
      for (const hypothesis of openHypotheses(outcome.result)) found.push({ session, hypothesis });
    } catch (error) {
      if (firstError === null) firstError = error;
    }
  }

  if (loaded === 0 && firstError !== null) {
    return { ...block, status: 'unavailable', lines: [`unavailable: ${errorMessage(firstError)}`] };
  }
  const lines = hypothesisLines(found);
  if (lines.length === 0) return block;
  return { ...block, status: 'ok', lines };
}

function runsBlock(
  cwd: string,
  readDir: (p: string) => string[],
  readFile: (p: string) => string,
  exists: (p: string) => boolean,
  cutoffMs: number,
  completed: ReadonlySet<string>,
): Block {
  const block: Block = { key: 'runs', heading: RUNS_HEADING, status: 'none', lines: [], removable: true };
  try {
    const runs = runItems(cwd, readDir, readFile, exists, cutoffMs, completed);
    if (runs.length === 0) return block;
    return { ...block, status: 'ok', lines: runs.map((run) => `- ${run.id}: status: ${run.status}`) };
  } catch (error) {
    return { ...block, status: 'unavailable', lines: [`unavailable: ${errorMessage(error)}`] };
  }
}

function render(header: string[], blocks: Block[], dropped: Record<string, number>): string {
  const lines = [...header];
  for (const block of blocks) {
    const more = dropped[block.key] ?? 0;
    lines.push('', `### ${block.heading}${more > 0 ? ` (+${more} more)` : ''}`);
    if (block.lines.length > 0) lines.push(...block.lines);
    else if (block.status === 'none' && more === 0) lines.push('none');
  }
  return lines.join('\n');
}

function nextDroppable(blocks: Block[]): Block | null {
  const order: Block['key'][] = ['runs', 'hypotheses', 'risk'];
  for (const key of order) {
    const block = blocks.find((candidate) => candidate.key === key);
    if (block && block.removable && block.lines.length > 0) return block;
  }
  return null;
}

/**
 * Build the compact session-start context block from live local stores. All
 * companion access goes through the injected `callHop`; failures are reported
 * per section and never thrown. Over `maxChars`, in-flight runs (oldest first),
 * then hypotheses and risk detail are dropped while the plan is preserved.
 */
export async function buildCompactBlock(deps: CompactDeps): Promise<CompactBlock> {
  if (!isObject(deps)) throw new TypeError('deps must be an object');
  if (typeof deps.cwd !== 'string' || deps.cwd.trim().length === 0) {
    throw new TypeError('cwd must be a non-empty string');
  }
  if (deps.hopPath !== undefined && (typeof deps.hopPath !== 'string' || deps.hopPath.trim().length === 0)) {
    throw new TypeError('hopPath must be a non-empty string when provided');
  }
  const maxChars = deps.maxChars ?? DEFAULT_MAX_CHARS;
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new TypeError(`maxChars must be a positive integer, got ${String(maxChars)}`);
  }
  const maxAgeHours = deps.inFlightMaxAgeHours ?? DEFAULT_IN_FLIGHT_MAX_AGE_HOURS;
  if (typeof maxAgeHours !== 'number' || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    throw new TypeError(`inFlightMaxAgeHours must be a positive number, got ${String(maxAgeHours)}`);
  }
  const now = deps.now ?? (() => new Date());
  const readDir = deps.readDir ?? ((path: string) => readdirSync(path));
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const exists = deps.exists ?? ((path: string) => existsSync(path));
  const callHop = deps.callHop ?? defaultCallHop;
  const hopPath = deps.hopPath ?? join(deps.cwd, '.delivery', 'setup', 'hop.json');
  const hopExists = exists(hopPath);

  const generated = now();
  if (!(generated instanceof Date) || Number.isNaN(generated.getTime())) {
    throw new TypeError('now must return a valid Date');
  }
  const header = ['## Junior compact context', `- generated: ${generated.toISOString()}`];
  if (hopExists) {
    try {
      header.push(`- hop revision: ${inspectHop(hopPath).revision}`);
    } catch (error) {
      header.push(`- hop: unavailable: ${errorMessage(error)}`);
    }
  } else {
    header.push('- hop: none');
  }

  let completed = new Set<string>();
  try {
    completed = deps.completedDeliverables
      ? await deps.completedDeliverables()
      : await defaultCompletedDeliverables(hopPath, hopExists, callHop);
  } catch {
    completed = new Set();
  }

  const blocks = [
    await planBlock(hopPath, hopExists, callHop),
    await riskBlock(hopPath, hopExists, callHop),
    await hypothesesBlock(hopPath, hopExists, callHop, readDir, readFile, exists),
    runsBlock(deps.cwd, readDir, readFile, exists, generated.getTime() - maxAgeHours * 3_600_000, completed),
  ];

  const dropped: Record<string, number> = { plan: 0, risk: 0, hypotheses: 0, runs: 0 };
  let markdown = render(header, blocks, dropped);
  while (markdown.length > maxChars) {
    const block = nextDroppable(blocks);
    if (block === null) break;
    block.lines.pop();
    dropped[block.key] = (dropped[block.key] ?? 0) + 1;
    markdown = render(header, blocks, dropped);
  }

  const sections: Record<string, CompactSectionStatus> = {};
  for (const block of blocks) sections[block.key] = block.status;
  return { markdown, truncated: Object.values(dropped).some((count) => count > 0), sections };
}
