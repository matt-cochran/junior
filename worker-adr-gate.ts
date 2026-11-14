// ---------------------------------------------------------------------------
// Junior's own runs go through the ADR conformance gate (ADR 0018 R2-R5).
//
// This is the worker-facing seam between a run and the gate:
//   * a prepare brief is checked at the design stage before the manager picks
//     an option (R3, R5);
//   * a code handoff's changed files are checked at the implementation stage
//     before the run becomes ready for review (R3, R4);
//   * a ticket can be checked before delegation (R3).
//
// The project configuration is read through adr-config.ts. Until the user has
// confirmed the `adr` block, a proposed `enforce` gate is downgraded to
// `advisory` so an upgrade never starts blocking work unannounced (R2). The
// gate never records a decision on the user's behalf (R5).
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAdrConfig, proposeAdrConfig, type AdrConfig } from './adr-config.ts';
import { loadAllAdrs } from './adr-foreign.ts';
import { renderGateMarkdown, runAdrGate, type AdrGateResult } from './adr-gate.ts';
import { checkTicket, type TicketCheckResult } from './adr-tickets.ts';
import { gateBrief, type Brief } from './prepare.ts';
import { readTicketsConfig, type TicketAdapter, type TicketsConfig } from './tickets.ts';
import { createGithubAdapter } from './tickets-github.ts';
import { createJiraAdapter, type JiraFetch } from './tickets-jira.ts';
import type { Adr } from './adr.ts';
import type { GateClassifier } from './worker.ts';

export interface ResolvedGateConfig {
  config: AdrConfig;
  /** True only when the user's `adr` block was recorded in config (R2). */
  confirmed: boolean;
}

export interface ImplementationGateResult {
  result: AdrGateResult | null;
  status: null | 'needs_adr_decision' | 'needs_operator';
  markdown: string | null;
}

export interface TicketGateResult {
  result: TicketCheckResult;
  status: null | 'needs_adr_decision';
}

/**
 * ADR 0018 R2: read the recorded `adr` block, or propose one from the detected
 * directory. A proposal never enforces: an unconfirmed gate is advisory until
 * the user confirms it, and an `off` gate yields no gate at all.
 */
export function resolveGateConfig(cwd: string): ResolvedGateConfig | null {
  const configured = readAdrConfig(cwd);
  if (configured) {
    if (configured.gate === 'off') return null;
    return {config: configured, confirmed: true};
  }

  const proposed = proposeAdrConfig(cwd);
  if (!proposed || proposed.gate === 'off') return null;
  return {
    config: {
      ...proposed,
      gate: proposed.gate === 'enforce' ? 'advisory' : proposed.gate,
    },
    confirmed: false,
  };
}

/** ADR 0018 R9: read Junior and MADR/Nygard records into one collection. */
export function loadGateAdrs(cwd: string, config: AdrConfig): Adr[] {
  return loadAllAdrs(join(cwd, config.dir));
}

/** ADR 0018 R3/R5: gate the prepare brief at the design stage. */
export async function designGate(opts: {
  cwd: string;
  brief: Brief;
  deliverable?: string;
  classify?: GateClassifier;
}): Promise<Brief> {
  const resolved = resolveGateConfig(opts.cwd);
  if (!resolved) return opts.brief;
  return gateBrief({
    root: opts.cwd,
    brief: opts.brief,
    config: resolved.config,
    adrs: loadGateAdrs(opts.cwd, resolved.config),
    ...(opts.deliverable !== undefined ? {deliverable: opts.deliverable} : {}),
    ...(opts.classify !== undefined ? {classify: opts.classify} : {}),
  });
}

/**
 * ADR 0018 R3-R5: check each changed file as one implementation-stage subject.
 * No changed files or no configured gate means no classifier call. A blocked
 * result needs a human decision; an unattended run stops as needs_operator.
 */

/** The changed file's content for the classifier, bounded; a gate that sees
 * only a path cannot judge conformance. */
export const CHANGED_FILE_TEXT_LIMIT = 6000;
export function changedFileText(root: string, path: string): string {
  try {
    const text = readFileSync(join(root, path), 'utf8');
    return text.length > CHANGED_FILE_TEXT_LIMIT ? `${text.slice(0, CHANGED_FILE_TEXT_LIMIT)}\n[truncated]` : text;
  } catch {
    return '(file deleted or unreadable)';
  }
}

export async function implementationGate(opts: {
  cwd: string;
  changedFiles: string[];
  deliverable?: string;
  classify?: GateClassifier;
  unattended?: boolean;
  /** Where the changed files' content lives (a handoff's worktree); defaults to cwd. */
  contentRoot?: string;
}): Promise<ImplementationGateResult> {
  const empty: ImplementationGateResult = {result: null, status: null, markdown: null};
  if (opts.changedFiles.length === 0) return empty;

  const resolved = resolveGateConfig(opts.cwd);
  if (!resolved) return empty;

  const result = await runAdrGate({
    root: opts.cwd,
    stage: 'implementation',
    subjects: opts.changedFiles.map((path) => ({target: path, files: [path], text: changedFileText(opts.contentRoot ?? opts.cwd, path)})),
    config: resolved.config,
    adrs: loadGateAdrs(opts.cwd, resolved.config),
    ...(opts.deliverable !== undefined ? {deliverable: opts.deliverable} : {}),
    ...(opts.classify !== undefined ? {classify: opts.classify} : {}),
  });

  return {
    result,
    status: result.blocked ? (opts.unattended === true ? 'needs_operator' : 'needs_adr_decision') : null,
    markdown: renderGateMarkdown(result),
  };
}

/** Global fetch adapted to the Jira adapter's narrow response surface. */
const jiraFetch: JiraFetch = async (url, init) => {
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

function adapterFor(config: TicketsConfig, cwd: string): TicketAdapter {
  if (config.provider === 'jira') {
    if (!config.baseUrl || !config.project) {
      throw new Error('tickets.baseUrl and tickets.project are required for the Jira adapter');
    }
    return createJiraAdapter({baseUrl: config.baseUrl, project: config.project}, {fetch: jiraFetch});
  }
  if (!config.repo) throw new Error('tickets.repo is required for the GitHub adapter');
  return createGithubAdapter(config.repo, {cwd});
}

/**
 * ADR 0018 R3: check a ticket before delegation. The ticket text is passed to
 * the classifier as untrusted data and redacted first (R10). A blocked result
 * needs a human decision (R5).
 */
export async function ticketGate(opts: {
  cwd: string;
  ticketId: string;
  deliverable?: string;
  classify?: GateClassifier;
  adapter?: TicketAdapter;
}): Promise<TicketGateResult> {
  const resolved = resolveGateConfig(opts.cwd);
  const config: AdrConfig = resolved?.config ?? {dir: 'docs/adr', format: 'junior', gate: 'off'};

  let adapter = opts.adapter;
  let redact: string[] | undefined;
  if (!adapter) {
    const tickets = readTicketsConfig(opts.cwd);
    redact = tickets.redact;
    adapter = adapterFor(tickets, opts.cwd);
  }

  const ticket = await adapter.get(opts.ticketId);
  const result = await checkTicket({
    root: opts.cwd,
    ticket,
    config,
    ...(resolved ? {adrs: loadGateAdrs(opts.cwd, config)} : {}),
    ...(opts.deliverable !== undefined ? {deliverable: opts.deliverable} : {}),
    ...(opts.classify !== undefined ? {classify: opts.classify} : {}),
    ...(redact !== undefined ? {redact} : {}),
  });

  return {result, status: result.gate.blocked ? 'needs_adr_decision' : null};
}
