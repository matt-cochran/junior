// Behavioral tests for the jevitate <-> elicitation <-> crossmatrix bridge.
//
// Every scenario is offline and uses literal fixtures. Each test asserts
// exactly one observable outcome through the public module/CLI interface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHop } from './tools/tools.ts';
import { draftJobsFromSpec, journeyEvidence, seedElicitation } from './jtbd-bridge.ts';

const ROOT = import.meta.dirname;
const JUNIOR = join(ROOT, 'junior.ts');
const FAKE = join(ROOT, 'tools', 'test-fixtures', 'fake-mcp.mjs');
const NODE = process.execPath;

const JOB = {
  id: 'record-verdict',
  trigger: 'a review item is waiting for my judgement',
  motivation: 'record whether it works',
  outcome: 'the team knows what to fix next',
  priority: 'high',
  steps: [
    { id: 'find', name: 'Find the item to judge', stage: 'locate' },
    { id: 'judge', name: 'Record the verdict', stage: 'execute' },
    { id: 'confirm', name: 'Confirm the verdict was saved', stage: 'confirm' },
  ],
  desiredOutcomes: [
    {
      id: 'verdict-fast',
      direction: 'minimize',
      measure: 'time',
      object: 'the time it takes to record a verdict',
      gulf: 'execution',
      target: { op: '<=', value: 30, unit: 's' },
      priority: 'high',
    },
    {
      id: 'verdict-wrong-item',
      direction: 'minimize',
      measure: 'likelihood',
      object: 'the likelihood of judging the wrong item',
      target: { op: '<=', value: 5, unit: 'percent' },
    },
  ],
};

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'junior-jtbd-'));
}

// --- seedElicitation --------------------------------------------------------

test('seedElicitation covers every step stage and desired outcome', () => {
  const seed = seedElicitation(JOB);
  assert.deepEqual(
    seed.sessionOpen.coverage_schema.dimensions.map((d) => d.tag),
    ['locate', 'execute', 'confirm', 'verdict-fast', 'verdict-wrong-item'],
  );
});

test('seedElicitation identifies each outcome claim by its job and outcome ids', () => {
  const seed = seedElicitation(JOB);
  const outcomeClaimIds = seed.claims
    .filter((payload) => payload.claim.predicate !== 'job_story')
    .map((payload) => payload.claim.id);
  assert.deepEqual(outcomeClaimIds, [
    'job:record-verdict/outcome:verdict-fast',
    'job:record-verdict/outcome:verdict-wrong-item',
  ]);
});

test('seedElicitation tags each outcome claim with its matching coverage dimension', () => {
  const seed = seedElicitation(JOB);
  const fast = seed.claims.find((payload) => payload.claim.id.endsWith('verdict-fast'));
  assert.deepEqual(fast?.claim.dimensions, ['verdict-fast']);
});

// --- journeyEvidence --------------------------------------------------------

test('journeyEvidence supports the outcomes of a passing linked journey', () => {
  const evidence = journeyEvidence(JOB, {
    journeyId: 'jz-guide',
    job: 'record-verdict',
    serves: ['verdict-fast'],
    outcome: 'ok',
  });
  assert.deepEqual(evidence.map((payload) => payload.evidence.source_type), ['app_research_support']);
});

test('journeyEvidence refutes the outcomes of a failing linked journey', () => {
  const evidence = journeyEvidence(JOB, {
    journeyId: 'jz-guide',
    metadata: { job: 'record-verdict', serves: ['verdict-fast', 'verdict-wrong-item'] },
    outcome: 'heal-exhausted',
  });
  assert.deepEqual(evidence.map((payload) => payload.evidence.source_type), [
    'app_research_refutation',
    'app_research_refutation',
  ]);
});

test('journeyEvidence ignores a journey linked to a different job', () => {
  const evidence = journeyEvidence(JOB, { job: 'some-other-job', serves: ['verdict-fast'], outcome: 'ok' });
  assert.deepEqual(evidence, []);
});

// --- draftJobsFromSpec ------------------------------------------------------

