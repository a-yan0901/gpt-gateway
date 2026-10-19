# gpt-gateway 方案分析：在 Claude Code 中使用 ChatGPT 订阅模型

> 目标：不购买/不使用 OpenAI API Key，而是复用 **ChatGPT Plus/Pro（及 Codex 订阅）** 的 OAuth 登录，
> 在本机启动一个 Anthropic Messages API 兼容网关，让 `claude` CLI 透明地调用 GPT 模型。
>
> 本文是方案分析与设计基线。实现代码位于 `src/`，当前状态见第 13 节；实现前请重点看第 11 节（风险）。

---

## 0. 结论（推荐方案）

**做一个小型本地网关进程 `gpt-gateway`，前端暴露 Anthropic Messages API，后端调用 Codex 的 Responses API。**

```
Claude Code CLI
  │  ANTHROPIC_BASE_URL=http://127.0.0.1:8787
  │  Authorization: Bearer <本地随机 token>
  ▼
gpt-gateway (Node.js / TypeScript, 仅监听 127.0.0.1)
  ├── /v1/messages             Anthropic Messages ⇄ OpenAI Responses 转换（含 SSE）
  ├── /v1/messages/count_tokens 本地估算
  ├── /v1/messages/cache_touch  空实现（保持兼容）
  ├── OAuth 管理器             ChatGPT 订阅登录 / token 刷新 / 多账号(后续)
  └── Codex 客户端             POST https://chatgpt.com/backend-api/codex/responses
```

推荐理由：

1. **Claude Code 原生支持自定义网关**。已在本机 2.1.296 二进制中确认：
   `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`--settings <file-or-json>`、
   `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`、`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 均存在。
2. **不改 Claude Code、不 fork、不打补丁**，工具调用、文件编辑、Bash、子代理、MCP 全部保留。
3. **认证方式与 OpenClaw / opencode / Codex CLI 完全一致**，都是 ChatGPT 订阅的 OAuth + Codex 后端。
4. 技术栈用 Node 24 + TypeScript：本机已装 Node 24.15，无需 Bun/Rust/Go；Claude Code 本身也在 Node 生态。
5. 用 `--settings` 独立配置文件启动，**不污染全局 `claude` 登录**：默认 `claude` 仍走 Anthropic 订阅。

### 不建议的方案

| 方案 | 不推荐原因 |
|---|---|
| 直接改 Claude Code 二进制/请求 | 版本升级即失效，风险高 |
| 用 LiteLLM / claude-code-router 做转换 | 能跑，但 Codex 订阅认证和 Responses 细节仍要自己补，依赖重 |
| 让 Claude 通过 MCP 调 `codex exec` | 每轮起子进程，无流式/工具保真度差，体验完全不是“在 Claude 里用 GPT” |
| Hermes 式“任务桥接” | 属于两个 agent 协作协议，不是把 GPT 变成 Claude 的模型后端 |

---

## 1. 调研结论

### 1.1 opencode 的做法（主要参考）

opencode 的官方文档写明：

1. `/connect` → 选择 **OpenAI**；
2. 菜单里选 **“ChatGPT Plus/Pro”**（不是手动填 API Key）；
3. 打开浏览器完成 OAuth；
4. 完成后 OpenAI 模型出现在 `/models` 中。

它背后使用的就是 **OpenAI Codex 的 OAuth 客户端和 ChatGPT Codex 后端**，不是 `api.openai.com`。
同一套协议在本机已安装的 OpenClaw / `@earendil-works/pi-ai` 中有完整实现，可直接作为行为基准。

### 1.2 关于 “Hermes”

公开仓库中名为 Hermes 的项目（如 `songruikang/hermes-claude-bridge`）是 **Hermes(GPT) 与 Claude Code 的任务桥接层**，
不是“ChatGPT 订阅 OAuth 反向代理”。如果指某个具体的 Hermes 项目，请给链接，我再对比其认证实现。
就“ChatGPT 订阅登录 + 在 Claude Code 中使用”这一目标而言，opencode、Codex CLI、pi-ai 是更直接的参考。

