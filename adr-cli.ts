// ---------------------------------------------------------------------------
// `junior adr` command surface (issues #220, #221, #223).
//
// This module is deliberately a thin shell: it parses arguments, calls the ADR
// config, init, gate, ticket and ledger functions, and prints their results. It
// owns no gate or ledger logic of its own.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { adrDiscovery, adrDiscoveryMessage, lintAdrs, runAdr } from './adr.ts';
import {
  adrExcludePatterns,
  defaultGate,
  detectAdrDir,
  detectAdrFormat,
  detectFilePattern,
  excludeMatcher,
  proposeAdrConfig,
  readAdrConfig,
  writeAdrConfig,
  type AdrConfig,
} from './adr-config.ts';
import { initAdrs } from './adr-init.ts';
import {
  recordGateDecision,
  renderGateMarkdown,
  runAdrGate,
  type AdrGateFinding,
  type AdrGateResult,
  type GateDecisionInput,
  type GateProgress,
  type GateSubject,
} from './adr-gate.ts';
import {
  checkTicket,
  checkTickets,
  renderTicketReport,
  writeBack,
  type TicketCheckResult,
} from './adr-tickets.ts';
import { loadGateAdrs, resolveGateConfig } from './worker-adr-gate.ts';
import { createJevClassifier } from './worker-gates.ts';
import { analyze } from './matrix-analyze.ts';
import {
  draftFrontMatter,
  hasJuniorFrontMatter,
  loadAllAdrs,
  readScopeCache,
  scopeCacheKey,
  scopeCandidates,
  scopeRequest,
  writeProposal,
  writeScopeCache,
} from './adr-foreign.ts';
import type { Adr } from './adr.ts';
import { adrContentHash } from './adr-ledger.ts';
import {
  extractAcceptance,
  readTicketsConfig,
  type Ticket,
  type TicketAdapter,
  type TicketQuery,
  type TicketState,
  type TicketsConfig,
} from './tickets.ts';
import { createGithubAdapter } from './tickets-github.ts';
import { createJiraAdapter, type JiraFetch } from './tickets-jira.ts';
import type { GateClassifier } from './worker.ts';
import { readExternalContextConsent } from './auth.ts';
import { runSync } from './spawn-sync.ts';
import { boundedDiff, changedFileDiff, changedFileText } from './worker-adr-gate.ts';
import { buildWholeChangeSubject } from './adr-change.ts';
import { systemClock, type Clock } from './clock.ts';

export type AdrGit = (args: string[]) => {status: number; stdout: string};

export interface AdrCliDeps {
  cwd?: string;
  classify?: GateClassifier;
  git?: AdrGit;
  adapter?: TicketAdapter;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  now?: Date;
  /** Time source when `now` is not given (default: the system clock). */
  clock?: Clock;
  /** #291: minimum milliseconds between progress lines on stderr (default 10,000). */
  progressIntervalMs?: number;
}

export const ADR_CLI_USAGE = [
  'Usage: junior adr <command> [options]',
  '  init [--dir <dir>] [--record-decision] [--yes]',
  '  check --stage design --input <file> [--json]',
  '  check --stage implementation [--base <ref>] [--result <result.json>] [--whole-change]',
  '        [--no-exclude] [--no-prefilter] [--json]',
  '  check --stage ticket (--ticket <id> | --draft <file>) [--json]',
  '  decide <F#> (--override --reason <text> | --amend --adr <ADR-NNNN> | --revise)',
  '         [--standing --expires <date|until-adr-change>] [--by <name>]',
  '  check-tickets [--state open|all] [--limit N] [--markdown <file>] [--post]',
  '  scope [--adr <ADR-id>]... [--max-candidates <n>] [--samples <k>] [--fresh] [--json]',
  '  new|lint|sync delegate to `junior matrix adr`',
].join('\n');

function output(deps: AdrCliDeps): (s: string) => void {
  return deps.stdout ?? ((s) => process.stdout.write(s));
}

function errorOutput(deps: AdrCliDeps): (s: string) => void {
  return deps.stderr ?? ((s) => process.stderr.write(s));
}

function failure(out: (s: string) => void, message: string): number {
  out(`${message}\n`);
  return 1;
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function flagSet(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function currentNow(deps: AdrCliDeps): Date {
  return deps.now ?? (deps.clock ?? systemClock).date();
}

function readingDate(deps: AdrCliDeps): Date {
  return deps.now ?? (deps.clock ?? systemClock).date();
}

function latestPath(root: string): string {
  return join(root, '.delivery', 'adr-check', 'latest.json');
}

/** The Jev classifier for a check. A check sends ADR and design/ticket text to
 * the gateway, so it needs the same recorded external-context consent a
 * handoff needs; without it the command stops before any request. */
async function classifierFor(deps: AdrCliDeps, root: string): Promise<GateClassifier | {consentRequired: string}> {
  if (deps.classify) return deps.classify;
  const created = await createJevClassifier();
  const consent = readExternalContextConsent(root, created.gateway);
  if (!consent.granted) {
    return {consentRequired: `external-context consent required: an ADR check sends ADR and work text to ${created.gateway}; run junior auth consent grant ${created.gateway} --project ${root}${consent.reason ? ` (${consent.reason})` : ''}`};
  }
  return created.classify;
}

function changedPaths(fromPorcelain: string): string[] {
  const paths: string[] = [];
  for (const line of fromPorcelain.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let raw = line.length > 3 ? line.slice(3).trim() : line.trim();
    const arrow = raw.lastIndexOf(' -> ');
    if (arrow >= 0) raw = raw.slice(arrow + 4).trim();
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        raw = JSON.parse(raw);
      } catch {
        raw = raw.slice(1, -1);
      }
    }
    if (raw !== '' && !paths.includes(raw)) paths.push(raw);
  }
  return paths;
}

