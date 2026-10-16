// ---------------------------------------------------------------------------
// Declarative multi-tool playbooks.
//
// A playbook maps a small set of task traits to an ordered tool plan. The
// catalog (`playbooks/playbooks.json`) is data: it names the traits a playbook
// serves with a weight and the applications it uses, all drawn from the same
// vocabulary as the routing evaluation set (`tasks/routing-eval`).
//
// `selectPlaybooks`/`toolPlan` are pure and deterministic: given a trait
// vector they produce a ranked, explainable plan. `playbookDimensions` projects
// the same catalog into Crossmatrix ADR-0004 dimensions so the capability map
// can be committed with the project's `.crossmatrix` store.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MatrixDimension, MatrixMember } from './matrix.ts';

/** The fixed trait vocabulary; playbooks may only serve these traits. */
export const TRAITS = [
  'vague_request',
  'decision_needed',
  'ui_or_journey',
  'performance_or_measurement',
  'flaky_or_unexplained_failure',
  'risky_change',
  'plan_sized',
  'technical_contradiction',
  'customer_job_or_outcome',
  'trivial_change',
] as const;

export type Trait = (typeof TRAITS)[number];

/** The `tool:application` vocabulary shared with the routing evaluation set. */
export const TOOL_APPLICATIONS: Readonly<Record<string, readonly string[]>> = {
  cpm: ['cpm:plan-backed-deliverable', 'cpm:lease-cohort', 'cpm:earned-value'],
  fmeca: ['fmeca:risk-before-change', 'fmeca:readiness-assess'],
  crossmatrix: [
    'crossmatrix:codemap-context',
    'crossmatrix:house-of-quality',
    'crossmatrix:multidimensional-matrix',
    'crossmatrix:test-coverage',
    'crossmatrix:stale-relink',
  ],
  elicitation: ['elicitation:requirements-interview'],
  'scientific-process': ['scientific-process:hypothesis-experiment'],
  jevitate: ['jevitate:browser-check'],
  triz: ['triz:contradiction'],
};

const RELEVANCE = ['required', 'recommended'] as const;
export type Relevance = (typeof RELEVANCE)[number];

export interface PlaybookStep {
  tool: string;
  application: string;
  relevance: Relevance;
  consumes: string[];
  produces: string[];
  managerSetup: string[];
  junior?: string;
}

export interface Playbook {
  id: string;
  title: string;
  traits: Record<string, number>;
  steps: PlaybookStep[];
}

export interface PlaybookCatalog {
  traits: string[];
  playbooks: Playbook[];
}

export interface ScoredPlaybook extends Playbook {
  score: number;
  explanation: string;
}

export interface ToolPlanEntry {
  tool: string;
  application: string;
  relevance: Relevance;
}

