// Behavioral tests for ADR project configuration (ADR 0018 R1, R2).
//
// Each scenario is atomic: one observable outcome per test, driven through the
// public functions of `adr-config.ts`. Temporary directories stand in for a
// project checkout; no network or model call is made.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adrExcludePatterns,
  adrFilePattern,
  adrIdFromFileName,
  excludeMatcher,
  defaultGate,
  detectAdrDir,
  detectAdrFormat,
  proposeAdrConfig,
  readAdrConfig,
  writeAdrConfig,
  type AdrConfig,
} from './adr-config.ts';

function project(t: any): string {
  const root = mkdtempSync(join(tmpdir(), 'junior-adr-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function touch(root: string, path: string, content = ''): string {
  const absolute = join(root, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
  return absolute;
}

function adrBlock(overrides: Partial<AdrConfig> = {}): AdrConfig {
  return { dir: 'docs/adr', format: 'junior', gate: 'enforce', ...overrides };
}

const JUNIOR_ADR = [
  '---',
  'id: ADR-0001',
  'title: Store state once',
  'status: accepted',
  'date: 2026-01-01',
  'supersedes: []',
  'applies_to: [docs/**]',
  'rules:',
  '  - id: R1',
  '    text: Store state exactly once.',
  '---',
  '',
  '## Context',
  '',
  'Context.',
  '',
  '## Decision',
  '',
  'Decision.',
  '',
].join('\n');

const PROPOSED_JUNIOR_ADR = JUNIOR_ADR.replace('status: accepted', 'status: proposed');

// --- detectAdrDir -----------------------------------------------------------

test('detectAdrDir returns null when no candidate directory exists', (t) => {
  assert.equal(detectAdrDir(project(t)), null);
});

for (const path of ['docs/adr', 'docs/decisions', 'doc/architecture/decisions', 'adr', 'architecture/decisions']) {
  test(`detectAdrDir finds ${path} as a default path`, (t) => {
    const root = project(t);
    mkdirSync(join(root, path), { recursive: true });
    assert.deepEqual(detectAdrDir(root), { dir: path, source: 'default-path' });
  });
}

test('detectAdrDir prefers the .adr-dir target over a default path', (t) => {
  const root = project(t);
  mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
  mkdirSync(join(root, 'decisions'), { recursive: true });
  touch(root, '.adr-dir', 'decisions\n');
  assert.deepEqual(detectAdrDir(root), { dir: 'decisions', source: '.adr-dir' });
});

test('detectAdrDir reads the trimmed first line of .adr-dir', (t) => {
  const root = project(t);
  mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
  touch(root, '.adr-dir', '  docs/decisions  \nignored second line\n');
  assert.equal(detectAdrDir(root)?.dir, 'docs/decisions');
});

test('detectAdrDir falls back to defaults when the .adr-dir target is absent', (t) => {
  const root = project(t);
  mkdirSync(join(root, 'adr'), { recursive: true });
  touch(root, '.adr-dir', 'missing/decisions\n');
  assert.deepEqual(detectAdrDir(root), { dir: 'adr', source: 'default-path' });
});

test('detectAdrDir picks the earliest default path when several exist', (t) => {
  const root = project(t);
  mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
  mkdirSync(join(root, 'architecture', 'decisions'), { recursive: true });
  assert.equal(detectAdrDir(root)?.dir, 'docs/decisions');
});

// --- detectAdrFormat --------------------------------------------------------

test('detectAdrFormat recognises Junior front matter with an ADR id', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/0001-store-state.md', JUNIOR_ADR);
  assert.equal(detectAdrFormat(join(root, 'docs', 'adr')), 'junior');
});

test('detectAdrFormat recognises a MADR Decision Outcome heading', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/0001-store-state.md', '# Store state\n\n## Decision Outcome\n\nKeep one copy.\n');
  assert.equal(detectAdrFormat(join(root, 'docs', 'adr')), 'madr');
});

test('detectAdrFormat recognises a MADR Considered Options heading', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/0001-store-state.md', '# Store state\n\n## Considered Options\n\n* One copy\n');
  assert.equal(detectAdrFormat(join(root, 'docs', 'adr')), 'madr');
});

