import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAcceptance, readTicketsConfig } from './tickets.ts';
import { createGithubAdapter } from './tickets-github.ts';

interface RunResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
}

interface RunCall {
  command: string;
  args: string[];
}

function project(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'junior-tickets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function config(root: string, value: unknown): void {
  writeFileSync(join(root, 'delivery.config.json'), JSON.stringify(value));
}

function fakeRun(result: RunResult | ((command: string, args: string[]) => RunResult)): {
  run: (command: string, args: string[]) => RunResult;
  calls: RunCall[];
} {
  const calls: RunCall[] = [];
  return {
    calls,
    run(command, args) {
      calls.push({ command, args });
      return typeof result === 'function' ? result(command, args) : result;
    },
  };
}

const ok = (stdout = ''): RunResult => ({ status: 0, stdout, stderr: '' });

const issue = {
  number: 42,
  url: 'https://github.com/acme/widgets/issues/42',
  title: 'Fix the widget',
  body: '## Acceptance criteria\n\n- [ ] widgets stay fixed\n- [x] tests cover the fix\n',
  labels: [{ name: 'bug' }, { name: 'ready' }],
  updatedAt: '2026-11-14T12:00:00Z',
};

// --- extractAcceptance ------------------------------------------------------

test('extractAcceptance reads an unchecked task-list item under an Acceptance heading', () => {
  assert.deepEqual(extractAcceptance('## Acceptance\n\n- [ ] widgets stay fixed\n'), ['widgets stay fixed']);
});

test('extractAcceptance reads a checked task-list item under an Acceptance heading', () => {
  assert.deepEqual(extractAcceptance('## Acceptance criteria\n\n- [x] tests cover the fix\n'), ['tests cover the fix']);
});

test('extractAcceptance ignores task-list items outside an Acceptance heading', () => {
  assert.deepEqual(extractAcceptance('## Tasks\n\n- [ ] build it\n\n## Notes\n\n- [ ] mention it\n'), []);
});

test('extractAcceptance stops at the next heading of the same level', () => {
  assert.deepEqual(extractAcceptance('## Acceptance\n\n- [ ] keep me\n\n## Notes\n\n- [ ] leave me\n'), ['keep me']);
});

test('extractAcceptance includes items under a nested heading', () => {
  assert.deepEqual(extractAcceptance('## Acceptance\n\n### Details\n\n- [ ] nested item\n'), ['nested item']);
});

// --- readTicketsConfig ------------------------------------------------------

test('readTicketsConfig defaults to GitHub with the repo from an ssh origin', (t) => {
  const root = project(t);
  const git = fakeRun(ok('git@github.com:acme/widgets.git\n'));
  assert.deepEqual(readTicketsConfig(root, { run: git.run }), { provider: 'github', repo: 'acme/widgets' });
});

test('readTicketsConfig parses the repo from an https origin', (t) => {
  const root = project(t);
  const git = fakeRun(ok('https://github.com/acme/widgets.git\n'));
  assert.equal(readTicketsConfig(root, { run: git.run }).repo, 'acme/widgets');
});

test('readTicketsConfig reads a complete tickets block', (t) => {
  const root = project(t);
  config(root, {
    tickets: {
      provider: 'jira',
      project: 'WID',
      baseUrl: 'https://jira.example.test',
      query: 'project = WID',
      redact: ['secret-[0-9]+'],
      writeBack: true,
    },
  });
  assert.deepEqual(readTicketsConfig(root), {
    provider: 'jira',
    project: 'WID',
    baseUrl: 'https://jira.example.test',
    query: 'project = WID',
    redact: ['secret-[0-9]+'],
    writeBack: true,
  });
});

test('readTicketsConfig rejects an unknown provider and names the field', (t) => {
  const root = project(t);
  config(root, { tickets: { provider: 'bitbucket' } });
  assert.throws(() => readTicketsConfig(root), /provider/);
});

test('readTicketsConfig rejects a non-string repo and names the field', (t) => {
  const root = project(t);
  config(root, { tickets: { provider: 'github', repo: 7 } });
  assert.throws(() => readTicketsConfig(root), /repo/);
});

test('readTicketsConfig rejects non-string redact entries and names the field', (t) => {
  const root = project(t);
  config(root, { tickets: { provider: 'github', repo: 'acme/widgets', redact: [7] } });
  assert.throws(() => readTicketsConfig(root), /redact/);
});

