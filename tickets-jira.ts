// ---------------------------------------------------------------------------
// Jira Cloud ticket adapter (issue #221).
//
// The adapter speaks Jira Cloud REST API v3 over an injected `fetch`, so tests
// never touch the network and production callers can supply the platform
// fetch. No command is spawned and no shell is used. Credentials are read from
// the environment only (`JIRA_EMAIL` and `JIRA_API_TOKEN`) and are never
// accepted from project configuration.
//
// ADR 0018 R10: ticket text is untrusted data. Descriptions are flattened from
// Atlassian Document Format (ADF) into plain text and only parsed for
// acceptance items; nothing in a ticket is evaluated or followed. Outgoing
// text is whatever the caller explicitly passes to comment/updateComment/label
// after applying `tickets.redact`; the adapter adds no process, shell or remote
// text of its own.
// ---------------------------------------------------------------------------

import {
  extractAcceptance,
  type Ticket,
  type TicketAdapter,
  type TicketQuery,
  type TicketState,
} from './tickets.ts';

export interface JiraAdapterConfig {
  baseUrl: string;
  project: string;
}

export interface JiraFetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface JiraFetchResponse {
  status: number;
  ok?: boolean;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

export type JiraFetch = (url: string, init: JiraFetchInit) => Promise<JiraFetchResponse>;

export interface JiraAdapterDeps {
  fetch: JiraFetch;
  env?: NodeJS.ProcessEnv;
}

const SEARCH_FIELDS = 'summary,description,labels,updated';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredEnv(env: NodeJS.ProcessEnv, name: 'JIRA_EMAIL' | 'JIRA_API_TOKEN'): string {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    // Name the missing variable, never a credential value (ADR 0018 R10).
    throw new Error(`Jira Cloud requires ${name} to be configured`);
  }
  return value.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jqlFor(project: string, state: TicketState): string {
  const base = `project=${project}`;
  if (state === 'closed') return `${base} AND statusCategory = Done`;
  if (state === 'all') return base;
  return `${base} AND statusCategory != Done`;
}

// --- ADF -> plain text ------------------------------------------------------

/** Inline text of a node: text, hardBreak, mention and emoji, else children. */
function inlineText(node: unknown): string {
  if (!isRecord(node)) return '';
  if (node.type === 'text') return typeof node.text === 'string' ? node.text : '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention' || node.type === 'emoji') {
    const attrs = isRecord(node.attrs) ? node.attrs : {};
    const text = typeof attrs.text === 'string' ? attrs.text : '';
    return node.type === 'mention' && text !== '' ? `@${text}` : text;
  }
  const content = Array.isArray(node.content) ? node.content : [];
  return content.map(inlineText).join('');
}

/** Flatten a list (bullet, ordered or task) into one block of Markdown lines. */
function flattenList(node: Record<string, unknown>): string {
  const items = Array.isArray(node.content) ? node.content : [];
  return items
    .map((item, index) => {
      const text = flattenBlocks(item).filter((part) => part !== '').join('\n');
      if (node.type === 'orderedList') return `${index + 1}. ${text}`;
      if (node.type === 'taskList' && isRecord(item)) {
        const attrs = isRecord(item.attrs) ? item.attrs : {};
        const done = attrs.state === 'DONE' || attrs.state === 'done';
        return `- [${done ? 'x' : ' '}] ${text}`;
      }
      return `- ${text}`;
    })
    .join('\n');
}

/** Flatten block nodes into an ordered list of blocks. */
function flattenBlocks(node: unknown): string[] {
  if (!isRecord(node)) return [];
  const content = Array.isArray(node.content) ? node.content : [];
  switch (node.type) {
    case 'doc':
      return content.flatMap(flattenBlocks);
    case 'paragraph':
      return [inlineText(node)];
    case 'heading': {
      const attrs = isRecord(node.attrs) ? node.attrs : {};
      const raw = typeof attrs.level === 'number' ? attrs.level : 1;
      const level = Math.min(6, Math.max(1, Math.trunc(raw)));
      return [`${'#'.repeat(level)} ${inlineText(node)}`.trimEnd()];
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return [flattenList(node)];
    case 'listItem':
    case 'taskItem': {
      const parts = content.flatMap(flattenBlocks).filter((part) => part !== '');
      return [parts.join('\n')];
    }
    case 'codeBlock':
    case 'blockquote': {
      const parts = content.flatMap(flattenBlocks).filter((part) => part !== '');
      return [parts.join('\n') || inlineText(node)];
    }
    case 'rule':
      return ['---'];
    default: {
      if (content.length > 0) return content.flatMap(flattenBlocks);
      const text = inlineText(node);
      return text === '' ? [] : [text];
    }
  }
}

/** Flatten a Jira v3 description (ADF) into plain text. A string passes through. */
function flattenDescription(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';
  return flattenBlocks(value)
    .map((block) => block.replace(/[ \t]+$/gm, '').trimEnd())
    .filter((block) => block.trim() !== '')
    .join('\n\n');
}

/** Plain text -> minimal ADF document for the v3 comment endpoints. */
function textToAdf(text: string): Record<string, unknown> {
  const paragraphs = text.split(/\r?\n/).map((line) => ({
    type: 'paragraph',
    content: line === '' ? [] : [{ type: 'text', text: line }],
  }));
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.length > 0 ? paragraphs : [{ type: 'paragraph', content: [] }],
  };
}

