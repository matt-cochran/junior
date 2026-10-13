// ---------------------------------------------------------------------------
// `junior report-issue` — draft a redacted upstream bug report for a tool
// Junior uses, and (only with `--file`) file it with the GitHub CLI.
//
// The draft has three parts: the manager's description (read from
// `--body-file`), an Environment section (Junior version, the tool's version
// from `<binary> --version`, OS/arch and Node), and, with `--hop`, the last ten
// recorded evidence entries for that tool. Evidence never carries snapshot
// contents. The whole draft is redacted before it is printed or filed.
//
// Without `--file` this module changes nothing: it prints the Markdown draft and
// the exact `gh issue create` argv it would run. With `--file` it first lists
// open issues with the same title and refuses to create a duplicate unless
// `--force`. Every child runs with argv (no shell).
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { readPackageVersion, spawnSpec } from './cli-entry.ts';
import { loadHop } from './tools/tools.ts';

export type ReportTool = 'fmeca' | 'cpm' | 'crossmatrix' | 'jevitate' | 'triz' | 'junior';

export interface ReportTarget {
  /** `owner/repo` on GitHub. */
  repo: string;
  /** Binary whose `--version` names the installed tool version. */
  binary: string;
}

/** Upstream repository (and probe binary) for every tool Junior can report on. */
export const REPORT_TARGETS: Record<ReportTool, ReportTarget> = {
  fmeca: { repo: 'praxec/fmeca', binary: 'fmeca-mcp' },
  cpm: { repo: 'praxec/cpm-planner', binary: 'cpm-planner' },
  crossmatrix: { repo: 'praxec/crossmatrix', binary: 'crossmatrix-mcp' },
  jevitate: { repo: 'matt-cochran/jevitate', binary: 'jevitate' },
  triz: { repo: 'matt-cochran/triz', binary: 'triz' },
  junior: { repo: 'matt-cochran/junior', binary: 'junior' },
};

export type ExecResult = { status: number | null; stdout?: string; stderr?: string; error?: string };
export type Exec = (
  command: string,
  args: string[],
  options?: { timeout?: number; env?: NodeJS.ProcessEnv; cwd?: string },
) => ExecResult;

export interface ReportIssueDeps {
  /** Injectable process seam so tests never spawn a real binary or gh. */
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Home directory that is rewritten to `~` (default: the real home). */
  home?: string;
  /** Directory that holds the staged Markdown body (tests inject a temp dir). */
  stagingDir?: string;
  readFile?: (path: string, encoding?: string) => string;
  writeFile?: (path: string, data: string) => void;
  write?: (text: string) => void;
}

export interface DraftInput {
  tool: ReportTool;
  title: string;
  bodyFile?: string;
  hopPath?: string;
}

export interface DraftResult {
  repo: string;
  title: string;
  body: string;
  command: string[];
}

export interface ReportIssueInput extends DraftInput {
  file?: boolean;
  force?: boolean;
}

export interface OpenIssue {
  number: number;
  title: string;
  url: string;
}

export interface ReportIssueOutcome extends DraftResult {
  filed: boolean;
  url?: string;
  duplicate?: OpenIssue;
}

const GH_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 15_000;

function defaultExec(command: string, args: string[], options: { timeout?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {}): ExecResult {
  const spec = spawnSpec(command, args);
  const result = spawnSync(spec.command, spec.args, {
    encoding: 'utf8',
    timeout: options.timeout,
    env: options.env,
    cwd: options.cwd,
    shell: spec.shell,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
}

function run(deps: ReportIssueDeps, command: string, args: string[], timeout: number): ExecResult {
  return (deps.exec ?? defaultExec)(command, args, { timeout, env: deps.env ?? process.env, cwd: deps.cwd });
}

function firstSemver(text: string | undefined): string | null {
  const match = String(text ?? '').match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** Token shapes and `KEY/TOKEN/SECRET=value` assignments that are never filed. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]+/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]+/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:[A-Za-z0-9]+_)*(?:KEY|TOKEN|SECRET)(?:_[A-Za-z0-9]+)*\s*[=:]\s*\S+/gi,
];

