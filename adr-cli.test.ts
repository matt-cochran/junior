// Behavioral tests for the `junior adr` command surface (issues #220, #221, #223).
//
// Every scenario is offline: a temporary project supplies configuration and
// ADRs, git and ticket adapters are fakes, and the classifier answers with a
// fixed verdict. Each test drives one public outcome and asserts exactly one
// observable fact.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAdrConfig } from './adr-config.ts';
import { readLedger } from './adr-ledger.ts';
import type { GateClassifier } from './worker.ts';
import type { Ticket, TicketAdapter, TicketQuery } from './tickets.ts';
import { runAdrCli } from './adr-cli.ts';

const ADR = [
  '---',
  'id: ADR-0001',
  'title: Keep the source tree honest',
  'status: accepted',
  'date: 2026-01-01',
  'supersedes: []',
  "applies_to: ['src/**']",
  'rules:',
  '  - id: R1',
  '    text: Source changes stay within the approved tree.',
  '---',
  '',
  '## Context',
  '',
  'Context.',
  '',
  '## Decision',
  '',
  'Decision.',
  '',
  '## Consequences',
  '',
  'Consequences.',
  '',
].join('\n');

function project(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'junior-adr-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function seed(t: { after(fn: () => void): void }): string {
  const root = project(t);
  mkdirSync(join(root, 'docs', 'adr'), {recursive: true});
  writeFileSync(join(root, 'docs', 'adr', '0001-src.md'), ADR);
  writeFileSync(
    join(root, 'delivery.config.json'),
    JSON.stringify({adr: {dir: 'docs/adr', format: 'junior', gate: 'enforce'}}, null, 2) + '\n',
  );
  return root;
}

function contradicting(): GateClassifier {
  return async ({questions}) => ({
    answers: Object.fromEntries(
      Object.keys(questions).map((id) => [id, {type: 'choice', choice: 'contradicts', confidence: 0.95}]),
    ),
  });
}

function capture(): {stdout: (s: string) => void; text: () => string} {
  let text = '';
  return {
    stdout: (s) => {
      text += s;
    },
    text: () => text,
  };
}

function fakeGit(files: string[] = ['src/changed.ts']) {
  return (args: string[]) => {
    if (args[0] === 'diff') return {status: 0, stdout: files.join('\n') + (files.length ? '\n' : '')};
    if (args[0] === 'status') return {status: 0, stdout: ''};
    if (args[0] === 'config') return {status: 0, stdout: 'Test User\n'};
    return {status: 0, stdout: ''};
  };
}

async function designCheck(root: string): Promise<number> {
  const input = join(root, 'brief.md');
  writeFileSync(input, 'Change src/widget.ts to keep the tree honest.\n');
  return runAdrCli(['check', '--stage', 'design', '--input', input], {
    cwd: root,
    classify: contradicting(),
    git: fakeGit(),
  });
}

function latest(root: string): any {
  return JSON.parse(readFileSync(join(root, '.delivery', 'adr-check', 'latest.json'), 'utf8'));
}

test('an unknown adr subcommand names check-tickets in its usage', async () => {
  const root = project(test);
  const out = capture();
  await runAdrCli(['wat'], {cwd: root, stdout: out.stdout});
  assert.match(out.text(), /check-tickets/);
});

test('init without --yes leaves the project untouched', async () => {
  const root = project(test);
  await runAdrCli(['init'], {cwd: root, stdout: capture().stdout});
  assert.deepEqual(readdirSync(root), []);
});

test('init --yes records the proposed adr config', async () => {
  const root = project(test);
  await runAdrCli(['init', '--yes'], {cwd: root, stdout: capture().stdout});
  assert.equal(readAdrConfig(root)?.dir, 'docs/adr');
});

test('a contradicting design check exits 3', async () => {
  const root = seed(test);
  assert.equal(await designCheck(root), 3);
});

test('a design check stores the first finding as F1', async () => {
  const root = seed(test);
  await designCheck(root);
  assert.equal(latest(root).findings[0].id, 'F1');
});

test('an implementation check reads changed files from fake git', async () => {
  const root = seed(test);
  await runAdrCli(['check', '--stage', 'implementation'], {
    cwd: root,
    classify: contradicting(),
    git: fakeGit(['src/from-git.ts']),
  });
  assert.equal(latest(root).findings[0].target, 'src/from-git.ts');
});

test('a ticket draft check stores a ticket-stage finding', async () => {
  const root = seed(test);
  const draft = join(root, 'draft.md');
  writeFileSync(draft, 'Fix the widget\n\n## Acceptance\n\n- [ ] the widget stays fixed\n');
  await runAdrCli(['check', '--stage', 'ticket', '--draft', draft], {
    cwd: root,
    classify: contradicting(),
    git: fakeGit(),
  });
  assert.equal(latest(root).findings[0].target, 'ticket:draft');
});

