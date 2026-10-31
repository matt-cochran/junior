// ---------------------------------------------------------------------------
// Crossmatrix ADR-0004 Dimensions CLI: usage, argument parsing and main.
// This module is split out of matrix.ts per ADR 0016; the facade keeps the
// isDirectEntry block.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { planStatusRows } from './companion-shapes.ts';
import { playbookDimensions } from './playbooks.ts';
import { callHop } from './tools/tools.ts';
import {
  codeLocations,
  cpmDeliverables,
  fmecaFailureModes,
  jevitateJobs,
  jevitateJourneys,
  jevitatePersonas,
  parseJsonContent,
  planIdFromPath,
  tests,
  type MatrixDimension,
  type MatrixFile,
} from './matrix-adapters.ts';
import { buildDimensionSet, writeDimensionSet } from './matrix-dimensions.ts';
import {
  defaultSources,
  featureFromResult,
  newestResult,
  normalizeFeature,
  projectRoot,
  resolveMatrixHop,
  resolveMatrixModel,
  resolveMatrixPlan,
} from './matrix-defaults.ts';

/** Resolve hop + model for a matrix command and note the choices on stderr. */
function resolveCore(explicit: { hop?: string; model?: string; dir?: string }, notes: string[]): { hop: string; model: string; root: string } {
  const root = projectRoot(explicit.dir ?? process.cwd());
  const hop = resolveMatrixHop(root, explicit.hop);
  const model = resolveMatrixModel(root, explicit.model);
  if (hop.source !== 'explicit') notes.push(`hop ${hop.path} (${hop.source})`);
  if (model.source !== 'explicit') notes.push(`model ${model.id} (${model.source})`);
  return { hop: hop.path, model: model.id, root };
}

function pick(core: { hop: string; model: string }): { hop: string; model: string } {
  return { hop: core.hop, model: core.model };
}

function planError(command: string, candidates: string[] | undefined): string {
  return candidates && candidates.length > 0
    ? `${command}: several unfinished plans (${candidates.join(', ')}); pass --plan <plan_id> or set matrix.plan in delivery.config.json`
    : `${command}: no unfinished plan found; pass --plan <plan_id> or set matrix.plan in delivery.config.json`;
}

/** Fill `--source` and, when cpm/state needs it, `--plan` from the project. */
async function defaultSyncSources(options: MatrixOptions, root: string, notes: string[]): Promise<void> {
  const defaulted = options.sources.length === 0;
  const needsPlan = defaulted || options.sources.includes('cpm') || options.sources.includes('state');
  if (needsPlan && options.plan === undefined && options.planFile === undefined) {
    const plan = await resolveMatrixPlan(root, options.hop!);
    if (plan.planId) {
      options.plan = plan.planId;
      notes.push(`plan ${plan.planId} (${plan.source})`);
    } else if (!defaulted && options.sources.includes('cpm')) {
      throw new Error(planError('matrix sync --source cpm', plan.candidates));
    } else if (plan.candidates) {
      notes.push(`cpm skipped: several unfinished plans (${plan.candidates.join(', ')})`);
    }
  }
  if (defaulted) {
    options.sources = defaultSources(root, options.plan !== undefined || options.planFile !== undefined);
    notes.push(`sources ${options.sources.join(',')}`);
  }
}

function writeNotes(notes: string[]): void {
  if (notes.length > 0) process.stderr.write(`matrix defaults: ${notes.join('; ')}\n`);
}

// ---------------------------------------------------------------------------
// CLI: `junior matrix export`
// ---------------------------------------------------------------------------

interface MatrixOptions {
  sources: string[];
  dir: string;
  out?: string;
  set?: string;
  hop?: string;
  plan?: string;
  planFile?: string;
  session?: string;
  fmecaSession?: string;
  elicitationSession?: string;
  spSession?: string;
  jevitateResults?: string;
  model?: string;
}

const SOURCES = ['code', 'tests', 'jevitate', 'cpm', 'fmeca', 'playbooks', 'state'];
const VALUE_FLAGS = [
  '--source', '--dir', '--out', '--set', '--hop', '--plan', '--plan-file', '--session', '--model',
  '--fmeca-session', '--elicitation-session', '--sp-session', '--jevitate-results',
];

