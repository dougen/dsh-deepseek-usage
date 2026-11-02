/**
 * dsh-deepseek-usage — host half.
 *
 * 注册四个 HTTP 路由：
 *
 *   GET  /api/deepseek-usage[?lang=zh|en]   当前模型的账户（余额 / 订阅用量）
 *   GET  /api/deepseek-usage/accounts       插件页元数据：映射目标、未识别路由、OAuth 令牌状态
 *   POST /api/deepseek-usage/token          写入或清除 OAuth 订阅令牌
 *   GET  /api/deepseek-usage/holidays       法定节假日表（浏览器侧启动拉一次）
 *
 * 插件配置（Config）只有一项 providerAliases：把第三方 provider 插件注册的路由 id
 * 映射到本插件支持的能力条目。设置页（Plugins → 本插件 bundle 的行 → 配置）读写
 * 它，也可以直接在 profile 的 cordis.patch.yml 里手写。非法项在激活时只记一条日志，
 * 不阻塞插件启动。插件页的映射编辑器消费 /accounts 的 aliasable（可作为映射目标的
 * 提供商）与 unmapped（检测到但未识别的路由）；OAuth 令牌填写区消费同一响应里的
 * oauth（检测到的提供商及令牌是否已填写）。
 *
 * 主路由返回（JSON）：
 *   {
 *     ok: true,
 *     provider: { id, displayName, kind, reason, via },   // 当前模型的 provider 及查询能力
 *     balance: { isAvailable, total, currency },     // kind=balance 时有效
 *     usage: null | { plan, windows: [{key,percent,resetsAt}] },  // kind=usage/oauth
 *     tier: { input, cacheRead, cacheWrite, output, model, known, currency, window },
 *     next: { peak, at, ms },                        // 距下次计费区间翻转（界面倒计时）
 *     peak,                                          // 当前是否处于较贵的一侧
 *     updatedAt, errors,
 *     pricing: { via, requested, provider, capability, used, known, currency, window } // 【内部诊断】
 *   }
 *
 * provider.via 说明这个路由是怎么被认出来的：`exact`（能力表命中）、`alias`
 * （用户在本插件配置里添加的映射）、`none`（未识别）。识别顺序固定：精确 id 优先，
 * 命中不了才查用户映射；不按名字、不按端点猜。
 *
 * 界面只使用 provider / balance / usage / tier / next / peak / errors：插件内部的取价
 * 路径属于诊断信息，保留在响应里供排查与测试，但不出现在 UI 上。
 * errors 只放"用户能理解且需要行动"的账户类失败，不含任何上游原文——上游错误消息
 * 可能带着凭据片段（undici 会把非法的 Authorization 值写进异常消息），直接透出等于
 * 把 Key 印在侧边栏上。
 *
 * `lang` 参数（zh 默认）只影响错误消息的语言；UI 其余文案由 client 端本地化。
 *
 * 账户数据源（lib/accounts.js 的能力表）：
 *   · 余额类：DeepSeek /user/balance、Moonshot /v1/users/me/balance、
 *     智谱 /api/biz/account/query-customer-account-report、OpenRouter /api/v1/key
 *     （单 Key 无限额时回落 /api/v1/credits）；
 *   · 订阅用量类：Kimi Coding /coding/v1/usages、OpenCode /zen/go/v1/usage、
 *     MiniMax /v1/token_plan/remains——订阅制没有余额接口，只有窗口百分比；
 *   · OAuth 订阅类：Claude Code /api/oauth/usage、Codex /backend-api/wham/usage，
 *     令牌由用户在插件页粘贴，经凭证服务存取（本机 .credentials.yaml），宿主之外
 *     任何位置都看不到它；
 *   · 其余 provider（云厂商 AK/SK、无可用接口的 OAuth-only）不查询，界面说明原因。
 *
 * 单价数据源：lib/pricing.js 的 PRICE_TABLES——一家提供商一份手动采集的快照，
 * DeepSeek 只是其中一条（带峰谷时段与法定节假日口径），代码不分叉。厂商调价时随
 * 插件版本更新——不联网抓取、不读写本地价格配置文件。
 * 只按 provider + 模型 id 精确查表：第三方路由上的 deepseek-* 同名模型按各自规则
 * 扣费，用官方快照算出来的数字与账单无关。表里模型带 schedule 时返回当前区间与
 * 下一次切换（tier.window / next），界面据此画指示灯与倒计时。
 *
 * 安全：所有路由只接受本机来源（见 isTrustedRequest）——与 DSH 自身的 /api 栅栏
 * 同一口径：Host 必须是回环地址或本监听器绑定的地址，跨站请求标记与异源 Origin
 * 一律拒绝。/token  additionally 要求 Content-Type 为 JSON 且 body 有界，
 * 只接受能力表白名单里的 provider，写入只经 credentials.set（见 routeToken）。
 * 另见 README 的"已知限制"：本机其它进程仍可直接访问该端口，这是本地工具的固有边界。
 */
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import z from "@deepseek-ai/schemastery";
import {
  accountCapabilityOf,
  aliasableProviderIds,
  candidateRefsOf,
  makeAccountReader,
  oauthProviderIds,
  oauthProviderOf,
} from "./accounts.js";
import {
  DEFAULT_MODEL,
  HOLIDAY_RANGES,
  hasHolidayCoverage,
  isDeepSeekScheduleModel,
  isPeak,
  nextChange,
  unitAt,
} from "./pricing.js";
import { createProviderResolver, normalizeAliases } from "./providers.js";

