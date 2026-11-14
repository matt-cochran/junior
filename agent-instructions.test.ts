// Behavioral tests for the Junior-owned agent instruction files (ADR 0018 R11).
//
// Every scenario is atomic and drives the public file functions only. Each
// test observes one outcome: rendered text, target-to-file mapping, a file
// action, the bytes left on disk, or an inspection state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_INSTRUCTIONS_VERSION,
  applyAgentInstructions,
  inspectAgentInstructions,
  instructionFiles,
  renderAgentInstructions,
} from './agent-instructions.ts';

const EXPECTED = `Use the installed Junior skill for delegation, CPM planning, FMECA risk, crossmatrix traceability and investigations; run \`junior routes "<request>"\` when unsure which command fits. Review receipts and independent checks before accepting work.

ADR compliance checkpoints (ADR 0018). Run the check, and if it reports findings, stop and show them to the human; never record a decision yourself:
- Design: before accepting a design, plan or brief, \`junior adr check --stage design --input <file>\`.
- Ticket proposal: before filing a ticket, \`junior adr check --stage ticket --draft <file>\`.
- Ticket pickup: before starting work on a ticket, \`junior adr check --stage ticket --ticket <id>\`.
- Implementation: before opening a pull request, \`junior adr check --stage implementation\`.
The human resolves a finding with \`junior adr decide\` (override with a reason, amend the ADR, or revise the work). If the repository has no ADRs, offer \`junior adr init\` and ask before running it.`;

function project(): string {
  return mkdtempSync(join(tmpdir(), 'junior-agent-instructions-'));
}

function block(content = EXPECTED, eol = '\n'): string {
  return `<junior>${eol}${content}${eol}</junior>${eol}`;
}

// --- rendering and mapping -------------------------------------------------

test('AGENT_INSTRUCTIONS_VERSION is 1', () => {
  assert.equal(AGENT_INSTRUCTIONS_VERSION, 1);
});

test('renderAgentInstructions returns the exact checkpoint text', () => {
  assert.equal(renderAgentInstructions(), EXPECTED);
});

test('the claude target maps to CLAUDE.md', () => {
  assert.deepEqual(instructionFiles('claude'), ['CLAUDE.md']);
});

test('the codex target maps to AGENTS.md', () => {
  assert.deepEqual(instructionFiles('codex'), ['AGENTS.md']);
});

test('the both target maps to CLAUDE.md then AGENTS.md', () => {
  assert.deepEqual(instructionFiles('both'), ['CLAUDE.md', 'AGENTS.md']);
});

test('the none target maps to no files', () => {
  assert.deepEqual(instructionFiles('none'), []);
});

// --- init ------------------------------------------------------------------

test('init creates a missing file containing just the block', () => {
  const cwd = project();
  applyAgentInstructions(cwd, { target: 'claude', command: 'init' });
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), block());
});

test('init creates both files for the both target', () => {
  const cwd = project();
  applyAgentInstructions(cwd, { target: 'both', command: 'init' });
  assert.deepEqual(
    [readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), readFileSync(join(cwd, 'AGENTS.md'), 'utf8')],
    [block(), block()],
  );
});

test('init adds the block to an existing file and preserves the text around it', () => {
  const cwd = project();
  writeFileSync(join(cwd, 'CLAUDE.md'), '# House rules\n\nBe kind.\n');
  applyAgentInstructions(cwd, { target: 'claude', command: 'init' });
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), `# House rules\n\nBe kind.\n\n${block()}`);
});

test('init replaces an outdated block and preserves the outside text', () => {
  const cwd = project();
  writeFileSync(join(cwd, 'CLAUDE.md'), `head\n${block('old instructions')}tail\n`);
  applyAgentInstructions(cwd, { target: 'claude', command: 'init' });
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), `head\n${block()}tail\n`);
});

// --- update ----------------------------------------------------------------

test('update reports a missing file as skipped', () => {
  const cwd = project();
  const result = applyAgentInstructions(cwd, { target: 'claude', command: 'update' });
  assert.deepEqual(result.files, [{ path: 'CLAUDE.md', action: 'skipped' }]);
});

test('update does not create a missing file', () => {
  const cwd = project();
  applyAgentInstructions(cwd, { target: 'claude', command: 'update' });
  assert.throws(() => readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), /ENOENT/);
});