### 1.3 本机已确认的事实

| 事实 | 证据 |
|---|---|
| Codex CLI 已安装并登录 ChatGPT | `codex-cli 0.163.0`，`codex login status` → `Logged in using ChatGPT` |
| 本机已有可用的 ChatGPT 订阅 token | `~/.codex/auth.json`：`auth_mode=chatgpt`，含 access/refresh/id token、`account_id` |
| Codex 当前模型 | `~/.codex/config.toml`: `model = "gpt-6-luna"`, `model_reasoning_effort = "max"` |
| Claude Code 版本 | `2.1.296`，支持 `--settings` 与自定义 base URL |
| 上游模型目录 | Codex 二进制中出现 `gpt-6.1-sol`、`gpt-6.1-sol`、`gpt-6-astra`、`gpt-6-luna` 等 |

---

## 2. 已确认的协议常量（实现基准）

### 2.1 ChatGPT OAuth

| 项 | 值 |
|---|---|
| OAuth Client ID | `app_EMoamEEZ73f0CkXaXp7hrann` |
| Issuer / Auth Base | `https://auth.openai.com` |
| Authorize | `https://auth.openai.com/oauth/authorize` |
| Token | `https://auth.openai.com/oauth/token` |
| Redirect URI（浏览器） | `http://localhost:1455/auth/callback`（fallback 1457） |
| Scope | `openid profile email offline_access` |
| PKCE | `S256`，`code_verifier` + `code_challenge` |
| 额外参数 | `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=codex_cli_rs` |
| Device Code 申请 | `POST https://auth.openai.com/api/accounts/deviceauth/usercode` |
| Device Code 轮询 | `POST https://auth.openai.com/api/accounts/deviceauth/token` |
| Device 验证页 | `https://auth.openai.com/codex/device` |
| Device redirect | `https://auth.openai.com/deviceauth/callback` |
| Refresh | `POST /oauth/token`，form：`grant_type=refresh_token&refresh_token=...&client_id=...` |
| account id 提取 | JWT claim `https://api.openai.com/auth` → `chatgpt_account_id` |
| 套餐类型 | 同一 claim → `chatgpt_plan_type` |
| 邮箱 | `id_token` 顶层 `email`，或 `https://api.openai.com/profile` |

浏览器授权 URL 的关键参数：

```text
response_type=code
client_id=app_EMoamEEZ73f0CkXaXp7hrann
redirect_uri=http://localhost:1455/auth/callback
scope=openid profile email offline_access
code_challenge=<base64url(sha256(verifier))>
code_challenge_method=S256
state=<random>
id_token_add_organizations=true
codex_cli_simplified_flow=true
originator=codex_cli_rs
```

> 端口 1455 与 Codex CLI 登录回调相同。若被占用：先试 1457，再退化为“粘贴回调 URL/授权码”或 device code。

### 2.2 Codex 后端（ChatGPT 订阅专用，非公开 API）

| 项 | 值 |
|---|---|
| 基址 | `https://chatgpt.com/backend-api/codex` |
| 推理端点 | `POST https://chatgpt.com/backend-api/codex/responses` |
| 认证头 | `Authorization: Bearer <access_token>` |
| 账号头 | `chatgpt-account-id: <chatgpt_account_id>` |
| 客户端标识 | `originator: codex_cli_rs`（OpenClaw/pi-ai 也接受 `pi`/`openclaw`） |
| Beta 头 | `OpenAI-Beta: responses=experimental` |
| 其他头 | `content-type: application/json`, `accept: text/event-stream`, `session-id`, `x-client-request-id` |

最小请求体（已从 pi-ai 的 Codex transport 中确认）：

