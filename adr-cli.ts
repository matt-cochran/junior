// ---------------------------------------------------------------------------
// `junior adr` command surface (issues #220, #221, #223).
//
// This module is deliberately a thin shell: it parses arguments, calls the ADR
// config, init, gate, ticket and ledger functions, and prints their results. It
// owns no gate or ledger logic of its own.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runAdr } from './adr.ts';
import {
  defaultGate,
  detectAdrDir,
  detectAdrFormat,
  proposeAdrConfig,
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
import { changedFileText } from './worker-adr-gate.ts';

export type AdrGit = (args: string[]) => {status: number; stdout: string};

export interface AdrCliDeps {
  cwd?: string;
  classify?: GateClassifier;
  git?: AdrGit;
  adapter?: TicketAdapter;
  stdout?: (s: string) => void;
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
  '  new|lint|sync delegate to `junior matrix adr`',
].join('\n');

function output(deps: AdrCliDeps): (s: string) => void {
  return deps.stdout ?? ((s) => process.stdout.write(s));
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

function gitOutput(deps: AdrCliDeps, args: string[]): string {
  if (!deps.git) throw new Error('this command needs deps.git');
  const result = deps.git(args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed with status ${result.status}`);
  return result.stdout;
}

function implementationSubjects(argv: string[], deps: AdrCliDeps): GateSubject[] {
  const paths: string[] = [];
  const add = (path: string) => {
    if (path !== '' && !paths.includes(path)) paths.push(path);
  };

  const result = valueAfter(argv, '--result');
  if (result) {
    for (const path of resultChangedPaths(result)) add(path);
  } else {
    const base = valueAfter(argv, '--base') ?? 'origin/main';
    for (const path of gitOutput(deps, ['diff', '--name-only', `${base}...HEAD`])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)) {
      add(path);
    }
    for (const path of changedPaths(gitOutput(deps, ['status', '--porcelain=v1']))) add(path);
  }

  return paths.map((path) => ({target: path, files: [path], text: changedFileText(deps.cwd ?? process.cwd(), path)}));
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
    out('ADR gate off\n');
    return 0;
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

  return gate.blocked ? 3 : 0;
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
  return {
    dir,
    format: detectAdrFormat(absolute),
    gate: defaultGate(absolute),
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

  if (command === 'new' || command === 'lint' || command === 'sync') {
    return runAdr([command, ...rest]);
  }
  if (command === 'init') return runInit(rest, deps);
  if (command === 'check') return runCheck(rest, deps);
  if (command === 'decide') return runDecide(rest, deps);
  if (command === 'check-tickets') return runCheckTickets(rest, deps);

  out(`${ADR_CLI_USAGE}\n`);
  return 1;
}
