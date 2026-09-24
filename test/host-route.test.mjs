// dsh-deepseek-usage — 宿主路由集成测试（node --test）。
//
// 目标：证明"dsh 重启后卡片不再退回内置表"这条链路真的通，覆盖：
//   · 启动时先读本地价格配置表（pricing.json），第一张卡片就用它报价；
//   · 官方页同步成功后把结果**合并回写**到价格表（用户自加条目保留）；
//   · autoUpdate:false 的手动模式完全不联网；
//   · 手改价格表后不必重启，下一次请求即生效（mtime 探测）。
//
// 重启的模拟方式：测试用 registerHooks 给 lib/ 下所有模块打上 `?graph=<tag>`，
// 每个 tag 得到一份全新的模块实例（内存态清零），等价于新开一个 dsh web 进程。
// 网络全部由 fetch 替身接管：余额走假响应，官方价格页走下面构造的小表格。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPeerStubs } from "./stubs/peer-hooks.mjs";

installPeerStubs();

const OFFICIAL_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
const DIR = mkdtempSync(join(tmpdir(), "dsh-usage-host-"));
const pricePath = (name) => join(DIR, `${name}.json`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

after(() => { rmSync(DIR, { recursive: true, force: true }); });

/** 官方页替身：一张结构化小表格（deepseek-flash 高峰 9 / 空闲 4，明显区别于内置表）。 */
const OFFICIAL_HTML = [
  "<html><body><h2>模型细节</h2><table>",
  "<tr><th>计费项</th><th>deepseek-flash</th></tr>",
  "<tr><td>缓存未命中（输入）· 空闲时段</td><td>4元</td></tr>",
  "<tr><td>缓存未命中（输入）· 高峰时段</td><td>9元</td></tr>",
  "<tr><td>缓存命中 · 空闲时段</td><td>0.4元</td></tr>",
  "<tr><td>缓存命中 · 高峰时段</td><td>0.9元</td></tr>",
  "<tr><td>输出 · 空闲时段</td><td>16元</td></tr>",
  "<tr><td>输出 · 高峰时段</td><td>32元</td></tr>",
  "</table></body></html>",
].join("\n");

/** 价格表条目：[高峰, 空闲]。 */
const entry = (peak, idle, cachePeak = 1, cacheIdle = 0.5, outPeak = 20, outIdle = 10) => ({
  input: [peak, idle],
  cacheRead: [cachePeak, cacheIdle],
  cacheWrite: 0,
  output: [outPeak, outIdle],
});

/**
 * 按"当前是高峰还是空闲"从 [高峰, 空闲] 二元组里取值。
 *
 * 这几条用例跑在真实时钟上，而峰谷按北京时间切换（工作日 9–12、14–18 为高峰）。
 * 以前这里把"高峰档"写死，导致中午/下午/晚上跑测试必然失败；改成用响应里的
 * body.peak 选档位后，任何时刻跑都成立。
 */
const tierOf = (body, pair) => pair[body.peak ? 0 : 1];

/** 官方页替身里 deepseek-flash 的 [高峰, 空闲] 输入 / 输出价。 */
const FLASH_INPUT = [9, 4];
const FLASH_OUTPUT = [32, 16];

let pricingFetches = 0;
/** 官方页响应延迟：让"第一次请求时后台同步仍在进行"这件事可确定复现。 */
let pricingDelayMs = 0;

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("api-docs.deepseek.com")) {
    pricingFetches += 1;
    if (pricingDelayMs > 0) await sleep(pricingDelayMs);
    return new Response(OFFICIAL_HTML, { status: 200, headers: { "content-type": "text/html" } });
  }
  if (u.includes("/user/balance")) {
    return new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: "35.56", granted_balance: "0", topped_up_balance: "35.56" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`测试替身没预期的请求：${u}`);
};

