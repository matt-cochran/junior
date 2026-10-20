#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/capture-companion-fixtures.mjs
//
// Reproduces the committed fixtures under tools/test-fixtures/companions by
// driving the installed managed companion binaries through the real
// `junior tools call` path (and, for scientific-process, its stdio JSON-RPC
// server directly, since that server keeps its session in process memory).
//
// Two modes:
//   --dry-run   list the tool/method recordings that would be written, spawn
//               nothing, exit 0.
//   (live)      create a temp project with mkdtemp, write a hop with
//               `junior tools init <hop>`, run the per-tool sequences below,
//               normalize responses, write
//               <out>/<tool>@<version>/<method>.json plus index.json, then
//               delete the temp project.
//
// Fixture directory names come from ~/.junior/tools/installed.json
// (`tools.<name>.version`); scientific-process uses the explicit
// `scientific-process@<v>` form.
//
// The reference driver for scientific-process (sp-capture-reference.mjs) is
// not in the repo; its approach is reproduced here: initialize,
// notifications/initialized, then tools/call per step, reading the last
// result as structuredContent ?? JSON.parse(content[0].text).
// ---------------------------------------------------------------------------

import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_OUT = join(REPO_ROOT, 'tools', 'test-fixtures', 'companions');

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const PLAN_ID_RE = /\bplan_[0-9a-f]{32}\b/g;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const TOKEN_FIELDS = new Set(['lease_token', 'token', 'lock_id', 'lease_id']);
const FIXED_TIMESTAMP = '2026-01-01T00:00:00Z';

/** Recursively normalize a parsed fixture value. */
export function normalizeValue(value) {
  if (typeof value === 'string') {
    if (ISO_TIMESTAMP_RE.test(value)) return FIXED_TIMESTAMP;
    return value.replace(PLAN_ID_RE, 'plan_FIXTURE');
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = TOKEN_FIELDS.has(key) ? 'TOKEN' : normalizeValue(item);
    }
    return out;
  }
  return value;
}

/** Drop the `junior tools: ...` trailer lines the CLI prints around a result. */
export function dropNonJsonLines(text) {
  return String(text)
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('junior tools:'));
}

/** Parse captured stdout without normalizing (ids are still needed for the next call). */
export function parseOutput(text) {
  const lines = dropNonJsonLines(text);
  if (lines.length === 0) throw new Error(`captured output is not JSON: ${JSON.stringify(String(text).slice(0, 200))}`);
  return JSON.parse(lines.join('\n'));
}

/** Parse captured stdout and normalize it. */
export function normalize(text) {
  return normalizeValue(parseOutput(text));
}

/** Serialize a fixture exactly as the committed files are formatted. */
export function renderJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// Recording plan
// ---------------------------------------------------------------------------

/** Flatten index.json into a list of {tool, file} recordings, in index order. */
export function plannedRecordings(index) {
  const out = [];
  for (const [tool, entry] of Object.entries(index.tools)) {
    for (const file of entry.files) out.push({ tool, file });
  }
  return out;
}

/**
 * Decide whether the capture script can rely on installed.json for the
 * version-derived directory name. scientific-process is always explicit.
 */
function versionFor(installed, tool) {
  const version = installed?.tools?.[tool]?.version;
  if (typeof version !== 'string' || !version) {
    throw new Error(`installed.json has no version for '${tool}'`);
  }
  return version;
}

// ---------------------------------------------------------------------------
// Live capture primitives
// ---------------------------------------------------------------------------

