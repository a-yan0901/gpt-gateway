import fs from "node:fs";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  authFromCodex,
  authPath,
  buildClaudeSettings,
  clearAuth,
  configPath,
  displayName,
  homeDir,
  loadAuth,
  loadConfig,
  saveAuth,
  settingsPath,
  writeClaudeSettings,
} from "./config";
import { TokenManager } from "./auth/token-manager";
import {
  describeAuth,
  loginBrowser,
  loginDeviceCode,
  ReauthRequiredError,
} from "./auth/oauth";
import { startServer } from "./server";
import { postResponses } from "./upstream/codex-client";
import { parseSseJson, parseSseStream } from "./upstream/sse";
import { translateRequest } from "./translate/request";
import type { AnthropicRequest } from "./types";
import { atomicWriteFile, chatgptClaims, ensureDir, jwtExpiryMs } from "./util";

const VERSION = "0.1.0";

const HELP = `gpt-gateway ${VERSION}

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

interface ParsedArgs {
  flags: Map<string, string | true>;
  positionals: string[];
  passthrough: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  const passthrough: string[] = [];
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
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
        if (next !== undefined && !next.startsWith("-")) {
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

function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function quoteCommandArg(arg: string): string {
  if (process.platform === "win32") {
    // cmd.exe: wrap in double quotes; embedded quotes are doubled.
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Build a single command line so Node does not warn about args + shell. */
function commandLine(bin: string, args: string[]): string {
  return [bin, ...args].map(quoteCommandArg).join(" ");
}

// Windows npm shims are .cmd files, which need a shell. On POSIX, resolve the
// executable directly: no quoting layer and signals reach Claude Code itself.
function spawnClaudeSync(bin: string, args: string[]): ReturnType<typeof spawnSync> {
  if (process.platform === "win32") {
    return spawnSync(commandLine(bin, args), { encoding: "utf8", shell: true, windowsHide: true });
  }
  return spawnSync(bin, args, { encoding: "utf8" });
}

async function checkTcpReachable(rawUrl: string): Promise<string> {
  const url = new URL(rawUrl);
  const host = url.hostname;
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  const addresses = await dns.lookup(host, { all: true });
  let lastError: Error | undefined;
  for (const { address, family } of addresses) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: address, port, family });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`TCP connect to ${address}:${port} timed out`));
        }, 4000);
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

async function cmdLogin(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  const config = loadConfig();

  if (flags.has("import-codex")) {
    const bundle = authFromCodex();
    if (!bundle) {
      fail("No ChatGPT login found in Codex auth.json (auth_mode must be \"chatgpt\"). Run `codex login` first.");
    }
    if (!bundle) return 1;
    saveAuth(bundle);
    console.log("Imported the Codex CLI login.");
    console.log(`  ${describeAuth(bundle)}`);
    console.log("  Note: imported tokens are never refreshed by the gateway, so that Codex keeps working.");
    console.log("        For long-term use prefer: gpt-gateway login");
    return 0;
  }

  const bundle = flags.has("device")
    ? await loginDeviceCode({ originator: config.originator })
    : await loginBrowser({
        originator: config.originator,
        manualOnly: flags.has("manual"),
      });
  console.log("Signed in with ChatGPT.");
  console.log(`  ${describeAuth(bundle)}`);
  console.log(`  Credentials stored in ${authPath}`);
  return 0;
}

async function cmdLogout(): Promise<number> {
  clearAuth();
  console.log("Removed the stored ChatGPT login.");
  return 0;
}

async function cmdStatus(args: string[]): Promise<number> {
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
          models: config.models,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Signed in: ${describeAuth(auth)}`);
    console.log(`  source: ${auth.source ?? (auth.imported ? "imported" : "oauth")}`);
    console.log(`  ${expired ? "EXPIRED" : "valid"}: ${expires ? new Date(expires).toISOString() : "unknown"}`);
    console.log(`  auth:   ${authPath}`);
    console.log(`  config: ${configPath}`);
    console.log("Models:");
    for (const tier of ["opus", "sonnet", "haiku", "fable"] as const) {
      console.log(`  ${tier.padEnd(7)} -> ${config.models[tier]} (${displayName(config.models[tier])})`);
    }
  }
  return 0;
}

async function cmdServe(args: string[]): Promise<number> {
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
  return new Promise<number>(() => {
    /* keep the process alive until a signal arrives */
  });
}

async function cmdModels(): Promise<number> {
  const config = loadConfig();
  for (const tier of ["opus", "sonnet", "haiku", "fable"] as const) {
    console.log(`${tier.padEnd(7)} -> ${config.models[tier].padEnd(16)} ${displayName(config.models[tier])}`);
  }
  console.log(`\ndefault -> ${config.defaultModel}`);
  console.log(`context window: ${config.contextWindow} tokens`);
  return 0;
}

async function cmdEnv(): Promise<number> {
  const config = loadConfig();
  writeClaudeSettings(config);
  const settings = buildClaudeSettings(config);
  const env = settings.env as Record<string, string>;
  for (const [key, value] of Object.entries(env)) {
    console.log(`export ${key}='${value.replace(/'/g, "'\\''")}'`);
  }
  console.log(`\n# then run: claude --settings '${settingsPath}'`);
  return 0;
}

