/**
 * dsh-deepseek-usage — 多提供商账户查询（余额 / 订阅用量 / OAuth 订阅余量）。
 *
 * 三种 kind：
 *   · balance —— 有"用 API Key 查余额"的接口，返回金额 + 币种；
 *   · usage   —— 订阅制，没有余额接口，但有关键字用量接口（百分比 + 重置时间）；
 *   · oauth   —— 只有 OAuth 订阅令牌能读的接口（Claude Code / Codex），令牌由用户
 *                在插件页主动粘贴，经凭证服务存取，宿主外任何位置都看不到它；
 *   · none    —— 上述都不成立（云厂商 AK/SK、OAuth-only 但无可用接口等）。
 *
 * 设计约束：
 *   · 每个取数器都是"一个纯解析函数 + 一次 HTTP 调用"，解析函数单独导出供测试，
 *     不联网也能覆盖全部字段映射与失败分类。
 *   · 解析不出字段就报 `shape`，绝不猜数字：各家接口字段来自其官方文档或长期稳定
 *     的社区实现，但本插件无法在发布前逐一用真实账号验证；宁可显示"无法识别"，
 *     也不要显示一个与账单无关的数字。
 *   · 数字一律走 toFinite：缺失 / 非数字 / 空串都是 null，由界面显示占位符。
 *     Number(null) 是 0，直接把 null 转成数字会把"读不到"显示成"余额 0"。
 *
 * 密钥引用：DSH 的模型页把用户键入的 Key 写到 `<ROUTE>_API_KEY`（route id 大写、
 * 非字母数字换成下划线），所以派生引用优先；适配器自己声明的环境名（pi-ai 的
 * PROVIDER_DATA.nativeAuth.env）作为第二条路径，覆盖用户在 shell / .env 里导出的
 * 情况。两者都不是机密本身，可以出现在状态页上告诉用户该配哪一个。
 */

/** 失败分类（宿主据此选文案，界面只看到一句人话）。 */
export const ACCOUNT_EMPTY = 'empty';   // 有响应，但没有可用数值
export const ACCOUNT_SHAPE = 'shape';   // 有响应，但字段不认得
export const ACCOUNT_UNAVAILABLE = 'unavailable'; // 账户被供应商标记为不可用

/**
 * API Key 可查余额的提供商。
 *
 * `hosts` 按顺序尝试：不同 host 的响应形状相同，只是域名/区域不同（如 Moonshot 的
 * 国际站与国内站）。第一个返回可用数值的 host 胜出，全部失败时报最后一个的失败分类。
 * `auth` 描述 Authorization 头的形态——`bearer` 是 `Bearer <key>`，`raw` 是把 Key
 * 原样放进头（智谱国内站 open.bigmodel.cn 的口径）。
 */
const BALANCE_PROVIDERS = {
  // DeepSeek 官方有三条路由（api-key / account / pi-ai 目录里的 deepseek），
  // 余额接口与密钥引用完全相同。`hosts` 为空表示端点由 lib/index.js 拼
  // （要兼容 DEEPSEEK_BASE_URL 覆盖）。
  'deepseek-official': {
    id: 'deepseek-official',
    displayName: 'DeepSeek',
    kind: 'balance',
    refs: ['DEEPSEEK_API_KEY'],
    hosts: [],
  },
  'deepseek-account': {
    id: 'deepseek-account',
    displayName: 'DeepSeek Account',
    kind: 'balance',
    refs: ['DEEPSEEK_API_KEY'],
    hosts: [],
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    kind: 'balance',
    refs: ['DEEPSEEK_API_KEY'],
    hosts: [],
  },
  moonshotai: {
    id: 'moonshotai',
    displayName: 'Moonshot',
    kind: 'balance',
    refs: ['MOONSHOTAI_API_KEY', 'MOONSHOT_API_KEY'],
    hosts: [
      { host: 'https://api.moonshot.ai', path: '/v1/users/me/balance', auth: 'bearer', currency: 'USD' },
      { host: 'https://api.moonshot.cn', path: '/v1/users/me/balance', auth: 'bearer', currency: 'CNY' },
    ],
  },
  zai: {
    id: 'zai',
    displayName: 'Z.ai (GLM)',
    kind: 'balance',
    refs: ['ZAI_API_KEY', 'ZAI_CODING_CN_API_KEY'],
    hosts: [
      { host: 'https://api.z.ai', path: '/api/biz/account/query-customer-account-report', auth: 'bearer' },
      { host: 'https://open.bigmodel.cn', path: '/api/biz/account/query-customer-account-report', auth: 'raw' },
    ],
  },
  openrouter: {
    id: 'openrouter',
    displayName: 'OpenRouter',
    kind: 'balance',
    refs: ['OPENROUTER_API_KEY'],
    hosts: [
      { host: 'https://openrouter.ai', path: '/api/v1/key', auth: 'bearer' },
    ],
    // 单个 Key 没有限额时（limit_remaining 为 null），回落查账户总余额。
    // 该接口要求 management key，普通 Key 会 403，因此失败分类照常上报。
    fallback: { host: 'https://openrouter.ai', path: '/api/v1/credits', auth: 'bearer' },
  },
};