test('readTicketsConfig rejects a non-boolean writeBack and names the field', (t) => {
  const root = project(t);
  config(root, { tickets: { provider: 'github', repo: 'acme/widgets', writeBack: 'yes' } });
  assert.throws(() => readTicketsConfig(root), /writeBack/);
});

// --- createGithubAdapter: argv ---------------------------------------------

test('Github list calls gh issue list with state, limit and json fields', async () => {
  const gh = fakeRun(ok('[]'));
  await createGithubAdapter('acme/widgets', { run: gh.run }).list();
  assert.deepEqual(gh.calls[0], {
    command: 'gh',
    args: ['issue', 'list', '--repo', 'acme/widgets', '--state', 'open', '--limit', '30', '--json', 'number,url,title,body,labels,updatedAt'],
  });
});

test('Github list passes query state, labels and limit', async () => {
  const gh = fakeRun(ok('[]'));
  await createGithubAdapter('acme/widgets', { run: gh.run }).list({ state: 'all', labels: ['bug', 'ready'], limit: 5 });
  assert.deepEqual(gh.calls[0].args, [
    'issue', 'list', '--repo', 'acme/widgets', '--state', 'all', '--label', 'bug', '--label', 'ready', '--limit', '5', '--json', 'number,url,title,body,labels,updatedAt',
  ]);
});

test('Github get calls gh issue view with the issue number and json fields', async () => {
  const gh = fakeRun(ok(JSON.stringify(issue)));
  await createGithubAdapter('acme/widgets', { run: gh.run }).get('42');
  assert.deepEqual(gh.calls[0], {
    command: 'gh',
    args: ['issue', 'view', '42', '--repo', 'acme/widgets', '--json', 'number,url,title,body,labels,updatedAt'],
  });
});

test('Github comment calls gh issue comment with the issue number and body', async () => {
  const gh = fakeRun(ok('https://github.com/acme/widgets/issues/42#issuecomment-99\n'));
  await createGithubAdapter('acme/widgets', { run: gh.run }).comment?.('42', 'A comment');
  assert.deepEqual(gh.calls[0], {
    command: 'gh',
    args: ['issue', 'comment', '42', '--repo', 'acme/widgets', '--body', 'A comment'],
  });
});

test('Github updateComment calls gh api to patch the issue comment', async () => {
  const gh = fakeRun(ok('{}'));
  await createGithubAdapter('acme/widgets', { run: gh.run }).updateComment?.('42', '99', 'Updated');
  assert.deepEqual(gh.calls[0], {
    command: 'gh',
    args: ['api', '--method', 'PATCH', 'repos/acme/widgets/issues/comments/99', '--field', 'body=Updated'],
  });
});

test('Github label calls gh issue edit with add-label', async () => {
  const gh = fakeRun(ok(''));
  await createGithubAdapter('acme/widgets', { run: gh.run }).label?.('42', 'ready');
  assert.deepEqual(gh.calls[0], {
    command: 'gh',
    args: ['issue', 'edit', '42', '--repo', 'acme/widgets', '--add-label', 'ready'],
  });
});

// --- createGithubAdapter: results and errors -------------------------------

test('Github list normalizes issues into tickets with an id, label names and acceptance', async () => {
  const gh = fakeRun(ok(JSON.stringify([issue])));
  assert.deepEqual(await createGithubAdapter('acme/widgets', { run: gh.run }).list(), [{
    id: '42',
    url: 'https://github.com/acme/widgets/issues/42',
    title: 'Fix the widget',
    body: issue.body,
    labels: ['bug', 'ready'],
    acceptance: ['widgets stay fixed', 'tests cover the fix'],
    updatedAt: '2026-11-14T12:00:00Z',
  }]);
});

test('Github get normalizes the issue id to a string', async () => {
  const gh = fakeRun(ok(JSON.stringify(issue)));
  assert.equal((await createGithubAdapter('acme/widgets', { run: gh.run }).get('42')).id, '42');
});

test('Github comment returns the comment id from the gh URL', async () => {
  const gh = fakeRun(ok('https://github.com/acme/widgets/issues/42#issuecomment-99\n'));
  assert.deepEqual(await createGithubAdapter('acme/widgets', { run: gh.run }).comment?.('42', 'A comment'), { id: '99' });
});

test('Github list throws the stderr when gh exits non-zero', async () => {
  const gh = fakeRun({ status: 1, stdout: '', stderr: 'gh: authentication failed\n' });
  await assert.rejects(createGithubAdapter('acme/widgets', { run: gh.run }).list(), /authentication failed/);
});