/** 写一份价格表文件。 */
function writePriceFile(path, models, extra = {}) {
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    autoUpdate: true,
    updatedAt: 1789090582880,
    updatedFrom: OFFICIAL_URL,
    strategy: "table",
    models,
    ...extra,
  }, null, 2)}\n`, "utf8");
}

/**
 * 起一个"插件实例"（等价于新开一个 dsh web 进程），返回可直接调用路由的 request()。
 * @param tag 模块图标签（每个 tag = 一次重启）
 * @param model 假 agentDefaultModel 返回的当前模型
 */
async function startHost(tag, model = "deepseek-flash") {
  const mod = await import(`../lib/index.js?graph=${tag}`);
  let handler = null;
  const logs = [];
  const ctx = {
    logger: { info: (m) => logs.push({ level: "info", message: String(m) }), warn: (m) => logs.push({ level: "warn", message: String(m) }) },
    effect: (fn) => { fn(); return () => {}; },
    webServer: { register: (route) => { handler = route.handler; return () => {}; } },
    get: (name) => (name === "agentDefaultModel" ? { currentSelection: () => ({ provider: "deepseek-official", model }) } : void 0),
    credentials: { resolve: async () => ({ value: "sk-test" }) },
  };
  mod.apply(ctx);
  assert.ok(handler, "apply() 应注册 GET /api/deepseek-usage");
  return {
    logs,
    /** query 例：''（卡片轮询）/ '?lang=zh&refresh=1'（点击卡片） */
    request: (query = "?lang=zh") => new Promise((resolve, reject) => {
      const req = { method: "GET", headers: { host: "127.0.0.1:3080" }, url: `/api/deepseek-usage${query}` };
      const res = {
        writeHead: () => {},
        end: (body) => {
          try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
        },
      };
      Promise.resolve(handler(req, res)).catch(reject);
    }),
  };
}

test("重启后第一张卡片用本地价格表报价（回归：这里以前会退回内置表并提示未同步）", async () => {
  const file = pricePath("restart");
  writePriceFile(file, { "deepseek-flash": entry(7, 3, 0.9, 0.5, 30, 12) });
  process.env.DEEPSEEK_USAGE_PRICE_FILE = file;
  pricingDelayMs = 60;

  try {
    const host = await startHost("restart");
    const body = await host.request();                    // 卡片挂载时的那次请求（不强制刷新）
    assert.equal(body.ok, true);
    assert.equal(body.pricing.source, "file", "重启后应直接用本地价格表，而不是内置种子表");
    assert.equal(body.pricing.via, "file");
    assert.equal(body.pricing.mode, "auto");
    assert.equal(body.pricing.syncing, true, "此刻官方页正在后台拉取，界面据此不误报未同步");
    assert.equal(body.pricing.syncOk, false);
    assert.equal(body.pricing.layerAt, 1789090582880, "layerAt 说明这份价是什么时候同步的");
    assert.equal(body.tier.input, tierOf(body, [7, 3]), "档单价来自价格表文件（按当前峰谷取对应档）");
    assert.equal(body.tier.output, tierOf(body, [30, 12]));
    assert.equal(body.pricing.file.path, file, "路径透出给界面，方便知道去哪儿改价");
    assert.equal(body.pricing.file.models, 1);
    assert.equal(body.balance.total, 35.56);
    assert.equal(body.errors.length, 0);
    await sleep(150);                                     // 让后台同步落地
  } finally {
    pricingDelayMs = 0;
  }
});

test("响应带 next（倒计时数据源）：字段自洽，且界面拿到的就是这几个数", async () => {
  // 卡片倒计时用 next.at 驱动；old 版本没有这个字段，客户端会本地兜底。
  const file = pricePath("next-field");
  writePriceFile(file, { "deepseek-flash": entry(7, 3, 0.9, 0.5, 30, 12) });
  process.env.DEEPSEEK_USAGE_PRICE_FILE = file;

  const host = await startHost("next-field");
  const body = await host.request();

  assert.ok(body.next && typeof body.next === "object", "响应必须带 next");
  assert.equal(typeof body.next.peak, "boolean", "next.peak = 切换后所处的时段");
  assert.ok(Number.isFinite(body.next.at), "next.at 必须是时间戳");
  assert.ok(Number.isFinite(body.next.ms), "next.ms 必须是剩余毫秒");
  assert.ok(body.next.at > body.updatedAt, "切换时刻必须在未来");
  assert.equal(body.next.ms, body.next.at - body.updatedAt, "ms 与 at/updatedAt 自洽");
  assert.notEqual(body.next.peak, body.peak, "切换后的时段必须与当前相反");
  assert.ok(body.next.ms <= 8 * 24 * 3600 * 1000, "最长空档不超过 8 天（周五晚 → 周一早）");
  assert.equal(typeof body.peak, "boolean", "peak 字段保持向后兼容");
  assert.equal(body.errors.length, 0, "未知模型的内部细节不再进 errors");
});

test("官方页同步成功后：合并回写价格表（用户自加条目保留），下个进程直接用回写结果", async () => {
  const file = pricePath("writeback");
  writePriceFile(file, {
    "deepseek-flash": entry(7, 3, 0.9, 0.5, 30, 12),
    "my-gateway-model": entry(1, 1, 0.1, 0.1, 2, 2),   // 用户自己加的中转价格
  });
  process.env.DEEPSEEK_USAGE_PRICE_FILE = file;

  const host = await startHost("writeback-a");
  const forced = await host.request("?lang=zh&refresh=1");   // 点击卡片：强制同步并等待
  assert.equal(forced.pricing.source, "remote", "点击后应拿到本次官方价");
  assert.equal(forced.pricing.syncOk, true);
  assert.equal(forced.tier.input, tierOf(forced, FLASH_INPUT), "官方页输入价（按当前峰谷取对应档）");
  assert.equal(forced.pricing.file.models, 2, "回写后表里应有 2 个模型");

  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(onDisk.models["deepseek-flash"].input, [9, 4], "官方条目覆盖同名项");
  assert.deepEqual(onDisk.models["my-gateway-model"].input, [1, 1], "用户自加条目必须保留");
  assert.equal(onDisk.updatedFrom, OFFICIAL_URL);
  assert.equal(onDisk.strategy, "table");
  assert.ok(onDisk.updatedAt >= 1789090582880);

  // 模拟重启：全新模块实例读同一份价格表
  const restarted = await startHost("writeback-b");
  const body = await restarted.request();
  assert.equal(body.pricing.source, "file", "重启后先吃本地价格表");
  assert.equal(body.tier.input, tierOf(body, FLASH_INPUT), "用的是回写后的官方价，而不是内置/旧价");
  assert.equal(body.pricing.file.updatedFrom, OFFICIAL_URL);
});

test("手动模式（autoUpdate:false）：不联网，完全按价格表报价", async () => {
  const file = pricePath("manual");
  writePriceFile(file, { "deepseek-flash": entry(11, 5, 1.1, 0.6, 33, 15) }, { autoUpdate: false, updatedFrom: "manual" });
  process.env.DEEPSEEK_USAGE_PRICE_FILE = file;

  const before = pricingFetches;
  const host = await startHost("manual");
  const body = await host.request();
  assert.equal(body.pricing.mode, "manual");
  assert.equal(body.pricing.source, "file");
  assert.equal(body.pricing.syncing, false);
  assert.equal(body.tier.input, tierOf(body, [11, 5]));
  assert.equal(body.pricing.file.autoUpdate, false);
  await sleep(80);
  assert.equal(pricingFetches, before, "手动模式不应发起任何官方页请求");
});

test("手改价格表后免重启生效（mtime 探测），且改坏文件时不覆盖、不崩", async () => {
  const file = pricePath("hotreload");
  // 用 deepseek-chat：它不在官方页替身里，因此取价始终落在"本地价格表"这一层，便于观察重载
  writePriceFile(file, { "deepseek-chat": entry(5, 2, 0.6, 0.3, 14, 7), "deepseek-flash": entry(9, 4, 0.9, 0.4, 32, 16) });
  process.env.DEEPSEEK_USAGE_PRICE_FILE = file;

  const host = await startHost("hotreload", "deepseek-chat");
  const first = await host.request();
  assert.equal(first.pricing.source, "file");
  assert.equal(first.tier.input, tierOf(first, [5, 2]));
  await sleep(120);                                    // 等后台同步与回写落地，避免和手改互相踩

  // 手改价格表
  await sleep(20);
  writePriceFile(file, { "deepseek-chat": entry(8, 3, 0.9, 0.4, 18, 9) });
  const second = await host.request();
  assert.equal(second.tier.input, tierOf(second, [8, 3]), "改完价格表，下一次请求就应生效");

  // 改坏：保持上一次的价格，且不覆盖用户的文件
  await sleep(20);
  writeFileSync(file, "{ 我手滑了", "utf8");
  const third = await host.request();
  assert.equal(third.tier.input, tierOf(third, [8, 3]), "坏文件不应让卡片崩掉或改变价格");
  assert.equal(readFileSync(file, "utf8"), "{ 我手滑了", "坏文件不被覆盖，等用户自己修");
  assert.ok(host.logs.some((l) => l.level === "warn" && l.message.includes("无法解析")), "应留下告警日志");
});

test("首次运行（没有价格表）：用内置快照生成可编辑的 pricing.json", async () => {
  const file = pricePath("first-run");
  process.env.DEEPSEEK_USAGE_PRICE_FILE = file;
  pricingDelayMs = 60;   // 让"生成内置快照"与"后台同步回写"两步可分别观察

  try {
    const host = await startHost("first-run");
    const body = await host.request();
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(onDisk.models["deepseek-flash"], "应写入内置快照");
    assert.equal(onDisk.autoUpdate, true);
    assert.equal(onDisk.updatedFrom, "built-in");
    assert.ok(typeof onDisk.$comment === "string" && onDisk.$comment.includes("autoUpdate"), "文件里应有格式说明");
    assert.equal(body.pricing.file.models, Object.keys(onDisk.models).length);
    assert.equal(body.pricing.source, "file", "第一张卡片就用刚生成的表（等价于内置快照）");

    await sleep(220);
    const after = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(after.updatedFrom, OFFICIAL_URL, "随后官方同步成功，会把官方价回写到同一份表里");
    assert.deepEqual(after.models["deepseek-flash"].input, [9, 4]);
  } finally {
    pricingDelayMs = 0;
  }
});
