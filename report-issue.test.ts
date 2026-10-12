// ---------------------------------------------------------------------------
// Behavioral tests for `junior report-issue`.
//
// Every scenario drives the public library/CLI with an injected exec seam and
// temp directories only: no GitHub call, network request or real binary is
// touched. Each test asserts exactly one observable outcome.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPORT_TARGETS, buildDraft, reportIssue, redact, main } from './report-issue.ts';
import { initHop, saveHop } from './tools/tools.ts';

const HOME = '/home/manager';

type Call = { command: string; args: string[] };

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-report-'));
}

/** A fake world: the tool's `--version` output, open GitHub issues and the
 * URL `gh issue create` prints. The injected exec records every argv. */
function world(options: { version?: string; issues?: unknown[]; url?: string } = {}) {
  const calls: Call[] = [];
  const exec = (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      return { status: 0, stdout: JSON.stringify(options.issues ?? []) };
    }
    if (command === 'gh' && args[0] === 'issue' && args[1] === 'create') {
      return { status: 0, stdout: `${options.url ?? 'https://github.com/praxec/fmeca/issues/11'}\n` };
    }
    if (args[0] === '--version') return { status: 0, stdout: `${options.version ?? '9.9.9'}\n` };
    return { status: 0, stdout: '' };
  };
  return { exec, calls };
}

function deps(exec: ReturnType<typeof world>['exec']) {
  return { exec, home: HOME, stagingDir: workdir() };
}

async function runMain(argv: string[], exec: ReturnType<typeof world>['exec']) {
  const writes: string[] = [];
  const status = await main(argv, { ...deps(exec), write: (text: string) => writes.push(text) });
  return { status, stdout: writes.join('') };
}

function hopWithEvidence(dir: string, entries: Array<{ tool: string; note: string; snapshotId?: string }>): string {
  const hopPath = join(dir, 'hop.json');
  const hop = initHop(hopPath);
  entries.forEach((entry, index) => {
    hop.evidence.push({
      id: `ev_${index}`,
      revision: index + 1,
      tool: entry.tool as never,
      toolName: 'state.get',
      kind: 'read',
      status: 'ok',
      note: entry.note,
      ...(entry.snapshotId ? { snapshotId: entry.snapshotId } : {}),
      createdAt: '2024-01-01T00:00:00.000Z',
    });
  });
  saveHop(hopPath, hop);
  return hopPath;
}

// --- tool → upstream repository --------------------------------------------

test('report-issue maps each supported tool to its upstream repository', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(REPORT_TARGETS).map(([tool, target]) => [tool, target.repo])),
    {
      fmeca: 'praxec/fmeca',
      cpm: 'praxec/cpm-planner',
      crossmatrix: 'praxec/crossmatrix',
      jevitate: 'matt-cochran/jevitate',
      triz: 'matt-cochran/triz',
      junior: 'matt-cochran/junior',
    },
  );
});

// --- draft contents ---------------------------------------------------------

test('the draft environment reports the tool version from the inserted --version output', () => {
  const { exec } = world({ version: '3.4.5' });
  assert.match(buildDraft({ tool: 'cpm', title: 'Broken' }, deps(exec)).body, /3\.4\.5/);
});

test('a description read from --body-file is redacted in the draft', () => {
  const dir = workdir();
  const bodyFile = join(dir, 'body.md');
  writeFileSync(bodyFile, 'leaked sk-live-abc123 here');
  const { exec } = world();
  assert.equal(buildDraft({ tool: 'fmeca', title: 't', bodyFile }, deps(exec)).body.includes('sk-live-abc123'), false);
});

test('the draft shows the user home directory as ~', () => {
  const dir = workdir();
  const bodyFile = join(dir, 'body.md');
  writeFileSync(bodyFile, `see ${HOME}/project/file.ts`);
  const { exec } = world();
  assert.ok(buildDraft({ tool: 'fmeca', title: 't', bodyFile }, deps(exec)).body.includes('~/project/file.ts'));
});

// --- redaction patterns -----------------------------------------------------

test('redact replaces an sk- token with the marker', () => {
  assert.equal(redact('key sk-live-abc123', HOME), 'key [REDACTED]');
});

test('redact replaces a ghp_ token with the marker', () => {
  assert.equal(redact('token ghp_abcdef123456', HOME), 'token [REDACTED]');
});

test('redact replaces a gho_ token with the marker', () => {
  assert.equal(redact('token gho_abcdef123456', HOME), 'token [REDACTED]');
});

test('redact replaces a github_pat_ token with the marker', () => {
  assert.equal(redact('token github_pat_11ABCDEF', HOME), 'token [REDACTED]');
});

test('redact replaces a Bearer token with the marker', () => {
  assert.equal(redact('Authorization: Bearer abc.def', HOME), 'Authorization: [REDACTED]');
});

test('redact replaces a KEY/TOKEN/SECRET assignment with the marker', () => {
  assert.equal(redact('API_TOKEN=supersecret', HOME), '[REDACTED]');
});

// --- hop evidence -----------------------------------------------------------