const SPEC = {
  session_id: 'job:record-verdict',
  ready: true,
  dimensions: [
    {
      dimension: 'verdict-fast',
      hypotheses: [
        {
          claim_id: 'job:record-verdict/outcome:verdict-fast',
          statement: 'outcome:record-verdict/verdict-fast minimize+time <= 30 s',
          standing: 'withstood',
          source_turn: 'job:record-verdict/outcome:verdict-fast',
        },
      ],
    },
  ],
  requirements: [
    {
      id: 'verdict-fast',
      statement: 'the time it takes to record a verdict',
      subject: { id: 'outcome:record-verdict/verdict-fast' },
      capability: 'minimize+time',
      priority: 'must',
      standing: 'withstood',
    },
  ],
  accepted_tensions: [],
  blockers: [],
};

test('draftJobsFromSpec never marks a draft approved', () => {
  const drafts = draftJobsFromSpec(SPEC, []);
  assert.equal('approval' in drafts[0], false);
});

test('draftJobsFromSpec bumps the revision of an existing job', () => {
  const drafts = draftJobsFromSpec(SPEC, [
    { id: 'record-verdict', trigger: 't', motivation: 'm', outcome: 'o', revision: 2 },
  ]);
  assert.equal(drafts[0].revision, 3);
});

test('draftJobsFromSpec marks the drafted provenance as elicitation', () => {
  const drafts = draftJobsFromSpec(SPEC, []);
  assert.equal(drafts[0].provenance, 'elicitation');
});

// --- CLI: `junior matrix jtbd draft` ---------------------------------------

function draftRepo(): string {
  const repo = workdir();
  mkdirSync(join(repo, '.jevitate'), { recursive: true });
  writeFileSync(
    join(repo, '.jevitate', 'jobs.json'),
    JSON.stringify([{ id: 'record-verdict', trigger: 't', motivation: 'm', outcome: 'o' }]),
  );
  writeFileSync(join(repo, 'spec.json'), JSON.stringify(SPEC));
  return repo;
}

test('matrix jtbd draft leaves the jevitate catalog unchanged', () => {
  const repo = draftRepo();
  const jobsPath = join(repo, '.jevitate', 'jobs.json');
  const before = readFileSync(jobsPath, 'utf8');
  spawnSync(NODE, [JUNIOR, 'matrix', 'jtbd', 'draft', '--dir', repo, '--spec', join(repo, 'spec.json')], {
    encoding: 'utf8',
  });
  assert.equal(readFileSync(jobsPath, 'utf8'), before);
});

test('matrix jtbd draft writes the drafts beside the catalog', () => {
  const repo = draftRepo();
  spawnSync(NODE, [JUNIOR, 'matrix', 'jtbd', 'draft', '--dir', repo, '--spec', join(repo, 'spec.json')], {
    encoding: 'utf8',
  });
  assert.equal(existsSync(join(repo, '.jevitate', 'jobs.draft.json')), true);
});

// --- CLI: `junior matrix jtbd seed` through the fake MCP fixture ------------

test('matrix jtbd seed sends a session open and one append per claim', () => {
  const dir = workdir();
  const hop = join(dir, 'hop.json');
  initHop(hop, {
    managedStatePath: join(dir, 'no-managed-tools.json'),
    tools: {
      elicitation: {
        command: NODE,
        args: [FAKE],
        env: { FAKE_MCP_MODE: 'echo' },
        sourceVersion: '1.0.0',
        sourceSha: '0'.repeat(64),
      },
    },
  });
  mkdirSync(join(dir, '.jevitate'), { recursive: true });
  writeFileSync(join(dir, '.jevitate', 'jobs.json'), JSON.stringify([JOB]));
  spawnSync(NODE, [JUNIOR, 'matrix', 'jtbd', 'seed', '--hop', hop, '--dir', dir], { encoding: 'utf8' });
  const evidence = JSON.parse(readFileSync(hop, 'utf8')).evidence ?? [];
  assert.deepEqual(evidence.map((entry: any) => entry.toolName), ['session.open', 'append', 'append', 'append']);
});
