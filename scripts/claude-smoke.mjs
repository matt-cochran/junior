#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Real Claude Code smoke for the Crossmatrix store deny rules.
//
// `junior init` writes `.claude/settings.json`. This script creates a throwaway
// project, runs that init, then asks the real Claude Code binary to try three
// denied store reads and one allowed control command. Claude Code rejects an
// unparseable deny rule with a stderr warning, so those warnings fail the run
// even when the model would otherwise behave. `--self-test` repeats the flow
// against an offline fake binary, proving both the pass and fail verdicts
// without a model or network call. The real run needs --live, calls a model,
// and is never run in CI.
// ---------------------------------------------------------------------------

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const fakeClaude = join(repoRoot, 'scripts', 'fixtures', 'fake-claude.mjs');
const WARNING_MARKERS = ['Deny rule', 'reads its * literally', 'never matches'];
// Claude Code reports invalid or ineffective permission rules as
// `[WARN] [permissions] Permission deny rule ...` lines in its debug log; in -p
// mode they never reach stderr, so every run writes a debug file we inspect.
const DEBUG_RULE_WARNING = /\[WARN\] \[permissions\] Permission (deny|allow|ask) rule/;

const RUNS = [
  {
    name: 'grep',
    prompt: 'Use the Bash tool to run exactly this command and nothing else: grep -r x .crossmatrix',
    expectsStoreDenial: true,
  },
  {
    name: 'jq',
    prompt: 'Use the Bash tool to run exactly this command and nothing else: jq . .crossmatrix/state/a.json',
    expectsStoreDenial: true,
  },
  {
    name: 'cat',
    prompt: 'Use the Bash tool to run exactly this command and nothing else: cat .crossmatrix/README.md',
    expectsStoreDenial: true,
  },
  {
    name: 'control',
    prompt: 'Use the Bash tool to run exactly this command and nothing else: ls',
    expectsStoreDenial: false,
  },
];

function childEnv(overrides = {}) {
  return { ...process.env, ...overrides };
}

function binaryArgs(env) {
  const raw = env.CLAUDE_BIN_ARGS;
  if (raw === undefined || raw === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`CLAUDE_BIN_ARGS must be a JSON array of strings: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== 'string')) {
    throw new Error('CLAUDE_BIN_ARGS must be a JSON array of strings');
  }
  return parsed;
}

function createProject(env) {
  const dir = mkdtempSync(join(tmpdir(), 'junior-claude-smoke-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: dir, env, stdio: 'pipe' });
    mkdirSync(join(dir, '.crossmatrix', 'state'), { recursive: true });
    writeFileSync(join(dir, '.crossmatrix', 'state', 'a.json'), '{"a":1}\n');
    writeFileSync(join(dir, '.crossmatrix', 'README.md'), '# store\n');
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

function runInit(dir, env) {
  // The smoke must stay offline and must not install global tools.
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, 'junior.ts'), 'init', '--no-install', '--no-companions'],
    {
      cwd: dir,
      env: { ...env, JUNIOR_NO_INSTALL: '1', JUNIOR_NO_UPDATE_CHECK: '1' },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  if (result.error) throw new Error(`junior init could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`junior init exited ${result.status}\nstdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`);
  }
}

async function storeRules() {
  const harness = await import(pathToFileURL(join(repoRoot, 'harness.ts')).href);
  const rules = harness.CLAUDE_STORE_DENY_RULES;
  if (!Array.isArray(rules)) throw new Error('harness.ts does not export CLAUDE_STORE_DENY_RULES as an array');
  return rules;
}

function assertSettings(dir, rules) {
  const path = join(dir, '.claude', 'settings.json');
  if (!existsSync(path)) throw new Error(`${path} was not written by junior init`);
  let settings;
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`);
  }
  const deny = settings?.permissions?.deny;
  if (!Array.isArray(deny)) throw new Error(`${path} has no permissions.deny array`);
  const missing = rules.filter((rule) => !deny.includes(rule));
  if (missing.length) {
    throw new Error(`${path} is missing CLAUDE_STORE_DENY_RULES entries: ${missing.join(', ')}`);
  }
}

function runClaude(run, dir, env, debugFile) {
  const command = env.CLAUDE_BIN || 'claude';
  const model = env.CLAUDE_SMOKE_MODEL || 'haiku';
  const args = [
    ...binaryArgs(env),
    '-p', run.prompt,
    '--output-format', 'json',
    '--model', model,
    '--max-turns', '3',
    // Allow Bash outright so a denial can only come from the project deny
    // rules (deny beats allow); without it -p mode denies every unapproved
    // command and the smoke would pass with no deny rules at all.
    '--allowedTools', 'Bash',
    '--debug-file', debugFile,
  ];
  const result = spawnSync(command, args, {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (result.error) throw new Error(`${run.name}: ${command} could not start: ${result.error.message}`);
  return result;
}

/** Debug log for one run, kept outside the project so Claude Code never reads it. */
function debugFile(dir, run) {
  return `${dir}.${run.name}.debug.log`;
}

function jsonResult(run, result) {
  const stdout = (result.stdout ?? '').trim();
  if (!stdout) {
    throw new Error(`${run.name}: Claude Code wrote no JSON result\nstderr:\n${result.stderr ?? ''}`);
  }
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${run.name}: Claude Code output is not JSON: ${error.message}\nstdout:\n${stdout}`);
  }
}

