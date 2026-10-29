import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, TOOLS, FAKE, NODE, tmpdir, toolEntry, writeConfig, writeJson, runCli, cliJson, initHop, defaultHop, nestedProjectHop, legacyHop, STORED_MODEL, crossmatrixHop, storeHop, commandRequest, readWrites, scientificHop, readScientificCalls, crossmatrixManifest, buildToolEnv, initHopManifest, crossmatrixUsesStore, callHop } from "./tools-helpers.test.ts";

// --- call ergonomics ----------------------------------------------------------
//
// `call` keeps the request-file form, defaults the hop when the first argument
// is a tool name, accepts inline `method key=value` arguments, and prints only
// the result value unless `--full` asks for the whole envelope.

test("call defaults the hop to .delivery/setup/hop.json under the current directory", () => {
  const dir = tmpdir();
  defaultHop(dir);
  const result = runCli(["call", "fmeca", "state.get", "session_id=s1"], 30000, {}, { cwd: dir });
  assert.equal(result.status, 0);
});


test("call uses the persisted active Hop selection when no Hop is explicit", () => {
  const root = tmpdir();
  nestedProjectHop(root, "alpha");
  const selected = nestedProjectHop(root, "beta");
  fs.writeFileSync(path.join(root, ".delivery", "active-hop.json"), JSON.stringify({ hop: ".delivery/beta/hop.json" }));
  runCli(["call", "fmeca", "state.get", "session_id=s1"], 30000, {}, { cwd: root });
  const manifest = JSON.parse(fs.readFileSync(selected, "utf8"));
  assert.equal(manifest.revision, 1);
});

test("an explicit Hop path wins over the persisted active selection", () => {
  const root = tmpdir();
  const explicit = nestedProjectHop(root, "alpha");
  nestedProjectHop(root, "beta");
  fs.writeFileSync(path.join(root, ".delivery", "active-hop.json"), JSON.stringify({ hop: ".delivery/beta/hop.json" }));
  runCli(["call", explicit, "fmeca", "state.get", "session_id=s1"], 30000, {}, { cwd: root });
  const manifest = JSON.parse(fs.readFileSync(explicit, "utf8"));
  assert.equal(manifest.revision, 1);
});

test("inline key=value arguments decode JSON values and keep bare tokens as strings", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const result = runCli([
    "call",
    hop,
    "cpm",
    "plan.status",
    "plan_id=plan_x",
    "max_count=1",
    'ids=["A"]',
    'status={"status":"complete"}',
  ]);
  assert.deepEqual(cliJson(result).echo, {
    plan_id: "plan_x",
    max_count: 1,
    ids: ["A"],
    status: { status: "complete" },
  });
});

test("compact success prints only the result value", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const result = runCli(["call", hop, "fmeca", "state.get", "session_id=s1"]);
  assert.deepEqual(cliJson(result), { ok: true, echo: { session_id: "s1" } });
});

test("compact success writes one summary line to stderr", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const result = runCli(["call", hop, "fmeca", "state.get", "session_id=s1"]);
  assert.match(result.stderr, /^junior tools: fmeca state\.get revision 1 snapshot snap_/);
});

test("compact failure exits 1", () => {
  const dir = tmpdir();
  const hop = initHop(dir, {
    tools: {
      fmeca: toolEntry("error"),
      cpm: toolEntry("echo"),
      crossmatrix: toolEntry("crossmatrix"),
    },
  });
  const result = runCli(["call", hop, "fmeca", "state.get", "session_id=s1"]);
  assert.equal(result.status, 1);
});

test("--full still exits 1 on a tool failure", () => {
  const dir = tmpdir();
  const hop = initHop(dir, {
    tools: {
      fmeca: toolEntry("error"),
      cpm: toolEntry("echo"),
      crossmatrix: toolEntry("crossmatrix"),
    },
  });
  const result = runCli(["call", "--full", hop, "fmeca", "state.get", "session_id=s1"]);
  assert.equal(result.status, 1);
});

test("compact tool failure prints an ok:false error envelope", () => {
  const dir = tmpdir();
  const hop = initHop(dir, {
    tools: {
      fmeca: toolEntry("error"),
      cpm: toolEntry("echo"),
      crossmatrix: toolEntry("crossmatrix"),
    },
  });
  const result = runCli(["call", hop, "fmeca", "state.get", "session_id=s1"]);
  assert.equal(cliJson(result).error.code, "UPSTREAM_ERROR");
});