function resultChangedPaths(path: string): string[] {
  const parsed: any = JSON.parse(readFileSync(path, 'utf8'));
  const changed = parsed?.evidence?.runChangedFiles;
  if (!Array.isArray(changed)) return [];
  const paths: string[] = [];
  for (const entry of changed) {
    const candidate = entry?.path;
    if (typeof candidate === 'string' && candidate !== '' && !paths.includes(candidate)) paths.push(candidate);
  }
  return paths;
}

function resultWorktree(path: string): string | undefined {
  try {
    const parsed: any = JSON.parse(readFileSync(path, 'utf8'));
    const candidate = parsed?.isolation?.worktree ?? parsed?.executionCwd;
    return typeof candidate === 'string' && candidate !== '' ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function gitOutput(deps: AdrCliDeps, args: string[]): string {
  if (!deps.git) throw new Error('this command needs deps.git');
  const result = deps.git(args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed with status ${result.status}`);
  return result.stdout;
}

/**
 * #249: with no `--base`, diff against the remote's default branch (`origin/HEAD`), else
 * `origin/main`, else `origin/master`. A repository with none of them fails naming `--base`.
 */
export function defaultBase(deps: AdrCliDeps): string {
  const git = deps.git;
  if (!git) throw new Error('this command needs deps.git');
  const head = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const resolved = head.status === 0 ? head.stdout.trim().replace(/^refs\/remotes\//, '') : '';
  if (resolved !== '') return resolved;
  for (const candidate of ['origin/main', 'origin/master']) {
    if (git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]).status === 0) return candidate;
  }
  throw new Error('cannot find the default branch (no origin/HEAD, origin/main or origin/master); pass --base <ref>');
}

function implementationSubject(root: string, path: string, base: string): GateSubject {
  const diff = changedFileDiff(root, path, base);
  return diff === null
    ? {target: path, files: [path], text: changedFileText(root, path), kind: 'file'}
    : {target: path, files: [path], text: boundedDiff(diff), kind: 'diff'};
}

function implementationDiffBase(argv: string[], deps: AdrCliDeps): string {
  const base = valueAfter(argv, '--base') ?? defaultBase(deps);
  try {
    const merged = gitOutput(deps, ['merge-base', base, 'HEAD']).trim();
    if (merged !== '') return merged;
  } catch {
    // A missing merge base falls back to the requested ref.
  }
  return base;
}

/** #291: an excluded path is never judged, so it is listed without reading its diff. */
function subjectFor(root: string, path: string, base: string, isExcluded: (path: string) => boolean): GateSubject {
  return isExcluded(path) ? {target: path, files: [path]} : implementationSubject(root, path, base);
}

function implementationSubjects(argv: string[], deps: AdrCliDeps, isExcluded: (path: string) => boolean): GateSubject[] {
  const root = deps.cwd ?? process.cwd();
  const result = valueAfter(argv, '--result');
  if (result) {
    const worktree = resultWorktree(result);
    const contentRoot = worktree !== undefined && existsSync(worktree) ? worktree : root;
    return resultChangedPaths(result).map((path) => subjectFor(contentRoot, path, 'HEAD', isExcluded));
  }

  const paths: string[] = [];
  const add = (path: string) => {
    if (path !== '' && !paths.includes(path)) paths.push(path);
  };

  const base = valueAfter(argv, '--base') ?? defaultBase(deps);
  for (const path of gitOutput(deps, ['diff', '--name-only', `${base}...HEAD`])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)) {
    add(path);
  }
  for (const path of changedPaths(gitOutput(deps, ['status', '--porcelain=v1']))) add(path);

  const diffBase = implementationDiffBase(argv, deps);
  return paths.map((path) => subjectFor(root, path, diffBase, isExcluded));
}

function wholeChangeSubject(argv: string[], deps: AdrCliDeps, isExcluded: (path: string) => boolean): GateSubject {
  const root = deps.cwd ?? process.cwd();
  const result = valueAfter(argv, '--result');
  const git = {...(deps.git !== undefined ? {git: deps.git} : {}), exclude: isExcluded};
  if (result) {
    const worktree = resultWorktree(result);
    const contentRoot = worktree !== undefined && existsSync(worktree) ? worktree : root;
    return buildWholeChangeSubject({root: contentRoot, base: 'HEAD', ...git});
  }
  return buildWholeChangeSubject({root, base: implementationDiffBase(argv, deps), ...git});
}

function printFindings(markdown: string, ids: readonly string[]): string {
  let index = 0;
  return markdown
    .split('\n')
    .map((line) => {
      if (!line.startsWith('|') || line.startsWith('| ---') || line.startsWith('| ADR/rule')) return line;
      const id = ids[index];
      index += 1;
      return id === undefined ? line : `| ${id} ${line.slice(2)}`;
    })
    .join('\n');
}

function ticketFromDraft(path: string, now: Date): Ticket {
  const body = readFileSync(path, 'utf8');
  const lines = body.split(/\r?\n/);
  return {
    id: 'draft',
    url: '',
    title: lines[0] ?? '',
    body: lines.slice(1).join('\n'),
    labels: [],
    acceptance: extractAcceptance(body),
    updatedAt: now.toISOString(),
  };
}

function jiraFetch(): JiraFetch {
  return async (url, init) => {
    const response = await (globalThis as any).fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? {body: init.body} : {}),
    });
    return {
      status: response.status,
      ok: response.ok,
      json: () => response.json(),
      text: () => response.text(),
    };
  };
}

function ticketConfig(root: string, deps: AdrCliDeps, soft: boolean): TicketsConfig | null {
  try {
    const run = deps.git
      ? (command: string, args: string[]) => {
          const result = deps.git!(args);
          return {status: result.status, stdout: result.stdout};
        }
      : undefined;
    return readTicketsConfig(root, run ? {run} : {});
  } catch (error) {
    if (soft) return null;
    throw error;
  }
}

function adapterFor(config: TicketsConfig, root: string): TicketAdapter {
  if (config.provider === 'jira') {
    if (!config.baseUrl || !config.project) {
      throw new Error('tickets.baseUrl and tickets.project are required for the Jira adapter');
    }
    return createJiraAdapter({baseUrl: config.baseUrl, project: config.project}, {fetch: jiraFetch()});
  }
  if (!config.repo) throw new Error('tickets.repo is required for the GitHub adapter');
  return createGithubAdapter(config.repo, {cwd: root});
}

function preflight(root: string, deps: AdrCliDeps): {config: AdrConfig; adrs: ReturnType<typeof loadGateAdrs>} | null {
  const resolved = resolveGateConfig(root);
  if (!resolved) return null;
  return {config: resolved.config, adrs: loadGateAdrs(root, resolved.config)};
}

type CheckStage = 'design' | 'implementation' | 'ticket';
type GateReady = NonNullable<ReturnType<typeof preflight>>;

function reportDiscovery(
  argv: string[],
  deps: AdrCliDeps,
  stage: CheckStage,
  discovery: ReturnType<typeof adrDiscovery>,
  config: AdrConfig,
): number | undefined {
  if (!discovery) return undefined;
  errorOutput(deps)(`${adrDiscoveryMessage(discovery, config)}\n`);
  if (flagSet(argv, '--json')) {
    output(deps)(`${JSON.stringify({stage, at: readingDate(deps).toISOString(), discovery}, null, 2)}\n`);
  }
  return 2;
}

function reportGateOff(argv: string[], deps: AdrCliDeps, root: string, stage: CheckStage): number {
  const config = readAdrConfig(root) ?? proposeAdrConfig(root);
  if (config) {
    const discovery = adrDiscovery(join(root, config.dir), loadGateAdrs(root, config).length, config);
    const code = reportDiscovery(argv, deps, stage, discovery, config);
    if (code !== undefined) return code;
  }
  output(deps)('ADR gate off\n');
  return 0;
}

async function checkTicketStage(
  argv: string[],
  deps: AdrCliDeps,
  root: string,
  ready: GateReady,
  classify: GateClassifier,
): Promise<{gate: AdrGateResult; markdown: string} | number> {
  const out = output(deps);
  const ticketId = valueAfter(argv, '--ticket');
  const draft = valueAfter(argv, '--draft');
  if (!ticketId && !draft) return failure(out, 'check --stage ticket needs --ticket <id> or --draft <file>');

  let ticket: Ticket;
  if (draft) {
    ticket = ticketFromDraft(draft, currentNow(deps));
  } else {
    let adapter = deps.adapter;
    if (!adapter) {
      const config = ticketConfig(root, deps, false);
      if (!config) return failure(out, 'tickets config is required for --ticket');
      adapter = adapterFor(config, root);
    }
    ticket = await adapter.get(ticketId!);
  }
  const result = await checkTicket({
    root,
    ticket,
    config: ready.config,
    adrs: ready.adrs,
    classify,
  });
  return {gate: result.gate, markdown: renderTicketReport([result])};
}

async function checkGateStage(
  argv: string[],
  deps: AdrCliDeps,
  root: string,
  stage: 'design' | 'implementation',
  ready: GateReady,
  classify: GateClassifier,
): Promise<{gate: AdrGateResult; markdown: string} | number> {
  let subjects: GateSubject[];
  const exclude = flagSet(argv, '--no-exclude') ? [] : adrExcludePatterns(ready.config);
  const isExcluded = excludeMatcher(exclude);
  if (stage === 'design') {
    const input = valueAfter(argv, '--input');
    if (!input) return failure(output(deps), 'check --stage design needs --input <file>');
    subjects = [{target: input, text: readFileSync(input, 'utf8')}];
  } else {
    subjects = flagSet(argv, '--whole-change')
      ? [wholeChangeSubject(argv, deps, isExcluded)]
      : implementationSubjects(argv, deps, isExcluded);
  }

  const gate = await runAdrGate({
    root,
    stage,
    subjects,
    config: ready.config,
    adrs: ready.adrs,
    classify,
    exclude,
    ...(flagSet(argv, '--no-prefilter') ? {prefilter: false} : {}),
    progress: progressReporter(deps),
    ...(deps.clock ? {clock: deps.clock} : {}),
  });
  return {gate, markdown: renderGateMarkdown(gate)};
}

/** #291: a plan of at least this many cells prints its size before judging starts. */
const PLAN_LINE_MIN_CELLS = 100;
/** #291: a plan of at least this many cells also says how to narrow the check. */
export const LARGE_CHECK_CELLS = 2000;
const DEFAULT_PROGRESS_INTERVAL_MS = 10_000;

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * #291: progress for a long check, on stderr only so stdout and --json stay
 * machine-readable. The plan line names the size (and, for a large change, how
 * to narrow it); judging prints at most one line per interval with an ETA.
 */
function progressReporter(deps: AdrCliDeps): (event: GateProgress) => void {
  const err = errorOutput(deps);
  const clock = deps.clock ?? systemClock;
  const interval = deps.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  let started = 0;
  let last = 0;
  return (event) => {
    if (event.phase === 'plan') {
      started = clock.now();
      last = started;
      const skipped = [
        ...(event.excluded > 0 ? [`${plural(event.excluded, 'generated/vendored file')} skipped`] : []),
        ...(event.prefiltered > 0 ? [`${plural(event.prefiltered, 'unrelated ADR/file pair')} pre-filtered`] : []),
      ];
      if (event.cells >= PLAN_LINE_MIN_CELLS || skipped.length > 0) {
        err(`ADR check: judging ${plural(event.cells, 'cell')} (${plural(event.adrs, 'ADR')} x ${plural(event.subjects, 'subject')})${skipped.length > 0 ? `; ${skipped.join(', ')}` : ''}\n`);
      }
      if (event.cells >= LARGE_CHECK_CELLS) {
        err(`ADR check: this is a large change set; narrow it with \`junior adr scope --adr <ADR-id>\` (tighter applies_to), a closer --base, or --whole-change\n`);
      }
      return;
    }
    const now = clock.now();
    if (event.cellsDone < event.cells && now - last < interval) return;
    if (event.cellsDone >= event.cells && last === started && now - started < interval) return;
    last = now;
    const elapsed = now - started;
    const percent = event.cells === 0 ? 100 : Math.floor((event.cellsDone / event.cells) * 100);
    const eta = event.cellsDone > 0 && event.cellsDone < event.cells
      ? `, ~${duration((elapsed / event.cellsDone) * (event.cells - event.cellsDone))} left`
      : event.cellsDone >= event.cells ? `, done in ${duration(elapsed)}` : '';
    err(`ADR ${event.adrIndex}/${event.adrs} (${event.adrId}), cells ${event.cellsDone}/${event.cells} (${percent}%)${eta}\n`);
  };
}

