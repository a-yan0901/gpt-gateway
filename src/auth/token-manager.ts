import { loadAuth } from "../config";
import type { TokenBundle } from "../types";
import { debugLog, jwtExpiryMs } from "../util";
import { ReauthRequiredError, refreshStoredAuth } from "./oauth";

const REFRESH_MARGIN_MS = 2 * 60 * 1000;

/**
 * Owns the ChatGPT access token.
 *
 * - Independently-obtained tokens are refreshed with single-flight semantics.
 * - Tokens imported from ~/.codex/auth.json are never refreshed: the Codex CLI
 *   owns that refresh token and refreshing it here can invalidate Codex's copy.
 */
export class TokenManager {
  private auth: TokenBundle | null;
  private refreshing: Promise<TokenBundle> | null = null;
  private lastRefreshAt = 0;

  constructor(auth?: TokenBundle | null) {
    this.auth = auth === undefined ? loadAuth() : auth;
  }

  get current(): TokenBundle | null {
    return this.auth;
  }

  /** Reload from disk (used after a CLI login while a server is running). */
  reload(): TokenBundle | null {
    this.auth = loadAuth();
    this.refreshing = null;
    return this.auth;
  }

  isExpiring(auth: TokenBundle, marginMs = REFRESH_MARGIN_MS): boolean {
    const exp = jwtExpiryMs(auth.access_token) ?? auth.expires_at;
    if (!exp) return false;
    return exp - Date.now() <= marginMs;
  }

  async getAuth(): Promise<TokenBundle> {
    const auth = this.auth;
    if (!auth) {
      throw new ReauthRequiredError("Not signed in. Run: gpt-gateway login");
    }
    if (!this.isExpiring(auth)) return auth;

    if (auth.imported) {
      throw new ReauthRequiredError(
        "The imported Codex token has expired. Run `gpt-gateway login --import-codex` after refreshing Codex, or use `gpt-gateway login` for an independent login.",
      );
    }
    if (!auth.refresh_token) {
      throw new ReauthRequiredError("Login expired and no refresh token is available. Run: gpt-gateway login");
    }

    const now = Date.now();
    if (this.lastRefreshAt && now - this.lastRefreshAt < 30_000) {
      // A refresh just happened and the access token still looks expired.
      // Do not hammer the token endpoint; let the upstream 401 path handle it.
      return auth;
    }
    return this.refresh();
  }

  async getAccessToken(): Promise<string> {
    return (await this.getAuth()).access_token;
  }

  /** Called after an upstream 401. Single-flight, and only once per token. */
  async refreshAfterUnauthorized(failedToken: string): Promise<TokenBundle> {
    if (this.auth && this.auth.access_token !== failedToken) {
      // Another request already refreshed the token.
      return this.auth;
    }
    const auth = this.auth;
    if (!auth) throw new ReauthRequiredError("Not signed in. Run: gpt-gateway login");
    if (auth.imported) {
      throw new ReauthRequiredError(
        "The imported Codex token was rejected. Run `gpt-gateway login` for an independent login.",
      );
    }
    if (!auth.refresh_token) {
      throw new ReauthRequiredError("Session rejected and no refresh token is available. Run: gpt-gateway login");
    }
    return this.refresh();
  }

  private refresh(): Promise<TokenBundle> {
    if (this.refreshing) return this.refreshing;
    const auth = this.auth;
    if (!auth) return Promise.reject(new ReauthRequiredError("Not signed in. Run: gpt-gateway login"));

    debugLog("refreshing ChatGPT access token");
    this.lastRefreshAt = Date.now();
    this.refreshing = refreshStoredAuthSafe(auth)
      .then((bundle) => {
        this.auth = bundle;
        debugLog("ChatGPT access token refreshed");
        return bundle;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }
}

// Keep the import name in one place; the typo-proof wrapper also avoids a
// partially-updated module during hot reload in development.
function refreshStoredAuthSafe(auth: TokenBundle): Promise<TokenBundle> {
  return refreshStoredAuth(auth);
}