/**
 * 订阅用量类提供商：没有余额接口，但关键字配额接口。
 * `windows` 声明窗口 key 的展示顺序（客户端本地化成 5 小时 / 7 天 / 30 天）。
 */
const USAGE_PROVIDERS = {
  'kimi-coding': {
    id: 'kimi-coding',
    displayName: 'Kimi For Coding',
    kind: 'usage',
    refs: ['KIMI_CODING_API_KEY', 'KIMI_API_KEY'],
    hosts: [{ host: 'https://api.kimi.com', path: '/coding/v1/usages', auth: 'bearer' }],
    windows: ['5h', '7d', '30d'],
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    kind: 'usage',
    refs: ['OPENCODE_API_KEY'],
    hosts: [{ host: 'https://opencode.ai', path: '/zen/go/v1/usage', auth: 'dual' }],
    windows: ['5h', '7d', '30d'],
  },
  'opencode-go': {
    id: 'opencode-go',
    displayName: 'OpenCode Go',
    kind: 'usage',
    refs: ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY'],
    hosts: [{ host: 'https://opencode.ai', path: '/zen/go/v1/usage', auth: 'dual' }],
    windows: ['5h', '7d', '30d'],
  },
  minimax: {
    id: 'minimax',
    displayName: 'MiniMax',
    kind: 'usage',
    refs: ['MINIMAX_API_KEY'],
    hosts: [{ host: 'https://www.minimax.io', path: '/v1/token_plan/remains', auth: 'bearer' }],
    windows: ['cycle', '7d'],
  },
  'minimax-cn': {
    id: 'minimax-cn',
    displayName: 'MiniMax (CN)',
    kind: 'usage',
    refs: ['MINIMAX_CN_API_KEY', 'MINIMAX_API_KEY'],
    hosts: [{ host: 'https://api.minimaxi.com', path: '/v1/token_plan/remains', auth: 'bearer' }],
    windows: ['cycle', '7d'],
  },
};

/**
 * OAuth 订阅类提供商：接口只有 OAuth 令牌能读，令牌由用户在插件页粘贴。
 * `usage` 是完整令牌的查询端点；`probe` 是 setup-token 的兜底——一次最小推理请求，
 * 从响应头里读节流状态（5h / 7d 两个窗口）。
 */
const OAUTH_PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    displayName: 'Claude Code',
    kind: 'oauth',
    tokenRef: 'DSH_USAGE_CLAUDE_OAUTH_TOKEN',
    usage: {
      host: 'https://api.anthropic.com',
      path: '/api/oauth/usage',
      method: 'GET',
      // 该端点要求 user:profile scope；claude setup-token 产的令牌只有
      // user:inference，会拿到 403，此时走 probe 兜底。
      headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    },
    probe: {
      host: 'https://api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      // 只取响应头，内容丢弃；max_tokens: 1 是社区实现沿用的最小请求。
      body: { model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: '.' }] },
    },
    windows: ['5h', '7d', '7d-opus'],
  },
  'openai-codex': {
    id: 'openai-codex',
    displayName: 'OpenAI Codex',
    kind: 'oauth',
    tokenRef: 'DSH_USAGE_CODEX_OAUTH_TOKEN',
    // ChatGPT-Account-Id 头是账号标识而非机密，与令牌同走凭证 seam 一处管理。
    accountRef: 'DSH_USAGE_CODEX_ACCOUNT_ID',
    usage: {
      host: 'https://chatgpt.com',
      path: '/backend-api/wham/usage',
      method: 'GET',
    },
    windows: ['5h', '7d'],
  },
};

/**
 * 查不到账户数据的提供商及原因。`reason` 是给用户看的一句"为什么"，
 * 由客户端本地化；这里只给分类键。
 */
const UNSUPPORTED_PROVIDERS = {
  'github-copilot': 'oauthOnly',
  google: 'cloudAuthOnly',
  'google-vertex': 'cloudAuthOnly',
  'amazon-bedrock': 'cloudAuthOnly',
  azure: 'cloudAuthOnly',
};

/** 所有 provider id → 能力条目。 */
export function accountCapabilityOf(providerId) {
  if (typeof providerId !== 'string') return null;
  const id = providerId.trim().toLowerCase();
  const found = BALANCE_PROVIDERS[id] ?? USAGE_PROVIDERS[id] ?? OAUTH_PROVIDERS[id];
  if (found) return found;
  const reason = UNSUPPORTED_PROVIDERS[id];
  if (reason !== undefined) return { id, displayName: id, kind: 'none', reason };
  return null;
}