```json
{
  "model": "gpt-6-luna",
  "store": false,
  "stream": true,
  "instructions": "<system prompt>",
  "input": [ <Responses input items> ],
  "text": { "verbosity": "low" },
  "include": ["reasoning.encrypted_content"],
  "prompt_cache_key": "<stable session uuid>",
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning": { "effort": "high", "summary": "auto" },
  "tools": [
    { "type": "function", "name": "Read", "description": "...", "parameters": { ... }, "strict": false }
  ]
}
```

注意：这些字段属于 Responses API，不要与 Chat Completions 的字段混用。
上游 **强制流式**（`stream: true`）时返回 SSE；非流式客户端请求由网关聚合。

---

## 3. 总体架构

```
┌──────────────────────────────────────────────────────────────────┐
│ Claude Code CLI (2.1.296)                                        │
│   claude --settings ~/.gpt-gateway/claude-settings.json          │
│   env: ANTHROPIC_BASE_URL=http://127.0.0.1:8787                   │
│        ANTHROPIC_AUTH_TOKEN=<local random>                        │
│        ANTHROPIC_DEFAULT_OPUS_MODEL=gpt-6.1-sol                    │
│        ANTHROPIC_DEFAULT_SONNET_MODEL=gpt-6.1-sol                │
│        ANTHROPIC_DEFAULT_HAIKU_MODEL=gpt-6-luna                  │
│        ANTHROPIC_DEFAULT_FABLE_MODEL=gpt-6-astra                 │
└───────────────────────────────┬──────────────────────────────────┘
                                │ POST /v1/messages?beta=true
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ gpt-gateway (127.0.0.1:8787)                                     │
│                                                                  │
│  HTTP server ──► Anthropic request parser                        │
│       │              │                                           │
│       │              ├─► translate-request (Messages→Responses)  │
│       │              │                                           │
│       │              └─► translate-stream  (Responses SSE→SSE)   │
│       │                           │                              │
│       │                           ▼                              │
│       │                  CodexClient.fetch()                     │
│       │                           │                              │
│       │                  TokenManager (refresh / lock)           │
│       │                           │                              │
│       └───────────────────────────┴──────────────► ChatGPT Codex│
│                                                                  │
│  Auth store: ~/.gpt-gateway/auth.json (0600 / ACL)               │
│  Settings:   ~/.gpt-gateway/claude-settings.json                 │
└──────────────────────────────────────────────────────────────────┘
```

### 组件职责

| 组件 | 职责 |
|---|---|
| `cli` | `login/logout/status/serve/claude/models/doctor/env` 子命令 |
| `auth/oauth` | 浏览器 PKCE、手动粘贴、device code、state/CSRF 校验 |
| `auth/store` | token 持久化、原子写、权限、Codex 登录导入 |
| `auth/token-manager` | 过期前刷新、并发锁、401 重试一次 |
| `anthropic/translate-request` | 消息/系统提示/工具/图片/thinking 映射 |
| `anthropic/translate-stream` | Responses SSE → Anthropic SSE 状态机 |
| `upstream/codex-client` | 请求头、端点、错误映射、取消与超时 |
| `server` | 路由、本地 Bearer 校验、请求 ID、日志脱敏 |
| `models` | 模型目录、tier 映射、fallback、上下文限制 |

---

## 4. 认证设计

### 4.1 两种登录方式

1. **浏览器 PKCE（默认）**
   - 本机监听 `127.0.0.1:1455`（被占用则 1457）；
   - 打开 `auth.openai.com/oauth/authorize`；
   - 回调校验 `state`，用 `code + code_verifier` 换 token；
   - 若回调不可达：提示用户粘贴完整回调 URL 或 `code#state`。

2. **Device Code（无浏览器/远程环境）**
   - 请求 user code，展示 `https://auth.openai.com/codex/device` 与 8 位码；
   - 每 `interval` 秒轮询，403/404 视为 pending，最多 15 分钟；
   - 成功后用返回的 `authorization_code + code_verifier` 换 token。

### 4.2 Token 存储

`~/.gpt-gateway/auth.json`（不直接写 `~/.codex/auth.json`）：

