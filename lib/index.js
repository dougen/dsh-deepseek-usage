/**
 * dsh-deepseek-usage — host half.
 *
 * 注册一个 HTTP 路由：
 *
 *   GET /api/deepseek-usage[?lang=zh|en][&refresh=1]
 *
 * 返回（JSON）：
 *   {
 *     ok: true,
 *     balance: { isAvailable, total, currency, granted, toppedUp },  // 官方余额接口（API Key）
 *     tier: { input, cacheRead, cacheWrite, output, model, known },  // 当前模型当前档单价
 *     next: { peak, at, ms },                                        // 距下次峰谷切换（界面倒计时）
 *     peak, peakHours,                                               // 峰谷时段（北京时间）
 *     updatedAt, errors,
 *     pricing: { source, via, requested, used, syncOk, syncing, syncedAt, layerAt,
 *                mode, file: { path, updatedAt, ... } },             // 【内部诊断】界面不再消费
 *   }
 *
 * 界面只使用 balance / tier / next / peak / errors：插件内部的计价来源、同步状态、
 * 价格表位置属于诊断信息，保留在响应里供排查与测试，但不出现在 UI 上。
 * errors 只放"用户能理解且需要行动"的余额类失败，不再包含"模型不在价格表"这类内部细节。
 *
 * `lang` 参数（zh 默认）控制错误消息与峰谷文案的语言；UI 其余文案由
 * client 端（DSH locale 服务）本地化。
 *
 * 单价数据源（0.7.0 起，三层：remote → file → seed）：
 * - 本地价格配置表（lib/pricing-store.js）：`<DSH_HOME>/dsh-deepseek-usage/pricing.json`
 *   （可用 DEEPSEEK_USAGE_PRICE_FILE 覆盖）。插件启动时先读它并注入 pricing.setFilePrices()，
 *   所以**重启后卡片立刻就有价格**（上次同步到的官方价 / 用户手改的价），不会再退回内置表。
 *   首次运行会把内置快照写进该文件，方便用户直接编辑；文件被手改后无需重启，下次请求
 *   （点击卡片即可）会按 mtime 自动重载。
 * - 默认从 DeepSeek 官方"模型 & 价格"页自动同步（lib/pricing-remote.js）：
 *   每天首次成功同步一次，失败按 10 分钟退避重试；请求带 refresh=1（点击卡片）
 *   时立即重拉并等待结果，便于官方刚调价后手动跟新。同步成功后**合并回写**本地价格表
 *   （官方页列出的模型覆盖同名条目，用户自加条目保留），下次重启即可直接用。
 * - 解析优先走"结构化表格"策略（对官方改版排版不敏感），失败再退回文本策略；
 *   两者都失败才使用上一层的价格（本地表 / 内置种子表 lib/pricing.js）。
 * - 拉取/解析失败不打扰用户：记录日志、保留上次成功数据或本地/内置表，并通过
 *   pricing.syncOk / pricing.source 让界面提示"当前价格未同步"，不静默展示旧价。
 * - 本地价格表里 autoUpdate=false 即"手动模式"：完全不联网，档单价完全以该表为准。
 * - 官方改名的旧模型 id（如 deepseek-v4-flash）按 MODEL_ALIASES / 价格表 aliases 映射到
 *   现名计价。峰谷时段（周一至周五 9–12、14–18，北京时间）见 lib/pricing.js。
 *
 * 数据源：余额来自 DeepSeek 官方 GET /user/balance（API Key 经凭证服务解析，
 * 与 llm-deepseek 同一引用，不出本机）。本插件仅支持 DeepSeek 官方平台余额显示。
 *
 * 安全：路由仅接受本机 Host（127.0.0.1 / localhost / ::1），拦截 DNS
 * rebinding 与 0.0.0.0 绑定下的局域网访问。
 */
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  SHANGHAI_OFFSET_MS,
  DEFAULT_MODEL,
  PEAK_HOURS_TEXT,
  PEAK_HOURS_TEXT_EN,
  filePriceMeta,
  isPeak,
  nextChange,
  remotePriceMeta,
  seedAliases,
  seedPrices,
  setFilePrices,
  setRemotePrices,
  unitAt,
} from "./pricing.js";
import { loadPriceTable, priceTableStat, savePriceTable } from "./pricing-store.js";
import { fetchOfficialPrices } from "./pricing-remote.js";

const name = "dsh-deepseek-usage";
const inject = ["credentials", "webServer"];

