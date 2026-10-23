// ---------------------------------------------------------------------------
// Open pull requests for the compact session-start block.
//
// The current repository and any configured companion repositories are queried
// with `gh`, concurrently. This module never throws from `openPullRequests`:
// failures are reported per repository so the surrounding compact block can
// fail soft.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type OpenPr = {
  repo: string;
  number: number;
  title: string;
  base: string;
  head: string;
  draft: boolean;
  url: string;
};

export type PrSection = {
  status: 'ok' | 'none' | 'unavailable';
  prs: OpenPr[];
  errors: string[];
};

export type RunGh = (
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; stderr: string; error?: string }>;

const DEFAULT_TIMEOUT_MS = 3000;
const PR_FIELDS = 'number,title,baseRefName,headRefName,isDraft,url';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ghErrorMessage(error: any): string {
  const code = error?.code;
  if (code === 'ENOENT') return 'gh not found';
  if (error?.killed || error?.signal || code === 'ETIMEDOUT') return 'gh timed out';
  if (typeof code === 'number') return `gh exited ${code}`;
  return messageOf(error);
}

function defaultRunGh(args: string[], opts: { cwd: string; timeoutMs: number }): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}> {
  return new Promise((resolve) => {
    try {
      execFile(
        'gh',
        args,
        { cwd: opts.cwd, timeout: opts.timeoutMs, encoding: 'utf8' },
        (error, stdout, stderr) => {
          resolve({
            code: error ? (typeof (error as any).code === 'number' ? (error as any).code : null) : 0,
            stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
            stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
            error: error ? ghErrorMessage(error) : undefined,
          });
        },
      );
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error: ghErrorMessage(error) });
    }
  });
}

function configuredRepos(cwd: string, readFile: (p: string) => string): string[] {
  try {
    const config = JSON.parse(readFile(join(cwd, 'delivery.config.json')));
    const repos = config?.compact?.repos;
    if (!Array.isArray(repos)) return [];
    return repos.filter((repo: unknown): repo is string => typeof repo === 'string' && repo.length > 0);
  } catch {
    return [];
  }
}

function parsePrs(repo: string, stdout: string): OpenPr[] {
  const raw = JSON.parse(stdout);
  if (!Array.isArray(raw)) throw new Error('gh returned non-array JSON');
  return raw.map((item: any) => ({
    repo,
    number: typeof item?.number === 'number' ? item.number : Number(item?.number),
    title: item?.title === undefined ? '' : String(item.title),
    base: item?.baseRefName === undefined ? '' : String(item.baseRefName),
    head: item?.headRefName === undefined ? '' : String(item.headRefName),
    draft: item?.isDraft === true,
    url: item?.url === undefined ? '' : String(item.url),
  }));
}

type RepoResult = { repo: string; prs: OpenPr[]; error?: string };

async function queryRepo(
  repo: string,
  runGh: RunGh,
  cwd: string,
  timeoutMs: number,
): Promise<RepoResult> {
  const args = ['pr', 'list', '--state', 'open', '--limit', '20', '--json', PR_FIELDS];
  if (repo !== '.') args.push('--repo', repo);
  try {
    const result = await runGh(args, { cwd, timeoutMs });
    if (!result || result.error) {
      return { repo, prs: [], error: result?.error ?? 'gh failed' };
    }
    if (result.code !== 0) {
      return { repo, prs: [], error: `gh exited ${result.code}` };
    }
    return { repo, prs: parsePrs(repo, result.stdout) };
  } catch (error) {
    return { repo, prs: [], error: messageOf(error) };
  }
}

/**
 * Query the current repository and any `compact.repos` entries concurrently.
 * Every per-repository failure becomes an error string; the promise always
 * resolves to a section.
 */
export async function openPullRequests(deps: {
  cwd: string;
  runGh?: RunGh;
  readFile?: (p: string) => string;
  timeoutMs?: number;
}): Promise<PrSection> {
  try {
    const runGh = deps.runGh ?? defaultRunGh;
    const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const repos = ['.', ...configuredRepos(deps.cwd, readFile)];
    const results = await Promise.all(
      repos.map((repo) => queryRepo(repo, runGh, deps.cwd, timeoutMs)),
    );
    const prs = results.flatMap((result) => result.prs);
    const errors = results
      .filter((result) => result.error !== undefined)
      .map((result) => `${result.repo}: ${result.error}`);
    const status =
      errors.length === results.length
        ? 'unavailable'
        : errors.length === 0 && prs.length === 0
          ? 'none'
          : 'ok';
    return { status, prs, errors };
  } catch {
    return { status: 'unavailable', prs: [], errors: ['.: gh failed'] };
  }
}

/** Render one compact line per pull request followed by one line per error. */
export function prLines(section: PrSection): string[] {
  if (section.status === 'none') return ['- none'];
  const lines = section.prs.map(
    (pr) =>
      `- ${pr.repo}#${pr.number} ${pr.title} (${pr.head} -> ${pr.base})${pr.draft ? ' [draft]' : ''}`,
  );
  return [...lines, ...section.errors.map((error) => `- unavailable: ${error}`)];
}
