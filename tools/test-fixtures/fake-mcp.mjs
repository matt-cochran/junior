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
//
// The crossmatrix mode intentionally starts with NO model in memory: a fresh
// process only answers `validate: true` if the caller replayed the import
// first. That is how the wrapper's replay-on-fresh-server behaviour is tested.

import fs from "node:fs";
import process from "node:process";

const mode = process.env.FAKE_MCP_MODE || "echo";
const modelFile = process.env.FAKE_MCP_MODEL_FILE;

let model = null;
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

    if (mode === "crossmatrix") {
      if (name === "crossmatrix.command") {
        const req = args?.request ?? {};
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
