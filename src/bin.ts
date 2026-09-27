#!/usr/bin/env node
/**
 * The `speechrevolutions` command.
 *
 * One subcommand today: `mcp`, which starts the stdio MCP server so an assistant can call
 * the transcription API directly. It is a subcommand rather than the whole binary so that a
 * real CLI (`transcribe`, `jobs`) can be added later without breaking anyone's config.
 */

import { runMcpServer } from "./mcp/server.js";
import { VERSION } from "./version.js";

const USAGE = `speechrevolutions ${VERSION}

Usage:
  speechrevolutions mcp        Start the MCP server on stdio
  speechrevolutions --version  Print the version

The MCP server reads SPEECHREVOLUTIONS_API_KEY from the environment. Add it to an MCP
client like this:

  {
    "mcpServers": {
      "speechrevolutions": {
        "command": "npx",
        "args": ["-y", "speechrevolutions", "mcp"],
        "env": { "SPEECHREVOLUTIONS_API_KEY": "stt_..." }
      }
    }
  }
`;

async function main(argv: string[]): Promise<void> {
  const [command] = argv;

  switch (command) {
    case "mcp":
      await runMcpServer();
      return;
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return;
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
