// ---------------------------------------------------------------------------
// Ticket adapters.
//
// A ticket provider is configured per project. This module defines the common
// Ticket shape, the adapter surface, acceptance extraction and the project
// configuration reader. Provider implementations (GitHub first) live beside it
// so callers never depend on a command line or a network client.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import { join } from 'node:path';
import { runSync } from './spawn-sync.ts';

export type TicketState = 'open' | 'closed' | 'all';

export interface TicketQuery {
  state?: TicketState;
  labels?: string[];
  limit?: number;
}

export interface Ticket {
  id: string;
  url: string;
  title: string;
  body: string;
  labels: string[];
  acceptance: string[];
  updatedAt: string;
}

export interface TicketAdapter {
  list(query?: TicketQuery): Promise<Ticket[]>;
  get(id: string): Promise<Ticket>;
  comment?(id: string, body: string): Promise<{ id: string }>;
  updateComment?(id: string, commentId: string, body: string): Promise<void>;
  label?(id: string, name: string): Promise<void>;
}

export type TicketProvider = 'github' | 'jira';

export interface TicketsConfig {
  provider: TicketProvider;
  repo?: string;
  project?: string;
  baseUrl?: string;
  query?: string;
  /**
   * Patterns applied to ticket and ADR text before it leaves the machine
   * (ADR 0018 R10). The adapter does not transmit text itself; callers use this
   * list for any model or remote request.
   */
  redact?: string[];
  writeBack?: boolean;
}

export interface TicketCommandResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export type TicketRun = (command: string, args: string[]) => TicketCommandResult;

export interface TicketRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Default command seam: argv only, through the sandbox-safe synchronous runner. */
export function defaultTicketRun(command: string, args: string[], options: TicketRunOptions = {}): TicketCommandResult {
  const result = runSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message,
  };
}

export interface TicketsConfigDeps extends TicketRunOptions {
  /** Injectable command seam so tests never run git. */
  run?: TicketRun;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Collect Markdown task-list text under every heading that names Acceptance.
 * A heading starts a section that lasts until a heading at the same or a
 * higher level; nested headings stay inside it. Fenced code is ignored.
 */
export function extractAcceptance(body: string): string[] {
  const items: string[] = [];
  const acceptanceLevels: number[] = [];
  let fenced = false;

  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      while (acceptanceLevels.length > 0 && level <= acceptanceLevels[acceptanceLevels.length - 1]) {
        acceptanceLevels.pop();
      }
      if (/acceptance/i.test(heading[2])) acceptanceLevels.push(level);
      continue;
    }

    if (acceptanceLevels.length === 0) continue;
    const item = /^\s*[-*+]\s+\[[ xX]\]\s+(.+?)\s*$/.exec(line);
    if (item) items.push(item[1]);
  }

  return items;
}

function readConfigFile(root: string): unknown | null {
  let raw: string;
  try {
    raw = fs.readFileSync(join(root, 'delivery.config.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`delivery.config.json is not valid JSON: ${(error as Error).message}`);
  }
}

function optionalString(block: Record<string, unknown>, field: string): string | undefined {
  const value = block[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`tickets.${field} must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(block: Record<string, unknown>, field: string): boolean | undefined {
  const value = block[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`tickets.${field} must be a boolean`);
  return value;
}

function optionalRedact(block: Record<string, unknown>): string[] | undefined {
  const value = block.redact;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('tickets.redact must be an array of strings');
  }
  return value as string[];
}

/** `owner/repo` from an https, ssh or scp-style GitHub remote URL. */
function githubRepoFromRemote(remote: string): string | null {
  const text = remote.trim();
  const url = /^(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(text);
  const scp = /^(?:[^@/\s]+@)?github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(text);
  const match = url ?? scp;
  return match ? `${match[1]}/${match[2]}` : null;
}

function remoteRepo(root: string, deps: TicketsConfigDeps): string {
  const run = deps.run ?? ((command, args) => defaultTicketRun(command, args, { cwd: root, env: deps.env }));
  const result = run('git', ['remote', 'get-url', 'origin']);
  if (result.status !== 0 || result.error) {
    const detail = (result.stderr ?? '').trim() || result.error || `exit status ${result.status}`;
    throw new Error(`tickets.repo: git remote get-url origin failed: ${detail}`);
  }
  const repo = githubRepoFromRemote(result.stdout ?? '');
  if (!repo) throw new Error('tickets.repo could not be parsed from the origin remote as a GitHub repository');
  return repo;
}

/**
 * Read the `tickets` block of delivery.config.json. With no block, default to
 * GitHub and discover `owner/repo` from the origin remote. Invalid fields name
 * themselves in the error.
 */
export function readTicketsConfig(root: string, deps: TicketsConfigDeps | TicketRun = {}): TicketsConfig {
  const options: TicketsConfigDeps = typeof deps === 'function' ? { run: deps } : deps;
  const document = readConfigFile(root);
  if (document === null) return { provider: 'github', repo: remoteRepo(root, options) };
  if (!isRecord(document)) throw new Error('delivery.config.json must be a JSON object');

  const block = document.tickets;
  if (block === undefined || block === null) return { provider: 'github', repo: remoteRepo(root, options) };
  if (!isRecord(block)) throw new Error('tickets must be an object');

  const provider = block.provider ?? 'github';
  if (provider !== 'github' && provider !== 'jira') {
    throw new Error('tickets.provider must be github or jira');
  }

  const repo = optionalString(block, 'repo');
  const project = optionalString(block, 'project');
  const baseUrl = optionalString(block, 'baseUrl');
  const query = optionalString(block, 'query');
  const redact = optionalRedact(block);
  const writeBack = optionalBoolean(block, 'writeBack');

  const config: TicketsConfig = { provider };
  if (repo !== undefined) config.repo = repo;
  if (project !== undefined) config.project = project;
  if (baseUrl !== undefined) config.baseUrl = baseUrl;
  if (query !== undefined) config.query = query;
  if (redact !== undefined) config.redact = redact;
  if (writeBack !== undefined) config.writeBack = writeBack;

  return config;
}