```json
{
  "version": 1,
  "provider": "openai-chatgpt",
  "account_id": "…",
  "plan_type": "plus|pro|…",
  "email": "…",
  "access_token": "…",
  "refresh_token": "…",
  "id_token": "…",
  "expires_at": 1730000000000,
  "last_refresh": "2026-10-19T…Z",
  "originator": "codex_cli_rs"
}
```

- POSIX：`chmod 600`；Windows：`icacls` 仅当前用户可读。
- 写入使用临时文件 + rename，避免半写。
- 日志绝不打印 token；错误信息中的 token 做脱敏。

### 4.3 Token 刷新

```
now >= expires_at - 5min
  → 单飞刷新（同进程 mutex + 文件锁）
  → POST /oauth/token (grant_type=refresh_token)
  → 成功：更新 access/refresh/expires_at，原子写
  → invalid_grant / 401：标记需要重新登录
  → 网络错误：保留旧 token，返回 503 并提示重试
```

上游请求遇到 401 时：强制刷新一次并重放；仍失败则返回 Anthropic 格式错误。

### 4.4 与现有 Codex CLI 登录的关系（重要）

本机 `~/.codex/auth.json` 已有 ChatGPT 登录。三种复用策略：

| 策略 | 行为 | 评价 |
|---|---|---|
| A. 独立登录（推荐默认） | 网关自己走一次 OAuth，拥有独立 refresh token | 与 Codex 互不影响，最稳 |
| B. 一次性导入 | `gpt-gateway login --import-codex` 复制当前 token | 上手最快；之后刷新可能和 Codex 发生 refresh token 竞争 |
| C. 共享读写 | 网关与 Codex 共用同一个 auth.json + 文件锁 | 最方便但最容易互相踩踏，不建议 |

实现上同时支持 A 和 B：默认 A；B 作为显式命令，并在文档中说明“导入后建议只用网关或只用 Codex 刷新”。
**不要**在后台自动刷新 Codex 的 refresh token。

---

## 5. API 转换层设计（核心难点）

### 5.1 请求字段映射

| Anthropic Messages | OpenAI Responses | 说明 |
|---|---|---|
| `system`（string / blocks） | `instructions` | 拼接所有 text block；忽略 `cache_control` |
| `messages[].role` | `input[]` item role | user/assistant |
| 文本 block | `input_text` / `output_text` | user 用 `input_text`，assistant 用 `output_text` |
| `image` block | `input_image` + data URL | base64 直接转；URL 透传 |
| `tool_use` | `function_call` item | `call_id=id`, `arguments=JSON.stringify(input)` |
| `tool_result` | `function_call_output` item | `call_id=tool_use_id`；内容序列化为字符串 |
| `thinking` / `redacted_thinking` | `reasoning` item | 见 5.5；v1 可先丢弃 |
| `tools[].input_schema` | `tools[].parameters` | `type:function`, `strict:false` |
| `tool_choice` | `tool_choice` | `auto`→`auto`，`any`→`required`，`tool`→`{type:function,name}` |
| `max_tokens` | `max_output_tokens` | 按模型上限 clamp |
| `temperature` / `top_p` | 同名 | 推理模型可省略，避免上游拒绝 |
| `stop_sequences` | 无直接对应 | 网关侧截断（可选） |
| `metadata.user_id` | `prompt_cache_key` | 或使用会话 ID，保持稳定以命中缓存 |
| `thinking.budget_tokens` | `reasoning.effort` | `<2k low, <8k medium, <24k high, ≥24k xhigh`；`summary:"auto"` |
| `stream` | 上游恒 `true` | 非流式请求由网关聚合 |

必须从上游请求中剥离的字段：`cache_control`、`anthropic-beta` 相关、`top_k`、
Claude Code 专有 metadata、未知 block 类型。

### 5.2 工具调用（决定 Agent 是否可用）

Claude Code 的核心工具（Read/Write/Edit/Bash/Glob/Grep/TodoWrite/Task/WebFetch/WebSearch/MCP）
都是普通 function tool。转换要点：