/**
 * #291: the fields an unscored finding keeps in a compact latest.json: enough
 * for `decide F<n>` and a rule-level decide to find and record it, without the
 * rule text and ledger lookups repeated on every row.
 */
function slimFinding(finding: {id: string} & AdrGateFinding): Record<string, unknown> {
  return {
    id: finding.id,
    adrId: finding.adrId,
    ruleId: finding.ruleId,
    target: finding.target,
    verdict: finding.verdict,
    probability: finding.probability,
    confidence: finding.confidence,
    adrHash: finding.adrHash,
    stage: finding.stage,
    ...(finding.deliverable !== undefined ? {deliverable: finding.deliverable} : {}),
    cleared: finding.cleared,
  };
}

/**
 * #291: an inconclusive, mostly-uncertain run keeps every finding in
 * latest.json under its original id, but slims the unscored (null-probability)
 * ones, so a large run does not write tens of megabytes of repeated rule text.
 */
function compactDocument(
  document: {stage: CheckStage; at: string; gate: AdrGateResult; findings: ({id: string} & AdrGateFinding)[]},
): Record<string, unknown> | null {
  if (!document.gate.discrimination?.noDiscrimination) return null;
  const scored = document.findings.filter((finding) => finding.probability !== null);
  const unscored = document.findings.length - scored.length;
  if (unscored === 0) return null;
  const byAdr: Record<string, number> = {};
  for (const finding of document.findings) {
    if (finding.probability === null) byAdr[finding.adrId] = (byAdr[finding.adrId] ?? 0) + 1;
  }
  const {findings: _omitted, ...gate} = document.gate;
  return {
    stage: document.stage,
    at: document.at,
    compact: true,
    summary: {
      checked: document.gate.checked,
      findings: document.findings.length,
      scored: scored.length,
      unscored,
      unscoredByAdr: byAdr,
    },
    gate,
    findings: document.findings.map((finding) => (finding.probability === null ? slimFinding(finding) : finding)),
  };
}

