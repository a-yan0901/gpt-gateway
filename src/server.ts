import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { GatewayConfig, accountInfo, loadConfig } from "./config";
import { TokenManager } from "./auth/token-manager";
import { ReauthRequiredError } from "./auth/oauth";
import { UpstreamError, isAbortError, postResponses } from "./upstream/codex-client";
import { parseSseJson, parseSseStream } from "./upstream/sse";
import { estimateRequestTokens, resolveModel, translateRequest } from "./translate/request";
import { AnthropicStreamTranslator } from "./translate/stream";
import type { AnthropicRequest, AnthropicResponse, AnthUsage } from "./types";
import { debugLog, log } from "./util";

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface ServerHandle {
  server: http.Server;
  port: number;
  host: string;
  url: string;
  tokenManager: TokenManager;
  close(): Promise<void>;
}

class HttpError extends Error {
  status: number;
  type: string;
  constructor(status: number, type: string, message: string) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

function errorBody(type: string, message: string): Record<string, unknown> {
  return { type: "error", error: { type, message } };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "invalid_request_error", "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function authorized(req: http.IncomingMessage, config: GatewayConfig): boolean {
  if (!config.localToken) return true;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    if (timingSafeEqual(auth.slice(7), config.localToken)) return true;
  }
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && timingSafeEqual(apiKey, config.localToken)) return true;
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  // Hash both sides so the comparison time does not depend on token length or
  // on how many leading characters match.
  const left = crypto.createHash("sha256").update(a).digest();
  const right = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

function anthropicErrorFromUpstream(error: UpstreamError): HttpError {
  const detail = error.message;
  if (error.status === 401) return new HttpError(401, "authentication_error", detail);
  if (error.status === 403) return new HttpError(403, "permission_error", detail);
  if (error.status === 404) return new HttpError(404, "not_found_error", detail);
  if (error.status === 429) return new HttpError(429, "rate_limit_error", detail);
  if (error.status === 400 || error.status === 413 || error.status === 422) {
    return new HttpError(400, "invalid_request_error", detail);
  }
  return new HttpError(502, "api_error", detail);
}

interface AggregatedBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  json?: string;
}

class ResponseAggregator {
  blocks: AggregatedBlock[] = [];
  usage: AnthUsage = { input_tokens: 0, output_tokens: 0 };
  stopReason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" = "end_turn";
  model: string;

  constructor(model: string) {
    this.model = model;
  }

  sink(event: string, data: Record<string, unknown>): void {
    switch (event) {
      case "message_start": {
        const message = data.message as Record<string, any> | undefined;
        const usage = message?.usage as AnthUsage | undefined;
        if (usage) this.usage = { ...this.usage, ...usage, output_tokens: 0 };
        break;
      }
      case "content_block_start": {
        const index = Number(data.index ?? 0);
        const block = (data.content_block ?? {}) as Record<string, any>;
        this.blocks[index] = { type: String(block.type ?? "text") };
        if (block.type === "tool_use") {
          this.blocks[index].id = block.id;
          this.blocks[index].name = block.name;
          this.blocks[index].json = "";
        }
        break;
      }
      case "content_block_delta": {
        const index = Number(data.index ?? 0);
        const delta = (data.delta ?? {}) as Record<string, any>;
        const block = this.blocks[index];
        if (!block) break;
        if (delta.type === "text_delta") block.text = (block.text ?? "") + String(delta.text ?? "");
        else if (delta.type === "input_json_delta") block.json = (block.json ?? "") + String(delta.partial_json ?? "");
        else if (delta.type === "thinking_delta") block.thinking = (block.thinking ?? "") + String(delta.thinking ?? "");
        else if (delta.type === "signature_delta") block.signature = (block.signature ?? "") + String(delta.signature ?? "");
        break;
      }
      case "message_delta": {
        const delta = (data.delta ?? {}) as Record<string, any>;
        if (
          delta.stop_reason === "end_turn" ||
          delta.stop_reason === "max_tokens" ||
          delta.stop_reason === "tool_use" ||
          delta.stop_reason === "stop_sequence"
        ) {
          this.stopReason = delta.stop_reason;
        }
        const usage = data.usage as AnthUsage | undefined;
        if (usage) this.usage = { ...this.usage, ...usage };
        break;
      }
      default:
        break;
    }
  }

