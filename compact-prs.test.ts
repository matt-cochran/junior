// Behavioral tests for the open-pull-request compact section.
//
// Every scenario stubs `runGh`, so no test calls the real gh or the network.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPullRequests, prLines, type RunGh } from './compact-prs.ts';

function workspace(t: any): string {
  const dir = mkdtempSync(join(tmpdir(), 'junior-compact-prs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gh(stdout: string, code: number | null = 0): Awaited<ReturnType<RunGh>> {
  return { code, stdout, stderr: '' };
}

const ONE_PR = JSON.stringify([
  { number: 12, title: 'Fix x', baseRefName: 'dev', headRefName: 'feat/x', isDraft: false, url: 'u' },
]);

test('one open pull request in the current repository reports an ok section', async (t) => {
  const section = await openPullRequests({ cwd: workspace(t), runGh: async () => gh(ONE_PR) });
  assert.equal(section.status, 'ok');
});

test('an open pull request renders as one compact line', async (t) => {
  const section = await openPullRequests({ cwd: workspace(t), runGh: async () => gh(ONE_PR) });
  assert.deepEqual(prLines(section), ['- .#12 Fix x (feat/x -> dev)']);
});

test('a draft pull request is marked in its compact line', async (t) => {
  const stdout = JSON.stringify([
    { number: 3, title: 'WIP', baseRefName: 'main', headRefName: 'wip', isDraft: true, url: 'u' },
  ]);
  const section = await openPullRequests({ cwd: workspace(t), runGh: async () => gh(stdout) });
  assert.deepEqual(prLines(section), ['- .#3 WIP (wip -> main) [draft]']);
});

test('a configured compact repo is queried with an explicit --repo argument', async (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, 'delivery.config.json'), JSON.stringify({ compact: { repos: ['praxec/triz'] } }));
  const calls: string[][] = [];
  await openPullRequests({
    cwd: dir,
    runGh: async (args) => {
      calls.push(args);
      return gh('[]');
    },
  });
  assert.ok(calls.some((args) => args.includes('--repo') && args.includes('praxec/triz')));
});

test('a config without compact repos queries only the current repository', async (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, 'delivery.config.json'), JSON.stringify({ provider: 'openrouter' }));
  const calls: string[][] = [];
  await openPullRequests({
    cwd: dir,
    runGh: async (args) => {
      calls.push(args);
      return gh('[]');
    },
  });
  assert.equal(calls.filter((args) => args.includes('--repo')).length, 0);
});

test('bad config JSON does not add a repository', async (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, 'delivery.config.json'), '{not json');
  const calls: string[][] = [];
  await openPullRequests({
    cwd: dir,
    runGh: async (args) => {
      calls.push(args);
      return gh('[]');
    },
  });
  assert.equal(calls.filter((args) => args.includes('--repo')).length, 0);
});

test('every repository failing reports the section as unavailable', async (t) => {
  const section = await openPullRequests({
    cwd: workspace(t),
    runGh: async () => ({ code: null, stdout: '', stderr: '', error: 'spawn gh ENOENT' }),
  });
  assert.equal(section.status, 'unavailable');
});

test('every repository failing yields no pull requests', async (t) => {
  const section = await openPullRequests({
    cwd: workspace(t),
    runGh: async () => ({ code: null, stdout: '', stderr: '', error: 'spawn gh ENOENT' }),
  });
  assert.deepEqual(section.prs, []);
});

test('a failed repository contributes its error as an unavailable line', async (t) => {
  const section = await openPullRequests({
    cwd: workspace(t),
    runGh: async () => gh('', 1),
  });
  assert.deepEqual(prLines(section), ['- unavailable: .: gh exited 1']);
});

test('a failed extra repository still leaves a successful current query ok', async (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, 'delivery.config.json'), JSON.stringify({ compact: { repos: ['owner/name'] } }));
  const section = await openPullRequests({
    cwd: dir,
    runGh: async (args) => (args.includes('--repo') ? gh('', 1) : gh('[]')),
  });
  assert.equal(section.status, 'ok');
});

test('no open pull requests anywhere reports the section as none', async (t) => {
  const section = await openPullRequests({ cwd: workspace(t), runGh: async () => gh('[]') });
  assert.equal(section.status, 'none');
});

test('the none section renders a single none line', async (t) => {
  const section = await openPullRequests({ cwd: workspace(t), runGh: async () => gh('[]') });
  assert.deepEqual(prLines(section), ['- none']);
});

test('a runGh rejection is reported as unavailable instead of escaping', async (t) => {
  const section = await openPullRequests({
    cwd: workspace(t),
    runGh: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(section.status, 'unavailable');
});

test('an unparsable gh response is reported as unavailable', async (t) => {
  const section = await openPullRequests({ cwd: workspace(t), runGh: async () => gh('not json') });
  assert.equal(section.status, 'unavailable');
});

test(
  'the default runGh returns unavailable when gh exceeds the timeout',
  { timeout: 2000 },
  async (t) => {
    const dir = workspace(t);
    const fakeGh = join(dir, 'gh');
    writeFileSync(fakeGh, '#!/bin/sh\n/bin/sleep 5\n');
    chmodSync(fakeGh, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = dir;
    t.after(() => {
      process.env.PATH = oldPath;
    });
    const section = await openPullRequests({ cwd: dir, timeoutMs: 200 });
    assert.equal(section.status, 'unavailable');
  },
);
