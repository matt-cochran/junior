import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { run, createRunState, preflight } from './worker.ts';

const MODEL = 'deepseek/deepseek-v4.1-flash';
const SESSION_ID = '123e4567-e89b-12d3-a456-426614174000';

const stream = (sessionId: string) => [
  JSON.stringify({ type: 'session', id: sessionId }),
  JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'openrouter', model: MODEL,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop' } }),
  JSON.stringify({ type: 'agent_settled' }),
].join('\n') + '\n';

const task = (cwd: string, extra: any = {}) => ({
  id: 'resume',
  deliverable: 'Resume the prior session',
  cwd,
  acceptance: ['resume works'],
  checks: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
  provider: 'openrouter',
  model: MODEL,
  externalContextConsent: true,
  ...extra,
});

const priorAt = (cwd: string, extra: any = {}) => {
  const artifactDir = join(cwd, '.delivery', 'prior', '1');
  mkdirSync(artifactDir, { recursive: true });
  const prior = {
    id: 'prior',
    status: 'ready_for_review',
    cwd,
    artifactDir,
    workflow: { selected: 'test_first' },
    receipt: {
      source: 'pi_message_end',
      requested: { provider: 'openrouter', model: MODEL },
      sessionId: SESSION_ID,
    },
    ...extra,
  };
  writeFileSync(join(artifactDir, 'result.json'), JSON.stringify(prior));
  return { artifactDir, resultPath: join(artifactDir, 'result.json') };
};

const sessionFiles = (root: string): string[] => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relative(root, path));
    }
  };
  walk(root);
  return found.sort();
};

test('resume imports exactly the referenced prior session file into the run overlay', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'delivery-resume-'));
  const { artifactDir } = priorAt(cwd);
  const relativeSession = join('--checkout--', `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
  mkdirSync(join(artifactDir, 'pi-agent', 'sessions', '--checkout--'), { recursive: true });
  writeFileSync(join(artifactDir, 'pi-agent', 'sessions', relativeSession), stream(SESSION_ID));
  writeFileSync(join(artifactDir, 'pi-agent', 'sessions', '--checkout--', 'other-session.jsonl'), stream('other-session'));
  let result: any;
  try {
    result = await run(task(cwd, { workflow: 'test_first', resumeFrom: join(artifactDir, 'result.json') }), false, {
      spawnPi: () => ({ status: 0, stdout: stream(SESSION_ID), stderr: '' }),
    });
    assert.deepEqual(
      sessionFiles(join(result.artifactDir, 'pi-agent', 'sessions')),
      [relativeSession],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('test_first resume with an absent prior session stops as resume_session_unavailable', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'delivery-resume-'));
  const { resultPath } = priorAt(cwd);
  try {
    const result = await run(task(cwd, { workflow: 'test_first', resumeFrom: resultPath }), false, {
      spawnPi: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    assert.equal(result.status, 'resume_session_unavailable');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('test_first resume with an absent prior session never starts Pi', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'delivery-resume-'));
  const { resultPath } = priorAt(cwd);
  let spawned = false;
  try {
    await run(task(cwd, { workflow: 'test_first', resumeFrom: resultPath }), false, {
      spawnPi: () => { spawned = true; return { status: 0, stdout: '', stderr: '' }; },
    });
    assert.equal(spawned, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('evaluate resume with an absent prior session records a fresh-session fallback', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'delivery-resume-'));
  const { artifactDir, resultPath } = priorAt(cwd);
  const state = createRunState(task(cwd, { workflow: 'evaluate', resumeFrom: resultPath }), true, {});
  try {
    await preflight(state);
    assert.deepEqual(state.resumeFallback, {
      reason: `session ${SESSION_ID} was not found under ${join(artifactDir, 'pi-agent', 'sessions')}`,
      priorResult: resultPath,
      sessionId: `${SESSION_ID.slice(0, 8)}…`,
    });
  } finally {
    state.release?.();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('evaluate resume fallback seeds the fresh session with the prior analysis report', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'delivery-resume-'));
  const { artifactDir, resultPath } = priorAt(cwd, { workflow: { selected: 'evaluate' } });
  writeFileSync(join(artifactDir, 'analysis-report.md'), 'PRIOR-REPORT-SENTINEL');
  let prompt = '';
  try {
    await run(task(cwd, { workflow: 'evaluate', resumeFrom: resultPath }), false, {
      spawnPi: (_command: string, args: string[]) => {
        prompt = args[args.length - 1];
        return { status: 0, stdout: stream(SESSION_ID), stderr: '' };
      },
    });
    assert.match(prompt, /PRIOR-REPORT-SENTINEL/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('evaluate resume fallback starts Pi without a --session argument', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'delivery-resume-'));
  const { resultPath } = priorAt(cwd, { workflow: { selected: 'evaluate' } });
  let args: string[] = [];
  try {
    await run(task(cwd, { workflow: 'evaluate', resumeFrom: resultPath }), false, {
      spawnPi: (_command: string, piArgs: string[]) => {
        args = piArgs;
        return { status: 0, stdout: stream(SESSION_ID), stderr: '' };
      },
    });
    assert.equal(args.includes('--session'), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