test('detectAdrFormat falls back to nygard when neither marker is present', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/0001-store-state.md', '# Store state\n\nStatus: Accepted\n\n## Decision\n\nKeep one copy.\n');
  assert.equal(detectAdrFormat(join(root, 'docs', 'adr')), 'nygard');
});

test('detectAdrFormat treats an empty directory as nygard', (t) => {
  const root = project(t);
  mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
  assert.equal(detectAdrFormat(join(root, 'docs', 'adr')), 'nygard');
});

test('detectAdrFormat prefers Junior front matter over a MADR heading', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/0001-store-state.md', JUNIOR_ADR.replace('## Decision', '## Decision Outcome'));
  assert.equal(detectAdrFormat(join(root, 'docs', 'adr')), 'junior');
});

// --- defaultGate ------------------------------------------------------------

test('defaultGate enforces when a Junior ADR is accepted', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/0001-store-state.md', JUNIOR_ADR);
  assert.equal(defaultGate(join(root, 'docs', 'adr')), 'enforce');
});

test('defaultGate is off when the only Junior ADR is proposed', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/0001-store-state.md', PROPOSED_JUNIOR_ADR);
  assert.equal(defaultGate(join(root, 'docs', 'adr')), 'off');
});

test('defaultGate enforces on a mixed Junior and Nygard collection', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/0001-proposed.md', PROPOSED_JUNIOR_ADR);
  touch(root, 'docs/adr/0002-accepted.md', '# 2. Use a queue\n\nStatus: Accepted\n\n## Decision\n\nUse a queue.\n');
  assert.equal(defaultGate(join(root, 'docs', 'adr')), 'enforce');
});

test('defaultGate is off on a mixed collection with no accepted record', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/0001-proposed.md', PROPOSED_JUNIOR_ADR);
  touch(root, 'docs/adr/0002-proposed.md', '# 2. Use a queue\n\nStatus: Proposed\n\n## Decision\n\nUse a queue.\n');
  assert.equal(defaultGate(join(root, 'docs', 'adr')), 'off');
});

test('defaultGate enforces on an accepted MADR status line', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/0001-store-state.md', '# Store state\n\nStatus: Accepted\n\n## Decision\n\nKeep one copy.\n');
  assert.equal(defaultGate(join(root, 'docs', 'adr')), 'enforce');
});

test('defaultGate is off on a rejected MADR status line', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/0001-store-state.md', '# Store state\n\nStatus: Rejected\n\n## Decision\n\nKeep one copy.\n');
  assert.equal(defaultGate(join(root, 'docs', 'adr')), 'off');
});

test('defaultGate enforces on an Accepted Nygard Status section', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/0001-store-state.md', '# Store state\n\n## Status\n\nAccepted\n\n## Decision\n\nKeep one copy.\n');
  assert.equal(defaultGate(join(root, 'docs', 'adr')), 'enforce');
});

test('defaultGate is off when a directory has no records', (t) => {
  const root = project(t);
  mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
  assert.equal(defaultGate(join(root, 'docs', 'adr')), 'off');
});

// --- readAdrConfig ----------------------------------------------------------

test('readAdrConfig returns null when delivery.config.json is absent', (t) => {
  assert.equal(readAdrConfig(project(t)), null);
});

test('readAdrConfig returns null when the adr block is absent', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ provider: 'openrouter' }));
  assert.equal(readAdrConfig(root), null);
});

test('readAdrConfig reads a complete adr block', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ adr: adrBlock() }));
  assert.deepEqual(readAdrConfig(root), adrBlock());
});

test('readAdrConfig keeps an explicit minConfidence', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ adr: adrBlock({ minConfidence: 0.7 }) }));
  assert.equal(readAdrConfig(root)?.minConfidence, 0.7);
});

test('readAdrConfig rejects an unknown gate and names the field', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ adr: { ...adrBlock(), gate: 'sometimes' } }));
  assert.throws(() => readAdrConfig(root), /gate/);
});

test('readAdrConfig rejects an unknown format and names the field', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ adr: { ...adrBlock(), format: 'rfc' } }));
  assert.throws(() => readAdrConfig(root), /format/);
});

test('readAdrConfig rejects a non-string dir and names the field', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ adr: { ...adrBlock(), dir: 7 } }));
  assert.throws(() => readAdrConfig(root), /dir/);
});

