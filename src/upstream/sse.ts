/**
 * A small, dependency-free Server-Sent Events parser.
 *
 * Handles chunk boundaries, CRLF/CR/LF line endings, multi-line `data:` fields,
 * comments, and UTF-8 sequences split across chunks.
 */

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

function takeLine(buffer: string): { line: string; rest: string } | null {
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer.charCodeAt(i);
    if (ch === 10) {
      return { line: buffer.slice(0, i), rest: buffer.slice(i + 1) };
    }
    if (ch === 13) {
      if (i + 1 >= buffer.length) return null; // may be the first half of CRLF
      const skip = buffer.charCodeAt(i + 1) === 10 ? 2 : 1;
      return { line: buffer.slice(0, i), rest: buffer.slice(i + skip) };
    }
  }
  return null;
}

export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let eventId: string | undefined;
  let retry: number | undefined;
  let dataLines: string[] = [];

  const dispatch = (): SseEvent | null => {
    if (dataLines.length === 0) {
      eventName = undefined;
      eventId = undefined;
      retry = undefined;
      return null;
    }
    const event: SseEvent = { data: dataLines.join("\n") };
    if (eventName !== undefined) event.event = eventName;
    if (eventId !== undefined) event.id = eventId;
    if (retry !== undefined) event.retry = retry;
    eventName = undefined;
    eventId = undefined;
    retry = undefined;
    dataLines = [];
    return event;
  };

  const consumeLine = (line: string): SseEvent | null => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        eventName = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        if (!value.includes("\0")) eventId = value;
        break;
      case "retry": {
        const num = Number(value);
        if (Number.isFinite(num)) retry = num;
        break;
      }
      default:
        break;
    }
    return null;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let line: ReturnType<typeof takeLine>;
      while ((line = takeLine(buffer))) {
        buffer = line.rest;
        const event = consumeLine(line.line);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    // Flush any lines that arrived without a trailing newline.
    let tail: ReturnType<typeof takeLine>;
    while ((tail = takeLine(buffer))) {
      buffer = tail.rest;
      const event = consumeLine(tail.line);
      if (event) yield event;
    }
    if (buffer.length > 0) {
      const event = consumeLine(buffer.replace(/\r$/, ""));
      if (event) yield event;
    }
    const last = dispatch();
    if (last) yield last;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed or aborted */
    }
    reader.releaseLock();
  }
}

/** Parse a Responses SSE event's JSON payload. Returns null for non-JSON frames. */
export function parseSseJson(event: SseEvent): Record<string, unknown> | null {
  if (event.data === "[DONE]") return null;
  try {
    const parsed = JSON.parse(event.data);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}