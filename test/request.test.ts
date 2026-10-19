import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayConfig } from "../src/config";
import { estimateRequestTokens, resolveModel, translateRequest } from "../src/translate/request";
import type { AnthropicRequest } from "../src/types";

const config: GatewayConfig = {
  host: "127.0.0.1",
  port: 8787,
  localToken: "test-token",
  upstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
  originator: "codex_cli_rs",
  userAgent: "test",
  models: {
    opus: "gpt-6.1-sol",
    sonnet: "gpt-6.1-sol",
    haiku: "gpt-6-luna",
    fable: "gpt-6-astra",
  },
  defaultModel: "gpt-6.1-sol",
  maxOutputTokens: 128000,
  contextWindow: 272000,
  textVerbosity: "low",
  reasoningEffort: null,
};

test("maps Claude tiers to configured GPT models", () => {
  assert.equal(resolveModel("claude-opus-4-1", config), "gpt-6.1-sol");
  assert.equal(resolveModel("claude-sonnet-4-5", config), "gpt-6.1-sol");
  assert.equal(resolveModel("claude-3-5-haiku-20241022", config), "gpt-6-luna");
  assert.equal(resolveModel("claude-fable-5", config), "gpt-6-astra");
  assert.equal(resolveModel("gpt-6.1-sol", config), "gpt-6.1-sol");
});

test("translates a plain conversation", () => {
  const request: AnthropicRequest = {
    model: "claude-sonnet-4-5",
    max_tokens: 1000,
    system: [{ type: "text", text: "Be terse." }],
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "How are you?" },
    ],
  };
  const { request: body } = translateRequest(request, config);
  assert.equal(body.model, "gpt-6.1-sol");
  assert.equal(body.instructions, "Be terse.");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 1000);
  assert.deepEqual(body.input, [
    { role: "user", content: [{ type: "input_text", text: "Hello" }] },
    { role: "assistant", content: [{ type: "output_text", text: "Hi" }] },
    { role: "user", content: [{ type: "input_text", text: "How are you?" }] },
  ]);
});

test("translates tool definitions, tool_use and tool_result", () => {
  const request: AnthropicRequest = {
    model: "claude-sonnet-4-5",
    max_tokens: 500,
    tools: [
      {
        name: "get_weather",
        description: "Weather lookup",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
    ],
    tool_choice: { type: "any", disable_parallel_tool_use: true },
    messages: [
      { role: "user", content: "Weather in Paris?" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "18C" }],
      },
    ],
  };
  const { request: body } = translateRequest(request, config);
  assert.deepEqual(body.tools, [
    {
      type: "function",
      name: "get_weather",
      description: "Weather lookup",
      parameters: { type: "object", properties: { city: { type: "string" } } },
      strict: false,
    },
  ]);
  assert.equal(body.tool_choice, "required");
  assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(body.input, [
    { role: "user", content: [{ type: "input_text", text: "Weather in Paris?" }] },
    { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' },
    { type: "function_call_output", call_id: "call_1", output: "18C" },
  ]);
});

test("forwards Claude Code /effort via output_config", () => {
  const high = translateRequest(
    {
      model: "claude-opus-4-1",
      max_tokens: 1000,
      output_config: { effort: "high" },
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: "hi" }],
    },
    config,
  ).request;
  assert.deepEqual(high.reasoning, { effort: "high", summary: "auto" });

  const max = translateRequest(
    {
      model: "claude-opus-4-1",
      max_tokens: 1000,
      output_config: { effort: "max" },
      messages: [{ role: "user", content: "hi" }],
    },
    config,
  ).request;
  assert.deepEqual(max.reasoning, { effort: "xhigh", summary: "auto" });
});

test("maps thinking to reasoning effort and drops temperature", () => {
  const { request: body } = translateRequest(
    {
      model: "claude-opus-4-1",
      max_tokens: 32000,
      temperature: 0.7,
      thinking: { type: "enabled", budget_tokens: 24000 },
      messages: [{ role: "user", content: "Think hard" }],
    },
    config,
  );
  assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
  assert.equal(body.temperature, undefined);
});

test("converts images to data URLs and clamps max tokens", () => {
  const request: AnthropicRequest = {
    model: "claude-haiku-4-5",
    max_tokens: 999999,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ],
  };
  const { request: body } = translateRequest(request, config);
  assert.equal(body.max_output_tokens, config.maxOutputTokens);
  assert.deepEqual(body.input, [
    {
      role: "user",
      content: [
        { type: "input_text", text: "What is this?" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ],
    },
  ]);
});

test("estimates token counts for messages and tools", () => {
  const count = estimateRequestTokens({
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hello world" }],
    tools: [{ name: "x", input_schema: { type: "object" } }],
  });
  assert.ok(count > 0);
});