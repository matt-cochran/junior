/**
 * Contract-shape lint (#279), run by `junior validate`, `junior handoff`
 * preflight (through validate) and `junior plan check`.
 *
 * Two findings keep evidence and budgets honest before a paid run starts:
 * CHECK_UNFILTERED flags a check that reruns a whole test project while the
 * contract names only a few test files, and CONTRACT_OVER_BUDGET estimates the
 * run's changed lines from the owned files (and past receipts) before it
 * exceeds the effective token budget.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { effectiveBudget } from './runtime-settings.ts';

export type ContractLintCode = 'CHECK_UNFILTERED' | 'CONTRACT_OVER_BUDGET';

export interface ContractLintFinding {
  code: ContractLintCode;
  /** 'error' only under jev.mode enforce; validate then refuses the contract. */
  severity: 'warning' | 'error';
  message: string;
  /** A concrete fix: the filtered check command, or the code/test split. */
  suggestion?: string;
  /** Index into checks for CHECK_UNFILTERED. */
  checkIndex?: number;
}

export interface ContractLintOptions {
  /** Directory whose past `.delivery/<id>/<stamp>/result.json` receipts give tokens per changed line. */
  deliveryDir?: string;
}

const DEFAULT_TOKENS_PER_CHANGED_LINE = 7000;
const MIN_RECEIPT_CHANGED_LINES = 50;
const NEW_FILE_CHANGED_LINES = 150;
const MAX_SMALL_TEST_SCOPE = 3;
const RECEIPT_MAX_DEPTH = 6;

const TEST_FILE_PATTERN = /(?:^|\/)(?:[^/]*\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)|test_[^/]*\.py|[^/]*_test\.py|[^/]*Tests?\.(?:cs|fs|vb)|tests?\/[^/]+\.(?:cs|fs|vb|py|rs)|__tests__\/[^/]+)$/i;

type LintTarget = Record<string, any>;

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizePath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function pathEntry(value: unknown): string {
  if (typeof value === 'string') return normalizePath(value);
  if (isRecord(value) && typeof value.path === 'string') return normalizePath(value.path);
  return '';
}

/** Owned or allowed paths, in either the contract shape (`scope.owned`) or the
 * plan-deliverable shape (`owned_files`). Unknown entries are ignored. */
function scopedPaths(t: LintTarget): string[] {
  const candidates = [
    t?.scope?.owned,
    t?.scope?.allowed,
    t?.scope?.allowedFiles,
    t?.owned_files,
    t?.ownedFiles,
    t?.allowed_files,
    t?.allowedFiles,
  ];
  const out: string[] = [];
  for (const candidate of candidates) {
    for (const entry of asArray(candidate)) {
      const path = pathEntry(entry);
      if (path && !out.includes(path)) out.push(path);
    }
  }
  return out;
}

function isTestFile(path: string): boolean {
  return TEST_FILE_PATTERN.test(normalizePath(path));
}

function testFilesOf(paths: string[]): string[] {
  return paths.filter(isTestFile);
}

function severityFor(t: LintTarget): 'warning' | 'error' {
  return t?.jev?.mode === 'enforce' ? 'error' : 'warning';
}

function tokenize(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of value) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function checkArgv(check: any): string[] {
  return [...tokenize(text(check?.command)), ...asArray(check?.args).map((arg) => text(arg))];
}

function commandName(value: string): string {
  return basename(normalizePath(value)).toLowerCase();
}

function commandStart(argv: string[]): number {
  let i = 0;
  while (i < argv.length) {
    const name = commandName(argv[i]);
    if (name === 'env') {
      i += 1;
      while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) i += 1;
      continue;
    }
    if (name === 'timeout') {
      i += 2;
      continue;
    }
    if (name === 'nice') {
      i += 1;
      while (i < argv.length && argv[i].startsWith('-')) i += 1;
      continue;
    }
    if (name === 'exec') {
      i += 1;
      continue;
    }
    break;
  }
  return Math.min(i, argv.length);
}