/** `[command, ...prefixArgs]` for the Junior CLI; a .ts/.js/.mjs entry runs under node. */
function juniorCommand() {
  const cli = process.env.JUNIOR_CLI;
  if (!cli) return ['junior'];
  return /\.(ts|js|mjs)$/.test(cli) ? [process.execPath, cli] : [cli];
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

/** Run one `junior tools call <hop> <tool> -` with `request` on stdin. */
function toolsCall(hopPath, tool, request) {
  const [command, ...prefix] = juniorCommand();
  const result = runChecked(command, [...prefix, 'tools', 'call', hopPath, tool, '-'], {
    input: JSON.stringify(request),
    // cpm resolves its project (and refuses absolute plan paths) from the cwd.
    cwd: dirname(hopPath),
  });
  return parseOutput(result.stdout);
}

// ---------------------------------------------------------------------------
// Per-tool sequences
// ---------------------------------------------------------------------------

const CPM_PLAN = {
  deliverables: [
    { id: 'd-api', owned_files: ['api.ts'], prerequisites: [], estimated_effort_hours: 2, metadata: { artifact: 'api.ts', owner: 'agent' } },
    { id: 'd-docs', owned_files: ['docs.md'], prerequisites: [{ id: 'd-api', consumes: 'api surface' }], estimated_effort_hours: 1, metadata: { artifact: 'docs.md', owner: 'agent' } },
    { id: 'ms', milestone: true, owned_files: [], prerequisites: [{ id: 'd-docs', consumes: 'docs' }], metadata: { artifact: 'release', owner: 'owner', kind: 'manual' } },
  ],
};

function writeCpmPlan(projectDir) {
  const planDir = join(projectDir, '.cpm-planner', 'plans', 'fixture');
  mkdirSync(planDir, { recursive: true });
  const planPath = join(planDir, 'main.json');
  writeFileSync(planPath, JSON.stringify(CPM_PLAN, null, 2) + '\n');
  return planPath;
}

async function captureCpm(hopPath, projectDir, emit) {
  const planPath = writeCpmPlan(projectDir);
  const synced = toolsCall(hopPath, 'cpm', { tool: 'plan.sync', arguments: { path: relative(projectDir, planPath) } });
  const planId = synced.plan_id;
  if (typeof planId !== 'string' || !planId) throw new Error('plan.sync did not return a plan_id');
  // Record plan.sync's own response? index.json lists plan.get etc.; sync is
  // only a setup step, so it is not emitted.

  emit('plan.get', toolsCall(hopPath, 'cpm', { tool: 'plan.get', arguments: { plan_id: planId } }));
  emit('plan.status', toolsCall(hopPath, 'cpm', { tool: 'plan.status', arguments: { plan_id: planId } }));
  emit('plan.acquire_cohort', toolsCall(hopPath, 'cpm', {
    tool: 'plan.acquire_cohort',
    arguments: { plan_id: planId, caller_id: 'fixture-worker', max_count: 1, ttl_seconds: 600 },
  }));
  emit('plan.status.leased', toolsCall(hopPath, 'cpm', { tool: 'plan.status', arguments: { plan_id: planId } }));
  emit('plan.mark_status', toolsCall(hopPath, 'cpm', {
    tool: 'plan.mark_status',
    arguments: {
      plan_id: planId,
      caller_id: 'fixture-worker',
      deliverable_id: 'd-api',
      status: { status: 'complete' },
      actual_effort_hours: 1.5,
    },
  }));
  emit('plan.status.progress', toolsCall(hopPath, 'cpm', { tool: 'plan.status', arguments: { plan_id: planId } }));
}

const ELICIT_SESSION = 'fixture-elicit-20261020b';

function elicitClaim(id, polarity) {
  return {
    id,
    session_id: ELICIT_SESSION,
    subject: { id: ELICIT_SESSION, label: 'export' },
    predicate: 'format',
    object: { kind: 'value', value: 'csv' },
    polarity,
    category: 'requirement',
    modality: 'constraint',
    dimensions: ['acceptance'],
    source: { turn_id: id },
  };
}

async function captureElicitation(hopPath, _projectDir, emit) {
  emit('session.open', toolsCall(hopPath, 'elicitation', {
    tool: 'session.open',
    arguments: {
      session_id: ELICIT_SESSION,
      coverage_schema: { dimensions: [{ tag: 'acceptance', required: true }] },
    },
  }));
  emit('append', toolsCall(hopPath, 'elicitation', {
    tool: 'append',
    arguments: { variant: 'add_claim', session_id: ELICIT_SESSION, claim: elicitClaim('c1', 'positive') },
  }));
  emit('append.contradiction', toolsCall(hopPath, 'elicitation', {
    tool: 'append',
    arguments: { variant: 'add_claim', session_id: ELICIT_SESSION, claim: elicitClaim('c2', 'negative') },
  }));
  emit('state.get', toolsCall(hopPath, 'elicitation', {
    tool: 'state.get',
    arguments: { session_id: ELICIT_SESSION },
  }));
  emit('question.next', toolsCall(hopPath, 'elicitation', {
    tool: 'question.next',
    arguments: { session_id: ELICIT_SESSION },
  }));
  emit('readiness.assess', toolsCall(hopPath, 'elicitation', {
    tool: 'readiness.assess',
    arguments: { session_id: ELICIT_SESSION },
  }));
  emit('spec.export', toolsCall(hopPath, 'elicitation', {
    tool: 'spec.export',
    arguments: { session_id: ELICIT_SESSION },
  }));
}

const FMECA_SESSION = 'fixture-fmeca-20261020';

async function captureFmeca(hopPath, _projectDir, emit) {
  emit('session.open', toolsCall(hopPath, 'fmeca', {
    tool: 'session.open',
    arguments: { session_id: FMECA_SESSION, title: 'fixture' },
  }));
  emit('append', toolsCall(hopPath, 'fmeca', {
    tool: 'append',
    arguments: {
      session_id: FMECA_SESSION,
      variant: 'add_failure_mode',
      failure_mode: {
        session_id: FMECA_SESSION,
        id: 'fm1',
        component: { id: 'export' },
        description: 'empty export',
        cause: 'shape drift',
        effect: 'silent data loss',
        domain: 'runtime',
        scope: 'localized',
        severity_observations: ['data_loss'],
        probability_observations: ['occasional'],
        source: { turn_id: 't1' },
      },
    },
  }));
  emit('append.mitigation', toolsCall(hopPath, 'fmeca', {
    tool: 'append',
    arguments: {
      session_id: FMECA_SESSION,
      variant: 'add_mitigation',
      mitigation: {
        session_id: FMECA_SESSION,
        id: 'm1',
        failure_mode_id: 'fm1',
        kind: 'detection',
        description: 'fail on unrecognized shape',
        residual_severity_observations: ['recoverable_error'],
        residual_probability_observations: ['rare_edge_case'],
        source: { turn_id: 't2' },
      },
    },
  }));
  emit('state.get', toolsCall(hopPath, 'fmeca', {
    tool: 'state.get',
    arguments: { session_id: FMECA_SESSION },
  }));
  emit('risk.next', toolsCall(hopPath, 'fmeca', {
    tool: 'risk.next',
    arguments: { session_id: FMECA_SESSION },
  }));
  emit('readiness.assess', toolsCall(hopPath, 'fmeca', {
    tool: 'readiness.assess',
    arguments: { session_id: FMECA_SESSION },
  }));
  emit('report.export', toolsCall(hopPath, 'fmeca', {
    tool: 'report.export',
    arguments: { session_id: FMECA_SESSION },
  }));
}

// --- scientific-process: direct stdio JSON-RPC in one process ---------------

const MCP_PROTOCOL_VERSION = '2024-11-05';

function extractStructured(result) {
  if (result && typeof result === 'object') {
    if (result.structuredContent !== undefined) return result.structuredContent;
    if (result.structured_content !== undefined) return result.structured_content;
    const content = Array.isArray(result.content) ? result.content : [];
    const textPart = content.find(
      (part) => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string',
    );
    if (textPart) {
      try {
        return JSON.parse(textPart.text);
      } catch {
        return textPart.text;
      }
    }
  }
  return result;
}

/**
 * Drive the scientific-process binary directly over stdio JSON-RPC in ONE
 * process, mirroring the reference driver's approach. `steps` is a list of
 * { name, args, record } in call order; every step's result is passed to
 * `emit(name, structured)` when record is truthy.
 */
function captureScientificProcess(binaryPath, stateDir, steps, emit) {
  const child = spawn(binaryPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SCIENTIFIC_PROCESS_STATE_DIR: stateDir },
  });

  let buf = '';
  let nextId = 1;
  const pending = new Map();
  let stderrText = '';

  child.stderr.on('data', (chunk) => {
    if (stderrText.length < 8192) stderrText += chunk.toString('utf8');
  });

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (!msg || msg.id === undefined || msg.id === null) continue;
      const entry = pending.get(msg.id);
      if (!entry) continue;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || 'JSON-RPC error'));
      else entry.resolve(msg.result);
    }
  });

  const write = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
  const request = (method, params) =>
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { resolve: res, reject: rej });
      write({ jsonrpc: '2.0', id, method, params });
    });

  const finished = (async () => {
    await request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'fixture-capture', version: '0.1.0' },
    });
    write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    for (const step of steps) {
      const result = await request('tools/call', { name: step.name, arguments: step.args });
      const structured = extractStructured(result);
      if (step.record) emit(step.record, structured);
    }
  })();

  return finished
    .then(() => {
      child.stdin.end();
      child.kill('SIGKILL');
    })
    .catch((err) => {
      child.kill('SIGKILL');
      const tail = stderrText.trim();
      throw new Error(`scientific-process capture failed: ${err.message}${tail ? `: ${tail}` : ''}`);
    });
}

