# @dougen/dsh-deepseek-usage

A sidebar plugin for **DeepSeek Harness Web UI** that shows your **DeepSeek account balance** (large display), the **current model's unit pricing**, and the **time left until the next peak/off-peak switch** — with a peak/off-peak billing indicator. UI language follows the DSH locale (Chinese UI shows Chinese, other languages show English).

DeepSeek **余额侧边栏插件**（DeepSeek Harness Web UI）：在 DSH **网页界面**的侧边栏底部常驻显示你的 **DeepSeek 账号余额**（放大显示）、**当前模型档单价**，以及**距下次峰谷切换的倒计时**，并提供高峰/空闲计费时段指示灯。界面语言跟随 DSH 语言设置（中文界面显示中文，其他语言显示英文）。

![DeepSeek usage card / 用量卡片](https://cdn.jsdelivr.net/npm/@dougen/dsh-deepseek-usage/screenshot.png)

## Features / 功能

- **Balance**: `¥ 110.00` large display (symbol follows account currency: `¥` CNY / `$` USD)
- **Unit pricing**: `→|1.5 ⚡0.05 |→4.5` (input / input cache / output, bottom-right of the card; switches with the active model and peak/off-peak window — **updates instantly when you switch models**)
- **Editable price table**: prices live in a JSON file (`<DSH_HOME>/dsh-deepseek-usage/pricing.json`), not in code. The plugin reads it at startup, so the card prices correctly **immediately after a restart**, and a successful official sync is written back into it. Hand-edit it for a gateway/manual pricing; changes apply without restarting (`autoUpdate: false` also turns the automatic sync off completely)
- **Auto price sync**: prices are re-fetched from the official DeepSeek pricing page on first use each day and when you click the card; the result is merged back into the price table (official entries overwrite same-named ones, your own entries are kept). The page is parsed **structurally (HTML table cells)**, not by matching surrounding text, so official layout/rewording changes no longer break it; a plain-text strategy remains as a fallback
- **Rename-proof model mapping**: when DeepSeek renames a model (e.g. `deepseek-v4-flash` → `deepseek-flash`) the old id is charged at the current model's price instead of silently showing an outdated price. (The card stays quiet about this — see *FAQ* below.)
- **Peak indicator & countdown**: top-right dot — orange during peak hours (Mon–Fri 9:00–12:00, 14:00–18:00 Beijing Time), green otherwise. Beside the dot a countdown shows the time left until the next peak/off-peak switch, in English units (`2d 15h`, `5h 47m`, `23m`).
- **Auto refresh**: every 5 minutes; click the card to refresh instantly.
- **i18n**: UI copy follows the DSH locale (Chinese / English)
- Follows the app light/dark theme

- **余额**：`¥ 110.00` 大字显示（符号随账号币种自动切换：人民币 `¥` / 美元 `$`）
- **档单价**：`→|1.5 ⚡0.05 |→4.5`（输入 / 输入缓存 / 输出，位于卡片右下角；随当前启用模型与峰谷时段自动切换，**切换模型时立即同步**）
- **可编辑的价格表**：价格不再写在代码里，而是存在 JSON 文件 `<DSH_HOME>/dsh-deepseek-usage/pricing.json`。插件启动时先读它，所以**重启后卡片立刻就是正确价格**；官方同步成功后会自动回写到这份表里。手改该文件即可用于中转/手动计价，改完**无需重启**（`autoUpdate: false` 还能彻底关掉自动同步）
- **单价自动同步**：每日首次使用或点击卡片时，自动从官方价格页拉取最新档单价，并把结果**合并回写**到价格表（官方条目覆盖同名项，你自己加的条目保留）。页面解析采用**结构化表格解析**（直接读 HTML 表格单元格），不再依赖"正文里某段文字长什么样"，官方改版/改文案不会失效；另保留纯文本兜底策略
- **抗改名映射**：官方给模型改名（如 `deepseek-v4-flash` → `deepseek-flash`）时，旧名按现名价格计费，不会静默显示旧价（卡片不为此弹提示，见下方 FAQ）
- **峰谷指示灯与倒计时**：卡片右上角圆点，高峰（周一至周五 9:00–12:00、14:00–18:00 北京时间）橙色，空闲绿色；圆点旁显示距下次峰谷切换的倒计时，统一英文单位（`2d 15h`、`5h 47m`、`23m`）
- **自动刷新**：每 5 分钟一次；点击卡片任意位置立即刷新
- **多语言**：界面文案跟随 DSH 语言（中文 / English）
- 跟随应用明暗主题

## Supported scope / 支持范围

> ⚠️ This plugin **only supports DeepSeek's official platform** balance display: balance comes from the official API `GET https://api.deepseek.com/user/balance` (using the `DEEPSEEK_API_KEY` configured in DSH). Pointing `DEEPSEEK_BASE_URL` at a third-party proxy/gateway may break or return unexpected results for the balance endpoint — **not guaranteed to be compatible**. Use an official DeepSeek platform account.

> ⚠️ 本插件**仅支持 DeepSeek 官方平台**的余额显示：余额来自 DeepSeek 官方 API `GET https://api.deepseek.com/user/balance`（使用 DSH 中已配置的 `DEEPSEEK_API_KEY`）。通过 `DEEPSEEK_BASE_URL` 指向第三方中转/代理时，余额接口可能不可用或返回异常，**不保证兼容**，请使用 DeepSeek 官方平台账号。

## Install / 安装

Requires the DSH CLI. Install from npm:

需要 DSH CLI，从 npm 安装：

```sh
dsh plugin --profile web add @dougen/dsh-deepseek-usage
```

Restart the web app (`dsh web`), open http://127.0.0.1:3080 , and the usage card appears at the bottom of the sidebar (below the Cordis panel button).

安装后重启网页应用：`dsh web`，打开 http://127.0.0.1:3080 ，侧边栏底部（Cordis 面板按钮下方）即出现用量卡片。

## Data sources / 数据来源

| Data | Source |
|---|---|
| Balance | Official DeepSeek API `GET /user/balance` (uses `DEEPSEEK_API_KEY` configured in DSH) |
| Unit pricing | Local price table `<DSH_HOME>/dsh-deepseek-usage/pricing.json` (read at startup; editable). Refreshed from the official page ([api-docs.deepseek.com/zh-cn/quick_start/pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)) on first daily use or on card click, then written back. Parsed from the HTML **table cells** (text fallback available); the built-in snapshot in code is only the seed for the very first run |
| Peak window | Built-in official rule: Mon–Fri 9:00–12:00, 14:00–18:00 Beijing Time (weekends are always off-peak). The card shows it as a coloured dot plus a countdown to the next switch |

| 数据 | 来源 |
|---|---|
| 余额 | DeepSeek 官方 API `GET /user/balance`（使用 DSH 中已配置的 `DEEPSEEK_API_KEY`） |
| 档单价 | 本地价格表 `<DSH_HOME>/dsh-deepseek-usage/pricing.json`（启动即读取，可手动编辑）；每日首次使用或点击卡片时从官方价格页 [api-docs.deepseek.com/zh-cn/quick_start/pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 同步并**回写**该表。官方页解析**读取 HTML 表格单元格**（另有纯文本兜底策略）；代码里的内置快照只在首次运行时用于生成价格表 |
| 峰谷时段 | 内置官方口径：周一至周五 9:00–12:00、14:00–18:00（北京时间），周末恒为空闲；界面以「指示灯 + 距下次切换倒计时」呈现 |

Make sure `DEEPSEEK_API_KEY` is configured in DSH (Model settings page) before use.

使用前请确保 DSH 已配置 `DEEPSEEK_API_KEY`（可在 DSH 设置中的模型页面配置）。

## Price table / 价格表

`<DSH_HOME>/dsh-deepseek-usage/pricing.json` (default `~/.dsh/dsh-deepseek-usage/pricing.json`; override with `DEEPSEEK_USAGE_PRICE_FILE`). Created from the built-in snapshot on first run, then maintained by the plugin:

```jsonc
{
  "autoUpdate": true,            // false = manual mode: never fetch, use this table as-is
  "updatedAt": 1789090582880,    // last write (ms or ISO string)
  "updatedFrom": "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
  "strategy": "table",           // table | flat | seed
  "aliases": { "deepseek-v4-flash": "deepseek-flash" },   // old id → current id
  "models": {
    // input / cacheRead / output are [peak, off-peak] in CNY per 1M tokens
    "deepseek-flash": { "input": [2, 1], "cacheRead": [0.04, 0.02], "cacheWrite": 0, "output": [8, 4] }
  }
}
```

- Full-line `//` comments are allowed; a bare `{"model-id": {...}}` map (no `models` wrapper) also works.
- Every successful official sync **merges** into this file: official entries overwrite same-named ones, your own entries stay.
- Edits are picked up without restarting the plugin (the file's mtime is checked per request).
- If the file is corrupt, the plugin keeps the last good prices and **never overwrites** it — fix it and it reloads.
  (The card itself never shows this path — it only shows your balance, the unit prices, the peak dot and the countdown.)

价格表文件位于 `<DSH_HOME>/dsh-deepseek-usage/pricing.json`（默认 `~/.dsh/dsh-deepseek-usage/pricing.json`，可用 `DEEPSEEK_USAGE_PRICE_FILE` 覆盖）。首次运行由内置快照生成，之后由插件维护：

- 允许**整行** `//` 注释；也接受省略 `models` 外壳的简写形式 `{"deepseek-flash": {...}}`。
- 每次官方同步成功都会**合并回写**本文件：官方页列出的模型覆盖同名条目，你自己加的条目保留。
- 手改后无需重启（每次请求会比对文件 mtime），改完点一下卡片即生效。
- 文件损坏时不会覆盖你的内容，会继续用上一次的价格并写日志；修好后自动重载。
  （卡片上不会显示该路径——卡片只显示余额、档单价、峰谷圆点与切换倒计时。）

## FAQ / 常见问题

**Balance shows "—"? / 余额显示"—"？**

- `DEEPSEEK_API_KEY` is not configured — configure it in DSH settings and restart.
- Network or API error — the card is blanked and shows only the error text; click it to retry.

- 未配置 `DEEPSEEK_API_KEY`：在 DSH 设置中配置后重启。
- 网络或接口异常：卡片会置空并只显示错误文字，点击卡片可重试。

**Price differs from the official one? / 单价与官方价格不一致？**

- The unit price switches with the **active model** and the **peak/off-peak window**. Prices come from the local price table (last successful official sync, or your own edits); the plugin re-syncs the official page on first daily use or on card click and writes the result back into that table.
- **The card deliberately shows no plugin internals**: no sync state, no pricing source, no price-table path. It shows your balance, the current unit prices, the peak dot and the countdown; **click it to refresh**.
- Want to know where a price comes from? Open `<DSH_HOME>/dsh-deepseek-usage/pricing.json` (see *Price table* above) — official entries are merged there on every successful sync.
- **After every `dsh` restart the card used to say "prices not synced (built-in table)"** — that was a race: sync state only lived in memory, so the first request after a restart was always answered from the built-in table. Since 0.7.0 the price table is persisted and read at startup, so restarts show real prices right away.

- 单价按**当前启用模型**与**峰谷时段**自动切换；价格取自本地价格表（上次成功同步到的官方价，或你自己改的价）。插件在每日首次使用或点击卡片时重新同步官方页，并把结果回写到该表。
- **卡片刻意不显示任何插件内部信息**：不显示同步状态、计价来源、价格表路径。卡片上只有余额、当前档单价、峰谷圆点与切换倒计时；**点击卡片即刷新**。
- 想知道某个价从哪来？打开 `<DSH_HOME>/dsh-deepseek-usage/pricing.json`（见上文「价格表」）——每次成功同步都会把官方价合并写进去。
- **以前每次 `dsh` 重启后卡片都会提示"价格未同步（用内置表）"**：那是竞态——同步状态只存在内存里，重启后的第一次请求只能用内置表回答。0.7.0 起价格表落盘并在启动时读取，重启后立即显示真实价格。

## Development / 开发与自检

```sh
npm test                 # 解析 + 定价 + 价格表 + 卡片布局 + 宿主路由（node --test）
npm run check:pricing    # 联网抓取官方页并打印解析结果；失败时退出码非 0
```

模块划分：`lib/index.js` 宿主路由（同步节流、余额、状态透出）· `lib/pricing.js` 三层价格
（remote/file/seed）· `lib/pricing-store.js` 价格表读写（可编辑的 pricing.json）·
`lib/pricing-remote.js` 官方页抓取与解析 · `lib/client.js` 侧边栏卡片。

官方页再次改版时（自检失败 / 卡片提示"价格未同步"）：

```sh
# 1. 存档新页面（解析失败也会存下来）并看解析结果
node lib/pricing-remote.js --check --save page.html

# 2. 离线复现、迭代解析策略（结构化策略通常无需改动，只有官方改用非表格
#    结构时才需要动 parseFlatPrices()）
node lib/pricing-remote.js --check --html page.html --json

# 3. 把新页面存为 test/fixtures/official-pricing-zh.html，跑 npm test 防回归
#    （若解析出的模型集合变了，再同步更新 lib/pricing.js 里的内置快照——
#      它只用于首次运行生成 pricing.json）
```

> 测试里的"重启"是给模块图打 `?graph=<tag>`（见 `test/host-route.test.mjs`），每个 tag
> 都拿到全新模块实例；peer 依赖 `@deepseek-ai/dsh-credentials` 由 `test/stubs/` 里的
> 替身接管，所以本仓库不需要 node_modules 也能跑宿主逻辑。
>
> DSH 沙箱内 `node --test test/` 可能因禁止子进程管道而报 `spawn EPERM`，此时用
> `node --test --test-isolation=none "test/*.test.mjs"`（Node ≥ 22.8），或逐个跑
> `node test/parse.test.mjs`、`node test/pricing.test.mjs`、`node test/pricing-store.test.mjs`、
> `node test/client-layout.test.mjs`、`node test/host-route.test.mjs`。
>
> 两种偶发失败都属于环境限制，不是插件行为，逐文件运行可稳定复现通过：
> - `host-route` 的"合并写回"用例依赖点击时的 `FORCED_GAP_MS`（30s）节流门；多个测试文件
>   共用同一进程（`--test-isolation=none`）时那条"强制同步"可能被门挡掉。
> - Windows 上原子写（写 `.tmp` 后 `rename`）可能被安全软件短暂占用而报
>   `EPERM ... rename`；重跑即过。
>
> 另：`test/host-route.test.mjs` 与 `test/pricing-store.test.mjs` 都只需要一个可写的临时目录
> （`os.tmpdir()`），若该目录不可写（`mkdtemp ... EPERM`），把 `TEMP`/`TMP` 指到任意可写目录即可。

## Uninstall / 卸载

```sh
dsh plugin --profile web remove @dougen/dsh-deepseek-usage
```

## License

MIT
