import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiraAdapter } from './tickets-jira.ts';

const BASE = 'https://jira.example.test';
const CONFIG = { baseUrl: BASE, project: 'WID' };
const ENV = { JIRA_EMAIL: 'user@example.test', JIRA_API_TOKEN: 'super-secret-token' };

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface FetchCall {
  url: string;
  init: FetchInit;
}

interface FakeResponse {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

interface FakeFetch {
  fetch: (url: string, init: FetchInit) => Promise<FakeResponse>;
  calls: FetchCall[];
}

function jsonResponse(status: number, body: unknown): FakeResponse {
  return {
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function fakeFetch(...responses: FakeResponse[]): FakeFetch {
  const calls: FetchCall[] = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      return responses[Math.min(calls.length - 1, responses.length - 1)];
    },
  };
}

const description = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Widget context.' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance' }] },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '[ ] widgets stay fixed' }] }],
        },
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '[x] tests cover the fix' }] }],
        },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Notes' }] },
    {
      type: 'orderedList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ship it' }] }],
        },
      ],
    },
  ],
};

const flatBody = [
  'Widget context.',
  '',
  '## Acceptance',
  '',
  '- [ ] widgets stay fixed',
  '- [x] tests cover the fix',
  '',
  '## Notes',
  '',
  '1. ship it',
].join('\n');

const issue = {
  id: '10001',
  key: 'WID-1',
  self: `${BASE}/rest/api/3/issue/10001`,
  fields: {
    summary: 'Fix the widget',
    description,
    labels: ['bug', 'ready'],
    updated: '2026-11-14T12:00:00.000+0000',
  },
};

const searchBody = { issues: [issue], isLast: true };

// --- list ------------------------------------------------------------------

test('list uses GET on the Jira search endpoint', async () => {
  const jira = fakeFetch(jsonResponse(200, searchBody));
  await createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).list();
  assert.equal(`${jira.calls[0].init.method} ${new URL(jira.calls[0].url).pathname}`, 'GET /rest/api/3/search/jql');
});

test('list requests open tickets with the project JQL', async () => {
  const jira = fakeFetch(jsonResponse(200, searchBody));
  await createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).list();
  assert.equal(new URL(jira.calls[0].url).searchParams.get('jql'), 'project=WID AND statusCategory != Done');
});

test('list requests the summary, description, labels and updated fields', async () => {
  const jira = fakeFetch(jsonResponse(200, searchBody));
  await createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).list();
  assert.equal(new URL(jira.calls[0].url).searchParams.get('fields'), 'summary,description,labels,updated');
});

test('list sends an HTTP Basic Authorization header from the environment credentials', async () => {
  const jira = fakeFetch(jsonResponse(200, searchBody));
  await createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).list();
  const header = jira.calls[0].init.headers?.Authorization ?? '';
  assert.equal(Buffer.from(header.replace(/^Basic /, ''), 'base64').toString('utf8'), 'user@example.test:super-secret-token');
});

test('list maps a search response into tickets', async () => {
  const jira = fakeFetch(jsonResponse(200, searchBody));
  const tickets = await createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).list();
  assert.deepEqual(tickets, [{
    id: 'WID-1',
    url: `${BASE}/browse/WID-1`,
    title: 'Fix the widget',
    body: flatBody,
    labels: ['bug', 'ready'],
    acceptance: ['widgets stay fixed', 'tests cover the fix'],
    updatedAt: '2026-11-14T12:00:00.000+0000',
  }]);
});

// --- get -------------------------------------------------------------------

test('get uses GET on the issue endpoint', async () => {
  const jira = fakeFetch(jsonResponse(200, issue));
  await createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).get('WID-1');
  assert.equal(`${jira.calls[0].init.method} ${new URL(jira.calls[0].url).pathname}`, 'GET /rest/api/3/issue/WID-1');
});

test('get uses the issue key as the ticket id', async () => {
  const jira = fakeFetch(jsonResponse(200, issue));
  const ticket = await createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).get('WID-1');
  assert.equal(ticket.id, 'WID-1');
});

test('get builds the browse URL from the configured base URL', async () => {
  const jira = fakeFetch(jsonResponse(200, issue));
  const ticket = await createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).get('WID-1');
  assert.equal(ticket.url, `${BASE}/browse/WID-1`);
});

