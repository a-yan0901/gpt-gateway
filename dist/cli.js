#!/usr/bin/env node

// src/cli.ts
import fs3 from "fs";
import dns from "dns/promises";
import net from "net";
import path3 from "path";
import { spawn, spawnSync as spawnSync2 } from "child_process";

// src/config.ts
import fs2 from "fs";
import os2 from "os";
import path2 from "path";

// src/util.ts
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}
function base64Url(input) {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function sha256Base64Url(input) {
  return base64Url(crypto.createHash("sha256").update(input).digest());
}
function randomUrlSafe(bytes = 48) {
  return base64Url(crypto.randomBytes(bytes));
}
function decodeJwt(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
function jwtExpiryMs(token) {
  const payload = decodeJwt(token);
  const exp = payload?.exp;
  if (typeof exp === "number" && Number.isFinite(exp)) return exp * 1e3;
  return null;
}
function chatgptClaims(token) {
  const payload = decodeJwt(token);
  if (!payload) return {};
  const auth = payload["https://api.openai.com/auth"];
  const profile = payload["https://api.openai.com/profile"];
  return {
    accountId: firstString(auth?.chatgpt_account_id),
    planType: firstString(auth?.chatgpt_plan_type),
    email: firstString(payload.email) ?? firstString(profile?.email),
    userId: firstString(auth?.chatgpt_user_id) ?? firstString(auth?.user_id)
  };
}
function firstString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function atomicWriteFile(filePath, data, mode = 384) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${randomHex(6)}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
    }
    fs.renameSync(tmp, filePath);
  }
  secureFile(filePath);
}
function secureFile(filePath) {
  if (process.platform === "win32") {
    try {
      const user = process.env.USERNAME;
      if (user) {
        spawnSync("icacls", [filePath, "/inheritance:r", "/grant:r", `${user}:F`], {
          stdio: "ignore",
          windowsHide: true
        });
      }
    } catch {
    }
    return;
  }
  try {
    fs.chmodSync(filePath, 384);
  } catch {
  }
}
function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
function redact(value) {
  return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>").replace(/("(?:access_token|refresh_token|id_token|localToken)"\s*:\s*")[^"]+(")/g, "$1<redacted>$2").replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<jwt>");
}
function debugLog(...args) {
  if (process.env.GPT_GATEWAY_DEBUG) {
    console.error("[gpt-gateway]", ...args);
  }
}
function log(...args) {
  console.error("[gpt-gateway]", ...args);
}
function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 19968 && code <= 40959 || code >= 12352 && code <= 12543 || code >= 44032 && code <= 55215 || code >= 13312 && code <= 19903) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk + other / 3.6);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function platformOpenCommand(url) {
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}
function tryOpenUrl(url) {
  try {
    const { command, args } = platformOpenCommand(url);
    spawnSync(command, args, { stdio: "ignore", windowsHide: true });
  } catch {
  }
}
function gatewayHomeDir() {
  return process.env.GPT_GATEWAY_HOME || path.join(os.homedir(), ".gpt-gateway");
}