test('decide --override --reason appends one ledger line', async () => {
  const root = seed(test);
  await designCheck(root);
  await runAdrCli(['decide', 'F1', '--override', '--reason', 'accepted risk'], {
    cwd: root,
    classify: contradicting(),
    git: fakeGit(),
    stdout: capture().stdout,
  });
  assert.equal(readLedger(root).length, 1);
});

test('decide --override without --reason exits 1', async () => {
  const root = seed(test);
  await designCheck(root);
  const status = await runAdrCli(['decide', 'F1', '--override'], {
    cwd: root,
    git: fakeGit(),
    stdout: capture().stdout,
  });
  assert.equal(status, 1);
});

test('decide with an unknown finding id exits 1', async () => {
  const root = seed(test);
  await designCheck(root);
  const status = await runAdrCli(['decide', 'F9', '--override', '--reason', 'accepted risk'], {
    cwd: root,
    git: fakeGit(),
    stdout: capture().stdout,
  });
  assert.equal(status, 1);
});

test('check-tickets without --post does not comment on the adapter', async () => {
  const root = seed(test);
  let comments = 0;
  const ticket: Ticket = {
    id: '42',
    url: 'https://example.test/issues/42',
    title: 'Fix the widget',
    body: 'Make the widget safe.',
    labels: [],
    acceptance: [],
    updatedAt: '2026-11-14T12:00:00Z',
  };
  const adapter: TicketAdapter = {
    async list(_query?: TicketQuery) {
      return [ticket];
    },
    async get() {
      return ticket;
    },
    async comment() {
      comments += 1;
      return {id: '1'};
    },
  };
  await runAdrCli(['check-tickets'], {
    cwd: root,
    adapter,
    classify: contradicting(),
    git: fakeGit(),
    stdout: capture().stdout,
  });
  assert.equal(comments, 0);
});

test('lint delegates to the existing adr lint command', async () => {
  const root = seed(test);
  const status = await runAdrCli(['lint'], {cwd: root, stdout: capture().stdout});
  assert.equal(status, 0);
});

test('init --yes with --record-decision writes the config file', async () => {
  const root = project(test);
  await runAdrCli(['init', '--yes', '--record-decision'], {cwd: root, stdout: capture().stdout});
  assert.equal(existsSync(join(root, 'delivery.config.json')), true);
});

const ADR_PREFIX_PATTERN = '^ADR-(?<number>\\d+[a-z]?)-(?<slug>.+)\\.md$';

function withFilePattern(t: { after(fn: () => void): void }): string {
  const root = project(t);
  mkdirSync(join(root, 'docs', 'adr'), {recursive: true});
  writeFileSync(join(root, 'docs', 'adr', 'ADR-001-src.md'), ADR.replace('id: ADR-0001', 'id: ADR-001'));
  writeFileSync(
    join(root, 'delivery.config.json'),
    JSON.stringify({adr: {dir: 'docs/adr', format: 'junior', gate: 'enforce', filePattern: ADR_PREFIX_PATTERN}}, null, 2) + '\n',
  );
  return root;
}

// --- scope: draft front matter for foreign ADRs (ADR 0018 R9) --------------

const FOREIGN = [
  '# 2. Use a queue',
  '',
  'Status: Accepted',
  '',
  '## Context',
  '',
  'Work arrives in bursts.',
  '',
  '## Decision',
  '',
  'We will put work on one durable queue.',
  '',
].join('\n');

