import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, TOOLS, FAKE, NODE, tmpdir, toolEntry, writeConfig, writeJson, runCli, cliJson, initHop, PROBE_SOURCE, writeAuthJson, writeAuthEntries, probeEntry, probeHop, readProbeEnv, companionAuth, MODEL_HOP, projectDefaults, TOOL_NAMES, callHop, cpmModelEnv, companionKeyEnv } from "./tools-helpers.test.ts";

// --- cpm review key derivation -----------------------------------------------
//
// cpm's `plan.review` may need the OpenRouter key Pi manages in auth.json. The
// wrapper derives it into the cpm child spawn env only — never the HOP, argv or
// evidence — and an explicit OPENROUTER_API_KEY / CPM_OPENROUTER_KEY_FILE in
// the process or hop env always wins. A probe MCP server records the review env
// it received so each scenario asserts exactly one child-environment outcome.

test("cpm spawn receives the OpenRouter key Pi manages in auth.json", () => {
  const dir = tmpdir();
  const log = path.join(dir, "probe-env.json");
  writeAuthJson(dir, "sk-derived-from-auth");
  const hop = probeHop(dir, log);
  const req = writeJson(path.join(dir, "req.json"), { tool: "plan.review", arguments: {} });
  runCli(["call", hop, "cpm", req], 30000, { PI_CODING_AGENT_DIR: dir });
  assert.equal(readProbeEnv(log).OPENROUTER_API_KEY, "sk-derived-from-auth");
});

test("an explicit process OPENROUTER_API_KEY is not overridden by auth.json", () => {
  const dir = tmpdir();
  const log = path.join(dir, "probe-env.json");
  writeAuthJson(dir, "sk-derived-from-auth");
  const hop = probeHop(dir, log);
  const req = writeJson(path.join(dir, "req.json"), { tool: "plan.review", arguments: {} });
  runCli(["call", hop, "cpm", req], 30000, { PI_CODING_AGENT_DIR: dir, OPENROUTER_API_KEY: "sk-explicit-process" });
  assert.equal(readProbeEnv(log).OPENROUTER_API_KEY, "sk-explicit-process");
});

test("an explicit hop OPENROUTER_API_KEY is not overridden by auth.json", () => {
  const dir = tmpdir();
  const log = path.join(dir, "probe-env.json");
  writeAuthJson(dir, "sk-derived-from-auth");
  const hop = probeHop(dir, log, { probeEnv: { OPENROUTER_API_KEY: "sk-explicit-hop" } });
  const req = writeJson(path.join(dir, "req.json"), { tool: "plan.review", arguments: {} });
  runCli(["call", hop, "cpm", req], 30000, { PI_CODING_AGENT_DIR: dir });
  assert.equal(readProbeEnv(log).OPENROUTER_API_KEY, "sk-explicit-hop");
});

test("an explicit process CPM_OPENROUTER_KEY_FILE suppresses the derived key", () => {
  const dir = tmpdir();
  const log = path.join(dir, "probe-env.json");
  writeAuthJson(dir, "sk-derived-from-auth");
  const hop = probeHop(dir, log);
  const req = writeJson(path.join(dir, "req.json"), { tool: "plan.review", arguments: {} });
  runCli(["call", hop, "cpm", req], 30000, { PI_CODING_AGENT_DIR: dir, CPM_OPENROUTER_KEY_FILE: "/tmp/review-key" });
  assert.equal(readProbeEnv(log).OPENROUTER_API_KEY, null);
});

test("an explicit hop CPM_OPENROUTER_KEY_FILE suppresses the derived key", () => {
  const dir = tmpdir();
  const log = path.join(dir, "probe-env.json");
  writeAuthJson(dir, "sk-derived-from-auth");
  const hop = probeHop(dir, log, { probeEnv: { CPM_OPENROUTER_KEY_FILE: "/tmp/review-key" } });
  const req = writeJson(path.join(dir, "req.json"), { tool: "plan.review", arguments: {} });
  runCli(["call", hop, "cpm", req], 30000, { PI_CODING_AGENT_DIR: dir });
  assert.equal(readProbeEnv(log).OPENROUTER_API_KEY, null);
});

test("an elicitation spawn receives the OpenRouter key from auth.json", () => {
  const dir = tmpdir();
  const log = path.join(dir, "probe-env.json");
  writeAuthJson(dir, "sk-elicitation-auth");
  const hop = probeHop(dir, log, { tool: "elicitation" });
  const req = writeJson(path.join(dir, "req.json"), { tool: "state.get", arguments: { session_id: "s1" } });
  runCli(["call", hop, "elicitation", req], 30000, { PI_CODING_AGENT_DIR: dir });
  assert.equal(readProbeEnv(log).OPENROUTER_API_KEY, "sk-elicitation-auth");
});

