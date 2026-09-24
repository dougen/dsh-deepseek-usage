# @dougen/dsh-deepseek-usage

<!-- 渲染器会给标题 id 加 `user-content-` 前缀（npm 页面、GitHub 都是），跳转链接要用带前缀的锚点 -->
[中文文档](#user-content-中文文档)

A sidebar plugin for the **DeepSeek Harness (DSH) Web UI** that answers two questions without leaving the app: **how much balance is left**, and **what the model costs right now**.

![DeepSeek usage card / 用量卡片](https://cdn.jsdelivr.net/npm/@dougen/dsh-deepseek-usage/screenshot.png)

## What it does

- **Balance** in the sidebar footer: your DeepSeek account balance (the symbol follows the account currency: `¥` / `$`).
- **Unit prices of the active model**: input / input cache / output for the billing window in effect right now. They change when you switch models and when the peak/off-peak window flips.
- **Peak / off-peak dot with a countdown**: orange during peak hours (Mon–Fri, excluding Chinese public holidays, 9:00–12:00 and 14:00–18:00 Beijing Time), green otherwise — weekends, public holidays and the make-up workdays that fall on a weekend are all off-peak; next to it, the time left until the next switch (`2d 15h`, `5h 47m`, `23m`).
- Refreshes every 5 minutes, and immediately when you click the card or switch models. Follows the app light/dark theme and the DSH language (Chinese / English).

## Install, uninstall, common errors

### Install

1. Configure `DEEPSEEK_API_KEY` in DSH (model settings).
2. `dsh plugin --profile web add @dougen/dsh-deepseek-usage`
3. Restart `dsh web` and open the URL it prints — the card sits at the bottom of the sidebar, below the Cordis panel button.

### Uninstall

```sh
dsh plugin --profile web remove @dougen/dsh-deepseek-usage
```

Then restart `dsh web`.

### A blank card means the balance could not be read

The card then shows the reason instead of numbers:

- **`DEEPSEEK_API_KEY` is not configured** — set it in DSH settings and restart.
- **The balance request or the network failed** — click the card to retry.
- **`DEEPSEEK_BASE_URL` points at a third-party gateway** — the official balance endpoint `https://api.deepseek.com/user/balance` may be unavailable or answer differently; only DeepSeek's official platform is supported.

### Prices differ from the official page

- Prices are the built-in table `PRICE_TABLE` in `lib/pricing.js`, a snapshot of the official pricing page. It changes only when a new version of the plugin ships — there is no local price file and no background sync.
- If the active model is not in the table, the card falls back to `deepseek-chat` pricing.
- Off-peak days come from the holiday table `HOLIDAY_RANGES` in `lib/pricing.js` (and its mirror in `lib/client.js`). The State Council usually publishes next year's arrangement in November; update both lists then. Until you do, holidays are treated as ordinary workdays and the card shows peak prices during them.

## How it works

- The **host half** (`lib/index.js`, `lib/pricing.js`) registers `GET /api/deepseek-usage`. Per request it reads the API key from DSH credentials, asks the official balance API, resolves the active model's price from the built-in price table, and answers with balance, tier prices, the peak flag and the next switch time. `GET /api/deepseek-usage/holidays` hands the browser half the same public-holiday table.
- The **browser half** (`lib/client.js`) renders that answer into the `sidebar.footer.action` slot, polls every 5 minutes, and refreshes on click or on a model change. The peak state and the countdown come from the same answer, so the card itself holds no pricing logic.

---

## 中文文档

一个 **DeepSeek Harness（DSH）网页界面**的侧边栏插件：不离开 DSH 就能知道**账号还剩多少钱**、**当前的模型现在什么价**。

### 这个插件做什么

- **余额**：侧边栏底部显示 DeepSeek 账号余额（符号随账号币种 `¥` / `$`）。
- **当前模型的档单价**：输入 / 输入缓存 / 输出，按此刻生效的计费时段显示；切换模型、跨过峰谷切换点时会跟着变。
- **峰谷指示灯 + 倒计时**：高峰（周一至周五、不含中国法定节假日，9:00–12:00、14:00–18:00 北京时间）橙色，其余时间绿色——周末、法定节假日全天，以及调休上班的周末都是空闲；指示灯旁给出距下次切换的剩余时间（`2d 15h`、`5h 47m`、`23m`）。
- 每 5 分钟自动刷新；点击卡片或切换模型时立即刷新。跟随应用明暗主题与 DSH 语言（中文 / English）。

### 安装、卸载与常见错误

安装：

1. 在 DSH 设置（模型页）里配置 `DEEPSEEK_API_KEY`。
2. `dsh plugin --profile web add @dougen/dsh-deepseek-usage`
3. 重启 `dsh web`，打开它打印的地址：卡片位于侧边栏底部、Cordis 面板按钮下方。

卸载：

```sh
dsh plugin --profile web remove @dougen/dsh-deepseek-usage
```

然后重启 `dsh web`。

卡片空白说明余额没读到，此时卡片会写明原因：

- **没有配置 `DEEPSEEK_API_KEY`**：在 DSH 设置里配置后重启。
- **余额接口或网络失败**：点击卡片重试。
- **`DEEPSEEK_BASE_URL` 指向第三方中转**：官方余额接口 `https://api.deepseek.com/user/balance` 可能不可用或返回异常，本插件只支持 DeepSeek 官方平台。

价格与官方不一致时：

- 价格是 `lib/pricing.js` 的内置表 `PRICE_TABLE`（官方价格页的快照），只在发布新版本时更新——没有本地价格文件，也没有后台同步。
- 当前模型不在价格表里时，按 `deepseek-chat` 的价格显示。
- 放假日期维护在 `lib/pricing.js` 的 `HOLIDAY_RANGES`（`lib/client.js` 有一份镜像，两处要一起改）。国务院办公厅通常在前一年 11 月发布次年安排，届时更新；未更新前，节假日会按普通工作日处理，白天显示高峰价。

### 简单的工作原理

- **宿主侧**（`lib/index.js`、`lib/pricing.js`）注册 `GET /api/deepseek-usage`：每次请求读取 DSH 凭据里的 API Key、调用官方余额接口、从内置价格表解析当前模型档单价，返回余额、档单价、峰谷状态与下次切换时刻；`GET /api/deepseek-usage/holidays` 把同一份法定节假日表交给浏览器侧。
- **浏览器侧**（`lib/client.js`）把这份响应渲染进 `sidebar.footer.action` 槽位，每 5 分钟轮询一次，点击卡片或模型变化时立即刷新；峰谷状态与倒计时同样来自这次响应，界面自身不做计价逻辑。

## License

MIT
