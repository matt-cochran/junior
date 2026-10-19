// Behavioral tests for Junior's commodity model roster and project model
// configuration.
//
// loadModelConfig resolves a project's delivery.config.json on top of the
// built-in OpenRouter commodity roster, moves any non-default profile that the
// model policy refuses into `rejected`, and surfaces a frontier/unknown pin
// through `pinnedVerdict` instead of rewriting it.
//
// Every scenario is offline and deterministic. Filesystem access is injected
// except for one on-disk integration test, and each test asserts exactly one
// observable outcome through the module's public API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BUILTIN_ROSTER,
  DEFAULT_ROUTING,
  findProfile,
  loadModelConfig,
  rosterChoiceCriteria,
} from './roster.ts';

const CWD = '/project';
const CONFIG_PATH = join(CWD, 'delivery.config.json');

function fakeFs(files: Record<string, string>) {
  return {
    existsSync: (p: string) => Object.hasOwn(files, p),
    readFileSync: (p: string) => {
      if (!Object.hasOwn(files, p)) throw new Error(`missing ${p}`);
      return files[p];
    },
  };
}

function fromJson(value: unknown): ReturnType<typeof loadModelConfig> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return loadModelConfig(CWD, fakeFs({ [CONFIG_PATH]: text }));
}

function noConfig(): ReturnType<typeof loadModelConfig> {
  return loadModelConfig(CWD, fakeFs({}));
}

// --- missing configuration -------------------------------------------------

test('loadModelConfig falls back to the builtin source when no config file exists', () => {
  assert.equal(noConfig().source, 'builtin');
});

test('loadModelConfig falls back to the general model when no config file exists', () => {
  assert.equal(noConfig().model, 'deepseek/deepseek-v4.1-flash');
});

test('loadModelConfig falls back to the openrouter provider when no config file exists', () => {
  assert.equal(noConfig().provider, 'openrouter');
});

test('loadModelConfig falls back to auto routing when no config file exists', () => {
  assert.equal(noConfig().routing, DEFAULT_ROUTING);
});

test('loadModelConfig returns the five builtin profiles when no config file exists', () => {
  assert.deepEqual(
    noConfig().roster.map((p) => p.id),
    ['general', 'deep-reasoning', 'long-horizon', 'agentic-tools', 'fast-mechanical'],
  );
});

test('loadModelConfig reports the general profile as the default', () => {
  assert.equal(noConfig().defaultProfile, 'general');
});

test('loadModelConfig reports no project path when no config file exists', () => {
  assert.equal(noConfig().path, null);
});

test('loadModelConfig reports the builtin pin as commodity', () => {
  assert.equal(noConfig().pinnedVerdict.class, 'commodity');
});

// --- project source --------------------------------------------------------

