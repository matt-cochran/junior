// ---------------------------------------------------------------------------
// GitHub ticket adapter (issue #221).
//
// Every operation is a `gh` argv call: no shell, no direct HTTP client. The
// adapter is deliberately small so the same interface can later front Jira and
// so tests can inject a command seam instead of running gh or git.
// ---------------------------------------------------------------------------

import {
  defaultTicketRun,
  extractAcceptance,
  type Ticket,
  type TicketAdapter,
  type TicketCommandResult,
  type TicketQuery,
  type TicketRun,
} from './tickets.ts';

export interface GithubAdapterDeps {
  /** Injectable command seam; defaults to runSync through `gh` argv. */
  run?: TicketRun;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const JSON_FIELDS = 'number,url,title,body,labels,updatedAt';
const DEFAULT_LIMIT = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function commandError(result: TicketCommandResult): Error {
  const stderr = result.stderr ?? '';
  const detail = stderr.trim() || result.error || `gh exited with status ${result.status}`;
  const error = new Error(detail);
  (error as Error & { status?: number | null; stderr?: string }).status = result.status;
  (error as Error & { status?: number | null; stderr?: string }).stderr = stderr;
  return error;
}

function labelName(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.name === 'string') return value.name;
  return null;
}

function normalizeTicket(raw: unknown): Ticket {
  if (!isRecord(raw)) throw new Error('gh returned a ticket that is not an object');
  const number = raw.number;
  if (typeof number !== 'number' && typeof number !== 'string') {
    throw new Error('gh returned a ticket without an issue number');
  }
  const body = typeof raw.body === 'string' ? raw.body : '';
  const labels = Array.isArray(raw.labels)
    ? raw.labels.map(labelName).filter((name): name is string => name !== null)
    : [];
  return {
    id: String(number),
    url: typeof raw.url === 'string' ? raw.url : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    body,
    labels,
    acceptance: extractAcceptance(body),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  };
}

function parseJson(text: string, operation: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`gh ${operation} returned invalid JSON: ${(error as Error).message}`);
  }
}

function commentId(stdout: string): string {
  const text = stdout.trim();
  if (text !== '') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && parsed.id !== undefined && parsed.id !== null) return String(parsed.id);
    } catch {
      // `gh issue comment` prints the comment URL rather than JSON.
    }
    const url = /#issuecomment-(\d+)/.exec(text);
    if (url) return url[1];
    if (/^\d+$/.test(text)) return text;
  }
  throw new Error('gh issue comment did not return a comment id');
}

/**
 * Create a GitHub-backed TicketAdapter. The caller supplies `owner/repo`; the
 * default runner is argv-only and synchronous underneath the Promise surface.
 */
export function createGithubAdapter(repo: string, deps: GithubAdapterDeps = {}): TicketAdapter {
  const run: TicketRun = deps.run ?? ((command, args) => defaultTicketRun(command, args, { cwd: deps.cwd, env: deps.env }));

  async function gh(args: string[]): Promise<string> {
    const result = await run('gh', args);
    if (result.status !== 0 || result.error) throw commandError(result);
    return result.stdout ?? '';
  }

  return {
    async list(query: TicketQuery = {}): Promise<Ticket[]> {
      const state = query.state ?? 'open';
      const limit = query.limit ?? DEFAULT_LIMIT;
      const args = ['issue', 'list', '--repo', repo, '--state', state];
      for (const label of query.labels ?? []) args.push('--label', label);
      args.push('--limit', String(limit), '--json', JSON_FIELDS);

      const stdout = await gh(args);
      if (stdout.trim() === '') return [];
      const parsed = parseJson(stdout, 'issue list');
      if (!Array.isArray(parsed)) throw new Error('gh issue list did not return a JSON array');
      return parsed.map(normalizeTicket);
    },

    async get(id: string): Promise<Ticket> {
      const stdout = await gh(['issue', 'view', id, '--repo', repo, '--json', JSON_FIELDS]);
      return normalizeTicket(parseJson(stdout, 'issue view'));
    },

    async comment(id: string, body: string): Promise<{ id: string }> {
      const stdout = await gh(['issue', 'comment', id, '--repo', repo, '--body', body]);
      return { id: commentId(stdout) };
    },

    async updateComment(id: string, commentId: string, body: string): Promise<void> {
      await gh(['api', '--method', 'PATCH', `repos/${repo}/issues/comments/${commentId}`, '--field', `body=${body}`]);
    },

    async label(id: string, name: string): Promise<void> {
      await gh(['issue', 'edit', id, '--repo', repo, '--add-label', name]);
    },
  };
}
