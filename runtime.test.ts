// ---------------------------------------------------------------------------
// Focused behavioral tests for stream compaction in executeWorkerStreaming.
//
// Each scenario drives the public streaming runtime with a synthetic Pi child
// and asserts one observable outcome on the returned result or the persisted
// events.jsonl / tool-output sidecar. No private internals are inspected.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { executeWorkerStreaming, executeCheck, EXECUTION_DEFAULTS, TOOL_TEXT_LIMIT_BYTES } from './runtime.ts';
import { parseReceipt, receiptValid } from './worker.ts';

const fakeChild = () => {
  const ee = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exited = false;
  const state = { killed: false, killSignals: [] as string[] };
  const finish = (code: number | null, sig: string | null) => {
    if (exited) return;
    exited = true;
    stdout.end();
    stderr.end();
    ee.emit('exit', code, sig);
    ee.emit('close', code, sig);
  };
  const child: any = {
    pid: 0,
    stdout,
    stderr,
    on: (event: string, cb: any) => { ee.on(event, cb); return child; },
    kill: (sig?: string) => { state.killed = true; state.killSignals.push(sig || 'SIGTERM'); finish(null, sig || 'SIGTERM'); return true; },
  };
  const emit = (ev: any) => stdout.write(JSON.stringify(ev) + '\n');
  const emitRaw = (line: string) => stdout.write(line);
  const end = (code = 0) => finish(code, null);
  return { child, emit, emitRaw, end, state };
};

const runStream = (dir: string, over: any = {}) => {
  const fake = fakeChild();
  const promise = executeWorkerStreaming({
    spawnChild: () => fake.child,
    command: 'pi',
    args: [],
    cwd: dir,
    eventsPath: join(dir, 'events.jsonl'),
    logPath: join(dir, 'worker.log'),
    runtimePath: join(dir, 'runtime.json'),
    settings: { ...EXECUTION_DEFAULTS, quietMs: 100000, heartbeatMs: 20 },
    deadlineAt: Date.now() + 60000,
    ...over,
  });
  return { fake, promise };
};

const eventsPathFor = (dir: string) => join(dir, 'events.jsonl');
const readEvents = (dir: string) => readFileSync(eventsPathFor(dir), 'utf8');

test('A message_update and tool_execution_update stream above the cap does not stop the run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-drop-cap-'));
  const { fake, promise } = runStream(dir, { maxOutputBytes: 64 * 1024 });
  const line = JSON.stringify({ type: 'message_update', message: { role: 'assistant' } }) + '\n';
  const update = JSON.stringify({ type: 'tool_execution_update', toolCallId: 'c1', toolName: 'bash' }) + '\n';
  for (let i = 0; i < Math.ceil((64 * 1024) / line.length); i++) fake.emitRaw(line);
  for (let i = 0; i < Math.ceil((64 * 1024) / update.length); i++) fake.emitRaw(update);
  fake.emit({ type: 'agent_settled' });
  fake.end(0);
  const res = await promise;
  assert.equal(res.outputTruncated, false);
});

test('A dropped-update stream persists no message_update or tool_execution_update lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-drop-absent-'));
  const { fake, promise } = runStream(dir);
  fake.emit({ type: 'message_update', message: { role: 'assistant' } });
  fake.emit({ type: 'tool_execution_update', toolCallId: 'c1', toolName: 'bash' });
  fake.emit({ type: 'agent_settled' });
  fake.end(0);
  await promise;
  const persisted = readEvents(dir);
  assert.ok(!persisted.includes('message_update') && !persisted.includes('tool_execution_update'));
});

test('A dropped-update stream still yields a valid receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-drop-receipt-'));
  const { fake, promise } = runStream(dir);
  for (let i = 0; i < 500; i++) fake.emit({ type: 'message_update', message: { role: 'assistant' } });
  fake.emit({ type: 'message_end', message: { role: 'assistant', provider: 'openrouter', model: 'm', stopReason: 'stop', usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } });
  fake.emit({ type: 'agent_settled' });
  fake.end(0);
  const res = await promise;
  assert.equal(receiptValid(parseReceipt(res.stdout, { provider: 'openrouter', model: 'm' })), true);
});

test('A malformed non-JSON line is persisted verbatim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-malformed-'));
  const { fake, promise } = runStream(dir);
  fake.emitRaw('{not json at all}\n');
  fake.emit({ type: 'agent_settled' });
  fake.end(0);
  await promise;
  assert.ok(readEvents(dir).includes('{not json at all}\n'));
});