test('loadModelConfig reports the project source for a valid config', () => {
  assert.equal(fromJson({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' }).source, 'project');
});

test('loadModelConfig reports the config path for a valid config', () => {
  assert.equal(fromJson({}).path, CONFIG_PATH);
});

// --- pinned default --------------------------------------------------------

test('a project model pin is reported as the config model', () => {
  assert.equal(fromJson({ provider: 'openrouter', model: 'deepseek/deepseek-v4-pro-0813' }).model, 'deepseek/deepseek-v4-pro-0813');
});

test('a project model pin and the default profile agree', () => {
  const config = fromJson({ provider: 'openrouter', model: 'deepseek/deepseek-v4-pro-0813' });
  assert.equal(findProfile(config, 'general')?.model, config.model);
});

test('a project provider pin replaces the default profile provider', () => {
  const config = fromJson({ provider: 'deepseek', model: 'deepseek-chat' });
  assert.equal(findProfile(config, 'general')?.provider, 'deepseek');
});

// --- frontier pin ----------------------------------------------------------

test('a frontier top-level pin is returned unchanged', () => {
  assert.equal(fromJson({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4' }).model, 'anthropic/claude-sonnet-4');
});

test('a frontier top-level pin reports a frontier pinnedVerdict', () => {
  assert.equal(fromJson({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4' }).pinnedVerdict.class, 'frontier');
});

test('a frontier top-level pin still fills the default profile', () => {
  const config = fromJson({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4' });
  assert.equal(findProfile(config, 'general')?.model, 'anthropic/claude-sonnet-4');
});

// --- roster overrides ------------------------------------------------------

test('a project roster override changes a builtin profile model', () => {
  const config = fromJson({ models: { roster: [{ id: 'fast-mechanical', model: 'deepseek/deepseek-v4.1-flash' }] } });
  assert.equal(findProfile(config, 'fast-mechanical')?.model, 'deepseek/deepseek-v4.1-flash');
});

test('a project override of the default profile model becomes the pin', () => {
  const config = fromJson({ models: { roster: [{ id: 'general', model: 'deepseek/deepseek-v4-pro-0813' }] } });
  assert.equal(config.model, 'deepseek/deepseek-v4-pro-0813');
});

test('a disabled non-default builtin profile is removed from the roster', () => {
  const config = fromJson({ models: { roster: [{ id: 'long-horizon', disabled: true }] } });
  assert.equal(findProfile(config, 'long-horizon'), null);
});

test('the default profile cannot be disabled', () => {
  const config = fromJson({ models: { roster: [{ id: 'general', disabled: true }] } });
  assert.equal(findProfile(config, 'general')?.id, 'general');
});

test('a complete new commodity roster entry is admitted', () => {
  const config = fromJson({
    models: { roster: [{ id: 'mini', provider: 'openrouter', model: 'minimax/minimax-m3', strengths: 'Tiny tasks.' }] },
  });
  assert.equal(findProfile(config, 'mini')?.model, 'minimax/minimax-m3');
});

test('a new roster entry missing strengths is rejected', () => {
  const config = fromJson({ models: { roster: [{ id: 'mini', provider: 'openrouter', model: 'minimax/minimax-m3' }] } });
  assert.ok(config.rejected.some((r) => r.id === 'mini'));
});

// --- frontier roster entries ----------------------------------------------

test('a frontier roster entry is listed in rejected', () => {
  const config = fromJson({
    models: { roster: [{ id: 'vision', provider: 'openrouter', model: 'anthropic/claude-sonnet-4', strengths: 'Images.' }] },
  });
  assert.ok(config.rejected.some((r) => r.id === 'vision'));
});

test('a frontier roster entry is absent from the roster', () => {
  const config = fromJson({
    models: { roster: [{ id: 'vision', provider: 'openrouter', model: 'anthropic/claude-sonnet-4', strengths: 'Images.' }] },
  });
  assert.equal(findProfile(config, 'vision'), null);
});

test('a frontier roster entry carries the policy reason', () => {
  const config = fromJson({
    models: { roster: [{ id: 'vision', provider: 'openrouter', model: 'anthropic/claude-sonnet-4', strengths: 'Images.' }] },
  });
  assert.match(config.rejected.find((r) => r.id === 'vision')!.reason, /frontier/);
});

// --- routing ---------------------------------------------------------------

test('an invalid models.routing value falls back to auto', () => {
  assert.equal(fromJson({ models: { routing: 'sideways' } }).routing, 'auto');
});

test('a valid models.routing value is honored', () => {
  assert.equal(fromJson({ models: { routing: 'shadow' } }).routing, 'shadow');
});

// --- approved models -------------------------------------------------------

test('loadModelConfig reports no approved keys by default', () => {
  assert.deepEqual(noConfig().approved, []);
});

test('loadModelConfig defaults unapproved handling to ask', () => {
  assert.equal(noConfig().unapproved, 'ask');
});

test('loadModelConfig trims and de-duplicates models.approved keys', () => {
  assert.deepEqual(fromJson({ models: { approved: [' long-horizon ', 'long-horizon'] } }).approved, ['long-horizon']);
});

test('loadModelConfig drops non-string models.approved entries', () => {
  assert.deepEqual(fromJson({ models: { approved: [7, 'long-horizon', {}] } }).approved, ['long-horizon']);
});

test('loadModelConfig honors models.unapproved default', () => {
  assert.equal(fromJson({ models: { unapproved: 'default' } }).unapproved, 'default');
});

test('loadModelConfig falls back to ask for an invalid models.unapproved value', () => {
  assert.equal(fromJson({ models: { unapproved: 'sometimes' } }).unapproved, 'ask');
});

// --- malformed configuration ----------------------------------------------

test('malformed config JSON falls back to the builtin source without throwing', () => {
  assert.equal(fromJson('{ not json').source, 'builtin');
});

test('malformed config JSON falls back to the builtin model', () => {
  assert.equal(fromJson('{ not json').model, 'deepseek/deepseek-v4.1-flash');
});

// --- helpers ---------------------------------------------------------------

test('rosterChoiceCriteria maps a profile id to its strengths', () => {
  const criteria = rosterChoiceCriteria([{ id: 'general', provider: 'openrouter', model: 'm', strengths: 'Everyday work.' }]);
  assert.equal(criteria.general, 'Everyday work.');
});

test('rosterChoiceCriteria covers every builtin profile', () => {
  assert.deepEqual(Object.keys(rosterChoiceCriteria(BUILTIN_ROSTER)).sort(), BUILTIN_ROSTER.map((p) => p.id).sort());
});

test('findProfile returns null for an unknown id', () => {
  assert.equal(findProfile(noConfig(), 'nope'), null);
});

// --- on-disk integration ---------------------------------------------------

test('loadModelConfig reads a project config from disk', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'junior-roster-'));
  writeFileSync(join(cwd, 'delivery.config.json'), JSON.stringify({ provider: 'openrouter', model: 'deepseek/deepseek-v4-pro-0813' }));
  assert.equal(loadModelConfig(cwd).model, 'deepseek/deepseek-v4-pro-0813');
});

// --- repo configuration ----------------------------------------------------

test('delivery.config.json keeps provider, model, pi and gains models', () => {
  const raw = JSON.parse(readFileSync(new URL('./delivery.config.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['model', 'models', 'pi', 'provider']);
});

test('delivery.config.json sets models.routing to auto', () => {
  const raw = JSON.parse(readFileSync(new URL('./delivery.config.json', import.meta.url), 'utf8'));
  assert.equal(raw.models.routing, 'auto');
});

test('autoUpgrade is off unless delivery.config.json enables it', () => {
  assert.equal(noConfig().autoUpgrade, false);
});

test('models.autoUpgrade true enables automatic model adoption', () => {
  assert.equal(fromJson({ models: { autoUpgrade: true } }).autoUpgrade, true);
});