test('get carries the Jira updated timestamp', async () => {
  const jira = fakeFetch(jsonResponse(200, issue));
  const ticket = await createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).get('WID-1');
  assert.equal(ticket.updatedAt, '2026-11-14T12:00:00.000+0000');
});

test('get flattens an ADF description into plain text', async () => {
  const jira = fakeFetch(jsonResponse(200, issue));
  const ticket = await createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).get('WID-1');
  assert.equal(ticket.body, flatBody);
});

test('get extracts acceptance from ADF checkbox list items', async () => {
  const jira = fakeFetch(jsonResponse(200, issue));
  const ticket = await createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).get('WID-1');
  assert.deepEqual(ticket.acceptance, ['widgets stay fixed', 'tests cover the fix']);
});

// --- comment ---------------------------------------------------------------

test('comment posts to the issue comment endpoint', async () => {
  const jira = fakeFetch(jsonResponse(201, { id: '10002' }));
  await createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).comment?.('WID-1', 'A comment');
  assert.equal(`${jira.calls[0].init.method} ${new URL(jira.calls[0].url).pathname}`, 'POST /rest/api/3/issue/WID-1/comment');
});

test('comment sends the text as an ADF document', async () => {
  const jira = fakeFetch(jsonResponse(201, { id: '10002' }));
  await createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).comment?.('WID-1', 'A comment');
  assert.deepEqual(JSON.parse(jira.calls[0].init.body ?? ''), {
    body: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A comment' }] }],
    },
  });
});

test('comment returns the new comment id', async () => {
  const jira = fakeFetch(jsonResponse(201, { id: '10002' }));
  const result = await createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).comment?.('WID-1', 'A comment');
  assert.equal(result?.id, '10002');
});

// --- updateComment ---------------------------------------------------------

test('updateComment puts to the comment endpoint', async () => {
  const jira = fakeFetch(jsonResponse(200, { id: '10002' }));
  await createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).updateComment?.('WID-1', '10002', 'Updated');
  assert.equal(`${jira.calls[0].init.method} ${new URL(jira.calls[0].url).pathname}`, 'PUT /rest/api/3/issue/WID-1/comment/10002');
});

test('updateComment sends the replacement text as an ADF document', async () => {
  const jira = fakeFetch(jsonResponse(200, { id: '10002' }));
  await createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).updateComment?.('WID-1', '10002', 'Updated');
  assert.deepEqual(JSON.parse(jira.calls[0].init.body ?? ''), {
    body: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Updated' }] }],
    },
  });
});

// --- label -----------------------------------------------------------------

test('label puts to the issue endpoint', async () => {
  const jira = fakeFetch(jsonResponse(204, {}));
  await createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).label?.('WID-1', 'ready');
  assert.equal(`${jira.calls[0].init.method} ${new URL(jira.calls[0].url).pathname}`, 'PUT /rest/api/3/issue/WID-1');
});

test('label sends the add label update operation', async () => {
  const jira = fakeFetch(jsonResponse(204, {}));
  await createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).label?.('WID-1', 'ready');
  assert.deepEqual(JSON.parse(jira.calls[0].init.body ?? ''), { update: { labels: [{ add: 'ready' }] } });
});

// --- credentials and errors ------------------------------------------------

test('createJiraAdapter names JIRA_EMAIL when it is missing', () => {
  const jira = fakeFetch(jsonResponse(200, searchBody));
  assert.throws(() => createJiraAdapter(CONFIG, { fetch: jira.fetch, env: { JIRA_API_TOKEN: 'token' } }), /JIRA_EMAIL/);
});

test('createJiraAdapter names JIRA_API_TOKEN when it is missing', () => {
  const jira = fakeFetch(jsonResponse(200, searchBody));
  assert.throws(() => createJiraAdapter(CONFIG, { fetch: jira.fetch, env: { JIRA_EMAIL: 'user@example.test' } }), /JIRA_API_TOKEN/);
});

test('get rejects when Jira responds with a non-2xx status', async () => {
  const jira = fakeFetch(jsonResponse(404, { errorMessages: ['Issue does not exist'] }));
  await assert.rejects(createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).get('WID-1'), /404/);
});

test('a request error never includes a credential value', async () => {
  const jira = fakeFetch(jsonResponse(401, { errorMessages: ['Unauthorized'] }));
  await assert.rejects(
    createJiraAdapter(CONFIG, { fetch: jira.fetch, env: ENV }).get('WID-1'),
    (error: Error) => !/user@example\.test|super-secret-token/.test(error.message),
  );
});