async function cmdInit(): Promise<number> {
  const config = loadConfig();
  const settings = writeClaudeSettings(config);
  console.log(`config:   ${configPath}`);
  console.log(`settings: ${settings}`);
  console.log("Run `gpt-gateway login` (or `gpt-gateway login --import-codex`), then `gpt-gateway claude`.");
  return 0;
}

async function cmdDoctor(args: string[]): Promise<number> {
  const { flags } = parseArgs(args);
  const config = loadConfig();
  const auth = loadAuth();
  let failed = false;
  const report = (ok: boolean, label: string, detail: string) => {
    console.log(`${ok ? "OK  " : "FAIL"} ${label}: ${detail}`);
    if (!ok) failed = true;
  };
  const warn = (label: string, detail: string) => console.log(`WARN ${label}: ${detail}`);

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  report(nodeMajor >= 22, "node", `${process.versions.node} (need >= 22.19)`);
  report(fs.existsSync(configPath), "config", configPath);
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
    version.status === 0 ? String(version.stdout).trim() : `not runnable (${version.error?.message ?? "exit " + version.status})`,
  );

  try {
    report(true, "upstream", await checkTcpReachable(config.upstreamBaseUrl));
  } catch (error) {
    report(false, "upstream", error instanceof Error ? error.message : String(error));
  }

  if (flags.has("live") && auth) {
    try {
      const request: AnthropicRequest = {
        model: config.models.haiku,
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "Reply with the single word OK." }],
      };
      const translated = translateRequest(request, config);
      const tokens = new TokenManager(auth);
      const upstream = await postResponses(config, {
        body: translated.request,
        auth: await tokens.getAuth(),
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

async function cmdClaude(args: string[]): Promise<number> {
  const config = loadConfig();
  const auth = loadAuth();
  if (!auth) {
    fail("Not signed in. Run `gpt-gateway login` first (or `gpt-gateway login --import-codex`).");
  }

  const handle = await startServer(config, 0);
  ensureDir(path.join(homeDir, "run"));
  const runSettings = path.join(homeDir, "run", `claude-settings-${process.pid}.json`);
  atomicWriteFile(runSettings, `${JSON.stringify(buildClaudeSettings(config, handle.port), null, 2)}\n`);

  const claudeBin = process.env.GPT_GATEWAY_CLAUDE_BIN || "claude";
  console.error(
    `[gpt-gateway] Claude Code -> ${config.models.opus} (opus) / ${config.models.sonnet} (sonnet) via ${handle.url}`,
  );

  const settingsEnv = buildClaudeSettings(config, handle.port).env as Record<string, string>;
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  // A parent Claude Code session (or another gateway) may export model/endpoint
  // variables. Strip those first, then apply the generated settings, so the
  // gateway mapping — not the parent environment — is the source of truth.
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ANTHROPIC_MODEL;
  delete childEnv.ANTHROPIC_CUSTOM_MODEL_OPTION;
  delete childEnv.CLAUDE_CODE_SUBAGENT_MODEL;
  delete childEnv.ANTHROPIC_SMALL_FAST_MODEL;
  delete childEnv.OMC_SUBAGENT_MODEL;
  Object.assign(childEnv, settingsEnv);
  // Do not let a nested Claude Code session reuse the parent's session plumbing.
  delete childEnv.CLAUDECODE;
  delete childEnv.CLAUDE_CODE_CHILD_SESSION;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;
  delete childEnv.CLAUDE_CODE_SESSION_ID;
  delete childEnv.CLAUDE_CODE_MESSAGING_SOCKET;
  delete childEnv.CLAUDE_CODE_MESSAGING_TOKEN;
  delete childEnv.CLAUDE_CODE_EXECPATH;

  const claudeArgs = ["--settings", runSettings, ...args];
  const child =
    process.platform === "win32"
      ? spawn(commandLine(claudeBin, claudeArgs), {
          stdio: "inherit",
          shell: true,
          env: childEnv,
          windowsHide: false,
        })
      : spawn(claudeBin, claudeArgs, { stdio: "inherit", env: childEnv });

  let finished = false;
  const cleanup = async (code: number) => {
    if (finished) return;
    finished = true;
    try {
      fs.rmSync(runSettings, { force: true });
    } catch {
      /* ignore */
    }
    await handle.close().catch(() => undefined);
    process.exit(code);
  };

  child.on("error", (error) => {
    console.error(`[gpt-gateway] failed to start ${claudeBin}: ${error.message}`);
    void cleanup(1);
  });
  child.on("exit", (code, signal) => {
    void cleanup(code ?? (signal ? 1 : 0));
  });

  const forward = (signal: NodeJS.Signals) => {
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));

  return new Promise<number>(() => {
    /* resolved by the child exit handler */
  });
}

async function main(): Promise<number> {
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
    case undefined:
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      return 2;
  }
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof ReauthRequiredError) {
      console.error(`error: ${error.message}`);
    } else {
      console.error(`error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
    process.exitCode = 1;
  });