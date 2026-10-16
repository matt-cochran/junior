#!/usr/bin/env node
// Schema validator and coverage reporter for the Junior routing evaluation set.
//
// Usage: node tasks/routing-eval/validate.mjs
// Exit 0 only when every case is schema-valid and the coverage minimums hold.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(HERE, "cases");

const REQUIRED_CASE_COUNT = 30;
const MIN_NO_TOOL_CASES = 4;
const MIN_CASES_PER_TOOL = 3;
const MIN_MULTI_TOOL_CASES = 5;
const FILE_PATTERN = /^(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;

const TOOLS = [
  "cpm",
  "fmeca",
  "crossmatrix",
  "elicitation",
  "scientific-process",
  "jevitate",
  "triz",
];

// Allowed `tool:application` values, grounded in skills/junior/SKILL.md and
// tools/README.md.
const APPLICATIONS = {
  cpm: [
    "cpm:plan-backed-deliverable",
    "cpm:lease-cohort",
    "cpm:earned-value",
  ],
  fmeca: ["fmeca:risk-before-change", "fmeca:readiness-assess"],
  crossmatrix: [
    "crossmatrix:codemap-context",
    "crossmatrix:house-of-quality",
    "crossmatrix:multidimensional-matrix",
    "crossmatrix:test-coverage",
    "crossmatrix:stale-relink",
  ],
  elicitation: ["elicitation:requirements-interview"],
  "scientific-process": ["scientific-process:hypothesis-experiment"],
  jevitate: ["jevitate:browser-check"],
  triz: ["triz:contradiction"],
};

const WORKFLOWS = ["recon", "test_first", "checks_first", "fmeca", "evaluate", "qa", "auto"];
const RELEVANCE = ["required", "recommended"];

const violations = [];
const fail = (file, message) => violations.push(`${file}: ${message}`);

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const isStringArray = (v) => Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString);

function validateContract(file, contract) {
  if (!isPlainObject(contract)) return fail(file, "`contract` must be an object");
  if (!isNonEmptyString(contract.id)) fail(file, "`contract.id` must be a non-empty string");
  if (!isNonEmptyString(contract.deliverable)) fail(file, "`contract.deliverable` must be a non-empty string");
  if (!WORKFLOWS.includes(contract.workflow)) {
    fail(file, `\`contract.workflow\` must be one of ${WORKFLOWS.join("|")}`);
  }
  if (!isStringArray(contract.acceptance)) {
    fail(file, "`contract.acceptance` must be a non-empty array of non-empty strings");
  }
  if (!isStringArray(contract.constraints)) {
    fail(file, "`contract.constraints` must be a non-empty array of non-empty strings");
  }
  return contract.id;
}

function validateExpected(file, expected) {
  if (!isPlainObject(expected)) return fail(file, "`expected` must be an object");

  if (!Array.isArray(expected.tools)) {
    fail(file, "`expected.tools` must be an array");
  } else {
    const seen = new Set();
    for (const [i, entry] of expected.tools.entries()) {
      const at = `expected.tools[${i}]`;
      if (!isPlainObject(entry)) {
        fail(file, `${at} must be an object`);
        continue;
      }
      if (!TOOLS.includes(entry.tool)) {
        fail(file, `${at}.tool must be one of ${TOOLS.join("|")}`);
      }
      if (!APPLICATIONS[entry.tool] || !APPLICATIONS[entry.tool].includes(entry.application)) {
        fail(file, `${at}.application is not an allowed application for ${entry.tool}`);
      } else if (!entry.application.startsWith(`${entry.tool}:`)) {
        fail(file, `${at}.application must be prefixed with ${entry.tool}:`);
      }
      if (!RELEVANCE.includes(entry.relevance)) {
        fail(file, `${at}.relevance must be required|recommended`);
      }
      const key = `${entry.tool}\u0000${entry.application}`;
      if (seen.has(key)) fail(file, `${at} duplicates ${entry.tool}:${entry.application}`);
      seen.add(key);
    }
  }

  if (!Array.isArray(expected.notTools) || !expected.notTools.every((t) => TOOLS.includes(t))) {
    fail(file, `\`expected.notTools\` must be an array of allowed tool names`);
  } else if (Array.isArray(expected.tools)) {
    const used = new Set(expected.tools.map((t) => t.tool));
    for (const t of expected.notTools) {
      if (used.has(t)) fail(file, `\`expected.notTools\` lists ${t} which is also expected`);
    }
    if (new Set(expected.notTools).size !== expected.notTools.length) {
      fail(file, "`expected.notTools` must not contain duplicates");
    }
  }

  if (!Array.isArray(expected.managerSetup) || !expected.managerSetup.every(isNonEmptyString)) {
    fail(file, "`expected.managerSetup` must be an array of non-empty strings");
  } else if (Array.isArray(expected.tools) && expected.tools.length > 0 && expected.managerSetup.length === 0) {
    fail(file, "`expected.managerSetup` must be non-empty when tools are expected");
  }

  if (!isNonEmptyString(expected.rationale)) {
    fail(file, "`expected.rationale` must be a non-empty string");
  } else if ((expected.rationale.match(/[.!?](?:\s|$)/g) ?? []).length > 1) {
    fail(file, "`expected.rationale` must be exactly one sentence");
  }
}