  result(): AnthropicResponse {
    const content: AnthropicResponse["content"] = [];
    for (const block of this.blocks) {
      if (!block) continue;
      if (block.type === "text") {
        content.push({ type: "text", text: block.text ?? "" });
      } else if (block.type === "tool_use") {
        let input: unknown = {};
        try {
          input = JSON.parse(block.json || "{}");
        } catch {
          input = {};
        }
        content.push({ type: "tool_use", id: block.id ?? "", name: block.name ?? "", input });
      }
    }
    return {
      id: `msg_${Date.now().toString(36)}`,
      type: "message",
      role: "assistant",
      model: this.model,
      content,
      stop_reason: this.stopReason,
      stop_sequence: null,
      usage: this.usage,
    };
  }
}

async function openUpstream(
  config: GatewayConfig,
  tokens: TokenManager,
  body: ReturnType<typeof translateRequest>,
  signal: AbortSignal,
): Promise<Response> {
  let auth = await tokens.getAuth();
  try {
    return await postResponses(config, {
      body: body.request,
      auth,
      signal,
      sessionId: body.sessionId,
    });
  } catch (error) {
    if (error instanceof UpstreamError && error.status === 401) {
      auth = await tokens.refreshAfterUnauthorized(auth.access_token);
      return postResponses(config, {
        body: body.request,
        auth,
        signal,
        sessionId: body.sessionId,
      });
    }
    throw error;
  }
}

