import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function randomHex(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function base64Url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function sha256Base64Url(input: string): string {
  return base64Url(crypto.createHash("sha256").update(input).digest());
}

export function randomUrlSafe(bytes = 48): string {
  return base64Url(crypto.randomBytes(bytes));
}

/** Decode a JWT payload. Returns null for malformed tokens. */
export function decodeJwt(token: string | undefined | null): Record<string, any> | null {
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

export function jwtExpiryMs(token: string | undefined | null): number | null {
  const payload = decodeJwt(token);
  const exp = payload?.exp;
  if (typeof exp === "number" && Number.isFinite(exp)) return exp * 1000;
  return null;
}

/** Extract ChatGPT account information from an id/access token. */
export function chatgptClaims(token: string | undefined | null): {
  accountId?: string;
  planType?: string;
  email?: string;
  userId?: string;
} {
  const payload = decodeJwt(token);
  if (!payload) return {};
  const auth = payload["https://api.openai.com/auth"] as Record<string, any> | undefined;
  const profile = payload["https://api.openai.com/profile"] as Record<string, any> | undefined;
  return {
    accountId: firstString(auth?.chatgpt_account_id),
    planType: firstString(auth?.chatgpt_plan_type),
    email: firstString(payload.email) ?? firstString(profile?.email),
    userId: firstString(auth?.chatgpt_user_id) ?? firstString(auth?.user_id),
  };
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function atomicWriteFile(filePath: string, data: string, mode = 0o600): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${randomHex(6)}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    // Windows can refuse to replace an existing file in some edge cases.
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      /* ignore */
    }
    fs.renameSync(tmp, filePath);
  }
  secureFile(filePath);
}

export function secureFile(filePath: string): void {
  if (process.platform === "win32") {
    // Best-effort ACL hardening; never fail the operation because of it.
    try {
      const user = process.env.USERNAME;
      if (user) {
        spawnSync("icacls", [filePath, "/inheritance:r", "/grant:r", `${user}:F`], {
          stdio: "ignore",
          windowsHide: true,
        });
      }
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* ignore */
  }
}

export function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/("(?:access_token|refresh_token|id_token|localToken)"\s*:\s*")[^"]+(")/g, "$1<redacted>$2")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<jwt>");
}

export function debugLog(...args: unknown[]): void {
  if (process.env.GPT_GATEWAY_DEBUG) {
    console.error("[gpt-gateway]", ...args);
  }
}

export function log(...args: unknown[]): void {
  console.error("[gpt-gateway]", ...args);
}

/** Rough token estimate used by /v1/messages/count_tokens. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x3400 && code <= 0x4dbf)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk + other / 3.6);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function platformOpenCommand(url: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}

export function tryOpenUrl(url: string): void {
  try {
    const { command, args } = platformOpenCommand(url);
    spawnSync(command, args, { stdio: "ignore", windowsHide: true });
  } catch {
    /* the user can open the printed URL manually */
  }
}

export function gatewayHomeDir(): string {
  return process.env.GPT_GATEWAY_HOME || path.join(os.homedir(), ".gpt-gateway");
}