const name = "dsh-deepseek-usage";
const inject = ["credentials", "webServer"];

/**
 * 插件配置：把第三方插件注册的 provider 路由映射到本插件支持的提供商。
 *
 * 设置页（Plugins → 本插件 bundle → 行 → 配置）读写这一项；`volatile()` 是
 * host 的 settings.describe 收录该字段、并把表单交给浏览器侧的必要条件。
 * capability 的枚举与设置页下拉共用 aliasableProviderIds()，不另维护一份。
 * 目标可以是 OAuth 提供商（Claude Code / OpenAI Codex）：此时映射只决定账户口径，
 * 凭据引用不参与（令牌由插件页的「订阅令牌」区经 /token 写入凭据服务）。
 *
 * 老宿主的 schemastery 若没有 volatile()，退化成一个普通 schema：配置仍能被校验、
 * 仍然可以手写 YAML，只是没有设置表单——不能因为缺一个修饰符就让插件加载失败。
 */
function buildConfig(z) {
  const field = z.array(z.object({
    provider: z.string().required(),
    capability: z.union(aliasableProviderIds().map((id) => z.const(id))).required(),
    refs: z.array(z.string()).default([]),
  })).default([]);
  return z.object({
    providerAliases: typeof field.volatile === "function" ? field.volatile() : field,
  });
}

const Config = buildConfig(z);

const PUBLIC_BASE_URL = "https://api.deepseek.com";
/** 与 llm-deepseek 适配器对齐的环境变量覆盖。注意：指向第三方网关时 API Key 会发给该地址。 */
const BASE_URL_ENV = "DEEPSEEK_BASE_URL";
const API_KEY_REF = credentialRef("DEEPSEEK_API_KEY");
const BALANCE_PATH = "/user/balance";
const ROUTE_PATH = "/api/deepseek-usage";
const ACCOUNTS_PATH = "/api/deepseek-usage/accounts";
const TOKEN_PATH = "/api/deepseek-usage/token";
/** 放假日期路由（浏览器侧启动拉一次，保证两边同一份日期表）。 */
const HOLIDAYS_PATH = "/api/deepseek-usage/holidays";
const TIMEOUT_MS = 15000;
/** 余额响应体上限：网关返回异常大 body 时不让它占满内存。 */
const MAX_BODY_BYTES = 64 * 1024;
/**
 * 账户快照缓存时长（毫秒）。客户端每 30s 心跳一次，多个标签页/多次点击会重复打
 * 上游接口；缓存把这段时间内的重复请求合并成一次。
 */
const ACCOUNT_CACHE_MS = 10_000;
/**
 * /token 写入体上限：令牌是单行 ASCII，4KiB 足够；与余额响应体上限分开是因为
 * 两者的威胁模型不同（一个是上游返回，一个是本机提交）。
 */
const MAX_TOKEN_BODY_BYTES = 8 * 1024;


const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

/**
 * 错误消息字典（zh/en）。只保留"账户数据为什么拿不到"这类用户能理解、且需要行动的
 * 信息；不拼接任何上游原文或异常消息。
 *
 * `balance*` / `noKey` / `badKey` 是 DeepSeek 官方余额的专属文案，逐字保留：
 * 已有用户与回归测试都认这一套说法。其余提供商走 `account*`，其中
 * `accountNoKey` / `accountNoKeyNamed` 由调用方把引用名填进参数位。
 */
const MESSAGES = {
  zh: {
    noKey: "未配置 DEEPSEEK_API_KEY",
    badKey: "DEEPSEEK_API_KEY 含有非法字符",
    balanceHttp: (status) => `余额接口 HTTP ${status}`,
    balanceTimeout: "余额接口超时",
    balanceNetwork: "余额接口无法连接",
    balancePayload: "余额接口返回了无法解析的内容",
    balanceEmpty: "余额接口没有返回余额",
    balanceUnavailable: "账户当前不可用",
    forbidden: "仅允许本机访问",
    method: "仅支持 GET",
    internal: "插件内部错误",
    accountHttp: (status) => `账户接口 HTTP ${status}`,
    accountTimeout: "账户接口超时",
    accountNetwork: "账户接口无法连接",
    accountPayload: "账户接口返回了无法解析的内容",
    accountEmpty: "账户接口没有返回可用数值",
    accountUnavailable: "账户当前不可用",
    accountNoKey: "未配置该提供商的 API Key",
    accountNoKeyNamed: (name) => `未配置 ${name}`,
    accountNoToken: "尚未填写该提供商的 OAuth 令牌",
    accountNoGrant: "DeepSeek 账号尚未登录：在设置里登录后即可显示余额",
    accountTokenExpired: "OAuth 令牌已失效，请重新填写",
    accountNoApi: (name) => `当前插件不支持 ${name}`,
    tokenUnknownProvider: "不支持的提供商",
    tokenMethod: "仅支持 POST",
    tokenPayload: "请求内容无法解析",
    tokenWritten: "令牌已保存",
    tokenCleared: "令牌已清除",
    tokenFailed: "令牌保存失败",
  },
  en: {
    noKey: "DEEPSEEK_API_KEY is not configured",
    badKey: "DEEPSEEK_API_KEY contains invalid characters",
    balanceHttp: (status) => `Balance API HTTP ${status}`,
    balanceTimeout: "Balance API timed out",
    balanceNetwork: "Balance API is unreachable",
    balancePayload: "Balance API returned an unreadable response",
    balanceEmpty: "Balance API returned no balance",
    balanceUnavailable: "The account is currently unavailable",
    forbidden: "Local access only",
    method: "GET only",
    internal: "Internal plugin error",
    accountHttp: (status) => `Account API HTTP ${status}`,
    accountTimeout: "Account API timed out",
    accountNetwork: "Account API is unreachable",
    accountPayload: "Account API returned an unreadable response",
    accountEmpty: "Account API returned no usable value",
    accountUnavailable: "The account is currently unavailable",
    accountNoKey: "This provider has no API key configured",
    accountNoKeyNamed: (name) => `${name} is not configured`,
    accountNoToken: "This provider has no OAuth token yet",
    accountNoGrant: "Not signed in to a DeepSeek account: sign in to see the balance",
    accountTokenExpired: "The OAuth token is no longer valid; save it again",
    accountNoApi: (name) => `This plugin does not support ${name}`,
    tokenUnknownProvider: "Unsupported provider",
    tokenMethod: "POST only",
    tokenPayload: "The request body could not be read",
    tokenWritten: "Token saved",
    tokenCleared: "Token cleared",
    tokenFailed: "The token could not be saved",
  },
};

