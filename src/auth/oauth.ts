import http from "node:http";
import readline from "node:readline";
import { OAUTH, saveAuth } from "../config";
import type { TokenBundle } from "../types";
import {
  chatgptClaims,
  jwtExpiryMs,
  randomUrlSafe,
  sha256Base64Url,
  sleep,
  tryOpenUrl,
} from "../util";

export class OAuthError extends Error {
  code?: string;
  status?: number;
  constructor(message: string, options?: { code?: string; status?: number }) {
    super(message);
    this.name = "OAuthError";
    this.code = options?.code;
    this.status = options?.status;
  }
}

export class ReauthRequiredError extends Error {
  constructor(message = "ChatGPT login has expired. Run: gpt-gateway login") {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

interface TokenEndpointResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
}

interface Pkce {
  verifier: string;
  challenge: string;
}

function createPkce(): Pkce {
  const verifier = randomUrlSafe(48);
  return { verifier, challenge: sha256Base64Url(verifier) };
}

export function buildAuthorizationUrl(params: {
  redirectUri: string;
  pkce: Pkce;
  state: string;
  originator: string;
}): string {
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

async function tokenRequest(body: URLSearchParams): Promise<TokenEndpointResponse> {
  const response = await fetch(OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  if (!response.ok) {
    const code = typeof json?.error === "string" ? json.error : undefined;
    const description =
      typeof json?.error_description === "string" ? json.error_description : text.slice(0, 400);
    throw new OAuthError(`OpenAI token request failed (${response.status}): ${description || response.statusText}`, {
      code,
      status: response.status,
    });
  }
  if (!json || typeof json.access_token !== "string") {
    throw new OAuthError(`OpenAI token response missing access_token: ${text.slice(0, 400)}`);
  }
  return json as TokenEndpointResponse;
}

export function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<TokenEndpointResponse> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OAUTH.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  );
}

export function refreshAccessToken(refreshToken: string): Promise<TokenEndpointResponse> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OAUTH.clientId,
    }),
  );
}

export function persistTokenResponse(
  token: TokenEndpointResponse,
  options: { originator: string; imported?: boolean; source?: string; previous?: TokenBundle | null },
): TokenBundle {
  const idToken = token.id_token ?? options.previous?.id_token;
  const claims = chatgptClaims(idToken) || chatgptClaims(token.access_token);
  const previous = options.previous;
  const expiresIn = typeof token.expires_in === "number" && token.expires_in > 0 ? token.expires_in : 3600;
  const bundle: TokenBundle = {
    access_token: token.access_token,
    refresh_token: token.refresh_token || previous?.refresh_token || "",
    id_token: idToken,
    account_id: claims.accountId ?? previous?.account_id,
    plan_type: claims.planType ?? previous?.plan_type,
    email: claims.email ?? previous?.email,
    expires_at: Date.now() + expiresIn * 1000,
    last_refresh: new Date().toISOString(),
    originator: options.originator,
    imported: options.imported ?? false,
    source: options.source ?? "oauth",
  };
  saveAuth(bundle);
  return bundle;
}

export async function refreshStoredAuth(auth: TokenBundle): Promise<TokenBundle> {
  if (!auth.refresh_token) {
    throw new OAuthError("No refresh token is stored. Run: gpt-gateway login");
  }
  // Keep the original expiry if the response does not provide one.
  const token = await refreshAccessToken(auth.refresh_token);
  return persistTokenResponse(token, {
    originator: auth.originator || "codex_cli_rs",
    imported: false,
    source: "refresh",
    previous: auth,
  });
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    /* not a URL */
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
  }
  return { code: value };
}

interface CallbackServer {
  port: number;
  redirectUri: string;
  waitForCode(): Promise<string>;
  close(): void;
}

async function startCallbackServer(state: string): Promise<CallbackServer | null> {
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

    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    const listening = await new Promise<boolean>((resolve) => {
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
      close: () => server.close(),
    };
  }
  return null;
}

function timeout(ms: number, message: string): { promise: Promise<never>; cancel: () => void } {
  let handle: NodeJS.Timeout;
  const promise = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new OAuthError(message)), ms);
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