1. 工具名保持原样（`mcp__server__tool` 这类下划线命名在 Responses 中合法）；
2. `strict: false`，避免 Claude Code 的 JSON Schema 不满足 OpenAI strict 模式；
3. 流式工具参数：
   - `response.output_item.added`（function_call）→ 记录 `call_id` / `name` / `output_index`；
   - `response.function_call_arguments.delta` → Anthropic `input_json_delta`；
   - `response.output_item.done` → 用完整 `arguments` 校正（防止 delta 丢失）；
4. 多轮：Claude Code 会把 `tool_use`（含 `id`）和 `tool_result`（含 `tool_use_id`）回传，
   网关分别映射为 `function_call` / `function_call_output`，`call_id` 必须一致；
5. 同一轮多个工具调用：保持 `parallel_tool_calls: true`，按 `output_index` 分发。

### 5.3 流式状态机

上游 Responses SSE（关键事件）：

```
response.created
response.in_progress
response.output_item.added
response.content_part.added
response.output_text.delta
response.reasoning_summary_text.delta
response.function_call_arguments.delta
response.output_item.done
response.completed / response.incomplete / response.failed
error
```

转换为 Anthropic SSE：

```
message_start
  content_block_start (text)       ── output_text.delta → content_block_delta(text_delta)
  content_block_stop
  content_block_start (tool_use)   ── function_call_arguments.delta → input_json_delta
  content_block_stop
message_delta (stop_reason, usage)
message_stop
```

规则：

- 每个 SSE 帧同时写 `event: <type>` 与 `data: <json>`，帧间空行；
- 每 15 秒写 `event: ping`，防止代理/终端超时；
- 文本和工具块可交错，用 `output_index` 维护独立的 content block index；
- `response.completed` 时根据是否存在 `function_call` 决定 `stop_reason`：
  - 有工具调用 → `tool_use`
  - 达到 `max_output_tokens` → `max_tokens`
  - 其他 → `end_turn`
- 客户端断开（Ctrl+C）→ `AbortController.abort()` 取消上游 fetch，避免继续消耗额度。

### 5.4 用量映射

| Responses | Anthropic |
|---|---|
| `usage.input_tokens` | `input_tokens`（可减去 cached） |
| `usage.output_tokens` | `output_tokens` |
| `usage.input_tokens_details.cached_tokens` | `cache_read_input_tokens` |
| `usage.output_tokens_details.reasoning_tokens` | 忽略或并入 output |
| `cache_creation_input_tokens` | 无对应，置 0 |

Claude Code 用这些值显示上下文占用；允许有少量误差。

### 5.5 思考/推理内容的保真（v1 可降级）

Responses 在 `store:false` 时需要回传 `reasoning` item（含 `encrypted_content`）才能完整保留推理链。
Claude Code 会把 assistant 的 `thinking` block（含 `signature`）原样回传。

推荐做法（阶段 2）：

- 把上游 `reasoning` item 的 `encrypted_content` 编进 Anthropic `thinking.signature`；
- 下次收到该 `signature` 时还原成 `reasoning` item 放回 `input`；
- 同时可把 `reasoning_summary_text` 映射为 `thinking_delta`，让 TUI 显示思考摘要。

v1 可先丢弃历史 reasoning，仅在每次请求设置 `reasoning.effort`。功能可用，但长对话推理连续性略差、token 消耗略高。

### 5.6 其他端点

| 端点 | 行为 |
|---|---|
| `POST /v1/messages` | 主转换 |
| `POST /v1/messages/count_tokens` | 本地估算（CJK/英文混合 chars/3.5），返回 `{input_tokens}`；无需精确 |
| `POST /v1/messages/cache_touch` | 返回 200 `{}`（Claude Code 用于缓存保活） |
| `GET /v1/models` | 可选，返回配置的模型目录，便于调试 |
| `POST /v1/messages/batches` | 不支持，返回 404/400 |