/**
 * 放假日期表未覆盖当前年份时告警一次（每天一次）。
 *
 * 在请求路径上检查，而不是只在启动时：进程跨年长跑时，下一年的节假日仍按工作日
 * 计价，而这正是用户真正会看到错误价格的时段——只在启动时告警覆盖不到那一刻。
 */
let lastHolidayWarningDay = "";
function warnHolidayCoverage(ctx) {
  if (hasHolidayCoverage()) return;
  const now = Date.now();
  const day = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (day === lastHolidayWarningDay) return;
  lastHolidayWarningDay = day;
  const year = new Date(now + 8 * 60 * 60 * 1000).getUTCFullYear();
  ctx.logger.warn(
    `dsh-deepseek-usage: 内置放假日期表未覆盖 ${year} 年（仅收录到 ${HOLIDAY_RANGES.at(-1)?.[1] ?? "未知"}）`
      + `，${year} 年法定节假日白天会被当作高峰时段：请按国务院办公厅通知更新 lib/pricing.js 的 HOLIDAY_RANGES`
      + `（并同步 lib/client.js 的镜像表，并把 HOLIDAY_TABLE_THROUGH_YEAR 推到 ${year}）`,
  );
}

function sendJson(res, status, body) {
  // 已经发过响应头时再写一次会抛 ERR_HTTP_HEADERS_SENT，直接结束即可。
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function balanceUrl() {
  const base = process.env[BASE_URL_ENV] ?? PUBLIC_BASE_URL;
  return `${base.replace(/\/+$/, "")}${BALANCE_PATH}`;
}

/**
 * 账号路由（`deepseek-account`）的余额端点，恒为官方源。
 *
 * 宿主只肯把登录 grant 发到它配置的官方推理源（`resolveToken(url)` 校验
 * `destination.origin === inferenceOrigin`，默认 https://api.deepseek.com），
 * 所以这里不能走 `balanceUrl()`：一旦用户把 DEEPSEEK_BASE_URL 指向第三方中转，
 * 账号令牌就会被送到那个地址。自定义基址只对 api-key 路由生效。
 */
function accountBalanceUrl() {
  return `${PUBLIC_BASE_URL}${BALANCE_PATH}`;
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

/**
 * 请求头里的 Host 是否是"本机"。
 *
 * 接受：回环地址（127/8 任意地址、::1、localhost）、本监听器绑定的地址。
 * 与 DSH 自己的 /api 栅栏同一口径（见 app.asar 的 isTrustedApiRequest）：只认回环
 * 会让 `--host <局域网IP>` 与 `--trusted-host` 部署下插件永久 403。
 */
function isLocalHost(req, bindHost) {
  const raw = req.headers.host;
  if (typeof raw !== "string" || raw === "") return false;
  const host = hostNameOf(raw);
  if (host === null) return false;
  if (host === "localhost" || host === "::1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host === "::ffff:127.0.0.1") return true;
  // 监听器绑定的地址（如 --host 10.0.0.7）同样是"自己"。
  if (typeof bindHost === "string" && bindHost !== "") {
    const bind = hostNameOf(bindHost);
    if (bind !== null && bind !== "" && host === bind) return true;
  }
  return false;
}

/**
 * 取 authority 里的主机名：小写、去掉端口与 IPv6 方括号。
 * IPv6 不能按冒号切（`::1` 切出空串），所以先剥方括号再处理。
 */
function hostNameOf(authority) {
  let host = authority.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return null;
    host = host.slice(1, end);
    return host;
  }
  const idx = host.lastIndexOf(":");
  if (idx !== -1 && host.indexOf(":") === idx) host = host.slice(0, idx);
  return host === "" ? null : host;
}

/**
 * 请求是否可以访问本插件的路由。
 *
 * 口径与 DSH 的 /api 栅栏一致：
 *   1. Host 必须是本机（回环或监听器绑定地址）；
 *   2. 浏览器标记为跨站的请求一律拒绝；
 *   3. 带 Origin 时，Origin 必须与 Host 同一 authority。
 * 这样任意网页都无法跨站读走余额，DNS rebinding（Host 变成攻击者域名）同样被挡下。
 */
function isTrustedRequest(req, bindHost) {
  if (!isLocalHost(req, bindHost)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "") {
    let originHost;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return false;
    }
    const host = String(req.headers.host ?? "").toLowerCase();
    if (originHost !== host) return false;
  }
  return true;
}

/** 解析 ?lang= 参数（zh 默认）。 */
function resolveQuery(req) {
  const url = req.url ?? "";
  const q = url.indexOf("?");
  const kv = q === -1 ? [] : url.slice(q + 1).split("&");
  let lang = "zh";
  for (const item of kv) {
    if (item === "lang=en" || item === "lang=en-US" || item === "lang=en-GB") lang = "en";
  }
  return { lang };
}

/**
 * API Key 是否能安全地放进 Authorization 头。
 * 凭据存储允许任意文本（多行值也是合法输入），而非法字符会让 undici 把整个
 * Authorization 值写进异常消息——那道消息会一路流到卡片上。
 */
function isUsableKey(value) {
  if (typeof value !== "string") return false;
  const key = value.trim();
  if (key === "") return false;
  // HTTP 头值只允许可见 ASCII（不含空格与控制字符）。
  return /^[\x21-\x7e]+$/.test(key);
}

/** 响应体超限：与"无法解析"同一类问题。 */
class PayloadTooLargeError extends Error {}

/** 读取响应体，超过上限即视为失败。 */
async function readBoundedText(response, limit = MAX_BODY_BYTES) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new PayloadTooLargeError();
  const text = await response.text();
  // text.length 是 UTF-16 码元数；按字节算才不会让多字节内容绕过上限。
  if (Buffer.byteLength(text, "utf8") > limit) throw new PayloadTooLargeError();
  return text;
}