function scientificProcessSteps(session) {
  return [
    { name: 'session.open', args: { session_id: session }, record: 'session.open' },
    { name: 'append', args: { variant: 'add_hypothesis', id: 'h1', statement: 'cpm 0.4.0 plan.get nests deliverables under graph' }, record: 'append' },
    { name: 'append', args: { variant: 'add_experiment', id: 'e1', hypothesis_id: 'h1', design: 'call plan.get on a synced plan', prediction: 'deliverables appear under graph.deliverables' } },
    { name: 'append', args: { variant: 'add_observation', id: 'o1', experiment_id: 'e1', result: 'graph.deliverables has 3 entries', supports: true, evidence: 'fixture cpm.plan.get.json' } },
    { name: 'state.get', args: {}, record: 'state.get' },
    { name: 'experiment.next', args: {}, record: 'experiment.next' },
    { name: 'append', args: { variant: 'conclude', hypothesis_id: 'h1', verdict: 'Supported', rationale: 'o1' } },
    { name: 'state.get', args: {}, record: 'state.get.concluded' },
    { name: 'report.export', args: {}, record: 'report.export' },
  ];
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function captureTool(tool, installed, hopPath, projectDir, emit) {
  if (tool === 'cpm') return captureCpm(hopPath, projectDir, emit);
  if (tool === 'elicitation') return captureElicitation(hopPath, projectDir, emit);
  if (tool === 'fmeca') return captureFmeca(hopPath, projectDir, emit);
  if (tool === 'scientific-process') {
    const binary = installed?.tools?.['scientific-process']?.path;
    if (typeof binary !== 'string' || !binary) {
      throw new Error('installed.json has no path for scientific-process');
    }
    const stateDir = join(projectDir, 'scientific-process-state');
    mkdirSync(stateDir, { recursive: true });
    return captureScientificProcess(binary, stateDir, scientificProcessSteps('fixture-sp-20261020b'), emit);
  }
  throw new Error(`no capture sequence for tool '${tool}'`);
}

async function runCapture(outDir, index, installed) {
  const projectDir = mkdtempSync(join(tmpdir(), 'junior-fixtures-'));
  try {
    const hopPath = join(projectDir, 'hop.json');
    const [command, ...prefix] = juniorCommand();
    runChecked(command, [...prefix, 'tools', 'init', hopPath]);
    if (!existsSync(hopPath)) throw new Error(`junior tools init did not write ${hopPath}`);

    for (const [tool, entry] of Object.entries(index.tools)) {
      const version = versionFor(installed, tool);
      const toolDir = join(outDir, `${tool}@${version}`);
      mkdirSync(toolDir, { recursive: true });
      const emitted = new Map();
      await captureTool(tool, installed, hopPath, projectDir, (file, value) => {
        emitted.set(`${file}.json`, value);
        writeFileSync(join(toolDir, `${file}.json`), renderJson(normalizeValue(value)));
      });
      const missing = entry.files.filter((file) => !emitted.has(file));
      if (missing.length > 0) {
        throw new Error(`${tool} capture did not produce: ${missing.join(', ')}`);
      }      // Record the newly verified version; older versions' fixtures are kept.
      entry.versions = [...new Set([...(entry.versions ?? [entry.version]), version])];
      entry.version = version;
    }
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

function readInstalled() {
  const path = join(homedir(), '.junior', 'tools', 'installed.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadIndex(outDir) {
  return JSON.parse(readFileSync(join(outDir, 'index.json'), 'utf8'));
}

function parseArgs(argv) {
  const args = { dryRun: false, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--out') args.out = argv[++i];
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const outDir = resolve(args.out);
  if (args.dryRun) {
    // Dry-run reads only the committed index and spawns nothing.
    const index = loadIndex(DEFAULT_OUT);
    for (const { tool, file } of plannedRecordings(index)) {
      process.stdout.write(`${tool} ${file}\n`);
    }
    return 0;
  }
  // The committed index names what to record, whatever --out points at.
  const index = loadIndex(DEFAULT_OUT);
  await runCapture(outDir, index, readInstalled());
  writeFileSync(join(outDir, 'index.json'), renderJson(index));
  process.stdout.write(`captured ${plannedRecordings(index).length} companion fixtures into ${outDir}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (err) {
    process.stderr.write(`${err?.stack || err}\n`);
    process.exitCode = 1;
  }
}
