// Behavioral tests for the Junior skill's route-selection surface.
//
// The skill's frontmatter description and its first headings are what a
// post-compaction agent reads first: they must name every route trigger, the
// route table is generated from `routes.ts` (the source of truth), the planning
// quick path follows immediately, and no command mentioned may be invented.
// Every scenario is offline, deterministic, and asserts exactly one observable
// outcome through the skill file as the public interface.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { ROUTES } from './routes.ts';

const ROOT = import.meta.dirname;
const SKILL = readFileSync(`${ROOT}/skills/junior/SKILL.md`, 'utf8');
const LINES = SKILL.split('\n');

/** Lines of the Skill's frontmatter, exclusive of the two `---` fences. */
function frontmatterLines(): string[] {
  assert.equal(LINES[0], '---');
  const end = LINES.indexOf('---', 1);
  return LINES.slice(1, end);
}

/** The single frontmatter `description` value, rejoined when wrapped. */
function description(): string {
  const lines = frontmatterLines();
  const start = lines.findIndex((line) => line.startsWith('description:'));
  const collected: string[] = [lines[start].slice('description:'.length).trim()];
  for (let i = start + 1; i < lines.length && lines[i].startsWith(' '); i++) {
    collected.push(lines[i].trim());
  }
  return collected.join(' ');
}

/** 1-based line number of a heading, or -1 when absent. */
function headingLine(heading: string): number {
  return LINES.findIndex((line) => line.trim() === heading) + 1;
}

/** The markdown table rows inside the first section after a heading. */
function tableRowsAfter(heading: string): string[] {
  const start = LINES.findIndex((line) => line.trim() === heading);
  const rows: string[] = [];
  for (let i = start + 1; i < LINES.length; i++) {
    const line = LINES[i];
    if (/^##\s/.test(line)) break;
    if (line.trim().startsWith('|')) rows.push(line);
  }
  return rows;
}

test('description is at most 1024 characters', () => {
  assert.ok(description().length <= 1024, `description is ${description().length} chars`);
});

test('description names every route trigger a post-compaction agent needs', () => {
  const text = description().toLowerCase();
  const required = ['delegate', 'cpm', 'plan', 'fmeca', 'risk', 'crossmatrix', 'traceability', 'discover', 'investigate', 'triz', 'mcp'];
  const missing = required.filter((keyword) => !text.includes(keyword));
  assert.deepEqual(missing, []);
});

test('the Choose a route heading starts within the first 40 lines', () => {
  const line = headingLine('## Choose a route');
  assert.ok(line >= 1 && line <= 40, `## Choose a route starts at line ${line}`);
});

test('the route table has one first cell per route id in manifest order', () => {
  const ids = tableRowsAfter('## Choose a route')
    .filter((row) => !/^\|\s*-+/.test(row) && !/^\|\s*Route\s*\|/.test(row))
    .map((row) => row.split('|')[1]?.trim());
  assert.deepEqual(ids, ROUTES.map((route) => `\`${route.id}\``));
});

test('every route table row contains its route first command', () => {
  const rows = tableRowsAfter('## Choose a route');
  const missing = ROUTES.filter((route) => {
    const row = rows.find((candidate) => candidate.split('|')[1]?.trim() === `\`${route.id}\``);
    return !row || !row.includes(route.first);
  }).map((route) => route.id);
  assert.deepEqual(missing, []);
});

test('the Planning with Junior heading starts before line 80', () => {
  const line = headingLine('## Planning with Junior');
  assert.ok(line >= 1 && line < 80, `## Planning with Junior starts at line ${line}`);
});

test('every junior command mentioned in the skill is dispatched by the CLI', () => {
  const source = readFileSync(`${ROOT}/junior.ts`, 'utf8');
  const commands = new Set<string>();
  for (const m of source.matchAll(/^\s*([a-z][a-z0-9-]*):\s*\{\s*flags:/gm)) commands.add(m[1]);
  for (const m of source.matchAll(/command === '([a-z][a-z0-9-]*)'/g)) commands.add(m[1]);
  const mentioned = new Set<string>();
  // Only commands in code spans count; prose such as "a junior engineer" does not.
  for (const span of SKILL.matchAll(/`([^`\n]+)`/g)) {
    for (const m of span[1].matchAll(/(?:^|\s)junior[ \t]+([a-z][a-z0-9-]*)/g)) {
      if (span[1][m.index + m[0].length] === '-') continue;
      mentioned.add(m[1]);
    }
  }
  const unknown = [...mentioned].filter((word) => !commands.has(word)).sort();
  assert.deepEqual(unknown, []);
});

test('the skill documents an inline key=value tools call form', () => {
  assert.match(SKILL, /junior tools call \w+ \w+\.\w+ [\w.]+=/);
});

test('the skill documents the stdin dash tools call form', () => {
  assert.match(SKILL, /junior tools call \w+ -/);
});

test('the skill documents the request file tools call form', () => {
  assert.match(SKILL, /junior tools call \w+ \S+\.json/);
});