const PUBLIC_BASE_URL = "https://api.deepseek.com";
/** 与 llm-deepseek 适配器对齐的环境变量覆盖。注意：指向第三方网关时 API Key 会发给该地址。 */
const BASE_URL_ENV = "DEEPSEEK_BASE_URL";
const API_KEY_REF = credentialRef("DEEPSEEK_API_KEY");
const BALANCE_PATH = "/user/balance";
const ROUTE_PATH = "/api/deepseek-usage";
const TIMEOUT_MS = 15000;

/** 官方价格页抓取超时。 */
const REMOTE_TIMEOUT_MS = 12000;
/** 手动（点击）重拉的最小间隔，避免连点打爆官方文档站。 */
const FORCED_GAP_MS = 30 * 1000;
/** 自动同步失败后的重试间隔（成功后当天不再自动重试）。 */
const RETRY_GAP_MS = 10 * 60 * 1000;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

/** 错误消息字典（zh/en）。只保留"余额为什么拿不到"这类用户能理解、且需要行动的信息；
 *  插件内部细节（计价来源、同步状态等）不再作为错误推给界面。 */
const MESSAGES = {
  zh: {
    noKey: "未配置 DEEPSEEK_API_KEY",
    balanceHttp: (status) => `余额接口 HTTP ${status}`,
    balanceFail: (detail) => `余额获取失败: ${detail}`,
  },
  en: {
    noKey: "DEEPSEEK_API_KEY is not configured",
    balanceHttp: (status) => `Balance API HTTP ${status}`,
    balanceFail: (detail) => `Failed to fetch balance: ${detail}`,
  },
};

// ---- 官方价格自动同步状态（进程内缓存；每日首次成功一次，失败按间隔重试） ----
let remoteInFlight = null;   // 进行中的拉取 promise（合并并发）
let remoteDay = "";          // 上次"自动同步成功"的北京日期键
let lastAutoAt = 0;          // 上次自动尝试时刻（失败后按 RETRY_GAP_MS 退避）
let lastForcedAt = 0;        // 上次手动重拉时刻
/** 同步状态（透出到界面：同步失败时让用户看到"当前是内置/旧价"，而不是静默展示）。 */
let remoteStatus = { ok: false, at: 0, error: null, models: 0, strategy: null };

// ---- 本地价格配置表状态（进程内镜像；文件才是持久层，见 lib/pricing-store.js） ----
/** 本地价格表当前状态：路径 / 上次写入时间 / mtime（探测手改）/ 模型数 / 是否自动同步。 */
let fileState = { path: "", exists: false, updatedAt: null, updatedFrom: null, mtimeMs: 0, models: 0, autoUpdate: true };

/** 把一份读取结果注入 pricing 层，并刷新进程内镜像。 */
function applyPriceFile(loaded, mtimeMs) {
  const table = loaded.table;
  setFilePrices(
    table.models,
    {
      path: loaded.path,
      updatedAt: table.updatedAt,
      source: table.updatedFrom,
      strategy: table.strategy,
      autoUpdate: table.autoUpdate,
      version: table.version,
    },
    table.aliases,
  );
  fileState = {
    path: loaded.path,
    exists: true,
    updatedAt: table.updatedAt,
    updatedFrom: table.updatedFrom,
    mtimeMs: mtimeMs ?? priceTableStat({ path: loaded.path }).mtimeMs,
    models: Object.keys(table.models).length,
    autoUpdate: table.autoUpdate !== false,
  };
  return fileState;
}

/**
 * 启动时载入本地价格配置表：有 → 直接注入（重启后卡片立刻有价）；没有 → 用内置快照
 * 生成一份，让用户有个可直接编辑的起点；损坏 → 只记日志、不覆盖文件（避免毁掉用户
 * 正在编辑的内容），内存里仍用内置快照兜底。
 */
