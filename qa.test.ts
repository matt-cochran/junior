// ---------------------------------------------------------------------------
// D12 bounded fresh-session QA review workflow (offline; no paid calls).
//
// These tests exercise the public behavior of the `qa` workflow through the
// existing worker/run/handoff/CLI interfaces. Every test is atomic with exactly
// one behavioral assertion.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validate, run, buildPrompt, WORKFLOW_PROMPT_BLOCKS, WORKFLOW_TEMPLATE_IDS, WORKFLOW_DESCRIPTIONS } from './worker.ts';
import { withHandoffIsolation } from './junior.ts';
import { compactHandoff } from './handoff.ts';

const SESSION = '123e4567-e89b-12d3-a456-426614174000';
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } };
const assistant = () => ({ type: 'message_end', message: { role: 'assistant', provider: 'openrouter', model: 'm', usage, stopReason: 'stop' } });
const okStream = () => [{ type: 'session', id: SESSION }, assistant(), { type: 'agent_settled' }].map((r) => JSON.stringify(r)).join('\n') + '\n';
const tmp = () => mkdtempSync(join(tmpdir(), 'junior-qa-'));

/** A valid prior result.json plus its prompt/evidence/transcript artifacts. */
const prior = () => {
 const dir = tmp();
 const artifactDir = join(dir, '.delivery', 'prior', '1');
 mkdirSync(artifactDir, { recursive: true });
 writeFileSync(join(artifactDir, 'prompt.txt'), 'Task contract (JSON):\n' + JSON.stringify({ id: 'prior', deliverable: 'Add widget', acceptance: ['Widget works'], workflow: 'test_first' }));
 writeFileSync(join(artifactDir, 'evidence.json'), JSON.stringify({
  runChangedFiles: [{ path: 'src/widget.ts', status: 'M' }],
  after: { diff: '--- a/src/widget.ts\n+++ b/src/widget.ts\n+export const widget=1;\n', stat: 'src/widget.ts | 1 +', truncated: false },
 }));
 writeFileSync(join(artifactDir, 'events.jsonl'), 'TRANSCRIPT-ONLY-MARKER\n');
 writeFileSync(join(artifactDir, 'result.json'), JSON.stringify({
  id: 'prior', status: 'ready_for_review', artifactDir, workflow: { selected: 'test_first' },
  checks: [{ command: 'node', args: ['--test', 'widget.test.ts'], exitCode: 0 }],
  evidence: { runChangedFiles: [{ path: 'src/widget.ts' }] },
 }));
 return { dir, artifactDir, resultPath: join(artifactDir, 'result.json') };
};

const qaTask = (cwd: string, reviewFrom?: string, extra: any = {}) => ({
 id: 'qa-1', deliverable: 'Review the widget deliverable', cwd, provider: 'openrouter', model: 'm',
 workflow: 'qa', acceptance: ['Review completed'],
 checks: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
 ...(reviewFrom ? { reviewFrom } : {}), ...extra,
});

const spawnOk = (capture: any, onPrompt?: (p: string) => void) => (_command: string, args: string[]) => {
 capture.command = _command; capture.args = args;
 const prompt = args[args.length - 1];
 if (onPrompt) onPrompt(prompt);
 return { status: 0, stdout: okStream(), stderr: '' };
};
const writeReport = (prompt: string) => {
 const m = /exact artifact path: ([^\n]+)/.exec(prompt);
 if (m) writeFileSync(m[1], '# QA report\n');
};

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const gitRepo = () => {
 const dir = tmp();
 git(dir, ['init', '-q']); git(dir, ['config', 'user.email', 't@t']); git(dir, ['config', 'user.name', 't']);
 writeFileSync(join(dir, '.gitignore'), '.delivery/\n');
 writeFileSync(join(dir, 'widget.ts'), 'export const widget=0;\n');
 git(dir, ['add', '.']); git(dir, ['commit', '-qm', 'base']);
 return dir;
};

const classifyChoice = (choice: string): any => async ({ questions }: any) => {
 const isPre = Object.prototype.hasOwnProperty.call(questions, 'contract_clear');
 return {
  stopReason: 'stop', provider: 'openrouter', model: 'typesafe/jev-1.13',
  usage: { input: 1, output: 1, totalTokens: 2 },
  answers: isPre
   ? { contract_clear: { type: 'bool', probability: 0.95 }, blocking_assumptions: { type: 'bool', probability: 0.05 }, workflow: { type: 'choice', choice, confidence: 0.95 } }
   : { AC1: { type: 'bool', probability: 0.95 } },
 };
};

// --- registration and validation -------------------------------------------

