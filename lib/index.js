/**
 * dsh-deepseek-usage — host half.
 *
 * 注册一个 HTTP 路由：
 *
 *   GET /api/deepseek-usage[?lang=zh|en]
 *   GET /api/deepseek-usage/holidays
 *
 * 返回（JSON）：
 *   {
 *     ok: true,
 *     balance: { isAvailable, total, currency, granted, toppedUp },  // 官方余额接口（API Key）
 *     tier: { input, cacheRead, cacheWrite, output, model, known },  // 当前模型当前档单价
 *     next: { peak, at, ms },                                        // 距下次峰谷切换（界面倒计时）
 *     peak, peakHours,                                               // 峰谷时段（北京时间）
 *     updatedAt, errors,
 *     pricing: { via, requested, used, known },                      // 【内部诊断】界面不再消费
 *   }
 *
 * 界面只使用 balance / tier / next / peak / errors：插件内部的取价路径属于诊断信息，
 * 保留在响应里供排查与测试，但不出现在 UI 上。
 * errors 只放"用户能理解且需要行动"的余额类失败，不再包含"模型不在价格表"这类内部细节。
 *
 * `lang` 参数（zh 默认）控制错误消息与峰谷文案的语言；UI 其余文案由
 * client 端（DSH locale 服务）本地化。
 *
 * 单价数据源：lib/pricing.js 的内置 PRICE_TABLE（DeepSeek 官方峰谷定价快照）。
 * 官方调价时随插件版本更新该表——不联网抓取、不读写本地价格配置文件。
 * 官方改名的旧模型 id（如 deepseek-v4-flash）按 MODEL_ALIASES 映射到现名计价。
 * 峰谷时段（周一至周五、不含法定节假日 9–12、14–18，北京时间）见 lib/pricing.js。
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
  HOLIDAY_RANGES,
  hasHolidayYear,
  isPeak,
  nextChange,
  unitAt,
} from "./pricing.js";

const name = "dsh-deepseek-usage";
const inject = ["credentials", "webServer"];

const PUBLIC_BASE_URL = "https://api.deepseek.com";
/** 与 llm-deepseek 适配器对齐的环境变量覆盖。注意：指向第三方网关时 API Key 会发给该地址。 */
const BASE_URL_ENV = "DEEPSEEK_BASE_URL";
const API_KEY_REF = credentialRef("DEEPSEEK_API_KEY");
const BALANCE_PATH = "/user/balance";
const ROUTE_PATH = "/api/deepseek-usage";
/** 放假日期路由（浏览器侧启动拉一次，保证两边同一份日期表）。 */
const HOLIDAYS_PATH = "/api/deepseek-usage/holidays";
const TIMEOUT_MS = 15000;

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

/** 北京时间年份。 */
function beijingYear(ms = Date.now()) {
  return new Date(ms + SHANGHAI_OFFSET_MS).getUTCFullYear();
}

/**
 * 放假日期表是否覆盖了今年：没覆盖就告警一次——否则节假日白天会被当成高峰时段，
 * 卡片显示的高峰价比实际高，且无从察觉（见 lib/pricing.js 的 HOLIDAY_RANGES）。
 */
function warnHolidayCoverage(ctx) {
  const year = beijingYear();
  if (hasHolidayYear(year)) return;
  ctx.logger.warn(
    `dsh-deepseek-usage: 内置放假日期表未覆盖 ${year} 年（仅收录到 ${HOLIDAY_RANGES.at(-1)?.[1] ?? "未知"}）`
      + `，${year} 年法定节假日白天会被当作高峰时段：请按国务院办公厅通知更新 lib/pricing.js 的 HOLIDAY_RANGES`
      + `（并同步 lib/client.js 的镜像表）`,
  );
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

/** 解析 ?lang= 参数。 */
function resolveQuery(req) {
  const url = req.url ?? "";
  const q = url.indexOf("?");
  const kv = q === -1 ? [] : url.slice(q + 1).split("&");
  let lang = "zh";
  for (const item of kv) {
    if (item === "lang=en") lang = "en";
  }
  return { lang };
}

function apply(ctx) {
  try {
    warnHolidayCoverage(ctx);
  } catch { /* 告警失败不影响卡片 */ }

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: HOLIDAYS_PATH,
      handler: async (req, res) => {
        if (!isLocalHost(req)) return sendJson(res, 403, { ok: false, error: "forbidden", message: "仅允许本机访问" });
        sendJson(res, 200, { ok: true, ranges: HOLIDAY_RANGES });
      },
    }),
    "dsh-deepseek-usage: holidays route",
  );

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

          const { lang } = resolveQuery(req);
          const msg = MESSAGES[lang] || MESSAGES.zh;

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
            // 【内部诊断】取价路径：界面不再展示（卡片去技术化），保留字段
            // 供排查问题与回归测试使用。
            pricing: {
              via: unit.via,                        // exact | alias | family | fallback
              requested: unit.requested,            // 当前启用的模型 id
              used: unit.model,                     // 实际取价使用的模型 id
              known: unit.known,                    // false = 不在内置表里，按 deepseek-chat 计价
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