/**
 * Create a Jira Cloud-backed TicketAdapter. `baseUrl` and `project` come from
 * `tickets` configuration; credentials come only from the environment.
 */
export function createJiraAdapter(config: JiraAdapterConfig, deps: JiraAdapterDeps): TicketAdapter {
  const env = deps.env ?? process.env;
  const email = requiredEnv(env, 'JIRA_EMAIL');
  const token = requiredEnv(env, 'JIRA_API_TOKEN');
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const project = config.project;
  const authHeader = `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}`;
  const secrets = [email, token];

  /** Keep credential values out of every error message (ADR 0018 R10). */
  function redact(message: string): string {
    let out = message;
    for (const secret of secrets) {
      if (secret !== '') out = out.split(secret).join('[redacted]');
    }
    return out;
  }

  function fail(message: string): Error {
    return new Error(redact(message));
  }

  async function errorDetail(response: JiraFetchResponse): Promise<string> {
    try {
      if (typeof response.text === 'function') {
        const text = (await response.text()).trim();
        if (text !== '') return text.slice(0, 500);
      }
      const parsed = await response.json();
      if (parsed !== undefined) return JSON.stringify(parsed).slice(0, 500);
    } catch {
      // A missing or unreadable error body is not itself an error.
    }
    return '';
  }

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: authHeader,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response: JiraFetchResponse;
    try {
      response = await deps.fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw fail(`Jira request failed: ${errorMessage(error)}`);
    }

    const status = typeof response.status === 'number' ? response.status : 0;
    const ok = typeof response.ok === 'boolean' ? response.ok : status >= 200 && status < 300;
    if (!ok) {
      const detail = await errorDetail(response);
      throw fail(`Jira request failed with HTTP status ${status}${detail === '' ? '' : `: ${detail}`}`);
    }

    if (status === 204 || status === 205) return undefined;
    try {
      return await response.json();
    } catch (error) {
      throw fail(`Jira ${method} ${path} returned invalid JSON: ${errorMessage(error)}`);
    }
  }

  function normalizeIssue(raw: unknown): Ticket {
    if (!isRecord(raw)) throw fail('Jira returned an issue that is not an object');
    const key = typeof raw.key === 'string' ? raw.key : '';
    if (key === '') throw fail('Jira returned an issue without a key');
    const fields = isRecord(raw.fields) ? raw.fields : {};
    const body = flattenDescription(fields.description);
    return {
      id: key,
      url: `${baseUrl}/browse/${key}`,
      title: typeof fields.summary === 'string' ? fields.summary : '',
      body,
      labels: Array.isArray(fields.labels)
        ? fields.labels.filter((label): label is string => typeof label === 'string')
        : [],
      acceptance: extractAcceptance(body),
      updatedAt: typeof fields.updated === 'string' ? fields.updated : '',
    };
  }

  return {
    async list(query: TicketQuery = {}): Promise<Ticket[]> {
      const params = new URLSearchParams();
      params.set('jql', jqlFor(project, query.state ?? 'open'));
      params.set('fields', SEARCH_FIELDS);
      if (query.limit !== undefined) params.set('maxResults', String(query.limit));

      const raw = await request('GET', `/rest/api/3/search/jql?${params.toString()}`);
      if (!isRecord(raw) || !Array.isArray(raw.issues)) {
        throw fail('Jira search did not return an issues array');
      }
      return raw.issues.map(normalizeIssue);
    },

    async get(id: string): Promise<Ticket> {
      return normalizeIssue(await request('GET', `/rest/api/3/issue/${encodeURIComponent(id)}`));
    },

    async comment(id: string, body: string): Promise<{ id: string }> {
      const raw = await request('POST', `/rest/api/3/issue/${encodeURIComponent(id)}/comment`, {
        body: textToAdf(body),
      });
      if (!isRecord(raw) || raw.id === undefined || raw.id === null) {
        throw fail('Jira comment response did not include an id');
      }
      return { id: String(raw.id) };
    },

    async updateComment(id: string, commentId: string, body: string): Promise<void> {
      await request(
        'PUT',
        `/rest/api/3/issue/${encodeURIComponent(id)}/comment/${encodeURIComponent(commentId)}`,
        { body: textToAdf(body) },
      );
    },

    async label(id: string, name: string): Promise<void> {
      await request('PUT', `/rest/api/3/issue/${encodeURIComponent(id)}`, {
        update: { labels: [{ add: name }] },
      });
    },
  };
}