test("a - request path reads the request from stdin", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const input = JSON.stringify({ tool: "state.get", arguments: { session_id: "s1" } });
  const result = runCli(["call", hop, "fmeca", "-"], 30000, {}, { input });
  assert.deepEqual(cliJson(result), { ok: true, echo: { session_id: "s1" } });
});

test("the request-file form still works", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  const result = runCli(["call", hop, "fmeca", req]);
  assert.deepEqual(cliJson(result), { ok: true, echo: { session_id: "s1" } });
});

test("--full prints the full call envelope", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const result = runCli(["call", "--full", hop, "fmeca", "state.get", "session_id=s1"]);
  assert.equal(cliJson(result).kind, "read");
});

test("an unknown call option fails with USAGE", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const result = runCli(["call", "--nope", hop, "fmeca", "state.get"]);
  assert.equal(cliJson(result).error.code, "USAGE");
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

test("an old hop without the new tools still runs a cpm call", () => {
  const dir = tmpdir();
  const hop = legacyHop(dir);
  const req = writeJson(path.join(dir, "req.json"), { tool: "plan.status", arguments: {} });
  const out = cliJson(runCli(["call", "--full", hop, "cpm", req]));
  assert.equal(out.ok, true);
});

test("calling a new tool on an old hop names the re-init remedy", () => {
  const dir = tmpdir();
  const hop = legacyHop(dir);
  const req = writeJson(path.join(dir, "req.json"), { tool: "state.get", arguments: {} });
  const out = cliJson(runCli(["call", hop, "scientific-process", req]));
  assert.match(out.error.message, /junior init --install/);
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
  const out = cliJson(runCli(["call", "--full", hop, "fmeca", req]));
  assert.equal(out.isError, true);
});

test("unsupported operation note is surfaced even when upstream ok is true", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "crossmatrix.command",
    arguments: { request: { requestId: "r1", op: { kind: "observe" } } },
  });
  const out = cliJson(runCli(["call", "--full", hop, "crossmatrix", req]));
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
  const out = cliJson(runCli(["call", "--full", hop, "crossmatrix", queryReq]));
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

// --- crossmatrix project store (0.3.0+) ---------------------------------------
//
// Crossmatrix 0.3+ keeps its validated model in a committed
// `<project>/.crossmatrix` store. The wrapper points the server at that store
// instead of replaying the imported model; 0.2.x keeps the legacy
// wrapper-owned replay.


test("buildToolEnv points CROSSMATRIX_DIR at the git project's store", () => {
  const root = tmpdir();
  const project = path.join(root, "project");
  const hopDir = path.join(project, "sub");
  fs.mkdirSync(hopDir, { recursive: true });
  fs.mkdirSync(path.join(project, ".git"));
  fs.mkdirSync(path.join(project, ".crossmatrix"));
  const env = buildToolEnv(path.join(hopDir, "hop.json"), "crossmatrix", crossmatrixManifest());
  assert.deepEqual(env, { CROSSMATRIX_DIR: path.join(project, ".crossmatrix") });
});

test("buildToolEnv falls back to the nearest project marker when git cannot resolve a repository", () => {
  const root = tmpdir();
  const project = path.join(root, "project");
  const hopDir = path.join(project, "sub");
  fs.mkdirSync(hopDir, { recursive: true });
  // Keep the fallback bounded to this fixture even when the OS temp root sits
  // inside an unrelated repository. The empty marker makes `git rev-parse`
  // fail, so the walk below exercises the fallback path.
  fs.mkdirSync(path.join(project, ".git"));
  fs.mkdirSync(path.join(project, ".crossmatrix"));
  const env = buildToolEnv(path.join(hopDir, "hop.json"), "crossmatrix", crossmatrixManifest());
  assert.deepEqual(env, { CROSSMATRIX_DIR: path.join(project, ".crossmatrix") });
});

test("buildToolEnv omits crossmatrix env when the project store is absent", () => {
  const root = tmpdir();
  const hopDir = path.join(root, "project", "sub");
  fs.mkdirSync(hopDir, { recursive: true });
  const env = buildToolEnv(path.join(hopDir, "hop.json"), "crossmatrix", crossmatrixManifest());
  assert.deepEqual(env, {});
});

