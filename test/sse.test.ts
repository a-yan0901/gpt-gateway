import assert from "node:assert/strict";
import test from "node:test";
import { parseSseJson, parseSseStream } from "../src/upstream/sse";

function streamChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const events = [];
  for await (const event of parseSseStream(stream)) events.push(event);
  return events;
}

test("parses events split across chunks, including CRLF boundaries", async () => {
  const events = await collect(
    streamChunks([
      'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",',
      '"delta":"Hel"}\r\n\r',
      '\nevent: response.completed\r\ndata: {"type":"response.completed"}\r\n\r\n',
    ]),
  );
  assert.equal(events.length, 2);
  assert.equal(events[0]?.event, "response.output_text.delta");
  assert.deepEqual(parseSseJson(events[0]!), {
    type: "response.output_text.delta",
    delta: "Hel",
  });
  assert.equal(events[1]?.event, "response.completed");
});

test("joins multi-line data, skips comments, and handles a lone CR", async () => {
  const events = await collect(
    streamChunks([": keep-alive\rdata: one\ndata: two\r\rdata: [DONE]\n\n"]),
  );
  assert.equal(events.length, 2);
  assert.equal(events[0]?.data, "one\ntwo");
  assert.equal(events[1]?.data, "[DONE]");
  assert.equal(parseSseJson(events[1]!), null);
});

test("survives UTF-8 characters split between chunks", async () => {
  const encoder = new TextEncoder();
  const payload = encoder.encode('data: {"text":"你好"}\n\n');
  // Split in the middle of the three-byte characters.
  const first = payload.slice(0, 12);
  const second = payload.slice(12);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
      controller.enqueue(second);
      controller.close();
    },
  });
  const events = await collect(stream);
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0]!.data), { text: "你好" });
});

test("flushes an event that ends without a blank line", async () => {
  const events = await collect(streamChunks(['data: {"ok":true}']));
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0]!.data), { ok: true });
});