### 5.7 v1 明确不支持

- `stop_sequences` 的严格语义（仅网关侧截断）；
- PDF/document block（先转文本或拒绝）；
- 服务端工具 `web_search_*` 的完整映射（可映射到 Responses `web_search`，阶段 2）；
- 精确 prompt cache 计费与 `cache_creation_input_tokens`；
- Claude Code 的 `context-1m` 等 Anthropic 专有 beta 语义。

---

## 6. Claude Code 接入方式

### 6.1 独立 settings（推荐）

生成 `~/.gpt-gateway/claude-settings.json`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "<32-byte-random-hex>",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-6.1-sol",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-6.1-sol",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-6-luna",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "gpt-6-astra",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "GPT-6 Sol",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "GPT-6.1 Sol",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "GPT-6 Luna",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": "GPT-6 Astra",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "272000",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "64000",
    "API_TIMEOUT_MS": "600000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

> 该文件由 `gpt-gateway claude` 自动生成；本地 token 随机生成，每次重装可轮换。

启动：

```bash
gpt-gateway claude            # 自动启动网关 + claude --settings ...
gpt-gateway claude --resume   # 其余参数透传
```

或手动：

```bash
gpt-gateway serve
claude --settings ~/.gpt-gateway/claude-settings.json
```

这样默认的 `claude` 仍然使用 Anthropic 登录，只有通过 wrapper 启动的会话走 GPT。

### 6.2 为什么用 `--settings` 而不是全局环境变量

Claude Code 2.1.x 对自定义 endpoint 有安全策略检查（`allowedProviders` / managed settings）。
把 `ANTHROPIC_BASE_URL` 放进 settings 的 `env` block 可以“pin”该地址，避免被判定为不安全来源；
同时不会影响你平时直接运行 `claude`。

若机器上有企业 managed settings 且设置了 `allowedProviders`，需要额外加入 `"customEndpoint"`；
个人环境一般不需要。

### 6.3 首次运行的交互

- Claude Code 可能提示 “Detected a custom API key in your environment”，选择一次 yes 即可；
- 若出现 “custom ANTHROPIC_BASE_URL” 警告，确认 settings 中已 pin；
- 启动后 `/status` 应显示自定义 base URL 与模型名。

### 6.4 模型层级映射

| Claude Code tier | 默认 GPT 模型 | 用途 |
|---|---|---|
| `opus` | `gpt-6.1-sol` | 主对话/复杂编码 |
| `sonnet` | `gpt-6.1-sol` | 日常任务 |
| `haiku` | `gpt-6-luna` | 后台小任务、标题、分类 |
| `fable` | `gpt-6-astra` | 最强推理/架构 |

所有映射写在配置文件里，可通过 `gpt-gateway models` 查看/修改。
网关对未知模型名做前缀映射（`claude-*opus*` → opus tier 等），保证 Claude Code 内部兜底调用也能落到有效模型。

上下文：Codex 默认运行时上下文约 272k；先用 `CLAUDE_CODE_MAX_CONTEXT_TOKENS=272000`，
若确认模型支持更大再提高，避免 Claude Code 把超长上下文直接发给上游导致 400。

---

## 7. 工程结构

```
gpt-gateway/
├─ package.json
├─ tsconfig.json
├─ README.md
├─ PLAN.md
├─ src/
│  ├─ cli.ts                 # 子命令入口
│  ├─ config.ts              # 路径、端口、模型映射
│  ├─ server.ts              # HTTP 路由 + 本地鉴权
│  ├─ auth/
│  │  ├─ oauth-browser.ts    # PKCE + 回调服务器 + 手动粘贴
│  │  ├─ oauth-device.ts     # device code
│  │  ├─ token-store.ts      # 原子读写 / 权限 / 导入 Codex
│  │  └─ token-manager.ts    # 刷新 + 单飞锁
│  ├─ anthropic/
│  │  ├─ types.ts
│  │  ├─ request.ts          # Messages → Responses
│  │  ├─ stream.ts           # Responses SSE → Anthropic SSE
│  │  ├─ tools.ts
│  │  └─ errors.ts
│  ├─ upstream/
│  │  ├─ codex-client.ts
│  │  └─ sse-parser.ts
│  └─ models.ts
└─ test/
   ├─ fixtures/              # 真实 Claude Code 请求样本（脱敏）
   ├─ request.test.ts
   ├─ stream.test.ts
   └─ e2e.test.ts
```