function reportCheck(
  argv: string[],
  deps: AdrCliDeps,
  root: string,
  stage: CheckStage,
  {gate, markdown}: {gate: AdrGateResult; markdown: string},
): number {
  const out = output(deps);
  const findings = gate.findings.map((finding, index) => ({id: `F${index + 1}`, ...finding}));
  const document = {
    stage,
    at: readingDate(deps).toISOString(),
    gate,
    findings,
  };

  mkdirSync(dirname(latestPath(root)), {recursive: true});
  const compact = compactDocument(document);
  writeFileSync(latestPath(root), `${JSON.stringify(compact ?? document, null, 2)}\n`);

  if (flagSet(argv, '--json')) {
    out(`${JSON.stringify(document, null, 2)}\n`);
  } else if (stage === 'ticket') {
    out(`${markdown}\n`);
  } else {
    out(`${printFindings(markdown, findings.map((finding) => finding.id))}\n`);
  }

  if (compact) {
    const summary = compact.summary as {scored: number; unscored: number};
    errorOutput(deps)(`${latestPath(root)}: kept ${plural(summary.scored, 'scored finding')}; ${plural(summary.unscored, 'unscored uncertain finding')} slimmed\n`);
  }
  if (gate.inconclusive && gate.inconclusiveReason) errorOutput(deps)(`${gate.inconclusiveReason}\n`);
  return gate.blocked ? 3 : gate.inconclusive ? 2 : 0;
}