test("an elicitation spawn omits the TypeSafe key when only the OpenRouter key resolves", () => {
  const dir = tmpdir();
  const log = path.join(dir, "probe-env.json");
  writeAuthJson(dir, "sk-elicitation-auth");
  const hop = probeHop(dir, log, { tool: "elicitation" });
  const req = writeJson(path.join(dir, "req.json"), { tool: "state.get", arguments: { session_id: "s1" } });
  runCli(["call", hop, "elicitation", req], 30000, { PI_CODING_AGENT_DIR: dir });
  assert.equal(readProbeEnv(log).TYPESAFE_JEV_API_KEY, null);
});

test("an explicit hop OPENROUTER_API_KEY reaches an elicitation spawn unchanged", () => {
  const dir = tmpdir();
  const log = path.join(dir, "probe-env.json");
  writeAuthJson(dir, "sk-derived-from-auth");
  const hop = probeHop(dir, log, { tool: "elicitation", probeEnv: { OPENROUTER_API_KEY: "sk-explicit-hop" } });
  const req = writeJson(path.join(dir, "req.json"), { tool: "state.get", arguments: { session_id: "s1" } });
  runCli(["call", hop, "elicitation", req], 30000, { PI_CODING_AGENT_DIR: dir });
  assert.equal(readProbeEnv(log).OPENROUTER_API_KEY, "sk-explicit-hop");
});

test("a crossmatrix spawn receives the TypeSafe key from auth.json", () => {
  const dir = tmpdir();
  const log = path.join(dir, "probe-env.json");
  writeAuthEntries(dir, { typesafe: { type: "api_key", key: "ts-crossmatrix-auth" } });
  const hop = probeHop(dir, log, { tool: "crossmatrix" });
  const req = writeJson(path.join(dir, "req.json"), {
    tool: "crossmatrix.query",
    arguments: { request: { requestId: "q1", query: { kind: "validate" } } },
  });
  runCli(["call", hop, "crossmatrix", req], 30000, { PI_CODING_AGENT_DIR: dir });
  assert.equal(readProbeEnv(log).TYPESAFE_JEV_API_KEY, "ts-crossmatrix-auth");
});

// --- companionKeyEnv ---------------------------------------------------------
//
// The shared companion env resolver layers the gateway keys over an explicit
// process/hop env. Every scenario injects the auth reader so no real HOME or
// credential is touched; one assertion observes the returned env map.

test("companionKeyEnv resolves the OpenRouter key from the auth file", () => {
  const out = companionKeyEnv(undefined, {}, companionAuth({ openrouter: { type: "api_key", key: "sk-or-auth" } }));
  assert.deepEqual(out, { OPENROUTER_API_KEY: "sk-or-auth" });
});

test("companionKeyEnv resolves the TypeSafe key from the auth file", () => {
  const out = companionKeyEnv(undefined, {}, companionAuth({ typesafe: { type: "api_key", key: "sk-ts-auth" } }));
  assert.deepEqual(out, { TYPESAFE_JEV_API_KEY: "sk-ts-auth" });
});

test("companionKeyEnv leaves an explicit process key in charge", () => {
  const out = companionKeyEnv(undefined, { OPENROUTER_API_KEY: "sk-process" }, companionAuth({ openrouter: { type: "api_key", key: "sk-or-auth" } }));
  assert.equal(out.OPENROUTER_API_KEY, undefined);
});

test("companionKeyEnv leaves an explicit hop key in charge", () => {
  const out = companionKeyEnv({ OPENROUTER_API_KEY: "sk-hop" }, {}, companionAuth({ openrouter: { type: "api_key", key: "sk-or-auth" } }));
  assert.equal(out.OPENROUTER_API_KEY, undefined);
});

test("companionKeyEnv ignores a blank explicit hop key", () => {
  const out = companionKeyEnv({ OPENROUTER_API_KEY: "   " }, {}, companionAuth({ openrouter: { type: "api_key", key: "sk-or-auth" } }));
  assert.equal(out.OPENROUTER_API_KEY, "sk-or-auth");
});

test("companionKeyEnv lets a CPM key file suppress the OpenRouter key", () => {
  const out = companionKeyEnv(undefined, { CPM_OPENROUTER_KEY_FILE: "/tmp/review-key" }, companionAuth({ openrouter: { type: "api_key", key: "sk-or-auth" } }));
  assert.equal(out.OPENROUTER_API_KEY, undefined);
});

test("the derived review key is never written to the hop or its snapshots", () => {
  const dir = tmpdir();
  writeAuthJson(dir, "sk-canary-secret-value");
  const hop = initHop(dir);
  const req = writeJson(path.join(dir, "req.json"), { tool: "plan.status", arguments: {} });
  runCli(["call", hop, "cpm", req], 30000, { PI_CODING_AGENT_DIR: dir });
  const artifacts = [fs.readFileSync(hop, "utf8")];
  const snapshots = path.join(dir, "snapshots");
  if (fs.existsSync(snapshots)) {
    for (const name of fs.readdirSync(snapshots)) artifacts.push(fs.readFileSync(path.join(snapshots, name), "utf8"));
  }
  assert.equal(artifacts.join("\n").includes("sk-canary-secret-value"), false);
});

