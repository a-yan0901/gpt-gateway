// Minimal Anthropic Messages API + OpenAI Responses API types used by the gateway.
// We intentionally keep these loose: both APIs evolve and Claude Code sends fields
// that are not relevant to the translation.

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: unknown;
}

export interface AnthropicImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
  cache_control?: unknown;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | { type: string; [key: string]: unknown };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  type?: string;
  [key: string]: unknown;
}

export interface AnthropicRequest {
  model: string;
  max_tokens?: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicTextBlock[];
  tools?: AnthropicTool[];
  tool_choice?: {
    type: "auto" | "any" | "tool" | "none";
    name?: string;
    disable_parallel_tool_use?: boolean;
  };
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  thinking?: {
    type: "enabled" | "disabled" | "adaptive";
    budget_tokens?: number;
    display?: string;
  };
  output_config?: {
    effort?: "low" | "medium" | "high" | "xhigh" | "max" | "auto";
    [key: string]: unknown;
  };
  metadata?: { user_id?: string; [key: string]: unknown };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Responses API
// ---------------------------------------------------------------------------

export type ResponsesInputItem = Record<string, unknown>;

export interface ResponsesRequest {
  model: string;
  store: false;
  stream: true;
  instructions: string;
  input: ResponsesInputItem[];
  text: { verbosity: "low" | "medium" | "high" };
  include: string[];
  prompt_cache_key?: string;
  tool_choice: unknown;
  parallel_tool_calls: boolean;
  tools?: unknown[];
  reasoning?: { effort: string; summary?: string };
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  [key: string]: unknown;
}

export interface AnthUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string; signature?: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
  stop_reason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence";
  stop_sequence: string | null;
  usage: AnthUsage;
}

export interface TokenBundle {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  account_id?: string;
  plan_type?: string;
  email?: string;
  expires_at: number;
  last_refresh?: string;
  originator?: string;
  /** Imported from ~/.codex/auth.json: never refresh it, to avoid rotating Codex's token. */
  imported?: boolean;
  source?: string;
}