async function runCheck(argv: string[], deps: AdrCliDeps): Promise<number> {
  const root = deps.cwd ?? process.cwd();
  const out = output(deps);
  const stage = valueAfter(argv, '--stage');
  if (stage !== 'design' && stage !== 'implementation' && stage !== 'ticket') {
    return failure(out, 'check needs --stage design|implementation|ticket');
  }

  const ready = preflight(root, deps);
  if (!ready) return reportGateOff(argv, deps, root, stage);

  const discovery = adrDiscovery(join(root, ready.config.dir), ready.adrs.length, ready.config);
  const discoveryCode = reportDiscovery(argv, deps, stage, discovery, ready.config);
  if (discoveryCode !== undefined) return discoveryCode;

  const classifier = await classifierFor(deps, root);
  if ('consentRequired' in classifier) return failure(out, classifier.consentRequired);
  const classify = classifier;

  const checked = stage === 'ticket'
    ? await checkTicketStage(argv, deps, root, ready, classify)
    : await checkGateStage(argv, deps, root, stage, ready, classify);
  if (typeof checked === 'number') return checked;
  return reportCheck(argv, deps, root, stage, checked);
}

async function runDecide(argv: string[], deps: AdrCliDeps): Promise<number> {
  const root = deps.cwd ?? process.cwd();
  const out = output(deps);
  const id = argv.find((arg) => !arg.startsWith('--') && !argv[argv.indexOf(arg) - 1]?.startsWith('--'));
  if (!id) return failure(out, 'decide needs a finding id such as F1');

  const override = flagSet(argv, '--override');
  const amend = flagSet(argv, '--amend');
  const revise = flagSet(argv, '--revise');
  const chosen = [override, amend, revise].filter(Boolean).length;
  if (chosen !== 1) return failure(out, 'decide needs exactly one of --override, --amend or --revise');

  const reason = valueAfter(argv, '--reason');
  if (override && reason === undefined) return failure(out, 'an override needs --reason');

  const amendmentAdr = valueAfter(argv, '--adr');
  if (amend && !amendmentAdr) return failure(out, 'an amendment needs --adr <ADR-NNNN>');

  let document: any;
  try {
    document = JSON.parse(readFileSync(latestPath(root), 'utf8'));
  } catch {
    return failure(out, `no ADR check found at ${latestPath(root)}`);
  }

  const finding = (document.findings ?? []).find((entry: any) => entry?.id === id) as AdrGateFinding | undefined;
  if (!finding) return failure(out, `unknown finding ${id}`);

  let by = 'unknown';
  if (deps.git) {
    const result = deps.git(['config', 'user.name']);
    const name = result.stdout.trim();
    if (result.status === 0 && name !== '') by = name;
  }
  by = valueAfter(argv, '--by') ?? by;

  const expires = valueAfter(argv, '--expires');
  const input: GateDecisionInput = {
    by,
    decision: override ? 'override' : amend ? 'amend' : 'revise',
    rationale: reason ?? '',
    stage: finding.stage,
    ...(finding.deliverable !== undefined ? {deliverable: finding.deliverable} : {}),
    ...(amendmentAdr !== undefined ? {amendmentAdr} : {}),
    ...(flagSet(argv, '--standing') ? {standing: true} : {}),
    ...(expires !== undefined ? {expires} : {}),
  };
  const decision = recordGateDecision(root, finding, input);
  out(`${decision.id}\n`);
  return 0;
}

function plannedInitFiles(root: string, dir: string, withRecordDecision: boolean): string[] {
  const absolute = join(root, dir);
  const files: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(absolute);
  } catch {
    names = [];
  }
  if (withRecordDecision && !names.some((name) => /^\d{4}-record-architecture-decisions\.md$/.test(name))) {
    let next = 1;
    for (const name of names) {
      const match = /^(\d{4})-.+\.md$/.exec(name);
      if (match) next = Math.max(next, Number(match[1]) + 1);
    }
    files.push(`${dir}/${String(next).padStart(4, '0')}-record-architecture-decisions.md`);
  }
  if (!names.includes('README.md')) files.push(`${dir}/README.md`);
  return files;
}

function previewConfig(root: string, dir: string): AdrConfig {
  const absolute = join(root, dir);
  const filePattern = detectFilePattern(absolute);
  const patternConfig = filePattern === undefined ? undefined : {filePattern};
  return {
    dir,
    format: detectAdrFormat(absolute, patternConfig),
    gate: defaultGate(absolute, patternConfig),
    ...(filePattern === undefined ? {} : {filePattern}),
  };
}

function printConfig(out: (s: string) => void, config: AdrConfig): void {
  out(`Proposed config:\n${JSON.stringify(config, null, 2)}\n`);
}

async function runInit(argv: string[], deps: AdrCliDeps): Promise<number> {
  const root = deps.cwd ?? process.cwd();
  const out = output(deps);
  const yes = flagSet(argv, '--yes');
  const withRecordDecision = flagSet(argv, '--record-decision');
  const dirOption = valueAfter(argv, '--dir');

  const existing = detectAdrDir(root);
  if (existing) {
    const proposed = proposeAdrConfig(root);
    if (!proposed) return failure(out, 'no ADR directory found');
    if (yes) writeAdrConfig(root, proposed);
    printConfig(out, proposed);
    return 0;
  }

  const dir = dirOption ?? 'docs/adr';
  if (!yes) {
    const planned = plannedInitFiles(root, dir, withRecordDecision);
    out(`ADR directory: ${dir}\n`);
    out(planned.length === 0 ? 'Would create: nothing\n' : `Would create:\n${planned.map((file) => `  ${file}`).join('\n')}\n`);
    printConfig(out, previewConfig(root, dir));
    return 0;
  }

  const result = initAdrs(root, {
    dir,
    ...(withRecordDecision ? {withRecordDecision: true} : {}),
  });
  writeAdrConfig(root, result.config);
  out(`Created:\n${result.created.length === 0 ? '  nothing\n' : result.created.map((file) => `  ${file}`).join('\n') + '\n'}`);
  printConfig(out, result.config);
  return 0;
}