function initPriceFile(ctx) {
  const loaded = loadPriceTable();
  fileState.path = loaded.path;
  for (const warning of loaded.warnings ?? []) ctx.logger.warn(`dsh-deepseek-usage: ${warning}`);

  if (loaded.table) {
    applyPriceFile(loaded);
    if (loaded.table.autoUpdate === false) {
      ctx.logger.info(`dsh-deepseek-usage: 已载入本地价格表 ${loaded.path}（${fileState.models} 个模型，手动模式：不再联网同步）`);
    } else {
      ctx.logger.info(
        `dsh-deepseek-usage: 已载入本地价格表 ${loaded.path}（${fileState.models} 个模型，上次写入 ${fileState.updatedAt ? new Date(fileState.updatedAt).toISOString() : "未知"}）`,
      );
    }
    return;
  }

  const seed = { models: seedPrices(), aliases: seedAliases() };
  if (loaded.exists) {
    ctx.logger.warn(`dsh-deepseek-usage: 本地价格表无法解析（${loaded.error}），本次先用内置快照，文件未被覆盖：${loaded.path}`);
    setFilePrices(seed.models, { path: loaded.path, updatedAt: null, source: "built-in", strategy: "seed", autoUpdate: true }, seed.aliases);
    fileState = {
      ...fileState,
      exists: true,
      updatedFrom: "built-in",
      models: Object.keys(seed.models).length,
      autoUpdate: true,
      mtimeMs: priceTableStat({ path: loaded.path }).mtimeMs, // 用户改好文件后 mtime 变化即可自动重载
    };
    return;
  }

  try {
    const written = savePriceTable({
      models: seed.models,
      aliases: seed.aliases,
      updatedAt: Date.now(),
      updatedFrom: "built-in",
      strategy: "seed",
      autoUpdate: true,
    });
    applyPriceFile({ path: written.path, table: written.doc });
    ctx.logger.info(`dsh-deepseek-usage: 未找到本地价格表，已用内置快照生成 ${written.path}（可手动编辑，autoUpdate=false 可关闭自动同步）`);
  } catch (error) {
    ctx.logger.warn(`dsh-deepseek-usage: 无法写入本地价格表 ${loaded.path}（${error instanceof Error ? error.message : String(error)}），本次用内置快照`);
    setFilePrices(seed.models, { path: loaded.path, updatedAt: null, source: "built-in", strategy: "seed", autoUpdate: true }, seed.aliases);
    fileState = { ...fileState, updatedFrom: "built-in", models: Object.keys(seed.models).length };
  }
}

/**
 * 手改价格表后免重启生效：每次请求先比 mtime，变了就重载（一次 stat，成本可忽略）。
 * 只重载"能解析"的文件；解析失败保持现状并记日志。
 */
function reloadPriceFileIfChanged(ctx) {
  if (!fileState.path) return;
  const stat = priceTableStat({ path: fileState.path });
  if (!stat.exists || stat.mtimeMs === fileState.mtimeMs) return;
  const loaded = loadPriceTable({ path: fileState.path });
  if (!loaded.table) {
    fileState.mtimeMs = stat.mtimeMs; // 别每请求都重读坏文件
    ctx.logger.warn(`dsh-deepseek-usage: 本地价格表改动后无法解析，继续用上一次的价格：${loaded.error}`);
    return;
  }
  applyPriceFile(loaded, stat.mtimeMs);
  for (const warning of loaded.warnings ?? []) ctx.logger.warn(`dsh-deepseek-usage: ${warning}`);
  ctx.logger.info(`dsh-deepseek-usage: 本地价格表已重新载入 ${fileState.path}（${fileState.models} 个模型）`);
}

/**
 * 把官方同步结果合并回写本地价格表（官方页列出的模型覆盖同名条目，用户自加条目保留），
 * 并同步刷新内存里的 file 层——这样"这次同步失败"的后续请求也还能用上最新一份官方价。
 */