test('update adds the block to an existing file', () => {
  const cwd = project();
  writeFileSync(join(cwd, 'AGENTS.md'), 'Existing notes.\n');
  applyAgentInstructions(cwd, { target: 'codex', command: 'update' });
  assert.equal(readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), `Existing notes.\n\n${block()}`);
});

test('update refreshes an outdated block', () => {
  const cwd = project();
  writeFileSync(join(cwd, 'CLAUDE.md'), block('stale guidance'));
  const result = applyAgentInstructions(cwd, { target: 'claude', command: 'update' });
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), block());
});

test('an already current file is not rewritten', () => {
  const cwd = project();
  writeFileSync(join(cwd, 'CLAUDE.md'), block());
  let writes = 0;
  const deps = {
    exists: (path: string) => path === join(cwd, 'CLAUDE.md'),
    readFile: () => block(),
    writeFile: () => { writes += 1; },
  };
  applyAgentInstructions(cwd, { target: 'claude', command: 'update', deps });
  assert.equal(writes, 0);
});

// --- conflict --------------------------------------------------------------

test('a duplicate block is reported with its reason and lines', () => {
  const cwd = project();
  applyAgentInstructions(cwd, { target: 'claude', command: 'init' });
  writeFileSync(join(cwd, 'CLAUDE.md'), block() + block());
  const result = applyAgentInstructions(cwd, { target: 'claude', command: 'update' });
  assert.deepEqual(result.files, [{ path: 'CLAUDE.md', action: 'conflict', reason: 'duplicate', lines: [1, 11] }]);
});

test('a conflicting file is left byte-identical', () => {
  const cwd = project();
  const original = block() + block();
  writeFileSync(join(cwd, 'CLAUDE.md'), original);
  applyAgentInstructions(cwd, { target: 'claude', command: 'update' });
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), original);
});

test('nested tags are reported as a conflict', () => {
  const cwd = project();
  writeFileSync(join(cwd, 'CLAUDE.md'), '<junior>\nouter\n<junior>\ninner\n</junior>\n</junior>\n');
  const result = applyAgentInstructions(cwd, { target: 'claude', command: 'update' });
  assert.equal(result.files[0].reason, 'nested');
});

test('unbalanced tags are reported as a conflict', () => {
  const cwd = project();
  writeFileSync(join(cwd, 'CLAUDE.md'), '<junior>\nbody\n');
  const result = applyAgentInstructions(cwd, { target: 'claude', command: 'update' });
  assert.equal(result.files[0].reason, 'unbalanced');
});

// --- inspect ---------------------------------------------------------------

test('inspect reports current for a file holding the rendered block', () => {
  const cwd = project();
  writeFileSync(join(cwd, 'CLAUDE.md'), block());
  assert.deepEqual(inspectAgentInstructions(cwd, { target: 'claude' }), [{ path: 'CLAUDE.md', state: 'current' }]);
});

test('inspect reports outdated for a block with other content', () => {
  const cwd = project();
  writeFileSync(join(cwd, 'CLAUDE.md'), block('old guidance'));
  assert.deepEqual(inspectAgentInstructions(cwd, { target: 'claude' }), [{ path: 'CLAUDE.md', state: 'outdated' }]);
});

test('inspect reports missing when the file is absent', () => {
  const cwd = project();
  assert.deepEqual(inspectAgentInstructions(cwd, { target: 'codex' }), [{ path: 'AGENTS.md', state: 'missing' }]);
});

test('inspect reports missing when the file has no block', () => {
  const cwd = project();
  writeFileSync(join(cwd, 'AGENTS.md'), 'No managed block here.\n');
  assert.deepEqual(inspectAgentInstructions(cwd, { target: 'codex' }), [{ path: 'AGENTS.md', state: 'missing' }]);
});

test('inspect reports a conflict with its line numbers', () => {
  const cwd = project();
  writeFileSync(join(cwd, 'CLAUDE.md'), block() + block());
  assert.deepEqual(inspectAgentInstructions(cwd, { target: 'claude' }), [
    { path: 'CLAUDE.md', state: 'conflict', lines: [1, 11] },
  ]);
});