test("a fresh hop anchors the scientific-process state env beside the hop", () => {
  const dir = tmpdir();
  const hopPath = path.join(dir, "hop.json");
  const manifest = initHopManifest(hopPath, { probeVersion: () => null });
  assert.deepEqual(buildToolEnv(hopPath, "scientific-process", manifest), {
    SCIENTIFIC_PROCESS_STATE_DIR: path.join(dir, "scientific-process-state"),
  });
});

test("a fresh hop anchors the elicitation state env beside the hop", () => {
  const dir = tmpdir();
  const hopPath = path.join(dir, "hop.json");
  const manifest = initHopManifest(hopPath, { probeVersion: () => null });
  assert.deepEqual(buildToolEnv(hopPath, "elicitation", manifest), {
    ELICITATION_STATE_DIR: path.join(dir, "elicitation-state"),
  });
});

test("crossmatrixUsesStore is true for a 0.3.0 source version", () => {
  assert.equal(crossmatrixUsesStore({ tools: { crossmatrix: { sourceVersion: "0.3.0" } } }), true);
});

test("crossmatrixUsesStore is false for a 0.2.1 source version", () => {
  assert.equal(crossmatrixUsesStore({ tools: { crossmatrix: { sourceVersion: "0.2.1" } } }), false);
});

test("crossmatrixUsesStore is false for an unparseable source version", () => {
  assert.equal(crossmatrixUsesStore({ tools: { crossmatrix: { sourceVersion: "not-a-version" } } }), false);
});


test("a 0.3.0 hop sends no model replay before a crossmatrix query", () => {
  const dir = tmpdir();
  const observed = path.join(dir, "server-received-model.json");
  const hop = crossmatrixHop(dir, "0.3.0", observed);
  const req = writeJson(path.join(dir, "query.json"), {
    tool: "crossmatrix.query",
    arguments: { request: { requestId: "q1", query: { kind: "validate" } } },
  });
  runCli(["call", hop, "crossmatrix", req]);
  assert.equal(fs.existsSync(observed), false);
});

test("a 0.2.1 hop still sends the model replay before a crossmatrix query", () => {
  const dir = tmpdir();
  const observed = path.join(dir, "server-received-model.json");
  const hop = crossmatrixHop(dir, "0.2.1", observed);
  const req = writeJson(path.join(dir, "query.json"), {
    tool: "crossmatrix.query",
    arguments: { request: { requestId: "q1", query: { kind: "validate" } } },
  });
  runCli(["call", hop, "crossmatrix", req]);
  assert.equal(fs.existsSync(observed), true);
});

test("a 0.3.0 import does not persist the model to the hop native file", () => {
  const dir = tmpdir();
  const hop = initHop(dir, {
    tools: {
      fmeca: toolEntry("echo"),
      cpm: toolEntry("echo"),
      crossmatrix: toolEntry("crossmatrix", { sourceVersion: "0.3.0" }),
    },
  });
  const req = writeJson(path.join(dir, "import.json"), {
    tool: "crossmatrix.command",
    arguments: { request: { requestId: "import-1", modelId: "state_demo", model: STORED_MODEL } },
  });
  runCli(["call", hop, "crossmatrix", req]);
  assert.equal(fs.existsSync(path.join(dir, "crossmatrix-model.json")), false);
});
// --- crossmatrix 0.3+ per-process model.open ----------------------------------
//
// A Crossmatrix 0.3+ server holds the opened model per process, so `tools call`
// prepends model.open to every store-backed command that names a model. The
// fake write log records both calls in order, proving the open ran in the same
// server session before the real command.


test("a 0.3.0 store call opens the model before the command", () => {
  const dir = tmpdir();
  const log = path.join(dir, "writes.log");
  const hop = storeHop(dir, log, "0.3.0");
  const req = writeJson(path.join(dir, "req.json"), commandRequest({ kind: "dimension.register", dimensionId: "code" }));
  runCli(["call", hop, "crossmatrix", req]);
  const ops = readWrites(log);
  const at = ops.findIndex((entry) => entry.op.kind === "dimension.register");
  assert.equal(ops[at - 1]?.op?.kind, "model.open");
});

test("a 0.3.0 model.open command is not preceded by a second open", () => {
  const dir = tmpdir();
  const log = path.join(dir, "writes.log");
  const hop = storeHop(dir, log, "0.3.0");
  const req = writeJson(path.join(dir, "req.json"), commandRequest({ kind: "model.open" }));
  runCli(["call", hop, "crossmatrix", req]);
  const opens = readWrites(log).filter((entry) => entry.op.kind === "model.open");
  assert.equal(opens.length, 1);
});