export async function startServer(config: GatewayConfig = loadConfig(), port = config.port): Promise<ServerHandle> {
  const tokenManager = new TokenManager();

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, config, tokenManager);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, config.host, () => resolve());
  });

  const address = server.address() as AddressInfo;
  const actualPort = typeof address === "object" && address ? address.port : port;
  log(`listening on http://${config.host}:${actualPort}`);

  return {
    server,
    port: actualPort,
    host: config.host,
    url: `http://${config.host}:${actualPort}`,
    tokenManager,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Do not let an in-flight SSE stream keep the process alive after the
        // Claude Code child has exited.
        (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: GatewayConfig,
  tokens: TokenManager,
): Promise<void> {
  const started = Date.now();
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  const finishLog = (status: number) => {
    debugLog(`${method} ${path} -> ${status} (${Date.now() - started}ms)`);
  };

  try {
    if (method === "GET" && (path === "/health" || path === "/healthz")) {
      const auth = tokens.current;
      const info = auth ? accountInfo(auth) : {};
      sendJson(res, 200, {
        ok: true,
        signedIn: !!auth,
        plan: info.planType,
        models: config.models,
        defaultModel: config.defaultModel,
      });
      finishLog(200);
      return;
    }

    if (method === "GET" && path === "/v1/models") {
      sendJson(res, 200, {
        object: "list",
        data: [config.models.opus, config.models.sonnet, config.models.haiku, config.models.fable]
          .filter(Boolean)
          .map((id) => ({
          id,
          object: "model",
          type: "model",
          display_name: id,
        })),
      });
      finishLog(200);
      return;
    }

    if (path === "/v1/messages" && method === "POST") {
      await handleMessages(req, res, config, tokens);
      finishLog(res.statusCode);
      return;
    }

    if (path === "/v1/messages/count_tokens" && method === "POST") {
      await handleCountTokens(req, res, config);
      finishLog(res.statusCode);
      return;
    }

    if (path === "/v1/messages/cache_touch" && method === "POST") {
      await readBody(req).catch(() => Buffer.alloc(0));
      sendJson(res, 200, { ok: true });
      finishLog(200);
      return;
    }

    sendJson(res, 404, errorBody("not_found_error", `Unknown endpoint: ${method} ${path}`));
    finishLog(404);
  } catch (error) {
    const httpError =
      error instanceof HttpError
        ? error
        : error instanceof ReauthRequiredError
          ? new HttpError(401, "authentication_error", error.message)
          : error instanceof UpstreamError
            ? anthropicErrorFromUpstream(error)
            : new HttpError(500, "api_error", error instanceof Error ? error.message : String(error));
    log(`${method} ${path} failed: ${httpError.message}`);
    if (!res.headersSent) {
      sendJson(res, httpError.status, errorBody(httpError.type, httpError.message));
    } else if (!res.writableEnded) {
      try {
        res.write(`event: error\ndata: ${JSON.stringify(errorBody(httpError.type, httpError.message))}\n\n`);
      } catch {
        /* client already gone */
      }
      res.end();
    }
    finishLog(httpError.status);
  }
}

async function parseAnthropicRequest(req: http.IncomingMessage): Promise<AnthropicRequest> {
  const raw = await readBody(req);
  if (raw.length === 0) throw new HttpError(400, "invalid_request_error", "Empty request body");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new HttpError(
      400,
      "invalid_request_error",
      `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_request_error", "Request body must be a JSON object");
  }
  const request = parsed as AnthropicRequest;
  if (!Array.isArray(request.messages)) {
    throw new HttpError(400, "invalid_request_error", "messages must be an array");
  }
  return request;
}

async function handleCountTokens(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _config: GatewayConfig,
): Promise<void> {
  const request = await parseAnthropicRequest(req);
  sendJson(res, 200, { input_tokens: estimateRequestTokens(request) });
}

async function handleMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: GatewayConfig,
  tokens: TokenManager,
): Promise<void> {
  if (!authorized(req, config)) {
    throw new HttpError(401, "authentication_error", "Invalid or missing local gateway token");
  }
  const request = await parseAnthropicRequest(req);
  debugLog(
    "Anthropic request:",
    JSON.stringify({
      model: request.model,
      stream: request.stream,
      thinking: request.thinking,
      output_config: request.output_config,
      effort: (request as Record<string, unknown>).effort,
      max_tokens: request.max_tokens,
    }),
  );
  const translated = translateRequest(request, config);
  debugLog(
    "Responses mapping:",
    JSON.stringify({
      model: translated.request.model,
      reasoning: translated.request.reasoning,
      max_output_tokens: translated.request.max_output_tokens,
    }),
  );
  if (translated.warnings.length > 0) debugLog(translated.warnings.join("; "));

  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once("aborted", onClose);
  res.once("close", onClose);

  const wantsStream = request.stream === true;
  const inputEstimate = estimateRequestTokens(request);

  try {
    const upstream = await openUpstream(config, tokens, translated, controller.signal);
    if (!upstream.body) throw new HttpError(502, "api_error", "Upstream returned an empty body");

    if (wantsStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
    }

    const aggregator = wantsStream ? null : new ResponseAggregator(translated.request.model);
    let writeFailed = false;
    const sink = wantsStream
      ? (event: string, data: Record<string, unknown>) => {
          if (writeFailed || res.writableEnded) return;
          try {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          } catch {
            writeFailed = true;
          }
        }
      : (event: string, data: Record<string, unknown>) => aggregator?.sink(event, data);

    const translator = new AnthropicStreamTranslator(sink, {
      model: translated.request.model,
      estimatedInputTokens: inputEstimate,
    });

    try {
      for await (const event of parseSseStream(upstream.body)) {
        if (controller.signal.aborted) break;
        const payload = parseSseJson(event);
        if (!payload) continue;
        translator.handle(event.event, payload);
        if (translator.isFinished) break;
      }
      translator.finish();
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        translator.finish();
      } else {
        translator.fail(error instanceof Error ? error.message : String(error));
      }
    }

    if (wantsStream) {
      if (!res.writableEnded) res.end();
    } else if (aggregator) {
      sendJson(res, 200, aggregator.result());
    }
  } finally {
    req.off("aborted", onClose);
    res.off("close", onClose);
  }
}