import type { GatewayConfig } from "../config";
import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicTool,
  ResponsesInputItem,
  ResponsesRequest,
} from "../types";
import { estimateTokens, sha256Base64Url } from "../util";

export interface TranslationResult {
  request: ResponsesRequest;
  sessionId?: string;
  warnings: string[];
}

const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function systemText(system: AnthropicRequest["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n");
}

function imageUrl(block: AnthropicImageBlock): string | null {
  const source = block.source;
  if (!source) return null;
  if (source.type === "base64" && source.data) {
    const mediaType = source.media_type || "image/png";
    return `data:${mediaType};base64,${source.data}`;
  }
  if (source.type === "url" && source.url) return source.url;
  return null;
}

function toolResultOutput(block: AnthropicContentBlock): string | Array<Record<string, unknown>> {
  const content = (block as { content?: unknown }).content;
  const isError = (block as { is_error?: boolean }).is_error === true;
  let parts: Array<Record<string, unknown>>;
  if (typeof content === "string") {
    parts = [{ type: "input_text", text: isError ? `[tool error]\n${content}` : content }];
  } else if (Array.isArray(content)) {
    parts = [];
    for (const item of content as AnthropicContentBlock[]) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "text" && typeof (item as { text?: unknown }).text === "string") {
        parts.push({ type: "input_text", text: (item as { text: string }).text });
      } else if (item.type === "image") {
        const url = imageUrl(item as AnthropicImageBlock);
        if (url) parts.push({ type: "input_image", image_url: url });
      }
    }
    if (isError && parts.length > 0 && parts[0]?.type === "input_text") {
      parts[0].text = `[tool error]\n${String(parts[0].text ?? "")}`;
    }
  } else {
    parts = [{ type: "input_text", text: isError ? "[tool error]" : "" }];
  }
  // A plain string is friendlier to the model and smaller on the wire.
  if (parts.length === 1 && parts[0]?.type === "input_text") {
    return String(parts[0].text ?? "");
  }
  return parts;
}

function assistantContent(blocks: AnthropicContentBlock[]): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
      const text = (block as { text: string }).text;
      if (text.length > 0) parts.push({ type: "output_text", text });
    }
    // thinking / redacted_thinking are dropped: Responses reasoning items need
    // encrypted_content that only the upstream can produce. Replaying a summary
    // as an authoritative reasoning item is worse than omitting it.
  }
  return parts;
}

function userContent(
  blocks: AnthropicContentBlock[],
  input: ResponsesInputItem[],
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text": {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string" && text.length > 0) parts.push({ type: "input_text", text });
        break;
      }
      case "image": {
        const url = imageUrl(block as AnthropicImageBlock);
        if (url) parts.push({ type: "input_image", image_url: url });
        break;
      }
      case "tool_result": {
        const callId = (block as { tool_use_id?: unknown }).tool_use_id;
        if (typeof callId === "string" && callId.length > 0) {
          input.push({
            type: "function_call_output",
            call_id: callId,
            output: toolResultOutput(block),
          });
        }
        break;
      }
      case "document": {
        // Documents without a text extraction cannot be represented by the
        // Responses input types we target. Keep any inline text if present.
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") parts.push({ type: "input_text", text });
        break;
      }
      default:
        break;
    }
  }
  return parts;
}

function convertMessages(messages: AnthropicMessage[]): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "assistant") {
      const blocks: AnthropicContentBlock[] =
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : Array.isArray(message.content)
            ? message.content
            : [];
      const content = assistantContent(blocks);
      if (content.length > 0) input.push({ role: "assistant", content });
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_use") {
          const id = (block as { id?: unknown }).id;
          const name = (block as { name?: unknown }).name;
          if (typeof id !== "string" || typeof name !== "string") continue;
          input.push({
            type: "function_call",
            call_id: id,
            name,
            arguments: JSON.stringify((block as { input?: unknown }).input ?? {}),
          });
        }
      }
      continue;
    }

    const blocks: AnthropicContentBlock[] =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : [];
    // Tool results become top-level function_call_output items; they must come
    // before any accompanying user text to preserve the reply ordering.
    const content = userContent(blocks, input);
    if (content.length > 0) input.push({ role: "user", content });
  }
  return input;
}

function convertTools(tools: AnthropicTool[] | undefined, warnings: string[]): unknown[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const converted: unknown[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const name = typeof tool.name === "string" ? tool.name : "";
    if (!name) continue;
    if (!TOOL_NAME_RE.test(name)) {
      warnings.push(`Skipping tool with unsupported name: ${name}`);
      continue;
    }
    // Anthropic server-side tools (e.g. web_search_20250305) have no function schema.
    const schema = tool.input_schema;
    if (!schema || typeof schema !== "object") {
      warnings.push(`Skipping tool without input_schema: ${name}`);
      continue;
    }
    converted.push({
      type: "function",
      name,
      description: typeof tool.description === "string" ? tool.description : "",
      parameters: schema,
      strict: false,
    });
  }
  return converted.length > 0 ? converted : undefined;
}

