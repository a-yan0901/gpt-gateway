# gpt-gateway

在 Claude Code CLI 里使用 ChatGPT 订阅（Plus / Pro）模型。

网关在本地实现 Anthropic Messages API，把请求翻译成 ChatGPT Codex 后端的 Responses API，
再把流式响应翻译回 Anthropic SSE。Claude Code 无需修改，工具调用、流式输出、多轮对话都能工作。

```text
Claude Code --(Anthropic API)--> gpt-gateway --(Responses API)--> chatgpt.com/backend-api/codex
```

> 非官方方案。`chatgpt.com/backend-api/codex` 是未公开接口，可能随上游变更而失效；
> 使用订阅凭据调用也可能触及 OpenAI 服务条款。请自行评估账号风险，合理使用。

## 环境要求

- Node.js >= 22.19（推荐 24）
- Claude Code CLI 已安装（`claude --version` 可用）

## 安装

### 从 GitHub 全局安装（推荐）

```bash
npm install -g --install-links git+https://github.com/a-yan0901/gpt-gateway.git
gpt-gateway --version
```

`--install-links` 会让 npm 打包安装，而不是创建一个指向缓存临时目录的软链
（npm 11 在 Windows 上直接安装 git 依赖时有这个问题）。

> npm registry 上的 `gpt-gateway` 是另一个无关的 0.0.1 包，因此目前不要用
> `npm install -g gpt-gateway`，请使用上面的完整 Git 地址。

### 从源码开发

```bash
git clone https://github.com/a-yan0901/gpt-gateway.git
cd gpt-gateway
npm install
npm run build
npm link        # 或 node dist/cli.js ...
```

## 登录

### 方式 A：复用现有 Codex 登录（最快）

如果你已经在本机登录过 Codex CLI：

```bash
gpt-gateway login --import-codex
gpt-gateway status
```

导入的令牌**不会被网关刷新**，避免和 Codex CLI 争抢 refresh token。
access token 过期后，重新执行一次导入，或改用方式 B。

### 方式 B：独立 OAuth（推荐长期使用）

```bash
gpt-gateway login
```

- 默认打开浏览器，回调监听 `http://localhost:1455/auth/callback`，端口占用时自动尝试 1457；
- 浏览器无法回调时，按提示把完整回调 URL 粘贴到终端；
- 无浏览器/远程机器：`gpt-gateway login --device`；
- 完全手动：`gpt-gateway login --manual`。

登录信息保存在 `~/.gpt-gateway/auth.json`（权限尽量收紧）。
独立登录会自行刷新 access token。

### 退出

```bash
gpt-gateway logout
```

## 使用

```bash
# 启动 Claude Code（网关随 Claude Code 一起启动/退出）
gpt-gateway claude

# 透传任意 Claude Code 参数
gpt-gateway claude --resume
gpt-gateway claude -p "解释这个仓库" --output-format text
```

每次启动都会：

1. 在随机本地端口启动网关；
2. 生成一份临时 `settings` 文件（含 `ANTHROPIC_BASE_URL`、本地随机 token、模型映射）；
3. 执行 `claude --settings <临时文件> ...`；
4. Claude Code 退出后关闭网关并删除临时文件。

这样不会污染全局 `~/.claude/settings.json`，也不会继承父进程里可能存在的
`ANTHROPIC_MODEL` / `ANTHROPIC_BASE_URL`。

临时 settings 里的 `ANTHROPIC_MODEL` 被显式设为空字符串。Claude Code 把空值当作“未设置”，
因此它会遵循 `/model` 的选择（以及用户 settings 里保存的 `model`），模型选择器、
状态栏和实际请求保持一致。网关只通过 `ANTHROPIC_DEFAULT_*_MODEL` 决定
`opus` / `sonnet` / `haiku` / `fable` 各对应哪个 GPT 模型。

### 其他命令

```bash
gpt-gateway status          # 登录状态、账号、套餐、模型映射
gpt-gateway status --json   # 机器可读
gpt-gateway models          # 层级映射
gpt-gateway serve           # 只启动网关（默认 127.0.0.1:8787）
gpt-gateway env             # 打印手动配置所需的环境变量
gpt-gateway init            # 写入默认配置与 settings
gpt-gateway doctor          # 自检
gpt-gateway doctor --live   # 自检并发一条真实请求
```

## 模型映射

| Claude Code 层级 | GPT 模型 |
|---|---|
| opus / 默认 | `gpt-6.1-sol` |
| sonnet | `gpt-6.1-sol` |
| haiku | `gpt-6-luna` |
| fable | `gpt-6-astra` |

会话内用 `/model` 切换层级即可；wrapper 启用了网关模型发现
（`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`），所以 `/model` 列表里也能直接选
`gpt-6.1-sol` / `gpt-6-luna` / `gpt-6-astra`。用 `/model` 保存的默认值对下次启动同样生效。

