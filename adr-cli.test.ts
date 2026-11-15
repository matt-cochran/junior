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
import { spawnSync } from 'node:child_process';
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

function gitProject(t: {after(fn: () => void): void}): {root: string; git: (args: string[]) => any} {
  const root = seed(t);
  const git = (args: string[]) => spawnSync('git', args, {cwd: root, encoding: 'utf8'});
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.test']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  return {root, git};
}

function recordingClassifier(choice: string): {classify: GateClassifier; questions: () => string} {
  const seen: string[] = [];
  return {
    questions: () => seen.join('\n'),
    classify: async ({questions}) => {
      seen.push(...Object.values(questions).map((question) => question.instructions));
      return {answers: Object.fromEntries(Object.keys(questions).map((id) => [id, {type: 'choice', choice, confidence: 0.95}]))};
    },
  };
}

test('an implementation check diffs against the merge base so committed and uncommitted changes are both judged', async (t) => {
  const {root, git} = gitProject(t);
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(join(root, 'src', 'app.ts'), 'export const base = true;\n');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']).stdout.trim();
  writeFileSync(join(root, 'src', 'app.ts'), 'export const committedMarker = true;\n');
  git(['add', '.']);
  git(['commit', '-qm', 'committed change']);
  writeFileSync(join(root, 'src', 'app.ts'), 'export const committedMarker = true;\nexport const uncommittedMarker = true;\n');
  const recorder = recordingClassifier('conforms');
  await runAdrCli(['check', '--stage', 'implementation', '--base', base], {
    cwd: root,
    classify: recorder.classify,
    stdout: capture().stdout,
  });
  assert.match(recorder.questions(), /committedMarker[\s\S]*uncommittedMarker/);
});