test("a 0.2.1 hop sends no extra open before a command", () => {
  const dir = tmpdir();
  const log = path.join(dir, "writes.log");
  const hop = storeHop(dir, log, "0.2.1");
  const req = writeJson(path.join(dir, "req.json"), commandRequest({ kind: "dimension.register", dimensionId: "code" }));
  runCli(["call", hop, "crossmatrix", req]);
  const opens = readWrites(log).filter((entry) => entry.op.kind === "model.open");
  assert.equal(opens.length, 0);
});

test("a 0.3.0 store call reports the command's own result", () => {
  const dir = tmpdir();
  const log = path.join(dir, "writes.log");
  const hop = storeHop(dir, log, "0.3.0");
  const req = writeJson(path.join(dir, "req.json"), commandRequest({ kind: "dimension.register", dimensionId: "code" }));
  const out = cliJson(runCli(["call", "--full", hop, "crossmatrix", req]));
  assert.equal(out.result.op, "dimension.register");
});
// --- scientific-process per-process session prelude ---------------------------
//
// Scientific Process keeps its open session in process memory, and `tools call`
// spawns a fresh server per call, so the wrapper opens the session in the same
// process before any method other than session.open. The session id comes from
// the request arguments (default "default") and is stripped from the forwarded
// method, which the 0.2.0 server scopes to the already-open session.


test("a scientific-process state.get that needs an open session succeeds", async () => {
  const dir = tmpdir();
  const hop = scientificHop(dir, path.join(dir, "calls.log"));
  const out = await callHop(hop, "scientific-process", {
    tool: "state.get",
    arguments: { session_id: "s1" },
  });
  assert.equal(out.ok, true);
});

test("a scientific-process prelude is not recorded as separate evidence", async () => {
  const dir = tmpdir();
  const hop = scientificHop(dir, path.join(dir, "calls.log"));
  await callHop(hop, "scientific-process", { tool: "state.get", arguments: { session_id: "s1" } });
  const manifest = JSON.parse(fs.readFileSync(hop, "utf8"));
  assert.equal(manifest.evidence.length, 1);
});

test("a scientific-process prelude opens the caller's session before the method", async () => {
  const dir = tmpdir();
  const log = path.join(dir, "calls.log");
  const hop = scientificHop(dir, log);
  await callHop(hop, "scientific-process", { tool: "state.get", arguments: { session_id: "s1" } });
  assert.deepEqual(
    readScientificCalls(log).map((call) => call.name),
    ["session.open", "state.get"],
  );
});

test("a scientific-process prelude defaults the session id when the request omits it", async () => {
  const dir = tmpdir();
  const log = path.join(dir, "calls.log");
  const hop = scientificHop(dir, log);
  await callHop(hop, "scientific-process", { tool: "state.get", arguments: {} });
  const open = readScientificCalls(log).find((call) => call.name === "session.open");
  assert.equal(open.arguments.session_id, "default");
});

test("a scientific-process read is forwarded without the wrapper session id", async () => {
  const dir = tmpdir();
  const log = path.join(dir, "calls.log");
  const hop = scientificHop(dir, log);
  await callHop(hop, "scientific-process", { tool: "state.get", arguments: { session_id: "s1", limit: 5 } });
  const call = readScientificCalls(log).find((entry) => entry.name === "state.get");
  assert.deepEqual(call.arguments, { limit: 5 });
});

test("a scientific-process command is forwarded without the wrapper session id", async () => {
  const dir = tmpdir();
  const log = path.join(dir, "calls.log");
  const hop = scientificHop(dir, log);
  await callHop(hop, "scientific-process", {
    tool: "append",
    arguments: { session_id: "s1", observation: { id: "o1" } },
  });
  const call = readScientificCalls(log).find((entry) => entry.name === "append");
  assert.deepEqual(call.arguments, { observation: { id: "o1" } });
});

test("an explicit scientific-process session.open is forwarded exactly once", async () => {
  const dir = tmpdir();
  const log = path.join(dir, "calls.log");
  const hop = scientificHop(dir, log);
  await callHop(hop, "scientific-process", { tool: "session.open", arguments: { session_id: "s1" } });
  assert.equal(readScientificCalls(log).length, 1);
});