async function runCheckTickets(argv: string[], deps: AdrCliDeps): Promise<number> {
  const root = deps.cwd ?? process.cwd();
  const out = output(deps);
  const state = valueAfter(argv, '--state');
  if (state !== undefined && state !== 'open' && state !== 'all') {
    return failure(out, 'check-tickets --state must be open or all');
  }
  const limitRaw = valueAfter(argv, '--limit');
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    return failure(out, 'check-tickets --limit must be a non-negative integer');
  }

  const ready = preflight(root, deps);
  if (!ready) {
    out('ADR gate off\n');
    return 0;
  }

  let adapter = deps.adapter;
  if (!adapter) {
    const config = ticketConfig(root, deps, false);
    if (!config) return failure(out, 'tickets config is required for check-tickets');
    adapter = adapterFor(config, root);
  }

  const classifier = await classifierFor(deps, root);
  if ('consentRequired' in classifier) return failure(out, classifier.consentRequired);
  const classify = classifier;
  const query: TicketQuery = {
    ...(state !== undefined ? {state: state as TicketState} : {}),
    ...(limit !== undefined ? {limit} : {}),
  };
  const results = await checkTickets({
    root,
    adapter,
    config: ready.config,
    adrs: ready.adrs,
    classify,
    query,
  });

  const report = renderTicketReport(results);
  out(`${report}\n`);

  const markdown = valueAfter(argv, '--markdown');
  if (markdown !== undefined) {
    mkdirSync(dirname(markdown), {recursive: true});
    writeFileSync(markdown, `${report}\n`);
  }

  const configured = ticketConfig(root, deps, true);
  const post = flagSet(argv, '--post') || configured?.writeBack === true;
  if (post) {
    for (const result of results) {
      await writeBack(adapter, result, {enabled: true});
    }
  }

  return results.some((result: TicketCheckResult) => result.gate.blocked) ? 3 : 0;
}

function adrFlags(argv: string[]): string[] {
  const ids: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--adr' && argv[index + 1] !== undefined) {
      ids.push(argv[index + 1]!);
      index += 1;
    }
  }
  return ids;
}

