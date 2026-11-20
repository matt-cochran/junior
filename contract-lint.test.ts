// Behavioural tests for the contract-shape lint (#279).
//
// Each scenario drives the public `contractLint` / `validate` /
// `contractWarnings` surface and asserts one observable outcome: a finding
// code, its severity, or the suggested fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contractLint } from './contract-lint.ts';
import { contractWarnings, validate } from './worker-contract.ts';

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-contract-lint-'));
}

function contract(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'c1',
    deliverable: 'do the work',
    cwd: '/repo',
    workflow: 'test_first',
    acceptance: ['works'],
    checks: [{ command: 'node', args: ['--test', 'a.test.ts'] }],
    scope: { owned: ['a.test.ts'] },
    jev: { mode: 'shadow' },
    ...overrides,
  };
}

function writeLines(dir: string, name: string, count: number): void {
  writeFileSync(join(dir, name), Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n'));
}

function receipt(dir: string, id: string, stamp: string, totalTokens: number, changedLines: number): void {
  const target = join(dir, id, stamp);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'result.json'), JSON.stringify({
    receipt: { usage: { totalTokens } },
    evidence: { changedLines },
  }));
}

function codes(value: any): string[] {
  return contractLint(value).map((finding) => finding.code);
}

// --- CHECK_UNFILTERED -------------------------------------------------------

test('contractLint flags a bare dotnet test project check', () => {
  const value = contract({ checks: [{ command: 'dotnet', args: ['test', 'tests/Foo.csproj'] }] });
  assert.ok(codes(value).includes('CHECK_UNFILTERED'));
});

test('CHECK_UNFILTERED suggests a dotnet filter naming the scoped test class', () => {
  const value = contract({ checks: [{ command: 'dotnet', args: ['test', 'tests/Foo.csproj'] }], scope: { owned: ['tests/CalculatorTests.cs'] } });
  const suggestion = contractLint(value).find((finding) => finding.code === 'CHECK_UNFILTERED')?.suggestion ?? '';
  assert.match(suggestion, /--filter "FullyQualifiedName~CalculatorTests"/);
});

test('contractLint flags a bare node --test check with no scoped test files', () => {
  const value = contract({ checks: [{ command: 'node', args: ['--test'] }], scope: { owned: ['src/a.ts'] } });
  assert.ok(codes(value).includes('CHECK_UNFILTERED'));
});

test('contractLint flags a bare node --test check', () => {
  const value = contract({ checks: [{ command: 'node', args: ['--test'] }] });
  assert.ok(codes(value).includes('CHECK_UNFILTERED'));
});

test('CHECK_UNFILTERED suggests the check file for a bare node --test check', () => {
  const value = contract({ checks: [{ command: 'node', args: ['--test'] }] });
  const suggestion = contractLint(value).find((finding) => finding.code === 'CHECK_UNFILTERED')?.suggestion ?? '';
  assert.equal(suggestion, 'node --test a.test.ts');
});

test('contractLint does not flag node --test with a file', () => {
  assert.equal(codes(contract()).includes('CHECK_UNFILTERED'), false);
});

test('contractLint does not flag an unfiltered check when the scope names more than three test files', () => {
  const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts'];
  const value = contract({ checks: [{ command: 'node', args: ['--test'] }], scope: { owned: files } });
  assert.equal(codes(value).includes('CHECK_UNFILTERED'), false);
});

test('contractLint flags a bare npx jest check', () => {
  const value = contract({ checks: [{ command: 'npx', args: ['jest'] }] });
  assert.ok(codes(value).includes('CHECK_UNFILTERED'));
});

test('contractLint does not flag npx jest narrowed with -t', () => {
  const value = contract({ checks: [{ command: 'npx', args: ['jest', '-t', 'adds totals'] }] });
  assert.equal(codes(value).includes('CHECK_UNFILTERED'), false);
});

test('contractLint flags a vitest run without a path or name filter', () => {
  const value = contract({ checks: [{ command: 'npx', args: ['vitest', 'run'] }] });
  assert.ok(codes(value).includes('CHECK_UNFILTERED'));
});

test('contractLint flags a bare pytest check', () => {
  const value = contract({ checks: [{ command: 'pytest', args: [] }] });
  assert.ok(codes(value).includes('CHECK_UNFILTERED'));
});

test('contractLint does not flag pytest narrowed with -k', () => {
  const value = contract({ checks: [{ command: 'pytest', args: ['-k', 'totals'] }] });
  assert.equal(codes(value).includes('CHECK_UNFILTERED'), false);
});

test('contractLint flags npm test when the package test script is unfiltered', () => {
  const dir = workdir();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  writeFileSync(join(dir, 'a.test.ts'), '');
  const value = contract({ cwd: dir, checks: [{ command: 'npm', args: ['test'] }] });
  assert.ok(codes(value).includes('CHECK_UNFILTERED'));
});