function optionPresent(args: string[], names: readonly string[]): boolean {
  return args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

function positionalArgs(args: string[], valueOptions: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && valueOptions.includes(arg)) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

const JEST_VALUE_OPTIONS = [
  '-t', '--testNamePattern', '--testPathPattern', '--runTestsByPath', '--config', '--rootDir',
  '--maxWorkers', '--minWorkers', '--testTimeout', '--testPathIgnorePatterns', '--collectCoverageFrom',
  '--coverageDirectory', '--reporters', '--selectProjects', '--outputFile', '--transform', '--moduleNameMapper',
];
const JEST_FILTERS = ['-t', '--testNamePattern', '--testPathPattern', '--runTestsByPath'];
const VITEST_VALUE_OPTIONS = [
  '-t', '--testNamePattern', '--testPathPattern', '--config', '--root', '--dir', '--maxWorkers',
  '--minWorkers', '--testTimeout', '--hookTimeout', '--sequence', '--reporter', '--outputFile',
  '--project', '--environment', '--pool', '--include', '--exclude',
];
const VITEST_FILTERS = ['-t', '--testNamePattern', '--testPathPattern'];
const PYTEST_VALUE_OPTIONS = [
  '-k', '-m', '--keyword', '--markers', '-c', '--rootdir', '--ignore', '--deselect', '--maxfail',
  '--tb', '--capture', '-o', '--override-ini', '-p', '--plugin', '--junitxml', '--log-file', '--durations',
];
const PYTEST_FILTERS = ['-k', '-m', '--keyword', '--markers', '--deselect'];
const NODE_TEST_VALUE_OPTIONS = [
  '--test-reporter', '--test-reporter-destination', '--test-name-pattern', '--test-skip-pattern',
  '--test-concurrency', '--test-timeout', '--conditions', '--import', '--loader',
  '--require', '--env-file', '--experimental-loader',
];

function dotnetClass(file: string): string {
  return basename(normalizePath(file)).replace(/\.(?:cs|fs|vb)$/i, '');
}

function dotnetFilter(files: string[]): string {
  return files.map((file) => `FullyQualifiedName~${dotnetClass(file)}`).join('|');
}

function analyzeUnfiltered(argv: string[], cwd: string, depth = 0): { label: string; suggestion: (files: string[]) => string } | null {
  if (depth > 2) return null;
  const start = commandStart(argv);
  if (start >= argv.length) return null;
  const name = commandName(argv[start]);
  let command = start;
  let launcher: string[] = [];
  let tool = name;
  let args = argv.slice(start + 1);

  if (['npx', 'pnpx', 'bunx'].includes(name)) {
    launcher = [argv[start]];
    let i = start + 1;
    while (i < argv.length && argv[i].startsWith('-')) i += 1;
    if (i >= argv.length) return null;
    command = i;
    tool = commandName(argv[i]);
    args = argv.slice(i + 1);
  } else if (name === 'pnpm' && ['exec', 'dlx'].includes(commandName(argv[start + 1] ?? ''))) {
    launcher = argv.slice(start, start + 2);
    command = start + 2;
    if (command >= argv.length) return null;
    tool = commandName(argv[command]);
    args = argv.slice(command + 1);
  } else if (name === 'yarn' && commandName(argv[start + 1] ?? '') === 'exec') {
    launcher = argv.slice(start, start + 2);
    command = start + 2;
    if (command >= argv.length) return null;
    tool = commandName(argv[command]);
    args = argv.slice(command + 1);
  }

  if (tool === 'node' || tool === 'nodejs') {
    const testIndex = args.indexOf('--test');
    if (testIndex === -1) return null;
    const after = args.slice(testIndex + 1);
    const files = positionalArgs(after, NODE_TEST_VALUE_OPTIONS);
    if (files.length > 0) return null;
    return {
      label: 'node --test without a file',
      suggestion: (testFiles) => ['node', '--test', ...testFiles].join(' '),
    };
  }

  if (tool === 'jest' || tool === 'jest-cli') {
    if (optionPresent(args, JEST_FILTERS)) return null;
    if (positionalArgs(args, JEST_VALUE_OPTIONS).length > 0) return null;
    return {
      label: 'jest without a path or name filter',
      suggestion: (testFiles) => [...launcher, 'jest', ...testFiles].join(' '),
    };
  }

  if (tool === 'vitest') {
    if (optionPresent(args, VITEST_FILTERS)) return null;
    const subcommand = args[0] === 'run' || args[0] === 'watch' || args[0] === 'dev' ? args[0] : '';
    const rest = subcommand ? args.slice(1) : args;
    if (positionalArgs(rest, VITEST_VALUE_OPTIONS).length > 0) return null;
    return {
      label: 'vitest without a path or name filter',
      suggestion: (testFiles) => [...launcher, 'vitest', ...(subcommand ? [subcommand] : []), ...testFiles].join(' '),
    };
  }

  if (tool === 'pytest' || tool === 'py.test' || (['python', 'python3'].includes(tool) && args[0] === '-m' && args[1] === 'pytest')) {
    const pytestArgs = ['python', 'python3'].includes(tool) ? args.slice(2) : args;
    const commandTokens = ['python', 'python3'].includes(tool) ? [argv[command], '-m', 'pytest'] : [argv[command]];
    if (optionPresent(pytestArgs, PYTEST_FILTERS)) return null;
    if (positionalArgs(pytestArgs, PYTEST_VALUE_OPTIONS).length > 0) return null;
    return {
      label: 'pytest without a path or keyword filter',
      suggestion: (testFiles) => [...launcher, ...commandTokens, ...testFiles].join(' '),
    };
  }

  if (tool === 'dotnet' && commandName(args[0] ?? '') === 'test') {
    if (optionPresent(args, ['--filter'])) return null;
    const base = argv.slice(command);
    return {
      label: 'dotnet test without --filter',
      suggestion: (testFiles) => `${base.join(' ')} --filter "${dotnetFilter(testFiles)}"`,
    };
  }

  if (tool === 'npm' && (args[0] === 'test' || (args[0] === 'run' && args[1] === 'test'))) {
    const script = packageTestScript(cwd);
    if (!script) return null;
    const nested = analyzeUnfiltered(tokenize(script), cwd, depth + 1);
    if (!nested) return null;
    return {
      label: `npm test script "${script}"`,
      suggestion: (testFiles) => `npm test -- ${testFiles.join(' ')}`,
    };
  }

  return null;
}

function packageTestScript(cwd: string): string {
  try {
    const packageJson = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const script = packageJson?.scripts?.test;
    return typeof script === 'string' ? script.trim() : '';
  } catch {
    return '';
  }
}

function checkUnfiltered(t: LintTarget): ContractLintFinding[] {
  const testFiles = testFilesOf(scopedPaths(t));
  if (testFiles.length > MAX_SMALL_TEST_SCOPE) return [];
  const cwd = resolve(text(t?.cwd) || '.');
  const findings: ContractLintFinding[] = [];
  asArray(t?.checks).forEach((check, index) => {
    const analysis = analyzeUnfiltered(checkArgv(check), cwd);
    if (!analysis) return;
    const command = checkArgv(check).join(' ');
    findings.push({
      code: 'CHECK_UNFILTERED',
      severity: severityFor(t),
      checkIndex: index,
      message: `check ${index} runs ${analysis.label} ("${command}") while the contract names ${testFiles.length} test file(s); filter it to the tests this contract changes`,
      ...(testFiles.length > 0 ? { suggestion: analysis.suggestion(testFiles) } : {}),
    });
  });
  return findings;
}

function lineCount(path: string): number {
  const value = readFileSync(path, 'utf8');
  if (value === '') return 0;
  const newlines = (value.match(/\n/g) ?? []).length;
  return newlines + (value.endsWith('\n') ? 0 : 1);
}

function estimateChangedLines(t: LintTarget): { lines: number; code: string[]; tests: string[] } {
  const paths = scopedPaths(t);
  const code = paths.filter((path) => !isTestFile(path));
  const tests = paths.filter(isTestFile);
  const explicit = finite(t?.estimate?.changedLines);
  if (explicit !== null && explicit >= 0) return { lines: explicit, code, tests };
  const cwd = resolve(text(t?.cwd) || '.');
  let lines = 0;
  for (const path of paths) {
    const absolute = resolve(cwd, path);
    try {
      if (statSync(absolute).isFile()) lines += lineCount(absolute) * 0.5;
      else lines += NEW_FILE_CHANGED_LINES;
    } catch {
      lines += NEW_FILE_CHANGED_LINES;
    }
  }
  return { lines, code, tests };
}

function receiptsUnder(root: string, depth = 0): string[] {
  if (depth > RECEIPT_MAX_DEPTH) return [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...receiptsUnder(full, depth + 1));
    else if (entry.isFile() && entry.name === 'result.json') out.push(full);
  }
  return out;
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function sumLineFields(value: any): number | null {
  let sum = 0;
  let found = false;
  for (const key of ['changedLines', 'linesChanged', 'additions', 'insertions', 'added', 'deletions', 'deleted']) {
    const number = finite(value?.[key]);
    if (number !== null && number >= 0) {
      sum += number;
      found = true;
    }
  }
  return found ? sum : null;
}

function diffLineCount(value: string): number {
  let count = 0;
  for (const line of value.split(/\r?\n/)) {
    if ((line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))) count += 1;
  }
  return count;
}