// src/config.ts
var homeDir = gatewayHomeDir();
var configPath = path2.join(homeDir, "config.json");
var authPath = path2.join(homeDir, "auth.json");
var settingsPath = path2.join(homeDir, "claude-settings.json");
var OAUTH = {
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
  deviceRedirectUri: "https://auth.openai.com/deviceauth/callback"
};
var DEFAULT_MODELS = {
  opus: "gpt-6.1-sol",
  sonnet: "gpt-6.1-sol",
  haiku: "gpt-6-luna",
  fable: "gpt-6-astra"
};
function defaultConfig() {
  return {
    host: "127.0.0.1",
    port: 8787,
    localToken: randomHex(32),
    upstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
    originator: "codex_cli_rs",
    userAgent: "codex_cli_rs/0.163.0",
    models: { ...DEFAULT_MODELS },
    defaultModel: DEFAULT_MODELS.opus,
    maxOutputTokens: 128e3,
    contextWindow: 272e3,
    textVerbosity: "low",
    reasoningEffort: null
  };
}
function loadConfig() {
  ensureDir(homeDir);
  const defaults = defaultConfig();
  const stored = readJsonFile(configPath) ?? {};
  const config = {
    ...defaults,
    ...stored,
    models: { ...defaults.models, ...stored.models ?? {} }
  };
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
  if (process.env.GPT_GATEWAY_REASONING_EFFORT !== void 0) {
    config.reasoningEffort = process.env.GPT_GATEWAY_REASONING_EFFORT || null;
  }
  if (config.models.opus === "gpt-6-sol") config.models.opus = defaults.models.opus;
  if (config.defaultModel === "gpt-6-sol") config.defaultModel = defaults.models.opus;
  const missing = !fs2.existsSync(configPath);
  if (missing || JSON.stringify(stored) !== JSON.stringify({ ...config, localToken: stored.localToken })) {
    saveConfig(config);
  }
  return config;
}
function saveConfig(config) {
  atomicWriteFile(configPath, `${JSON.stringify(config, null, 2)}
`);
}
function loadAuth() {
  const envToken = process.env.GPT_GATEWAY_ACCESS_TOKEN;
  if (envToken) {
    const claims2 = chatgptClaims(envToken);
    return {
      access_token: envToken,
      refresh_token: "",
      account_id: process.env.GPT_GATEWAY_ACCOUNT_ID || claims2.accountId,
      plan_type: claims2.planType,
      email: claims2.email,
      expires_at: jwtExpiryMs(envToken) ?? Date.now() + 60 * 60 * 1e3,
      imported: true
    };
  }
  const raw = readJsonFile(authPath);
  if (!raw) return null;
  const bundle = typeof raw.access_token === "string" ? raw : raw.tokens ?? {};
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
    expires_at: typeof bundle.expires_at === "number" ? bundle.expires_at : jwtExpiryMs(access) ?? 0,
    last_refresh: bundle.last_refresh,
    originator: bundle.originator,
    imported: bundle.imported,
    source: bundle.source
  };
}
function saveAuth(auth) {
  atomicWriteFile(authPath, `${JSON.stringify(auth, null, 2)}
`);
}
function clearAuth() {
  try {
    fs2.rmSync(authPath, { force: true });
  } catch {
  }
}
function accountInfo(auth) {
  const claims = chatgptClaims(auth.id_token) || chatgptClaims(auth.access_token);
  return {
    accountId: auth.account_id ?? claims.accountId,
    planType: auth.plan_type ?? claims.planType,
    email: auth.email ?? claims.email
  };
}
function codexAuthPath() {
  const home = process.env.CODEX_HOME || path2.join(os2.homedir(), ".codex");
  return path2.join(home, "auth.json");
}
function authFromCodex() {
  const raw = readJsonFile(codexAuthPath());
  if (!raw || raw.auth_mode !== "chatgpt") return null;
  const tokens = raw.tokens ?? {};
  const access = tokens.access_token;
  if (typeof access !== "string" || access.length === 0) return null;
  const idToken = typeof tokens.id_token === "string" ? tokens.id_token : void 0;
  const claims = chatgptClaims(idToken) || chatgptClaims(access);
  const expiresAt = jwtExpiryMs(access) ?? Date.now() + 10 * 60 * 1e3;
  return {
    access_token: access,
    refresh_token: typeof tokens.refresh_token === "string" ? tokens.refresh_token : "",
    id_token: idToken,
    account_id: tokens.account_id || claims.accountId,
    plan_type: claims.planType,
    email: claims.email,
    expires_at: expiresAt,
    last_refresh: typeof raw.last_refresh === "string" ? raw.last_refresh : void 0,
    imported: true,
    source: "codex"
  };
}
function buildClaudeSettings(config, port = config.port) {
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
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(Math.min(config.maxOutputTokens, 64e3)),
      API_TIMEOUT_MS: "600000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
    }
  };
}
function writeClaudeSettings(config) {
  atomicWriteFile(settingsPath, `${JSON.stringify(buildClaudeSettings(config), null, 2)}
`);
  return settingsPath;
}
function displayName(model) {
  return model.replace(/^gpt-/i, "GPT-").replace(/-codex$/i, "").replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

// src/auth/oauth.ts
import http from "http";
import readline from "readline";
var OAuthError = class extends Error {
  code;
  status;
  constructor(message, options) {
    super(message);
    this.name = "OAuthError";
    this.code = options?.code;
    this.status = options?.status;
  }
};
var ReauthRequiredError = class extends Error {
  constructor(message = "ChatGPT login has expired. Run: gpt-gateway login") {
    super(message);
    this.name = "ReauthRequiredError";
  }
};
function createPkce() {
  const verifier = randomUrlSafe(48);
  return { verifier, challenge: sha256Base64Url(verifier) };
}
function buildAuthorizationUrl(params) {
  const url = new URL(OAUTH.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OAUTH.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", OAUTH.scope);
  url.searchParams.set("code_challenge", params.pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", params.originator);
  return url.toString();
}
async function tokenRequest(body) {
  const response = await fetch(OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(3e4)
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
  }
  if (!response.ok) {
    const code = typeof json?.error === "string" ? json.error : void 0;
    const description = typeof json?.error_description === "string" ? json.error_description : text.slice(0, 400);
    throw new OAuthError(`OpenAI token request failed (${response.status}): ${description || response.statusText}`, {
      code,
      status: response.status
    });
  }
  if (!json || typeof json.access_token !== "string") {
    throw new OAuthError(`OpenAI token response missing access_token: ${text.slice(0, 400)}`);
  }
  return json;
}
function exchangeAuthorizationCode(code, verifier, redirectUri) {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OAUTH.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri
    })
  );
}
function refreshAccessToken(refreshToken) {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OAUTH.clientId
    })
  );
}
function persistTokenResponse(token, options) {
  const idToken = token.id_token ?? options.previous?.id_token;
  const claims = chatgptClaims(idToken) || chatgptClaims(token.access_token);
  const previous = options.previous;
  const expiresIn = typeof token.expires_in === "number" && token.expires_in > 0 ? token.expires_in : 3600;
  const bundle = {
    access_token: token.access_token,
    refresh_token: token.refresh_token || previous?.refresh_token || "",
    id_token: idToken,
    account_id: claims.accountId ?? previous?.account_id,
    plan_type: claims.planType ?? previous?.plan_type,
    email: claims.email ?? previous?.email,
    expires_at: Date.now() + expiresIn * 1e3,
    last_refresh: (/* @__PURE__ */ new Date()).toISOString(),
    originator: options.originator,
    imported: options.imported ?? false,
    source: options.source ?? "oauth"
  };
  saveAuth(bundle);
  return bundle;
}
async function refreshStoredAuth(auth) {
  if (!auth.refresh_token) {
    throw new OAuthError("No refresh token is stored. Run: gpt-gateway login");
  }
  const token = await refreshAccessToken(auth.refresh_token);
  return persistTokenResponse(token, {
    originator: auth.originator || "codex_cli_rs",
    imported: false,
    source: "refresh",
    previous: auth
  });
}
function parseAuthorizationInput(input) {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? void 0,
      state: url.searchParams.get("state") ?? void 0
    };
  } catch {
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return { code: params.get("code") ?? void 0, state: params.get("state") ?? void 0 };
  }
  return { code: value };
}
async function startCallbackServer(state) {
  const ports = [1455, 1457];
  for (const port of ports) {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      const gotState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (gotState !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h2>State mismatch</h2><p>You can close this window.</p>");
        rejectCode(new OAuthError("OAuth state mismatch"));
        return;
      }
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h2>Missing authorization code</h2><p>You can close this window.</p>");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h2>ChatGPT login complete</h2><p>You can close this window and return to the terminal.</p>");
      resolveCode(code);
    });
    let resolveCode;
    let rejectCode;
    const codePromise = new Promise((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    const listening = await new Promise((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (!listening) {
      server.close();
      continue;
    }
    return {
      port,
      redirectUri: `http://localhost:${port}/auth/callback`,
      waitForCode: () => codePromise,
      close: () => server.close()
    };
  }
  return null;
}
function timeout(ms, message) {
  let handle;
  const promise = new Promise((_, reject) => {
    handle = setTimeout(() => reject(new OAuthError(message)), ms);
  });
  return { promise, cancel: () => clearTimeout(handle) };
}
function askManualCode(rl) {
  return new Promise((resolve) => {
    rl.question(
      "Paste the full callback URL (or the authorization code), then press Enter: ",
      (answer) => resolve(answer)
    );
  });
}
async function loginBrowser(options) {
  const originator = options?.originator || "codex_cli_rs";
  const timeoutMs = options?.timeoutMs ?? 5 * 60 * 1e3;
  const pkce = createPkce();
  const state = randomUrlSafe(24);
  const server = options?.manualOnly ? null : await startCallbackServer(state);
  const redirectUri = server?.redirectUri ?? OAUTH.redirectUri;
  const url = buildAuthorizationUrl({ redirectUri, pkce, state, originator });
  console.error("\nOpen this URL in your browser to sign in with ChatGPT:\n");
  console.error(`  ${url}
`);
  if (!options?.manualOnly) tryOpenUrl(url);
  let code;
  let gotState;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (server) {
      const timeoutHandle = timeout(timeoutMs, "OAuth callback timed out");
      try {
        const first = await Promise.race([
          server.waitForCode().then((value) => ({ kind: "callback", value })),
          askManualCode(rl).then((value) => ({ kind: "manual", value })),
          timeoutHandle.promise
        ]);
        if (first && typeof first === "object" && first.kind === "callback") {
          code = first.value;
          gotState = state;
        } else if (first && typeof first === "object" && first.kind === "manual") {
          ({ code, state: gotState } = parseAuthorizationInput(first.value));
        }
      } finally {
        timeoutHandle.cancel();
        server.close();
      }
    } else {
      const input = await askManualCode(rl);
      ({ code, state: gotState } = parseAuthorizationInput(input));
    }
  } finally {
    rl.close();
  }
  if (!code) throw new OAuthError("No authorization code was provided");
  if (gotState && gotState !== state) throw new OAuthError("OAuth state mismatch");
  const token = await exchangeAuthorizationCode(code, pkce.verifier, redirectUri);
  return persistTokenResponse(token, { originator });
}
async function loginDeviceCode(options) {
  const originator = options?.originator || "codex_cli_rs";
  const timeoutMs = options?.timeoutMs ?? 15 * 60 * 1e3;
  const startResponse = await fetch(OAUTH.deviceUserCodeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: OAUTH.clientId }),
    signal: AbortSignal.timeout(3e4)
  });
  if (!startResponse.ok) {
    const text = await startResponse.text().catch(() => "");
    throw new OAuthError(`Device code request failed (${startResponse.status}): ${text.slice(0, 400)}`, {
      status: startResponse.status
    });
  }
  const start = await startResponse.json();
  if (!start.device_auth_id || !start.user_code) {
    throw new OAuthError(`Invalid device code response: ${JSON.stringify(start)}`);
  }
  const intervalSeconds = typeof start.interval === "string" ? Number(start.interval.trim()) : Number(start.interval ?? 0);
  const intervalMs = Math.max(1e3, (Number.isFinite(intervalSeconds) ? intervalSeconds : 5) * 1e3);
  console.error("\nOpen this URL in your browser and enter the code below:\n");
  console.error(`  ${OAUTH.deviceVerificationUrl}`);
  console.error(`  Code: ${start.user_code}
`);
  tryOpenUrl(OAUTH.deviceVerificationUrl);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const poll = await fetch(OAUTH.deviceTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: start.device_auth_id, user_code: start.user_code }),
      signal: AbortSignal.timeout(3e4)
    });
    const text = await poll.text();
    if (poll.status === 403 || poll.status === 404) {
      await sleep(intervalMs);
      continue;
    }
    if (!poll.ok) {
      throw new OAuthError(`Device code polling failed (${poll.status}): ${text.slice(0, 400)}`, {
        status: poll.status
      });
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new OAuthError(`Invalid device code response: ${text.slice(0, 400)}`);
    }
    const authorizationCode = json.authorization_code;
    const verifier = json.code_verifier;
    if (!authorizationCode || !verifier) {
      throw new OAuthError(`Device code response missing fields: ${JSON.stringify(json)}`);
    }
    const token = await exchangeAuthorizationCode(authorizationCode, verifier, OAUTH.deviceRedirectUri);
    return persistTokenResponse(token, { originator, source: "device-code" });
  }
  throw new OAuthError("Device code login timed out after 15 minutes");
}
function describeAuth(auth) {
  const claims = chatgptClaims(auth.id_token) || chatgptClaims(auth.access_token);
  const plan = auth.plan_type || claims.planType || "unknown";
  const email = auth.email || claims.email || "unknown";
  const account = auth.account_id || claims.accountId || "unknown";
  const expiry = jwtExpiryMs(auth.access_token) ?? auth.expires_at;
  const expires = expiry ? new Date(expiry).toISOString() : "unknown";
  return `account=${account} plan=${plan} email=${email} access_expires=${expires}`;
}