function isForeignRecord(adr: Adr): boolean {
  if (!adr.path) return false;
  try {
    return !hasJuniorFrontMatter(readFileSync(adr.path, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * ADR 0018 R9: draft `applies_to` and `rules` front matter for every accepted
 * foreign ADR and write it only under `.delivery/adr-proposals/`. The original
 * ADR is never edited or committed.
 */
async function runScope(argv: string[], deps: AdrCliDeps): Promise<number> {
  const root = deps.cwd ?? process.cwd();
  const out = output(deps);
  const config = readAdrConfig(root) ?? proposeAdrConfig(root);
  if (!config) return failure(out, 'no ADR directory found; run junior adr init');

  const options = parseScopeOptions(argv, out);
  if (typeof options === 'number') return options;
  const {requested, maxCandidates, samples, fresh} = options;
  const candidatesForRepo = scopeCandidates(root, maxCandidates === undefined ? undefined : {maxCandidates});
  const adrs = loadGateAdrs(root, config)
    .filter((adr) => adr.status === 'accepted')
    .filter((adr) => requested.length === 0 || requested.includes(adr.id))
    .filter(isForeignRecord);

  const classifier = await scopeClassifier(root, deps, out);
  if (typeof classifier === 'number') return classifier;

  const run: ScopeRun = {
    root,
    samples,
    fresh,
    model: classifier.model,
    classify: classifier.classify,
    candidatesForRepo,
    cache: readScopeCache(root),
    judged: 0,
    cached: 0,
    proposals: [],
    skipped: [],
  };

  for (const adr of adrs) await scopeAdr(run, adr);

  if (run.judged > 0) writeScopeCache(root, run.cache);
  printScope(argv, out, run);
  return 0;
}

type UncertainPath = {path: string; votes: number; samples: number};

interface ScopeProposal {
  adrId: string;
  path: string;
  appliesTo: string[];
  rules: Array<{id: string; text: string}>;
  uncertain: UncertainPath[];
  votes: Record<string, number>;
}

interface ScopeRun {
  root: string;
  samples: number;
  fresh: boolean;
  model: string;
  classify: GateClassifier;
  candidatesForRepo: string[];
  cache: ReturnType<typeof readScopeCache>;
  judged: number;
  cached: number;
  proposals: ScopeProposal[];
  skipped: Array<{adrId: string; reason: string; uncertain?: UncertainPath[]}>;
}

interface ScopeOptions {
  requested: string[];
  maxCandidates: number | undefined;
  samples: number;
  fresh: boolean;
}

function parseScopeOptions(argv: string[], out: (s: string) => void): ScopeOptions | number {
  const requested = adrFlags(argv);
  const maxCandidatesRaw = valueAfter(argv, '--max-candidates');
  const maxCandidates = maxCandidatesRaw === undefined ? undefined : Number(maxCandidatesRaw);
  if (maxCandidates !== undefined && (!Number.isInteger(maxCandidates) || maxCandidates < 1)) {
    return failure(out, '--max-candidates must be a positive integer');
  }
  const samplesFlag = argv.includes('--samples');
  const samplesRaw = valueAfter(argv, '--samples');
  const samples = samplesFlag && samplesRaw === undefined ? Number.NaN : samplesRaw === undefined ? 3 : Number(samplesRaw);
  if (!Number.isInteger(samples) || samples < 1 || samples > 7 || samples % 2 === 0) {
    return failure(out, '--samples must be an odd number from 1 to 7');
  }
  const fresh = flagSet(argv, '--fresh');
  return {requested, maxCandidates, samples, fresh};
}

async function scopeClassifier(
  root: string,
  deps: AdrCliDeps,
  out: (s: string) => void,
): Promise<{classify: GateClassifier; model: string} | number> {
  if (deps.classify) return {classify: deps.classify, model: 'injected'};
  const created = await createJevClassifier();
  const consent = readExternalContextConsent(root, created.gateway);
  if (!consent.granted) {
    return failure(out, `external-context consent required: an ADR check sends ADR and work text to ${created.gateway}; run junior auth consent grant ${created.gateway} --project ${root}${consent.reason ? ` (${consent.reason})` : ''}`);
  }
  return {classify: created.classify, model: created.model};
}

function candidateOf(questionId: string): string {
  return questionId.startsWith('cell:') && questionId.endsWith(':governs')
    ? questionId.slice('cell:'.length, -':governs'.length)
    : '';
}

function scopeCacheEntry(answer: unknown): Record<string, unknown> {
  const record = answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
  const choice = typeof record.choice === 'string' ? record.choice : null;
  const confidence =
    typeof record.confidence === 'number' && Number.isFinite(record.confidence) ? record.confidence : null;
  if (choice === null) return {};
  return {type: 'choice', choice, ...(confidence === null ? {} : {confidence})};
}

function depthOf(candidate: string): number {
  return candidate.replace(/\/\*\*$/, '').split('/').length;
}

function replayClassifier(run: ScopeRun, adrHash: string, sample: number): GateClassifier {
  const {cache, model} = run;
  return async ({state, questions}, options) => {
    const answers: Record<string, unknown> = {};
    const missing: Record<string, typeof questions[string]> = {};
    for (const [id, question] of Object.entries(questions)) {
      const candidate = candidateOf(id);
      const key = scopeCacheKey({adrHash, candidate, sample, model});
      if (!run.fresh && Object.prototype.hasOwnProperty.call(cache, key)) {
        answers[id] = cache[key];
        run.cached += 1;
      } else {
        missing[id] = question;
      }
    }
    if (Object.keys(missing).length > 0) {
      const result = await run.classify({state, questions: missing}, options);
      for (const id of Object.keys(missing)) {
        const candidate = candidateOf(id);
        const key = scopeCacheKey({adrHash, candidate, sample, model});
        const entry = scopeCacheEntry(result.answers?.[id]);
        cache[key] = entry;
        answers[id] = entry;
        run.judged += 1;
      }
    }
    return {answers};
  };
}

async function voteScope(
  run: ScopeRun,
  adr: Adr,
): Promise<{counts: Map<string, number>; majority: Set<string>; anyKnown: boolean}> {
  const {candidatesForRepo, samples} = run;
  const adrHash = adrContentHash(readFileSync(adr.path, 'utf8'));
  const counts = new Map<string, number>(candidatesForRepo.map((candidate) => [candidate, 0]));
  const levels = new Map<number, string[]>();
  for (const candidate of candidatesForRepo) {
    const depth = depthOf(candidate);
    levels.set(depth, [...(levels.get(depth) ?? []), candidate]);
  }
  const majority = new Set<string>();
  let anyKnown = false;

  for (const depth of [...levels.keys()].sort((a, b) => a - b)) {
    const eligible = (levels.get(depth) ?? []).filter(
      (candidate) =>
        ![...majority].some((kept) => candidate.startsWith(`${kept.replace(/\/\*\*$/, '')}/`)),
    );
    if (eligible.length === 0) continue;

    for (let sample = 0; sample < samples; sample += 1) {
      const replay = replayClassifier(run, adrHash, sample);
      const result = await analyze({input: scopeRequest(adr, eligible), classify: replay});
      for (const cell of result.cells.filter((entry) => entry.criterionId === 'governs')) {
        if (!cell.known) continue;
        anyKnown = true;
        if (cell.optionId === 'yes') counts.set(cell.itemId, (counts.get(cell.itemId) ?? 0) + 1);
      }
    }

    for (const candidate of eligible) {
      if ((counts.get(candidate) ?? 0) > samples / 2) majority.add(candidate);
    }
  }
  return {counts, majority, anyKnown};
}

async function scopeAdr(run: ScopeRun, adr: Adr): Promise<void> {
  const {candidatesForRepo, samples, skipped} = run;
  if (candidatesForRepo.length === 0) {
    skipped.push({adrId: adr.id, reason: 'no candidate path judged governed'});
    return;
  }
  const {counts, majority, anyKnown} = await voteScope(run, adr);

  const voted = candidatesForRepo.filter((candidate) => (counts.get(candidate) ?? 0) > 0);
  const majorityPaths = candidatesForRepo.filter((candidate) => majority.has(candidate));
  const uncertain: UncertainPath[] = voted
    .filter((candidate) => !majority.has(candidate))
    .map((candidate) => ({path: candidate, votes: counts.get(candidate) ?? 0, samples}));
  const votes = Object.fromEntries(voted.map((candidate) => [candidate, counts.get(candidate) ?? 0]));

  if (majorityPaths.length === 0) {
    if (uncertain.length > 0) {
      skipped.push({adrId: adr.id, reason: `only uncertain paths (${uncertain.length})`, uncertain});
    } else if (!anyKnown) {
      skipped.push({adrId: adr.id, reason: 'Jev answers were unknown'});
    } else {
      skipped.push({adrId: adr.id, reason: 'no candidate path judged governed'});
    }
    return;
  }

  const appliesTo: string[] = [];
  for (const candidate of majorityPaths) {
    if (appliesTo.some((kept) => candidate.startsWith(`${kept.replace(/\/\*\*$/, '')}/`))) continue;
    appliesTo.push(candidate);
  }
  const ruleD = adr.rules.find((rule) => rule.id === 'D');
  const rules = ruleD ? [{id: 'D', text: ruleD.text}] : [];
  const draft = draftFrontMatter(adr, {appliesTo, rules, uncertain});
  writeProposal(run.root, draft);
  run.proposals.push({adrId: adr.id, path: draft.path, appliesTo, rules, uncertain, votes});
}

function printScope(argv: string[], out: (s: string) => void, run: ScopeRun): void {
  const {proposals, skipped, judged, cached} = run;
  if (flagSet(argv, '--json')) {
    out(`${JSON.stringify({proposals, skipped, judged, cached}, null, 2)}\n`);
  } else {
    for (const proposal of proposals) {
      const marginal = proposal.uncertain.length > 0 ? `, uncertain: ${proposal.uncertain.length}` : '';
      out(`${proposal.adrId} -> ${proposal.path} (applies_to: ${proposal.appliesTo.length} paths, rules: ${proposal.rules.length}${marginal})\n`);
    }
    for (const entry of skipped) out(`${entry.adrId} skipped: ${entry.reason}\n`);
    out(`judged: ${judged}, cached: ${cached}\n`);
  }
}

function subcommandUsage(command: string | undefined): string {
  const lines = ADR_CLI_USAGE.split('\n');
  const own: string[] = [];
  let matched = false;
  for (const line of lines.slice(1)) {
    const continuation = /^ {4,}/.test(line);
    if (!continuation) matched = command !== undefined && line.trim().split(/\s/)[0]!.split('|').includes(command);
    if (matched) own.push(line);
  }
  return own.length > 0 ? [lines[0], ...own].join('\n') : ADR_CLI_USAGE;
}

function runLint(rest: string[], deps: AdrCliDeps): number {
  const out = output(deps);
  const root = deps.cwd ?? process.cwd();
  const configured = readAdrConfig(root) ?? proposeAdrConfig(root);
  const detection = configured ? null : detectAdrDir(root);
  let label = configured?.dir ?? detection?.dir ?? 'docs/adr';
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--dir') label = rest[++i] ?? label;
    else if (arg.startsWith('--dir=')) label = arg.slice('--dir='.length);
  }
  const dir = isAbsolute(label) ? label : join(root, label);
  const config = configured?.filePattern === undefined ? undefined : {filePattern: configured.filePattern};
  try {
    const adrs = loadAllAdrs(dir, config);
    const foreignPaths = new Set(adrs.filter(isForeignRecord).map((adr) => adr.path));
    const findings = lintAdrs(adrs, {foreignPaths});
    const discovery = adrDiscovery(dir, adrs.length, {...config, dir: label});
    if (discovery) errorOutput(deps)(`${adrDiscoveryMessage(discovery, config)}\n`);
    out(`${JSON.stringify(discovery ? {findings, discovery} : {findings}, null, 2)}\n`);
    return findings.some((entry) => entry.severity === 'error') ? 1 : 0;
  } catch (err) {
    return failure(errorOutput(deps), err instanceof Error ? err.message : String(err));
  }
}

/** ADR 0018 R1-R5: the `junior adr` command parser and dispatcher. */
/** Real git through runSync (argv, no shell), in the project directory. */
function defaultGit(cwd: string): NonNullable<AdrCliDeps['git']> {
  return (args) => {
    const result = runSync('git', args, {cwd, encoding: 'utf8'} as any);
    return {status: typeof result.status === 'number' ? result.status : 1, stdout: String(result.stdout ?? '')};
  };
}

export async function runAdrCli(argv: string[], deps: AdrCliDeps = {}): Promise<number> {
  // The CLI entry passes no deps; tests inject them. Give production a real git.
  if (!deps.git) deps = {...deps, git: defaultGit(deps.cwd ?? process.cwd())};
  const command = argv[0];
  const rest = argv.slice(1);
  const out = output(deps);

  // #252: `--help`/`-h` on any subcommand prints usage and never runs it (`adr new --help`
  // used to write an ADR titled "--help").
  if (rest.includes('--help') || rest.includes('-h')) {
    out(`${subcommandUsage(command)}\n`);
    return 0;
  }

  if (command === 'lint') return runLint(rest, deps);
  if (command === 'new' || command === 'sync') {
    return runAdr([command, ...rest]);
  }
  if (command === 'init') return runInit(rest, deps);
  if (command === 'check') return runCheck(rest, deps);
  if (command === 'decide') return runDecide(rest, deps);
  if (command === 'check-tickets') return runCheckTickets(rest, deps);
  if (command === 'scope') return runScope(rest, deps);

  out(`${ADR_CLI_USAGE}\n`);
  return 1;
}
