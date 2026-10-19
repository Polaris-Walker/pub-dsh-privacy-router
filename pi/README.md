# Pi Privacy Router

[Pi](https://github.com/badlogic/pi-mono) coding agent 的隐私关口扩展。在同一个 Pi 会话里，根据本地隐私检查自动选择本地模型（如 Ollama）或云端全量 API；敏感请求可以选择**糊名后**再发往云端，云端回复在本地还原。

它是根目录 DSH 版本的 Pi 移植，核心原则不变：**拿不准就留在本地**。

## 工作方式

扩展注册一个虚拟模型 `privacy-router/auto`。在 Pi 里选中它之后，每次模型调用都经过路由：

```text
用户请求
  -> ① 本地确定性规则（私钥 / Token / 密码 / 邮箱 / 电话 / 家目录路径 / 自定义敏感词）
  -> ② 本地小模型分类：public / sensitive / unknown，并列出需要遮盖的实体
  -> public                        → 云端模型（默认无工具、固定系统提示词）
  -> sensitive 且可糊名（需开启）   → 🎭 糊名后发云端，回复在本地还原
  -> sensitive / unknown / 失败     → 🔒 本地模型处理原始请求（带 Pi 全部工具）
```

- 同一用户 Turn 内的工具续步复用第一次判定，不会重复分类。
- 分类失败、分类模型缺失、图片输入、超出 `maxPromptBytes` 的请求全部留在本地。
- Pi 的上下文压缩（compaction）和分支摘要会序列化整段对话，始终交给本地模型，不做分类。
- 云端只看到**已批准云端的 Turn**；被判为本地的 Turn 永远不会出现在云端上下文里。

### 糊名（masking）

```text
原文:   给王五 (wangwu@corp.cn) 写封信，说 Orion 项目延期
云端看到: 给⟦PRIVATE_1⟧ (⟦EMAIL_1⟧) 写封信，说 ⟦PRIVATE_2⟧ 项目延期
云端回复: ⟦PRIVATE_1⟧您好，关于 ⟦PRIVATE_2⟧ 项目……
你看到:  王五您好，关于 Orion 项目……
```

- 占位符映射只保存在本进程内存中，同一会话内稳定：同一个值始终对应同一个占位符。
- 实体来源有三类：确定性规则、自定义敏感词、本地分类器给出的 `entities`。分类器给出的实体必须在原文中逐字出现才会被采用。
- 糊名后会再跑一遍规则；仍有命中（不含占位符本身）就退回本地。分类器判定 `maskable: false` 时（敏感的是内容本身，例如机密代码或业务逻辑）也退回本地。
- 流式还原会缓存被拆到两个 chunk 之间的占位符；工具调用参数会在 Pi 执行前还原。
- 一旦某个值被糊名过，之后所有云端请求都会继续遮盖它。凭证类（私钥、Token、密码等）在**任何**云端请求中都会被遮盖，包括手动放行。

## 安装

```sh
pi install /absolute/path/to/pub-dsh-privacy-router/pi
# 或临时试用
pi -e /absolute/path/to/pub-dsh-privacy-router/pi
```

启动后用 `/model` 选择 `privacy-router/auto`。

默认本地模型是 `http://localhost:11434/v1` 上的 Ollama `qwen2.5:7b`，扩展会自动注册为 `privacy-local/qwen2.5:7b`；默认云端是 Pi 内置的 `deepseek/deepseek-v4-flash`，需要先配好 `DEEPSEEK_API_KEY`（或用 `/login`）。

## 配置

配置文件：`~/.pi/agent/privacy-router.json`（遵循 `PI_CODING_AGENT_DIR`），也可用 `PI_PRIVACY_ROUTER_CONFIG` 指定路径。**不读取项目目录下的配置**，避免克隆来的仓库削弱隐私关口。字段写错会直接报错。

```json
{
  "local": { "baseUrl": "http://localhost:11434/v1", "model": "qwen2.5:7b" },
  "cloud": { "provider": "anthropic", "model": "claude-sonnet-4-5" },
  "cloudTools": "none",
  "sensitiveRoute": "local",
  "sensitiveTerms": ["Orion", "内部代号"]
}
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `local` | Ollama `qwen2.5:7b` | `{ baseUrl, model, apiKey?, contextWindow?, maxTokens? }` 由扩展注册任意 OpenAI 兼容本地端点（vLLM、LM Studio、llama.cpp…）；或 `{ provider, model }` 引用 Pi `models.json` 里已有的本地模型 |
| `classifier` | 同 `local` | `{ provider, model }`，可单独指定一个更小的分类模型 |
| `cloud` | `deepseek/deepseek-v4-flash` | `{ provider, model }`，任意 Pi 已配置的云端模型 |
| `cloudTools` | `"none"` | `"none"`：云端不给工具（方案 A，最安全）；`"masked"`：云端可用工具，全部上下文（含系统提示词、工具结果）糊名后发送（方案 B） |
| `sensitiveRoute` | `"local"` | 自动模式下 sensitive 的去向：`"local"` 或 `"mask"`（可糊名时糊名发云端） |
| `defaultMode` | `"auto"` | 启动模式：`"auto"` 或 `"local"` |
| `privacyPolicy` | 内置策略 | 交给本地分类器的隐私定义 |
| `sensitiveTerms` | `[]` | 大小写不敏感的额外敏感词，命中即视为敏感，糊名时会被遮盖 |
| `maxPromptBytes` | `32768` | 本轮文本和分类上下文的 UTF-8 总大小 |
| `classifierMaxTokens` | `512` | 分类输出上限 |
| `cloudMaxTokens` | `8192` | 云端回复输出上限 |
| `contextWindow` | 本地模型的窗口 | 虚拟模型对 Pi 报告的上下文窗口，影响 Pi 何时压缩 |

## 切换器：`/privacy`

| 命令 | 效果 |
| --- | --- |
| `/privacy` | 显示当前模式和本地 / 云端模型 |
| `/privacy auto` / `/privacy local` | 切换常驻模式 |
| `/privacy mask` | **下一轮**强制糊名后发云端（分类器失败或糊名不完整仍会退回本地） |
| `/privacy cloud` | **下一轮**跳过分类，直接放行到云端（凭证仍会被遮盖） |
| `/privacy mask sticky` / `/privacy cloud sticky` | 常驻，直到切回 `auto` / `local` |
| `/privacy retry cloud` / `retry mask` / `retry local` | 把上一个问题用指定路线重新发一次。本地答得不好时，用它升级到云端 |

`cloud` 和 `mask` 默认只作用一轮，避免放行状态被遗忘。状态栏会显示每一轮的实际路线：🔒 local / ☁️ cloud / 🎭 masked→cloud。

## 会话记录

每轮判定会以 `privacy-router` 自定义条目写入 Pi 会话，只包含路线、分类、方法、理由、模型、耗时和被遮盖实体的**数量**，不复制正文或实体值。这些条目不会进入模型上下文。

恢复会话（`/resume`）时，只恢复 public 的云端批准；糊名映射只在内存里，所以之前糊名过的 Turn 在恢复后不再发往云端。

## 安全说明

- `public` 是本地规则和小模型的判定，不是绝对证明；`unknown → local` 用来降低误放行。
- 糊名做不到 100%：模型可能漏掉实体，代码里的业务逻辑本身无法替换成占位符。所以 `sensitiveRoute` 默认为 `local`，`cloudTools` 默认为 `none`。
- `cloudTools: "masked"` 会把项目系统提示词（含 AGENTS.md）和工具结果糊名后发往云端，遮盖范围限于规则、敏感词和已知实体，开启前请评估。
- 隐私关口只对 `privacy-router/auto` 生效。直接选其他云端模型会绕过它，扩展会给出警告。
- 扩展只路由 Pi 主 Agent 的模型调用，不拦截其他扩展自行发起的网络请求。
- 本地会话文件保存完整对话，应按敏感数据处理。

## 开发

```sh
npm install
npm run typecheck
npm test
```

测试使用 `@mariozechner/pi-ai` 的 faux provider 模拟本地和云端模型，覆盖路由、糊名、流式还原、工具续步、历史隔离和压缩请求。