test('readAdrConfig rejects minConfidence below zero and names the field', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ adr: adrBlock({ minConfidence: -0.1 }) }));
  assert.throws(() => readAdrConfig(root), /minConfidence/);
});

test('readAdrConfig rejects minConfidence above one and names the field', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ adr: adrBlock({ minConfidence: 1.1 }) }));
  assert.throws(() => readAdrConfig(root), /minConfidence/);
});

// --- proposeAdrConfig -------------------------------------------------------

test('proposeAdrConfig returns null when no ADR directory can be detected', (t) => {
  assert.equal(proposeAdrConfig(project(t)), null);
});

test('proposeAdrConfig combines the detected directory, format and gate', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/0001-store-state.md', JUNIOR_ADR);
  assert.deepEqual(proposeAdrConfig(root), { dir: 'docs/adr', format: 'junior', gate: 'enforce' });
});

test('proposeAdrConfig writes nothing', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/0001-store-state.md', JUNIOR_ADR);
  proposeAdrConfig(root);
  assert.equal(existsSync(join(root, 'delivery.config.json')), false);
});

// --- writeAdrConfig ---------------------------------------------------------

test('writeAdrConfig creates delivery.config.json when absent', (t) => {
  const root = project(t);
  writeAdrConfig(root, adrBlock());
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'delivery.config.json'), 'utf8')), { adr: adrBlock() });
});

test('writeAdrConfig preserves every other top-level key', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ provider: 'openrouter', compact: { repos: ['a/b'] } }));
  writeAdrConfig(root, adrBlock());
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'delivery.config.json'), 'utf8')).compact, { repos: ['a/b'] });
});

test('writeAdrConfig replaces an existing adr block', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ adr: { dir: 'old', format: 'nygard', gate: 'off' } }));
  writeAdrConfig(root, adrBlock());
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'delivery.config.json'), 'utf8')).adr, adrBlock());
});

test('writeAdrConfig formats with two spaces and a trailing newline', (t) => {
  const root = project(t);
  writeAdrConfig(root, adrBlock());
  const raw = readFileSync(join(root, 'delivery.config.json'), 'utf8');
  assert.equal(raw, JSON.stringify({ adr: adrBlock() }, null, 2) + '\n');
});

// --- configurable file patterns --------------------------------------------

const ADR_PREFIX_PATTERN = '^ADR-(?<number>\\d+[a-z]?)-(?<slug>.+)\\.md$';

test('readAdrConfig rejects a filePattern that is not a valid regular expression', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ adr: adrBlock({ filePattern: '[unclosed' }) }));
  assert.throws(
    () => readAdrConfig(root),
    /adr\.filePattern must be a regular expression with a named group 'number'/,
  );
});

test('readAdrConfig rejects a filePattern without a number named group', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ adr: adrBlock({ filePattern: '^ADR-(?<id>\\d+)-.*\\.md$' }) }));
  assert.throws(
    () => readAdrConfig(root),
    /adr\.filePattern must be a regular expression with a named group 'number'/,
  );
});

test('readAdrConfig keeps a valid filePattern', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ adr: adrBlock({ filePattern: ADR_PREFIX_PATTERN }) }));
  assert.equal(readAdrConfig(root)?.filePattern, ADR_PREFIX_PATTERN);
});

test('adrIdFromFileName keeps the number group text as the id', () => {
  assert.deepEqual(adrIdFromFileName('ADR-008a-title.md', adrFilePattern({ filePattern: ADR_PREFIX_PATTERN })), {
    id: 'ADR-008a',
    number: 8,
  });
});

test('adrIdFromFileName uses the default NNNN prefix with no configuration', () => {
  assert.equal(adrIdFromFileName('0007-title.md', adrFilePattern())?.id, 'ADR-0007');
});

test('detectAdrFormat uses the configured pattern to find Junior records', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/ADR-001-store-state.md', JUNIOR_ADR);
  assert.equal(detectAdrFormat(join(root, 'docs', 'adr'), { filePattern: ADR_PREFIX_PATTERN }), 'junior');
});