/**
 * 把 accounts.js 的取数结果归一成宿主侧的失败分类。
 *
 * 分类键保持 accounts.js 的原始值（empty / shape / unavailable / timeout /
 * network / unauthorized），由调用方按自己的文案表映射：DeepSeek 走
 * DEEPSEEK_CODES（既有 `balance*` 契约），其余提供商走 ACCOUNT_CODES。
 */
function normalizeAccountResult(result) {
  if (result.ok) {
    return {
      ok: true,
      balance: result.balance ?? { isAvailable: null, total: null, currency: null },
      usage: result.usage ?? null,
      code: null,
    };
  }
  return { ok: false, balance: null, usage: null, code: result.code ?? "empty" };
}

/** 通用提供商的失败分类 → MESSAGES 的 `account*` 键。 */
const ACCOUNT_CODES = {
  empty: "accountEmpty",
  shape: "accountPayload",
  unavailable: "accountUnavailable",
  timeout: "accountTimeout",
  network: "accountNetwork",
  unauthorized: "accountTokenExpired",
  // 来自 resolveCredential 的三个分类：没配 / 配了但形状非法。
  noKey: "accountNoKey",
  accountNoKey: "accountNoKey",
  accountNoToken: "accountNoToken",
  badKey: "accountPayload",
};

/** 通用提供商的失败分类 → 用户文案。 */
function accountMessage(msg, code) {
  const key = ACCOUNT_CODES[code];
  if (key === undefined) return msg.accountNetwork;
  const text = msg[key];
  return typeof text === "function" ? text() : text;
}

/**
 * 从凭证服务解析第一个可用的引用值。
 *
 * @returns {{ ok: true, value, ref } | { ok: false, code: 'noKey'|'unusable' }}
 *   noKey = 一个都没配；unusable = 配了但形状不能进 HTTP 头。
 */
async function resolveCredential(ctx, refs) {
  for (const ref of refs) {
    let hit;
    try {
      hit = await ctx.credentials.resolve(credentialRef(ref));
    } catch {
      // 单个引用解析失败（服务异常）不阻断其余引用。
      continue;
    }
    if (hit === undefined) continue;
    const value = typeof hit.value === "string" ? hit.value.trim() : "";
    if (value === "") continue;
    if (!isUsableKey(value)) return { ok: false, code: "unusable" };
    return { ok: true, value, ref };
  }
  return { ok: false, code: "noKey" };
}

/**
 * DSH 账号登录留下的 grant 记录，键是 `<scope>/<id>`。
 *
 * `deepseek-account` 路由不认 DEEPSEEK_API_KEY：宿主把邮箱/设备登录换来的令牌写进
 * 这条记录，请求头是 `x-dsh-auth-token`（Bearer 会被上游 401 拒掉）。记录形状由
 * dsh-deepseek-account-platform 写入，令牌在 `payload.token`。
 *
 * 键名写字面量而不经 `credentialKey()`：记录 API 是较新的凭证服务能力，插件仍声明
 * 兼容更早的宿主（package.json 的 peerDependencies），这里的字符串与宿主写入的键
 * 逐字相同，因此不需要为它提高版本门槛，也不会在旧宿主上链接失败。
 */
const ACCOUNT_GRANT_KEY = "deepseek-account-platform/default";

/**
 * 读 DeepSeek 账号登录的 grant 令牌。
 *
 * @returns {{ ok: true, value: string } | { ok: false, code: 'noKey' | 'unusable' }}
 */
