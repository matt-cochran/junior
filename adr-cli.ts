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
  defaultGate,
  detectAdrDir,
  detectAdrFormat,
  detectFilePattern,
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
  scopeCandidates,
  scopeRequest,
  writeProposal,
} from './adr-foreign.ts';
import type { Adr } from './adr.ts';
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

export type AdrGit = (args: string[]) => {status: number; stdout: string};

export interface AdrCliDeps {
  cwd?: string;
  classify?: GateClassifier;
  git?: AdrGit;
  adapter?: TicketAdapter;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  now?: Date;
}

export const ADR_CLI_USAGE = [
  'Usage: junior adr <command> [options]',
  '  init [--dir <dir>] [--record-decision] [--yes]',
  '  check --stage design --input <file> [--json]',
  '  check --stage implementation [--base <ref>] [--result <result.json>] [--json]',
  '  check --stage ticket (--ticket <id> | --draft <file>) [--json]',
  '  decide <F#> (--override --reason <text> | --amend --adr <ADR-NNNN> | --revise)',
  '         [--standing --expires <date|until-adr-change>] [--by <name>]',
  '  check-tickets [--state open|all] [--limit N] [--markdown <file>] [--post]',
  '  scope [--adr <ADR-id>]... [--max-candidates <n>] [--samples <k>] [--json]',
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
  return deps.now ?? new Date();
}

