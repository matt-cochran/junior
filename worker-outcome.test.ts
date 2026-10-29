import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './worker-outcome.ts';
import { resolveExplicitApproval } from './worker-approval.ts';
import { buildPrompt } from './worker-prompt.ts';
import { mockReceipt } from './worker-receipt.ts';
import { collectGitEvidence } from './evidence.ts';

function outcomeState(over: any = {}): any {
  const cwd = over.cwd ?? mkdtempSync(join(tmpdir(), 'delivery-outcome-'));
  const dir = over.dir ?? join(cwd, '.delivery', 'task', 'stamp');
  mkdirSync(dir, { recursive: true });
  const before = collectGitEvidence(cwd);
  return {
    mock: true,
    deps: {},
    settings: { checkTimeoutMs: 120000 },
    sourceCwd: cwd,
    executionCwd: cwd,
    isolation: 'worktree',
    dir,
    heartbeat: { update() {}, setState() {}, snapshot() { return {}; } },
    emit() {},
    requested: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' },
    requestedSource: 'project',
    resume: undefined,
    prior: undefined,
    review: undefined,
    signal: undefined,
    mode: 'off',
    jev: undefined,
    decision: { selected: 'evaluate' },
    lineage: {},
    modelRoute: {},
    providerRouting: {},
    externalContext: undefined,
    piIsolation: undefined,
    worktreePath: undefined,
    reportWorkflow: false,
    reportPath: null,
    prepareRun: false,
    preparePlan: undefined,
    prepareHistory: [],
    isQa: false,
    isRepair: false,
    templates: {},
    classify: undefined,
    before,
    streamResult: undefined,
    workerStatus: 0,
    receipt: mockReceipt({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' }),
    receiptOk: true,
    legacyError: undefined,
    segments: [],
    checks: [],
    workerRan: true,
    stopped: false,
    deadlineAt: Date.now() + 60_000,
    deadlineDuringChecks: false,
    runStartedAt: Date.now(),
    stderr: '',
    t: { id: 'task', cwd },
    ...over,
  };
}

test('a credential-lock worker failure replaces the generic worker error with its summary', async () => {
  const summary = 'Pi could not create its credential lock; make the agent directory writable, then retry.';
  const state = outcomeState({
    workerStatus: 1,
    workerFailure: { category: 'credential_lock', summary, retryable: false, detail: 'EROFS auth.json.lock' },
  });
  const result = await finish(state);
  assert.equal(result.workerError, summary);
});

test('a credential-lock worker failure is retained on the result', async () => {
  const summary = 'Pi could not create its credential lock; make the agent directory writable, then retry.';
  const state = outcomeState({
    workerStatus: 1,
    workerFailure: { category: 'credential_lock', summary, retryable: false, detail: 'EROFS auth.json.lock' },
  });
  const result = await finish(state);
  assert.equal(result.workerFailure.category, 'credential_lock');
});

test('a resume fallback is copied onto the result', async () => {
  const resumeFallback = { reason: 'prior session unavailable', priorResult: '/prior/result.json', sessionId: 'abcdef12…' };
  const result = await finish(outcomeState({ resumeFallback }));
  assert.deepEqual(result.resumeFallback, resumeFallback);
});

test('the result records the configured per-check timeout', async () => {
  const result = await finish(outcomeState({ settings: { checkTimeoutMs: 654321 } }));
  assert.equal(result.checkTimeoutMs, 654321);
});

test('the evaluate prompt asks for the report to be updated after each acceptance criterion', () => {
  const prompt = buildPrompt({ id: 'task', cwd: '/tmp' }, 'evaluate', null, '/tmp/analysis-report.md');
  assert.match(prompt, /update .*analysis-report\.md after each acceptance criterion/i);
});

test('--approve-model naming the requested model records a run approval', () => {
  const config: any = { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', roster: [], approved: [] };
  const approval = resolveExplicitApproval(config, { approveModel: 'moonshotai/kimi-k2.7-code' },
    { provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code' }, undefined);
  assert.deepEqual(approval, { source: 'run', key: 'moonshotai/kimi-k2.7-code' });
});