test("tools inspect reports cpmReview available when auth.json holds an OpenRouter key", () => {
  const dir = tmpdir();
  writeAuthJson(dir, "sk-inspect-value");
  const hop = initHop(dir);
  const out = cliJson(runCli(["inspect", hop], 30000, { PI_CODING_AGENT_DIR: dir }));
  assert.equal(out.cpmReview, "available");
});

test("tools inspect reports cpmReview unavailable without any OpenRouter key", () => {
  const dir = tmpdir();
  const hop = initHop(dir);
  const out = cliJson(runCli(["inspect", hop], 30000, { PI_CODING_AGENT_DIR: path.join(dir, "empty-agent") }));
  assert.equal(out.cpmReview, "unavailable");
});

test("tools inspect output does not contain the OpenRouter key value", () => {
  const dir = tmpdir();
  writeAuthJson(dir, "sk-inspect-secret-canary");
  const hop = initHop(dir);
  const result = runCli(["inspect", hop], 30000, { PI_CODING_AGENT_DIR: dir });
  assert.equal(result.stdout.includes("sk-inspect-secret-canary"), false);
});

// --- cpm executor model selection --------------------------------------------
//
// cpm spawns must be directed at the project's resolved model when the project
// provider is openrouter, while an explicit CPM_LLM_MODEL still wins. Every
// resolved id is policy-checked with the same commodity gate the rest of Junior
// uses, so a frontier or unknown id fails the call before any child is spawned.

test("cpmModelEnv injects the project openrouter model when nothing explicit is set", () => {
  const out = cpmModelEnv(MODEL_HOP, undefined, {}, () => projectDefaults("openrouter", "deepseek/deepseek-v4.1-flash"));
  assert.deepEqual(out, { CPM_LLM_MODEL: "deepseek/deepseek-v4.1-flash" });
});

test("cpmModelEnv injects nothing when the project provider is not openrouter", () => {
  const out = cpmModelEnv(MODEL_HOP, undefined, {}, () => projectDefaults("local", "deepseek/deepseek-v4.1-flash"));
  assert.deepEqual(out, {});
});

test("cpmModelEnv lets the hop model win over the project model", () => {
  const out = cpmModelEnv(
    MODEL_HOP,
    { CPM_LLM_MODEL: "qwen/qwen3-coder" },
    {},
    () => projectDefaults("openrouter", "deepseek/deepseek-v4.1-flash"),
  );
  assert.deepEqual(out, { CPM_LLM_MODEL: "qwen/qwen3-coder" });
});

test("cpmModelEnv passes a commodity process model through unchanged", () => {
  const out = cpmModelEnv(MODEL_HOP, undefined, { CPM_LLM_MODEL: "moonshotai/kimi-k2" });
  assert.deepEqual(out, { CPM_LLM_MODEL: "moonshotai/kimi-k2" });
});

test("cpmModelEnv refuses a frontier hop model", () => {
  assert.throws(
    () => cpmModelEnv(MODEL_HOP, { CPM_LLM_MODEL: "openai/gpt-5-mini" }),
    (err) => err.code === "frontier_model_refused",
  );
});

test("cpmModelEnv refuses an unknown hop model", () => {
  assert.throws(
    () => cpmModelEnv(MODEL_HOP, { CPM_LLM_MODEL: "mystery/model-x" }),
    (err) => err.code === "unknown_model_refused",
  );
});

test("cpmModelEnv refuses a frontier project model", () => {
  assert.throws(
    () => cpmModelEnv(MODEL_HOP, undefined, {}, () => projectDefaults("openrouter", "anthropic/claude-opus-4")),
    (err) => err.code === "frontier_model_refused",
  );
});

test("a frontier hop CPM_LLM_MODEL fails the cpm call with frontier_model_refused", async () => {
  const dir = tmpdir();
  const log = path.join(dir, "probe-env.json");
  const hop = probeHop(dir, log, { probeEnv: { CPM_LLM_MODEL: "openai/gpt-5-mini" } });
  await assert.rejects(
    callHop(hop, "cpm", { tool: "plan.status", arguments: {} }),
    (err) => err.code === "frontier_model_refused",
  );
});

test("a frontier hop CPM_LLM_MODEL fails the cpm call before the child spawns", async () => {
  const dir = tmpdir();
  const log = path.join(dir, "probe-env.json");
  const hop = probeHop(dir, log, { probeEnv: { CPM_LLM_MODEL: "openai/gpt-5-mini" } });
  await callHop(hop, "cpm", { tool: "plan.status", arguments: {} }).catch(() => {});
  assert.equal(fs.existsSync(log), false);
});

test("a commodity process CPM_LLM_MODEL reaches the cpm child env", () => {
  const dir = tmpdir();
  const log = path.join(dir, "probe-env.json");
  const hop = probeHop(dir, log);
  const req = writeJson(path.join(dir, "req.json"), { tool: "plan.status", arguments: {} });
  runCli(["call", hop, "cpm", req], 30000, { CPM_LLM_MODEL: "qwen/qwen3-coder" });
  assert.equal(readProbeEnv(log).CPM_LLM_MODEL, "qwen/qwen3-coder");
});
