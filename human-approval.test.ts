// ---------------------------------------------------------------------------
// Behavioral tests for human approval of agent-raised policy changes.
// Each scenario asserts exactly one observable outcome through the public API.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  agentEnvironment,
  requireHuman,
  E_HUMAN_APPROVAL_REQUIRED,
  type HumanApprovalError,
} from './human-approval.ts';

test('agentEnvironment names CLAUDECODE as the detected agent shell', () => {
  assert.equal(agentEnvironment({ CLAUDECODE: '1' }), 'CLAUDECODE');
});

test('agentEnvironment returns null for an ordinary human shell', () => {
  assert.equal(agentEnvironment({ HOME: '/home/human' }), null);
});

test('requireHuman refuses an agent budget raise without a TTY', async () => {
  await assert.rejects(
    () => requireHuman('junior auth budget approve G2 --tokens 20000000', {
      env: { CLAUDECODE: '1' },
      isTTY: false,
    }),
    (error: HumanApprovalError) => error.code === E_HUMAN_APPROVAL_REQUIRED,
  );
});

test('requireHuman accepts the six-character code typed back on a TTY', async () => {
  let shown = '';
  const token = await requireHuman('junior auth budget approve G2 --tokens 20000000', {
    env: {},
    isTTY: true,
    prompt: (question) => {
      shown = /Enter code ([A-Z0-9]{6})/.exec(question)?.[1] ?? '';
      return shown;
    },
  });
  assert.equal(token, shown);
});

test('requireHuman refuses a TTY answer that does not match the shown code', async () => {
  await assert.rejects(
    () => requireHuman('junior auth consent grant openrouter', {
      env: {},
      isTTY: true,
      prompt: () => 'WRONG1',
    }),
    (error: HumanApprovalError) => error.code === E_HUMAN_APPROVAL_REQUIRED,
  );
});
