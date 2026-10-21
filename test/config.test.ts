import assert from "node:assert/strict";
import test from "node:test";
import { buildClaudeSettings, type GatewayConfig } from "../src/config";

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

test("generated settings map tiers without pinning the session model", () => {
  const settings = buildClaudeSettings(config, 1234);
  const env = settings.env as Record<string, string>;

  // An empty value cancels an inherited pin while leaving /model in charge.
  assert.equal(env.ANTHROPIC_MODEL, "");
  assert.equal(settings.model, undefined);

  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "gpt-6.1-sol");
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "gpt-6.1-sol");
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "gpt-6-luna");
  assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, "gpt-6-astra");
  assert.equal(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "inherit");
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, undefined);
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, "gpt-6-luna");
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:1234");
});