function readingDate(deps: AdrCliDeps): Date {
  return deps.now ?? new Date();
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

function implementationSubject(root: string, path: string, base: string): GateSubject {
  const diff = changedFileDiff(root, path, base);
  return diff === null
    ? {target: path, files: [path], text: changedFileText(root, path), kind: 'file'}
    : {target: path, files: [path], text: boundedDiff(diff), kind: 'diff'};
}

function implementationSubjects(argv: string[], deps: AdrCliDeps): GateSubject[] {
  const root = deps.cwd ?? process.cwd();
  const result = valueAfter(argv, '--result');
  if (result) {
    const worktree = resultWorktree(result);
    const contentRoot = worktree !== undefined && existsSync(worktree) ? worktree : root;
    return resultChangedPaths(result).map((path) => implementationSubject(contentRoot, path, 'HEAD'));
  }

  const paths: string[] = [];
  const add = (path: string) => {
    if (path !== '' && !paths.includes(path)) paths.push(path);
  };

  const base = valueAfter(argv, '--base') ?? 'origin/main';
  for (const path of gitOutput(deps, ['diff', '--name-only', `${base}...HEAD`])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)) {
    add(path);
  }
  for (const path of changedPaths(gitOutput(deps, ['status', '--porcelain=v1']))) add(path);

  let diffBase = base;
  try {
    const merged = gitOutput(deps, ['merge-base', base, 'HEAD']).trim();
    if (merged !== '') diffBase = merged;
  } catch {
    // A missing merge base falls back to the requested ref.
  }
  return paths.map((path) => implementationSubject(root, path, diffBase));
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

async function runCheck(argv: string[], deps: AdrCliDeps): Promise<number> {
  const root = deps.cwd ?? process.cwd();
  const out = output(deps);
  const stage = valueAfter(argv, '--stage');
  if (stage !== 'design' && stage !== 'implementation' && stage !== 'ticket') {
    return failure(out, 'check needs --stage design|implementation|ticket');
  }

  const ready = preflight(root, deps);
  if (!ready) {
    const config = readAdrConfig(root) ?? proposeAdrConfig(root);
    if (config) {
      const discovery = adrDiscovery(join(root, config.dir), loadGateAdrs(root, config).length, config);
      if (discovery) {
        errorOutput(deps)(`${adrDiscoveryMessage(discovery, config)}\n`);
        if (flagSet(argv, '--json')) {
          out(`${JSON.stringify({stage, at: readingDate(deps).toISOString(), discovery}, null, 2)}\n`);
        }
        return 2;
      }
    }
    out('ADR gate off\n');
    return 0;
  }

  const discovery = adrDiscovery(join(root, ready.config.dir), ready.adrs.length, ready.config);
  if (discovery) {
    errorOutput(deps)(`${adrDiscoveryMessage(discovery, ready.config)}\n`);
    if (flagSet(argv, '--json')) {
      out(`${JSON.stringify({stage, at: readingDate(deps).toISOString(), discovery}, null, 2)}\n`);
    }
    return 2;
  }

  const classifier = await classifierFor(deps, root);
  if ('consentRequired' in classifier) return failure(out, classifier.consentRequired);
  const classify = classifier;
  let gate: AdrGateResult;
  let markdown: string;

  if (stage === 'ticket') {
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
    gate = result.gate;
    markdown = renderTicketReport([result]);
  } else {
    let subjects: GateSubject[];
    if (stage === 'design') {
      const input = valueAfter(argv, '--input');
      if (!input) return failure(out, 'check --stage design needs --input <file>');
      subjects = [{target: input, text: readFileSync(input, 'utf8')}];
    } else {
      subjects = implementationSubjects(argv, deps);
    }

    gate = await runAdrGate({
      root,
      stage,
      subjects,
      config: ready.config,
      adrs: ready.adrs,
      classify,
    });
    markdown = renderGateMarkdown(gate);
  }

  const findings = gate.findings.map((finding, index) => ({id: `F${index + 1}`, ...finding}));
  const document = {
    stage,
    at: readingDate(deps).toISOString(),
    gate,
    findings,
  };

  mkdirSync(dirname(latestPath(root)), {recursive: true});
  writeFileSync(latestPath(root), `${JSON.stringify(document, null, 2)}\n`);

  if (flagSet(argv, '--json')) {
    out(`${JSON.stringify(document, null, 2)}\n`);
  } else if (stage === 'ticket') {
    out(`${markdown}\n`);
  } else {
    out(`${printFindings(markdown, findings.map((finding) => finding.id))}\n`);
  }

  if (gate.inconclusive && gate.inconclusiveReason) errorOutput(deps)(`${gate.inconclusiveReason}\n`);
  return gate.blocked ? 3 : gate.inconclusive ? 2 : 0;
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
  const candidatesForRepo = scopeCandidates(root, maxCandidates === undefined ? undefined : {maxCandidates});
  const adrs = loadGateAdrs(root, config)
    .filter((adr) => adr.status === 'accepted')
    .filter((adr) => requested.length === 0 || requested.includes(adr.id))
    .filter(isForeignRecord);

  const classifier = await classifierFor(deps, root);
  if ('consentRequired' in classifier) return failure(out, classifier.consentRequired);
  const classify = classifier;
  type UncertainPath = {path: string; votes: number; samples: number};
  const proposals: Array<{
    adrId: string;
    path: string;
    appliesTo: string[];
    rules: Array<{id: string; text: string}>;
    uncertain: UncertainPath[];
    votes: Record<string, number>;
  }> = [];
  const skipped: Array<{adrId: string; reason: string; uncertain?: UncertainPath[]}> = [];

  for (const adr of adrs) {
    if (candidatesForRepo.length === 0) {
      skipped.push({adrId: adr.id, reason: 'no candidate path judged governed'});
      continue;
    }
    const counts = new Map<string, number>(candidatesForRepo.map((candidate) => [candidate, 0]));
    let anyKnown = false;
    for (let sample = 0; sample < samples; sample += 1) {
      const result = await analyze({input: scopeRequest(adr, candidatesForRepo), classify});
      for (const cell of result.cells.filter((entry) => entry.criterionId === 'governs')) {
        if (!cell.known) continue;
        anyKnown = true;
        if (cell.optionId === 'yes') counts.set(cell.itemId, (counts.get(cell.itemId) ?? 0) + 1);
      }
    }

    const voted = candidatesForRepo.filter((candidate) => (counts.get(candidate) ?? 0) > 0);
    const majority = voted.filter((candidate) => (counts.get(candidate) ?? 0) > samples / 2);
    const uncertain: UncertainPath[] = voted
      .filter((candidate) => (counts.get(candidate) ?? 0) <= samples / 2)
      .map((candidate) => ({path: candidate, votes: counts.get(candidate) ?? 0, samples}));
    const votes = Object.fromEntries(voted.map((candidate) => [candidate, counts.get(candidate) ?? 0]));

    if (majority.length === 0) {
      if (uncertain.length > 0) {
        skipped.push({adrId: adr.id, reason: `only uncertain paths (${uncertain.length})`, uncertain});
      } else if (!anyKnown) {
        skipped.push({adrId: adr.id, reason: 'Jev answers were unknown'});
      } else {
        skipped.push({adrId: adr.id, reason: 'no candidate path judged governed'});
      }
      continue;
    }

    const appliesTo: string[] = [];
    for (const candidate of majority) {
      if (appliesTo.some((kept) => candidate.startsWith(`${kept.replace(/\/\*\*$/, '')}/`))) continue;
      appliesTo.push(candidate);
    }
    const ruleD = adr.rules.find((rule) => rule.id === 'D');
    const rules = ruleD ? [{id: 'D', text: ruleD.text}] : [];
    const draft = draftFrontMatter(adr, {appliesTo, rules, uncertain});
    writeProposal(root, draft);
    proposals.push({adrId: adr.id, path: draft.path, appliesTo, rules, uncertain, votes});
  }

  if (flagSet(argv, '--json')) {
    out(`${JSON.stringify({proposals, skipped}, null, 2)}\n`);
  } else {
    for (const proposal of proposals) {
      const marginal = proposal.uncertain.length > 0 ? `, uncertain: ${proposal.uncertain.length}` : '';
      out(`${proposal.adrId} -> ${proposal.path} (applies_to: ${proposal.appliesTo.length} paths, rules: ${proposal.rules.length}${marginal})\n`);
    }
    for (const entry of skipped) out(`${entry.adrId} skipped: ${entry.reason}\n`);
  }
  return 0;
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

  if (command === 'lint') {
    const root = deps.cwd ?? process.cwd();
    const configured = readAdrConfig(root);
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
