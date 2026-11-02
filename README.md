<img src="https://cdn.jsdelivr.net/npm/@dougen/dsh-deepseek-usage/icon.svg" alt="dsh-deepseek-usage icon" width="72" align="right" />

# dsh-deepseek-usage

[![npm version](https://img.shields.io/npm/v/@dougen/dsh-deepseek-usage)](https://www.npmjs.com/package/@dougen/dsh-deepseek-usage)
[![CI](https://github.com/dougen/dsh-deepseek-usage/actions/workflows/ci.yml/badge.svg)](https://github.com/dougen/dsh-deepseek-usage/actions/workflows/ci.yml)

<!-- GitHub and npm both prefix heading ids with `user-content-`, so the in-page anchor needs it -->
[中文文档](#user-content-中文文档)

A **DeepSeek Harness (DSH)** sidebar plugin that shows, right in the DSH main window, how much money or quota is left on the account behind the currently selected model, and what that model costs right now — without leaving DSH. It supports nine providers and a Chinese / English UI.

<img src="https://cdn.jsdelivr.net/npm/@dougen/dsh-deepseek-usage/screenshot.png" alt="The sidebar card: balance, current unit prices and the billing-window dot" width="520" />

*Balance mode (DeepSeek, Kimi, Z.ai, OpenRouter…): the account balance, the current model's input / cache / output unit prices, and the peak / off-peak indicator in the top-right corner.*

<img src="https://cdn.jsdelivr.net/npm/@dougen/dsh-deepseek-usage/screenshot2.png" alt="Subscription usage: remaining quota per billing window" width="520" />

*Subscription mode (Kimi For Coding, OpenCode, MiniMax, Claude Code / Codex…): one D-shaped gauge per usage window — the number in the middle is the remaining quota, the grey arc is what has been used, the green arc is what is left (red once 80% is used), and the badge names the window (`5H` = 5-hour, `7D` = weekly, `1M` = monthly).*

## What this plugin does

DSH lets you switch between many model providers, but each provider hides its account status on a different website. This plugin resolves the provider behind the model you have selected in DSH and puts a live status card for that account at the bottom of the sidebar:

- **Account reading.** Two forms, depending on what the provider offers:
  - *Balance providers* (DeepSeek, Moonshot / Kimi, Z.ai, OpenRouter) publish the account balance, so the card shows it with its currency symbol (`¥` / `$`).
  - *Subscription providers* (Kimi For Coding, OpenCode, MiniMax, Claude Code, OpenAI Codex) publish no balance, only usage windows. The card draws one gauge per window — 5-hour, weekly, monthly, whatever the endpoint returns — and shows how much of each quota remains, turning red once 80% is used.
  - The card always follows the selected model, so switching provider switches the reading; no per-provider setup beyond the credential.
- **Unit prices of the current model.** The card lists input, input-cache and output prices for the billing period in effect right now, in the provider's own currency. When a provider bills by time of day — DeepSeek's official peak / off-peak schedule (Mon–Fri 09:00–12:00 and 14:00–18:00 Beijing time is peak, evenings, weekends and holidays are off-peak) or OpenRouter's time-of-day pricing — an orange / green dot marks which window is active, and hovering it shows the time left until the next switch.
- **Reliable numbers.** It refreshes every 30 seconds, immediately on click and when the model changes. Until the first answer arrives it shows a placeholder (`—`) rather than a guess, and a model the price table does not cover gets no price at all. The interface follows the DSH language (Chinese / English) and light / dark theme.

> [!NOTE]
> GitHub Copilot, Google, Amazon Bedrock, Azure and other credential kinds this plugin deliberately does not handle will get a short reason in the card instead of a number.

## Installation and usage

**Step 1 — configure the provider's credential.** The plugin queries each provider with the key you already use for that provider: fill it on the **Models page in DSH**, or export it as an environment variable (`DEEPSEEK_API_KEY`, `MOONSHOTAI_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `KIMI_CODING_API_KEY`, `OPENCODE_API_KEY`, `MINIMAX_API_KEY`, …). The `deepseek-account` route is the exception: it needs no key — sign in to DeepSeek inside DSH and the card reads that account grant.

**Step 2 — install the plugin into the `web` profile:**

```sh
dsh plugin --profile web add @dougen/dsh-deepseek-usage
```

**Step 3 — restart `dsh web`** and open the URL it prints. The card sits at the bottom of the sidebar, below the Cordis panel button; click it to refresh right away.

<details>
<summary>Using a Claude Code / OpenAI Codex subscription (OAuth)</summary>

An API key cannot read these subscriptions — they share an OAuth token instead. When DSH detects Claude Code or OpenAI Codex (or a provider mapping targets one of them), a token field appears on the plugin's own page (**Plugins → @dougen/dsh-deepseek-usage**), under the provider mappings. Paste the token there and the sidebar card starts reporting that subscription's remaining quota:

- **Claude Code** — on a machine signed in to Claude Code, copy `claudeAiOauth.accessToken` from `~/.claude/.credentials.json` (on macOS: the `Claude Code-credentials` keychain item). A token minted by `claude setup-token` also works.
- **OpenAI Codex** — copy `tokens.access_token` from `~/.codex/auth.json` into the token field, and `tokens.account_id` into the account ID field.

Tokens are stored through DSH's credential service (`~/.dsh/.credentials.yaml`) and never leave this machine: no response, log line or page element carries one back. The **Clear** button removes them again.
</details>

<details>
<summary>Uninstall</summary>

```sh
dsh plugin --profile web remove @dougen/dsh-deepseek-usage
```

Then restart `dsh web`.
</details>

## Supported DSH versions

Use a plugin version that matches your DSH:

| DSH version | Plugin version to install |
| --- | --- |
| `0.2.x` (from `0.2.0-rc.1` on) | `0.11.0` or later |
| `0.1.x` (from `0.1.0-rc.6` on) | `0.10.x`, or `0.11.0` or later |

Run `dsh --version` to check your DSH version. Installing without an explicit version picks the newest compatible release automatically; if the newest release does not match your DSH, pin an exact one, e.g. `@dougen/dsh-deepseek-usage@0.10.2`.

---

## 中文文档

一个 **DeepSeek Harness（DSH）** 的侧边栏插件：在 DSH 主界面就能看到**当前选中模型背后的账户还剩多少钱 / 多少额度**、**这个模型此刻什么价**。覆盖九家提供商，界面支持中文与英文。

### 这个插件是干嘛的

DSH 可以切换很多家模型提供商，但每家的账户状况藏在不同的网站后台。这个插件会解析你在 DSH 里当前选中的模型属于哪家提供商，把那个账户的实时状态卡片放进 DSH 主界面侧边栏底部：

- **账户读数**，按提供商公开的内容分两种形态：
  - *余额类*（DeepSeek、Moonshot / Kimi、智谱 Z.ai、OpenRouter）公开账户余额，卡片直接显示带币种符号（`¥` / `$`）的余额。
  - *订阅类*（Kimi For Coding、OpenCode、MiniMax、Claude Code、OpenAI Codex）没有余额可查，只公开用量窗口。卡片按接口返回的窗口各画一个仪表盘——5 小时、周、月，返回几个画几个——显示每份额度还剩多少，已用达到 80% 时剩余弧变红。
  - 卡片始终跟随当前选中的模型，切换提供商即切换读数；除凭据外不需要针对某家提供商再做任何配置。
- **当前模型的单价**。卡片列出输入 / 输入缓存 / 输出的单价，按此刻生效的计费时段取值，币种跟该提供商保持一致。有的提供商按时段计价——DeepSeek 官方峰谷（北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰，夜间、周末、节假日为空闲）或 OpenRouter 的分时定价——卡片会用一枚橙 / 绿指示灯标出当前时段，悬浮可见距下次切换还剩多久。
- **数字可靠**。每 30 秒自动刷新，点击卡片或切换模型时立即刷新。第一次响应回来之前显示占位符 `—`，不猜数；价格表未收录的模型干脆不显示价格。界面跟随 DSH 语言（中文 / 英文）与明暗主题。

> [!NOTE]
> GitHub Copilot、Google、Amazon Bedrock、Azure 等本插件有意不处理的凭据形态，卡片上会写明原因而不是给一个数字。

### 如何安装和使用

**第 1 步——配置提供商的凭据。** 插件用你给该提供商配的那把 Key 查询：在 DSH 设置的**模型页**填好，或导出为环境变量（`DEEPSEEK_API_KEY`、`MOONSHOTAI_API_KEY`、`ZAI_API_KEY`、`OPENROUTER_API_KEY`、`KIMI_CODING_API_KEY`、`OPENCODE_API_KEY`、`MINIMAX_API_KEY` 等）。`deepseek-account` 是例外：它不需要密钥——在 DSH 里登录 DeepSeek 账号即可，卡片读的是登录留下的授权。

**第 2 步——把插件装进 `web` profile：**

```sh
dsh plugin --profile web add @dougen/dsh-deepseek-usage
```

**第 3 步——重启 `dsh web`**，打开它打印的地址。卡片位于侧边栏底部、Cordis 面板按钮下方；点击卡片可立即刷新。

<details>
<summary>使用 Claude Code / OpenAI Codex 订阅（OAuth）</summary>

API Key 读不到这两种订阅——它们走 OAuth 令牌。当 DSH 检测到 Claude Code 或 OpenAI Codex（或有映射目标指向其中之一），插件详情页（**Plugins → @dougen/dsh-deepseek-usage**）的提供商映射下方会出现令牌填写框。把令牌粘贴进去，侧边栏卡片即可开始显示该订阅的余量：

- **Claude Code**——在已登录 Claude Code 的机器上，从 `~/.claude/.credentials.json` 复制 `claudeAiOauth.accessToken`（macOS 在钥匙串项 `Claude Code-credentials` 里）。`claude setup-token` 产生的令牌也能用。
- **OpenAI Codex**——从 `~/.codex/auth.json` 复制 `tokens.access_token` 填进令牌框，`tokens.account_id` 填进账号 ID 框。

令牌经 DSH 的凭据服务保存在本机（`~/.dsh/.credentials.yaml`），任何响应、日志、页面元素都不会把它带出去；点**清除**按钮即可删除。
</details>

<details>
<summary>卸载</summary>

```sh
dsh plugin --profile web remove @dougen/dsh-deepseek-usage
```

然后重启 `dsh web`。
</details>

### 支持的 DSH 版本

插件版本要与 DSH 版本相配：

| DSH 版本 | 应安装的插件版本 |
| --- | --- |
| `0.2.x`（`0.2.0-rc.1` 起） | `0.11.0` 及以后 |
| `0.1.x`（`0.1.0-rc.6` 起） | `0.10.x`，或 `0.11.0` 及以后 |

运行 `dsh --version` 查看你的 DSH 版本。不带版本号安装会自动取最新的兼容版本；最新版与你的 DSH 不匹配时，指定确切版本，例如 `@dougen/dsh-deepseek-usage@0.10.2`。