export const MATRIX_USAGE = [
  'Every flag is an override. Defaults: --hop = the active/configured/sole Hop (.delivery/setup/hop.json);',
  '  --model = matrix.model in delivery.config.json, the sole .crossmatrix/state/<id>.json, else the project name;',
  '  --source = matrix.sources, else code,tests (+jevitate when .jevitate/ exists, +cpm when one plan is unfinished);',
  '  --plan = matrix.plan, else the sole unfinished plan; <feature> = <deliverable id> | <dimensionId>:<memberId>.',
  'Usage: junior matrix export [--source code|tests|jevitate|cpm|fmeca|playbooks ...] [--dir <project>]',
  '       [--out <crossmatrix dir, default <project>/.crossmatrix>] [--set <dimensionSetId, default project-<source>>]',
  '       [--hop <hop.json> --plan <plan_id> | --plan-file <path>] [--hop <hop.json> --session <fmeca session_id>]',
  'Usage: junior matrix init [--dir <project>]',
  'Usage: junior matrix sync [--source code|tests|jevitate|cpm|fmeca|playbooks ...] [--hop <hop.json>] [--model <id>]',
  '       [--dir <project>] [--plan <plan_id> | --plan-file <path>] [--session <fmeca session_id>]',
  'Usage: junior matrix sync --source state [--plan <plan_id>] [--fmeca-session <id>] [--elicitation-session <id>]',
  '       [--sp-session <id>] [--jevitate-results <dir|file>] [--dir <project>]',
  'Usage: junior matrix codemap init [--feature-dimension <id> ...]',
  'Usage: junior matrix link [<feature>] [--result <result.json, default newest .delivery run>] [--observation implements|tests|touches]',
  '       (feature defaults to the result\'s plan deliverable)',
  'Usage: junior matrix files <feature>',
  'Usage: junior matrix context <feature> [--max N]',
  'Usage: junior matrix refresh [--hop <hop.json>] [--model <id>] [--plan <plan_id>] [--dir <project>]',
  'Usage: junior matrix stale [--dir <project>]',
  'Usage: junior matrix bootstrap [--dir <project>] [--out proposals.json] [--plan-file <plan.json>]',
  'Usage: junior matrix confirm --proposals <proposals.json> [--min high|medium|low] [--only <id,...>] [--exclude <id,...>]',
  'Usage: junior matrix autolink [--plan <plan_id>]',
  '(--hop <hop.json> and --model <id> override the defaults on every command.)',
].join('\n');

export function parseMatrixArgs(argv: string[]): MatrixOptions {
  const sources: string[] = [];
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!VALUE_FLAGS.includes(name)) throw new Error(`Unknown option for matrix: ${arg}`);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined) value = argv[++i];
    if (value === undefined || value === '') throw new Error(`Option ${name} requires a value`);
    if (name === '--source') sources.push(value);
    else values[name] = value;
  }
  for (const source of sources) if (!SOURCES.includes(source)) throw new Error(`Unknown source: ${source}`);
  if (values['--plan'] !== undefined && values['--plan-file'] !== undefined) {
    throw new Error('--plan and --plan-file are mutually exclusive');
  }
  return {
    sources,
    dir: values['--dir'] ?? process.cwd(),
    out: values['--out'],
    set: values['--set'],
    hop: values['--hop'],
    plan: values['--plan'],
    planFile: values['--plan-file'],
    session: values['--session'],
    fmecaSession: values['--fmeca-session'],
    elicitationSession: values['--elicitation-session'],
    spSession: values['--sp-session'],
    jevitateResults: values['--jevitate-results'],
    model: values['--model'],
  };
}

interface CodemapOptions {
  hop?: string;
  model?: string;
  result?: string;
  feature?: string;
  observation?: string;
  featureDimensions: string[];
  max?: number;
  dir?: string;
  out?: string;
  proposals?: string;
  min?: string;
  only?: string[];
  exclude?: string[];
  plan?: string;
  planFile?: string;
}

const CODEMAP_VALUE_FLAGS = ['--hop', '--model', '--result', '--feature', '--observation', '--feature-dimension', '--max', '--dir', '--out', '--proposals', '--min', '--only', '--exclude', '--plan', '--plan-file'];
const CODEMAP_OBSERVATIONS = ['implements', 'tests', 'touches'];
const CODEMAP_CONFIDENCES = ['high', 'medium', 'low'];
const CODEMAP_LIST_FLAGS = ['--only', '--exclude']; // comma-separated id lists