test('detectAdrFormat recognises Junior front matter with a suffixed id', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/ADR-008a-store-state.md', JUNIOR_ADR.replace('id: ADR-0001', 'id: ADR-008a'));
  assert.equal(detectAdrFormat(join(root, 'docs', 'adr'), { filePattern: ADR_PREFIX_PATTERN }), 'junior');
});

test('defaultGate uses the configured pattern to find accepted records', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/ADR-001-store-state.md', JUNIOR_ADR);
  assert.equal(defaultGate(join(root, 'docs', 'adr'), { filePattern: ADR_PREFIX_PATTERN }), 'enforce');
});

test('detectAdrDir returns a conventional folder in its real case', (t) => {
  const root = project(t);
  mkdirSync(join(root, 'Docs', 'adr'), { recursive: true });
  assert.equal(detectAdrDir(root)?.dir, 'Docs/adr');
});

test('proposeAdrConfig proposes the ADR prefix pattern for ADR-named records', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/ADR-001-store-state.md', JUNIOR_ADR);
  assert.equal(proposeAdrConfig(root)?.filePattern, ADR_PREFIX_PATTERN);
});

test('proposeAdrConfig omits filePattern for default NNNN records', (t) => {
  const root = project(t);
  touch(root, 'docs/adr/0001-store-state.md', JUNIOR_ADR);
  assert.equal(proposeAdrConfig(root)?.filePattern, undefined);
});

// --- NO_DISCRIMINATION thresholds ------------------------------------------

test('readAdrConfig keeps minDiscriminationCells', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ adr: adrBlock({ minDiscriminationCells: 25 }) }));
  assert.equal(readAdrConfig(root)?.minDiscriminationCells, 25);
});

test('readAdrConfig keeps maxUncertainRatio', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ adr: adrBlock({ maxUncertainRatio: 0.8 }) }));
  assert.equal(readAdrConfig(root)?.maxUncertainRatio, 0.8);
});

test('readAdrConfig rejects a negative minDiscriminationCells and names the field', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ adr: adrBlock({ minDiscriminationCells: -1 }) }));
  assert.throws(() => readAdrConfig(root), /minDiscriminationCells/);
});

test('readAdrConfig rejects maxUncertainRatio above one and names the field', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ adr: adrBlock({ maxUncertainRatio: 1.1 }) }));
  assert.throws(() => readAdrConfig(root), /maxUncertainRatio/);
});

// --- Exclude globs (issue #291) ---------------------------------------------

const DEFAULT_EXCLUDED = excludeMatcher(adrExcludePatterns({}));

for (const path of [
  'src/generated/client.ts',
  'Api/Generated.cs',
  'Api/Models.Generated.cs',
  'vendor/lib/a.go',
  'web/node_modules/x/index.js',
  'package-lock.json',
  'app/yarn.lock',
  'dist/cli.js',
]) {
  test(`the default exclude globs skip ${path}`, () => {
    assert.equal(DEFAULT_EXCLUDED(path), true);
  });
}

test('the default exclude globs keep an ordinary source file', () => {
  assert.equal(DEFAULT_EXCLUDED('src/generator.ts'), false);
});

test('adr.exclude adds globs to the defaults', () => {
  assert.equal(excludeMatcher(adrExcludePatterns({exclude: ['proto/**']}))('proto/a.pb.go'), true);
});

test('adr.excludeDefaults false leaves only adr.exclude', () => {
  assert.equal(excludeMatcher(adrExcludePatterns({excludeDefaults: false, exclude: ['proto/**']}))('src/generated/a.ts'), false);
});

test('readAdrConfig reads adr.exclude', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ adr: adrBlock({ exclude: ['proto/**'] }) }));
  assert.deepEqual(readAdrConfig(root)?.exclude, ['proto/**']);
});

test('readAdrConfig rejects a non-array adr.exclude', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ adr: adrBlock({ exclude: 'proto/**' } as any) }));
  assert.throws(() => readAdrConfig(root), /adr\.exclude/);
});

test('readAdrConfig rejects a negative adr.prefilterCells', (t) => {
  const root = project(t);
  touch(root, 'delivery.config.json', JSON.stringify({ adr: adrBlock({ prefilterCells: -1 }) }));
  assert.throws(() => readAdrConfig(root), /prefilterCells/);
});
