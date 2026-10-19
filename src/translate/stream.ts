import type { AnthUsage } from "../types";
import { randomUrlSafe } from "../util";

/**
 * Translates the Codex/Responses SSE event stream into Anthropic Messages SSE.
 *
 * Reasoning output is intentionally not forwarded: Anthropic thinking blocks
 * require a signature that only the real Anthropic API can produce, and the
 * gateway drops thinking blocks when replaying history anyway.
 */

export interface SseSink {
  (event: string, data: Record<string, unknown>): void;
}

interface BlockState {
  index: number;
  kind: "text" | "tool";
  key: string;
  toolId?: string;
  name?: string;
  opened: boolean;
  closed: boolean;
  sawDelta: boolean;
  text: string;
  args: string;
}

export interface TranslatorOptions {
  model: string;
  estimatedInputTokens?: number;
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  input_tokens_details?: { cached_tokens?: number };
  total_tokens?: number;
}

export class AnthropicStreamTranslator {
  private sink: SseSink;
  private options: TranslatorOptions;
  private messageId = `msg_${randomUrlSafe(18)}`;
  private model: string;
  private started = false;
  private finished = false;
  private nextIndex = 0;
  private blocks = new Map<string, BlockState>();
  private openKeys: string[] = [];
  private hadTool = false;
  private stopReason: "end_turn" | "max_tokens" | "tool_use" = "end_turn";
  private usage: AnthUsage = { input_tokens: 0, output_tokens: 0 };

  constructor(sink: SseSink, options: TranslatorOptions) {
    this.sink = sink;
    this.options = options;
    this.model = options.model;
    this.usage.input_tokens = Math.max(0, Math.round(options.estimatedInputTokens ?? 0));
  }