function main() {
  if (!existsSync(CASES_DIR)) {
    console.error(`missing cases directory: ${CASES_DIR}`);
    process.exit(1);
  }

  const files = readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort();
  const nonJson = readdirSync(CASES_DIR).filter((f) => !f.endsWith(".json"));
  for (const f of nonJson) fail(f, "unexpected non-JSON file in cases/");
  if (files.length !== REQUIRED_CASE_COUNT) {
    fail("cases/", `expected exactly ${REQUIRED_CASE_COUNT} case files, found ${files.length}`);
  }

  const seenIds = new Map();
  const perTool = new Map(TOOLS.map((t) => [t, { cases: 0, required: 0, recommended: 0 }]));
  let noToolCases = 0;
  let multiToolCases = 0;

  for (const file of files) {
    if (!FILE_PATTERN.test(file)) fail(file, "file name must match <nn>-<slug>.json");
    let raw;
    try {
      raw = JSON.parse(readFileSync(join(CASES_DIR, file), "utf8"));
    } catch (err) {
      fail(file, `invalid JSON: ${err.message}`);
      continue;
    }
    if (!isPlainObject(raw)) {
      fail(file, "case must be a JSON object");
      continue;
    }
    const id = validateContract(file, raw.contract);
    validateExpected(file, raw.expected);

    if (id !== undefined) {
      if (seenIds.has(id)) fail(file, `duplicate contract id ${id} (also in ${seenIds.get(id)})`);
      else seenIds.set(id, file);
    }

    if (isPlainObject(raw.expected) && Array.isArray(raw.expected.tools)) {
      const tools = raw.expected.tools.filter((t) => isPlainObject(t));
      const distinct = new Set(tools.map((t) => t.tool));
      if (distinct.size === 0) noToolCases += 1;
      if (distinct.size >= 2) multiToolCases += 1;
      for (const t of tools) {
        const row = perTool.get(t.tool);
        if (row) {
          row.cases += 1;
          if (t.relevance === "required") row.required += 1;
          if (t.relevance === "recommended") row.recommended += 1;
        }
      }
    }
  }

  if (noToolCases < MIN_NO_TOOL_CASES) {
    fail("coverage", `expected at least ${MIN_NO_TOOL_CASES} no-tool cases, found ${noToolCases}`);
  }
  if (multiToolCases < MIN_MULTI_TOOL_CASES) {
    fail("coverage", `expected at least ${MIN_MULTI_TOOL_CASES} multi-tool cases, found ${multiToolCases}`);
  }
  for (const tool of TOOLS) {
    const row = perTool.get(tool);
    if (row.cases < MIN_CASES_PER_TOOL) {
      fail("coverage", `tool ${tool} appears in ${row.cases} cases (min ${MIN_CASES_PER_TOOL})`);
    }
  }

  console.log("Coverage");
  console.log("tool                cases  required  recommended");
  for (const tool of TOOLS) {
    const { cases, required, recommended } = perTool.get(tool);
    console.log(`${tool.padEnd(20)}${String(cases).padStart(5)}${String(required).padStart(10)}${String(recommended).padStart(13)}`);
  }
  console.log("");
  console.log(`cases: ${files.length}  no-tool: ${noToolCases}  multi-tool: ${multiToolCases}`);

  if (violations.length > 0) {
    console.error("\nViolations");
    for (const v of violations) console.error(`  - ${v}`);
    console.error(`\n${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log("\nOK");
}

main();