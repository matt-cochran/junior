// Dependency-free fake MCP stdio server used by tools.test.ts.
//
// It speaks newline-delimited JSON-RPC (the MCP stdio framing) and can be
// switched between behaviours with FAKE_MCP_MODE:
//   echo        (default) respond to every tools/call with { ok: true, echo }
//   error       respond with a CallToolResult carrying isError: true
//   rpc-error   respond with a JSON-RPC error object
//   unsupported respond with an ok:true result carrying a deferred/unsupported note
//   timeout     complete initialize, then never answer tools/call
//   crossmatrix emulate the in-memory crossmatrix server (import + queries)
//   elicitation serve real `question.next`/`state.get`/`readiness.assess`/
//               `spec.export` elicitation shapes (defaults to the captured
//               live shapes; override with FAKE_ELICITATION_STATE=<file>)
//   scientific-process
//               emulate the per-process scientific-process server: every
//               method except session.open fails until session.open runs in
//               the same process. Logs each tools/call as { name, arguments }
//               to FAKE_SCIENTIFIC_LOG when set.
//
// The crossmatrix mode intentionally starts with NO model in memory: a fresh
// process only answers `validate: true` if the caller replayed the import
// first. That is how the wrapper's replay-on-fresh-server behaviour is tested.

import fs from "node:fs";
import process from "node:process";

const mode = process.env.FAKE_MCP_MODE || "echo";
const modelFile = process.env.FAKE_MCP_MODEL_FILE;
// Opt-in Crossmatrix 0.3+ write-API mode: when set, every
// crossmatrix.command request is appended as one JSON line to this path and
// succeeds. Unset (the default) keeps the emulated read-only behaviour.
const writeLog = process.env.FAKE_CROSSMATRIX_WRITES;
// Opt-in failure injection for write mode: when this value matches a request's
// requestId or op.kind, that command answers with the real 0.3+ error envelope
// `{ ok: false, error: { code, message } }` (isError: true). Unset = never fail.
const errorOn = process.env.FAKE_CROSSMATRIX_ERROR;
// Opt-in Crossmatrix query results: a JSON file mapping a query kind to the
// result object to return. A value may be an array of pages selected by the
// request's cursor so a client's nextCursor paging can be exercised. Unset
// (the default) keeps the emulated read-only behaviour unchanged.
const queryResponsesFile = process.env.FAKE_CROSSMATRIX_QUERY_RESPONSES;
let queryResponses = null;
if (queryResponsesFile && fs.existsSync(queryResponsesFile)) {
  try {
    queryResponses = JSON.parse(fs.readFileSync(queryResponsesFile, "utf8"));
  } catch {
    queryResponses = null;
  }
}

// Opt-in elicitation state: a JSON file with the real `question.next`/`state.get`
// shapes ({ question, signals, claims, readiness, spec }). Unset (the default)
// serves the real shapes captured from a live elicitation session so the
// clarification loop can be exercised offline.
const elicitationFile = process.env.FAKE_ELICITATION_STATE;
// Opt-in Scientific Process call log: each tools/call is appended as one JSON
// line `{ name, arguments }` so tests can observe the session.open prelude and
// the forwarded method arguments.
const scientificLog = process.env.FAKE_SCIENTIFIC_LOG;
const DEFAULT_ELICITATION = (() => {
  const coverageGap = {
    claims: [],
    code: "coverage_gap",
    dimension: "acceptance",
    kind: "clarify",
    message: "Coverage dimension 'acceptance' has no withstood hypothesis.",
    suggested_question: "The acceptance hypothesis isn't settled yet \u2014 can you confirm or refute it?",
  };
  const openHypothesis = (claimId, dimension) => ({
    claims: [claimId],
    code: "open_hypothesis",
    dimension,
    kind: "clarify",
    message: `Hypothesis '${claimId}' has no evidence yet; seek user assent or refutation.`,
    suggested_question: `Can you confirm: ${claimId}?`,
  });
  return {
    question: coverageGap,
    signals: [
      coverageGap,
      openHypothesis("clarify:live-clarify/acceptance:0", "acceptance"),
      openHypothesis("clarify:live-clarify/acceptance:1", "acceptance"),
      openHypothesis("clarify:live-clarify/assumption:0", "assumptions"),
    ],
    claims: [
      { id: "clarify:live-clarify/acceptance:0", subject: { id: "clarify:live-clarify", label: "Add a widget" }, object: { kind: "value", value: "Widget works" }, dimensions: ["acceptance"] },
      { id: "clarify:live-clarify/acceptance:1", subject: { id: "clarify:live-clarify", label: "Add a widget" }, object: { kind: "value", value: "Widget is fast" }, dimensions: ["acceptance"] },
      { id: "clarify:live-clarify/assumption:0", subject: { id: "clarify:live-clarify", label: "Add a widget" }, object: { kind: "value", value: "The API is stable" }, dimensions: ["assumptions"] },
    ],
    readiness: { ready: false, blockers: [] },
    spec: { session_id: "clarify:live-clarify", ready: true, requirements: [], blockers: [] },
  };
})();
function loadElicitationState() {
  if (elicitationFile && fs.existsSync(elicitationFile)) {
    try {
      return JSON.parse(fs.readFileSync(elicitationFile, "utf8"));
    } catch {
      /* fall through to the default real shapes */
    }
  }
  return DEFAULT_ELICITATION;
}

let model = null;
let scientificSession = null;
if (modelFile && fs.existsSync(modelFile)) {
  try {
    model = JSON.parse(fs.readFileSync(modelFile, "utf8"));
  } catch {
    model = null;
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function structured(value, isError) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: isError === true,
  };
}