test('an implementation check with --result diffs against HEAD in the recorded worktree', async (t) => {
  const {root} = gitProject(t);
  const worktree = project(t);
  const git = (args: string[]) => spawnSync('git', args, {cwd: worktree, encoding: 'utf8'});
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.test']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(worktree, 'src'), {recursive: true});
  writeFileSync(join(worktree, 'src', 'app.ts'), 'export const base = true;\n');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  writeFileSync(join(worktree, 'src', 'app.ts'), 'export const resultWorktreeMarker = true;\n');
  const result = join(root, 'result.json');
  writeFileSync(result, JSON.stringify({
    isolation: {mode: 'worktree', worktree},
    executionCwd: worktree,
    evidence: {runChangedFiles: [{path: 'src/app.ts'}]},
  }));
  const recorder = recordingClassifier('conforms');
  await runAdrCli(['check', '--stage', 'implementation', '--result', result], {
    cwd: root,
    classify: recorder.classify,
    stdout: capture().stdout,
  });
  assert.match(recorder.questions(), /resultWorktreeMarker/);
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

function foreignProject(
  t: { after(fn: () => void): void },
  names: string[] = ['0002-queue.md'],
  tracked: string[] = ['src/app.ts'],
): string {
  const root = project(t);
  mkdirSync(join(root, 'docs', 'adr'), {recursive: true});
  for (const name of names) writeFileSync(join(root, 'docs', 'adr', name), FOREIGN.replace(/^# 2\./, `# ${name.slice(0, 4)}.`));
  writeFileSync(
    join(root, 'delivery.config.json'),
    JSON.stringify({adr: {dir: 'docs/adr', format: 'nygard', gate: 'enforce'}}, null, 2) + '\n',
  );
  for (const name of tracked) {
    mkdirSync(join(root, name, '..'), {recursive: true});
    writeFileSync(join(root, name), 'tracked\n');
  }
  const init = spawnSync('git', ['init', '-q'], {cwd: root, encoding: 'utf8'});
  if (init.status !== 0) throw new Error(init.stderr);
  const add = spawnSync('git', ['add', '.'], {cwd: root, encoding: 'utf8'});
  if (add.status !== 0) throw new Error(add.stderr);
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

const NYGARD_ADR = [
  '# 1. Use a queue',
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
  '## Consequences',
  '',
  'Work waits instead of failing.',
  '',
].join('\n');

function nygardLintProject(
  t: { after(fn: () => void): void },
  records: Array<{name: string; content: string}>,
): string {
  const root = project(t);
  mkdirSync(join(root, 'docs', 'adr'), {recursive: true});
  for (const record of records) writeFileSync(join(root, 'docs', 'adr', record.name), record.content);
  writeFileSync(
    join(root, 'delivery.config.json'),
    JSON.stringify(
      {adr: {dir: 'docs/adr', format: 'nygard', gate: 'enforce', filePattern: ADR_PREFIX_PATTERN}},
      null,
      2,
    ) + '\n',
  );
  return root;
}

test('lint exits 0 for a well-formed Nygard ADR- collection', async () => {
  const root = nygardLintProject(test, [{name: 'ADR-001-queue.md', content: NYGARD_ADR}]);
  const status = await runAdrCli(['lint'], {cwd: root, stdout: capture().stdout, stderr: () => {}});
  assert.equal(status, 0);
});

test('lint --json reports no error findings for a well-formed Nygard ADR- collection', async () => {
  const root = nygardLintProject(test, [{name: 'ADR-001-queue.md', content: NYGARD_ADR}]);
  const out = capture();
  await runAdrCli(['lint', '--json'], {cwd: root, stdout: out.stdout, stderr: () => {}});
  assert.equal(JSON.parse(out.text()).findings.filter((finding: {severity: string}) => finding.severity === 'error').length, 0);
});

test('lint reports a duplicate id across foreign records', async () => {
  const root = nygardLintProject(test, [
    {name: 'ADR-001-queue.md', content: NYGARD_ADR},
    {name: 'ADR-001-topics.md', content: NYGARD_ADR.replace('# 1. Use a queue', '# 1. Use topics')},
  ]);
  const out = capture();
  await runAdrCli(['lint', '--json'], {cwd: root, stdout: out.stdout, stderr: () => {}});
  assert.equal(JSON.parse(out.text()).findings.some((finding: {code: string}) => finding.code === 'duplicate-id'), true);
});

test('lint reports missing rules for an accepted foreign record with no Decision section', async () => {
  const root = nygardLintProject(test, [
    {
      name: 'ADR-002-empty.md',
      content: [
        '# 2. Leave it unspecified',
        '',
        'Status: Accepted',
        '',
        '## Context',
        '',
        'The team has not decided.',
        '',
        '## Consequences',
        '',
        'Nothing changes yet.',
        '',
      ].join('\n'),
    },
  ]);
  const out = capture();
  await runAdrCli(['lint', '--json'], {cwd: root, stdout: out.stdout, stderr: () => {}});
  assert.equal(
    JSON.parse(out.text()).findings.find((finding: {code: string}) => finding.code === 'missing-rules')?.adrId,
    'ADR-002',
  );
});

function scopeJudge(governed: readonly string[], confidence = 0.95): GateClassifier {
  return async ({questions}) => {
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(questions)) {
      const candidate = /^cell:(.+):governs$/.exec(id)?.[1] ?? '';
      answers[id] = {
        type: 'choice',
        choice: governed.includes(candidate) ? 'yes' : 'no',
        confidence,
      };
    }
    return {answers};
  };
}

test('scope writes a proposal file for a foreign ADR', async () => {
  const root = foreignProject(test);
  await runAdrCli(['scope'], {cwd: root, classify: scopeJudge(['src/**']), stdout: capture().stdout});
  assert.equal(existsSync(join(root, '.delivery', 'adr-proposals', '0002-front-matter.md')), true);
});

test('scope leaves the original foreign ADR byte-identical', async () => {
  const root = foreignProject(test);
  const path = join(root, 'docs', 'adr', '0002-queue.md');
  const before = readFileSync(path, 'utf8');
  await runAdrCli(['scope'], {cwd: root, classify: scopeJudge(['src/**']), stdout: capture().stdout});
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('scope turns a confident yes on src/** into the proposal applies_to', async () => {
  const root = foreignProject(test);
  const out = capture();
  await runAdrCli(['scope', '--json'], {cwd: root, classify: scopeJudge(['src/**']), stdout: out.stdout});
  assert.deepEqual(JSON.parse(out.text()).proposals[0].appliesTo, ['src/**']);
});

test('scope drops a nested yes under its kept parent glob', async () => {
  const root = foreignProject(test, ['0002-queue.md'], ['src/app.ts', 'src/nested/app.ts']);
  const out = capture();
  await runAdrCli(['scope', '--json'], {
    cwd: root,
    classify: scopeJudge(['src/**', 'src/nested/**']),
    stdout: out.stdout,
  });
  assert.deepEqual(JSON.parse(out.text()).proposals[0].appliesTo, ['src/**']);
});

test('scope does not use low-confidence judgments', async () => {
  const root = foreignProject(test);
  await runAdrCli(['scope'], {cwd: root, classify: scopeJudge(['src/**'], 0.5), stdout: capture().stdout});
  assert.equal(existsSync(join(root, '.delivery', 'adr-proposals', '0002-front-matter.md')), false);
});

test('scope skips an ADR with only no answers and reports its reason', async () => {
  const root = foreignProject(test);
  const out = capture();
  await runAdrCli(['scope', '--json'], {cwd: root, classify: scopeJudge([]), stdout: out.stdout});
  assert.equal(JSON.parse(out.text()).skipped[0].reason, 'no candidate path judged governed');
});

test('scope skips an ADR whose answers are all unknown and reports its reason', async () => {
  const root = foreignProject(test);
  const out = capture();
  await runAdrCli(['scope', '--json'], {cwd: root, classify: scopeJudge(['src/**'], 0.5), stdout: out.stdout});
  assert.equal(JSON.parse(out.text()).skipped[0].reason, 'Jev answers were unknown');
});

test('scope --adr limits the run to the named ADR', async () => {
  const root = foreignProject(test, ['0001-queue.md', '0002-queue.md']);
  await runAdrCli(['scope', '--adr', 'ADR-0001'], {cwd: root, classify: scopeJudge(['src/**']), stdout: capture().stdout});
  assert.equal(existsSync(join(root, '.delivery', 'adr-proposals', '0002-front-matter.md')), false);
});

test('scope --json reports the proposal path for an answered ADR', async () => {
  const root = foreignProject(test);
  const out = capture();
  await runAdrCli(['scope', '--json'], {cwd: root, classify: scopeJudge(['src/**']), stdout: out.stdout});
  assert.equal(JSON.parse(out.text()).proposals[0].path, '.delivery/adr-proposals/0002-front-matter.md');
});

test('scope --max-candidates passes the limit to candidate selection', async () => {
  const root = foreignProject(test, ['0002-queue.md'], ['a/app.ts', 'b/app.ts']);
  const out = capture();
  await runAdrCli(['scope', '--json', '--max-candidates', '1'], {
    cwd: root,
    classify: scopeJudge(['a/**', 'b/**']),
    stdout: out.stdout,
  });
  assert.deepEqual(JSON.parse(out.text()).proposals[0].appliesTo, ['a/**']);
});

test('scope prints one review line per answered ADR', async () => {
  const root = foreignProject(test);
  const out = capture();
  await runAdrCli(['scope'], {cwd: root, classify: scopeJudge(['src/**']), stdout: out.stdout});
  assert.match(out.text(), /ADR-0002 -> \.delivery\/adr-proposals\/0002-front-matter\.md \(applies_to: 1 paths, rules: 1\)/);
});

function scopeSequence(samples: ReadonlyArray<readonly string[]>, confidence = 0.95): GateClassifier {
  let call = 0;
  return async ({questions}) => {
    const governed = samples[call] ?? [];
    call += 1;
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(questions)) {
      const candidate = /^cell:(.+):governs$/.exec(id)?.[1] ?? '';
      answers[id] = {
        type: 'choice',
        choice: governed.includes(candidate) ? 'yes' : 'no',
        confidence,
      };
    }
    return {answers};
  };
}

test('scope keeps a path that a majority of samples judge governed', async () => {
  const root = foreignProject(test);
  const out = capture();
  await runAdrCli(['scope', '--json'], {
    cwd: root,
    classify: scopeSequence([['src/**'], [], ['src/**']]),
    stdout: out.stdout,
  });
  assert.deepEqual(JSON.parse(out.text()).proposals[0].appliesTo, ['src/**']);
});

test('scope reports a minority path as uncertain with its vote count', async () => {
  const root = foreignProject(test, ['0002-queue.md'], ['src/app.ts', 'docs/guide.md']);
  const out = capture();
  await runAdrCli(['scope', '--json'], {
    cwd: root,
    classify: scopeSequence([['src/**', 'docs/**'], ['src/**'], ['src/**']]),
    stdout: out.stdout,
  });
  assert.deepEqual(JSON.parse(out.text()).proposals[0].uncertain, [{path: 'docs/**', votes: 1, samples: 3}]);
});

test('scope leaves a minority path out of applies_to', async () => {
  const root = foreignProject(test, ['0002-queue.md'], ['src/app.ts', 'docs/guide.md']);
  const out = capture();
  await runAdrCli(['scope', '--json'], {
    cwd: root,
    classify: scopeSequence([['src/**', 'docs/**'], ['src/**'], ['src/**']]),
    stdout: out.stdout,
  });
  assert.deepEqual(JSON.parse(out.text()).proposals[0].appliesTo, ['src/**']);
});

test('scope includes the vote count for every path that got a vote', async () => {
  const root = foreignProject(test, ['0002-queue.md'], ['src/app.ts', 'docs/guide.md']);
  const out = capture();
  await runAdrCli(['scope', '--json'], {
    cwd: root,
    classify: scopeSequence([['src/**', 'docs/**'], ['src/**'], ['src/**']]),
    stdout: out.stdout,
  });
  assert.deepEqual(JSON.parse(out.text()).proposals[0].votes, {'src/**': 3, 'docs/**': 1});
});

test('scope text output appends its uncertain path count', async () => {
  const root = foreignProject(test, ['0002-queue.md'], ['src/app.ts', 'docs/guide.md']);
  const out = capture();
  await runAdrCli(['scope'], {
    cwd: root,
    classify: scopeSequence([['src/**', 'docs/**'], ['src/**'], ['src/**']]),
    stdout: out.stdout,
  });
  assert.match(out.text(), /, uncertain: 1/);
});

test('scope --samples 1 takes one judgment per candidate', async () => {
  const root = foreignProject(test);
  const out = capture();
  let calls = 0;
  const classifier: GateClassifier = async ({questions}) => {
    calls += 1;
    const choice = calls === 1 ? 'yes' : 'no';
    return {
      answers: Object.fromEntries(
        Object.keys(questions).map((id) => [id, {type: 'choice', choice, confidence: 0.95}]),
      ),
    };
  };
  await runAdrCli(['scope', '--json', '--samples', '1'], {cwd: root, classify: classifier, stdout: out.stdout});
  assert.deepEqual(JSON.parse(out.text()).proposals[0].appliesTo, ['src/**']);
});

test('scope rejects an even --samples value', async () => {
  const root = foreignProject(test);
  const out = capture();
  await runAdrCli(['scope', '--samples', '2'], {cwd: root, classify: scopeJudge(['src/**']), stdout: out.stdout});
  assert.match(out.text(), /--samples must be an odd number from 1 to 7/);
});

test('scope rejects an out-of-range --samples value', async () => {
  const root = foreignProject(test);
  const out = capture();
  await runAdrCli(['scope', '--samples', '9'], {cwd: root, classify: scopeJudge(['src/**']), stdout: out.stdout});
  assert.match(out.text(), /--samples must be an odd number from 1 to 7/);
});

test('scope skips an ADR with only uncertain paths and reports them', async () => {
  const root = foreignProject(test);
  const out = capture();
  await runAdrCli(['scope', '--json'], {
    cwd: root,
    classify: scopeSequence([['src/**'], [], []]),
    stdout: out.stdout,
  });
  assert.deepEqual(JSON.parse(out.text()).skipped[0], {
    adrId: 'ADR-0002',
    reason: 'only uncertain paths (1)',
    uncertain: [{path: 'src/**', votes: 1, samples: 3}],
  });
});

test('scope replays an identical sample sequence to an identical proposal file', async () => {
  const root = foreignProject(test);
  const samples = [['src/**'], [], ['src/**']];
  await runAdrCli(['scope'], {cwd: root, classify: scopeSequence(samples), stdout: capture().stdout});
  const first = readFileSync(join(root, '.delivery', 'adr-proposals', '0002-front-matter.md'), 'utf8');
  await runAdrCli(['scope'], {cwd: root, classify: scopeSequence(samples), stdout: capture().stdout});
  assert.equal(
    readFileSync(join(root, '.delivery', 'adr-proposals', '0002-front-matter.md'), 'utf8'),
    first,
  );
});

function scoping(confidence = 0.95): GateClassifier {
  return async ({questions}) => {
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(questions)) {
      answers[id] = {type: 'choice', choice: 'complete', confidence};
    }
    return {answers};
  };
}

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
