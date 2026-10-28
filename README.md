<img src="https://cdn.jsdelivr.net/npm/@dougen/dsh-deepseek-usage/icon.svg" alt="dsh-deepseek-usage icon" width="72" align="right" />

# dsh-deepseek-usage

[![npm version](https://img.shields.io/npm/v/@dougen/dsh-deepseek-usage)](https://www.npmjs.com/package/@dougen/dsh-deepseek-usage)
[![CI](https://github.com/dougen/dsh-deepseek-usage/actions/workflows/ci.yml/badge.svg)](https://github.com/dougen/dsh-deepseek-usage/actions/workflows/ci.yml)

<!-- GitHub and npm both prefix heading ids with `user-content-`, so the in-page anchor needs it -->
[中文文档](#user-content-中文文档)

A **DeepSeek Harness (DSH)** sidebar plugin that keeps the active provider's account reading and the current model's unit price one glance away — DeepSeek, Moonshot / Kimi, Z.ai (GLM), MiniMax, OpenRouter, Kimi For Coding, OpenCode, and Claude Code / Codex OAuth subscriptions — with a Chinese / English UI.

<img src="https://cdn.jsdelivr.net/npm/@dougen/dsh-deepseek-usage/screenshot.png" alt="The sidebar card: balance, current unit prices and the billing-window dot" width="520" />

*Balance mode: the account balance, the current model's unit prices, and the peak / off-peak indicator in the top-right corner.*

<img src="https://cdn.jsdelivr.net/npm/@dougen/dsh-deepseek-usage/screenshot2.png" alt="Subscription usage: remaining quota per billing window" width="520" />

*Subscription mode: one D-shaped gauge per billing window — the number inside is the remaining quota, grey is what has been used, green (red once 80% is used) is what is left, and the badge names the window (`5H` / `7D` / `1M`).*

## Features

- **The active provider's account, in the sidebar footer.** A balance with its currency symbol (`¥` / `$`), or — for subscription plans that publish no balance — every usage window the endpoint returns, drawn as one D-shaped gauge per quota in the same card: the green arc is the share still available, the grey arc the share already used, the remaining amount sits in the middle as a plain number, and a short badge in the open bottom names the window (`5H` / `7D` / `1M`), with the reset countdown on hover. The remaining arc turns red once 80% of the quota is used. Gauges spread evenly across the card, whether the plan returns one, two or three windows. The card follows the model you have selected, so switching provider switches the reading.
- **Unit prices of the active model.** Input, input cache and output for the billing window in effect right now, in the currency of the table that priced them (`元` / `$`). They change when you switch models and when the billing window flips.
- **Billing-window dot.** Shown whenever the model's price table declares time-based windows: DeepSeek's official peak / off-peak schedule (orange during Mon–Fri 09:00–12:00 and 14:00–18:00 Beijing time, green otherwise — evenings, weekends, Chinese public holidays and make-up workdays are all off-peak). Hovering it gives the time left until the next switch as `2d 15h`, `5h 47m` or `23m`. OpenRouter's time-of-day overrides get the same dot. A subscription route that serves a DeepSeek model keeps the same dot (no per-token price is shown for a subscription). Models priced flat all day show the price row alone.
- **A query-status page** on the plugin's own page in Plugins: every provider DSH knows about that is configured, supported, or currently active gets a small card with its reading or the reason it cannot be read.
- **OAuth token cards** for Claude Code and OpenAI Codex, when DSH detects those routes: paste a token and the card plus the status table start reporting subscription usage.
- **Refreshes every 30 seconds**, immediately on click and when the model changes; follows the app light / dark theme and the DSH language; pauses while the tab is hidden.
- **No invented numbers.** Until the first answer arrives the card shows a placeholder (`—`). A model the price table does not cover gets no price at all rather than a guess.

## Supported providers

| Provider | Kind | Endpoint | Credential reference |
| --- | --- | --- | --- |
| DeepSeek (`deepseek-official`, `deepseek-account`, `deepseek`) | Balance | `GET https://api.deepseek.com/user/balance` (honours `DEEPSEEK_BASE_URL`) | `DEEPSEEK_API_KEY` |
| Moonshot / Kimi (`moonshotai`) | Balance | `GET /v1/users/me/balance` — USD on `api.moonshot.ai`, then CNY on `api.moonshot.cn` | `MOONSHOTAI_API_KEY`, `MOONSHOT_API_KEY` |
| Z.ai / GLM (`zai`) | Balance | `GET /api/biz/account/query-customer-account-report` — Bearer on `api.z.ai`, raw key on `open.bigmodel.cn` | `ZAI_API_KEY`, `ZAI_CODING_CN_API_KEY` |
| OpenRouter (`openrouter`) | Balance | `GET /api/v1/key`, falling back to `GET /api/v1/credits` when the key carries no limit | `OPENROUTER_API_KEY` |
| Kimi For Coding (`kimi-coding`) | Subscription usage | `GET https://api.kimi.com/coding/v1/usages` | `KIMI_CODING_API_KEY`, `KIMI_API_KEY` |
| OpenCode (`opencode`, `opencode-go`) | Subscription usage | `GET https://opencode.ai/zen/go/v1/usage` | `OPENCODE_GO_API_KEY`, `OPENCODE_API_KEY` |
| MiniMax (`minimax`, `minimax-cn`) | Subscription usage | `GET /v1/token_plan/remains` on `www.minimax.io` / `api.minimaxi.com` | `MINIMAX_CN_API_KEY`, `MINIMAX_API_KEY` |
| Claude Code (`anthropic`) | OAuth subscription | `GET https://api.anthropic.com/api/oauth/usage` | `DSH_USAGE_CLAUDE_OAUTH_TOKEN` |
| OpenAI Codex (`openai-codex`) | OAuth subscription | `GET https://chatgpt.com/backend-api/wham/usage` | `DSH_USAGE_CODEX_OAUTH_TOKEN` + `DSH_USAGE_CODEX_ACCOUNT_ID` |

Each provider reads the reference the Models page writes for that route first (`<ROUTE>_API_KEY`, with non-alphanumerics turned into `_`), then the adapter's own environment name — so a key typed on the Models page and one exported in your shell both work. When a key is missing, the card names the reference it looked for.

Every subscription endpoint returns all of its usage windows in a single response, so the card lists them side by side without a request per window: OpenCode reports 5-hour, weekly and monthly; Kimi For Coding reports 5-hour, weekly and, when the account has one, monthly; Claude Code reports 5-hour, weekly and a separate Opus weekly window; Codex reports 5-hour and weekly; MiniMax reports an interval plus a weekly window per quota bucket (the card shows the tightest bucket for each). Vendors disagree on whether a number means used or remaining, so every reading is normalised to **used**.

> [!NOTE]
> When GitHub Copilot (OAuth only), Google, Google Vertex, Amazon Bedrock or Azure (cloud AK/SK) are configured or currently active, the status page states the reason instead of showing a number; this plugin deliberately does not handle those credential kinds. OpenCode's Zen wallet balance has no API-key-readable endpoint ([anomalyco/opencode#44189](https://github.com/anomalyco/opencode/issues/44189)), so only the subscription usage windows above are available.

## Requirements

| DSH | Plugin version |
| --- | --- |
| `0.2.x` (`0.2.0-rc.1` and later) | `0.11.0` and later |
| `0.1.x` (`0.1.0-rc.6` and later) | `0.10.x`, or `0.11.0` and later |

`dsh --version` prints your DSH version. Installing without a version picks the newest compatible release; name an exact version (`@dougen/dsh-deepseek-usage@0.10.2`) when the newest does not match your DSH.

## Getting started

1. Configure the API key for the provider you want to query — on the Models page in DSH, or as its environment variable (`DEEPSEEK_API_KEY`, and so on).
2. Install the plugin into the `web` profile:

   ```sh
   dsh plugin --profile web add @dougen/dsh-deepseek-usage
   ```

3. Restart `dsh web` and open the URL it prints. The card sits at the bottom of the sidebar, below the Cordis panel button.

Click the card to refresh it; while it still has no reading it retries after 4, 8, 15 and 30 seconds.

To uninstall:

```sh
dsh plugin --profile web remove @dougen/dsh-deepseek-usage
```

Then restart `dsh web`.

## Query status page and OAuth tokens

Open the plugin's own page in **Plugins** to see the status table. The currently active provider is listed first and tagged `Current`; the others follow grouped by kind. A row either shows its reading or a status: `No API key`, `No token`, `Querying…`, `Query failed` or `Not applicable`.

### Claude Code

On a machine signed in to Claude Code, copy `claudeAiOauth.accessToken` from `~/.claude/.credentials.json` (on macOS: the `Claude Code-credentials` keychain item). A token minted by `claude setup-token` also works, but it carries only `user:inference`, so the plugin reads the 5-hour and 7-day windows from rate-limit response headers instead of the full usage body.

### OpenAI Codex

Copy `tokens.access_token` from `~/.codex/auth.json` into the token field, and `tokens.account_id` into the account ID field (sent as the `ChatGPT-Account-Id` header).

### Where tokens live

Tokens are stored through DSH's credential service (`~/.dsh/.credentials.yaml`) and stay on this machine: no response, log line or page element ever carries one back. **Clear** removes them again.

## Pricing data

Prices are one built-in snapshot per provider, `PRICE_TABLES` in `lib/pricing.js`. A model is priced only when its provider **and** its model id are in a table; everything shares one lookup path (`quoteAt`). There is no price file and no background sync — prices change only when a new version of the plugin ships.

| Table (provider id) | Currency | Snapshot | Models and billing windows |
| --- | --- | --- | --- |
| DeepSeek (`deepseek-official`, `deepseek-account`, `deepseek`) | CNY | 2026-09-10 | `deepseek-flash`, `deepseek-v4-pro`, `deepseek-chat`, `deepseek-reasoner`; peak / off-peak schedule, with aliases `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` |
| Moonshot / Kimi (`moonshotai`) | USD | 2026-10-27 | `kimi-k3.1-pro`, `kimi-k3.1-pro-highspeed`, `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, `kimi-k2.6` |
| Z.ai (`zai`) | USD | 2026-10-27 | `glm-5.3`, `glm-5.3-flash`, `glm-5.3-flashx`, `glm-5.2`, `glm-5.1`, `glm-5`, `glm-4.7`, `glm-4.7-flashx`, `glm-4.6`, `glm-4.6v`, `glm-4.5`, `glm-4.5-air` |
| MiniMax international (`minimax`) | USD | 2026-10-27 | `minimax-m3`, `minimax-m3.1-flash` |
| MiniMax China (`minimax-cn`) | CNY | 2026-10-27 | `minimax-m3`, `minimax-m3.1-flash` |
| OpenRouter (`openrouter`) | USD | 2026-10-27 | `deepseek/deepseek-v4.1-flash-1017` (time-based), `deepseek/deepseek-v4.1-flash`, `claude-sonnet-5.5`, `gpt-6.1-sol`, `gemini-3.8-flash`, `grok-4.7`, `glm-4.6`, `minimax-m3.1-flash` |

### Billing windows

- **DeepSeek** — peak prices (`standard`) apply Mon–Fri 09:00–12:00 and 14:00–18:00 Beijing time, excluding Chinese public holidays; everything else (evenings, weekends, holidays, make-up workdays) is off-peak (`offPeak`). `deepseek-chat` and `deepseek-reasoner` have the same price in both windows but still get the indicator (hover it for the remaining time).
- **OpenRouter** — `deepseek/deepseek-v4.1-flash-1017` carries its own weekday 09:00–12:00 / 14:00–18:00 windows, without the Chinese holiday rule.
- **Everything else** is priced flat all day: the price row appears without a dot.

> [!WARNING]
> The Chinese holiday table (`HOLIDAY_RANGES` in `lib/pricing.js`) currently covers 2026. The State Council usually publishes next year's arrangement in November; update the table, the browser-side mirror and `HOLIDAY_TABLE_THROUGH_YEAR` then. Until you do, holidays are billed as ordinary workdays and the host logs a warning once a day.

### Limits of the table

- Only one price per model is stored, so provider-side tiers that are not time-based are not modelled: MiniMax M3's input-length tiers and priority service, GLM-5.1's ≥32K input tier, and OpenRouter's per-upstream spread (the gateway table records the default-route price). The card shows the base tier.
- Each table follows **one storefront**, because the same model id is priced differently per site: Moonshot / Kimi and Z.ai use international USD prices; MiniMax is split into `minimax` (USD, `.io`) and `minimax-cn` (CNY, `.cn`). A key on the other storefront will not match its bill.
- A model newer than the plugin release is not priced until the table catches up — the plugin never guesses a price from the model name.
- Models reached through a third-party gateway (a relay, a self-hosted endpoint, Workbuddy) are billed by that gateway. A vendor API reports **your own account** at that vendor, which is a different fact; if your DeepSeek key is configured but the active model runs on a gateway, the card shows that gateway's status or its reason — not your DeepSeek balance, and not what the gateway is charging.

### Updating a price table

Edit `PRICE_TABLES` in `lib/pricing.js` — one block per provider id with `currency`, `asOf`, and one `models` entry per official model id: `standard: { input, cacheRead, output }` (per 1M tokens). A model with a cheaper time window gets `offPeak: { … }` plus a provider-level `schedule`: `peakWindows` marks the expensive ranges (prices are `standard` inside, `offPeak` outside), `days: 'everyday' | 'weekdays'`, `offsetMinutes` for the time zone, and `holidays: true` only where Chinese public holidays apply. Legacy model names go in that provider's `aliases`. Models absent from a table stay unpriced.

## How it works

The plugin has two halves, both plain ESM with no build step. The host registers four local routes:

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/deepseek-usage` | `GET` (`?lang=zh\|en`) | the active model's provider reading, price tier and billing-window state |
| `/api/deepseek-usage/accounts` | `GET` (`?list=1` for a list-only pass) | query status for every configured, supported or current provider |
| `/api/deepseek-usage/token` | `POST` | save or clear an OAuth token |
| `/api/deepseek-usage/holidays` | `GET` | the public-holiday table for the browser half |

- **Host** (`lib/index.js`, `lib/accounts.js`, `lib/pricing.js`) resolves the active model's provider from `agentDefaultModel` on every request, resolves that provider's credential reference through DSH's credential service, calls the matching endpoint with a 15-second timeout and a 64 KiB response cap, then classifies any failure into a short, actionable message. Readings are cached for 10 seconds and keyed by provider, endpoint and credential, with in-flight coalescing, so a second tab or a click does not repeat the upstream call.
- **Browser** (`lib/client.js`) renders that answer into the `sidebar.footer.action` slot and the status table into `plugins.detail.section` on the plugin's own page. It holds no pricing logic: the dot and the prices all come from the same answer. It re-reads every 30 seconds, on click and when the model changes, and mirrors the holiday table only as a fallback if the host route is unavailable.
- **Local only.** Every route answers only to local callers: the `Host` header must name a loopback address (or the address the server is bound to), cross-site browser requests and foreign `Origin` headers are refused, only the documented methods are accepted, and the token route requires JSON with a bounded body. Credentials never cross to the browser — no response carries a key, a token or an upstream error message. A local process on the same machine can still read the routes; that is inherent to a local tool.

## Troubleshooting

**The card is blank, with a reason instead of numbers.**

- *`DEEPSEEK_API_KEY is not configured`* / another reference name — set it in DSH settings (Models page) and restart.
- *The key contains characters an HTTP header cannot carry* — usually a stray newline from a copy-paste; re-copy it without the line break.
- *Balance API HTTP n / timed out / unreachable / returned an unreadable response / returned no balance* — click the card to retry; check the network and the provider's status page.
- *The account is currently unavailable* — the balance API answered with `is_available: false`.
- *`This plugin does not support <provider>`* — the active provider has no readable balance or usage API (see above).
- *`This provider has no OAuth token yet`* / *`The OAuth token is no longer valid`* — paste or replace the token on the plugin's page.

If `DEEPSEEK_BASE_URL` points at a third-party gateway, only that gateway's answer is available: the official balance endpoint `https://api.deepseek.com/user/balance` is never called, and only DeepSeek's official platform is supported.

The card never shows an upstream error message verbatim: transport details stay in the host log, and the card carries a short, actionable line instead.

**The status page shows no reading for a provider** — look at the row's status: `No API key` means the credential reference is missing, `Not applicable` means the provider has no readable API. Providers that are neither supported nor configured are not listed at all.

---

## 中文文档

一个 **DeepSeek Harness（DSH）** 的侧边栏插件：不离开 DSH 就能看到**当前模型提供商的账户还剩多少**、**当前模型此刻什么价**——覆盖 DeepSeek、Moonshot / Kimi、Z.ai（GLM）、MiniMax、OpenRouter、Kimi For Coding、OpenCode，以及 Claude Code / Codex 的 OAuth 订阅，界面支持中文与英文。

### 功能

- **侧边栏底部的账户读数**：余额带币种符号（`¥` / `$`）；订阅制没有余额接口，就在同一张卡片里为接口返回的每个用量窗口画一个 D 形仪表盘——绿色弧是还没用完的额度，灰色弧是已经用掉的部分，弧内数字是剩余量（不带百分号），底部缺口嵌着周期缩写徽章（`5H`、`7D`、`1M`），重置倒计时放在悬浮说明里；已用达到 80% 后剩余弧变红。无论返回 1 个、2 个还是 3 个窗口，仪表盘都在卡片里均分居中。读数跟随当前选中的模型，切换提供商即切换读数。
- **当前模型的单价**：输入 / 输入缓存 / 输出，按此刻生效的计费时段显示，币种跟给价的那张表走（`元` / `$`）。切换模型、跨过计费区间切换点时会跟着变。
- **计费区间指示灯**：价格表声明了分时段计费时出现。DeepSeek 为官方峰谷：高峰（周一至周五 09:00–12:00、14:00–18:00 北京时间，不含中国法定节假日）橙色，其余时间绿色——周末、法定节假日、调休上班的周末都按空闲处理；指针悬停时给出距下次切换的剩余时间（`2d 15h`、`5h 47m`、`23m`）。OpenRouter 的分时 overrides 用同一套指示灯。订阅制路由上跑的若是 DeepSeek 模型，也照旧显示指示灯（订阅制不显示按 token 的单价）。全天一价的模型只显示单价行。
- **查询状态页**：在 Plugins 面板本插件的详情页上，DSH 里已配置的、受支持的、当前的每个提供商各占一张小卡片，能查的显示读数，不能查的写明原因。
- **OAuth 令牌填写卡**：DSH 检测到 Claude Code / Codex 时出现，粘贴令牌后卡片与状态表即可显示订阅用量。
- **每 30 秒自动刷新**，点击卡片或切换模型时立即刷新；跟随应用明暗主题与 DSH 语言；标签页隐藏时暂停心跳。
- **不编数字**：第一次响应回来之前显示占位符 `—`；价格表未收录的模型不显示价格，也不按模型名猜。

### 支持的提供商

| 提供商 | 类型 | 接口 | 密钥引用 |
| --- | --- | --- | --- |
| DeepSeek（`deepseek-official`、`deepseek-account`、`deepseek`） | 余额 | `GET https://api.deepseek.com/user/balance`（遵循 `DEEPSEEK_BASE_URL`） | `DEEPSEEK_API_KEY` |
| Moonshot / Kimi（`moonshotai`） | 余额 | `GET /v1/users/me/balance`——`api.moonshot.ai` 为 USD，回落 `api.moonshot.cn` 为 CNY | `MOONSHOTAI_API_KEY`、`MOONSHOT_API_KEY` |
| 智谱 Z.ai / GLM（`zai`） | 余额 | `GET /api/biz/account/query-customer-account-report`——`api.z.ai` 用 Bearer，`open.bigmodel.cn` 用裸 Key | `ZAI_API_KEY`、`ZAI_CODING_CN_API_KEY` |
| OpenRouter（`openrouter`） | 余额 | `GET /api/v1/key`；该 Key 无限额时回落 `GET /api/v1/credits` | `OPENROUTER_API_KEY` |
| Kimi For Coding（`kimi-coding`） | 订阅用量 | `GET https://api.kimi.com/coding/v1/usages` | `KIMI_CODING_API_KEY`、`KIMI_API_KEY` |
| OpenCode（`opencode`、`opencode-go`） | 订阅用量 | `GET https://opencode.ai/zen/go/v1/usage` | `OPENCODE_GO_API_KEY`、`OPENCODE_API_KEY` |
| MiniMax（`minimax`、`minimax-cn`） | 订阅用量 | `GET /v1/token_plan/remains`——`www.minimax.io` / `api.minimaxi.com` | `MINIMAX_CN_API_KEY`、`MINIMAX_API_KEY` |
| Claude Code（`anthropic`） | OAuth 订阅 | `GET https://api.anthropic.com/api/oauth/usage` | `DSH_USAGE_CLAUDE_OAUTH_TOKEN` |
| OpenAI Codex（`openai-codex`） | OAuth 订阅 | `GET https://chatgpt.com/backend-api/wham/usage` | `DSH_USAGE_CODEX_OAUTH_TOKEN` + `DSH_USAGE_CODEX_ACCOUNT_ID` |

每个提供商先读模型页为该路由写入的 `<路由名>_API_KEY`（非字母数字换成 `_`），然后读适配器自己声明的环境变量名——无论密钥是当初在模型页键入的，还是在 shell / `.env` 里导出的，都能读到。缺密钥时卡片会点名它查过的引用。

每个订阅接口都在**一次响应**里返回全部用量窗口，卡片因此可以并排列出，不必每个窗口各发一次请求：OpenCode 给 5 小时 / 周 / 月；Kimi For Coding 给 5 小时 / 周，账号有月额度时再给月；Claude Code 给 5 小时 / 周，以及单独的 Opus 周窗口；Codex 给 5 小时 / 周；MiniMax 给「区间 + 周」两档、每个额度桶各一份（卡片取每档里最紧的桶）。各家对"已用"和"剩余"的口径不一致，解析时统一折算成**已用**。

> [!NOTE]
> GitHub Copilot（仅 OAuth）、Google、Google Vertex、Amazon Bedrock、Azure（云厂商 AK/SK）被配置或正好是当前提供商时，状态页写明原因而不是给一个数字——这些凭据形态本插件有意不处理。OpenCode 的 Zen 钱包余额没有可用 API Key 读取的接口（[anomalyco/opencode#44189](https://github.com/anomalyco/opencode/issues/44189)），只有上面的订阅用量窗口可读。

### 版本要求

| DSH | 插件版本 |
| --- | --- |
| `0.2.x`（`0.2.0-rc.1` 起） | `0.11.0` 及以后 |
| `0.1.x`（`0.1.0-rc.6` 起） | `0.10.x`，或 `0.11.0` 及以后 |

`dsh --version` 查看当前 DSH 版本。不带版本号安装会取最新的兼容版本；最新版与你的 DSH 不匹配时，用 `@dougen/dsh-deepseek-usage@0.10.2` 这样的完整版本号指定。

### 安装

1. 在 DSH 设置（模型页）里配置要查的提供商的 API Key，或导出对应的环境变量（DeepSeek 是 `DEEPSEEK_API_KEY`，其余同理）。
2. 装进 `web` profile：

   ```sh
   dsh plugin --profile web add @dougen/dsh-deepseek-usage
   ```

3. 重启 `dsh web`，打开它打印的地址：卡片位于侧边栏底部、Cordis 面板按钮下方。

点击卡片即可刷新；还没拿到读数时，会按 4、8、15、30 秒的节奏补几次请求。

卸载：

```sh
dsh plugin --profile web remove @dougen/dsh-deepseek-usage
```

然后重启 `dsh web`。

### 查询状态页与 OAuth 令牌

打开 **Plugins** 面板里本插件的详情页即可看到状态表。当前提供商排在最前并标着 `当前`，其余按类型分组；每一行要么显示读数，要么是 `未配置密钥`、`未填写令牌`、`查询中…`、`查询失败`、`不适用` 之一。

**Claude Code**——在已登录 Claude Code 的机器上，从 `~/.claude/.credentials.json` 的 `claudeAiOauth.accessToken` 复制（macOS 在钥匙串项 `Claude Code-credentials` 里）。`claude setup-token` 产生的令牌也能用，但它只带 `user:inference` 权限，插件改为从推理响应的限流头读取 5 小时与 7 天两个窗口。

**OpenAI Codex**——从 `~/.codex/auth.json` 的 `tokens.access_token` 复制，并把 `tokens.account_id` 填进账号 ID 一栏（它会作为 `ChatGPT-Account-Id` 请求头发送）。

令牌经 DSH 的凭据服务保存在本机（`~/.dsh/.credentials.yaml`），不出这台机器：任何响应、日志、页面元素都不会把它带回来。点**清除**即可删除。

### 价格数据

价格是 `lib/pricing.js` 里的 `PRICE_TABLES`：一家提供商一份内置快照。只有 provider 与模型 id 都在表里才给价，所有提供商共用同一段查表代码（`quoteAt`）。没有本地价格文件，也没有后台同步——只在发布新版本时更新。

| 价格表（provider id） | 币种 | 采集日期 | 模型与计费区间 |
| --- | --- | --- | --- |
| DeepSeek（`deepseek-official`、`deepseek-account`、`deepseek`） | CNY | 2026-09-10 | `deepseek-flash`、`deepseek-v4-pro`、`deepseek-chat`、`deepseek-reasoner`；峰谷时段，旧名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 走别名 |
| Moonshot / Kimi（`moonshotai`） | USD | 2026-10-27 | `kimi-k3.1-pro`、`kimi-k3.1-pro-highspeed`、`kimi-k3`、`kimi-k2.7-code`、`kimi-k2.7-code-highspeed`、`kimi-k2.6` |
| Z.ai（`zai`） | USD | 2026-10-27 | `glm-5.3`、`glm-5.3-flash`、`glm-5.3-flashx`、`glm-5.2`、`glm-5.1`、`glm-5`、`glm-4.7`、`glm-4.7-flashx`、`glm-4.6`、`glm-4.6v`、`glm-4.5`、`glm-4.5-air` |
| MiniMax 国际站（`minimax`） | USD | 2026-10-27 | `minimax-m3`、`minimax-m3.1-flash` |
| MiniMax 国内站（`minimax-cn`） | CNY | 2026-10-27 | `minimax-m3`、`minimax-m3.1-flash` |
| OpenRouter（`openrouter`） | USD | 2026-10-27 | `deepseek/deepseek-v4.1-flash-1017`（分时）、`deepseek/deepseek-v4.1-flash`、`claude-sonnet-5.5`、`gpt-6.1-sol`、`gemini-3.8-flash`、`grok-4.7`、`glm-4.6`、`minimax-m3.1-flash` |

**计费区间**

- **DeepSeek**——高峰价（`standard`）为周一至周五 09:00–12:00、14:00–18:00 北京时间，剔除中国法定节假日；其余时间（夜间、周末、节假日、调休上班日）为空闲价（`offPeak`）。`deepseek-chat` / `deepseek-reasoner` 两个区间同价，但照旧显示指示灯（悬停给出剩余时间）。
- **OpenRouter**——`deepseek/deepseek-v4.1-flash-1017` 自带工作日 09:00–12:00 / 14:00–18:00 的窗口，**没有**中国法定节假日规则。
- **其余模型**全天一价：只显示单价行，没有指示灯。

> [!WARNING]
> 中国法定节假日表（`lib/pricing.js` 的 `HOLIDAY_RANGES`）目前只覆盖 2026 年。国务院办公厅通常在前一年 11 月发布次年安排，届时更新该表、浏览器侧镜像表与 `HOLIDAY_TABLE_THROUGH_YEAR`。未更新前，节假日按普通工作日计价，宿主每天告警一次。

**价格表的边界**

- 每个模型只存一档价，所以**不是按时间**的分档没有建模：MiniMax M3 的输入长度分档与 priority 服务、GLM-5.1 的 ≥32K 输入档、OpenRouter 的多上游价差（表里记的是默认路由价）。卡片显示基础档。
- 每张表只按**一个站点**维护，因为同一个模型 id 在不同站点价格不同：Moonshot / Kimi、Z.ai 取国际站美元价；MiniMax 分成 `minimax`（美元，`.io`）与 `minimax-cn`（人民币，`.cn`）。Key 在另一个站点时，数字不会与账单一致。
- 比本插件版本更新的模型不估价，直到价格表更新——插件不按模型名猜价。
- 经第三方网关（中转、自建端点、Workbuddy）访问的模型由网关计费。厂商接口反映的是**你自己在该厂商的账户**，这是另一件事：配了 DeepSeek Key 但当前模型跑在网关上时，卡片显示的是该网关的状态或原因，既不是你的 DeepSeek 余额，也不是网关在扣多少。

**手动更新价格表**：改 `PRICE_TABLES`——给某个 provider id 加一块 `currency`、`asOf`，`models` 里每个官方模型 id 一条 `standard: { input, cacheRead, output }`（每百万 tokens）。有分时段计费的模型再加 `offPeak: { … }` 与 provider 级 `schedule`：`peakWindows` 标出贵的时段（区间内按 `standard`、区间外按 `offPeak`），`days: 'everyday' | 'weekdays'`，`offsetMinutes` 指定计时时区，只有套用中国法定节假日的地方才写 `holidays: true`；旧模型名放该 provider 的 `aliases`。表里没有的模型不计价。

### 工作原理

插件分宿主侧与浏览器侧，都是无构建步骤的普通 ESM。宿主侧注册四个本机路由：

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/api/deepseek-usage` | `GET`（`?lang=zh\|en`） | 当前模型提供商的读数、单价与计费区间 |
| `/api/deepseek-usage/accounts` | `GET`（`?list=1` 只回清单） | 每个已配置 / 受支持 / 当前提供商的查询状态 |
| `/api/deepseek-usage/token` | `POST` | 写入或清除 OAuth 令牌 |
| `/api/deepseek-usage/holidays` | `GET` | 交给浏览器侧的法定节假日表 |

- **宿主侧**（`lib/index.js`、`lib/accounts.js`、`lib/pricing.js`）每次请求从 `agentDefaultModel` 解析当前提供商，经凭据服务解析该提供商的密钥引用，请求对应接口（15 秒超时、64 KiB 响应上限），失败分类成一句简短可行动的话。读数缓存 10 秒并按「提供商 + 端点 + 凭据」分桶、合并在途请求，多标签页或重复点击不会重复打上游。
- **浏览器侧**（`lib/client.js`）把响应渲染进 `sidebar.footer.action`，把状态表渲染进本插件详情页的 `plugins.detail.section`。界面自身不做计价逻辑：指示灯与单价都来自同一份响应。每 30 秒重新读一次，点击卡片或模型变化时立即刷新；宿主路由不可用时才用内置的节假日表兜底。
- **只服务本机**：`Host` 必须是回环地址（或服务器绑定的地址），跨站浏览器请求与异源 `Origin` 一律拒绝，只接受文档声明的方法，令牌路由还要求 JSON 且有 body 上限。凭据从不下发到浏览器——任何响应都不带 Key、令牌或上游错误原文。同一台机器上的本地进程仍能读到这些路由，这是本地工具的固有边界。

### 常见问题

**卡片空白，显示的是原因而不是数字**

- *未配置 `DEEPSEEK_API_KEY`*（或其它引用名）：在 DSH 设置（模型页）里配置后重启。
- *Key 里含有 HTTP 头带不了的字符*：通常是粘贴时带进一个换行，重新复制并去掉换行。
- *余额接口 HTTP n / 超时 / 无法连接 / 返回了无法解析的内容 / 没有返回余额*：点击卡片重试，检查网络与该提供商的状态页。
- *账户当前不可用*：余额接口有响应，但 `is_available` 为 false。
- *本插件不支持 `<提供商>`*：当前提供商没有可查的余额或用量接口（见上文）。
- *尚未填写该提供商的 OAuth 令牌* / *OAuth 令牌已失效*：到插件页面粘贴或重新粘贴一个。

把 `DEEPSEEK_BASE_URL` 指向第三方中转时，拿到的是该中转的响应，官方余额接口不再被调用——本插件只支持 DeepSeek 官方平台。

卡片不会原样显示上游的错误消息：传输层细节留在宿主日志里，卡片上只放一句简短、能行动的话。

**状态页里某个提供商没有读数**——看该行的状态：`未配置密钥` 表示凭据引用缺失，`不适用` 表示这类提供商没有可查接口。既不支持也没配置的提供商不会出现在列表里。
