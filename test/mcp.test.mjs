/**
 * Protocol tests for the MCP server.
 *
 * These drive the real binary over a pipe, the way a client does, rather than calling the
 * handler directly — the failures worth catching here are framing failures (a message split
 * across chunks, something written to stdout that is not protocol), and those only exist at
 * the process boundary.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../dist/esm/bin.js", import.meta.url));

/** Start the server, send each message, and collect the responses. */
function exchange(messages, { apiKey = "stt_" + "0".repeat(64) } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, "mcp"], {
      env: { ...process.env, SPEECHREVOLUTIONS_API_KEY: apiKey },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    const responses = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
      let i;
      while ((i = out.indexOf("\n")) !== -1) {
        const line = out.slice(0, i).trim();
        out = out.slice(i + 1);
        if (line) responses.push(JSON.parse(line));
      }
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ responses, stderr: err, code }));

    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
    child.stdin.end();
  });
}

test("initialize returns the protocol version and server info", async () => {
  const { responses } = await exchange([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
  ]);
  assert.equal(responses.length, 1);
  const { result } = responses[0];
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.equal(result.serverInfo.name, "speechrevolutions");
  assert.ok(result.capabilities.tools, "tools capability must be advertised");
});

test("tools/list names every tool with a schema", async () => {
  const { responses } = await exchange([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  const tools = responses.find((r) => r.id === 2).result.tools;
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "check_job",
    "get_transcript",
    "list_jobs",
    "submit_transcription_job",
    "transcribe_audio",
  ]);
  for (const tool of tools) {
    assert.ok(tool.description.length > 40, `${tool.name} needs a usable description`);
    assert.equal(tool.inputSchema.type, "object");
  }
});

test("a notification is never answered", async () => {
  // `notifications/initialized` has no id. Replying to it is a protocol violation that some
  // clients treat as fatal.
  const { responses } = await exchange([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "ping" },
  ]);
  assert.deepEqual(
    responses.map((r) => r.id),
    [1, 2],
  );
});

test("an unknown tool is a protocol error, a failing tool is not", async () => {
  const { responses } = await exchange([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nope", arguments: {} } },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "transcribe_audio", arguments: { audio: "/nonexistent/file.mp3" } },
    },
  ]);

  const unknown = responses.find((r) => r.id === 2);
  assert.ok(unknown.error, "an unknown tool name is a JSON-RPC error");

  // A missing file is information for the model, so it comes back as a result with isError,
  // which keeps the conversation alive instead of failing the request.
  const failed = responses.find((r) => r.id === 3);
  assert.ok(!failed.error, "a tool failure must not be a protocol error");
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /No such file/);
});

test("a message split across writes is still parsed", async () => {
  const message = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`;
  const half = Math.floor(message.length / 2);

  const child = spawn(process.execPath, [BIN, "mcp"], {
    env: { ...process.env, SPEECHREVOLUTIONS_API_KEY: "stt_" + "0".repeat(64) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const seen = await new Promise((resolve) => {
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      out += c;
      if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]));
    });
    child.stdin.write(message.slice(0, half));
    setTimeout(() => child.stdin.write(message.slice(half)), 50);
  });
  child.kill();
  assert.equal(seen.id, 1);
});

test("a missing API key fails at startup rather than on every call", async () => {
  const child = spawn(process.execPath, [BIN, "mcp"], {
    env: { ...process.env, SPEECHREVOLUTIONS_API_KEY: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const { code, stderr } = await new Promise((resolve) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.end();
  });
  assert.equal(code, 1);
  assert.match(stderr, /SPEECHREVOLUTIONS_API_KEY/);
});

test("nothing but protocol is ever written to stdout", async () => {
  const { responses, stderr } = await exchange([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  ]);
  // Every stdout line parsed as JSON above, which is the assertion. The readiness banner
  // must be on stderr, where it cannot corrupt the stream.
  assert.equal(responses.length, 1);
  assert.match(stderr, /speechrevolutions-mcp .* ready/);
});
