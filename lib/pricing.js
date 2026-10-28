/**
 * dsh-deepseek-usage — 定价表（每百万 tokens）。
 *
 * 一家提供商一份价格快照，全部放在 PRICE_TABLES 里；DeepSeek 只是其中一条，
 * 没有单独一套计价代码：
 *   · PRICE_TABLES[provider] = { currency, asOf, schedule?, aliases?, models }
 *   · models[模型 id] = { standard: { input, cacheRead, cacheWrite?, output }, offPeak?: {…} }
 *   · schedule 描述计费区间：peakWindows 标出"贵"的时段（区间内走 standard，区间外走
 *     offPeak）。没写 schedule、或该模型没有 offPeak 时，全天同一价，卡片也就没有
 *     指示灯与倒计时。
 *
 * 同一个 window 机制同时表达两种口径：
 *   · DeepSeek 官方峰谷：peakWindows = 工作日 9:00–12:00、14:00–18:00，
 *     peakDays = weekdays，holidays = true（中国法定节假日与周末全天空闲）；
 *   · OpenRouter 上个别模型的分时 overrides：形状相同，但按 UTC 星期、不认中国
 *     法定节假日（holidays = false）。所以同一个模型走官方路由与走网关，指示灯会
 *     在节假日给出相反结论——这是两条真实计费规则，不是 bug。
 *
 * 模型改名：官方会把模型改名并把旧名保留为别名（如 deepseek-v4-flash →
 * deepseek-flash）。旧名若落到表里就会长期显示过期价且无从察觉，因此每家提供商可以
 * 带一份 aliases（"旧名 → 现名"），quoteAt() 的 via 字段标出来源（exact / alias），
 * 供排查，避免静默算错。
 *
 * 不做"同家族唯一匹配"（flash / pro / chat / reasoner）：家族词没有词边界，
 * deepseek-v5-pro、deepseek-prompt-helper 都会命中 pro 并按上代价格计价；官方发布
 * 下一代模型后，卡片会自信地显示旧价而不是隐藏。表里没有的模型一律 known=false。
 *
 * 只按 provider + 模型 id 精确查表：第三方路由上的 deepseek-* 同名模型按各自规则扣费，
 * 用官方表算出来的数字与账单无关；反过来，官方路由上不在表里的模型也不猜价。
 *
 * 价格快照均为手动采集，厂商调价时随插件版本更新（见 README「价格与官方不一致时」）：
 * 不联网抓取、不读写本地价格文件、不做后台同步。
 *
 * 时区：DeepSeek 的峰谷判定与"每日"边界按北京时间（Asia/Shanghai，固定 UTC+8，
 * 无夏令时），不随部署机器时区变化；其它提供商用各自 schedule 的 offsetMinutes。
 */

/** 北京时间固定偏移（上海无夏令时）。 */
export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 默认模型（当 agentDefaultModel 不可用时的展示默认）。 */
export const DEFAULT_MODEL = 'deepseek-flash';

/**
 * DeepSeek 官方峰谷快照：2026-09-10 官方价格页。三条官方路由共用这一份。
 *
 * 原来的 [高峰, 空闲] 二元组在这里展开成 standard（高峰）/ offPeak（空闲）两个价；
 * cacheWrite 官方暂不计费，两个区间都是 0。
 *
 * 只按模型名前缀判"官方"是不够的：Qwen token-plan、NVIDIA、opencode、workbuddy 这些
 * 第三方路由上都有 `deepseek-*` 同名模型，它们按各自的计价规则扣费。所以查表以
 * provider 为键——这些路由没有快照，一律 known=false；provider 缺失（旧宿主、路由
 * 未上报）时同样隐藏价格，不显示一个与实际账单无关的数字。
 */
const DEEPSEEK = {
  currency: 'CNY',
  asOf: '2026-09-10',
  schedule: { offsetMinutes: 480, peakWindows: [[9, 12], [14, 18]], peakDays: 'weekdays', holidays: true },
  aliases: {
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  },
  models: {
    'deepseek-flash': {
      standard: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
      offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
    },
    'deepseek-v4-pro': {
      standard: { input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 },
      offPeak: { input: 4.5, cacheRead: 0.15, cacheWrite: 0, output: 13.5 },
    },
    // chat / reasoner 官方没有峰谷差价：两个区间同价，但仍是"有区间"的模型，
    // 卡片照旧显示指示灯与倒计时（价格不变）。
    'deepseek-chat': {
      standard: { input: 2, cacheRead: 0.5, cacheWrite: 0, output: 8 },
      offPeak: { input: 2, cacheRead: 0.5, cacheWrite: 0, output: 8 },
    },
    'deepseek-reasoner': {
      standard: { input: 4, cacheRead: 1, cacheWrite: 0, output: 16 },
      offPeak: { input: 4, cacheRead: 1, cacheWrite: 0, output: 16 },
    },
  },
};