test('contractLint does not flag npm test when the package test script names a file', () => {
  const dir = workdir();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test a.test.ts' } }));
  writeFileSync(join(dir, 'a.test.ts'), '');
  const value = contract({ cwd: dir, checks: [{ command: 'npm', args: ['test'] }] });
  assert.equal(codes(value).includes('CHECK_UNFILTERED'), false);
});

test('CHECK_UNFILTERED is a warning under jev.mode shadow', () => {
  const value = contract({ checks: [{ command: 'node', args: ['--test'] }], jev: { mode: 'shadow' } });
  assert.equal(contractLint(value).find((finding) => finding.code === 'CHECK_UNFILTERED')?.severity, 'warning');
});

test('CHECK_UNFILTERED is an error under jev.mode enforce', () => {
  const value = contract({ checks: [{ command: 'node', args: ['--test'] }], jev: { mode: 'enforce' } });
  assert.equal(contractLint(value).find((finding) => finding.code === 'CHECK_UNFILTERED')?.severity, 'error');
});

test('contractWarnings reports CHECK_UNFILTERED for a shadow contract', () => {
  const value = contract({ checks: [{ command: 'node', args: ['--test'] }] });
  assert.ok(contractWarnings(value).some((warning) => warning.startsWith('CHECK_UNFILTERED:')));
});

test('validate refuses an unfiltered check under jev.mode enforce', () => {
  const dir = workdir();
  writeFileSync(join(dir, 'a.test.ts'), '');
  const value = contract({ cwd: dir, checks: [{ command: 'node', args: ['--test'] }], jev: { mode: 'enforce' } });
  assert.throws(() => validate(value), /CHECK_UNFILTERED/);
});

// --- CONTRACT_OVER_BUDGET ---------------------------------------------------

test('contractLint flags an explicit changed-line estimate above the budget', () => {
  const value = contract({ estimate: { changedLines: 100 }, budget: { maxTotalTokens: 1000 } });
  assert.ok(codes(value).includes('CONTRACT_OVER_BUDGET'));
});

test('contractLint does not flag an explicit changed-line estimate below the budget', () => {
  const value = contract({ estimate: { changedLines: 100 }, budget: { maxTotalTokens: 10000000 } });
  assert.equal(codes(value).includes('CONTRACT_OVER_BUDGET'), false);
});

test('CONTRACT_OVER_BUDGET suggests a code and test split', () => {
  const value = contract({ estimate: { changedLines: 100 }, budget: { maxTotalTokens: 1000 } });
  const suggestion = contractLint(value).find((finding) => finding.code === 'CONTRACT_OVER_BUDGET')?.suggestion ?? '';
  assert.match(suggestion, /code.*test/i);
});

test('CONTRACT_OVER_BUDGET is an error under jev.mode enforce', () => {
  const value = contract({ estimate: { changedLines: 100 }, budget: { maxTotalTokens: 1000 }, jev: { mode: 'enforce' } });
  assert.equal(contractLint(value).find((finding) => finding.code === 'CONTRACT_OVER_BUDGET')?.severity, 'error');
});

test('validate refuses an over-budget estimate under jev.mode enforce', () => {
  const dir = workdir();
  writeLines(dir, 'a.test.ts', 100);
  const value = contract({ cwd: dir, scope: { owned: ['a.test.ts'] }, budget: { maxTotalTokens: 300000 }, jev: { mode: 'enforce' } });
  assert.throws(() => validate(value), /CONTRACT_OVER_BUDGET/);
});

test('contractLint estimates half the current lines of an edited owned file', () => {
  const dir = workdir();
  writeLines(dir, 'a.test.ts', 100);
  const value = contract({ cwd: dir, scope: { owned: ['a.test.ts'] }, budget: { maxTotalTokens: 349999 } });
  assert.ok(codes(value).includes('CONTRACT_OVER_BUDGET'));
});

test('contractLint estimates 150 lines for a new owned file', () => {
  const value = contract({ cwd: workdir(), scope: { owned: ['new.ts'] }, budget: { maxTotalTokens: 1000000 } });
  assert.ok(codes(value).includes('CONTRACT_OVER_BUDGET'));
});

test('contractLint uses the median tokens per changed line from past receipts', () => {
  const dir = workdir();
  const delivery = join(dir, '.delivery');
  writeLines(dir, 'a.test.ts', 100);
  receipt(delivery, 'old-a', '1', 100000, 100);
  receipt(delivery, 'old-b', '2', 300000, 100);
  const value = contract({ cwd: dir, scope: { owned: ['a.test.ts'] }, budget: { maxTotalTokens: 300000 } });
  assert.ok(codes(value).includes('CONTRACT_OVER_BUDGET'));
});

test('contractLint ignores past receipts with fewer than 50 changed lines', () => {
  const dir = workdir();
  const delivery = join(dir, '.delivery');
  writeLines(dir, 'a.test.ts', 100);
  receipt(delivery, 'small', '1', 1000000, 10);
  const value = contract({ cwd: dir, scope: { owned: ['a.test.ts'] }, budget: { maxTotalTokens: 1000000 } });
  assert.equal(codes(value).includes('CONTRACT_OVER_BUDGET'), false);
});