function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "0.0.1" },
      },
    });
    return;
  }

  if (msg.method === "notifications/initialized") return;

  if (msg.method === "tools/call") {
    if (mode === "timeout") return;
    if (mode === "rpc-error") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: "upstream rpc failure" },
      });
      return;
    }
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};

    if (mode === "error") {
      send({ jsonrpc: "2.0", id: msg.id, result: structured("boom", true) });
      return;
    }

    if (mode === "unsupported") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: structured({
          ok: true,
          op: args?.request?.op?.kind ?? "unknown",
          note: "op not supported in this build (mutation ops deferred — see ADR-0004; needs a core write-API)",
          links: ["query"],
        }),
      });
      return;
    }

    if (mode === "elicitation") {
      const state = loadElicitationState();
      if (name === "session.open") {
        send({ jsonrpc: "2.0", id: msg.id, result: structured({ ok: true, session_id: args?.session_id }) });
        return;
      }
      if (name === "append") {
        send({ jsonrpc: "2.0", id: msg.id, result: structured({ ok: true, variant: args?.variant }) });
        return;
      }
      if (name === "question.next") {
        send({ jsonrpc: "2.0", id: msg.id, result: structured({ question: state.question }) });
        return;
      }
      if (name === "state.get") {
        send({ jsonrpc: "2.0", id: msg.id, result: structured({ signals: state.signals, claims: state.claims }) });
        return;
      }
      if (name === "readiness.assess") {
        send({ jsonrpc: "2.0", id: msg.id, result: structured(state.readiness) });
        return;
      }
      if (name === "spec.export") {
        send({ jsonrpc: "2.0", id: msg.id, result: structured({ spec: state.spec }) });
        return;
      }
      send({ jsonrpc: "2.0", id: msg.id, result: structured({ ok: true }) });
      return;
    }

    if (mode === "scientific-process") {
      if (scientificLog) {
        try {
          fs.appendFileSync(scientificLog, JSON.stringify({ name, arguments: args }) + "\n");
        } catch {
          /* ignore */
        }
      }
      if (name === "session.open") {
        scientificSession = typeof args?.session_id === "string" ? args.session_id : null;
        send({ jsonrpc: "2.0", id: msg.id, result: structured({ message: "session opened", status: "ok" }) });
        return;
      }
      if (scientificSession === null) {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: structured("no session open; call session.open first", true),
        });
        return;
      }
      if (name === "state.get") {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: structured({ experiments: [], hypotheses: [], observations: [] }),
        });
        return;
      }
      if (name === "experiment.next") {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: structured({ id: "h1", statement: "next experiment", status: "Open" }),
        });
        return;
      }
      send({ jsonrpc: "2.0", id: msg.id, result: structured({ status: "ok" }) });
      return;
    }

    if (mode === "crossmatrix") {
      if (name === "crossmatrix.command") {
        const req = args?.request ?? {};
        if (writeLog) {
          try {
            fs.appendFileSync(writeLog, JSON.stringify(req) + "\n");
          } catch {
            /* ignore */
          }
          if (errorOn && (req?.requestId === errorOn || req?.op?.kind === errorOn)) {
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: structured({ ok: false, error: { code: "no_model", message: "no model loaded" } }, true),
            });
            return;
          }
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: structured({
              ok: true,
              op: req?.op?.kind ?? "unknown",
              validated: true,
              links: ["query"],
            }),
          });
          return;
        }
        if (req.model !== undefined) {
          model = req.model;
          if (modelFile) {
            try {
              fs.writeFileSync(modelFile, JSON.stringify(model));
            } catch {
              /* ignore */
            }
          }
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: structured({
              ok: true,
              op: "model.open",
              validated: true,
              links: ["query"],
            }),
          });
        } else {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: structured({
              ok: true,
              op: req?.op?.kind ?? "unknown",
              note: "op not supported in this build (mutation ops deferred — see ADR-0004; needs a core write-API)",
              links: ["query"],
            }),
          });
        }
        return;
      }
      if (name === "crossmatrix.query") {
        const kind = args?.request?.query?.kind ?? "";
        if (queryResponses && Object.prototype.hasOwnProperty.call(queryResponses, kind)) {
          let value = queryResponses[kind];
          if (Array.isArray(value)) {
            const rawCursor = args?.request?.query?.cursor;
            const index =
              rawCursor === undefined || rawCursor === null || rawCursor === ""
                ? 0
                : Number(rawCursor);
            value = Number.isInteger(index) && index >= 0 && index < value.length ? value[index] : null;
          }
          send({ jsonrpc: "2.0", id: msg.id, result: structured(value) });
          return;
        }
        if (kind === "validate") {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: structured({
              validated: model !== null,
              links: ["analyze.contract", "describe"],
            }),
          });
          return;
        }
        if (kind === "analyze.marginalize") {
          if (model === null) {
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: structured("no model loaded", true),
            });
            return;
          }
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: structured({
              findings: [{ member: "m1", value: 81 }],
              links: ["analyze.contract"],
            }),
          });
          return;
        }
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: structured({
            ok: true,
            query: kind,
            note: "query not supported in this build (conflicts needs valence/tension analysis — ADR-0002; export deferred)",
            links: ["describe", "validate"],
          }),
        });
        return;
      }
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: structured(`unknown tool: ${name}`, true),
      });
      return;
    }

    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: structured({ ok: true, echo: args }),
    });
    return;
  }

  // Unknown methods: answer with a JSON-RPC method-not-found.
  if (msg.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `method not found: ${msg.method}` },
    });
  }
}