test('A turn_end line is persisted with only its toolResultCount', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-turn-end-'));
  const { fake, promise } = runStream(dir);
  fake.emit({ type: 'turn_end', message: { role: 'assistant' }, toolResults: [{ a: 1 }, { b: 2 }] });
  fake.end(0);
  await promise;
  const line = readEvents(dir).split('\n').find((l: string) => l.includes('turn_end'))!;
  assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ['toolResultCount', 'type']);
});

test('An agent_end line is persisted with only its willRetry and messageCount', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-agent-end-'));
  const { fake, promise } = runStream(dir);
  fake.emit({ type: 'agent_end', willRetry: true, messages: [{ a: 1 }, { b: 2 }, { c: 3 }] });
  fake.end(0);
  await promise;
  const line = readEvents(dir).split('\n').find((l: string) => l.includes('agent_end'))!;
  assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ['messageCount', 'type', 'willRetry']);
});

test('An oversized tool text block is persisted with the omission marker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-tool-marker-'));
  const { fake, promise } = runStream(dir);
  const big = 'x'.repeat(5 * 1024 * 1024);
  fake.emit({ type: 'tool_execution_end', toolCallId: 'tc-9', toolName: 'read', result: { content: [{ type: 'text', text: big }] } });
  fake.end(0);
  await promise;
  const line = readEvents(dir).split('\n').find((l: string) => l.includes('tool_execution_end'))!;
  const text = JSON.parse(line).result.content[0].text as string;
  assert.ok(text.includes('bytes omitted; full text: tool-output/tc-9.txt'));
});

test('An oversized tool text block is persisted with at most 32 KiB plus the marker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-tool-bound-'));
  const { fake, promise } = runStream(dir);
  const big = 'x'.repeat(5 * 1024 * 1024);
  fake.emit({ type: 'tool_execution_end', toolCallId: 'tc-9', toolName: 'read', result: { content: [{ type: 'text', text: big }] } });
  fake.end(0);
  await promise;
  const line = readEvents(dir).split('\n').find((l: string) => l.includes('tool_execution_end'))!;
  const text = JSON.parse(line).result.content[0].text as string;
  const marker = text.slice(text.indexOf('[...'), text.indexOf('...]') + 4);
  assert.ok(text.length <= TOOL_TEXT_LIMIT_BYTES + marker.length + 2);
});

test('An oversized tool text block is written in full to its sidecar file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-tool-sidecar-'));
  const { fake, promise } = runStream(dir);
  const big = 'y'.repeat(5 * 1024 * 1024);
  fake.emit({ type: 'tool_execution_end', toolCallId: 'tc-9', toolName: 'read', result: { content: [{ type: 'text', text: big }] } });
  fake.end(0);
  await promise;
  const sidecar = join(dir, 'tool-output', 'tc-9.txt');
  assert.equal(readFileSync(sidecar, 'utf8').length, big.length);
});

test('A toolResult message_end oversized text block is written to its sidecar file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-toolresult-sidecar-'));
  const { fake, promise } = runStream(dir);
  const big = 'z'.repeat(1024 * 1024);
  fake.emit({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'tr-3', content: [{ type: 'text', text: big }] } });
  fake.end(0);
  await promise;
  assert.equal(readFileSync(join(dir, 'tool-output', 'tr-3.txt'), 'utf8').length, big.length);
});

test('Retained verbatim lines beyond the cap still stop the run as output_truncated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-retain-cap-'));
  const { fake, promise } = runStream(dir, { maxOutputBytes: 8 * 1024 });
  const line = JSON.stringify({ type: 'session', id: 's', pad: 'q'.repeat(400) }) + '\n';
  for (let i = 0; i < 60; i++) fake.emitRaw(line);
  fake.end(0);
  const res = await promise;
  assert.equal(res.outputTruncated, true);
});

test('Dropped events beyond eight times the cap stop the run as output_truncated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-raw-cap-'));
  const { fake, promise } = runStream(dir, { maxOutputBytes: 8 * 1024 });
  const line = JSON.stringify({ type: 'message_update', message: { role: 'assistant' } }) + '\n';
  for (let i = 0; i < Math.ceil((80 * 1024) / line.length); i++) fake.emitRaw(line);
  fake.end(0);
  const res = await promise;
  assert.equal(res.outputTruncated, true);
});

test('Twenty MiB of dropped update events completes without output truncation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-20mib-'));
  const { fake, promise } = runStream(dir);
  const line = JSON.stringify({ type: 'message_update', message: { role: 'assistant' } }) + '\n';
  const count = Math.ceil((20 * 1024 * 1024) / line.length);
  for (let i = 0; i < count; i++) fake.emitRaw(line);
  fake.emit({ type: 'message_end', message: { role: 'assistant', provider: 'openrouter', model: 'm', stopReason: 'stop', usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } });
  fake.emit({ type: 'agent_settled' });
  fake.end(0);
  const res = await promise;
  assert.equal(res.outputTruncated, false);
});