/**
 * 各家提供商的按量计费价格表（手动采集的快照，每百万 tokens）。
 *
 * 只收**按 token 计费**的官方 API 模型：订阅套餐、按次计费、图片/语音等非 token
 * 计费项都不收。表里没有的模型一律 known=false，界面隐藏价格。
 *
 * 币种按**一个站点**的口径维护——同一个模型 id 在不同站点价格不同，混用会与账单不符：
 *   · Moonshot / Kimi、Z.ai 取国际站美元价；
 *   · MiniMax 分 `minimax`（.io，美元）与 `minimax-cn`（.cn，人民币）；
 *   · OpenRouter 是网关聚合价，记的是默认路由价，实际结算按响应里的上游 provider。
 */
const PRICE_TABLES = {
  'deepseek-official': DEEPSEEK,
  'deepseek-account': DEEPSEEK,
  deepseek: DEEPSEEK,

  // Moonshot / Kimi：platform.kimi.ai 国际站（USD）。国内站 kimi.com 是人民币价，
  // 同 id 不同价，本表不混用。
  moonshotai: {
    currency: 'USD',
    asOf: '2026-10-27',
    models: {
      'kimi-k3.1-pro': { standard: { input: 2, cacheRead: 0.2, output: 10 } },
      'kimi-k3.1-pro-highspeed': { standard: { input: 4, cacheRead: 0.2, output: 20 } },
      'kimi-k3': { standard: { input: 3, cacheRead: 0.3, output: 15 } },
      'kimi-k2.7-code': { standard: { input: 0.95, cacheRead: 0.19, output: 4 } },
      'kimi-k2.7-code-highspeed': { standard: { input: 1.9, cacheRead: 0.38, output: 8 } },
      'kimi-k2.6': { standard: { input: 0.95, cacheRead: 0.16, output: 4 } },
    },
  },

  // Z.ai / 智谱：docs.z.ai 国际站（USD）。BigModel 人民币价另有一份，本表不混用。
  zai: {
    currency: 'USD',
    asOf: '2026-10-27',
    models: {
      'glm-5.3': { standard: { input: 1.4, cacheRead: 0.26, output: 4.4 } },
      'glm-5.3-flash': { standard: { input: 0.15, cacheRead: 0.03, output: 0.5 } },
      'glm-5.3-flashx': { standard: { input: 0.37, cacheRead: 0.075, output: 1.25 } },
      'glm-5.2': { standard: { input: 1.4, cacheRead: 0.26, output: 4.4 } },
      'glm-5.1': { standard: { input: 1.4, cacheRead: 0.26, output: 4.4 } },
      'glm-5': { standard: { input: 1, cacheRead: 0.2, output: 3.2 } },
      'glm-4.7': { standard: { input: 0.6, cacheRead: 0.11, output: 2.2 } },
      'glm-4.7-flashx': { standard: { input: 0.07, cacheRead: 0.01, output: 0.4 } },
      'glm-4.6': { standard: { input: 0.6, cacheRead: 0.11, output: 2.2 } },
      'glm-4.6v': { standard: { input: 0.3, cacheRead: 0.05, output: 0.9 } },
      'glm-4.5': { standard: { input: 0.6, cacheRead: 0.11, output: 2.2 } },
      'glm-4.5-air': { standard: { input: 0.2, cacheRead: 0.03, output: 1.1 } },
    },
  },

  // MiniMax 国际站（platform.minimax.io，USD）。
  minimax: {
    currency: 'USD',
    asOf: '2026-10-27',
    models: {
      'minimax-m3.1-flash': { standard: { input: 0.15, cacheRead: 0.015, output: 0.6 } },
      // M3 按输入长度分档（≤512k / >512k）与 priority 服务等级加价；这里取默认档
      //（≤512k、标准服务），长上下文/优先服务会与账单有出入。
      'minimax-m3': { standard: { input: 0.3, cacheRead: 0.06, output: 1.2 } },
    },
  },

  // MiniMax 国内站（platform.minimax.cn，人民币）。
  'minimax-cn': {
    currency: 'CNY',
    asOf: '2026-10-27',
    models: {
      'minimax-m3.1-flash': { standard: { input: 1, cacheRead: 0.1, output: 4 } },
      'minimax-m3': { standard: { input: 2.1, cacheRead: 0.42, output: 8.4 } },
    },
  },

  // OpenRouter（网关聚合价，USD）。`deepseek/deepseek-v4.1-flash-1017` 的分时 overrides
  // 与官方 DeepSeek 峰谷同构（UTC 工作日 01–04、06–10 为贵的一侧，周末全天便宜），
  // 但**没有**中国法定节假日概念——schedule 里 holidays 为 false。
  openrouter: {
    currency: 'USD',
    asOf: '2026-10-27',
    schedule: { offsetMinutes: 480, peakWindows: [[9, 12], [14, 18]], peakDays: 'weekdays', holidays: false },
    models: {
      'deepseek/deepseek-v4.1-flash-1017': {
        standard: { input: 0.3, cacheRead: 0.006, output: 1.2 },
        offPeak: { input: 0.15, cacheRead: 0.003, output: 0.6 },
      },
      'deepseek/deepseek-v4.1-flash': { standard: { input: 0.14, cacheRead: 0.0042, output: 0.42 } },
      'claude-sonnet-5.5': { standard: { input: 2, cacheRead: 0.1, output: 10 } },
      'gpt-6.1-sol': { standard: { input: 2, cacheRead: 0.1, output: 10 } },
      'gemini-3.8-flash': { standard: { input: 0.825, cacheRead: 0.0825, output: 4.125 } },
      'grok-4.7': { standard: { input: 2, cacheRead: 0.5, output: 6 } },
      'glm-4.6': { standard: { input: 0.55, cacheRead: 0.11, output: 2.2 } },
      'minimax-m3.1-flash': { standard: { input: 0.15, cacheRead: 0.015, output: 0.6 } },
    },
  },
};