test('qa is an accepted explicit workflow', () => {
 assert.doesNotThrow(() => validate(qaTask(tmp(), '/tmp/prior/result.json')));
});
test('qa template id is fixed', () => assert.equal(WORKFLOW_TEMPLATE_IDS.qa, 'delivery-qa-1'));
test('qa is offered to the Jev workflow choice', () => assert.ok(WORKFLOW_DESCRIPTIONS.qa.length > 0));
test('qa report block names the deterministic report path', () => {
 assert.ok(buildPrompt(qaTask(tmp(), '/tmp/p/result.json'), 'qa', null, '/tmp/art/analysis-report.md').includes('/tmp/art/analysis-report.md'));
});
test('qa report block marks a missing report as needs_review', () => {
 assert.match(buildPrompt(qaTask(tmp(), '/tmp/p/result.json'), 'qa', null, '/tmp/art/analysis-report.md'), /needs_review until that file exists/);
});
test('qa report block states review completion is not acceptance', () => {
 assert.match(buildPrompt(qaTask(tmp(), '/tmp/p/result.json'), 'qa', null, '/tmp/art/analysis-report.md'), /review completion is not deliverable acceptance/);
});

// --- prompt contract --------------------------------------------------------

test('qa prompt forbids production edits', () => assert.match(WORKFLOW_PROMPT_BLOCKS.qa, /Do not modify production code/));
test('qa prompt forbids commits and pushes', () => assert.match(WORKFLOW_PROMPT_BLOCKS.qa, /commit, push/));
test('qa prompt compares acceptance with tracked staged and untracked changes', () => assert.match(WORKFLOW_PROMPT_BLOCKS.qa, /tracked, staged and untracked/));
test('qa prompt requires missing behavioral coverage and regressions', () => assert.match(WORKFLOW_PROMPT_BLOCKS.qa, /missing behavioral coverage and regressions/));
test('qa prompt requires severity and file references', () => assert.match(WORKFLOW_PROMPT_BLOCKS.qa, /severity/));
test('qa prompt requires affected acceptance IDs', () => assert.match(WORKFLOW_PROMPT_BLOCKS.qa, /acceptance ID/));
test('qa prompt requires uncertainties and recommended checks', () => assert.match(WORKFLOW_PROMPT_BLOCKS.qa, /recommended check/));
test('qa prompt forbids nested workers or paid calls', () => assert.match(WORKFLOW_PROMPT_BLOCKS.qa, /nested workers or paid calls/));
test('qa prompt scope is instruction not sandbox', () => assert.match(WORKFLOW_PROMPT_BLOCKS.qa, /not a sandbox guarantee/));

// --- CLI isolation defaults -------------------------------------------------

test('qa handoff defaults to no isolation', () => assert.equal(withHandoffIsolation({ workflow: 'qa' }).isolation, 'none'));
test('qa handoff preserves an explicit worktree isolation', () => assert.equal(withHandoffIsolation({ workflow: 'qa', isolation: 'worktree' }).isolation, 'worktree'));
test('non-qa handoff still defaults to worktree isolation', () => assert.equal(withHandoffIsolation({ workflow: 'test_first' }).isolation, 'worktree'));

// --- pre-paid rejection -----------------------------------------------------

test('qa without reviewFrom is rejected', async () => {
 const r = await run(qaTask(tmp()), false, { spawnPi: () => { throw Error('worker must not start'); } });
 assert.match(r.workerError, /reviewFrom is required/);
});
test('qa rejects resumeFrom before paid calls', async () => {
 const r = await run(qaTask(tmp(), '/tmp/p/result.json', { resumeFrom: '/tmp/p/result.json' }), false, { spawnPi: () => { throw Error('worker must not start'); } });
 assert.match(r.workerError, /resumeFrom is not allowed/);
});
test('qa rejects repairFrom before paid calls', async () => {
 const r = await run(qaTask(tmp(), '/tmp/p/result.json', { repairFrom: '/tmp/p/result.json' }), false, { spawnPi: () => { throw Error('worker must not start'); } });
 assert.match(r.workerError, /repairFrom is not allowed/);
});
test('qa rejects worktree isolation before paid calls', async () => {
 const r = await run(qaTask(tmp(), '/tmp/p/result.json', { isolation: 'worktree' }), false, { spawnPi: () => { throw Error('worker must not start'); } });
 assert.match(r.workerError, /worktree/);
});
test('qa rejects an unreadable reviewFrom', async () => {
 const r = await run(qaTask(tmp(), '/tmp/does-not-exist/result.json'), false, { spawnPi: () => { throw Error('worker must not start'); } });
 assert.match(r.workerError, /reviewFrom rejected/);
});
test('qa rejects a reviewFrom result without artifactDir', async () => {
 const dir = tmp();
 writeFileSync(join(dir, 'result.json'), JSON.stringify({ id: 'prior', status: 'ready_for_review' }));
 const r = await run(qaTask(dir, join(dir, 'result.json')), false, { spawnPi: () => { throw Error('worker must not start'); } });
 assert.match(r.workerError, /artifactDir/);
});

