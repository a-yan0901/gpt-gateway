import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TokenBundle } from "./types";
import {
  atomicWriteFile,
  chatgptClaims,
  ensureDir,
  gatewayHomeDir,
  jwtExpiryMs,
  randomHex,
  readJsonFile,
} from "./util";

export interface ModelMap {
  opus: string;
  sonnet: string;
  haiku: string;
  fable: string;
}

export interface GatewayConfig {
  host: string;
  port: number;
  localToken: string;
  upstreamBaseUrl: string;
  originator: string;
  userAgent: string;
  models: ModelMap;
  defaultModel: string;
  maxOutputTokens: number;
  contextWindow: number;
  textVerbosity: "low" | "medium" | "high";
  reasoningEffort: string | null;
}

export interface AccountInfo {
  accountId?: string;
  planType?: string;
  email?: string;
}

export const homeDir = gatewayHomeDir();
export const configPath = path.join(homeDir, "config.json");
export const authPath = path.join(homeDir, "auth.json");
export const settingsPath = path.join(homeDir, "claude-settings.json");

export const OAUTH = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  issuer: "https://auth.openai.com",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  redirectUri: "http://localhost:1455/auth/callback",
  fallbackRedirectUri: "http://localhost:1457/auth/callback",
  scope: "openid profile email offline_access",
  deviceUserCodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  deviceTokenUrl: "https://auth.openai.com/api/accounts/deviceauth/token",
  deviceVerificationUrl: "https://auth.openai.com/codex/device",
  deviceRedirectUri: "https://auth.openai.com/deviceauth/callback",
} as const;

const DEFAULT_MODELS: ModelMap = {
  opus: "gpt-6.1-sol",
  sonnet: "gpt-6.1-sol",
  haiku: "gpt-6-luna",
  fable: "gpt-6-astra",
};

function defaultConfig(): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    localToken: randomHex(32),
    upstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
    originator: "codex_cli_rs",
    userAgent: "codex_cli_rs/0.163.0",
    models: { ...DEFAULT_MODELS },
    defaultModel: DEFAULT_MODELS.opus,
    maxOutputTokens: 128000,
    contextWindow: 272000,
    textVerbosity: "low",
    reasoningEffort: null,
  };
}

export function loadConfig(): GatewayConfig {
  ensureDir(homeDir);
  const defaults = defaultConfig();
  const stored = readJsonFile<Partial<GatewayConfig>>(configPath) ?? {};
  const config: GatewayConfig = {
    ...defaults,
    ...stored,
    models: { ...defaults.models, ...(stored.models ?? {}) },
  };

  // Environment overrides are useful for tests and for temporary runs.
  if (process.env.GPT_GATEWAY_HOST) config.host = process.env.GPT_GATEWAY_HOST;
  if (process.env.GPT_GATEWAY_PORT) config.port = Number(process.env.GPT_GATEWAY_PORT) || config.port;
  if (process.env.GPT_GATEWAY_UPSTREAM) config.upstreamBaseUrl = process.env.GPT_GATEWAY_UPSTREAM;
  if (process.env.GPT_GATEWAY_LOCAL_TOKEN) config.localToken = process.env.GPT_GATEWAY_LOCAL_TOKEN;
  if (process.env.GPT_GATEWAY_ORIGINATOR) config.originator = process.env.GPT_GATEWAY_ORIGINATOR;
  if (process.env.GPT_GATEWAY_USER_AGENT) config.userAgent = process.env.GPT_GATEWAY_USER_AGENT;
  if (process.env.GPT_GATEWAY_MODEL_OPUS) config.models.opus = process.env.GPT_GATEWAY_MODEL_OPUS;
  if (process.env.GPT_GATEWAY_MODEL_SONNET) config.models.sonnet = process.env.GPT_GATEWAY_MODEL_SONNET;
  if (process.env.GPT_GATEWAY_MODEL_HAIKU) config.models.haiku = process.env.GPT_GATEWAY_MODEL_HAIKU;
  if (process.env.GPT_GATEWAY_MODEL_FABLE) config.models.fable = process.env.GPT_GATEWAY_MODEL_FABLE;
  if (process.env.GPT_GATEWAY_DEFAULT_MODEL) config.defaultModel = process.env.GPT_GATEWAY_DEFAULT_MODEL;
  if (process.env?.GPT_GATEWAY_MAX_OUTPUT_TOKENS) {
    config.maxOutputTokens = Number(process.env.GPT_GATEWAY_MAX_OUTPUT_TOKENS) || config.maxOutputTokens;
  }
  if (process.env.GPT_GATEWAY_CONTEXT_WINDOW) {
    config.contextWindow = Number(process.env.GPT_GATEWAY_CONTEXT_WINDOW) || config.contextWindow;
  }
  if (process.env.GPT_GATEWAY_REASONING_EFFORT !== undefined) {
    config.reasoningEffort = process.env.GPT_GATEWAY_REASONING_EFFORT || null;
  }

  // Migrate the old default, which the upstream account no longer serves.
  if (config.models.opus === "gpt-6-sol") config.models.opus = defaults.models.opus;
  if (config.defaultModel === "gpt-6-sol") config.defaultModel = defaults.models.opus;

  const missing = !fs.existsSync(configPath);
  if (missing || JSON.stringify(stored) !== JSON.stringify({ ...config, localToken: stored.localToken })) {
    saveConfig(config);
  }
  return config;
}