修改 `~/.gpt-gateway/config.json` 的 `models` 字段，或用环境变量：

```bash
GPT_GATEWAY_MODEL_OPUS=...   # 见 config.ts 中的完整列表
```

更常见的做法是编辑：

```json
{
  "models": {
    "opus": "gpt-6.1-sol",
    "sonnet": "gpt-6.1-sol",
    "haiku": "gpt-6-luna",
    "fable": "gpt-6-astra"
  },
  "contextWindow": 272000,
  "textVerbosity": "low"
}
```

## 思考强度（effort）

进入 Claude Code 后，`/model` 只负责选择模型层级（opus/sonnet/haiku/fable），
**调整思考强度要用 `/effort`**，或者启动时传 `--effort`：

```bash
gpt-gateway claude --effort high
# 会话内：
/effort low | medium | high | xhigh | max
```

Claude Code 会把当前强度放在请求的 `output_config.effort` 字段里。网关按下面的规则
转成 Responses API 的 `reasoning.effort`：

| Claude Code effort | 上游 `reasoning.effort` |
|---|---|
| `low` / `medium` / `high` / `xhigh` / `max` | 原样透传 |
| `auto`（未显式设置） | 回退到 `thinking.budget_tokens` 映射或配置值 |

可用 `GPT_GATEWAY_REASONING_EFFORT=high` 设置一个固定默认值。

## 已实现

- 浏览器 PKCE、device code、手动回调粘贴；
- 独立 token 的单飞刷新、401 后重试；
- Anthropic → Responses：system、文本、图片、工具定义、`tool_choice`、`output_config.effort` / thinking→reasoning effort；
- Responses → Anthropic：文本流、tool_use 参数流、usage、stop_reason、错误；
- `/v1/messages`、`/v1/messages/count_tokens`、`/v1/messages/cache_touch`、`/health`、`/v1/models`；
- 本地 Bearer / `x-api-key` 鉴权，只绑定 `127.0.0.1`；
- 客户端取消传播到上游请求。

## 已知限制

- 历史 `thinking` 块会被丢弃，不向前端显示推理摘要（Anthropic thinking 需要签名）。
- 暂不映射 OpenAI 服务端工具（如 `web_search`）；Claude Code 的客户端工具正常。
- 429/5xx 只返回结构化错误，不做自动重试。
- 上游模型名必须与账号可用模型一致；错误会原样以 Anthropic 错误格式返回。
- 导入的 Codex token 不刷新。

## 故障排查

**Claude Code 输出 `[claude-code:unrecognized_model]`**

无害。Claude Code 不认识 `gpt-6-*` 名称，但仍会正常使用。模型能力上限通过
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 控制。

**`Codex upstream returned 401`**

登录失效。独立登录：重新 `gpt-gateway login`；导入模式：刷新 Codex 后重新
`gpt-gateway login --import-codex`。

**`The '<model>' model is not supported when using Codex with a ChatGPT account`**

请求里的模型名不是你的套餐可用的 GPT 模型。检查 `gpt-gateway models` 与配置。
如果使用 `gpt-gateway claude`，wrapper 会清空继承来的 `ANTHROPIC_MODEL`；
但用户 settings 里保存的 `model` 仍会生效，换成任一 `gpt-6-*` 模型或 Claude 层级即可。

**`/model` 切换到 luna 后，状态栏仍显示 sol**

旧版 wrapper 会把 `ANTHROPIC_MODEL` 固定为 `gpt-6.1-sol`，它优先级高于 `/model`
保存的默认值，因此状态栏和下次启动都会回到 sol。现在改为空字符串（视为未设置），
重新启动一次 `gpt-gateway claude` 后即可正常切换。状态栏本身只在下一条助手消息等
时机刷新，执行 `/model` 后需要发一条消息才会更新。

**自定义 endpoint 被 Claude Code 安全策略拦截**

确保是通过 `gpt-gateway claude`（或 `claude --settings ~/.gpt-gateway/claude-settings.json`）启动。
企业托管策略可能需要在 managed settings 中允许 `customEndpoint`。

**登录回调打不开**

使用 `gpt-gateway login --device`，或 `--manual` 后粘贴回调 URL。

**端口被占用**

`gpt-gateway serve --port 0` 使用随机端口；`gpt-gateway claude` 总是使用随机端口。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test 单元测试
npm run build       # tsup -> dist/cli.js
npm run dev -- ...  # tsx src/cli.ts ...
```

目录：

```text
src/auth/         OAuth、token 管理
src/upstream/     Codex 客户端、SSE 解析
src/translate/    Anthropic <-> Responses 请求/流翻译
src/server.ts     本地 Anthropic API
src/cli.ts        命令行与 Claude Code wrapper
test/             单元测试
PLAN.md           设计与风险分析
```