// src/auth/token-manager.ts
var REFRESH_MARGIN_MS = 2 * 60 * 1e3;
var TokenManager = class {
  auth;
  refreshing = null;
  lastRefreshAt = 0;
  constructor(auth) {
    this.auth = auth === void 0 ? loadAuth() : auth;
  }
  get current() {
    return this.auth;
  }
  /** Reload from disk (used after a CLI login while a server is running). */
  reload() {
    this.auth = loadAuth();
    this.refreshing = null;
    return this.auth;
  }
  isExpiring(auth, marginMs = REFRESH_MARGIN_MS) {
    const exp = jwtExpiryMs(auth.access_token) ?? auth.expires_at;
    if (!exp) return false;
    return exp - Date.now() <= marginMs;
  }
  async getAuth() {
    const auth = this.auth;
    if (!auth) {
      throw new ReauthRequiredError("Not signed in. Run: gpt-gateway login");
    }
    if (!this.isExpiring(auth)) return auth;
    if (auth.imported) {
      throw new ReauthRequiredError(
        "The imported Codex token has expired. Run `gpt-gateway login --import-codex` after refreshing Codex, or use `gpt-gateway login` for an independent login."
      );
    }
    if (!auth.refresh_token) {
      throw new ReauthRequiredError("Login expired and no refresh token is available. Run: gpt-gateway login");
    }
    const now = Date.now();
    if (this.lastRefreshAt && now - this.lastRefreshAt < 3e4) {
      return auth;
    }
    return this.refresh();
  }
  async getAccessToken() {
    return (await this.getAuth()).access_token;
  }
  /** Called after an upstream 401. Single-flight, and only once per token. */
  async refreshAfterUnauthorized(failedToken) {
    if (this.auth && this.auth.access_token !== failedToken) {
      return this.auth;
    }
    const auth = this.auth;
    if (!auth) throw new ReauthRequiredError("Not signed in. Run: gpt-gateway login");
    if (auth.imported) {
      throw new ReauthRequiredError(
        "The imported Codex token was rejected. Run `gpt-gateway login` for an independent login."
      );
    }
    if (!auth.refresh_token) {
      throw new ReauthRequiredError("Session rejected and no refresh token is available. Run: gpt-gateway login");
    }
    return this.refresh();
  }
  refresh() {
    if (this.refreshing) return this.refreshing;
    const auth = this.auth;
    if (!auth) return Promise.reject(new ReauthRequiredError("Not signed in. Run: gpt-gateway login"));
    debugLog("refreshing ChatGPT access token");
    this.lastRefreshAt = Date.now();
    this.refreshing = refreshStoredAuthSafe(auth).then((bundle) => {
      this.auth = bundle;
      debugLog("ChatGPT access token refreshed");
      return bundle;
    }).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
};
function refreshStoredAuthSafe(auth) {
  return refreshStoredAuth(auth);
}

// src/server.ts
import crypto2 from "crypto";
import http2 from "http";

// src/upstream/codex-client.ts
var UpstreamError = class extends Error {
  status;
  code;
  retryAfterMs;
  body;
  constructor(message, options) {
    super(message);
    this.name = "UpstreamError";
    this.status = options.status;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
    this.body = options.body;
  }
};
function parseRetryAfter(value) {
  if (!value) return void 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1e3;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return void 0;
}
async function postResponses(config, options) {
  const { body, auth, signal, sessionId } = options;
  const url = `${config.upstreamBaseUrl.replace(/\/+$/, "")}/responses`;
  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${auth.access_token}`,
    originator: auth.originator || config.originator,
    "User-Agent": config.userAgent,
    "OpenAI-Beta": "responses=experimental"
  };
  if (auth.account_id) headers["chatgpt-account-id"] = auth.account_id;
  if (sessionId) headers["session_id"] = sessionId;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal
  });
  if (response.ok) return response;
  const text = await response.text().catch(() => "");
  let code;
  try {
    const json = JSON.parse(text);
    code = typeof json?.error?.code === "string" ? json.error.code : void 0;
  } catch {
  }
  const detail = redact(text).slice(0, 800);
  throw new UpstreamError(
    `Codex upstream returned ${response.status}${code ? ` (${code})` : ""}: ${detail || response.statusText}`,
    {
      status: response.status,
      code,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      body: detail
    }
  );
}
function isAbortError(error) {
  return !!error && typeof error === "object" && ("name" in error && error.name === "AbortError");
}

// src/upstream/sse.ts
function takeLine(buffer) {
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer.charCodeAt(i);
    if (ch === 10) {
      return { line: buffer.slice(0, i), rest: buffer.slice(i + 1) };
    }
    if (ch === 13) {
      if (i + 1 >= buffer.length) return null;
      const skip = buffer.charCodeAt(i + 1) === 10 ? 2 : 1;
      return { line: buffer.slice(0, i), rest: buffer.slice(i + skip) };
    }
  }
  return null;
}
async function* parseSseStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName;
  let eventId;
  let retry;
  let dataLines = [];
  const dispatch = () => {
    if (dataLines.length === 0) {
      eventName = void 0;
      eventId = void 0;
      retry = void 0;
      return null;
    }
    const event = { data: dataLines.join("\n") };
    if (eventName !== void 0) event.event = eventName;
    if (eventId !== void 0) event.id = eventId;
    if (retry !== void 0) event.retry = retry;
    eventName = void 0;
    eventId = void 0;
    retry = void 0;
    dataLines = [];
    return event;
  };
  const consumeLine = (line) => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        eventName = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        if (!value.includes("\0")) eventId = value;
        break;
      case "retry": {
        const num = Number(value);
        if (Number.isFinite(num)) retry = num;
        break;
      }
      default:
        break;
    }
    return null;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let line;
      while (line = takeLine(buffer)) {
        buffer = line.rest;
        const event = consumeLine(line.line);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    let tail;
    while (tail = takeLine(buffer)) {
      buffer = tail.rest;
      const event = consumeLine(tail.line);
      if (event) yield event;
    }
    if (buffer.length > 0) {
      const event = consumeLine(buffer.replace(/\r$/, ""));
      if (event) yield event;
    }
    const last = dispatch();
    if (last) yield last;
  } finally {
    try {
      await reader.cancel();
    } catch {
    }
    reader.releaseLock();
  }
}
function parseSseJson(event) {
  if (event.data === "[DONE]") return null;
  try {
    const parsed = JSON.parse(event.data);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// src/translate/request.ts
var TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
function systemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.filter((block) => block && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n\n");
}
function imageUrl(block) {
  const source = block.source;
  if (!source) return null;
  if (source.type === "base64" && source.data) {
    const mediaType = source.media_type || "image/png";
    return `data:${mediaType};base64,${source.data}`;
  }
  if (source.type === "url" && source.url) return source.url;
  return null;
}
function toolResultOutput(block) {
  const content = block.content;
  const isError = block.is_error === true;
  let parts;
  if (typeof content === "string") {
    parts = [{ type: "input_text", text: isError ? `[tool error]
${content}` : content }];
  } else if (Array.isArray(content)) {
    parts = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "text" && typeof item.text === "string") {
        parts.push({ type: "input_text", text: item.text });
      } else if (item.type === "image") {
        const url = imageUrl(item);
        if (url) parts.push({ type: "input_image", image_url: url });
      }
    }
    if (isError && parts.length > 0 && parts[0]?.type === "input_text") {
      parts[0].text = `[tool error]
${String(parts[0].text ?? "")}`;
    }
  } else {
    parts = [{ type: "input_text", text: isError ? "[tool error]" : "" }];
  }
  if (parts.length === 1 && parts[0]?.type === "input_text") {
    return String(parts[0].text ?? "");
  }
  return parts;
}
function assistantContent(blocks) {
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      const text = block.text;
      if (text.length > 0) parts.push({ type: "output_text", text });
    }
  }
  return parts;
}
function userContent(blocks, input) {
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text": {
        const text = block.text;
        if (typeof text === "string" && text.length > 0) parts.push({ type: "input_text", text });
        break;
      }
      case "image": {
        const url = imageUrl(block);
        if (url) parts.push({ type: "input_image", image_url: url });
        break;
      }
      case "tool_result": {
        const callId = block.tool_use_id;
        if (typeof callId === "string" && callId.length > 0) {
          input.push({
            type: "function_call_output",
            call_id: callId,
            output: toolResultOutput(block)
          });
        }
        break;
      }
      case "document": {
        const text = block.text;
        if (typeof text === "string") parts.push({ type: "input_text", text });
        break;
      }
      default:
        break;
    }
  }
  return parts;
}
function convertMessages(messages) {
  const input = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "assistant") {
      const blocks2 = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
      const content2 = assistantContent(blocks2);
      if (content2.length > 0) input.push({ role: "assistant", content: content2 });
      for (const block of blocks2) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_use") {
          const id = block.id;
          const name = block.name;
          if (typeof id !== "string" || typeof name !== "string") continue;
          input.push({
            type: "function_call",
            call_id: id,
            name,
            arguments: JSON.stringify(block.input ?? {})
          });
        }
      }
      continue;
    }
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
    const content = userContent(blocks, input);
    if (content.length > 0) input.push({ role: "user", content });
  }
  return input;
}
function convertTools(tools, warnings) {
  if (!Array.isArray(tools) || tools.length === 0) return void 0;
  const converted = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const name = typeof tool.name === "string" ? tool.name : "";
    if (!name) continue;
    if (!TOOL_NAME_RE.test(name)) {
      warnings.push(`Skipping tool with unsupported name: ${name}`);
      continue;
    }
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
      strict: false
    });
  }
  return converted.length > 0 ? converted : void 0;
}
function convertToolChoice(choice) {
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
        parallel
      };
    case "auto":
    default:
      return { toolChoice: "auto", parallel };
  }
}
function mapReasoning(request, config) {
  const level = request.output_config?.effort;
  if (level && level !== "auto") {
    if (level === "low" || level === "medium" || level === "high" || level === "xhigh" || level === "max") {
      return { effort: level, summary: "auto" };
    }
  }
  if (request.thinking?.type === "enabled") {
    const budget = request.thinking.budget_tokens ?? 0;
    const effort = budget >= 2e4 ? "high" : budget >= 6e3 ? "medium" : "low";
    return { effort, summary: "auto" };
  }
  if (config.reasoningEffort) return { effort: config.reasoningEffort, summary: "auto" };
  return void 0;
}
function resolveModel(model, config) {
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
function isSessionId(value) {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}
function translateRequest(request, config) {
  const warnings = [];
  const instructions = systemText(request.system);
  const input = convertMessages(request.messages ?? []);
  const tools = convertTools(request.tools, warnings);
  const { toolChoice, parallel } = convertToolChoice(request.tool_choice);
  const reasoning = mapReasoning(request, config);
  const userId = request.metadata?.user_id;
  const promptCacheKey = typeof userId === "string" && userId.length > 0 ? sha256Base64Url(userId).slice(0, 32) : "";
  const maxOutputTokens = typeof request.max_tokens === "number" && request.max_tokens > 0 ? Math.min(request.max_tokens, config.maxOutputTokens) : config.maxOutputTokens;
  const body = {
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
    max_output_tokens: maxOutputTokens
  };
  if (tools) body.tools = tools;
  if (reasoning) {
    body.reasoning = reasoning;
  } else {
    if (typeof request.temperature === "number") body.temperature = request.temperature;
    if (typeof request.top_p === "number") body.top_p = request.top_p;
  }
  if (promptCacheKey === "") delete body.prompt_cache_key;
  const sessionId = typeof userId === "string" && isSessionId(userId) ? userId : void 0;
  return { request: body, sessionId, warnings };
}
function estimateRequestTokens(request) {
  let total = estimateTokens(systemText(request.system));
  for (const message of request.messages ?? []) {
    if (typeof message.content === "string") {
      total += estimateTokens(message.content);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text") total += estimateTokens(String(block.text ?? ""));
      else if (block.type === "tool_use") total += estimateTokens(JSON.stringify(block.input ?? {})) + 16;
      else if (block.type === "tool_result") {
        const content = block.content;
        total += typeof content === "string" ? estimateTokens(content) : estimateTokens(JSON.stringify(content ?? ""));
      } else if (block.type === "image") total += 1600;
    }
  }
  if (Array.isArray(request.tools)) total += estimateTokens(JSON.stringify(request.tools));
  return Math.max(1, Math.ceil(total));
}

// src/translate/stream.ts
var AnthropicStreamTranslator = class {
  sink;
  options;
  messageId = `msg_${randomUrlSafe(18)}`;
  model;
  started = false;
  finished = false;
  nextIndex = 0;
  blocks = /* @__PURE__ */ new Map();
  openKeys = [];
  hadTool = false;
  stopReason = "end_turn";
  usage = { input_tokens: 0, output_tokens: 0 };
  constructor(sink, options) {
    this.sink = sink;
    this.options = options;
    this.model = options.model;
    this.usage.input_tokens = Math.max(0, Math.round(options.estimatedInputTokens ?? 0));
  }
  get hasStarted() {
    return this.started;
  }
  get isFinished() {
    return this.finished;
  }
  emit(event, data) {
    if (this.finished) return;
    this.sink(event, data);
  }
  ensureStart() {
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
          cache_creation_input_tokens: 0
        }
      }
    });
  }
  currentOpen() {
    for (let i = this.openKeys.length - 1; i >= 0; i--) {
      const key = this.openKeys[i];
      if (!key) continue;
      const block = this.blocks.get(key);
      if (block && !block.closed) return block;
    }
    return null;
  }
  closeBlock(block) {
    if (block.closed || !block.opened) return;
    block.closed = true;
    this.emit("content_block_stop", { type: "content_block_stop", index: block.index });
  }
  closeCurrent() {
    const current = this.currentOpen();
    if (current) this.closeBlock(current);
  }
  openBlock(key, kind, init) {
    const existing = this.blocks.get(key);
    if (existing) return existing;
    this.ensureStart();
    this.closeCurrent();
    const block = {
      index: this.nextIndex++,
      kind,
      key,
      toolId: init?.toolId,
      name: init?.name,
      opened: false,
      closed: false,
      sawDelta: false,
      text: "",
      args: ""
    };
    this.blocks.set(key, block);
    if (kind === "text") {
      this.emit("content_block_start", {
        type: "content_block_start",
        index: block.index,
        content_block: { type: "text", text: "" }
      });
    } else {
      this.hadTool = true;
      this.emit("content_block_start", {
        type: "content_block_start",
        index: block.index,
        content_block: { type: "tool_use", id: block.toolId, name: block.name, input: {} }
      });
    }
    block.opened = true;
    this.openKeys.push(key);
    return block;
  }
  emitTextDelta(block, delta) {
    if (!delta) return;
    block.sawDelta = true;
    block.text += delta;
    this.emit("content_block_delta", {
      type: "content_block_delta",
      index: block.index,
      delta: { type: "text_delta", text: delta }
    });
  }
  emitJsonDelta(block, delta) {
    if (!delta) return;
    block.sawDelta = true;
    block.args += delta;
    this.emit("content_block_delta", {
      type: "content_block_delta",
      index: block.index,
      delta: { type: "input_json_delta", partial_json: delta }
    });
  }
  ensureToolBlock(payload, item) {
    const itemId = str(item?.id) ?? str(payload.item_id) ?? `tool:${str(payload.output_index) ?? this.nextIndex}`;
    const existing = this.blocks.get(itemId);
    if (existing) return existing;
    const callId = str(item?.call_id) ?? str(payload.call_id) ?? itemId;
    const name = str(item?.name) ?? str(payload.name) ?? "unknown_tool";
    return this.openBlock(itemId, "tool", { toolId: callId, name });
  }
  ensureTextBlock(payload, itemId) {
    const key = itemId ?? str(payload.item_id) ?? `text:${str(payload.output_index) ?? "0"}`;
    return this.openBlock(key, "text");
  }
  updateUsage(raw) {
    if (!raw) return;
    const cached = Number(raw.input_tokens_details?.cached_tokens ?? 0) || 0;
    const input = Number(raw.input_tokens ?? 0) || 0;
    const output = Number(raw.output_tokens ?? 0) || 0;
    this.usage = {
      input_tokens: Math.max(0, input - cached),
      output_tokens: output,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0
    };
  }
  handle(eventName, payload) {
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
        this.updateUsage(asRecord(response?.usage));
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
  finish() {
    if (this.finished) return;
    this.ensureStart();
    this.closeCurrent();
    if (this.hadTool && this.stopReason === "end_turn") this.stopReason = "tool_use";
    this.finished = true;
    this.sink("message_delta", {
      type: "message_delta",
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage: this.usage
    });
    this.sink("message_stop", { type: "message_stop" });
  }
  fail(message) {
    if (this.finished) return;
    this.ensureStart();
    this.closeCurrent();
    this.finished = true;
    this.sink("error", {
      type: "error",
      error: { type: "api_error", message }
    });
  }
};
function str(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function asRecord(value) {
  return value && typeof value === "object" ? value : null;
}

// src/server.ts
var MAX_BODY_BYTES = 64 * 1024 * 1024;
var HttpError = class extends Error {
  status;
  type;
  constructor(status, type, message) {
    super(message);
    this.status = status;
    this.type = type;
  }
};
function errorBody(type, message) {
  return { type: "error", error: { type, message } };
}
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
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
function authorized(req, config) {
  if (!config.localToken) return true;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    if (timingSafeEqual(auth.slice(7), config.localToken)) return true;
  }
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && timingSafeEqual(apiKey, config.localToken)) return true;
  return false;
}
function timingSafeEqual(a, b) {
  const left = crypto2.createHash("sha256").update(a).digest();
  const right = crypto2.createHash("sha256").update(b).digest();
  return crypto2.timingSafeEqual(left, right);
}
function anthropicErrorFromUpstream(error) {
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
var ResponseAggregator = class {
  blocks = [];
  usage = { input_tokens: 0, output_tokens: 0 };
  stopReason = "end_turn";
  model;
  constructor(model) {
    this.model = model;
  }
  sink(event, data) {
    switch (event) {
      case "message_start": {
        const message = data.message;
        const usage = message?.usage;
        if (usage) this.usage = { ...this.usage, ...usage, output_tokens: 0 };
        break;
      }
      case "content_block_start": {
        const index = Number(data.index ?? 0);
        const block = data.content_block ?? {};
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
        const delta = data.delta ?? {};
        const block = this.blocks[index];
        if (!block) break;
        if (delta.type === "text_delta") block.text = (block.text ?? "") + String(delta.text ?? "");
        else if (delta.type === "input_json_delta") block.json = (block.json ?? "") + String(delta.partial_json ?? "");
        else if (delta.type === "thinking_delta") block.thinking = (block.thinking ?? "") + String(delta.thinking ?? "");
        else if (delta.type === "signature_delta") block.signature = (block.signature ?? "") + String(delta.signature ?? "");
        break;
      }
      case "message_delta": {
        const delta = data.delta ?? {};
        if (delta.stop_reason === "end_turn" || delta.stop_reason === "max_tokens" || delta.stop_reason === "tool_use" || delta.stop_reason === "stop_sequence") {
          this.stopReason = delta.stop_reason;
        }
        const usage = data.usage;
        if (usage) this.usage = { ...this.usage, ...usage };
        break;
      }
      default:
        break;
    }
  }
  result() {
    const content = [];
    for (const block of this.blocks) {
      if (!block) continue;
      if (block.type === "text") {
        content.push({ type: "text", text: block.text ?? "" });
      } else if (block.type === "tool_use") {
        let input = {};
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
      usage: this.usage
    };
  }
};
async function openUpstream(config, tokens, body, signal) {
  let auth = await tokens.getAuth();
  try {
    return await postResponses(config, {
      body: body.request,
      auth,
      signal,
      sessionId: body.sessionId
    });
  } catch (error) {
    if (error instanceof UpstreamError && error.status === 401) {
      auth = await tokens.refreshAfterUnauthorized(auth.access_token);
      return postResponses(config, {
        body: body.request,
        auth,
        signal,
        sessionId: body.sessionId
      });
    }
    throw error;
  }
}
async function startServer(config = loadConfig(), port = config.port) {
  const tokenManager = new TokenManager();
  const server = http2.createServer((req, res) => {
    void handleRequest(req, res, config, tokenManager);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, config.host, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  log(`listening on http://${config.host}:${actualPort}`);
  return {
    server,
    port: actualPort,
    host: config.host,
    url: `http://${config.host}:${actualPort}`,
    tokenManager,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}
async function handleRequest(req, res, config, tokens) {
  const started = Date.now();
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path4 = url.pathname;
  const finishLog = (status) => {
    debugLog(`${method} ${path4} -> ${status} (${Date.now() - started}ms)`);
  };
  try {
    if (method === "GET" && (path4 === "/health" || path4 === "/healthz")) {
      const auth = tokens.current;
      const info = auth ? accountInfo(auth) : {};
      sendJson(res, 200, {
        ok: true,
        signedIn: !!auth,
        plan: info.planType,
        models: config.models,
        defaultModel: config.defaultModel
      });
      finishLog(200);
      return;
    }
    if (method === "GET" && path4 === "/v1/models") {
      const ids = [.../* @__PURE__ */ new Set([config.models.opus, config.models.sonnet, config.models.haiku, config.models.fable])].filter(Boolean);
      sendJson(res, 200, {
        object: "list",
        data: ids.map((id) => ({
          id,
          object: "model",
          type: "model",
          display_name: displayName(id),
          created_at: "2025-01-01T00:00:00Z"
        })),
        has_more: false,
        first_id: ids[0] ?? null,
        last_id: ids[ids.length - 1] ?? null
      });
      finishLog(200);
      return;
    }
    if (path4 === "/v1/messages" && method === "POST") {
      await handleMessages(req, res, config, tokens);
      finishLog(res.statusCode);
      return;
    }
    if (path4 === "/v1/messages/count_tokens" && method === "POST") {
      await handleCountTokens(req, res, config);
      finishLog(res.statusCode);
      return;
    }
    if (path4 === "/v1/messages/cache_touch" && method === "POST") {
      await readBody(req).catch(() => Buffer.alloc(0));
      sendJson(res, 200, { ok: true });
      finishLog(200);
      return;
    }
    sendJson(res, 404, errorBody("not_found_error", `Unknown endpoint: ${method} ${path4}`));
    finishLog(404);
  } catch (error) {
    const httpError = error instanceof HttpError ? error : error instanceof ReauthRequiredError ? new HttpError(401, "authentication_error", error.message) : error instanceof UpstreamError ? anthropicErrorFromUpstream(error) : new HttpError(500, "api_error", error instanceof Error ? error.message : String(error));
    log(`${method} ${path4} failed: ${httpError.message}`);
    if (!res.headersSent) {
      sendJson(res, httpError.status, errorBody(httpError.type, httpError.message));
    } else if (!res.writableEnded) {
      try {
        res.write(`event: error
data: ${JSON.stringify(errorBody(httpError.type, httpError.message))}

`);
      } catch {
      }
      res.end();
    }
    finishLog(httpError.status);
  }
}
async function parseAnthropicRequest(req) {
  const raw = await readBody(req);
  if (raw.length === 0) throw new HttpError(400, "invalid_request_error", "Empty request body");
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new HttpError(
      400,
      "invalid_request_error",
      `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_request_error", "Request body must be a JSON object");
  }
  const request = parsed;
  if (!Array.isArray(request.messages)) {
    throw new HttpError(400, "invalid_request_error", "messages must be an array");
  }
  return request;
}
async function handleCountTokens(req, res, _config) {
  const request = await parseAnthropicRequest(req);
  sendJson(res, 200, { input_tokens: estimateRequestTokens(request) });
}
async function handleMessages(req, res, config, tokens) {
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
      effort: request.effort,
      max_tokens: request.max_tokens
    })
  );
  const translated = translateRequest(request, config);
  debugLog(
    "Responses mapping:",
    JSON.stringify({
      model: translated.request.model,
      reasoning: translated.request.reasoning,
      max_output_tokens: translated.request.max_output_tokens
    })
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
        "X-Accel-Buffering": "no"
      });
      res.flushHeaders?.();
    }
    const aggregator = wantsStream ? null : new ResponseAggregator(translated.request.model);
    let writeFailed = false;
    const sink = wantsStream ? (event, data) => {
      if (writeFailed || res.writableEnded) return;
      try {
        res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
      } catch {
        writeFailed = true;
      }
    } : (event, data) => aggregator?.sink(event, data);
    const translator = new AnthropicStreamTranslator(sink, {
      model: translated.request.model,
      estimatedInputTokens: inputEstimate
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

// src/cli.ts
var VERSION = "0.1.0";
var HELP = `gpt-gateway ${VERSION}

Use a ChatGPT subscription (Plus/Pro) as the model backend for Claude Code.

Commands:
  gpt-gateway login [--device] [--manual] [--import-codex]
      Sign in with ChatGPT. Default opens a browser and uses a local callback.
      --import-codex  import the existing Codex CLI login (one-time)
      --device        use the device-code flow (no local callback port)
      --manual        print the URL and paste the callback manually

  gpt-gateway logout            Remove the stored ChatGPT login
  gpt-gateway status [--json]   Show the current login and model mapping
  gpt-gateway serve [--port N]  Run the Anthropic-compatible gateway only
  gpt-gateway claude [args...]  Start Claude Code through the gateway
  gpt-gateway models            Show the Claude->GPT tier mapping
  gpt-gateway env               Print environment variables for manual use
  gpt-gateway init              Write the default config and settings file
  gpt-gateway doctor [--live]   Diagnose setup (--live sends a real request)

Environment overrides:
  GPT_GATEWAY_HOME, GPT_GATEWAY_HOST, GPT_GATEWAY_PORT,
  GPT_GATEWAY_MODEL_OPUS/SONNET/HAIKU/FABLE, GPT_GATEWAY_CLAUDE_BIN
`;
function parseArgs(args) {
  const flags = /* @__PURE__ */ new Map();
  const positionals = [];
  const passthrough = [];
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === void 0) continue;
    if (afterDoubleDash) {
      passthrough.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const name = arg.slice(2);
        const next = args[i + 1];
        if (next !== void 0 && !next.startsWith("-")) {
          flags.set(name, next);
          i++;
        } else {
          flags.set(name, true);
        }
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      flags.set(arg.slice(1), true);
      continue;
    }
    positionals.push(arg);
  }
  return { flags, positionals, passthrough };
}
function flagString(flags, name) {
  const value = flags.get(name);
  return typeof value === "string" ? value : void 0;
}
function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
function quoteCommandArg(arg) {
  if (process.platform === "win32") {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
function commandLine(bin, args) {
  return [bin, ...args].map(quoteCommandArg).join(" ");
}
function spawnClaudeSync(bin, args) {
  if (process.platform === "win32") {
    return spawnSync2(commandLine(bin, args), { encoding: "utf8", shell: true, windowsHide: true });
  }
  return spawnSync2(bin, args, { encoding: "utf8" });
}
async function checkTcpReachable(rawUrl) {
  const url = new URL(rawUrl);
  const host = url.hostname;
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  const addresses = await dns.lookup(host, { all: true });
  let lastError;
  for (const { address, family } of addresses) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host: address, port, family });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`TCP connect to ${address}:${port} timed out`));
        }, 4e3);
        socket.once("connect", () => {
          clearTimeout(timer);
          socket.destroy();
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      return `${host}:${port} reachable (${address})`;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error(`No addresses found for ${host}`);
}
async function cmdLogin(args) {
  const { flags } = parseArgs(args);
  const config = loadConfig();
  if (flags.has("import-codex")) {
    const bundle2 = authFromCodex();
    if (!bundle2) {
      fail('No ChatGPT login found in Codex auth.json (auth_mode must be "chatgpt"). Run `codex login` first.');
    }
    if (!bundle2) return 1;
    saveAuth(bundle2);
    console.log("Imported the Codex CLI login.");
    console.log(`  ${describeAuth(bundle2)}`);
    console.log("  Note: imported tokens are never refreshed by the gateway, so that Codex keeps working.");
    console.log("        For long-term use prefer: gpt-gateway login");
    return 0;
  }
  const bundle = flags.has("device") ? await loginDeviceCode({ originator: config.originator }) : await loginBrowser({
    originator: config.originator,
    manualOnly: flags.has("manual")
  });
  console.log("Signed in with ChatGPT.");
  console.log(`  ${describeAuth(bundle)}`);
  console.log(`  Credentials stored in ${authPath}`);
  return 0;
}
async function cmdLogout() {
  clearAuth();
  console.log("Removed the stored ChatGPT login.");
  return 0;
}
async function cmdStatus(args) {
  const { flags } = parseArgs(args);
  const config = loadConfig();
  const auth = loadAuth();
  if (!auth) {
    if (flags.has("json")) {
      console.log(JSON.stringify({ signedIn: false }, null, 2));
    } else {
      console.log("Not signed in. Run: gpt-gateway login");
    }
    return 1;
  }
  const claims = chatgptClaims(auth.id_token) || chatgptClaims(auth.access_token);
  const expires = jwtExpiryMs(auth.access_token) ?? auth.expires_at;
  const expired = expires > 0 && expires <= Date.now();
  if (flags.has("json")) {
    console.log(
      JSON.stringify(
        {
          signedIn: true,
          accountId: auth.account_id ?? claims.accountId,
          plan: auth.plan_type ?? claims.planType,
          email: auth.email ?? claims.email,
          imported: auth.imported === true,
          source: auth.source,
          accessExpiresAt: expires ? new Date(expires).toISOString() : null,
          expired,
          authPath,
          configPath,
          models: config.models
        },
        null,
        2
      )
    );
  } else {
    console.log(`Signed in: ${describeAuth(auth)}`);
    console.log(`  source: ${auth.source ?? (auth.imported ? "imported" : "oauth")}`);
    console.log(`  ${expired ? "EXPIRED" : "valid"}: ${expires ? new Date(expires).toISOString() : "unknown"}`);
    console.log(`  auth:   ${authPath}`);
    console.log(`  config: ${configPath}`);
    console.log("Models:");
    for (const tier of ["opus", "sonnet", "haiku", "fable"]) {
      console.log(`  ${tier.padEnd(7)} -> ${config.models[tier]} (${displayName(config.models[tier])})`);
    }
  }
  return 0;
}
async function cmdServe(args) {
  const { flags } = parseArgs(args);
  const config = loadConfig();
  const portText = flagString(flags, "port");
  const port = portText ? Number(portText) : config.port;
  const host = flagString(flags, "host");
  if (host) config.host = host;
  if (!Number.isFinite(port) || port < 0 || port > 65535) fail(`Invalid port: ${portText}`);
  const handle = await startServer(config, port);
  console.log(`gpt-gateway ${VERSION} listening on ${handle.url}`);
  const shutdown = () => {
    void handle.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return new Promise(() => {
  });
}
async function cmdModels() {
  const config = loadConfig();
  for (const tier of ["opus", "sonnet", "haiku", "fable"]) {
    console.log(`${tier.padEnd(7)} -> ${config.models[tier].padEnd(16)} ${displayName(config.models[tier])}`);
  }
  console.log(`
default -> ${config.defaultModel}`);
  console.log(`context window: ${config.contextWindow} tokens`);
  return 0;
}
async function cmdEnv() {
  const config = loadConfig();
  writeClaudeSettings(config);
  const settings = buildClaudeSettings(config);
  const env = settings.env;
  for (const [key, value] of Object.entries(env)) {
    console.log(`export ${key}='${value.replace(/'/g, "'\\''")}'`);
  }
  console.log(`
# then run: claude --settings '${settingsPath}'`);
  return 0;
}
async function cmdInit() {
  const config = loadConfig();
  const settings = writeClaudeSettings(config);
  console.log(`config:   ${configPath}`);
  console.log(`settings: ${settings}`);
  console.log("Run `gpt-gateway login` (or `gpt-gateway login --import-codex`), then `gpt-gateway claude`.");
  return 0;
}
async function cmdDoctor(args) {
  const { flags } = parseArgs(args);
  const config = loadConfig();
  const auth = loadAuth();
  let failed = false;
  const report = (ok, label, detail) => {
    console.log(`${ok ? "OK  " : "FAIL"} ${label}: ${detail}`);
    if (!ok) failed = true;
  };
  const warn = (label, detail) => console.log(`WARN ${label}: ${detail}`);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  report(nodeMajor >= 22, "node", `${process.versions.node} (need >= 22.19)`);
  report(fs3.existsSync(configPath), "config", configPath);
  if (!auth) {
    report(false, "login", "not signed in; run `gpt-gateway login`");
  } else {
    const expires = jwtExpiryMs(auth.access_token) ?? auth.expires_at;
    const valid = !expires || expires > Date.now();
    report(valid, "login", describeAuth(auth));
    if (auth.imported) warn("login", "imported Codex token; it will not be refreshed by the gateway");
    if (!auth.refresh_token && !auth.imported) warn("login", "no refresh token; re-login when the access token expires");
    if (!auth.account_id) warn("login", "no chatgpt-account-id claim found; upstream may reject requests");
  }
  const claudeBin = process.env.GPT_GATEWAY_CLAUDE_BIN || "claude";
  const version = spawnClaudeSync(claudeBin, ["--version"]);
  report(
    version.status === 0,
    "claude",
    version.status === 0 ? String(version.stdout).trim() : `not runnable (${version.error?.message ?? "exit " + version.status})`
  );
  try {
    report(true, "upstream", await checkTcpReachable(config.upstreamBaseUrl));
  } catch (error) {
    report(false, "upstream", error instanceof Error ? error.message : String(error));
  }
  if (flags.has("live") && auth) {
    try {
      const request = {
        model: config.models.haiku,
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "Reply with the single word OK." }]
      };
      const translated = translateRequest(request, config);
      const tokens = new TokenManager(auth);
      const upstream = await postResponses(config, {
        body: translated.request,
        auth: await tokens.getAuth()
      });
      if (!upstream.body) throw new Error("empty upstream body");
      let text = "";
      let completed = false;
      for await (const event of parseSseStream(upstream.body)) {
        const payload = parseSseJson(event);
        if (!payload) continue;
        if (payload.type === "response.output_text.delta") text += String(payload.delta ?? "");
        if (payload.type === "response.completed") {
          completed = true;
          break;
        }
      }
      report(completed, "live", completed ? `model replied: ${JSON.stringify(text.slice(0, 80))}` : "stream ended early");
    } catch (error) {
      report(false, "live", error instanceof Error ? error.message : String(error));
    }
  }
  return failed ? 1 : 0;
}
async function cmdClaude(args) {
  const config = loadConfig();
  const auth = loadAuth();
  if (!auth) {
    fail("Not signed in. Run `gpt-gateway login` first (or `gpt-gateway login --import-codex`).");
  }
  const handle = await startServer(config, 0);
  ensureDir(path3.join(homeDir, "run"));
  const runSettings = path3.join(homeDir, "run", `claude-settings-${process.pid}.json`);
  atomicWriteFile(runSettings, `${JSON.stringify(buildClaudeSettings(config, handle.port), null, 2)}
`);
  const claudeBin = process.env.GPT_GATEWAY_CLAUDE_BIN || "claude";
  console.error(
    `[gpt-gateway] Claude Code -> ${config.models.opus} (opus) / ${config.models.sonnet} (sonnet) via ${handle.url}`
  );
  const settingsEnv = buildClaudeSettings(config, handle.port).env;
  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ANTHROPIC_MODEL;
  delete childEnv.ANTHROPIC_CUSTOM_MODEL_OPTION;
  Object.assign(childEnv, settingsEnv);
  delete childEnv.CLAUDECODE;
  delete childEnv.CLAUDE_CODE_CHILD_SESSION;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;
  delete childEnv.CLAUDE_CODE_SESSION_ID;
  delete childEnv.CLAUDE_CODE_MESSAGING_SOCKET;
  delete childEnv.CLAUDE_CODE_MESSAGING_TOKEN;
  delete childEnv.CLAUDE_CODE_EXECPATH;
  const claudeArgs = ["--settings", runSettings, ...args];
  const child = process.platform === "win32" ? spawn(commandLine(claudeBin, claudeArgs), {
    stdio: "inherit",
    shell: true,
    env: childEnv,
    windowsHide: false
  }) : spawn(claudeBin, claudeArgs, { stdio: "inherit", env: childEnv });
  let finished = false;
  const cleanup = async (code) => {
    if (finished) return;
    finished = true;
    try {
      fs3.rmSync(runSettings, { force: true });
    } catch {
    }
    await handle.close().catch(() => void 0);
    process.exit(code);
  };
  child.on("error", (error) => {
    console.error(`[gpt-gateway] failed to start ${claudeBin}: ${error.message}`);
    void cleanup(1);
  });
  child.on("exit", (code, signal) => {
    void cleanup(code ?? (signal ? 1 : 0));
  });
  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {
    }
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  return new Promise(() => {
  });
}
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "login":
      return cmdLogin(rest);
    case "logout":
      return cmdLogout();
    case "status":
      return cmdStatus(rest);
    case "serve":
      return cmdServe(rest);
    case "models":
      return cmdModels();
    case "env":
      return cmdEnv();
    case "init":
      return cmdInit();
    case "doctor":
      return cmdDoctor(rest);
    case "claude":
      return cmdClaude(rest);
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;
    case "help":
    case "--help":
    case "-h":
    case void 0:
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${command}
`);
      console.log(HELP);
      return 2;
  }
}
main().then((code) => {
  if (code !== 0) process.exitCode = code;
}).catch((error) => {
  if (error instanceof ReauthRequiredError) {
    console.error(`error: ${error.message}`);
  } else {
    console.error(`error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
  process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map