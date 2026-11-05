<img src="https://cdn.jsdelivr.net/npm/@dougen/dsh-deepseek-usage/icon.svg" alt="dsh-deepseek-usage icon" width="72" align="right" />

# dsh-deepseek-usage

[![npm version](https://img.shields.io/npm/v/@dougen/dsh-deepseek-usage)](https://www.npmjs.com/package/@dougen/dsh-deepseek-usage)
[![CI](https://github.com/dougen/dsh-deepseek-usage/actions/workflows/ci.yml/badge.svg)](https://github.com/dougen/dsh-deepseek-usage/actions/workflows/ci.yml)

[English](README.md) | 中文

一个 **DeepSeek Harness（DSH）** 的侧边栏插件：在 DSH 主界面就能看到**当前选中模型背后的账户还剩多少钱 / 多少额度**、**这个模型此刻什么价**。覆盖九家提供商。

<img src="https://cdn.jsdelivr.net/npm/@dougen/dsh-deepseek-usage/screenshot.png" alt="侧边栏卡片：余额、当前单价与计费时段指示灯" width="520" />

*余额形态（DeepSeek、Kimi、Z.ai、OpenRouter 等）：账户余额、当前模型的输入 / 输入缓存 / 输出单价，右上角是峰谷时段指示灯。*

<img src="https://cdn.jsdelivr.net/npm/@dougen/dsh-deepseek-usage/screenshot2.png" alt="订阅用量：各计费窗口的剩余额度" width="520" />

*订阅形态（Kimi For Coding、OpenCode、MiniMax、Claude Code / Codex 等）：每个用量窗口一个 D 形仪表盘——中间的数是剩余额度，灰色弧是已用量，绿色弧是剩余量（已用达到 80% 时转红），底部徽章标出窗口（`5H` = 5 小时、`7D` = 周、`1M` = 月）。*

## 这个插件是干嘛的

DSH 可以切换很多家模型提供商，但每家的账户状况藏在不同的网站后台。这个插件会解析你在 DSH 里当前选中的模型属于哪家提供商，把那个账户的实时状态卡片放进 DSH 主界面侧边栏底部：

- **账户读数**，按提供商公开的内容分两种形态：
  - *余额类*（DeepSeek、Moonshot / Kimi、智谱 Z.ai、OpenRouter）公开账户余额，卡片直接显示带币种符号（`¥` / `$`）的余额。
  - *订阅类*（Kimi For Coding、OpenCode、MiniMax、Claude Code、OpenAI Codex）没有余额可查，只公开用量窗口。卡片按接口返回的窗口各画一个仪表盘——5 小时、周、月，返回几个画几个——显示每份额度还剩多少，已用达到 80% 时剩余弧变红。
  - 卡片始终跟随当前选中的模型，切换提供商即切换读数；除凭据外不需要针对某家提供商再做任何配置。
- **当前模型的单价**。卡片列出输入 / 输入缓存 / 输出的单价，按此刻生效的计费时段取值，币种跟该提供商保持一致。有的提供商按时段计价——DeepSeek 官方峰谷（北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰，夜间、周末、节假日为空闲）或 OpenRouter 的分时定价——卡片会用一枚橙 / 绿指示灯标出当前时段，悬浮可见距下次切换还剩多久。
- **数字可靠**。每 30 秒自动刷新，点击卡片或切换模型时立即刷新。第一次响应回来之前显示占位符 `—`，不猜数；价格表未收录的模型干脆不显示价格。界面跟随 DSH 语言设置：DSH 用中文时显示中文，其它语言一律显示英文；插件列表里的名称与描述、插件详情页也遵循同一规则。明暗主题同样跟随 DSH。

> [!NOTE]
> GitHub Copilot、Google、Amazon Bedrock、Azure 等本插件有意不处理的凭据形态，卡片上会写明原因而不是给一个数字。

## 如何安装和使用

**第 1 步——配置提供商的凭据。** 插件用你给该提供商配的那把 Key 查询：在 DSH 设置的**模型页**填好，或导出为环境变量（`DEEPSEEK_API_KEY`、`MOONSHOTAI_API_KEY`、`ZAI_API_KEY`、`OPENROUTER_API_KEY`、`KIMI_CODING_API_KEY`、`OPENCODE_API_KEY`、`MINIMAX_API_KEY` 等）。`deepseek-account` 是例外：它不需要密钥——在 DSH 里登录 DeepSeek 账号即可，卡片读的是登录留下的授权。

**第 2 步——把插件装进 `web` profile：**

```sh
dsh plugin --profile web add @dougen/dsh-deepseek-usage
```

**第 3 步——重启 `dsh web`**，打开它打印的地址。卡片位于侧边栏底部、Cordis 面板按钮下方；点击卡片可立即刷新。提供商映射与订阅令牌在**设置 → DeepSeek 用量**里配置。

<details>
<summary>使用 Claude Code / OpenAI Codex 订阅（OAuth）</summary>

API Key 读不到这两种订阅——它们走 OAuth 令牌。当 DSH 检测到 Claude Code 或 OpenAI Codex（或有映射目标指向其中之一），**设置 → DeepSeek 用量** 的提供商映射下方会出现令牌填写框。把令牌粘贴进去，侧边栏卡片即可开始显示该订阅的余量：

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

## 支持的 DSH 版本

插件版本要与 DSH 版本相配：

| DSH 版本 | 应安装的插件版本 |
| --- | --- |
| `0.2.x`（`0.2.0-rc.1` 起） | `0.11.0` 及以后 |
| `0.1.x`（`0.1.0-rc.6` 起） | `0.10.x`，或 `0.11.0` 及以后 |

运行 `dsh --version` 查看你的 DSH 版本。不带版本号安装会自动取最新的兼容版本；最新版与你的 DSH 不匹配时，指定确切版本，例如 `@dougen/dsh-deepseek-usage@0.10.2`。
