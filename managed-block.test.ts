// Behavioral tests for the Junior-owned Markdown instruction block (ADR 0018 R11).
//
// Every scenario is atomic and drives the public string functions only. The
// tests cover one observable outcome each: an inspection state, a conflict
// reason, an exact string transformation, or a changed flag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectBlock, removeBlock, upsertBlock } from './managed-block.ts';

const CONTENT = 'Use Junior.';

function block(content = CONTENT, eol = '\n', tag = 'junior'): string {
  return `<${tag}>${eol}${content}${eol}</${tag}>${eol}`;
}

// --- inspectBlock -----------------------------------------------------------

test('inspectBlock reports absent when the text has no tag', () => {
  assert.deepEqual(inspectBlock('Just instructions.\n'), { state: 'absent' });
});

test('inspectBlock reports absent for an inline tag that is not the whole line', () => {
  assert.deepEqual(inspectBlock('See <junior> in the docs.\n'), { state: 'absent' });
});

test('inspectBlock locates the block boundaries and inner content', () => {
  const text = 'head\n<junior>\nbody\n</junior>\ntail\n';
  assert.deepEqual(inspectBlock(text), {
    state: 'present',
    start: 5,
    end: 29,
    content: 'body\n',
  });
});

test('inspectBlock ignores a tag shown inside a backtick fence', () => {
  const text = ['```markdown', '<junior>', 'example', '</junior>', '```', ''].join('\n');
  assert.deepEqual(inspectBlock(text), { state: 'absent' });
});

test('inspectBlock ignores a tag shown inside a tilde fence', () => {
  const text = ['~~~markdown', '<junior>', 'example', '</junior>', '~~~', ''].join('\n');
  assert.deepEqual(inspectBlock(text), { state: 'absent' });
});

test('inspectBlock reports duplicate when two complete blocks exist', () => {
  const text = block('one') + block('two');
  const result = inspectBlock(text);
  assert.equal(result.state === 'conflict' ? result.reason : result.state, 'duplicate');
});

test('inspectBlock reports nested when an opening tag appears inside a block', () => {
  const text = '<junior>\nouter\n<junior>\ninner\n</junior>\n</junior>\n';
  const result = inspectBlock(text);
  assert.equal(result.state === 'conflict' ? result.reason : result.state, 'nested');
});

test('inspectBlock reports unbalanced for a missing closing tag', () => {
  const result = inspectBlock('<junior>\nbody\n');
  assert.equal(result.state === 'conflict' ? result.reason : result.state, 'unbalanced');
});

test('inspectBlock reports unbalanced for a stray closing tag', () => {
  const result = inspectBlock('body\n</junior>\n');
  assert.equal(result.state === 'conflict' ? result.reason : result.state, 'unbalanced');
});

// --- upsertBlock: appending -------------------------------------------------

test('upsertBlock turns an empty file into just the managed block', () => {
  assert.equal(upsertBlock('', CONTENT).text, block());
});

test('upsertBlock appends after text that has no trailing newline', () => {
  assert.equal(upsertBlock('Intro', CONTENT).text, `Intro\n\n${block()}`);
});

test('upsertBlock appends after text that has one trailing newline', () => {
  assert.equal(upsertBlock('Intro\n', CONTENT).text, `Intro\n\n${block()}`);
});

test('upsertBlock always adds its own blank separator so a remove restores the file', () => {
  assert.equal(upsertBlock('Intro\n\n', CONTENT).text, `Intro\n\n\n${block()}`);
});

test('upsertBlock trims only the trailing whitespace of the content', () => {
  assert.equal(
    upsertBlock('', 'Use Junior.\n\n').text,
    `<junior>\nUse Junior.\n</junior>\n`,
  );
});

// --- upsertBlock: replacing and idempotence ---------------------------------

test('upsertBlock replaces only the lines between existing tags', () => {
  const text = 'before\n\n<junior>\nold\n</junior>\nafter\n';
  assert.equal(
    upsertBlock(text, 'new content').text,
    'before\n\n<junior>\nnew content\n</junior>\nafter\n',
  );
});

test('upsertBlock marks a first write as changed', () => {
  assert.equal(upsertBlock('Intro\n', CONTENT).changed, true);
});

test('upsertBlock returns the input text unchanged when the content already matches', () => {
  const first = upsertBlock('Intro\n', CONTENT);
  assert.equal(upsertBlock(first.text, CONTENT).text, first.text);
});

test('upsertBlock marks an already-matching write as unchanged', () => {
  const first = upsertBlock('Intro\n', CONTENT);
  assert.equal(upsertBlock(first.text, CONTENT).changed, false);
});

test('upsertBlock reports a conflict instead of writing when tags are duplicated', () => {
  const result = upsertBlock(block('one') + block('two'), CONTENT);
  assert.deepEqual('conflict' in result ? result.conflict.reason : 'written', 'duplicate');
});

// --- CRLF -------------------------------------------------------------------

test('upsertBlock uses CRLF for every line in a CRLF file', () => {
  assert.equal(
    upsertBlock('Intro\r\n', CONTENT).text,
    `Intro\r\n\r\n<junior>\r\nUse Junior.\r\n</junior>\r\n`,
  );
});

test('upsertBlock replaces a CRLF block without introducing LF-only lines', () => {
  const text = 'before\r\n\r\n<junior>\r\nold\r\n</junior>\r\nafter\r\n';
  assert.equal(
    upsertBlock(text, 'new content').text,
    'before\r\n\r\n<junior>\r\nnew content\r\n</junior>\r\nafter\r\n',
  );
});

// --- removeBlock ------------------------------------------------------------

test('removeBlock reverses upsertBlock for a text with a trailing newline', () => {
  const original = 'Intro\n';
  const written = upsertBlock(original, CONTENT);
  assert.equal(removeBlock(written.text).text, original);
});

test('removeBlock reverses upsertBlock for a CRLF text', () => {
  const original = 'Intro\r\n';
  const written = upsertBlock(original, CONTENT);
  assert.equal(removeBlock(written.text).text, original);
});

test('removeBlock is a no-op when the block is absent', () => {
  assert.equal(removeBlock('Just instructions.\n').text, 'Just instructions.\n');
});

test('removeBlock marks an absent block as unchanged', () => {
  assert.equal(removeBlock('Just instructions.\n').changed, false);
});

test('removeBlock reports a conflict instead of editing when tags are unbalanced', () => {
  const result = removeBlock('<junior>\nbody\n');
  assert.deepEqual('conflict' in result ? result.conflict.reason : 'removed', 'unbalanced');
});

test('removeBlock keeps a blank line the user already had at the end of the file', () => {
  const original = 'Tail\n\n';
  const added = upsertBlock(original, 'Use Junior.');
  assert.ok('text' in added);
  const removed = removeBlock(added.text);
  assert.equal('text' in removed ? removed.text : null, original);
});

test('removeBlock leaves the newline that ended a last line which had none', () => {
  const added = upsertBlock('Tail without newline', 'Use Junior.');
  assert.ok('text' in added);
  const removed = removeBlock(added.text);
  assert.equal('text' in removed ? removed.text : null, 'Tail without newline\n');
});