/** Replace secrets with `[REDACTED]` and the user's home with `~`. */
export function redact(text: string, home: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  const normalized = home.replace(/[\\/]+$/, '');
  if (normalized) out = out.split(normalized).join('~');
  return out;
}

// ---------------------------------------------------------------------------
// Draft construction
// ---------------------------------------------------------------------------

function evidenceSection(tool: ReportTool, hopPath: string): string {
  const manifest = loadHop(hopPath);
  const entries = manifest.evidence.filter((entry) => entry.tool === tool).slice(-10);
  const lines = ['## Recent evidence', ''];
  if (entries.length === 0) {
    lines.push('_No recorded evidence for this tool._');
    return lines.join('\n');
  }
  lines.push('| revision | toolName | kind | status | note |', '| --- | --- | --- | --- | --- |');
  for (const entry of entries) {
    // Only the bounded evidence summary travels; snapshot contents never do.
    const note = (entry.note ?? '').replace(/\s+/g, ' ').trim();
    lines.push(`| ${entry.revision} | ${entry.toolName} | ${entry.kind} | ${entry.status} | ${note} |`);
  }
  return lines.join('\n');
}

function stageBody(body: string, deps: ReportIssueDeps): string {
  const dir = deps.stagingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'junior-report-issue-'));
  const file = path.join(dir, 'report-issue-body.md');
  const writeFile = deps.writeFile ?? ((target: string, data: string) => fs.writeFileSync(target, data));
  writeFile(file, body);
  return file;
}

/**
 * Build the redacted Markdown draft and the exact `gh issue create` argv. The
 * body is staged to a temp file so the argv is exact and reusable when filing.
 */
export function buildDraft(input: DraftInput, deps: ReportIssueDeps = {}): DraftResult {
  const target = REPORT_TARGETS[input.tool];
  if (!target) throw new Error(`Unknown tool: ${input.tool}`);
  const home = deps.home ?? os.homedir();
  const readFile = deps.readFile ?? ((file: string) => fs.readFileSync(file, 'utf8'));
  const description = input.bodyFile ? readFile(input.bodyFile, 'utf8') : '';

  const versionProbe = run(deps, target.binary, ['--version'], VERSION_TIMEOUT_MS);
  const toolVersion = firstSemver(versionProbe.stdout) ?? 'unknown';
  const juniorVersion = readPackageVersion(import.meta.url);
  const title = redact(input.title, home);

  const parts = [
    `# ${title}`,
    '',
    '## Description',
    '',
    redact(description.trim() || '_No description provided._', home),
    '',
    '## Environment',
    '',
    `- junior: ${juniorVersion}`,
    `- ${input.tool}: ${toolVersion}`,
    `- os: ${process.platform}/${process.arch}`,
    `- node: ${process.version}`,
  ];
  if (input.hopPath) parts.push('', redact(evidenceSection(input.tool, input.hopPath), home));
  const body = parts.join('\n') + '\n';

  const command = ['gh', 'issue', 'create', '--repo', target.repo, '--title', title, '--body-file', stageBody(body, deps)];
  return { repo: target.repo, title, body, command };
}

function parseIssues(stdout: string | undefined): OpenIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((issue): issue is OpenIssue => !!issue && typeof issue.title === 'string')
    .map((issue) => ({ number: Number(issue.number), title: issue.title, url: String(issue.url ?? '') }));
}

/**
 * Draft the report and, with `file`, check for a same-title open issue before
 * creating one. Returns the draft regardless; `filed` only becomes true when
 * `gh issue create` ran successfully.
 */