function askManualCode(rl: readline.Interface): Promise<string> {
  return new Promise<string>((resolve) => {
    rl.question("Paste the full callback URL (or the authorization code), then press Enter: ", (answer) =>
      resolve(answer),
    );
  });
}

export async function loginBrowser(options?: {
  originator?: string;
  timeoutMs?: number;
  manualOnly?: boolean;
}): Promise<TokenBundle> {
  const originator = options?.originator || "codex_cli_rs";
  const timeoutMs = options?.timeoutMs ?? 5 * 60 * 1000;
  const pkce = createPkce();
  const state = randomUrlSafe(24);

  const server = options?.manualOnly ? null : await startCallbackServer(state);
  const redirectUri = server?.redirectUri ?? OAUTH.redirectUri;
  const url = buildAuthorizationUrl({ redirectUri, pkce, state, originator });
  console.error("\nOpen this URL in your browser to sign in with ChatGPT:\n");
  console.error(`  ${url}\n`);
  if (!options?.manualOnly) tryOpenUrl(url);

  let code: string | undefined;
  let gotState: string | undefined;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (server) {
      const timeoutHandle = timeout(timeoutMs, "OAuth callback timed out");
      try {
        const first = await Promise.race([
          server.waitForCode().then((value) => ({ kind: "callback" as const, value })),
          askManualCode(rl).then((value) => ({ kind: "manual" as const, value })),
          timeoutHandle.promise,
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
  return persistTokenResponse(token, { originator: originator });
}

interface DeviceUserCodeResponse {
  device_auth_id: string;
  user_code: string;
  interval?: number | string;
}

export async function loginDeviceCode(options?: {
  originator?: string;
  timeoutMs?: number;
}): Promise<TokenBundle> {
  const originator = options?.originator || "codex_cli_rs";
  const timeoutMs = options?.timeoutMs ?? 15 * 60 * 1000;

  const startResponse = await fetch(OAUTH.deviceUserCodeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: OAUTH.clientId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!startResponse.ok) {
    const text = await startResponse.text().catch(() => "");
    throw new OAuthError(`Device code request failed (${startResponse.status}): ${text.slice(0, 400)}`, {
      status: startResponse.status,
    });
  }
  const start = (await startResponse.json()) as DeviceUserCodeResponse;
  if (!start.device_auth_id || !start.user_code) {
    throw new OAuthError(`Invalid device code response: ${JSON.stringify(start)}`);
  }
  const intervalSeconds =
    typeof start.interval === "string" ? Number(start.interval.trim()) : Number(start.interval ?? 0);
  const intervalMs = Math.max(1000, (Number.isFinite(intervalSeconds) ? intervalSeconds : 5) * 1000);

  console.error("\nOpen this URL in your browser and enter the code below:\n");
  console.error(`  ${OAUTH.deviceVerificationUrl}`);
  console.error(`  Code: ${start.user_code}\n`);
  tryOpenUrl(OAUTH.deviceVerificationUrl);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const poll = await fetch(OAUTH.deviceTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: start.device_auth_id, user_code: start.user_code }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await poll.text();
    if (poll.status === 403 || poll.status === 404) {
      await sleep(intervalMs);
      continue;
    }
    if (!poll.ok) {
      throw new OAuthError(`Device code polling failed (${poll.status}): ${text.slice(0, 400)}`, {
        status: poll.status,
      });
    }
    let json: any;
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

/** A short, printable description of the current grant. */
export function describeAuth(auth: TokenBundle): string {
  const claims = chatgptClaims(auth.id_token) || chatgptClaims(auth.access_token);
  const plan = auth.plan_type || claims.planType || "unknown";
  const email = auth.email || claims.email || "unknown";
  const account = auth.account_id || claims.accountId || "unknown";
  const expiry = jwtExpiryMs(auth.access_token) ?? auth.expires_at;
  const expires = expiry ? new Date(expiry).toISOString() : "unknown";
  return `account=${account} plan=${plan} email=${email} access_expires=${expires}`;
}