// --- fresh session and grounded context ------------------------------------

test('qa runs a fresh Pi session without --session', async () => {
 const p = prior();
 const capture: any = {};
 await run(qaTask(p.dir, p.resultPath), false, { spawnPi: spawnOk(capture) });
 assert.ok(!capture.args.includes('--session'));
});
test('qa prompt includes the original contract evidence', async () => {
 const p = prior();
 const capture: any = {};
 await run(qaTask(p.dir, p.resultPath), false, { spawnPi: spawnOk(capture) });
 assert.ok(capture.args[capture.args.length - 1].includes('Widget works'));
});
test('qa prompt includes the complete change evidence', async () => {
 const p = prior();
 const capture: any = {};
 await run(qaTask(p.dir, p.resultPath), false, { spawnPi: spawnOk(capture) });
 assert.ok(capture.args[capture.args.length - 1].includes('export const widget=1'));
});
test('qa prompt never loads the full transcript', async () => {
 const p = prior();
 const capture: any = {};
 await run(qaTask(p.dir, p.resultPath), false, { spawnPi: spawnOk(capture) });
 assert.ok(!capture.args[capture.args.length - 1].includes('TRANSCRIPT-ONLY-MARKER'));
});
test('qa writes a review context artifact', async () => {
 const p = prior();
 const r = await run(qaTask(p.dir, p.resultPath), false, { spawnPi: spawnOk({}) });
 assert.ok(existsSync(join(r.artifactDir, 'review-context.md')));
});
test('qa result records the review subject', async () => {
 const p = prior();
 const r = await run(qaTask(p.dir, p.resultPath), false, { spawnPi: spawnOk({}) });
 assert.equal(r.review.priorResult.id, 'prior');
});

// --- report lifecycle and production-change flag ---------------------------

test('qa without its report is needs_review', async () => {
 const p = prior();
 const r = await run(qaTask(p.dir, p.resultPath), false, { spawnPi: spawnOk({}) });
 assert.equal(r.status, 'needs_review');
});
test('qa with its report is ready_for_review', async () => {
 const p = prior();
 const r = await run(qaTask(p.dir, p.resultPath), false, { spawnPi: spawnOk({}, writeReport) });
 assert.equal(r.status, 'ready_for_review');
});
test('qa with unexpected production changes is needs_review', async () => {
 const dir = gitRepo();
 const artifactDir = join(dir, '.delivery', 'prior', '1');
 mkdirSync(artifactDir, { recursive: true });
 writeFileSync(join(artifactDir, 'prompt.txt'), 'Task contract (JSON):\n' + JSON.stringify({ id: 'prior', deliverable: 'Add widget', acceptance: ['Widget works'] }));
 writeFileSync(join(artifactDir, 'evidence.json'), JSON.stringify({ runChangedFiles: [] }));
 writeFileSync(join(artifactDir, 'result.json'), JSON.stringify({ id: 'prior', status: 'ready_for_review', artifactDir, workflow: { selected: 'test_first' }, checks: [] }));
 const spawn = spawnOk({}, (prompt) => { writeReport(prompt); writeFileSync(join(dir, 'widget.ts'), 'export const widget=2;\n'); });
 const r = await run(qaTask(dir, join(artifactDir, 'result.json')), false, { spawnPi: spawn });
 assert.equal(r.status, 'needs_review');
});
test('qa compact handoff exposes the review subject', async () => {
 const p = prior();
 const r = await run(qaTask(p.dir, p.resultPath), false, { spawnPi: spawnOk({}) });
 assert.equal(compactHandoff(r).review.priorResult.id, 'prior');
});

// --- auto authorization boundary -------------------------------------------

test('auto cannot select qa without reviewFrom', async () => {
 const r = await run({ ...qaTask(tmp()), workflow: 'auto', jev: { mode: 'shadow' } }, true, { classify: classifyChoice('qa') });
 assert.equal(r.workflow.selected, 'checks_first');
});
test('auto may select qa when reviewFrom is present', async () => {
 const p = prior();
 const r = await run({ ...qaTask(p.dir, p.resultPath), workflow: 'auto', jev: { mode: 'shadow' } }, true, { classify: classifyChoice('qa') });
 assert.equal(r.workflow.selected, 'qa');
});

// --- CLI --------------------------------------------------------------------

test('junior qa CLI runs in place without worktree isolation', () => {
 const p = prior();
 const cfg = tmp();
 const taskPath = join(cfg, 'task.json');
 writeFileSync(taskPath, JSON.stringify(qaTask(p.dir, p.resultPath)));
 const r = spawnSync(process.execPath, ['junior.ts', 'qa', taskPath, '--mock'], { encoding: 'utf8' });
 const out = JSON.parse(r.stdout);
 assert.equal(out.execution.isolation, 'none');
});