export interface ToolPlan {
  tools: ToolPlanEntry[];
  managerSetup: string[];
  directions: string[];
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Resolve the catalog both from the source tree and from the built `dist/`. */
function defaultCatalogPath(): string {
  const candidates = [
    join(HERE, 'playbooks', 'playbooks.json'),
    join(HERE, '..', 'playbooks', 'playbooks.json'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error(`playbooks catalog not found (looked in ${candidates.join(', ')})`);
}

/** Load and parse the playbooks catalog (optionally from an explicit path). */
export function loadPlaybooks(file: string = defaultCatalogPath()): PlaybookCatalog {
  return JSON.parse(readFileSync(file, 'utf8')) as PlaybookCatalog;
}

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/** Return a list of human-readable problems; empty means the catalog is valid. */
export function validatePlaybooks(catalog: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(catalog)) return ['catalog: expected an object'];

  if (!isStringArray(catalog.traits)) {
    errors.push('catalog.traits: expected an array of trait names');
  } else {
    for (const trait of catalog.traits) {
      if (!(TRAITS as readonly string[]).includes(trait)) errors.push(`catalog.traits: unknown trait ${trait}`);
    }
  }

  if (!Array.isArray(catalog.playbooks)) {
    errors.push('catalog.playbooks: expected an array');
    return errors;
  }

  const seenIds = new Set<string>();
  catalog.playbooks.forEach((playbook: any, index: number) => {
    const base = `playbooks[${index}]`;
    if (!isRecord(playbook)) {
      errors.push(`${base}: expected an object`);
      return;
    }
    if (typeof playbook.id !== 'string' || playbook.id.trim() === '') errors.push(`${base}.id: expected a non-empty string`);
    else if (seenIds.has(playbook.id)) errors.push(`${base}.id: duplicate id ${playbook.id}`);
    else seenIds.add(playbook.id);
    if (typeof playbook.title !== 'string' || playbook.title.trim() === '') errors.push(`${base}.title: expected a non-empty string`);

    if (!isRecord(playbook.traits)) {
      errors.push(`${base}.traits: expected an object`);
    } else {
      for (const [trait, weight] of Object.entries(playbook.traits)) {
        if (!(TRAITS as readonly string[]).includes(trait)) errors.push(`${base}.traits: unknown trait ${trait}`);
        if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
          errors.push(`${base}.traits.${trait}: expected a positive weight`);
        }
      }
    }

    if (!Array.isArray(playbook.steps)) {
      errors.push(`${base}.steps: expected an array`);
      return;
    }
    playbook.steps.forEach((step: any, stepIndex: number) => {
      const at = `${base}.steps[${stepIndex}]`;
      if (!isRecord(step)) {
        errors.push(`${at}: expected an object`);
        return;
      }
      const allowed = isRecord(step) && typeof step.tool === 'string' ? TOOL_APPLICATIONS[step.tool] : undefined;
      if (typeof step.tool !== 'string' || !allowed) {
        errors.push(`${at}.tool: unknown tool ${String(step.tool)}`);
      }
      if (typeof step.application !== 'string' || !allowed || !allowed.includes(step.application)) {
        errors.push(`${at}.application: unknown application ${String(step.application)}`);
      }
      if (!(RELEVANCE as readonly string[]).includes(step.relevance)) {
        errors.push(`${at}.relevance: expected required|recommended`);
      }
      for (const field of ['consumes', 'produces', 'managerSetup']) {
        if (!isStringArray(step[field])) errors.push(`${at}.${field}: expected an array of strings`);
      }
      if (step.junior !== undefined && typeof step.junior !== 'string') errors.push(`${at}.junior: expected a string`);
    });
  });

  return errors;
}

/** A trait vector: trait name -> weight in [0, 1]. */
export type TraitVector = Record<string, number>;

/**
 * Rank the playbooks that the trait vector activates. A playbook is selected
 * when its weighted score is positive; ties break deterministically by id.
 */
/** A primary trait (weight >= 1) must be at least this likely to activate a
 * playbook; a faint primary signal never selects it on its own. */
export const PRIMARY_TRAIT_THRESHOLD = 0.5;

export function selectPlaybooks(traits: TraitVector, catalog: PlaybookCatalog = loadPlaybooks()): ScoredPlaybook[] {
  for (const [trait, value] of Object.entries(traits)) {
    if (!(TRAITS as readonly string[]).includes(trait)) throw new Error(`selectPlaybooks: unknown trait ${trait}`);
    if (typeof value !== 'number' || value < 0 || value > 1) {
      throw new Error(`selectPlaybooks: ${trait} must be a number in [0, 1]`);
    }
  }

  const scored: ScoredPlaybook[] = [];
  for (const playbook of catalog.playbooks) {
    const contributions: Array<[string, number]> = [];
    let score = 0;
    // A secondary trait only amplifies a playbook whose primary trait (weight
    // >= 1) is present; it never activates the playbook on its own.
    let primary = false;
    for (const [trait, weight] of Object.entries(playbook.traits)) {
      const value = traits[trait] ?? 0;
      if (value <= 0) continue;
      const contribution = value * weight;
      score += contribution;
      contributions.push([trait, contribution]);
      if (weight >= 1 && value >= PRIMARY_TRAIT_THRESHOLD) primary = true;
    }
    if (score <= 0 || !primary) continue;
    contributions.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const explanation = `${contributions.map(([trait, c]) => `${trait} ${c.toFixed(2)}`).join(' + ')} -> ${playbook.id}`;
    scored.push({ ...playbook, score, explanation });
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored;
}

/**
 * Flatten ranked playbooks into one worker-facing plan: each tool application
 * once (strongest relevance wins), the merged setup list, and per-application
 * directions in rank order.
 */
export function toolPlan(selected: ScoredPlaybook[]): ToolPlan {
  const entries = new Map<string, ToolPlanEntry & { produces: string[]; direction: string }>();
  const managerSetup: string[] = [];
  const seenSetup = new Set<string>();

  for (const playbook of selected) {
    for (const step of playbook.steps) {
      const existing = entries.get(step.application);
      if (!existing) {
        entries.set(step.application, {
          tool: step.tool,
          application: step.application,
          relevance: step.relevance,
          produces: [...step.produces],
          direction: step.junior ?? `${step.application} -> ${step.produces.join('; ')}`,
        });
      } else if (step.relevance === 'required') {
        existing.relevance = 'required';
      }
      for (const setup of step.managerSetup) {
        if (!seenSetup.has(setup)) {
          seenSetup.add(setup);
          managerSetup.push(setup);
        }
      }
    }
  }

  const tools = [...entries.values()];
  return {
    tools: tools.map(({ tool, application, relevance }) => ({ tool, application, relevance })),
    managerSetup,
    directions: tools.map((entry) => entry.direction),
  };
}

// ---------------------------------------------------------------------------
// Crossmatrix projection (`junior matrix sync --source playbooks`)
// ---------------------------------------------------------------------------

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

function contentHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(sortKeysDeep(value))).digest('hex')}`;
}

function member(id: string, label: string, payload: unknown): MatrixMember {
  return {
    id,
    label,
    status: 'active',
    sourceRef: {
      system: 'playbooks',
      sourceType: 'playbook',
      sourceRef: `playbooks:${id}`,
      locator: 'playbooks/playbooks.json',
      contentHash: contentHash(payload),
    },
    attributes: {},
  };
}

/** Project the catalog into the three capability dimensions. */
export function playbookDimensions(catalog: PlaybookCatalog = loadPlaybooks()): MatrixDimension[] {
  const traitMembers: MatrixMember[] = (catalog.traits.length > 0 ? catalog.traits : [...TRAITS]).map((trait) => {
    const serving = catalog.playbooks.filter((playbook) => (playbook.traits[trait] ?? 0) > 0).map((p) => p.id);
    const entry = member(`trait:${trait}`, trait, { trait, playbooks: serving });
    entry.attributes = { playbooks: serving };
    return entry;
  });

  const playbookMembers: MatrixMember[] = catalog.playbooks.map((playbook) => {
    const entry = member(`playbook:${playbook.id}`, playbook.title, playbook);
    entry.attributes = { traits: playbook.traits, steps: playbook.steps.map((s) => s.application) };
    return entry;
  });

  const applications = new Map<string, { tool: string; playbooks: Set<string> }>();
  for (const playbook of catalog.playbooks) {
    for (const step of playbook.steps) {
      const existing = applications.get(step.application) ?? { tool: step.tool, playbooks: new Set<string>() };
      existing.playbooks.add(playbook.id);
      applications.set(step.application, existing);
    }
  }
  const applicationMembers: MatrixMember[] = [...applications.entries()].map(([application, entry]) => {
    const memberEntry = member(`application:${application}`, application, { application, tool: entry.tool, playbooks: [...entry.playbooks].sort() });
    memberEntry.sourceRef!.sourceType = 'tool_application';
    memberEntry.attributes = { tool: entry.tool, playbooks: [...entry.playbooks].sort() };
    return memberEntry;
  });

  return [
    { id: 'task-traits', label: 'Task traits', kind: 'criterion', order: 0, system: 'playbooks', members: traitMembers },
    { id: 'playbooks', label: 'Playbooks', kind: 'option', order: 1, system: 'playbooks', members: playbookMembers },
    {
      id: 'tool-applications',
      label: 'Tool applications',
      kind: 'implementation_asset',
      order: 2,
      system: 'playbooks',
      members: applicationMembers,
    },
  ];
}