function statLineCount(value: string): number {
  let count = 0;
  for (const match of value.matchAll(/(\d+) insertions?\(\+\)/g)) count += Number(match[1]);
  for (const match of value.matchAll(/(\d+) deletions?\(-\)/g)) count += Number(match[1]);
  return count;
}

function evidenceChangedLines(evidence: any): number | null {
  if (!isRecord(evidence)) return null;
  for (const key of ['changedLines', 'linesChanged', 'changedLineCount', 'totalChangedLines']) {
    const number = finite(evidence[key]);
    if (number !== null && number >= 0) return number;
  }
  for (const key of ['changedFiles', 'runChangedFiles']) {
    const value = evidence[key];
    const number = finite(value);
    if (number !== null && number >= 0) return number;
    if (Array.isArray(value)) {
      if (value.length === 0) return 0;
      let sum = 0;
      let counted = false;
      for (const entry of value) {
        const entryLines = isRecord(entry) ? sumLineFields(entry) : null;
        if (entryLines !== null) {
          sum += entryLines;
          counted = true;
        } else if (isRecord(entry) && typeof entry.diff === 'string') {
          sum += diffLineCount(entry.diff);
          counted = true;
        }
      }
      return counted ? sum : value.length;
    }
  }
  if (typeof evidence.stat === 'string') {
    const count = statLineCount(evidence.stat);
    if (count > 0) return count;
  }
  if (typeof evidence.diff === 'string') {
    const count = diffLineCount(evidence.diff);
    if (count > 0) return count;
  }
  return null;
}