function persistOfficialPrices(ctx, models, meta) {
  try {
    const written = savePriceTable({
      models,
      updatedAt: meta.fetchedAt || Date.now(),
      updatedFrom: meta.source,
      strategy: meta.strategy,
    });
    applyPriceFile({ path: written.path, table: written.doc }, priceTableStat({ path: written.path }).mtimeMs);
    ctx.logger.info(`dsh-deepseek-usage: 官方价格已回写本地价格表 ${written.path}（共 ${fileState.models} 个模型）`);
  } catch (error) {
    ctx.logger.warn(`dsh-deepseek-usage: 官方价格回写本地价格表失败（本次仍按内存里的官方价显示）：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 北京时间日期键（yyyy-mm-dd）。 */
function beijingDayKey(ms) {
  const d = new Date(ms + SHANGHAI_OFFSET_MS);
  const m = `${d.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${d.getUTCDate()}`.padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

/**
 * 保证官方价格已同步：每天首次自动拉取一次，失败则按 RETRY_GAP_MS 退避重试；
 * force（点击卡片 refresh=1）时立即重拉并等待。
 * 拉取成功 → pricing.setRemotePrices() 注入 + 合并回写本地价格表；失败 → 记日志并记录
 * 状态，继续用本地表/上次数据，同时把失败状态透出到界面。
 * 注意：非强制（自动）路径不在请求内等待拉取结果，界面用 pricing.syncing 表示"正在同步"，
 * 免得把一次正常的后台刷新误报成"未同步"。
 */
async function refreshRemote(ctx, force) {
  if (!fileState.autoUpdate) return;                         // 手动模式：完全不联网
  const now = Date.now();
  if (!force) {
    if (remoteDay === beijingDayKey(now)) return;            // 今天已成功同步过
    if (now - lastAutoAt < RETRY_GAP_MS) return;             // 上次失败，退避中
  }
  if (force && now - lastForcedAt < FORCED_GAP_MS) return;   // 防连点
  if (force) lastForcedAt = now;
  if (remoteInFlight) {
    if (force) { try { await remoteInFlight; } catch { /* 已吞错 */ } }
    return;
  }
  lastAutoAt = now;
  const task = (async () => {
    try {
      const { models, meta } = await fetchOfficialPrices({ timeoutMs: REMOTE_TIMEOUT_MS });
      setRemotePrices(models, meta);
      remoteDay = beijingDayKey(Date.now());
      remoteStatus = {
        ok: true,
        at: meta.fetchedAt || Date.now(),
        error: null,
        models: Object.keys(models).length,
        strategy: meta.strategy || null,
      };
      ctx.logger.info(
        `dsh-deepseek-usage: 官方价格已同步（${Object.keys(models).length} 个模型，策略 ${meta.strategy}，来源 ${meta.source}）`,
      );
      persistOfficialPrices(ctx, models, meta);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      remoteStatus = { ...remoteStatus, ok: false, error: message };
      ctx.logger.warn(`dsh-deepseek-usage: 官方价格同步失败，沿用本地价格表/上次价格: ${message}`);
    } finally {
      remoteInFlight = null;
    }
  })();
  remoteInFlight = task;
  if (force) {
    try { await task; } catch { /* 已吞错 */ }
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function balanceUrl() {
  const base = process.env[BASE_URL_ENV] ?? PUBLIC_BASE_URL;
  return `${base.replace(/\/+$/, "")}${BALANCE_PATH}`;
}

/** 容忍字符串/数字，返回有限数或 NaN。 */
function toFinite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** 仅接受本机 Host（127.0.0.1 / localhost / ::1），拦截 DNS rebinding 与局域网访问。 */
function isLocalHost(req) {
  const raw = req.headers.host;
  if (typeof raw !== "string" || raw === "") return false;
  let host = raw.toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return false;
    host = host.slice(1, end);
  } else {
    const idx = host.lastIndexOf(":");
    if (idx !== -1) host = host.slice(0, idx);
  }
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** 解析 ?lang= / ?refresh= 参数。 */
function resolveQuery(req) {
  const url = req.url ?? "";
  const q = url.indexOf("?");
  const kv = q === -1 ? [] : url.slice(q + 1).split("&");
  let lang = "zh";
  let refresh = false;
  for (const item of kv) {
    if (item === "lang=en") lang = "en";
    else if (item === "refresh=1") refresh = true;
  }
  return { lang, refresh };
}

function apply(ctx) {
  // ---- 本地价格配置表：启动即载入（重启后卡片立刻有价，不再退回内置表）----
  try {
    initPriceFile(ctx);
  } catch (error) {
    ctx.logger.warn(`dsh-deepseek-usage: 载入本地价格表失败，改用内置快照：${error instanceof Error ? error.message : String(error)}`);
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PATH,
      handler: async (req, res) => {
        try {
          // ---- 仅本机访问：拦截 DNS rebinding 与局域网直接访问 ----
          if (!isLocalHost(req)) {
            return sendJson(res, 403, { ok: false, error: "forbidden", message: "仅允许本机访问" });
          }

          const { lang, refresh } = resolveQuery(req);
          const msg = MESSAGES[lang] || MESSAGES.zh;

          // ---- 手改价格表免重启生效（mtime 变了才重读）----
          try {
            reloadPriceFileIfChanged(ctx);
          } catch (error) {
            ctx.logger.warn(`dsh-deepseek-usage: 重载本地价格表失败：${error instanceof Error ? error.message : String(error)}`);
          }

          // ---- 官方价格自动同步（每日首次后台拉取；点击卡片强制并等待；手动模式跳过）----
          await refreshRemote(ctx, refresh);

          // ---- 当前模型当前档单价（展示用）----
          const now = Date.now();
          let model = DEFAULT_MODEL;
          try {
            const adm = ctx.get("agentDefaultModel");
            const selection = adm && typeof adm.currentSelection === "function" ? adm.currentSelection() : void 0;
            if (selection && typeof selection.model === "string") model = selection.model;
          } catch {}
          const unit = unitAt(model, now);

          const errors = [];

          // ---- 余额（官方接口，API Key）----
          const balance = { isAvailable: null, total: null, currency: null, granted: null, toppedUp: null };
          try {
            const hit = await ctx.credentials.resolve(API_KEY_REF);
            if (hit === void 0) {
              errors.push(msg.noKey);
            } else {
              const response = await fetch(balanceUrl(), {
                headers: { Authorization: `Bearer ${hit.value}`, Accept: "application/json" },
                signal: AbortSignal.timeout(TIMEOUT_MS),
              });
              const text = await response.text();
              if (!response.ok) {
                errors.push(msg.balanceHttp(response.status));
              } else {
                const body = JSON.parse(text);
                const infos = body && Array.isArray(body.balance_infos) ? body.balance_infos : [];
                const first = infos[0] || {};
                balance.isAvailable = body?.is_available !== false;
                balance.total = toFinite(first.total_balance);
                balance.currency = typeof first.currency === "string" ? first.currency : null;
                balance.granted = toFinite(first.granted_balance);
                balance.toppedUp = toFinite(first.topped_up_balance);
              }
            }
          } catch (error) {
            errors.push(msg.balanceFail(error instanceof Error ? error.message : String(error)));
          }

          // ---- 档单价：未知模型静默回退 chat 档（属内部兜底，不再作为错误推给界面）----
          const next = nextChange(now);

          sendJson(res, 200, {
            ok: true,
            balance,
            peak: isPeak(now),
            peakHours: lang === "en" ? PEAK_HOURS_TEXT_EN : PEAK_HOURS_TEXT,
            // 距下一次峰谷切换的剩余时间（界面用它在指示灯旁显示倒计时）：
            //   peak = 切换后所处的时段，at = 切换时刻，ms = 剩余毫秒
            next,
            tier: {
              input: unit.input,
              cacheRead: unit.cacheRead,
              cacheWrite: unit.cacheWrite,
              output: unit.output,
              model: unit.model,
              known: unit.known,
            },
            // 【内部诊断】价格来源与同步状态：界面不再展示（卡片去技术化），保留字段
            // 供排查问题与回归测试使用。
            pricing: {
              source: unit.source,                  // remote=本次官方页同步 / file=本地价格表 / seed=内置兜底
              via: unit.via,                        // remote* | file* | alias | seed | fallback
              requested: unit.requested,            // 当前启用的模型 id
              used: unit.model,                     // 实际取价使用的模型 id
              mode: fileState.autoUpdate ? "auto" : "manual", // manual=价格表 autoUpdate:false，不联网
              syncing: remoteInFlight !== null,      // 后台正在拉官方页（别误报成"未同步"）
              syncOk: remoteStatus.ok,
              syncedAt: remoteStatus.at || null,
              layerAt: unit.layerAt,                 // 当前这份单价所属层的时间戳（remote/file）
              strategy: remoteStatus.strategy,      // table=结构化表格 / flat=文本兜底
              modelCount: remoteStatus.models,
              syncError: remoteStatus.error,
              remoteMeta: remotePriceMeta(),
              // 本地价格配置表（用户可编辑；路径透出给界面，方便知道去哪儿改价）
              file: fileState.path
                ? {
                    path: fileState.path,
                    updatedAt: fileState.updatedAt,
                    updatedFrom: fileState.updatedFrom,
                    autoUpdate: fileState.autoUpdate,
                    models: fileState.models,
                  }
                : null,
            },
            updatedAt: now,
            errors,
          });
        } catch (error) {
          ctx.logger.warn("dsh-deepseek-usage: request failed");
          ctx.logger.warn(error);
          sendJson(res, 502, {
            ok: false,
            error: "internal",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }),
    "dsh-deepseek-usage: route",
  );
}

export { name, inject, apply };
