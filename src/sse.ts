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
  let dataLines: string[] = [];

  const flush = (): SSEEvent | undefined => {
    if (!dataLines.length) return undefined;
    const event = { ...current, data: dataLines.join("\n") };
    dataLines = [];
    return event;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      if (rawLine === "") {
        const event = flush();
        if (event) yield event;
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
      else if (field === "data") dataLines.push(valueStr);
    }
  }

  const event = flush();
  if (event) yield event;
}