test('A line that exceeds the remaining budget is retained whole or not at all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-atomic-line-'));
  const { fake, promise } = runStream(dir, { maxOutputBytes: 1024 });
  fake.emitRaw(JSON.stringify({ type: 'agent_settled', pad: 'a'.repeat(200) }) + '\n');
  fake.emitRaw(JSON.stringify({ type: 'agent_settled', pad: 'b'.repeat(900) }) + '\n');
  fake.end(0);
  await promise;
  const lines = readEvents(dir).split('\n').filter((l: string) => l.length > 0);
  assert.ok(lines.every((l: string) => { try { JSON.parse(l); return true; } catch { return false; } }));
});

test('A line that exceeds the remaining budget marks the result output_truncated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-trunc-flag-'));
  const { fake, promise } = runStream(dir, { maxOutputBytes: 1024 });
  fake.emitRaw(JSON.stringify({ type: 'agent_settled', pad: 'a'.repeat(200) }) + '\n');
  fake.emitRaw(JSON.stringify({ type: 'agent_settled', pad: 'b'.repeat(900) }) + '\n');
  fake.end(0);
  const res = await promise;
  assert.equal(res.outputTruncated, true);
});

test('A line that exceeds the remaining budget reports output_truncated as the stop reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-trunc-reason-'));
  const { fake, promise } = runStream(dir, { maxOutputBytes: 1024 });
  fake.emitRaw(JSON.stringify({ type: 'agent_settled', pad: 'a'.repeat(200) }) + '\n');
  fake.emitRaw(JSON.stringify({ type: 'agent_settled', pad: 'b'.repeat(900) }) + '\n');
  fake.end(0);
  const res = await promise;
  assert.equal(res.stopReason, 'output_truncated');
});

test('outputBreakdown.byType counts dropped message_update bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-bytype-'));
  const { fake, promise } = runStream(dir);
  const raw = JSON.stringify({ type: 'message_update', message: { role: 'assistant' } });
  for (let i = 0; i < 100; i++) fake.emitRaw(raw + '\n');
  fake.emit({ type: 'agent_settled' });
  fake.end(0);
  const res = await promise;
  assert.equal(res.outputBreakdown.byType.message_update, 100 * raw.length);
});

test('outputBreakdown.largestToolResults keeps the three largest results, largest first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-largest-'));
  const { fake, promise } = runStream(dir);
  fake.emit({ type: 'tool_execution_end', toolCallId: 'small', toolName: 'read', result: { content: [{ type: 'text', text: 'a'.repeat(100) }] } });
  fake.emit({ type: 'tool_execution_end', toolCallId: 'mid', toolName: 'read', result: { content: [{ type: 'text', text: 'b'.repeat(300) }] } });
  fake.emit({ type: 'tool_execution_end', toolCallId: 'big', toolName: 'read', result: { content: [{ type: 'text', text: 'c'.repeat(500) }] } });
  fake.emit({ type: 'tool_execution_end', toolCallId: 'huge', toolName: 'read', result: { content: [{ type: 'text', text: 'd'.repeat(700) }] } });
  fake.end(0);
  const res = await promise;
  assert.deepEqual(res.outputBreakdown.largestToolResults.map((r: any) => r.toolCallId), ['huge', 'big', 'mid']);
});

test('outputBreakdown.retainedBytes equals the retained stdout length', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-retained-'));
  const { fake, promise } = runStream(dir);
  fake.emit({ type: 'agent_settled' });
  fake.emit({ type: 'session', id: 's' });
  fake.end(0);
  const res = await promise;
  assert.equal(res.outputBreakdown.retainedBytes, res.stdout.length);
});

test('executeCheck counts raw stdout bytes in its outputBreakdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-check-bd-'));
  const fake = fakeChild();
  const promise = executeCheck({
    spawnChild: () => fake.child,
    command: 'pi',
    args: [],
    cwd: dir,
    timeoutMs: 5000,
    deadlineAt: Date.now() + 60000,
  });
  fake.emitRaw('line one\n');
  fake.emitRaw('line two\n');
  fake.end(0);
  const res = await promise;
  assert.equal(res.outputBreakdown.rawBytes, 18);
});

test('outputBreakdown.largestToolResults lists a tool call once when it also arrives as a toolResult message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'junior-rt-'));
  const { fake, promise } = runStream(dir);
  fake.emit({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: { content: [{ type: 'text', text: 'x'.repeat(500) }] } });
  fake.emit({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'x'.repeat(500) }] } });
  fake.end(0);
  const res: any = await promise;
  assert.deepEqual(res.outputBreakdown.largestToolResults.map((r: any) => r.toolCallId), ['c1']);
});