async function resolveAccountGrant(ctx) {
  const readRecord = ctx.credentials?.readRecord;
  if (typeof readRecord !== "function") return { ok: false, code: "noKey" };
  let record;
  try {
    record = await readRecord.call(ctx.credentials, ACCOUNT_GRANT_KEY);
  } catch {
    return { ok: false, code: "noKey" };
  }
  const token = typeof record?.payload?.token === "string" ? record.payload.token.trim() : "";
  if (token === "") return { ok: false, code: "noKey" };
  if (!isUsableKey(token)) return { ok: false, code: "unusable" };
  return { ok: true, value: token };
}

/**
 * 账户快照缓存：同一时间窗内多个请求（多标签页、点击、心跳）共用一次上游调用。
 *
 * 只缓存成功结果——失败必须立刻能被下一次请求重试。缓存与在途请求都按
 * `provider + 引用 + Key` 分桶：换 Key 不命中旧缓存，换 provider 也不会。
 */
const accountCache = new Map();
const accountInFlight = new Map();

/** 丢掉过期的缓存条目：换 Key 频繁时 Map 会一直长。 */
function evictStaleCache(now) {
  for (const [key, entry] of accountCache) {
    if (now - entry.at >= ACCOUNT_CACHE_MS) accountCache.delete(key);
  }
}

/** 让某个 provider 的下一次读取重新打上游（令牌写入后调用）。 */
function invalidateAccount(providerId) {
  const prefix = `${providerId}\u0000`;
  for (const key of accountCache.keys()) {
    if (key.startsWith(prefix)) accountCache.delete(key);
  }
  for (const key of accountInFlight.keys()) {
    if (key.startsWith(prefix)) accountInFlight.delete(key);
  }
}