- 运行时零/极少依赖：Node 内置 `http`、`fetch`、`crypto`、`ReadableStream`；
- 开发依赖：`typescript`、`tsx`、`@types/node`（可选 vitest，或直接用 `node:test`）；
- 打包：`tsup`/`esbuild` 生成单文件 `dist/cli.js`，npm `bin` 暴露 `gpt-gateway`；
- Windows 下 npm 自动生成 `.cmd` shim。

---

## 8. 里程碑与验收

### M0 协议探针（0.5 天）
- 实现一个 echo server，记录 Claude Code 实际发出的 `/v1/messages` 请求；
- 用现有 `~/.codex/auth.json` 的 access token 手工调用一次上游 `/responses`（最小 prompt）；
- 验收：拿到真实的上游 SSE 样本和 Claude Code 请求样本。

### M1 认证（1 天）
- 浏览器 PKCE + 手动粘贴 + device code；
- token 存储/刷新/`status`/`logout`；
- `--import-codex`；
- 验收：`gpt-gateway login` 能在本机完成并显示 plan/account；刷新后仍可用。

### M2 文本流式对话（1 天）
- `/v1/messages` 流式 + 非流式；
- 文本 delta、usage、stop_reason、ping；
- `gpt-gateway claude` 启动；
- 验收：Claude Code 能进行普通问答，Ctrl+C 能中断。

### M3 工具调用（1–2 天）
- tool_use / tool_result 多轮映射；
- 并行工具调用、参数流式；
- 验收：Claude Code 能完成 “读文件 → 修改 → 运行测试” 的完整闭环。

### M4 稳定性与兼容（1 天）
- count_tokens / cache_touch；
- 401 刷新重试、429/5xx 错误映射、超时；
- 模型映射与 fallback、上下文限制；
- 日志脱敏、请求 ID；
- 验收：错误场景返回可读的 Anthropic 错误；长时间会话稳定。

### M5 收尾（0.5–1 天）
- README、Windows 安装说明、故障排查；
- 单测 + 端到端测试；
- 可选：reasoning signature 保真、web_search 映射、多账号。

总计约 5–7 个工作日（不含不可控的上游协议变更）。

---

## 9. 测试计划

1. **转换单测**：用脱敏后的真实 Claude Code 请求做 fixture，断言 Responses 请求 JSON；
2. **流式单测**：喂入录制好的上游 SSE，断言 Anthropic SSE 序列（文本、工具、错误、截断）；
3. **Mock 上游集成**：本地假 `/responses` 返回固定事件，跑完整 HTTP；
4. **E2E**：
   - `claude -p "hello"`；
   - 让 Claude 读一个文件并回答；
   - 让 Claude 修改文件并运行 `node -e`；
   - 子代理（Task）调用；
   - 中文/英文混合、长上下文；
5. **故障注入**：401、429、500、流中断、客户端取消、token 过期；
6. **安全**：非 localhost 拒绝、错误 token 拒绝、日志无敏感信息。

---

## 10. 安全与合规

- 网关只绑定 `127.0.0.1`；本地 API 使用随机 Bearer token；
- OAuth 使用 PKCE + state，防 CSRF；device code 提示用户不要分享代码；
- token 文件最小权限；日志脱敏；
- **重要**：`chatgpt.com/backend-api/codex` 是未公开、未承诺稳定的接口。
  使用 ChatGPT 订阅凭据在非官方客户端中调用，可能违反 OpenAI 服务条款，
  存在账号被限流/封禁的风险。请自行评估并优先使用自己的订阅与合理用量。
