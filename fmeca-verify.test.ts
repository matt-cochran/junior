import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {proposeVerified} from './fmeca-verify.ts';

const RUN_REF = 'R1/20261023';

function resultWith(criteria: unknown): unknown {
  return {jev: {postflight: {criteria}}};
}

test('proposeVerified yields exactly one proposal per (criterion, mitigation) pair', () => {
  const result = resultWith([
    {id: 'req:c1/ac1', verdict: 'met', tier: 'check_passed', mitigates: ['s1/m1']},
  ]);
  assert.equal(proposeVerified(result, RUN_REF).proposals.length, 1);
});

test('proposeVerified takes session_id from the first slash-separated part', () => {
  const result = resultWith([
    {id: 'req:c1/ac1', verdict: 'met', tier: 'check_passed', mitigates: ['s1/m1']},
  ]);
  assert.equal(proposeVerified(result, RUN_REF).proposals[0].request.arguments.session_id, 's1');
});

test('proposeVerified takes mitigation_id from the part after the first slash', () => {
  const result = resultWith([
    {id: 'req:c1/ac1', verdict: 'met', tier: 'check_passed', mitigates: ['s1/m1']},
  ]);
  assert.equal(proposeVerified(result, RUN_REF).proposals[0].request.arguments.mitigation_id, 'm1');
});

test('proposeVerified keeps the full mitigates entry as the proposal mitigation', () => {
  const result = resultWith([
    {id: 'req:c1/ac1', verdict: 'met', tier: 'check_passed', mitigates: ['s1/m1']},
  ]);
  assert.equal(proposeVerified(result, RUN_REF).proposals[0].mitigation, 's1/m1');
});

test('proposeVerified references the criterion as runRef:criterionId in its evidence', () => {
  const result = resultWith([
    {id: 'req:c1/ac1', verdict: 'met', tier: 'check_passed', mitigates: ['s1/m1']},
  ]);
  assert.equal(
    proposeVerified(result, RUN_REF).proposals[0].request.arguments.evidence[0].reference,
    'R1/20261023:req:c1/ac1',
  );
});

test('A criterion met at tier judged yields no proposal', () => {
  const result = resultWith([
    {id: 'req:c1/ac1', verdict: 'met', tier: 'judged', mitigates: ['s1/m1']},
  ]);
  assert.equal(proposeVerified(result, RUN_REF).proposals.length, 0);
});

test('A criterion at verdict gap yields no proposal even at tier check_passed', () => {
  const result = resultWith([
    {id: 'req:c1/ac1', verdict: 'gap', tier: 'check_passed', mitigates: ['s1/m1']},
  ]);
  assert.equal(proposeVerified(result, RUN_REF).proposals.length, 0);
});

test('A mitigates entry without a slash is skipped', () => {
  const result = resultWith([
    {id: 'req:c1/ac1', verdict: 'met', tier: 'check_passed', mitigates: ['nosession']},
  ]);
  assert.equal(proposeVerified(result, RUN_REF).skipped.length, 1);
});

test('A skipped mitigates entry yields no proposal', () => {
  const result = resultWith([
    {id: 'req:c1/ac1', verdict: 'met', tier: 'check_passed', mitigates: ['nosession']},
  ]);
  assert.equal(proposeVerified(result, RUN_REF).proposals.length, 0);
});

test('proposeVerified emits one proposal for each mitigation on a criterion', () => {
  const result = resultWith([
    {id: 'req:c1/ac1', verdict: 'met', tier: 'check_passed', mitigates: ['s1/m1', 's2/m2']},
  ]);
  assert.equal(proposeVerified(result, RUN_REF).proposals.length, 2);
});

test('proposeVerified preserves a non-string mitigates entry in skipped', () => {
  const result = resultWith([
    {id: 'req:c1/ac1', verdict: 'met', tier: 'check_passed', mitigates: [42]},
  ]);
  assert.equal(proposeVerified(result, RUN_REF).skipped[0].entry, 42);
});

test('proposeVerified on null returns both empty lists', () => {
  assert.deepEqual(proposeVerified(null, 'R'), {proposals: [], skipped: []});
});

test('proposeVerified on a non-array criteria field returns both empty lists', () => {
  assert.deepEqual(proposeVerified(resultWith('nope'), 'R'), {proposals: [], skipped: []});
});

test('fmeca-verify.ts declares no import statement', () => {
  const source = readFileSync(new URL('./fmeca-verify.ts', import.meta.url), 'utf8');
  assert.equal(/^\s*import\b/m.test(source), false);
});