/** 缓存 + 在途合并的公共路径（只缓存成功结果）。 */
async function cachedRead(ctx, bucket, run, now) {
  evictStaleCache(now);
  const cached = accountCache.get(bucket);
  if (cached !== undefined && now - cached.at < ACCOUNT_CACHE_MS) return cached.value;
  const pending = accountInFlight.get(bucket);
  if (pending !== undefined) return pending;
  const request = run()
    .then((value) => {
      if (value.ok) accountCache.set(bucket, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      accountInFlight.delete(bucket);
    });
  accountInFlight.set(bucket, request);
  return request;
}

/**
 * 取一个提供商的账户读数，带缓存与在途合并。
 *
 * `resolution` 是 lib/providers.js 的解析结果（可选）：精确 id 与用户映射都走
 * 同一条取数路径，`capabilityId` 决定端点与缓存桶，`entry` 决定解析函数，
 * `refs` 是候选凭据引用。
 */
async function readAccountCached(ctx, providerId, resolution = null) {
  const entry = resolution?.entry ?? accountCapabilityOf(providerId);
  const capabilityId = resolution?.capabilityId ?? entry?.id ?? providerId;
  const now = Date.now();
  if (entry === null || entry === undefined || entry.kind === "none") {
    return { kind: "none", reason: entry?.reason ?? "unsupported", ok: false, code: "accountNoApi" };
  }

  // DeepSeek 的端点由 DEEPSEEK_BASE_URL 决定，桶 Key 必须带上它，否则改了覆盖
  // 之后还会命中旧地址的缓存。
  const endpointKey = entry.kind === "balance" && capabilityId.startsWith("deepseek") ? balanceUrl() : "";

  if (entry.kind === "oauth") {
    const spec = oauthProviderOf(capabilityId);
    const resolved = await resolveCredential(ctx, [spec.tokenRef]);
    if (!resolved.ok) {
      return { kind: "oauth", ok: false, code: resolved.code === "noKey" ? "accountNoToken" : "badKey" };
    }
    // Codex 的账号标识是可选请求头：配了就带上，没配也照常查。
    let accountId = "";
    if (spec.accountRef !== undefined) {
      const account = await resolveCredential(ctx, [spec.accountRef]);
      if (account.ok) accountId = account.value;
    }
    const bucket = `${capabilityId}\u0000${resolved.ref}\u0000${resolved.value}\u0000${accountId}`;
    const reader = makeAccountReader({ deepseekUrl: balanceUrl() });
    return cachedRead(ctx, bucket, async () => normalizeAccountResult(await reader.read(entry, resolved.value, { accountId })), now);
  }

  // DeepSeek 的账号路由走宿主登录的 grant，不读环境变量里的 API key。
  if (capabilityId === "deepseek-account") {
    const grant = await resolveAccountGrant(ctx);
    if (!grant.ok) {
      return {
        kind: entry.kind,
        ok: false,
        code: grant.code === "unusable" ? "badKey" : "accountNoGrant",
        // 没登录不是"配错了 Key"，ref 留空，文案由 accountNoGrant 给。
        ref: null,
      };
    }
    const url = accountBalanceUrl();
    const bucket = `${capabilityId}\u0000${url}\u0000${grant.value}`;
    const reader = makeAccountReader({ deepseekUrl: url });
    return cachedRead(ctx, bucket, async () => normalizeAccountResult(await reader.read(entry, grant.value)), now);
  }

  const refs = resolution?.refs ?? candidateRefsOf(capabilityId);
  const resolved = await resolveCredential(ctx, refs);
  if (!resolved.ok) {
    return {
      kind: entry.kind,
      ok: false,
      code: resolved.code === "noKey" ? "accountNoKey" : "badKey",
      ref: resolved.code === "noKey" ? refs[0] : null,
    };
  }
  const bucket = `${capabilityId}\u0000${endpointKey}\u0000${resolved.ref}\u0000${resolved.value}`;
  const reader = makeAccountReader({ deepseekUrl: balanceUrl() });
  return cachedRead(ctx, bucket, async () => normalizeAccountResult(await reader.read(entry, resolved.value)), now);
}

/**
 * DeepSeek 官方余额的失败分类映射。
 *
 * accounts.js 的解析器返回 `empty`/`shape`/`unavailable`，而 DeepSeek 的用户可见
 * 文案（`balanceEmpty`/`balancePayload`/`balanceUnavailable`）是既有契约，逐字保留；
 * 其余分类（timeout / network）与通用文案一致。
 */
const DEEPSEEK_CODES = {
  empty: "balanceEmpty",
  shape: "balancePayload",
  unavailable: "balanceUnavailable",
  timeout: "balanceTimeout",
  network: "balanceNetwork",
  unauthorized: "accountTokenExpired",
};

/**
 * DeepSeek 失败分类 → 用户文案。
 *
 * `noKey` / `accountNoKey` / `badKey` 映射回 DeepSeek 专属说法（指出
 * DEEPSEEK_API_KEY 本身）：它们来自 resolveCredential 的通用分类，
 * 而 DeepSeek 的用户可见文案是既有契约，逐字保留。
 */
function deepSeekMessage(msg, snapshot) {
  if (snapshot.code === "noKey" || snapshot.code === "accountNoKey") return msg.noKey;
  if (snapshot.code === "accountNoGrant") return msg.accountNoGrant;
  if (snapshot.code === "badKey") return msg.badKey;
  const key = DEEPSEEK_CODES[snapshot.code];
  if (key === undefined) return msg.balanceNetwork;
  const text = msg[key];
  return typeof text === "function" ? text() : text;
}

function apply(ctx, config = {}) {
  const bindHost = typeof ctx.webServer?.host === "string" ? ctx.webServer.host : "";

  // 用户映射：把第三方插件注册的 provider id 翻译成受支持提供商的账户口径。
  //
  // 必须在**每次请求**时读取，不能在 apply 时拍快照：`providerAliases` 是
  // volatile 字段，Loader 对「只有 volatile 值变化」的配置更新不会重跑 apply，
  // 而是把新值就地写进这里捕获的引用（cordis-plugin-loader 的 _commitVolatile）。
  // 拍快照会让设置页保存后仍按旧映射查询，直到重启宿主。
  const warned = new Set();
  function providersNow() {
    const { aliases, warnings } = normalizeAliases(config?.providerAliases);
    for (const warning of warnings) {
      if (warned.has(warning)) continue;
      warned.add(warning);
      ctx.logger.warn(`dsh-deepseek-usage: ${warning}`);
    }
    return createProviderResolver(aliases);
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: HOLIDAYS_PATH,
      handler: async (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return sendJson(res, 405, { ok: false, error: "method", message: MESSAGES.zh.method });
        }
        if (!isTrustedRequest(req, bindHost)) {
          return sendJson(res, 403, { ok: false, error: "forbidden", message: MESSAGES.zh.forbidden });
        }
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
          if (req.method !== "GET" && req.method !== "HEAD") {
            return sendJson(res, 405, { ok: false, error: "method", message: MESSAGES.zh.method });
          }
          // ---- 仅本机访问：拦截 DNS rebinding、跨站读取与局域网直连 ----
          if (!isTrustedRequest(req, bindHost)) {
            return sendJson(res, 403, { ok: false, error: "forbidden", message: MESSAGES.zh.forbidden });
          }

          const { lang } = resolveQuery(req);
          const msg = MESSAGES[lang] || MESSAGES.zh;

          // 放假日期表过期时告警（每天一次）。放在请求路径上，跨年长跑也能覆盖到。
          try {
            warnHolidayCoverage(ctx);
          } catch { /* 告警失败不影响卡片 */ }

          // ---- 当前模型当前档单价（展示用）----
          let model = DEFAULT_MODEL;
          let provider = "";
          try {
            const adm = ctx.get("agentDefaultModel");
            const selection = adm && typeof adm.currentSelection === "function" ? adm.currentSelection() : void 0;
            if (selection && typeof selection.model === "string") model = selection.model;
            if (selection && typeof selection.provider === "string") provider = selection.provider;
          } catch {}
          // 时刻在账户请求之后再取：请求耗时会跨过峰谷边界，先取会让 peak / 单价 /
          // 倒计时三者互相矛盾（显示橙色高峰灯却给着空闲价）。
          const now = Date.now();
          // provider 解析：精确 id 优先，其次用户映射；未识别时按「不支持」处理。
          // 解析器按请求现建，读取的是 volatile 配置的最新值（见 providersNow）。
          const resolution = providersNow().resolve(provider);
          const entry = resolution?.entry ?? null;
          // 计价按解析后的能力 id 查表：映射到厂商账户的路由复用该厂商的价格快照。
          const unit = unitAt(model, now, entry?.id ?? provider);

          const errors = [];
          const kind = entry?.kind ?? "none";
          const providerInfo = {
            id: provider,
            displayName: entry?.displayName ?? provider,
            kind,
            reason: kind === "none" ? (entry?.reason ?? "unsupported") : null,
            // 这个 provider 是怎么被认出来的：exact（能力表）/ alias（用户映射）/ none。
            via: resolution?.via ?? "none",
          };

          // ---- 当前 provider 的账户数据（余额 / 订阅用量）----
          let balance = { isAvailable: null, total: null, currency: null };
          let usage = null;

          if (kind === "none") {
            // 这个 provider 没有可查的接口：卡片置空并说明原因，不显示任何数字。
            errors.push(msg.accountNoApi(providerInfo.displayName));
          } else if (kind === "oauth") {
            const snapshot = await readAccountCached(ctx, provider, resolution);
            if (snapshot.ok) {
              balance = snapshot.balance ?? balance;
              usage = snapshot.usage ?? null;
            } else {
              errors.push(accountMessage(msg, snapshot.code));
            }
          } else if (entry.id === "deepseek-official" || entry.id === "deepseek-account" || entry.id === "deepseek") {
            // DeepSeek 官方路由：与其他提供商同一条取数路径，但失败文案沿用
            // 既有的 `balance*`（用户可见契约，逐字保留）。
            const snapshot = await readAccountCached(ctx, provider, resolution);
            balance = snapshot.balance ?? balance;
            usage = snapshot.usage ?? null;
            if (!snapshot.ok) {
              errors.push(deepSeekMessage(msg, snapshot));
            }
          } else {
            const snapshot = await readAccountCached(ctx, provider, resolution);
            if (snapshot.ok) {
              balance = snapshot.balance ?? balance;
              usage = snapshot.usage ?? null;
            } else {
              errors.push(
                snapshot.code === "accountNoKey" && snapshot.ref
                  ? msg.accountNoKeyNamed(snapshot.ref)
                  : accountMessage(msg, snapshot.code),
              );
            }
          }

          // ---- 距下一次计费区间翻转（界面用它在指示灯旁显示倒计时）----
          // DeepSeek 官方模型走峰谷表；其它 provider 有分时段计费时由各自的表给出；
          // 不分时段的（window 为 null）不发送倒计时。
          //
          // 订阅制路由没有价格快照，但当前模型如果是 DeepSeek 的峰谷型号，仍然把
          // 时段信息发出去——卡片照旧显示峰谷灯与倒计时（不显示单价）。
          let displayWindow = unit.window;
          if (
            displayWindow === null &&
            (kind === "usage" || kind === "oauth") &&
            isDeepSeekScheduleModel(model)
          ) {
            displayWindow = isPeak(now) ? "peak" : "idle";
          }
          const next = displayWindow === null
            ? { peak: false, at: null, ms: 0 }
            : unit.next ?? nextChange(now);

          sendJson(res, 200, {
            ok: true,
            provider: providerInfo,
            balance,
            usage,
            // peak = 当前是否处于较贵的一侧（DeepSeek 的峰谷、其它 provider 的高峰
            // 时段或优惠时段之外都是这个含义）；不分时段时为 false。
            peak: displayWindow === "peak",
            //   peak = 切换后所处的时段，at = 切换时刻，ms = 剩余毫秒
            next,
            tier: {
              input: unit.input,
              cacheRead: unit.cacheRead,
              cacheWrite: unit.cacheWrite,
              output: unit.output,
              model: unit.model,
              known: unit.known,
              // 计费币种：DeepSeek 为 CNY，其它 provider 见各自价格表。
              currency: unit.currency,
              // null = 这个模型全天同一价（不画指示灯与倒计时）；订阅制路由上的
              // DeepSeek 模型会给出峰谷时段，但仍然 known=false（不显示单价）。
              window: displayWindow,
            },
            // 【内部诊断】取价路径：界面不再展示（卡片去技术化），保留字段
            // 供排查问题与回归测试使用。
            pricing: {
              via: unit.via,                        // exact | alias | fallback
              requested: unit.requested,            // 当前启用的模型 id
              provider: provider,                   // 当前路由的原始 provider id
              capability: entry?.id ?? provider,    // 解析后用于查价的能力表 id
              used: unit.model,                     // 实际取价使用的模型 id
              known: unit.known,                    // false = 不计价，界面隐藏单价
              currency: unit.currency,
              window: unit.window,
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
            message: MESSAGES.zh.internal,
          });
        }
      },
    }),
    "dsh-deepseek-usage: route",
  );

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: ACCOUNTS_PATH,
      handler: async (req, res) => {
        try {
          if (req.method !== "GET" && req.method !== "HEAD") {
            return sendJson(res, 405, { ok: false, error: "method", message: MESSAGES.zh.method });
          }
          if (!isTrustedRequest(req, bindHost)) {
            return sendJson(res, 403, { ok: false, error: "forbidden", message: MESSAGES.zh.forbidden });
          }

          // 当前 provider 也是"已检测到"的一条：用户可能只在 agentDefaultModel 里
          // 指向了它，而目录还没列出。
          let currentProvider = "";
          try {
            const adm = ctx.get("agentDefaultModel");
            const selection = adm && typeof adm.currentSelection === "function" ? adm.currentSelection() : void 0;
            if (selection && typeof selection.provider === "string") currentProvider = selection.provider;
          } catch {}

          // 设置页的下拉选项：schema 允许映射到的提供商集合。与 Config 的枚举同源，
          // 目录读不到时也要给出来，否则设置页没法添加映射。`kind` 让设置页知道
          // OAuth 目标（Claude Code / Codex）的凭据是订阅令牌，不填凭据引用。
          const aliasable = aliasableProviderIds().map((id) => {
            const entry = accountCapabilityOf(id);
            return { id, displayName: entry.displayName, kind: entry.kind };
          });

          // 已注册的 provider 路由（directory 可能包含未注册的，只取注册过的）。
          const registered = new Map();
          try {
            const llm = ctx.get("llm");
            if (llm && typeof llm.listProviders === "function") {
              for (const item of llm.listProviders()) registered.set(item.id, item.name ?? item.id);
            }
          } catch {
            // 目录读不到时映射选项照常给，未识别候选与令牌区留空。
            sendJson(res, 200, { ok: true, aliasable, unmapped: [], oauth: [] });
            return;
          }

          // 本次请求的映射解析器：volatile 配置可能在两次请求之间被设置页改写。
          const providers = providersNow();

          // 检测到、但既不在能力表里、也没有用户映射的路由：设置页用它给出"添加映射"
          // 的候选。只取已注册与当前 provider，目录里那几十条无关路由不进列表。
          const detected = new Set([...registered.keys(), ...(currentProvider ? [currentProvider] : [])]);
          const unmapped = [...detected]
            .filter((id) => providers.resolve(id) === null)
            .map((id) => ({ id, displayName: registered.get(id) ?? id }));

          // OAuth 令牌状态：列出「DSH 里检测到」或「被映射目标引用」的 Claude Code /
          // Codex——后者让只装了第三方 Codex/Claude 插件的环境也能先填令牌。令牌值
          // 永不回传；`configured` 只看本地凭据，不查上游。
          const mappedOauth = new Set(providers.capabilityIds.filter((id) => oauthProviderOf(id) !== null));
          const oauth = [];
          for (const id of oauthProviderIds()) {
            if (!detected.has(id) && !mappedOauth.has(id)) continue;
            const spec = oauthProviderOf(id);
            const resolved = await resolveCredential(ctx, [spec.tokenRef]);
            oauth.push({
              id,
              displayName: accountCapabilityOf(id).displayName,
              configured: resolved.ok,
            });
          }

          sendJson(res, 200, { ok: true, aliasable, unmapped, oauth });
        } catch (error) {
          ctx.logger.warn("dsh-deepseek-usage: plugin page request failed");
          ctx.logger.warn(error);
          sendJson(res, 502, { ok: false, error: "internal", message: MESSAGES.zh.internal });
        }
      },
    }),
    "dsh-deepseek-usage: plugin page route",
  );

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: TOKEN_PATH,
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") {
            return sendJson(res, 405, { ok: false, error: "method", message: MESSAGES.zh.tokenMethod });
          }
          if (!isTrustedRequest(req, bindHost)) {
            return sendJson(res, 403, { ok: false, error: "forbidden", message: MESSAGES.zh.forbidden });
          }

          const { lang } = resolveQuery(req);
          const msg = MESSAGES[lang] || MESSAGES.zh;

          // 读有界 body：本机提交也不该无限读。
          let raw = "";
          try {
            raw = await readBoundedText(req, MAX_TOKEN_BODY_BYTES);
          } catch {
            return sendJson(res, 413, { ok: false, error: "payload", message: msg.tokenPayload });
          }
          let body;
          try {
            body = JSON.parse(raw);
          } catch {
            return sendJson(res, 400, { ok: false, error: "payload", message: msg.tokenPayload });
          }

          const provider = typeof body?.provider === "string" ? body.provider.trim().toLowerCase() : "";
          const spec = oauthProviderOf(provider);
          if (spec === null) {
            return sendJson(res, 400, { ok: false, error: "provider", message: msg.tokenUnknownProvider });
          }
          const token = typeof body?.token === "string" ? body.token.trim() : "";
          if (token !== "" && !isUsableKey(token)) {
            return sendJson(res, 400, { ok: false, error: "key", message: MESSAGES.zh.badKey });
          }

          const ref = credentialRef(spec.tokenRef);
          try {
            if (token === "") {
              await ctx.credentials.unset(ref);
              if (spec.accountRef !== undefined) await ctx.credentials.unset(credentialRef(spec.accountRef));
              invalidateAccount(provider);
              return sendJson(res, 200, { ok: true, provider, configured: false, message: msg.tokenCleared });
            }
            await ctx.credentials.set(ref, token);
            // Codex 的账号标识与令牌一并保存（缺了它上游可能拒绝请求）。
            if (spec.accountRef !== undefined) {
              const accountId = typeof body?.accountId === "string" ? body.accountId.trim() : "";
              if (accountId !== "") await ctx.credentials.set(credentialRef(spec.accountRef), accountId);
            }
            invalidateAccount(provider);
            return sendJson(res, 200, { ok: true, provider, configured: true, message: msg.tokenWritten });
          } catch (error) {
            ctx.logger.warn("dsh-deepseek-usage: token write failed");
            ctx.logger.warn(error);
            return sendJson(res, 502, { ok: false, error: "internal", message: msg.tokenFailed });
          }
        } catch (error) {
          ctx.logger.warn("dsh-deepseek-usage: token request failed");
          ctx.logger.warn(error);
          sendJson(res, 502, { ok: false, error: "internal", message: MESSAGES.zh.internal });
        }
      },
    }),
    "dsh-deepseek-usage: token route",
  );
}

export { name, inject, apply, Config };