export function reportIssue(input: ReportIssueInput, deps: ReportIssueDeps = {}): ReportIssueOutcome {
  const draft = buildDraft(input, deps);
  if (!input.file) return { ...draft, filed: false };

  const listArgs = ['issue', 'list', '--repo', draft.repo, '--state', 'open', '--search', draft.title, '--json', 'number,title,url'];
  const listed = run(deps, 'gh', listArgs, GH_TIMEOUT_MS);
  if (listed.status !== 0) throw new Error(listed.error || listed.stderr || `gh issue list exited ${listed.status}`);
  const duplicate = parseIssues(listed.stdout).find((issue) => issue.title === draft.title);
  if (duplicate && !input.force) return { ...draft, filed: false, duplicate };

  const created = run(deps, draft.command[0], draft.command.slice(1), GH_TIMEOUT_MS);
  if (created.status !== 0) throw new Error(created.error || created.stderr || `gh issue create exited ${created.status}`);
  const url = String(created.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .pop() ?? '';
  return { ...draft, filed: true, url };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const REPORT_USAGE = [
  'Usage: junior report-issue <tool> --title <t> [--body-file <f>] [--hop <hop.json>] [--file] [--force]',
  `  tools: ${Object.keys(REPORT_TARGETS).join(', ')}`,
  '  Without --file it prints the draft and the exact gh argv; --file files it after a duplicate check.',
].join('\n');

interface ParsedReportArgs {
  tool?: string;
  title?: string;
  bodyFile?: string;
  hopPath?: string;
  file: boolean;
  force: boolean;
}

function parseArgs(args: string[]): ParsedReportArgs {
  const parsed: ParsedReportArgs = { file: false, force: false };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (name === '--file' || name === '--force') {
      if (inline !== undefined) throw new Error(`Option ${name} does not take a value`);
      if (name === '--file') parsed.file = true;
      else parsed.force = true;
      continue;
    }
    if (name === '--title' || name === '--body-file' || name === '--hop') {
      let value = inline;
      if (value === undefined) value = args[++i];
      if (value === undefined || value === '' || value.startsWith('-')) throw new Error(`Option ${name} requires a value`);
      if (name === '--title') parsed.title = value;
      else if (name === '--body-file') parsed.bodyFile = value;
      else parsed.hopPath = value;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option for report-issue: ${arg}`);
    positional.push(arg);
  }
  if (positional.length > 1) throw new Error('Too many arguments for report-issue: expected at most 1');
  parsed.tool = positional[0];
  return parsed;
}

export async function main(argv: string[], deps: ReportIssueDeps = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const first = argv[0];
  if (!first || first === '--help' || first === '-h' || first === 'help') {
    write(REPORT_USAGE + '\n');
    return 0;
  }
  let parsed: ParsedReportArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    write(`${err instanceof Error ? err.message : String(err)}\n${REPORT_USAGE}\n`);
    return 1;
  }
  if (!parsed.tool || !REPORT_TARGETS[parsed.tool as ReportTool]) {
    write(`Unknown or missing tool (expected ${Object.keys(REPORT_TARGETS).join('|')})\n${REPORT_USAGE}\n`);
    return 1;
  }
  if (!parsed.title) {
    write(`Option --title is required\n${REPORT_USAGE}\n`);
    return 1;
  }
  try {
    const outcome = reportIssue({ ...parsed, tool: parsed.tool as ReportTool }, deps);
    if (!parsed.file) {
      write(JSON.stringify({ repo: outcome.repo, title: outcome.title, body: outcome.body, command: outcome.command }, null, 2) + '\n');
    } else if (!outcome.filed) {
      write(JSON.stringify({ repo: outcome.repo, title: outcome.title, filed: false, duplicate: outcome.duplicate, command: outcome.command }, null, 2) + '\n');
    } else {
      write(`${outcome.url ?? ''}\n`);
    }
    return 0;
  } catch (err) {
    write(JSON.stringify({ ok: false, error: { code: 'REPORT_ISSUE_ERROR', message: err instanceof Error ? err.message : String(err) } }, null, 2) + '\n');
    return 1;
  }
}