function receiptUsage(result: any): number | null {
  const usage = result?.receipt?.usage ?? result?.usage;
  if (!isRecord(usage)) return null;
  const total = finite(usage.totalTokens);
  if (total !== null && total > 0) return total;
  let sum = 0;
  let found = false;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    const number = finite(usage[key]);
    if (number !== null && number >= 0) {
      sum += number;
      found = true;
    }
  }
  return found && sum > 0 ? sum : null;
}

function receiptChangedLines(result: any, resultPath: string): number | null {
  const direct = evidenceChangedLines(result?.evidence);
  if (direct !== null) return direct;
  const artifact = result?.evidence?.artifact;
  if (typeof artifact === 'string' && artifact.trim()) {
    const evidencePath = resolve(dirname(resultPath), artifact);
    const evidence = readJson(evidencePath);
    const fromArtifact = evidenceChangedLines(evidence);
    if (fromArtifact !== null) return fromArtifact;
  }
  const fromResult = evidenceChangedLines(result);
  return fromResult;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function tokensPerChangedLine(deliveryDir: unknown): number {
  if (typeof deliveryDir !== 'string' || !deliveryDir.trim()) return DEFAULT_TOKENS_PER_CHANGED_LINE;
  const ratios: number[] = [];
  for (const resultPath of receiptsUnder(resolve(deliveryDir))) {
    const result = readJson(resultPath);
    if (!result) continue;
    const changedLines = receiptChangedLines(result, resultPath);
    const usage = receiptUsage(result);
    if (changedLines === null || changedLines < MIN_RECEIPT_CHANGED_LINES || usage === null) continue;
    ratios.push(usage / changedLines);
  }
  return ratios.length > 0 ? median(ratios) : DEFAULT_TOKENS_PER_CHANGED_LINE;
}

function splitSuggestion(code: string[], tests: string[]): string {
  const parts = ['Split the contract into a code contract and a test contract before running it'];
  if (code.length > 0 || tests.length > 0) {
    const codeFiles = code.length > 0 ? code.join(', ') : 'no code files';
    const testFiles = tests.length > 0 ? tests.join(', ') : 'no test files';
    parts.push(`code: ${codeFiles}; test: ${testFiles}`);
  }
  return parts.join('; ');
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function checkOverBudget(t: LintTarget, opts: ContractLintOptions): ContractLintFinding[] {
  const { lines, code, tests } = estimateChangedLines(t);
  if (!(lines > 0)) return [];
  const tokens = tokensPerChangedLine(opts.deliveryDir);
  const estimatedTokens = lines * tokens;
  const workflow = typeof t?.workflow === 'string' ? t.workflow : '';
  const budget = effectiveBudget(workflow, isRecord(t?.budget) ? t.budget : undefined);
  const max = finite(budget.maxTotalTokens);
  if (max === null || estimatedTokens <= max) return [];
  return [{
    code: 'CONTRACT_OVER_BUDGET',
    severity: severityFor(t),
    message: `estimated ${formatNumber(lines)} changed lines at ${formatNumber(tokens)} tokens per changed line (~${formatNumber(estimatedTokens)} tokens) exceeds the effective budget of ${formatNumber(max)} tokens`,
    suggestion: splitSuggestion(code, tests),
  }];
}

export function contractLint(t: any, opts: ContractLintOptions = {}): ContractLintFinding[] {
  return [...checkUnfiltered(t), ...checkOverBudget(t, opts)];
}