function convertToolChoice(
  choice: AnthropicRequest["tool_choice"],
): { toolChoice: unknown; parallel: boolean } {
  if (!choice) return { toolChoice: "auto", parallel: true };
  const parallel = choice.disable_parallel_tool_use !== true;
  switch (choice.type) {
    case "any":
      return { toolChoice: "required", parallel };
    case "none":
      return { toolChoice: "none", parallel };
    case "tool":
      return {
        toolChoice: choice.name ? { type: "function", name: choice.name } : "required",
        parallel,
      };
    case "auto":
    default:
      return { toolChoice: "auto", parallel };
  }
}

function mapReasoning(
  request: AnthropicRequest,
  config: GatewayConfig,
): { effort: string; summary: string } | undefined {
  // Claude Code's /effort and --effort send the explicit per-turn level here.
  // The Codex backend accepts low/medium/high/xhigh/max for all configured
  // GPT models, so pass the level through unchanged.
  const level = request.output_config?.effort;
  if (level && level !== "auto") {
    if (level === "low" || level === "medium" || level === "high" || level === "xhigh" || level === "max") {
      return { effort: level, summary: "auto" };
    }
  }
  if (request.thinking?.type === "enabled") {
    const budget = request.thinking.budget_tokens ?? 0;
    const effort = budget >= 20_000 ? "high" : budget >= 6_000 ? "medium" : "low";
    return { effort, summary: "auto" };
  }
  if (config.reasoningEffort) return { effort: config.reasoningEffort, summary: "auto" };
  return undefined;
}

/** Map an Anthropic model alias to the configured GPT model. */
export function resolveModel(model: string, config: GatewayConfig): string {
  const value = (model || "").trim();
  if (!value) return config.defaultModel;
  if (/claude|opus|sonnet|haiku|fable/i.test(value)) {
    if (/opus/i.test(value)) return config.models.opus;
    if (/sonnet/i.test(value)) return config.models.sonnet;
    if (/haiku/i.test(value)) return config.models.haiku;
    if (/fable/i.test(value)) return config.models.fable;
    return config.defaultModel;
  }
  return value;
}

function isSessionId(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

export function translateRequest(request: AnthropicRequest, config: GatewayConfig): TranslationResult {
  const warnings: string[] = [];
  const instructions = systemText(request.system);
  const input = convertMessages(request.messages ?? []);
  const tools = convertTools(request.tools, warnings);
  const { toolChoice, parallel } = convertToolChoice(request.tool_choice);
  const reasoning = mapReasoning(request, config);

  const userId = request.metadata?.user_id;
  const promptCacheKey =
    typeof userId === "string" && userId.length > 0 ? sha256Base64Url(userId).slice(0, 32) : "";

  const maxOutputTokens =
    typeof request.max_tokens === "number" && request.max_tokens > 0
      ? Math.min(request.max_tokens, config.maxOutputTokens)
      : config.maxOutputTokens;

  const body: ResponsesRequest = {
    model: resolveModel(request.model, config),
    store: false,
    stream: true,
    instructions,
    input,
    text: { verbosity: config.textVerbosity },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: promptCacheKey,
    tool_choice: toolChoice,
    parallel_tool_calls: parallel,
    max_output_tokens: maxOutputTokens,
  };
  if (tools) body.tools = tools;
  if (reasoning) {
    body.reasoning = reasoning;
  } else {
    if (typeof request.temperature === "number") body.temperature = request.temperature;
    if (typeof request.top_p === "number") body.top_p = request.top_p;
  }
  if (promptCacheKey === "") delete body.prompt_cache_key;

  const sessionId =
    typeof userId === "string" && isSessionId(userId) ? userId : undefined;

  return { request: body, sessionId, warnings };
}

/** Approximate input token count for count_tokens responses. */
export function estimateRequestTokens(request: AnthropicRequest): number {
  let total = estimateTokens(systemText(request.system));
  for (const message of request.messages ?? []) {
    if (typeof message.content === "string") {
      total += estimateTokens(message.content);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text") total += estimateTokens(String((block as { text?: unknown }).text ?? ""));
      else if (block.type === "tool_use") total += estimateTokens(JSON.stringify((block as { input?: unknown }).input ?? {})) + 16;
      else if (block.type === "tool_result") {
        const content = (block as { content?: unknown }).content;
        total += typeof content === "string" ? estimateTokens(content) : estimateTokens(JSON.stringify(content ?? ""));
      } else if (block.type === "image") total += 1600;
    }
  }
  if (Array.isArray(request.tools)) total += estimateTokens(JSON.stringify(request.tools));
  return Math.max(1, Math.ceil(total));
}