export function saveConfig(config: GatewayConfig): void {
  atomicWriteFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function loadAuth(): TokenBundle | null {
  // Test / automation escape hatch. Never needed in normal use.
  const envToken = process.env.GPT_GATEWAY_ACCESS_TOKEN;
  if (envToken) {
    const claims = chatgptClaims(envToken);
    return {
      access_token: envToken,
      refresh_token: "",
      account_id: process.env.GPT_GATEWAY_ACCOUNT_ID || claims.accountId,
      plan_type: claims.planType,
      email: claims.email,
      expires_at: jwtExpiryMs(envToken) ?? Date.now() + 60 * 60 * 1000,
      imported: true,
    };
  }

  const raw = readJsonFile<any>(authPath);
  if (!raw) return null;
  // Accept both our flat format and a Codex-like { tokens: {...} } shape.
  const bundle: Partial<TokenBundle> =
    typeof raw.access_token === "string" ? raw : (raw.tokens ?? {});
  if (!bundle.access_token || typeof bundle.access_token !== "string") return null;

  const access = bundle.access_token;
  const idToken = bundle.id_token;
  const claims = chatgptClaims(idToken) || chatgptClaims(access);
  return {
    access_token: access,
    refresh_token: typeof bundle.refresh_token === "string" ? bundle.refresh_token : "",
    id_token: idToken,
    account_id: bundle.account_id || claims.accountId,
    plan_type: bundle.plan_type || claims.planType,
    email: bundle.email || claims.email,
    expires_at: typeof bundle.expires_at === "number" ? bundle.expires_at : (jwtExpiryMs(access) ?? 0),
    last_refresh: bundle.last_refresh,
    originator: bundle.originator,
    imported: bundle.imported,
    source: bundle.source,
  };
}

export function saveAuth(auth: TokenBundle): void {
  atomicWriteFile(authPath, `${JSON.stringify(auth, null, 2)}\n`);
}

export function clearAuth(): void {
  try {
    fs.rmSync(authPath, { force: true });
  } catch {
    /* ignore */
  }
}

export function accountInfo(auth: TokenBundle): AccountInfo {
  const claims = chatgptClaims(auth.id_token) || chatgptClaims(auth.access_token);
  return {
    accountId: auth.account_id ?? claims.accountId,
    planType: auth.plan_type ?? claims.planType,
    email: auth.email ?? claims.email,
  };
}

function codexAuthPath(): string {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(home, "auth.json");
}

/**
 * Read the existing Codex CLI login. The returned bundle is marked imported and
 * deliberately not refreshed by the gateway: refreshing the same refresh token
 * from two clients can invalidate one of them.
 */
export function authFromCodex(): TokenBundle | null {
  const raw = readJsonFile<any>(codexAuthPath());
  if (!raw || raw.auth_mode !== "chatgpt") return null;
  const tokens = raw.tokens ?? {};
  const access = tokens.access_token;
  if (typeof access !== "string" || access.length === 0) return null;
  const idToken = typeof tokens.id_token === "string" ? tokens.id_token : undefined;
  const claims = chatgptClaims(idToken) || chatgptClaims(access);
  const expiresAt = jwtExpiryMs(access) ?? Date.now() + 10 * 60 * 1000;
  return {
    access_token: access,
    refresh_token: typeof tokens.refresh_token === "string" ? tokens.refresh_token : "",
    id_token: idToken,
    account_id: tokens.account_id || claims.accountId,
    plan_type: claims.planType,
    email: claims.email,
    expires_at: expiresAt,
    last_refresh: typeof raw.last_refresh === "string" ? raw.last_refresh : undefined,
    imported: true,
    source: "codex",
  };
}

export function buildClaudeSettings(config: GatewayConfig, port = config.port): Record<string, unknown> {
  return {
    env: {
      ANTHROPIC_BASE_URL: `http://${config.host}:${port}`,
      ANTHROPIC_AUTH_TOKEN: config.localToken,
      // Intentionally empty: this shadows a model pin from the user's global
      // settings (often another provider), while Claude Code treats an empty
      // value as unset. The session then follows the `/model` selection, so
      // the model picker and status line stay consistent.
      ANTHROPIC_MODEL: "",
      ANTHROPIC_CUSTOM_MODEL_OPTION: config.models.opus,
      // Subagents resolve their tier through the same *_DEFAULT_*_MODEL table as
      // the main conversation. "inherit" only shadows a model left over from
      // another provider; it is the fallback when an agent assigns no model.
      // It does not force every subagent onto the main model.
      CLAUDE_CODE_SUBAGENT_MODEL: "inherit",
      ANTHROPIC_SMALL_FAST_MODEL: config.models.haiku,
      // Let the /model picker list every model the gateway serves, so users can
      // switch between them without hand-editing settings.
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: config.models.opus,
      ANTHROPIC_DEFAULT_SONNET_MODEL: config.models.sonnet,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: config.models.haiku,
      ANTHROPIC_DEFAULT_FABLE_MODEL: config.models.fable,
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: displayName(config.models.opus),
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: displayName(config.models.sonnet),
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: displayName(config.models.haiku),
      ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: displayName(config.models.fable),
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(config.contextWindow),
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(Math.min(config.maxOutputTokens, 64000)),
      API_TIMEOUT_MS: "600000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  };
}

export function writeClaudeSettings(config: GatewayConfig): string {
  atomicWriteFile(settingsPath, `${JSON.stringify(buildClaudeSettings(config), null, 2)}\n`);
  return settingsPath;
}

export function displayName(model: string): string {
  return model
    .replace(/^gpt-/i, "GPT-")
    .replace(/-codex$/i, "")
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}