function parseCodemapArgs(argv: string[]): CodemapOptions {
  const featureDimensions: string[] = [];
  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = { '--only': [], '--exclude': [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!arg.startsWith('-') && values['--feature'] === undefined) {
      values['--feature'] = arg; // positional feature: `junior matrix context d-1`
      continue;
    }
    if (!CODEMAP_VALUE_FLAGS.includes(name)) throw new Error(`Unknown option for matrix codemap: ${arg}`);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (value === undefined) value = argv[++i];
    if (value === undefined || value === '') throw new Error(`Option ${name} requires a value`);
    if (name === '--feature-dimension') featureDimensions.push(value);
    else if (CODEMAP_LIST_FLAGS.includes(name)) lists[name].push(...value.split(',').map((entry) => entry.trim()).filter(Boolean));
    else values[name] = value;
  }
  if (values['--observation'] !== undefined && !CODEMAP_OBSERVATIONS.includes(values['--observation'])) {
    throw new Error(`Unknown observation: ${values['--observation']}`);
  }
  if (values['--min'] !== undefined && !CODEMAP_CONFIDENCES.includes(values['--min'])) {
    throw new Error(`Unknown minimum confidence: ${values['--min']}`);
  }
  return {
    hop: values['--hop'],
    model: values['--model'],
    result: values['--result'],
    feature: values['--feature'],
    observation: values['--observation'],
    featureDimensions,
    max: parseMax(values['--max']),
    dir: values['--dir'],
    out: values['--out'],
    proposals: values['--proposals'],
    min: values['--min'],
    only: lists['--only'],
    exclude: lists['--exclude'],
    plan: values['--plan'],
    planFile: values['--plan-file'],
  };
}