/**
 * 中国法定节假日放假日期（含起止，闭区间；北京时间的日历日）。
 * 来源：国务院办公厅《关于 2026 年部分节假日安排的通知》（国办发明电〔2025〕7号）。
 * 官方口径：法定节假日全天、调休上班的周末均为空闲时段——周末本来就空闲，所以
 * 只需列"放假日期"，落在工作日里的那几天才会把判定从高峰翻成空闲。
 * 下一年的安排通常在前一年 11 月发布，届时更新本表与 HOLIDAY_TABLE_THROUGH_YEAR；
 * 当前年份未被覆盖时由 lib/index.js 告警（见 hasHolidayCoverage）。
 */
export const HOLIDAY_RANGES = [
  ['2026-01-01', '2026-01-03'], // 元旦
  ['2026-02-15', '2026-02-23'], // 春节
  ['2026-04-04', '2026-04-06'], // 清明节
  ['2026-05-01', '2026-05-05'], // 劳动节
  ['2026-06-19', '2026-06-21'], // 端午节
  ['2026-09-25', '2026-09-27'], // 中秋节
  ['2026-10-01', '2026-10-07'], // 国庆节
];

/**
 * 把 [起, 止] 闭区间展开成日期键集合（`yyyy-mm-dd`，O(1) 查表）。
 *
 * 非法日期（如 2027-02-30）会被 Date.parse 滚到 03-02，把一个不存在的日子变成
 * 真的假日。这里先校验解析结果与输入一致，不一致就跳过该段。
 */
export function expandHolidayRanges(ranges) {
  const set = new Set();
  const DAY = 24 * 60 * 60 * 1000;
  for (const [from, to] of ranges) {
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) continue;
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    // 解析结果必须与输入同一天，否则说明输入本身不是合法日期（已滚动到别的日子）。
    if (new Date(start).toISOString().slice(0, 10) !== from) continue;
    if (new Date(end).toISOString().slice(0, 10) !== to) continue;
    for (let t = start; t <= end; t += DAY) set.add(new Date(t).toISOString().slice(0, 10));
  }
  return set;
}

const HOLIDAY_DAYS = expandHolidayRanges(HOLIDAY_RANGES);

/** 某时刻在指定固定偏移时区下的钟点、星期、日期键与当日零点（ms）。 */
function scheduleParts(ms, offsetMinutes) {
  const local = new Date(ms + offsetMinutes * 60000);
  const dateKey = local.toISOString().slice(0, 10);
  return {
    hour: local.getUTCHours(),
    dow: local.getUTCDay(),
    dateKey,
    dayStart: Date.parse(`${dateKey}T00:00:00Z`) - offsetMinutes * 60000,
  };
}

const scheduleOffsetOf = (schedule) =>
  Number.isFinite(schedule.offsetMinutes) ? schedule.offsetMinutes : SHANGHAI_OFFSET_MS / 60000;