function denialCommand(denial) {
  const command = denial?.tool_input?.command;
  return typeof command === 'string' ? command : '';
}

/** Run the whole smoke and return every failed assertion instead of exiting. */
async function runSmoke(envOverrides = {}) {
  const env = childEnv(envOverrides);
  const errors = [];
  let dir;
  try {
    dir = createProject(env);
    runInit(dir, env);
    const rules = await storeRules();
    assertSettings(dir, rules);
  } catch (error) {
    if (dir) rmSync(dir, { recursive: true, force: true });
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }

  try {
    for (const run of RUNS) {
      let result;
      try {
        result = runClaude(run, dir, env, debugFile(dir, run));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        continue;
      }

      const debugText = existsSync(debugFile(dir, run)) ? readFileSync(debugFile(dir, run), 'utf8') : '';
      const ruleWarnings = debugText.split('\n').filter((line) => DEBUG_RULE_WARNING.test(line));
      if (ruleWarnings.length) {
        errors.push(`${run.name}: Claude Code reported permission-rule warnings:\n${ruleWarnings.join('\n')}`);
      }

      const stderr = result.stderr ?? '';
      for (const marker of WARNING_MARKERS) {
        if (stderr.includes(marker)) {
          errors.push(`${run.name}: stderr contains permission warning ${JSON.stringify(marker)}\nstderr:\n${stderr}`);
        }
      }

      let parsed;
      try {
        parsed = jsonResult(run, result);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        continue;
      }

      const denials = Array.isArray(parsed.permission_denials) ? parsed.permission_denials : [];
      if (run.expectsStoreDenial) {
        if (!denials.some((denial) => denialCommand(denial).includes('.crossmatrix'))) {
          errors.push(`${run.name}: expected a permission_denials entry for a .crossmatrix Bash command; got ${JSON.stringify(denials)}`);
        }
      } else if (denials.length) {
        errors.push(`${run.name}: control command was denied: ${JSON.stringify(denials)}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const run of RUNS) rmSync(debugFile(dir, run), { force: true });
  }

  return { ok: errors.length === 0, errors };
}

function report(label, outcome) {
  if (outcome.ok) {
    console.log(`${label}: ok`);
    return;
  }
  console.error(`${label}: FAILED`);
  for (const error of outcome.errors) console.error(`- ${error}`);
}

async function selfTest() {
  if (!existsSync(fakeClaude)) throw new Error(`missing fake Claude binary: ${fakeClaude}`);
  const base = {
    CLAUDE_BIN: process.execPath,
    CLAUDE_BIN_ARGS: JSON.stringify([fakeClaude]),
  };

  const passing = await runSmoke({ ...base, FAKE_CLAUDE_WARN: '0' });
  if (!passing.ok) {
    report('self-test without warning (expected pass)', passing);
    return 1;
  }

  const warning = await runSmoke({ ...base, FAKE_CLAUDE_WARN: '1' });
  if (warning.ok) {
    console.error('self-test with warning (expected fail): the smoke accepted a deny-rule warning');
    return 1;
  }
  if (!warning.errors.some((error) => error.includes('permission-rule warnings'))) {
    report('self-test with warning (expected a deny-rule warning failure)', warning);
    return 1;
  }

  console.log('claude smoke self-test ok: clean settings pass, warning is rejected');
  return 0;
}

async function main() {
  if (process.argv.includes('--self-test')) {
    try {
      process.exitCode = await selfTest();
    } catch (error) {
      console.error(`claude smoke self-test failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (!process.argv.includes('--live')) {
    console.error('usage: node scripts/claude-smoke.mjs --self-test | --live');
    console.error('--live starts real Claude Code, which calls a model: run it only by hand with explicit approval, never in CI.');
    process.exitCode = 2;
    return;
  }
  const outcome = await runSmoke();
  report('claude smoke', outcome);
  process.exitCode = outcome.ok ? 0 : 1;
}

main().catch((error) => {
  console.error(`claude smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