/** Parse an optional non-negative integer `--max`. */
function parseMax(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Option --max requires a non-negative integer, got: ${value}`);
  }
  return parsed;
}

function gitTrackedFiles(dir: string): MatrixFile[] {
  const listing = spawnSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' });
  if (listing.status !== 0) throw new Error(`git ls-files failed in ${dir}: ${listing.stderr?.trim() ?? 'unknown error'}`);
  const files: MatrixFile[] = [];
  for (const line of listing.stdout.split('\n')) {
    const p = line.trim();
    if (!p) continue;
    files.push({ path: p, content: fs.readFileSync(path.join(dir, p)) });
  }
  return files;
}

function readJevitateFiles(dir: string): MatrixFile[] {
  const files: MatrixFile[] = [];
  const jobs = path.join(dir, '.jevitate', 'jobs.json');
  if (fs.existsSync(jobs)) files.push({ path: '.jevitate/jobs.json', content: fs.readFileSync(jobs) });

  const journeysDir = path.join(dir, '.jevitate', 'journeys');
  const walk = (absDir: string, relDir: string): void => {
    if (!fs.existsSync(absDir)) return;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(absDir, entry.name);
      const rel = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push({ path: rel, content: fs.readFileSync(abs) });
    }
  };
  walk(journeysDir, '.jevitate/journeys');
  return files;
}

export async function dimensionsForSource(options: MatrixOptions, source: string): Promise<MatrixDimension[]> {
  if (source === 'playbooks') return playbookDimensions();
  if (source === 'code') return [codeLocations(gitTrackedFiles(options.dir))];
  if (source === 'tests') return [tests(gitTrackedFiles(options.dir))];
  if (source === 'jevitate') {
    const files = readJevitateFiles(options.dir);
    const jobsFile = files.find((f) => f.path === '.jevitate/jobs.json');
    const jobsJson = jobsFile ? parseJsonContent(jobsFile.content) : [];
    return [jevitateJobs(jobsJson), jevitatePersonas(jobsJson), jevitateJourneys(files)];
  }
  if (source === 'cpm') {
    if (options.planFile === undefined && (!options.hop || !options.plan)) {
      throw new Error('cpm export requires --hop <hop.json> and --plan <plan_id>, or --plan-file <path>');
    }
    if (options.planFile !== undefined) {
      let raw: string;
      try {
        raw = fs.readFileSync(options.planFile, 'utf8');
      } catch {
        throw new Error(`cpm --plan-file could not read ${options.planFile}`);
      }
      let planJson: unknown;
      try {
        planJson = JSON.parse(raw);
      } catch {
        throw new Error(`cpm --plan-file is not valid JSON: ${options.planFile}`);
      }
      return [cpmDeliverables(planJson, planIdFromPath(options.planFile))];
    }
    const outcome = await callHop(options.hop!, 'cpm', { tool: 'plan.get', arguments: { plan_id: options.plan! } });
    if (!outcome.ok) throw new Error(`cpm plan.get failed: ${outcome.error?.message ?? outcome.note ?? 'unknown error'}`);
    const statusOutcome = await callHop(options.hop!, 'cpm', { tool: 'plan.status', arguments: { plan_id: options.plan! } });
    const statuses = statusOutcome.ok
      ? new Map(planStatusRows(statusOutcome.result).items.map((row) => [row.id, row.status]))
      : undefined;
    return [cpmDeliverables(outcome.result, options.plan!, statuses)];
  }
  if (!options.hop || !options.session) throw new Error('fmeca export requires --hop <hop.json> and --session <fmeca session_id>');
  const outcome = await callHop(options.hop, 'fmeca', { tool: 'state.get', arguments: { session_id: options.session } });
  if (!outcome.ok) throw new Error(`fmeca state.get failed: ${outcome.error?.message ?? outcome.note ?? 'unknown error'}`);
  return [fmecaFailureModes(outcome.result, options.session)];
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${MATRIX_USAGE}\n`);
    return 0;
  }
  if (argv[0] === 'init') {
    const { runMatrixInit } = await import('./matrix-init.ts');
    return runMatrixInit(argv.slice(1));
  }
  if (argv[0] === 'sync') {
    try {
      const options = parseMatrixArgs(argv.slice(1));
      const notes: string[] = [];
      const core = resolveCore(options, notes);
      options.hop = core.hop;
      options.model = core.model;
      await defaultSyncSources(options, core.root, notes);
      writeNotes(notes);
      if (options.sources.includes('state')) {
        const { syncState } = await import('./state-sync.ts');
        const result = await syncState({
          hopPath: options.hop,
          modelId: options.model,
          planId: options.plan,
          fmecaSession: options.fmecaSession,
          elicitationSession: options.elicitationSession,
          spSession: options.spSession,
          jevitateResults: options.jevitateResults,
          dir: options.dir,
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (result.failures.length > 0) process.exitCode = 1;
        return 0;
      }
      const dimensions: MatrixDimension[] = [];
      for (const source of options.sources) dimensions.push(...(await dimensionsForSource(options, source)));
      const { syncDimensions } = await import('./matrix-sync.ts');
      const result = await syncDimensions({ hopPath: options.hop, modelId: options.model, dimensions });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (argv[0] === 'refresh') {
    try {
      const options = parseMatrixArgs(argv.slice(1));
      const { refresh } = await import('./matrix-refresh.ts');
      const result = await refresh({
        dir: options.dir,
        hop: options.hop,
        model: options.model,
        plan: options.plan,
        planFile: options.planFile,
      });
      writeNotes(result.notes);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (argv[0] === 'codemap') {
    try {
      if (argv[1] !== 'init') throw new Error('Usage: junior matrix codemap init [--feature-dimension <id> ...]');
      const options = parseCodemapArgs(argv.slice(2));
      const notes: string[] = [];
      Object.assign(options, pick(resolveCore(options, notes)));
      writeNotes(notes);
      const { codemapInit } = await import('./codemap.ts');
      const result = await codemapInit({
        hopPath: options.hop,
        modelId: options.model,
        featureDimensions: options.featureDimensions.length > 0 ? options.featureDimensions : undefined,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (argv[0] === 'link') {
    try {
      const options = parseCodemapArgs(argv.slice(1));
      const notes: string[] = [];
      const core = resolveCore(options, notes);
      Object.assign(options, pick(core));
      if (!options.result) {
        options.result = newestResult(core.root);
        if (!options.result) throw new Error('matrix link found no .delivery/<id>/<stamp>/result.json; pass --result <result.json>');
        notes.push(`result ${options.result} (newest)`);
      }
      if (!options.feature) {
        options.feature = featureFromResult(options.result);
        if (!options.feature) throw new Error('matrix link: the result names no plan deliverable; pass --feature <dimensionId>:<memberId> or <deliverable id>');
        notes.push(`feature ${options.feature} (result plan)`);
      }
      options.feature = normalizeFeature(options.feature);
      writeNotes(notes);
      const { codemapLink } = await import('./codemap.ts');
      const result = await codemapLink({
        hopPath: options.hop,
        modelId: options.model,
        resultPath: options.result,
        feature: options.feature,
        observation: options.observation as 'implements' | 'tests' | 'touches' | undefined,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (argv[0] === 'bootstrap' || argv[0] === 'confirm' || argv[0] === 'autolink') {
    const subcommand = argv[0];
    try {
      const options = parseCodemapArgs(argv.slice(1));
      const notes: string[] = [];
      const core = resolveCore(options, notes);
      Object.assign(options, pick(core));
      if (subcommand === 'autolink' && !options.plan) {
        const plan = await resolveMatrixPlan(core.root, core.hop);
        if (!plan.planId) throw new Error(planError('matrix autolink', plan.candidates));
        options.plan = plan.planId;
        notes.push(`plan ${plan.planId} (${plan.source})`);
      }
      writeNotes(notes);
      const autopilot = await import('./matrix-autopilot.ts');
      if (subcommand === 'bootstrap') {
        const dir = options.dir ?? process.cwd();
        // --plan-file reads the plan graph offline instead of the hop's plan.get snapshot.
        const planGraph = options.planFile === undefined ? undefined : JSON.parse(fs.readFileSync(options.planFile, 'utf8'));
        const result = await autopilot.bootstrap({
          hopPath: options.hop,
          modelId: options.model,
          dir,
          out: options.out ?? path.join(dir, 'proposals.json'),
          ...(planGraph === undefined ? {} : { deps: { planGraph } }),
        });
        process.stdout.write(
          `${JSON.stringify({ out: result.out, count: result.proposals.length, ...result.counts })}\n`,
        );
        return 0;
      }
      if (subcommand === 'confirm') {
        if (!options.proposals) throw new Error('matrix confirm requires --proposals <proposals.json>');
        const result = await autopilot.confirmProposals({
          hopPath: options.hop,
          modelId: options.model,
          proposalsPath: options.proposals,
          min: options.min as 'high' | 'medium' | 'low' | undefined,
          only: options.only,
          exclude: options.exclude,
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }
      const result = await autopilot.autolink({
        hopPath: options.hop,
        modelId: options.model,
        planId: options.plan,
        dir: options.dir ?? process.cwd(),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (argv[0] === 'files' || argv[0] === 'context' || argv[0] === 'stale') {
    const subcommand = argv[0];
    try {
      const options = parseCodemapArgs(argv.slice(1));
      const notes: string[] = [];
      Object.assign(options, pick(resolveCore(options, notes)));
      writeNotes(notes);
      const codemap = await import('./codemap.ts');
      if (subcommand === 'stale') {
        const result = await codemap.codemapStale({
          hopPath: options.hop,
          modelId: options.model,
          dir: options.dir ?? process.cwd(),
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }
      if (!options.feature) throw new Error(`matrix ${subcommand} requires a feature: <deliverable id> or --feature <dimensionId>:<memberId>`);
      options.feature = normalizeFeature(options.feature);
      if (subcommand === 'files') {
        const result = await codemap.codemapFiles({
          hopPath: options.hop,
          modelId: options.model,
          feature: options.feature,
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }
      const result = await codemap.codemapContext({
        hopPath: options.hop,
        modelId: options.model,
        feature: options.feature,
        max: options.max,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (argv[0] === 'qc') {
    const { runLinkQc } = await import('./link-qc.ts');
    return runLinkQc(argv.slice(1));
  }
  if (argv[0] === 'graph') {
    const { runGraph } = await import('./context-graph.ts');
    return runGraph(argv.slice(1));
  }
  if (argv[0] === 'jtbd') {
    const { runJtbd } = await import('./jtbd-bridge.ts');
    return runJtbd(argv.slice(1));
  }
  if (argv[0] === 'plan-from-spec') {
    const { runPlanFromSpec } = await import('./spec-bridge.ts');
    return runPlanFromSpec(argv.slice(1));
  }
  if (argv[0] === 'analyze') {
    const { runAnalyze } = await import('./matrix-analyze.ts');
    return runAnalyze(argv.slice(1));
  }
  if (argv[0] === 'adr') {
    const { runAdr } = await import('./adr.ts');
    return runAdr(argv.slice(1));
  }
  if (argv[0] !== 'export') {
    process.stdout.write(`${MATRIX_USAGE}\n`);
    return 1;
  }
  try {
    const options = parseMatrixArgs(argv.slice(1));
    if (options.sources.length === 0) {
      options.sources = defaultSources(projectRoot(options.dir), options.planFile !== undefined || (options.hop !== undefined && options.plan !== undefined));
    }
    const written: string[] = [];
    const unchanged: string[] = [];
    for (const source of options.sources) {
      const dimensionSetId = options.set ?? `project-${source}`;
      const dimensions = await dimensionsForSource(options, source);
      const doc = buildDimensionSet(dimensionSetId, dimensions);
      const outDir = options.out ?? path.join(options.dir, '.crossmatrix');
      const result = writeDimensionSet(outDir, doc);
      if (result.unchanged) unchanged.push(result.path);
      else written.push(result.path);
    }
    process.stdout.write(`${JSON.stringify({ written, unchanged }, null, 2)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