  get hasStarted(): boolean {
    return this.started;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  private emit(event: string, data: Record<string, unknown>): void {
    if (this.finished) return;
    this.sink(event, data);
  }

  private ensureStart(): void {
    if (this.started) return;
    this.started = true;
    this.emit("message_start", {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: this.usage.input_tokens,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
  }

  private currentOpen(): BlockState | null {
    for (let i = this.openKeys.length - 1; i >= 0; i--) {
      const key = this.openKeys[i];
      if (!key) continue;
      const block = this.blocks.get(key);
      if (block && !block.closed) return block;
    }
    return null;
  }

  private closeBlock(block: BlockState): void {
    if (block.closed || !block.opened) return;
    block.closed = true;
    this.emit("content_block_stop", { type: "content_block_stop", index: block.index });
  }

  private closeCurrent(): void {
    const current = this.currentOpen();
    if (current) this.closeBlock(current);
  }

  private openBlock(key: string, kind: "text" | "tool", init?: { toolId?: string; name?: string }): BlockState {
    const existing = this.blocks.get(key);
    if (existing) return existing;
    this.ensureStart();
    this.closeCurrent();
    const block: BlockState = {
      index: this.nextIndex++,
      kind,
      key,
      toolId: init?.toolId,
      name: init?.name,
      opened: false,
      closed: false,
      sawDelta: false,
      text: "",
      args: "",
    };
    this.blocks.set(key, block);
    if (kind === "text") {
      this.emit("content_block_start", {
        type: "content_block_start",
        index: block.index,
        content_block: { type: "text", text: "" },
      });
    } else {
      this.hadTool = true;
      this.emit("content_block_start", {
        type: "content_block_start",
        index: block.index,
        content_block: { type: "tool_use", id: block.toolId, name: block.name, input: {} },
      });
    }
    block.opened = true;
    this.openKeys.push(key);
    return block;
  }

  private emitTextDelta(block: BlockState, delta: string): void {
    if (!delta) return;
    block.sawDelta = true;
    block.text += delta;
    this.emit("content_block_delta", {
      type: "content_block_delta",
      index: block.index,
      delta: { type: "text_delta", text: delta },
    });
  }

  private emitJsonDelta(block: BlockState, delta: string): void {
    if (!delta) return;
    block.sawDelta = true;
    block.args += delta;
    this.emit("content_block_delta", {
      type: "content_block_delta",
      index: block.index,
      delta: { type: "input_json_delta", partial_json: delta },
    });
  }

  private ensureToolBlock(payload: Record<string, unknown>, item?: Record<string, unknown>): BlockState {
    const itemId = str(item?.id) ?? str(payload.item_id) ?? `tool:${str(payload.output_index) ?? this.nextIndex}`;
    const existing = this.blocks.get(itemId);
    if (existing) return existing;
    const callId = str(item?.call_id) ?? str(payload.call_id) ?? itemId;
    const name = str(item?.name) ?? str(payload.name) ?? "unknown_tool";
    return this.openBlock(itemId, "tool", { toolId: callId, name });
  }

  private ensureTextBlock(payload: Record<string, unknown>, itemId?: string): BlockState {
    const key = itemId ?? str(payload.item_id) ?? `text:${str(payload.output_index) ?? "0"}`;
    return this.openBlock(key, "text");
  }

  private updateUsage(raw: ResponsesUsage | undefined): void {
    if (!raw) return;
    const cached = Number(raw.input_tokens_details?.cached_tokens ?? 0) || 0;
    const input = Number(raw.input_tokens ?? 0) || 0;
    const output = Number(raw.output_tokens ?? 0) || 0;
    this.usage = {
      input_tokens: Math.max(0, input - cached),
      output_tokens: output,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    };
  }

  handle(eventName: string | undefined, payload: Record<string, unknown> | null): void {
    if (this.finished) return;
    if (!payload) return;
    const type = typeof payload.type === "string" ? payload.type : eventName;

    switch (type) {
      case "response.created":
      case "response.in_progress": {
        const response = asRecord(payload.response);
        const model = str(response?.model);
        if (model) this.model = model;
        this.ensureStart();
        break;
      }

      case "response.output_item.added": {
        const item = asRecord(payload.item);
        if (!item) break;
        this.ensureStart();
        if (item.type === "function_call") this.ensureToolBlock(payload, item);
        break;
      }

      case "response.content_part.added": {
        const part = asRecord(payload.part);
        if (part?.type === "output_text") {
          this.ensureTextBlock(payload, str(payload.item_id));
        }
        break;
      }

      case "response.output_text.delta": {
        const delta = str(payload.delta) ?? "";
        const block = this.ensureTextBlock(payload, str(payload.item_id));
        this.emitTextDelta(block, delta);
        break;
      }

      case "response.output_text.done": {
        const block = this.ensureTextBlock(payload, str(payload.item_id));
        const text = str(payload.text);
        if (!block.sawDelta && text) this.emitTextDelta(block, text);
        block.text = text ?? block.text;
        this.closeBlock(block);
        break;
      }

      case "response.function_call_arguments.delta": {
        const block = this.ensureToolBlock(payload);
        this.emitJsonDelta(block, str(payload.delta) ?? "");
        break;
      }

      case "response.function_call_arguments.done": {
        const block = this.ensureToolBlock(payload);
        const args = str(payload.arguments);
        if (!block.sawDelta && args) this.emitJsonDelta(block, args);
        block.args = args ?? block.args;
        this.closeBlock(block);
        break;
      }

      case "response.output_item.done": {
        const item = asRecord(payload.item);
        if (!item) break;
        if (item.type === "function_call") {
          const block = this.ensureToolBlock(payload, item);
          const args = str(item.arguments);
          if (!block.sawDelta && args) this.emitJsonDelta(block, args);
          if (args) block.args = args;
          this.closeBlock(block);
        } else if (item.type === "message") {
          const block = this.blocks.get(str(payload.item_id) ?? str(item.id) ?? "");
          if (block) this.closeBlock(block);
        }
        break;
      }

      case "response.completed":
      case "response.incomplete": {
        const response = asRecord(payload.response);
        this.updateUsage(asRecord(response?.usage) as ResponsesUsage | undefined);
        const status = str(response?.status);
        const reason = str(asRecord(response?.incomplete_details)?.reason);
        if (status === "incomplete" && reason === "max_output_tokens") {
          this.stopReason = "max_tokens";
        }
        this.finish();
        break;
      }

      case "response.failed": {
        const response = asRecord(payload.response);
        const error = asRecord(response?.error) ?? asRecord(payload.error);
        const message = str(error?.message) ?? "Codex upstream response failed";
        this.fail(message);
        break;
      }

      case "error": {
        const error = asRecord(payload.error) ?? payload;
        const message = str(error.message) ?? "Codex upstream stream error";
        this.fail(message);
        break;
      }

      default:
        break;
    }
  }

  /** Flush a stream that ended without a response.completed event. */
  finish(): void {
    if (this.finished) return;
    this.ensureStart();
    this.closeCurrent();
    if (this.hadTool && this.stopReason === "end_turn") this.stopReason = "tool_use";
    this.finished = true;
    // Bypass emit(): it suppresses events once `finished` is set.
    this.sink("message_delta", {
      type: "message_delta",
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage: this.usage,
    });
    this.sink("message_stop", { type: "message_stop" });
  }

  fail(message: string): void {
    if (this.finished) return;
    this.ensureStart();
    this.closeCurrent();
    this.finished = true;
    this.sink("error", {
      type: "error",
      error: { type: "api_error", message },
    });
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" ? (value as Record<string, any>) : null;
}