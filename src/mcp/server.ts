/**
 * The stdio MCP server entry point.
 *
 * Run as `npx speechrevolutions mcp`, or wired into a client's config. The client owns the
 * process: it spawns this, talks JSON-RPC over the pipe, and kills it on exit.
 *
 * The one rule that matters: stdout carries the protocol and nothing else. A single stray
 * write corrupts the stream and the client drops the connection with a parse error that
 * names neither the cause nor the line. Everything human-readable goes to stderr.
 */

import { SpeechRevolutionsClient } from "../client.js";
import { VERSION } from "../version.js";
import { McpServer, readJsonLines, PARSE_ERROR } from "./protocol.js";
import { buildTools } from "./tools.js";

export interface McpServerOptions {
  apiKey?: string;
  baseUrl?: string;
}

export async function runMcpServer(options: McpServerOptions = {}): Promise<void> {
  const apiKey = options.apiKey ?? process.env.SPEECHREVOLUTIONS_API_KEY;
  if (!apiKey) {
    // Fail here rather than on the first tool call. A server that starts, lists five tools
    // and then errors on every one of them looks like a broken API; this looks like what it
    // is, and the client surfaces stderr.
    process.stderr.write(
      "speechrevolutions-mcp: SPEECHREVOLUTIONS_API_KEY is not set.\n" +
        "Create a key at https://console.speechrevolutions.com and set it in the env block of\n" +
        "your MCP client configuration.\n",
    );
    process.exitCode = 1;
    return;
  }

  const client = new SpeechRevolutionsClient({ apiKey, baseUrl: options.baseUrl });
  const server = new McpServer("speechrevolutions", VERSION);
  for (const tool of buildTools(client)) server.tool(tool);

  const write = (message: unknown) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  process.stderr.write(`speechrevolutions-mcp ${VERSION} ready\n`);

  await readJsonLines(process.stdin, async (message, raw) => {
    if (message === undefined) {
      // Unparseable input. Per JSON-RPC the id is unknown, so it is null.
      process.stderr.write(`speechrevolutions-mcp: could not parse: ${raw.slice(0, 200)}\n`);
      write({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } });
      return;
    }
    const response = await server.handle(message as Parameters<typeof server.handle>[0]);
    if (response) write(response);
  });
}
