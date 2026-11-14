// Behavioral tests for the Claude Code permission-rule grammar used by the
// Crossmatrix store lockdown. Each scenario asserts one observable outcome of
// the public lint and matching helpers.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CLAUDE_STORE_DENY_RULES } from './harness.ts';
import { lintPermissionRule, ruleMatches, type PermissionCall } from './harness-rule-grammar.ts';

const RULES_0_16_0 = [
  'Read(./.crossmatrix/**)',
  'Edit(./.crossmatrix/**)',
  'Write(./.crossmatrix/**)',
  'Bash(cat .crossmatrix:*)',
  'Bash(grep * .crossmatrix:*)',
  'Bash(jq * .crossmatrix:*)',
];

function denied(call: PermissionCall): boolean {
  return CLAUDE_STORE_DENY_RULES.some((rule) => ruleMatches(rule, call));
}

// ---------------------------------------------------------------------------
// Lint: every rule Junior writes must be valid and effective.
// ---------------------------------------------------------------------------

test('current store deny rules have no lint problems', () => {
  const problems = CLAUDE_STORE_DENY_RULES.flatMap((rule) =>
    lintPermissionRule(rule, CLAUDE_STORE_DENY_RULES),
  );
  assert.deepEqual(problems, []);
});

test('0.16.0 store deny list reports exactly three lint problems', () => {
  const problems = RULES_0_16_0.flatMap((rule) => lintPermissionRule(rule, RULES_0_16_0));
  assert.equal(problems.length, 3);
});

test('0.16.0 write rule is reported as redundant with its edit rule', () => {
  const problems = lintPermissionRule('Write(./.crossmatrix/**)', RULES_0_16_0);
  assert.match(problems[0] ?? '', /Write\(\.\/\.crossmatrix\/\*\*\)/);
});

test('0.16.0 grep rule is reported for a literal star before the trailing colon-star', () => {
  const problems = lintPermissionRule('Bash(grep * .crossmatrix:*)', RULES_0_16_0);
  assert.match(problems[0] ?? '', /Bash\(grep/);
});

test('0.16.0 jq rule is reported for a literal star before the trailing colon-star', () => {
  const problems = lintPermissionRule('Bash(jq * .crossmatrix:*)', RULES_0_16_0);
  assert.match(problems[0] ?? '', /Bash\(jq/);
});

test('mid-pattern bash glob is accepted', () => {
  const problems = lintPermissionRule('Bash(grep * .crossmatrix*)', ['Bash(grep * .crossmatrix*)']);
  assert.deepEqual(problems, []);
});

test('read path outside the project-relative, absolute or home forms is reported', () => {
  const problems = lintPermissionRule('Read(.crossmatrix/**)', ['Read(.crossmatrix/**)']);
  assert.match(problems[0] ?? '', /Read\(\.crossmatrix\/\*\*\)/);
});

test('project-relative read path is accepted', () => {
  const problems = lintPermissionRule('Read(./src/**)', ['Read(./src/**)']);
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// Matching: what the current deny rules actually block.
// ---------------------------------------------------------------------------

const DENIED_CALLS: ReadonlyArray<{ name: string; call: PermissionCall }> = [
  { name: 'grep -r x .crossmatrix/', call: { tool: 'Bash', command: 'grep -r x .crossmatrix/' } },
  { name: 'jq . .crossmatrix/state/a.json', call: { tool: 'Bash', command: 'jq . .crossmatrix/state/a.json' } },
  { name: 'cat .crossmatrix/README.md', call: { tool: 'Bash', command: 'cat .crossmatrix/README.md' } },
  { name: 'Read .crossmatrix/state/a.json', call: { tool: 'Read', path: '.crossmatrix/state/a.json' } },
  { name: 'Edit ./.crossmatrix/x', call: { tool: 'Edit', path: './.crossmatrix/x' } },
];

for (const { name, call } of DENIED_CALLS) {
  test(`current store deny rules deny ${name}`, () => {
    assert.equal(denied(call), true);
  });
}

const ALLOWED_CALLS: ReadonlyArray<{ name: string; call: PermissionCall }> = [
  { name: 'grep -r x src/', call: { tool: 'Bash', command: 'grep -r x src/' } },
  { name: 'cat README.md', call: { tool: 'Bash', command: 'cat README.md' } },
  { name: 'Read src/a.ts', call: { tool: 'Read', path: 'src/a.ts' } },
];

for (const { name, call } of ALLOWED_CALLS) {
  test(`current store deny rules allow ${name}`, () => {
    assert.equal(denied(call), false);
  });
}

// ---------------------------------------------------------------------------
// Matching semantics.
// ---------------------------------------------------------------------------

test('colon-star bash rule matches the bare command', () => {
  assert.equal(ruleMatches('Bash(npm run test:*)', { tool: 'Bash', command: 'npm run test' }), true);
});

test('colon-star bash rule matches the command followed by a space', () => {
  assert.equal(
    ruleMatches('Bash(npm run test:*)', { tool: 'Bash', command: 'npm run test --watch' }),
    true,
  );
});

test('colon-star bash rule does not match a longer command word', () => {
  assert.equal(ruleMatches('Bash(npm run test:*)', { tool: 'Bash', command: 'npm run testing' }), false);
});

test('mid-pattern bash glob spans spaces and slashes', () => {
  assert.equal(
    ruleMatches('Bash(grep * .crossmatrix*)', { tool: 'Bash', command: 'grep -r x .crossmatrix/state' }),
    true,
  );
});

test('mid-pattern bash glob does not match a different path', () => {
  assert.equal(
    ruleMatches('Bash(grep * .crossmatrix*)', { tool: 'Bash', command: 'grep -r x src/' }),
    false,
  );
});

test('directory glob matches a path under the directory with a leading dot-slash', () => {
  assert.equal(ruleMatches('Read(./dir/**)', { tool: 'Read', path: './dir/a' }), true);
});

test('directory glob matches a path under the directory without a leading dot-slash', () => {
  assert.equal(ruleMatches('Read(./dir/**)', { tool: 'Read', path: 'dir/a' }), true);
});

test('directory glob does not match a sibling directory', () => {
  assert.equal(ruleMatches('Read(./dir/**)', { tool: 'Read', path: './other/a' }), false);
});

test('rule for another tool never matches the call', () => {
  assert.equal(ruleMatches('Read(./dir/**)', { tool: 'Edit', path: './dir/a' }), false);
});

test('the 0.16.0 cat prefix rule does not deny reading a file inside the store', () => {
  assert.equal(ruleMatches('Bash(cat .crossmatrix:*)', { tool: 'Bash', command: 'cat .crossmatrix/README.md' }), false);
});