/** 某时刻是否落在"贵"的一侧（peakWindows 窗口内，且不属于节假日/非工作日豁免）。 */
function inExpensiveWindow(ms, schedule, holidays) {
  const { hour, dow, dateKey } = scheduleParts(ms, scheduleOffsetOf(schedule));
  if (!Array.isArray(schedule.peakWindows)) return false;
  const weekday = dow !== 0 && dow !== 6;
  const holiday = schedule.holidays === true && holidays.has(dateKey);
  if (holiday) return false;
  if ((schedule.peakDays ?? 'everyday') === 'weekdays' && !weekday) return false;
  return schedule.peakWindows.some(([start, end]) => hour >= start && hour < end);
}

/**
 * 距下一次计费区间翻转的剩余时间。
 *
 * 只枚举窗口边界的整点（高峰起止 / 优惠起止），逐日推进；上限 32 天，覆盖
 * "长假最后一天 18:00 → 假期后第一个工作日 09:00"这类最长空档（2026 年春节假期
 * 9 天，空档 10.7 天）。找不到时返回 at:null——调用方据此显示占位符，不要当成"此刻"。
 */
function nextWindowChange(ms, schedule, holidays) {
  const current = inExpensiveWindow(ms, schedule, holidays);
  const windows = schedule.peakWindows;
  if (!Array.isArray(windows) || windows.length === 0) return { peak: current, at: null, ms: 0 };
  const hours = [...new Set(windows.flat())].sort((a, b) => a - b);
  const { dayStart } = scheduleParts(ms, scheduleOffsetOf(schedule));
  const DAY = 24 * 60 * 60 * 1000;
  for (let day = 0; day < 32; day += 1) {
    for (const hour of hours) {
      const at = dayStart + day * DAY + hour * 60 * 60 * 1000;
      if (at <= ms) continue;
      const expensive = inExpensiveWindow(at, schedule, holidays);
      if (expensive !== current) return { peak: expensive, at, ms: at - ms };
    }
  }
  // 理论上不可达（不变量：一个月内必有工作日整点边界）。返回 at:null 而不是 now，
  // 否则调用方会显示 switching 并永久卡住。
  return { peak: !current, at: null, ms: 0 };
}

const DEEPSEEK_SCHEDULE = DEEPSEEK.schedule;

/** 某时刻是否为 DeepSeek 高峰时段（北京时间；法定节假日全天与周末恒为空闲）。
 *
 * `holidays` 可选：浏览器侧镜像无法 import 本模块，测试与宿主以外的调用方可以传入
 * 自己的日期集合；缺省用内置表，保证 `isPeak(ms)` 的既有语义不变。
 */
export function isPeak(ms, holidays = HOLIDAY_DAYS) {
  return inExpensiveWindow(Number.isFinite(ms) ? ms : Date.now(), DEEPSEEK_SCHEDULE, holidays);
}

/**
 * 距下一次 DeepSeek 峰谷翻转的剩余时间（供卡片显示倒计时）。
 *
 * 与 isPeak 同源同口径，只是换一个视图：返回「下一次 isPeak 结果发生翻转」的时刻。
 * 注意空闲时段里的下一次切换**不等于**下一个整点：
 *   · 12:00–14:00 午休 → 下一次切换是 14:00（高峰开始）；
 *   · 周五 18:00 之后、整个周末 → 下一次切换是下周一 09:00（跨 2 天多）。
 * 因此倒计时必须能显示「天」。
 *
 * @returns {{ peak: boolean, at: number, ms: number }} peak=切换后所处的时段，
 *   at=切换发生的时刻（ms 时间戳，新时段在此刻生效），ms=剩余毫秒（不会为负）。
 *   找不到切换点时返回 `at: null`——调用方据此判断"不知道"，不要把它当成"此刻"。
 */
export function nextChange(ms, holidays = HOLIDAY_DAYS) {
  return nextWindowChange(Number.isFinite(ms) ? ms : Date.now(), DEEPSEEK_SCHEDULE, holidays);
}

/**
 * 模型名是否属于 DeepSeek 官方峰谷口径（仅用于订阅制路由上的时段指示）。
 *
 * 订阅制路由（OpenCode Go 等）没有价格快照，单价仍是 known=false；但当当前模型
 * 本身就是 DeepSeek 的峰谷型号时，卡片照旧显示峰谷指示灯与倒计时。这里只判断
 * 模型名，不改变任何价格结论。
 */
