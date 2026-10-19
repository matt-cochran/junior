import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { validate, TASK_FIELDS } from './worker.ts';

// A minimal valid contract; `plan` is layered on per scenario.
const base = (extra: any = {}) => ({
 id: 'plan-field',
 deliverable: 'Plan field',
 cwd: process.cwd(),
 acceptance: ['Plan accepted'],
 checks: [{ command: process.execPath, args: ['-e', ''] }],
 ...extra,
});
// Most plan scenarios also need the hop handoff a plan is linked from.
const task = (plan: any) => base({ hopFrom: '/tmp/hop.json', plan });

test('TASK_FIELDS advertises the plan field', () =>
 assert.ok((TASK_FIELDS as readonly string[]).includes('plan')));

test('validate accepts a plan with id and deliverable', () =>
 assert.doesNotThrow(() => validate(task({ id: 'deliverable-1', deliverable: 'Ship the widget' }))));

test('validate accepts a plan with an optional callerId', () =>
 assert.doesNotThrow(() => validate(task({ id: 'deliverable-1', deliverable: 'Ship the widget', callerId: 'agent-7' }))));

test('validate rejects a plan that is not an object', () =>
 assert.throws(() => validate(task('deliverable-1')), /Invalid plan/));

test('validate rejects a plan with a missing id', () =>
 assert.throws(() => validate(task({ deliverable: 'Ship the widget' })), /Invalid plan\.id/));

test('validate rejects a plan with a blank id', () =>
 assert.throws(() => validate(task({ id: '   ', deliverable: 'Ship the widget' })), /Invalid plan\.id/));

test('validate rejects a plan with a missing deliverable', () =>
 assert.throws(() => validate(task({ id: 'deliverable-1' })), /Invalid plan\.deliverable/));

test('validate rejects a plan with a blank deliverable', () =>
 assert.throws(() => validate(task({ id: 'deliverable-1', deliverable: '' })), /Invalid plan\.deliverable/));

test('validate rejects a plan with a non-string callerId', () =>
 assert.throws(() => validate(task({ id: 'deliverable-1', deliverable: 'Ship the widget', callerId: 7 })), /Invalid plan\.callerId/));

test('validate rejects a plan with a blank callerId', () =>
 assert.throws(() => validate(task({ id: 'deliverable-1', deliverable: 'Ship the widget', callerId: '  ' })), /Invalid plan\.callerId/));

test('validate rejects a plan with an unknown key', () =>
 assert.throws(() => validate(task({ id: 'deliverable-1', deliverable: 'Ship the widget', cohort: 'a' })), /Unknown plan field/));

test('validate rejects a plan when hopFrom is missing', () =>
 assert.throws(() => validate(base({ plan: { id: 'deliverable-1', deliverable: 'Ship the widget' } })), /plan.*hopFrom/));

test('validate rejects a plan when hopFrom is blank', () =>
 assert.throws(() => validate(base({ hopFrom: '   ', plan: { id: 'deliverable-1', deliverable: 'Ship the widget' } })), /plan.*hopFrom/));