/**
 * 一个 provider 的候选密钥引用（按优先级）。
 * DSH 模型页写入的派生引用在前（与 ui-settings-models 的 deriveKeyRef 同规则），
 * 适配器原生环境名在后。
 */
export function candidateRefsOf(providerId) {
  const entry = accountCapabilityOf(providerId);
  if (!entry || entry.kind !== 'balance' && entry.kind !== 'usage') return [];
  const derived = `${String(providerId).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
  const refs = [derived, ...(entry.refs ?? [])];
  return [...new Set(refs)];
}

/** OAuth 提供商的令牌引用（未配置 OAuth 的 provider 返回 null）。 */
export function oauthProviderOf(providerId) {
  if (typeof providerId !== 'string') return null;
  return OAUTH_PROVIDERS[providerId.trim().toLowerCase()] ?? null;
}

/** 受支持（kind 不是 none）的 provider id 全集。 */
export function supportedProviderIds() {
  return [
    ...Object.keys(BALANCE_PROVIDERS),
    ...Object.keys(USAGE_PROVIDERS),
    ...Object.keys(OAUTH_PROVIDERS),
  ];
}

/** 不可查原因的分类键（未登记的 provider 返回 null）。 */
export function unsupportedReasonOf(providerId) {
  if (typeof providerId !== 'string') return null;
  return UNSUPPORTED_PROVIDERS[providerId.trim().toLowerCase()] ?? null;
}

/** 容忍字符串/数字，返回有限数或 NaN。 */
function toFinite(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** 取有限数或 null（绝不把缺失变成 0）。 */
function finiteOrNull(value) {
  const n = toFinite(value);
  return Number.isFinite(n) ? n : null;
}

/** 解析时间戳：秒 / 毫秒 / ISO 字符串 → ms 或 null。 */
function toEpochMs(value) {
  const n = toFinite(value);
  if (Number.isFinite(n)) {
    // 10 位按秒、13 位按毫秒；其余量级不当时间戳。
    if (n > 1e11) return n;
    if (n > 1e8) return n * 1000;
    return null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** 归一成空余额（拿不到时界面显示占位符，不是 0）。 */
function emptyBalance() {
  return { isAvailable: null, total: null, currency: null };
}

function ok(balance) {
  return { ok: true, balance, usage: null };
}

/** 归一成一次成功的用量读数。 */
function okUsage(usage) {
  return { ok: true, balance: null, usage };
}

function fail(code) {
  return { ok: false, balance: null, usage: null, code };
}

// ---- DeepSeek 官方余额 ----------------------------------------------------

/**
 * 解析 DeepSeek `GET /user/balance`：
 * { is_available, balance_infos: [{ currency, total_balance, … }] }
 */
export function parseDeepSeekBalance(body) {
  const infos = body && Array.isArray(body.balance_infos) ? body.balance_infos : [];
  const first = infos[0] || {};
  const total = finiteOrNull(first.total_balance);
  if (total === null) return fail(ACCOUNT_EMPTY);
  if (body?.is_available === false) return fail(ACCOUNT_UNAVAILABLE);
  const balance = emptyBalance();
  balance.isAvailable = body?.is_available !== false;
  balance.total = total;
  balance.currency = typeof first.currency === 'string' && first.currency.trim() !== '' ? first.currency.trim() : null;
  return ok(balance);
}

// ---- Moonshot / Kimi 余额 -------------------------------------------------

/**
 * 解析 Moonshot `GET /v1/users/me/balance`：
 * { code: 0, data: { available_balance, voucher_balance, cash_balance }, status: true }
 * code 非 0 是业务错误（401 等），按"无法识别的内容"处理。
 */
export function parseMoonshotBalance(body) {
  // 没有 data 对象就是形状不对（空 body、HTML 错误页、数组等）。
  const data = body && typeof body.data === 'object' && body.data !== null ? body.data : null;
  if (data === null) return fail(ACCOUNT_SHAPE);
  const code = toFinite(body.code);
  // code 非 0 是业务错误（401 / 1001 等），不是"没有数据"。
  if (Number.isFinite(code) && code !== 0) return fail(ACCOUNT_SHAPE);
  const total = finiteOrNull(data.available_balance);
  if (total === null) return fail(ACCOUNT_EMPTY);
  const balance = emptyBalance();
  balance.isAvailable = true;
  balance.total = total;
  // 接口不返回币种，由调用方按 host 补（国际站 USD / 国内站 CNY）。
  return ok(balance);
}

// ---- 智谱 GLM 标准 API 余额 ----------------------------------------------

/**
 * 解析智谱 `GET /api/biz/account/query-customer-account-report`：
 * { success: true, data: { balance, availableBalance, rechargeAmount, … } }
 * success 为 false 是业务错误；data 为空对象视为没有数据。
 */
export function parseZaiBalance(body) {
  if (body && body.success === false) return fail(ACCOUNT_SHAPE);
  const data = body && typeof body.data === 'object' && body.data !== null ? body.data : null;
  if (data === null) return fail(ACCOUNT_SHAPE);
  const total = finiteOrNull(data.availableBalance ?? data.balance);
  if (total === null) return fail(ACCOUNT_EMPTY);
  const balance = emptyBalance();
  balance.isAvailable = true;
  balance.total = total;
  balance.currency = 'CNY';
  return ok(balance);
}

// ---- OpenRouter 余额 ------------------------------------------------------

/**
 * 解析 OpenRouter `GET /api/v1/key`：
 * { data: { limit, limit_remaining, usage, … } }
 * limit_remaining 为 null 表示这个 Key 没有限额——此时调用方回落 /api/v1/credits。
 */
export function parseOpenRouterKey(body) {
  const data = body && typeof body.data === 'object' && body.data !== null ? body.data : null;
  if (data === null) return fail(ACCOUNT_SHAPE);
  const remaining = data.limit_remaining;
  if (remaining === null || remaining === undefined) return fail(ACCOUNT_EMPTY);
  const total = finiteOrNull(remaining);
  if (total === null) return fail(ACCOUNT_SHAPE);
  const balance = emptyBalance();
  balance.isAvailable = true;
  balance.total = total;
  balance.currency = 'USD';
  return ok(balance);
}

/**
 * 解析 OpenRouter `GET /api/v1/credits`（management key）：
 * { data: { total_credits, total_usage } }
 */
export function parseOpenRouterCredits(body) {
  const data = body && typeof body.data === 'object' && body.data !== null ? body.data : null;
  if (data === null) return fail(ACCOUNT_SHAPE);
  const total = finiteOrNull(data.total_credits);
  const used = finiteOrNull(data.total_usage);
  if (total === null || used === null) return fail(ACCOUNT_EMPTY);
  const balance = emptyBalance();
  balance.isAvailable = true;
  balance.total = total - used;
  balance.currency = 'USD';
  return ok(balance);
}

// ---- Kimi For Coding 用量 -------------------------------------------------

/**
 * 解析 Kimi Coding `GET /coding/v1/usages`。
 *
 * 同一响应里有三种窗口来源（社区实现实测；字段随账号与接口版本略有出入）：
 *   · `usage.limit` / `usage.used` / `usage.remaining` + `usage.resetTime` —— 周窗口；
 *   · `usage.limits[]`：`window.duration` + `timeUnit` 定长度，`detail` 里是
 *     `limit` / `used` / `remaining`（也接受 usedPercent 一类旧字段）—— 通常是 5 小时；
 *   · `usages.limit_5h` / `limit_month_total` / `limit_month_code`：`used_ratio`
 *     （0..1）+ `reset_time` —— 比例池，其中 month_* 是月窗口。
 *
 * 百分比优先用接口明确给的；没有就用 used/limit 或 (limit-remaining)/limit 换算。
 * 同一个窗口 key 出现多次时保留已用百分比更高的那条（最先撞限的那条）。
 */
export function parseKimiCodingUsage(body) {
  const usage = body?.usage;
  const usages = body?.usages;
  const usageOk = usage !== null && typeof usage === 'object';
  const usagesOk = usages !== null && typeof usages === 'object';
  if (!usageOk && !usagesOk) return fail(ACCOUNT_SHAPE);
  const windows = [];
  const push = (key, percent, resetsAt) => {
    if (percent === null) return;
    const seen = windows.find((w) => w.key === key);
    if (seen === undefined) windows.push({ key, percent, resetsAt });
    else if (percent > seen.percent) {
      seen.percent = percent;
      seen.resetsAt = resetsAt;
    }
  };
  if (usageOk) {
    // 周窗口：顶层 limit / used / remaining。
    push('7d', usedPercentOf(usage), toEpochMs(usage.resetTime ?? usage.reset_time ?? usage.resetsAt));
    if (Array.isArray(usage.limits)) {
      for (const limit of usage.limits) {
        const window = limit?.window ?? limit ?? {};
        const detail = limit?.detail ?? limit ?? {};
        push(
          windowKeyOf(window),
          usedPercentOf(detail),
          toEpochMs(detail.resetTime ?? detail.reset_time ?? detail.resetsAt),
        );
      }
    }
  }
  if (usagesOk) {
    const map = { limit_5h: '5h', limit_month_total: '30d', limit_month_code: '30d' };
    for (const [field, key] of Object.entries(map)) {
      const entry = usages[field];
      if (entry === null || typeof entry !== 'object') continue;
      push(key, usedPercentOf(entry), toEpochMs(entry.reset_time ?? entry.resetTime));
    }
  }
  if (windows.length === 0) return fail(ACCOUNT_EMPTY);
  return okUsage({ plan: null, windows });
}

/**
 * 从各家用量条目里取"已用百分比"：显式百分比 → used_ratio → used/limit →
 * (limit-remaining)/limit。都没有时返回 null（该窗口跳过，不当成 0）。
 */
function usedPercentOf(entry) {
  if (entry === null || typeof entry !== 'object') return null;
  const explicit = finiteOrNull(entry.usedPercent ?? entry.used_percent ?? entry.percent);
  if (explicit !== null) return explicit;
  const ratio = finiteOrNull(entry.used_ratio ?? entry.usedRatio);
  if (ratio !== null) return ratio * 100;
  const limit = finiteOrNull(entry.limit ?? entry.total);
  if (limit === null || limit <= 0) return null;
  const used = finiteOrNull(entry.used);
  if (used !== null) return (used / limit) * 100;
  const remaining = finiteOrNull(entry.remaining ?? entry.remains ?? entry.left);
  if (remaining !== null) return ((limit - remaining) / limit) * 100;
  return null;
}

/**
 * 窗口时长 → 卡片上的窗口标签。
 *
 * 先把 duration + timeUnit 归一成分钟，再按长度分档：≤ 5 小时是 `5h`，
 * > 5 小时且 ≤ 8 天是 `7d`，其余是 `cycle`（Kimi 只暴露这两档，其余长度不猜）。
 * 缺 duration 或单位时不猜，直接 `cycle`。
 */
function windowKeyOf(window) {
  const duration = toFinite(window?.duration);
  if (!Number.isFinite(duration)) return 'cycle';
  const unit = String(window?.timeUnit ?? window?.time_unit ?? '').toUpperCase();
  const perUnit = { MINUTE: 1, HOUR: 60, DAY: 1440, SECOND: 1 / 60 };
  const minutes = duration * (perUnit[unit] ?? NaN);
  if (!Number.isFinite(minutes)) return 'cycle';
  if (minutes <= 5 * 60) return '5h';
  if (minutes <= 8 * 1440) return '7d';
  return 'cycle';
}

// ---- OpenCode Zen 用量 ----------------------------------------------------

/**
 * 解析 OpenCode `GET /zen/go/v1/usage`：
 * { usage: { rolling: { status, percent, resetsAt }, weekly: {…}, monthly: {…} } }
 * percent 是已用百分比；status 非 ok 的窗口跳过（未订阅/无数据）。
 */
export function parseOpenCodeUsage(body) {
  const usage = body?.usage;
  if (usage === null || typeof usage !== 'object') return fail(ACCOUNT_SHAPE);
  const map = { rolling: '5h', weekly: '7d', monthly: '30d' };
  const windows = [];
  for (const [field, key] of Object.entries(map)) {
    const entry = usage[field];
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.status === 'string' && entry.status !== 'ok') continue;
    const percent = finiteOrNull(entry.percent);
    if (percent === null) continue;
    windows.push({ key, percent, resetsAt: toEpochMs(entry.resetsAt ?? entry.resets_at) });
  }
  if (windows.length === 0) return fail(ACCOUNT_EMPTY);
  return okUsage({ plan: null, windows });
}

// ---- MiniMax Coding Plan 用量 ---------------------------------------------

/**
 * 解析 MiniMax `GET /v1/token_plan/remains`：
 * { base_resp: { status_code }, model_remains: [ { …,
 *   current_interval_remaining_percent, end_time,
 *   current_weekly_remaining_percent, weekly_end_time } ] }
 * model_remains 按模型 / 配额桶分多条，每条自带区间窗口与周窗口。卡片是摘要：
 * 每个窗口取所有桶里已用百分比最高的那条（最先撞限），区间窗口标成 cycle
 * （长度随套餐与桶而变），周窗口标成 7d。
 * 各家实现对"已用"的口径不一致（有的把 usage 当剩余），这里只采信剩余百分比与
 * 总数/剩余数：剩余百分比缺失且总数也缺失时不猜，直接跳过该窗口。
 */
export function parseMiniMaxRemains(body) {
  if (body?.base_resp && toFinite(body.base_resp.status_code) !== 0) return fail(ACCOUNT_SHAPE);
  const rows = body?.model_remains;
  if (!Array.isArray(rows) || rows.length === 0) return fail(ACCOUNT_EMPTY);
  const best = { cycle: null, '7d': null };
  for (const row of rows) {
    const candidates = [
      ['cycle', usedPercentFromRemaining(row.current_interval_remaining_percent), row.end_time ?? row.remains_time,
        usedPercentFromCounts(row.current_interval_total_count, row.current_interval_remaining_count ?? row.current_interval_remains_count)],
      ['7d', usedPercentFromRemaining(row.current_weekly_remaining_percent), row.weekly_end_time,
        usedPercentFromCounts(row.current_weekly_total_count, row.current_weekly_remaining_count)],
    ];
    for (const [key, fromPercent, resetsAt, fromCounts] of candidates) {
      const value = fromPercent ?? fromCounts;
      if (value === null) continue;
      const clamped = Math.max(0, Math.min(100, value));
      if (best[key] === null || clamped > best[key].percent) {
        best[key] = { key, percent: clamped, resetsAt: toEpochMs(resetsAt) };
      }
    }
  }
  const windows = Object.values(best).filter((w) => w !== null);
  if (windows.length === 0) return fail(ACCOUNT_EMPTY);
  return okUsage({ plan: null, windows });
}

/** 剩余百分比 → 已用百分比（接口给的是剩余）。 */
function usedPercentFromRemaining(remainingPercent) {
  const remaining = finiteOrNull(remainingPercent);
  return remaining === null ? null : 100 - remaining;
}

/** 总数 + 剩余数 → 已用百分比；任一缺失或总数为 0 时返回 null。 */
function usedPercentFromCounts(totalValue, remainingValue) {
  const total = finiteOrNull(totalValue);
  const remaining = finiteOrNull(remainingValue);
  if (total === null || remaining === null || total <= 0) return null;
  return ((total - remaining) / total) * 100;
}

// ---- Claude Code OAuth 用量 ----------------------------------------------

/**
 * 解析 Claude `GET /api/oauth/usage`：
 * { five_hour: { utilization, resets_at }, seven_day: {…}, seven_day_opus: {…},
 *   extra_usage: { is_enabled, used_credits, monthly_limit, currency } }
 * utilization 是 0–100 的已用百分比；null 表示该窗口未启用。
 * seven_day_opus 是模型专属的周窗口，key 与 seven_day 分开，界面上才不会被
 * 合并成两个同名窗口。extra_usage 是按量超额（金额），不是时间窗口，不在此列。
 */
export function parseClaudeOAuthUsage(body) {
  if (body === null || typeof body !== 'object') return fail(ACCOUNT_SHAPE);
  const map = { five_hour: '5h', seven_day: '7d', seven_day_opus: '7d-opus' };
  const windows = [];
  for (const [field, key] of Object.entries(map)) {
    const entry = body[field];
    if (entry === null || typeof entry !== 'object') continue;
    const percent = finiteOrNull(entry.utilization);
    if (percent === null) continue;
    windows.push({ key, percent, resetsAt: toEpochMs(entry.resets_at) });
  }
  if (windows.length === 0) return fail(ACCOUNT_EMPTY);
  return okUsage({ plan: null, windows });
}

/**
 * 从 Claude 推理响应头合成用量窗口（setup-token 兜底路径）。
 *
 * 头名：anthropic-ratelimit-unified-{5h,7d}-utilization（0..1 小数）
 *       anthropic-ratelimit-unified-{5h,7d}-reset（unix 秒）
 * 任意一个窗口都取不到时返回 null——调用方据此判断"这个令牌读不到用量"。
 */
export function parseClaudeRateLimitHeaders(headers) {
  const pick = (name) => {
    const raw = headers?.[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined || value === null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const windows = [];
  for (const [suffix, key] of [['5h', '5h'], ['7d', '7d']]) {
    const utilization = pick(`anthropic-ratelimit-unified-${suffix}-utilization`);
    if (utilization === null) continue;
    const resetSecs = pick(`anthropic-ratelimit-unified-${suffix}-reset`);
    windows.push({
      key,
      percent: Math.max(0, Math.min(100, utilization * 100)),
      resetsAt: resetSecs === null ? null : resetSecs * 1000,
    });
  }
  if (windows.length === 0) return null;
  return { ok: true, balance: null, usage: { plan: null, windows } };
}

// ---- OpenAI Codex 用量 ----------------------------------------------------

/**
 * 解析 Codex `GET /backend-api/wham/usage`：
 * { plan_type, rate_limit: { primary_window: { used_percent, reset_at,
 *   limit_window_seconds }, secondary_window: {…} },
 *   credits: { has_credits, unlimited, balance } }
 * primary / secondary 是位置化的：窗口长度由各自的 limit_window_seconds 决定
 * （当前为 5 小时会话窗口与 7 天窗口）。优先按秒数标注窗口，缺字段时才退回
 * "primary=5h / secondary=7d" 的历史口径。credits.balance 是余额，与窗口分开
 * 返回：余额有值时作为 usage.balance 一并给出，界面优先显示余额。
 */
export function parseCodexUsage(body) {
  if (body === null || typeof body !== 'object') return fail(ACCOUNT_SHAPE);
  const rate = body.rate_limit;
  if (rate === null || typeof rate !== 'object') return fail(ACCOUNT_SHAPE);
  const windows = [];
  const fallbacks = [[rate.primary_window, '5h'], [rate.secondary_window, '7d']];
  for (const [entry, fallbackKey] of fallbacks) {
    if (entry === null || typeof entry !== 'object') continue;
    const percent = finiteOrNull(entry.used_percent);
    if (percent === null) continue;
    windows.push({
      key: windowKeyOfSeconds(entry.limit_window_seconds) ?? fallbackKey,
      percent,
      resetsAt: toEpochMs(entry.reset_at),
    });
  }
  const credits = body.credits;
  let balance = null;
  if (credits && typeof credits === 'object' && credits.has_credits === true && credits.unlimited !== true) {
    const total = finiteOrNull(credits.balance);
    if (total !== null) {
      balance = { isAvailable: true, total, currency: 'USD' };
    }
  }
  if (windows.length === 0 && balance === null) return fail(ACCOUNT_EMPTY);
  return { ok: true, balance, usage: { plan: typeof body.plan_type === 'string' ? body.plan_type : null, windows } };
}

/**
 * 窗口秒数 → 卡片标签 key：18000 秒是 `5h`、604800 秒是 `7d`；其它长度按
 * 整小时 / 整天的通用写法（如 `1h`、`3d`），由界面本地化。非数字返回 null，
 * 调用方据此退回位置化口径。
 */
function windowKeyOfSeconds(value) {
  const seconds = toFinite(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (Math.abs(seconds - 18000) <= 60) return '5h';
  if (Math.abs(seconds - 604800) <= 3600) return '7d';
  if (seconds < 72 * 3600) return `${Math.max(1, Math.round(seconds / 3600))}h`;
  return `${Math.max(1, Math.round(seconds / 86400))}d`;
}

// ---- 通用 HTTP 取数 -------------------------------------------------------

/** 取数器的运行环境（宿主注入，便于测试替身）。 */
export function makeAccountReader({
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  maxBodyBytes = 64 * 1024,
  /** DeepSeek 官方余额端点（lib/index.js 传入以兼容 DEEPSEEK_BASE_URL 覆盖）。 */
  deepseekUrl = null,
} = {}) {
  /** 发一次 GET，返回 { status, headers, text }；超时/网络错误抛出带 name 的 Error。 */
  async function request(url, { method = 'GET', headers = {}, body = null } = {}) {
    const response = await fetchImpl(url, {
      method,
      headers: { Accept: 'application/json', ...headers },
      body: body === null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text };
  }

  /** 解析 JSON；失败抛错（调用方按 shape 处理）。 */
  function parseJson(text, bytes) {
    if (bytes > maxBodyBytes) throw new Error('payload-too-large');
    return JSON.parse(text);
  }

  /**
   * 按能力表取一个提供商的账户数据。
   *
   * @param entry   accountCapabilityOf 的返回值（kind 不能是 none）
   * @param secret  已解析出的密钥 / OAuth 令牌（调用方已做形状校验）
   * @param extra   { accountId } —— Codex 的 ChatGPT-Account-Id
   * @returns 归一结果 { ok, balance, usage, code? }
   */
  async function read(entry, secret, extra = {}) {
    if (entry.kind === 'oauth') return readOAuth(entry, secret, extra);
    // DeepSeek 官方余额的端点由宿主拼（兼容 DEEPSEEK_BASE_URL），不写在能力表里。
    if (entry.id === 'deepseek' || entry.id === 'deepseek-official' || entry.id === 'deepseek-account') {
      if (deepseekUrl === null) return fail(ACCOUNT_EMPTY);
      try {
        const res = await request(deepseekUrl, { headers: { Authorization: authHeader('bearer', secret) } });
        if (!(res.status >= 200 && res.status < 300)) return fail(ACCOUNT_SHAPE);
        let body;
        try {
          body = parseJson(res.text, Buffer.byteLength(res.text, 'utf8'));
        } catch {
          return fail(ACCOUNT_SHAPE);
        }
        return parseDeepSeekBalance(body);
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        return fail(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
      }
    }
    const hosts = entry.hosts ?? [];
    let last = fail(ACCOUNT_EMPTY);
    for (const endpoint of hosts) {
      const url = `${endpoint.host}${endpoint.path}`;
      const headers = { Authorization: authHeader(endpoint.auth, secret) };
      // OpenCode 的用量接口要求同时带 Authorization 与 x-api-key。
      if (endpoint.auth === 'dual') headers['x-api-key'] = secret;
      try {
        const res = await request(url, { headers });
        if (!(res.status >= 200 && res.status < 300)) {
          last = fail(ACCOUNT_SHAPE);
          continue;
        }
        let body;
        try {
          body = parseJson(res.text, Buffer.byteLength(res.text, 'utf8'));
        } catch {
          last = fail(ACCOUNT_SHAPE);
          continue;
        }
        const parsed = dispatch(entry.id, body, endpoint);
        if (parsed.ok) return parsed;
        last = parsed;
        // 明确没有数据时换下一个 host 也没意义（同形状），但区域差异可能造成
        // "有响应无数值"，继续尝试其余 host 更稳妥。
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        // 网络类失败（超时、连接被拒）对所有 host 都一样：继续试第二个只会把
        // "连不上"掩盖成"形状不认"，所以直接返回。
        if (name === 'TimeoutError' || name === 'AbortError') return fail('timeout');
        return fail('network');
      }
    }
    // OpenRouter 单 Key 无限额时回落查账户总余额。
    if (entry.fallback !== undefined && last.code === ACCOUNT_EMPTY) {
      const endpoint = entry.fallback;
      try {
        const res = await request(`${endpoint.host}${endpoint.path}`, {
          headers: { Authorization: authHeader(endpoint.auth, secret) },
        });
        if (res.status >= 200 && res.status < 300) {
          const body = parseJson(res.text, Buffer.byteLength(res.text, 'utf8'));
          const parsed = parseOpenRouterCredits(body);
          if (parsed.ok) return parsed;
          last = parsed;
        }
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        last = { ok: false, balance: null, usage: null, code: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' };
      }
    }
    return last;
  }

  /** OAuth 提供商：先查 usage 端点，403 时走最小推理请求的响应头兜底。 */
  async function readOAuth(entry, token, extra) {
    const endpoint = entry.usage;
    const url = `${endpoint.host}${endpoint.path}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      ...endpoint.headers,
    };
    if (entry.accountRef !== undefined && typeof extra.accountId === 'string' && extra.accountId !== '') {
      headers['ChatGPT-Account-Id'] = extra.accountId;
    }
    let sawUnauthorized = false;
    try {
      const res = await request(url, { method: endpoint.method ?? 'GET', headers });
      if (res.status === 401 || res.status === 403) {
        sawUnauthorized = true;
      } else if (res.status >= 200 && res.status < 300) {
        let body;
        try {
          body = parseJson(res.text, Buffer.byteLength(res.text, 'utf8'));
        } catch {
          return fail(ACCOUNT_SHAPE);
        }
        const parsed = entry.id === 'openai-codex' ? parseCodexUsage(body) : parseClaudeOAuthUsage(body);
        if (parsed.ok) return parsed;
        if (parsed.code !== ACCOUNT_EMPTY) return parsed;
      } else {
        return fail(ACCOUNT_SHAPE);
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name !== 'TimeoutError' && name !== 'AbortError') return fail('network');
      return fail('timeout');
    }
    // 403 且该提供商有 probe（setup-token 只带 user:inference）→ 兜底读响应头。
    if (sawUnauthorized && entry.probe !== undefined) {
      return readProbe(entry, token);
    }
    if (sawUnauthorized) return fail('unauthorized');
    return fail(ACCOUNT_EMPTY);
  }

  /** 一次最小推理请求，从响应头合成用量窗口。 */
  async function readProbe(entry, token) {
    const probe = entry.probe;
    const url = `${probe.host}${probe.path}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      ...probe.headers,
    };
    try {
      const res = await request(url, { method: probe.method ?? 'POST', headers, body: probe.body });
      if (!(res.status >= 200 && res.status < 300)) {
        // 调用方是在 usage 端点 401/403 之后才走到这里的，令牌无效已经成立；
        // 兜底再失败（限流、模型下线、网络）都改报同一个结论，让界面提示重新填写。
        return fail('unauthorized');
      }
      const parsed = parseClaudeRateLimitHeaders(Object.fromEntries(res.headers.entries()));
      if (parsed === null) return fail(ACCOUNT_EMPTY);
      return parsed;
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      return fail(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
    }
  }

  return { read };
}

/** Authorization 头形态。 */
function authHeader(kind, secret) {
  return kind === 'raw' ? secret : `Bearer ${secret}`;
}

/** 按 provider id 选解析函数。 */
function dispatch(id, body, endpoint) {
  switch (id) {
    case 'deepseek':
      return parseDeepSeekBalance(body);
    case 'moonshotai': {
      const parsed = parseMoonshotBalance(body);
      if (parsed.ok && parsed.balance.currency === null && endpoint.currency) {
        return { ...parsed, balance: { ...parsed.balance, currency: endpoint.currency } };
      }
      return parsed;
    }
    case 'zai':
      return parseZaiBalance(body);
    case 'openrouter':
      return parseOpenRouterKey(body);
    case 'kimi-coding':
      return parseKimiCodingUsage(body);
    case 'opencode':
    case 'opencode-go':
      return parseOpenCodeUsage(body);
    case 'minimax':
    case 'minimax-cn':
      return parseMiniMaxRemains(body);
    default:
      return fail(ACCOUNT_SHAPE);
  }
}
