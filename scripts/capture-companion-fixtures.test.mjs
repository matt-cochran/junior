// Behavioral tests for scripts/capture-companion-fixtures.mjs.
//
// Only normalization and --dry-run are covered: both run without any managed
// companion binary. Live capture is exercised by the manager's post-work
// reproduction check, not here.
//
// Conventions: atomic scenarios, declarative names, exactly one behavioral
// assertion per test, all through the public interface (the exported
// normalize/compose helpers and the script's own CLI).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, 'capture-companion-fixtures.mjs');
const fixtureIndexPath = join(here, '..', 'tools', 'test-fixtures', 'companions', 'index.json');

const {
  normalize,
  normalizeValue,
  dropNonJsonLines,
  renderJson,
  plannedRecordings,
} = await import('./capture-companion-fixtures.mjs');

const index = JSON.parse(readFileSync(fixtureIndexPath, 'utf8'));

// --- normalization: plan ids -------------------------------------------------

test('normalize_value_replaces_plan_id_with_fixture_placeholder', () => {
  const value = normalizeValue({ plan_id: 'plan_0123456789abcdef0123456789abcdef' });
  assert.equal(value.plan_id, 'plan_FIXTURE');
});

test('normalize_value_replaces_nested_plan_id_inside_arrays', () => {
  const value = normalizeValue({ locks: [{ plan_id: 'plan_deadbeefdeadbeefdeadbeefdeadbeef' }] });
  assert.equal(value.locks[0].plan_id, 'plan_FIXTURE');
});

// --- normalization: timestamps ----------------------------------------------

test('normalize_value_replaces_iso8601_timestamp_with_fixed_instant', () => {
  const value = normalizeValue({ acquired_at: '2026-10-20T14:30:31.578Z' });
  assert.equal(value.acquired_at, '2026-01-01T00:00:00Z');
});

test('normalize_value_replaces_offset_iso8601_timestamp_with_fixed_instant', () => {
  const value = normalizeValue({ as_of: '2026-10-20T14:19:51.204706+02:00' });
  assert.equal(value.as_of, '2026-01-01T00:00:00Z');
});

test('normalize_value_leaves_non_timestamp_strings_untouched', () => {
  const value = normalizeValue({ note: 'release 2026-10-20' });
  assert.equal(value.note, 'release 2026-10-20');
});

// --- normalization: token fields --------------------------------------------

test('normalize_value_replaces_lease_token_with_token_placeholder', () => {
  const value = normalizeValue({ lease_token: 'raw-secret-value' });
  assert.equal(value.lease_token, 'TOKEN');
});

test('normalize_value_replaces_token_lock_id_and_lease_id_with_token_placeholder', () => {
  const value = normalizeValue({ token: 'a', lock_id: 'b', lease_id: 'c' });
  assert.deepEqual(
    [value.token, value.lock_id, value.lease_id],
    ['TOKEN', 'TOKEN', 'TOKEN'],
  );
});

// --- normalize: parsing stdout ----------------------------------------------

test('normalize_parses_json_and_returns_normalized_value', () => {
  const value = normalize('{"plan_id":"plan_0123456789abcdef0123456789abcdef"}');
  assert.equal(value.plan_id, 'plan_FIXTURE');
});

test('normalize_drops_diagnostic_lines_before_parsing_json', () => {
  const value = normalize('junior tools: cpm plan.get revision 3 snapshot none\n{"ok":true}\n');
  assert.equal(value.ok, true);
});

test('drop_non_json_lines_drops_only_junior_tools_trailer_lines', () => {
  assert.deepEqual(dropNonJsonLines('{\n  "ok": true\n}\njunior tools: cpm plan.get revision 3 snapshot none\n'), ['{', '  "ok": true', '}']);
});

// --- rendering ---------------------------------------------------------------

test('render_json_uses_two_space_indent_and_single_trailing_newline', () => {
  assert.equal(renderJson({ a: 1 }), '{\n  "a": 1\n}\n');
});

// --- dry run -----------------------------------------------------------------

test('dry_run_lists_one_recording_line_per_index_file', () => {
  const stdout = execFileSync(process.execPath, [scriptPath, '--dry-run'], { encoding: 'utf8' });
  const expected = plannedRecordings(index).length;
  const lines = stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, expected);
});

test('dry_run_prints_a_line_naming_every_index_file', () => {
  const stdout = execFileSync(process.execPath, [scriptPath, '--dry-run'], { encoding: 'utf8' });
  const missing = plannedRecordings(index).filter((rec) => !stdout.includes(rec.file));
  assert.deepEqual(missing, []);
});

test('dry_run_exits_zero', () => {
  const result = spawnSync(process.execPath, [scriptPath, '--dry-run'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
});

test('dry_run_writes_nothing_to_stderr', () => {
  const result = spawnSync(process.execPath, [scriptPath, '--dry-run'], { encoding: 'utf8' });
  assert.equal(result.stderr, '');
});
