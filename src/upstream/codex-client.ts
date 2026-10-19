import type { GatewayConfig } from "../config";
import type { ResponsesRequest, TokenBundle } from "../types";
import { redact } from "../util";

export class UpstreamError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;
  body?: string;
  constructor(
    message: string,
    options: { status: number; code?: string; retryAfterMs?: number; body?: string },
  ) {
    super(message);
    this.name = "UpstreamError";
    this.status = options.status;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
    this.body = options.body;
  }
}

export interface CodexRequestOptions {
  body: ResponsesRequest;
  auth: TokenBundle;
  signal?: AbortSignal;
  sessionId?: string;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** POST /responses against the ChatGPT Codex backend. */
export async function postResponses(config: GatewayConfig, options: CodexRequestOptions): Promise<Response> {
  const { body, auth, signal, sessionId } = options;
  const url = `${config.upstreamBaseUrl.replace(/\/+$/, "")}/responses`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${auth.access_token}`,
    originator: auth.originator || config.originator,
    "User-Agent": config.userAgent,
    "OpenAI-Beta": "responses=experimental",
  };

  if (auth.account_id) headers["chatgpt-account-id"] = auth.account_id;
  if (sessionId) headers["session_id"] = sessionId;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (response.ok) return response;

  const text = await response.text().catch(() => "");
  let code: string | undefined;
  try {
    const json = JSON.parse(text);
    code = typeof json?.error?.code === "string" ? json.error.code : undefined;
  } catch {
    /* non-JSON body */
  }
  const detail = redact(text).slice(0, 800);
  throw new UpstreamError(
    `Codex upstream returned ${response.status}${code ? ` (${code})` : ""}: ${detail || response.statusText}`,
    {
      status: response.status,
      code,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      body: detail,
    },
  );
}

export function isAbortError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    ("name" in error && (error as { name?: string }).name === "AbortError")
  );
}