test('with --hop the draft includes the latest evidence note for the tool', () => {
  const dir = workdir();
  const hopPath = hopWithEvidence(dir, [{ tool: 'fmeca', note: 'baseline recorded' }]);
  const { exec } = world();
  assert.match(buildDraft({ tool: 'fmeca', title: 't', hopPath }, deps(exec)).body, /baseline recorded/);
});

test('with --hop the draft includes only evidence for the requested tool', () => {
  const dir = workdir();
  const hopPath = hopWithEvidence(dir, [
    { tool: 'fmeca', note: 'fmeca-note' },
    { tool: 'cpm', note: 'cpm-note' },
  ]);
  const { exec } = world();
  assert.equal(buildDraft({ tool: 'fmeca', title: 't', hopPath }, deps(exec)).body.includes('cpm-note'), false);
});

test('with --hop the draft omits evidence snapshot identifiers', () => {
  const dir = workdir();
  const hopPath = hopWithEvidence(dir, [{ tool: 'fmeca', note: 'n', snapshotId: 'snap_secret_123' }]);
  const { exec } = world();
  assert.equal(buildDraft({ tool: 'fmeca', title: 't', hopPath }, deps(exec)).body.includes('snap_secret_123'), false);
});

test('with --hop the draft caps evidence at the last ten entries', () => {
  const dir = workdir();
  const entries = [
    { tool: 'fmeca', note: 'oldest-one' },
    { tool: 'fmeca', note: 'oldest-two' },
    ...Array.from({ length: 10 }, (_, i) => ({ tool: 'fmeca', note: `recent-${i + 1}` })),
  ];
  const hopPath = hopWithEvidence(dir, entries);
  const { exec } = world();
  assert.equal(buildDraft({ tool: 'fmeca', title: 't', hopPath }, deps(exec)).body.includes('oldest-one'), false);
});

test('with --hop the draft keeps the most recent evidence entry', () => {
  const dir = workdir();
  const entries = [
    { tool: 'fmeca', note: 'oldest-one' },
    ...Array.from({ length: 10 }, (_, i) => ({ tool: 'fmeca', note: `recent-${i + 1}` })),
  ];
  const hopPath = hopWithEvidence(dir, entries);
  const { exec } = world();
  assert.match(buildDraft({ tool: 'fmeca', title: 't', hopPath }, deps(exec)).body, /recent-10/);
});

// --- filing with gh ---------------------------------------------------------

test('report-issue without --file runs no gh command', async () => {
  const { exec, calls } = world();
  await runMain(['fmeca', '--title', 'Broken'], exec);
  assert.equal(calls.filter((call) => call.command === 'gh').length, 0);
});

test('report-issue without --file prints the exact gh issue create argv it would run', async () => {
  const { exec } = world();
  const { stdout } = await runMain(['fmeca', '--title', 'Broken'], exec);
  assert.deepEqual(JSON.parse(stdout).command.slice(0, 6), ['gh', 'issue', 'create', '--repo', 'praxec/fmeca', '--title']);
});

test('report-issue with --file checks open issues before creating', async () => {
  const { exec, calls } = world({ issues: [] });
  await runMain(['fmeca', '--title', 'Broken', '--file'], exec);
  assert.deepEqual(calls.filter((call) => call.command === 'gh').map((call) => call.args[1]), ['list', 'create']);
});

test('report-issue with --file does not create an issue when an open same-title issue exists', async () => {
  const { exec, calls } = world({ issues: [{ number: 5, title: 'Broken', url: 'https://github.com/praxec/fmeca/issues/5' }] });
  await runMain(['fmeca', '--title', 'Broken', '--file'], exec);
  assert.equal(calls.some((call) => call.command === 'gh' && call.args[1] === 'create'), false);
});

test('report-issue --file --force creates an issue despite a same-title open issue', async () => {
  const { exec, calls } = world({ issues: [{ number: 5, title: 'Broken', url: 'https://github.com/praxec/fmeca/issues/5' }] });
  await runMain(['fmeca', '--title', 'Broken', '--file', '--force'], exec);
  assert.ok(calls.some((call) => call.command === 'gh' && call.args[1] === 'create'));
});

test('report-issue with --file creates the issue with a staged body file', async () => {
  const { exec, calls } = world({ issues: [] });
  await runMain(['fmeca', '--title', 'Broken', '--file'], exec);
  assert.ok(calls.find((call) => call.command === 'gh' && call.args[1] === 'create')?.args.includes('--body-file'));
});

test('report-issue with --file prints the created issue URL', async () => {
  const { exec } = world({ issues: [], url: 'https://github.com/praxec/fmeca/issues/42' });
  const { stdout } = await runMain(['fmeca', '--title', 'Broken', '--file'], exec);
  assert.equal(stdout.trim(), 'https://github.com/praxec/fmeca/issues/42');
});

test('report-issue rejects an unknown tool', async () => {
  const { exec } = world();
  assert.equal((await runMain(['not-a-tool', '--title', 'x'], exec)).status, 1);
});