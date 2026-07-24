/** Minimal SSE line parser for fetch ReadableStreams. */

export interface SSEEvent {
  id?: string;
  event?: string;
  data?: string;
}

export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let current: SSEEvent = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      if (rawLine === "") {
        if (current.data !== undefined) {
          yield current;
        }
        current = {};
        continue;
      }

      if (rawLine.startsWith(":")) continue;

      const colon = rawLine.indexOf(":");
      let field: string;
      let valueStr: string;
      if (colon === -1) {
        field = rawLine;
        valueStr = "";
      } else {
        field = rawLine.slice(0, colon);
        valueStr = rawLine.slice(colon + 1).replace(/^ /, "");
      }

      if (field === "id") current.id = valueStr;
      else if (field === "event") current.event = valueStr;
      else if (field === "data") current.data = valueStr;
    }
  }

  if (current.data !== undefined) {
    yield current;
  }
}
