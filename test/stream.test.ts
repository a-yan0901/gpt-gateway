import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicStreamTranslator } from "../src/translate/stream";

interface Captured {
  event: string;
  data: Record<string, any>;
}

function makeTranslator(): { translator: AnthropicStreamTranslator; events: Captured[] } {
  const events: Captured[] = [];
  const translator = new AnthropicStreamTranslator((event, data) => events.push({ event, data }), {
    model: "gpt-6-sol",
    estimatedInputTokens: 42,
  });
  return { translator, events };
}

test("emits a text message and final usage", () => {
  const { translator, events } = makeTranslator();
  translator.handle("response.created", { type: "response.created", response: { model: "gpt-6-sol" } });
  translator.handle("response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", id: "msg_item_1", role: "assistant" },
  });
  translator.handle("response.content_part.added", {
    type: "response.content_part.added",
    item_id: "msg_item_1",
    part: { type: "output_text", text: "" },
  });
  translator.handle("response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: "msg_item_1",
    delta: "Hel",
  });
  translator.handle("response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: "msg_item_1",
    delta: "lo",
  });
  translator.handle("response.output_text.done", {
    type: "response.output_text.done",
    item_id: "msg_item_1",
    text: "Hello",
  });
  translator.handle("response.output_item.done", {
    type: "response.output_item.done",
    item: { type: "message", id: "msg_item_1" },
  });
  translator.handle("response.completed", {
    type: "response.completed",
    response: {
      status: "completed",
      usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 20 } },
    },
  });

  const names = events.map((e) => e.event);
  assert.deepEqual(names, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.equal(events[0]?.data.message.usage.input_tokens, 42);
  const delta = events.find((e) => e.event === "message_delta");
  assert.equal(delta?.data.delta.stop_reason, "end_turn");
  assert.equal(delta?.data.usage.input_tokens, 80);
  assert.equal(delta?.data.usage.cache_read_input_tokens, 20);
  assert.equal(delta?.data.usage.output_tokens, 5);
  assert.equal(translator.isFinished, true);
});

test("emits tool_use blocks and stop reason tool_use", () => {
  const { translator, events } = makeTranslator();
  translator.handle("response.output_item.added", {
    type: "response.output_item.added",
    item: { type: "function_call", id: "fc_1", call_id: "call_abc", name: "get_weather" },
  });
  translator.handle("response.function_call_arguments.delta", {
    type: "response.function_call_arguments.delta",
    item_id: "fc_1",
    delta: '{"city":',
  });
  translator.handle("response.function_call_arguments.delta", {
    type: "response.function_call_arguments.delta",
    item_id: "fc_1",
    delta: '"Paris"}',
  });
  translator.handle("response.function_call_arguments.done", {
    type: "response.function_call_arguments.done",
    item_id: "fc_1",
    arguments: '{"city":"Paris"}',
  });
  translator.handle("response.output_item.done", {
    type: "response.output_item.done",
    item: { type: "function_call", id: "fc_1", call_id: "call_abc", name: "get_weather" },
  });
  translator.handle("response.completed", { type: "response.completed", response: { status: "completed" } });

  const start = events.find((e) => e.event === "content_block_start");
  assert.equal(start?.data.content_block.type, "tool_use");
  assert.equal(start?.data.content_block.id, "call_abc");
  assert.equal(start?.data.content_block.name, "get_weather");
  const jsonDeltas = events
    .filter((e) => e.event === "content_block_delta")
    .map((e) => e.data.delta.partial_json)
    .join("");
  assert.equal(jsonDeltas, '{"city":"Paris"}');
  const delta = events.find((e) => e.event === "message_delta");
  assert.equal(delta?.data.delta.stop_reason, "tool_use");
});

test("uses the final arguments when no deltas were streamed", () => {
  const { translator, events } = makeTranslator();
  translator.handle("response.output_item.added", {
    type: "response.output_item.added",
    item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "lookup" },
  });
  translator.handle("response.output_item.done", {
    type: "response.output_item.done",
    item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "lookup", arguments: '{"q":"x"}' },
  });
  translator.finish();
  const json = events
    .filter((e) => e.event === "content_block_delta")
    .map((e) => e.data.delta.partial_json)
    .join("");
  assert.equal(json, '{"q":"x"}');
});

test("reports upstream errors", () => {
  const { translator, events } = makeTranslator();
  translator.handle("response.failed", {
    type: "response.failed",
    response: { error: { message: "quota exceeded" } },
  });
  const error = events.find((e) => e.event === "error");
  assert.equal(error?.data.error.message, "quota exceeded");
  assert.equal(translator.isFinished, true);
});

test("finishing with no output still emits a complete envelope", () => {
  const { translator, events } = makeTranslator();
  translator.finish();
  assert.deepEqual(
    events.map((e) => e.event),
    ["message_start", "message_delta", "message_stop"],
  );
});