- 本项目与 OpenAI、Anthropic 均无关联。

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 上游协议变更/封禁 | 网关突然不可用 | 协议集中在 `upstream/` 与 `auth/`；可配置 base URL/headers；保留 Codex CLI 作为对照 |
| refresh token 竞争 | Codex 或网关掉登录 | 默认独立登录；导入模式明确告知；文件锁 + 单飞刷新 |
| Claude Code 安全策略拦截 | 自定义 base URL 被拒 | `--settings` env pin；必要时 `allowedProviders: ["customEndpoint"]` |
| 工具调用不保真 | Agent 无法编辑/执行 | M3 专项测试；以 `output_item.done` 的完整参数为准 |
| reasoning 丢失 | 长对话质量下降 | 阶段 2 用 signature 保存 encrypted_content |
| 上下文窗口不匹配 | 400/截断 | `CLAUDE_CODE_MAX_CONTEXT_TOKENS=272000`；按模型配置 |
| 429 限流 | 会话中断 | 返回带 `retry-after` 的 Anthropic 错误；不做无限重试 |
| Windows 回调/端口 | 登录失败 | 1455→1457→手动粘贴→device code 四级兜底 |
| WebSearch 服务端工具 | 搜索不可用 | 阶段 2 映射 Responses `web_search`；否则退回 WebFetch |

---

## 12. 已确认的决策

1. **认证策略**：独立 OAuth 为主 + 一次性导入现有 Codex 登录（`login --import-codex`）。
2. **技术栈**：Node 24 + TypeScript，零运行时依赖。
3. **模型映射**：opus→`gpt-6.1-sol`，sonnet→`gpt-6.1-sol`，haiku→`gpt-6-luna`，fable→`gpt-6-astra`。
4. **启动方式**：`gpt-gateway claude` wrapper + 每次运行独立的临时 settings 文件。

---

## 13. 实现状态（2026-10-19）

已实现并通过本机验证：

- `src/auth/oauth.ts`：浏览器 PKCE（1455/1457 回调 + 手动粘贴）、device code、token 交换与刷新；
- `src/auth/token-manager.ts`：过期检查、单飞刷新、401 重试；导入的 Codex token 不刷新；
- `src/upstream/sse.ts`：支持分块、CRLF、多行 data、UTF-8 跨块的 SSE 解析；
- `src/upstream/codex-client.ts`：`/responses` 请求、必要的 ChatGPT 头、错误映射；
- `src/translate/request.ts`：Anthropic → Responses 的 system/messages/image/tool/tool_choice/thinking 映射；
- `src/translate/stream.ts`：Responses SSE → Anthropic SSE（文本、tool_use 参数流、usage、错误、stop_reason）；
- `src/server.ts`：`/v1/messages`、`count_tokens`、`cache_touch`、`/health`、`/v1/models`、本地 Bearer 鉴权、取消传播；
- `src/cli.ts`：`login/logout/status/serve/claude/models/env/init/doctor`；
- 测试：16 个单元测试（SSE、请求翻译、`output_config.effort` 映射、流式状态机）全部通过。

本机验证结果：

- `login --import-codex` 成功读取现有 Codex 登录（plan=plus）；
- `doctor --live` 真实调用上游并收到 `OK`；
- 直接用 curl 验证了流式文本、非流式、tool_use 参数流、tool_result 多轮回放；
- `gpt-gateway claude -p ...` 与带 Bash 工具的 Claude Code 打印模式均成功。

尚未验证/未实现：

- 独立 OAuth 的完整交互登录（需要人工在浏览器完成；代码路径已就绪）；
- reasoning（thinking）保真：当前丢弃历史 thinking，不向前端暴露推理摘要；
- 并行工具调用、`web_search` 等服务端工具映射；
- 429/5xx 的自动重试（仅返回结构化错误，不做无限重试）；
- npm 包发布与自动更新。