function foreignProject(t: { after(fn: () => void): void }, names: string[] = ['0002-queue.md']): string {
  const root = project(t);
  mkdirSync(join(root, 'docs', 'adr'), {recursive: true});
  for (const name of names) writeFileSync(join(root, 'docs', 'adr', name), FOREIGN.replace(/^# 2\./, `# ${name.slice(0, 4)}.`));
  writeFileSync(
    join(root, 'delivery.config.json'),
    JSON.stringify({adr: {dir: 'docs/adr', format: 'nygard', gate: 'enforce'}}, null, 2) + '\n',
  );
  return root;
}

test('a design check loads ADR-named records through adr.filePattern', async () => {
  const root = withFilePattern(test);
  await designCheck(root);
  assert.equal(latest(root).findings[0].adrId, 'ADR-001');
});

test('a check exits 2 when Markdown files hold no parsed ADRs', async () => {
  const root = project(test);
  mkdirSync(join(root, 'docs', 'adr'), {recursive: true});
  writeFileSync(join(root, 'docs', 'adr', 'notes.md'), 'Project notes.\n');
  writeFileSync(
    join(root, 'delivery.config.json'),
    JSON.stringify({adr: {dir: 'docs/adr', format: 'junior', gate: 'enforce'}}, null, 2) + '\n',
  );
  assert.equal(await designCheck(root), 2);
});

test('a check --json includes the discovery for an unparsed ADR folder', async () => {
  const root = project(test);
  const out = capture();
  mkdirSync(join(root, 'docs', 'adr'), {recursive: true});
  writeFileSync(join(root, 'docs', 'adr', 'notes.md'), 'Project notes.\n');
  writeFileSync(
    join(root, 'delivery.config.json'),
    JSON.stringify({adr: {dir: 'docs/adr', format: 'junior', gate: 'enforce'}}, null, 2) + '\n',
  );
  const input = join(root, 'brief.md');
  writeFileSync(input, 'Change src/widget.ts.\n');
  await runAdrCli(['check', '--stage', 'design', '--input', input, '--json'], {
    cwd: root,
    classify: contradicting(),
    git: fakeGit(),
    stdout: out.stdout,
  });
  assert.equal(JSON.parse(out.text()).discovery.parsed, 0);
});

test('lint includes the discovery when Markdown files hold no ADRs', async () => {
  const root = project(test);
  const out = capture();
  mkdirSync(join(root, 'docs', 'adr'), {recursive: true});
  writeFileSync(join(root, 'docs', 'adr', 'notes.md'), 'Project notes.\n');
  writeFileSync(
    join(root, 'delivery.config.json'),
    JSON.stringify({adr: {dir: 'docs/adr', format: 'junior', gate: 'enforce'}}, null, 2) + '\n',
  );
  await runAdrCli(['lint'], {cwd: root, stdout: out.stdout, stderr: () => {}});
  assert.equal(JSON.parse(out.text()).discovery.markdownFiles, 1);
});

function scoping(confidence = 0.95): GateClassifier {
  return async ({questions}) => {
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(questions)) {
      answers[id] = id.endsWith(':applies_to')
        ? {type: 'choice', choice: 'complete', confidence, appliesTo: ['src/**']}
        : {type: 'choice', choice: 'complete', confidence, rules: [{id: 'R1', text: 'Use one durable queue.'}]};
    }
    return {answers};
  };
}

test('scope writes a proposal file for a foreign ADR', async () => {
  const root = foreignProject(test);
  await runAdrCli(['scope'], {cwd: root, classify: scoping(), stdout: capture().stdout});
  assert.equal(existsSync(join(root, '.delivery', 'adr-proposals', '0002-front-matter.md')), true);
});

test('scope leaves the original foreign ADR byte-identical', async () => {
  const root = foreignProject(test);
  const path = join(root, 'docs', 'adr', '0002-queue.md');
  const before = readFileSync(path, 'utf8');
  await runAdrCli(['scope'], {cwd: root, classify: scoping(), stdout: capture().stdout});
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('scope skips an unknown answer and writes no proposal file', async () => {
  const root = foreignProject(test);
  await runAdrCli(['scope'], {cwd: root, classify: scoping(0.5), stdout: capture().stdout});
  assert.equal(existsSync(join(root, '.delivery', 'adr-proposals', '0002-front-matter.md')), false);
});

test('scope --adr limits the run to the named ADR', async () => {
  const root = foreignProject(test, ['0001-queue.md', '0002-queue.md']);
  await runAdrCli(['scope', '--adr', 'ADR-0001'], {cwd: root, classify: scoping(), stdout: capture().stdout});
  assert.equal(existsSync(join(root, '.delivery', 'adr-proposals', '0002-front-matter.md')), false);
});

test('scope --json reports the proposal path for an answered ADR', async () => {
  const root = foreignProject(test);
  const out = capture();
  await runAdrCli(['scope', '--json'], {cwd: root, classify: scoping(), stdout: out.stdout});
  assert.equal(JSON.parse(out.text()).proposals[0].path, '.delivery/adr-proposals/0002-front-matter.md');
});

test('scope prints one review line per answered ADR', async () => {
  const root = foreignProject(test);
  const out = capture();
  await runAdrCli(['scope'], {cwd: root, classify: scoping(), stdout: out.stdout});
  assert.match(out.text(), /ADR-0002 -> \.delivery\/adr-proposals\/0002-front-matter\.md \(applies_to: 1 paths, rules: 1\)/);
});

test('an implementation check exits 2 when it checked nothing but skipped accepted ADRs', async () => {
  const root = foreignProject(test);
  const status = await runAdrCli(['check', '--stage', 'implementation'], {
    cwd: root,
    classify: scoping(),
    git: fakeGit(['src/changed.ts']),
    stdout: capture().stdout,
  });
  assert.equal(status, 2);
});

test('an inconclusive implementation check names junior adr scope on stderr', async () => {
  const root = foreignProject(test);
  let stderr = '';
  await runAdrCli(['check', '--stage', 'implementation'], {
    cwd: root,
    classify: scoping(),
    git: fakeGit(['src/changed.ts']),
    stdout: capture().stdout,
    stderr: (s) => {
      stderr += s;
    },
  });
  assert.match(stderr, /junior adr scope/);
});