export function isDeepSeekScheduleModel(model) {
  if (typeof model !== 'string') return false;
  const id = model.trim().toLowerCase();
  if (id === '') return false;
  return id === 'deepseek' || id.startsWith('deepseek-') || id.startsWith('deepseek.');
}

/**
 * 放假日期表覆盖到的年份（含）。
 *
 * 国务院办公厅通常在前一年 11 月发布次年安排，届时更新 HOLIDAY_RANGES 并把这个
 * 常量 +1。不能用"表里有没有这一年的某一天"来判定覆盖：只补一条元旦记录就会让
 * 判定通过，而春节、国庆仍然按工作日计价。
 */
export const HOLIDAY_TABLE_THROUGH_YEAR = 2026;

/** 该时刻所在的北京时间年份是否已被放假日期表覆盖。 */
export function hasHolidayCoverage(ms = Date.now()) {
  const year = new Date(ms + SHANGHAI_OFFSET_MS).getUTCFullYear();
  return year <= HOLIDAY_TABLE_THROUGH_YEAR;
}

const has = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);

/** 取某 provider 的价格快照（id 大小写、首尾空白无关）。 */
function tableOf(provider) {
  if (typeof provider !== 'string') return null;
  const id = provider.trim().toLowerCase();
  return id !== '' && has(PRICE_TABLES, id) ? PRICE_TABLES[id] : null;
}

/** 在快照里找模型：精确 → 别名。表里没有就是不知道，不做家族猜测。 */
function lookupModel(table, id) {
  const key = id.trim().toLowerCase();
  if (has(table.models, key)) return { id: key, via: 'exact' };
  if (table.aliases !== undefined && has(table.aliases, key) && has(table.models, table.aliases[key])) {
    return { id: table.aliases[key], via: 'alias' };
  }
  return null;
}

/** 按当前区间取价：便宜的一侧用 offPeak（若提供），否则一律 standard。 */
function priceOf(entry, expensive) {
  const price = !expensive && entry.offPeak ? entry.offPeak : entry.standard;
  return {
    input: price.input,
    cacheRead: price.cacheRead ?? null,
    cacheWrite: price.cacheWrite ?? 0,
    output: price.output,
  };
}

/**
 * 某模型在某一时刻的单位价格（每百万 tokens，币种见返回的 currency）。
 *
 * 一条路径：provider → 该 provider 的价格快照 → 模型（精确 → 别名）→ 按 schedule
 * 判断当前区间并取价。DeepSeek 与其它提供商的唯一差别都在表里（币种、schedule、
 * 有没有法定节假日），代码不分叉。查不到 provider 或模型时返回 known=false 的占位
 * 结果，调用方据此隐藏价格——绝不按模型名猜价。
 *
 * @returns {{ input, cacheRead, cacheWrite, output, currency, window, next, model,
 *   requested, provider, known, via }}
 *   window 为 'peak'（当前是贵的一侧）/ 'idle'（便宜的一侧）/ null（全天一价）；
 *   next 为 { peak, at, ms }（下一次翻转）或 null（全天一价）。
 */
export function quoteAt(model, ms, provider, holidays = HOLIDAY_DAYS) {
  const now = Number.isFinite(ms) ? ms : Date.now();
  const requested = typeof model === 'string' ? model : '';
  const providerId = typeof provider === 'string' ? provider.trim().toLowerCase() : '';

  const table = tableOf(providerId);
  const found = table !== null && requested.trim() !== '' ? lookupModel(table, requested) : null;
  if (table !== null && found !== null) {
    const entry = table.models[found.id];
    // 没有 offPeak 的模型全天一价；有 offPeak 才按 provider 的 schedule 判区间。
    const schedule = entry.offPeak ? table.schedule ?? null : null;
    const expensive = schedule !== null && inExpensiveWindow(now, schedule, holidays);
    return {
      ...priceOf(entry, expensive),
      currency: table.currency ?? 'CNY',
      window: schedule === null ? null : (expensive ? 'peak' : 'idle'),
      next: schedule === null ? null : nextWindowChange(now, schedule, holidays),
      model: found.id,
      requested,
      provider: providerId,
      known: true,
      via: found.via,
    };
  }

  // 兜底：没有价格就是没有数字（known=false），不拿同名的其它模型顶替。
  return {
    input: null,
    cacheRead: null,
    cacheWrite: null,
    output: null,
    currency: 'CNY',
    window: null,
    next: null,
    model: null,
    requested,
    provider: typeof provider === 'string' ? provider : '',
    known: false,
    via: 'fallback',
  };
}

/** 兼容旧名：宿主与测试仍以 unitAt 调用。 */
export const unitAt = quoteAt;
