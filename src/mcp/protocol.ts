/**
 * The slice of MCP this server needs, implemented directly.
 *
 * WHY NOT `@modelcontextprotocol/sdk`: this package has no dependencies, and that is a
 * property worth keeping — it is an SDK, so anything it installs, every consumer installs.
 * A stdio MCP server that only exposes tools needs three request handlers and a framing
 * loop over newline-delimited JSON-RPC 2.0. That is smaller than the dependency, and it
 * cannot break when the dependency's major version moves.
 *
 * Transport: one JSON-RPC message per line on stdin, one per line on stdout. Nothing else
 * may ever be written to stdout — a stray `console.log` corrupts the stream and the client
 * disconnects with a parse error. Diagnostics go to stderr, which the host shows in its logs.
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC error codes. The -32602/-32601 values are from the base spec. */
export const INVALID_PARAMS = -32602;
export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;
export const PARSE_ERROR = -32700;

export interface ToolDefinition {
  name: string;
  /**
   * Written for a model deciding whether to call this, not for a human reading a reference.
   * State what it does, what it costs, and when to reach for a different tool.
   */
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  /** Set when the tool failed in a way the model should see and can act on. */
  isError?: boolean;
}

/** The protocol revision this server implements. */
export const PROTOCOL_VERSION = "2025-06-18";

export class McpServer {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(
    private readonly name: string,
    private readonly version: string,
  ) {}

  tool(definition: ToolDefinition): this {
    this.tools.set(definition.name, definition);
    return this;
  }

  /**
   * Handle one parsed request. Returns the response to write, or null for a notification
   * (a message with no `id`), which the spec says must never be answered.
   */
  async handle(request: JsonRpcRequest): Promise<Record<string, unknown> | null> {
    const { id, method, params = {} } = request;
    const isNotification = id === undefined;

    try {
      switch (method) {
        case "initialize":
          return isNotification ? null : this.ok(id, this.initializeResult(params));

        // The client tells us it is ready. No reply is expected or permitted.
        case "notifications/initialized":
          return null;

        case "ping":
          return isNotification ? null : this.ok(id, {});

        case "tools/list":
          return isNotification
            ? null
            : this.ok(id, {
                tools: [...this.tools.values()].map(({ name, description, inputSchema }) => ({
                  name,
                  description,
                  inputSchema,
                })),
              });

        case "tools/call": {
          if (isNotification) return null;
          const toolName = String(params.name ?? "");
          const tool = this.tools.get(toolName);
          if (!tool) {
            return this.fail(id, INVALID_PARAMS, `Unknown tool: ${toolName}`);
          }
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          /*
           * A tool that throws is NOT a protocol error. The spec draws this line on purpose:
           * a protocol error means the client is broken, while "that job id does not exist"
           * is information the model should receive and can act on. So failures come back as
           * an ordinary result with isError set, and the conversation continues.
           */
          try {
            return this.ok(id, await tool.handler(args));
          } catch (error) {
            return this.ok(id, {
              content: [{ type: "text", text: describeError(error) }],
              isError: true,
            });
          }
        }

        default:
          if (isNotification) return null;
          return this.fail(id, METHOD_NOT_FOUND, `Unknown method: ${method}`);
      }
    } catch (error) {
      if (isNotification) return null;
      return this.fail(id ?? null, INTERNAL_ERROR, describeError(error));
    }
  }

  private initializeResult(params: Record<string, unknown>) {
    // Echo the client's protocol version when we can speak it, which is what the spec asks
    // for; otherwise state ours and let the client decide whether to continue.
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : null;
    return {
      protocolVersion: requested ?? PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.name, version: this.version },
    };
  }

  private ok(id: JsonRpcId | undefined, result: unknown) {
    return { jsonrpc: "2.0" as const, id: id ?? null, result };
  }

  private fail(id: JsonRpcId | undefined, code: number, message: string) {
    return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    // SDK errors carry a status code and a request id; both are what a user needs when
    // asking us what went wrong, so neither should be swallowed.
    const extra = [
      "statusCode" in error ? `status=${(error as { statusCode?: unknown }).statusCode}` : null,
      "requestId" in error ? `requestId=${(error as { requestId?: unknown }).requestId}` : null,
    ].filter(Boolean);
    return extra.length ? `${error.message} (${extra.join(", ")})` : error.message;
  }
  return String(error);
}

/**
 * Read newline-delimited JSON from a stream and call `onMessage` for each message.
 *
 * Chunk boundaries are not line boundaries, so the tail of a chunk is held until the
 * newline that completes it arrives. Getting this wrong produces a server that works on
 * small messages and fails on large ones, which is the worst failure mode to debug.
 */
export async function readJsonLines(
  stream: AsyncIterable<Buffer | string>,
  onMessage: (message: unknown, raw: string) => Promise<void> | void,
): Promise<void> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        await onMessage(undefined, line);
        continue;
      }
      await onMessage(parsed, line);
    }
  }
}
