// Behavioral tests for the junior-tools CLI/library.
//
// Every scenario is offline, uses its own temp directory, and asserts exactly
// one observable outcome through the public CLI. No source text is inspected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = import.meta.dirname;
const TOOLS = path.join(ROOT, "tools.ts");
const FAKE = path.join(ROOT, "test-fixtures", "fake-mcp.mjs");
const NODE = process.execPath;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "junior-tools-test-"));
}

function toolEntry(mode, extra = {}) {
  return {
    command: NODE,
    args: [FAKE],
    env: { FAKE_MCP_MODE: mode },
    sourceVersion: "0.0.1",
    sourceSha: "0".repeat(64),
    ...extra,
  };
}

function writeConfig(dir, overrides = {}) {
  const cfg = {
    projectId: "test-project",
    timeoutMs: 20000,
    lockTimeoutMs: 5000,
    tools: {
      fmeca: toolEntry("echo"),
      cpm: toolEntry("echo"),
      crossmatrix: toolEntry("crossmatrix"),
    },
    ...overrides,
  };
  const p = path.join(dir, "config.json");
  fs.writeFileSync(p, JSON.stringify(cfg));
  return p;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function runCli(args, timeout = 30000) {
  return spawnSync(NODE, [TOOLS, ...args], {
    encoding: "utf8",
    timeout,
  });
}

function cliJson(result) {
  return JSON.parse(result.stdout);
}

function initHop(dir, overrides) {
  const hop = path.join(dir, "hop.json");
  const cfg = writeConfig(dir, overrides);
  runCli(["init", hop, cfg]);
  return hop;
}

// --- init / manifest contract -------------------------------------------------

test("init writes a schemaVersion 1 manifest", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const manifest = JSON.parse(fs.readFileSync(hop, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
});

test("init persists a stable project id across a later call", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const before = JSON.parse(fs.readFileSync(hop, "utf8")).projectId;
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  runCli(["call", hop, "fmeca", req]);
  const after = JSON.parse(fs.readFileSync(hop, "utf8")).projectId;
  assert.equal(after, before);
});

test("call advances the manifest revision monotonically", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  runCli(["call", hop, "fmeca", req]);
  runCli(["call", hop, "fmeca", req]);
  const manifest = JSON.parse(fs.readFileSync(hop, "utf8"));
  assert.equal(manifest.revision, 2);
});

test("call keeps manager acceptance pending after a worker call", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  runCli(["call", hop, "fmeca", req]);
  const manifest = JSON.parse(fs.readFileSync(hop, "utf8"));
  assert.equal(manifest.managerAcceptance, "pending");
});

test("call records a read snapshot whose sha256 matches the stored file", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  runCli(["call", hop, "fmeca", req]);
  const manifest = JSON.parse(fs.readFileSync(hop, "utf8"));
  const snap = manifest.snapshots[0];
  const bytes = fs.readFileSync(path.resolve(dir, snap.path));
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(snap.sha256, digest);
});

// --- failure surfaces ---------------------------------------------------------

test("missing MCP binary is reported as a spawn error", () => {
  const dir = tmpdir();
  const hop = initHop(dir, {
    tools: {
      fmeca: toolEntry("echo", { command: "/nonexistent/fake-mcp-binary" }),
      cpm: toolEntry("echo"),
      crossmatrix: toolEntry("crossmatrix"),
    },
  });
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  const out = cliJson(runCli(["call", hop, "fmeca", req]));
  assert.equal(out.error.code, "SPAWN_ERROR");
});

test("malformed manifest is rejected", () => {
  const dir = tmpdir();
  const hop = path.join(dir, "hop.json");
  fs.writeFileSync(hop, "{ this is not json");
  const out = cliJson(runCli(["inspect", hop]));
  assert.equal(out.error.code, "MALFORMED_MANIFEST");
});

test("stale expected revision is rejected", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const first = writeJson(path.join(dir, "first.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  runCli(["call", hop, "fmeca", first]);
  const stale = writeJson(path.join(dir, "stale.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
    expectedRevision: 0,
  });
  const out = cliJson(runCli(["call", hop, "fmeca", stale]));
  assert.equal(out.error.code, "STALE_REVISION");
});

test("a timed-out MCP call is reported as a timeout", () => {
  const dir = tmpdir();
  const hop = initHop(dir, {
    timeoutMs: 1200,
    tools: {
      fmeca: toolEntry("timeout"),
      cpm: toolEntry("echo"),
      crossmatrix: toolEntry("crossmatrix"),
    },
  });
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  const out = cliJson(runCli(["call", hop, "fmeca", req]));
  assert.equal(out.error.code, "TIMEOUT");
});

test("upstream tool isError is propagated", () => {
  const dir = tmpdir();
  const hop = initHop(dir, {
    tools: {
      fmeca: toolEntry("error"),
      cpm: toolEntry("echo"),
      crossmatrix: toolEntry("crossmatrix"),
    },
  });
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  const out = cliJson(runCli(["call", hop, "fmeca", req]));
  assert.equal(out.isError, true);
});

test("unsupported operation note is surfaced even when upstream ok is true", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "crossmatrix.command",
    arguments: { request: { requestId: "r1", op: { kind: "observe" } } },
  });
  const out = cliJson(runCli(["call", hop, "crossmatrix", req]));
  assert.equal(out.unsupported, true);
});

test("a held manifest lock blocks a concurrent call", () => {
  const dir = tmpdir();
  const hop = initHop(dir, { lockTimeoutMs: 250 });
  fs.writeFileSync(hop + ".lock", JSON.stringify({ pid: 999999 }));
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  const out = cliJson(runCli(["call", hop, "fmeca", req]));
  assert.equal(out.error.code, "LOCKED");
});

// --- crossmatrix persistence --------------------------------------------------

test("crossmatrix query sees the model imported in an earlier process", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const model = {
    schemaVersion: "0.2.0",
    modelId: "state_demo",
    dimensions: [
      { id: "d1", order: 0, members: [{ id: "a" }] },
      { id: "d2", order: 1, members: [{ id: "x" }] },
    ],
    scales: [],
    relations: [],
  };
  const importReq = writeJson(path.join(dir, "import.json"), {
    tool: "crossmatrix.command",
    arguments: {
      request: { requestId: "import-1", modelId: "state_demo", model },
    },
  });
  runCli(["call", hop, "crossmatrix", importReq]);
  const queryReq = writeJson(path.join(dir, "query.json"), {
    tool: "crossmatrix.query",
    arguments: { request: { requestId: "q1", query: { kind: "validate" } } },
  });
  const out = cliJson(runCli(["call", hop, "crossmatrix", queryReq]));
  assert.equal(out.result.validated, true);
});

// --- inspect ------------------------------------------------------------------

test("inspect lists the snapshots recorded by prior reads", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  runCli(["call", hop, "fmeca", req]);
  const out = cliJson(runCli(["inspect", hop]));
  assert.equal(out.snapshots.length, 1);
});
