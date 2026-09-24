/**
 * dsh-deepseek-usage — 定价表（元 / 百万 tokens）。
 *
 * 价格唯一来源：下方 PRICE_TABLE 内置表——DeepSeek 官方峰谷定价快照
 * （2026-09-10 官方价格页）。官方调价时随插件版本更新本表。
 *
 * 模型改名（0.6.0 起）：官方会把模型改名并把旧名保留为别名（如
 * deepseek-v4-flash / deepseek-v4-flash-vision-exp → deepseek-flash）。旧名若
 * 落到内置表就会长期显示过期价且无从察觉，因此：
 *   · MODEL_ALIASES 维护"旧名 → 现名"的显式映射；
 *   · 查不到时先试别名，再试"同家族唯一匹配"（flash / pro / chat /
 *     reasoner），命中即按现名计价；
 *   · 两条路径都会在 unitAt() 的 via 字段里标出来源，供排查，避免静默算错。
 *
 * 峰谷（官方口径）：高峰时段为北京时间周一至周五（**不含中国法定节假日**）
 * 9:00–12:00、14:00–18:00，其余（含整个周末、法定节假日全天、以及调休上班的
 * 周末）为空闲时段；缓存写暂不计费（cacheWrite = 0）。
 * 因此只有"落在工作日里的法定节假日"会改变判定结果——周末无论是否调休上班都
 * 是空闲，见 HOLIDAY_RANGES。
 *
 * 本文件用于卡片"当前档单价"展示、峰谷指示灯，以及 nextChange() 给出的
 * 「距下次峰谷切换倒计时」（卡片上显示为 `2d 15h` / `5h 47m` 这类英文单位时长）。
 *
 * 时区（0.1.7 起）：峰谷判定与"每日"边界均按北京时间（Asia/Shanghai，固定
 * UTC+8，无夏令时）计算，不随服务器本地时区变化——在任何时区部署的 DSH 上
 * 显示一致。
 */

/** 北京时间固定偏移（上海无夏令时）。 */
export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 价格表：input（缓存未命中）/ cacheRead（缓存命中）/ output 均为 [高峰, 空闲]
 * 二元组；cacheWrite 为常量 0。官方改价时更新本表并发布新版本。
 */
const PRICE_TABLE = {
  'deepseek-flash': { input: [2, 1], cacheRead: [0.04, 0.02], cacheWrite: 0, output: [8, 4] },
  'deepseek-v4-pro': { input: [9, 4.5], cacheRead: [0.3, 0.15], cacheWrite: 0, output: [27, 13.5] },
  'deepseek-chat': { input: [2, 2], cacheRead: [0.5, 0.5], cacheWrite: 0, output: [8, 8] },
  'deepseek-reasoner': { input: [4, 4], cacheRead: [1, 1], cacheWrite: 0, output: [16, 16] },
};

/**
 * 旧模型名 → 现模型名（官方改名后旧名仍可调用，且按现模型价格计费）。
 * 见官方价格页脚注：deepseek-v4-flash / deepseek-v4-flash-vision-exp 由
 * DeepSeek-V4.1-Flash 提供服务，按 Flash 价格计费。
 */
export const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
};

/** 默认模型（当 agentDefaultModel 不可用时的展示默认）。 */
export const DEFAULT_MODEL = 'deepseek-flash';

/** 高峰时段窗口（北京时间，含起点不含终点）。 */
export const PEAK_WINDOWS = [[9, 12], [14, 18]];
/** 官方口径：高峰仅限周一至周五（北京时间），周末整天为空闲时段。 */
export const PEAK_WEEKDAYS_ONLY = true;
/** 高峰时段展示文案（中文）。 */
export const PEAK_HOURS_TEXT = '周一至周五（不含法定节假日）9:00–12:00、14:00–18:00（北京时间）';
/** 高峰时段展示文案（英文）。 */
export const PEAK_HOURS_TEXT_EN = 'Mon–Fri (excluding public holidays) 9:00–12:00, 14:00–18:00 (Beijing Time)';

/**
 * 中国法定节假日放假日期（含起止，闭区间；北京时间的日历日）。
 * 来源：国务院办公厅《关于 2026 年部分节假日安排的通知》（国办发明电〔2025〕7号）。
 * 官方口径：法定节假日全天、调休上班的周末均为空闲时段——周末本来就空闲，所以
 * 只需列"放假日期"，落在工作日里的那几天才会把判定从高峰翻成空闲。
 * 下一年的安排通常在前一年 11 月发布，届时更新本表；当前年份未收录时由
 * lib/index.js 在启动时告警（见 hasHolidayYear）。
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

/** 把 [起, 止] 闭区间展开成日期键集合（`yyyy-mm-dd`，O(1) 查表）。 */
function expandHolidayRanges(ranges) {
  const set = new Set();
  const DAY = 24 * 60 * 60 * 1000;
  for (const [from, to] of ranges) {
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    for (let t = start; t <= end; t += DAY) set.add(new Date(t).toISOString().slice(0, 10));
  }
  return set;
}

const HOLIDAY_DAYS = expandHolidayRanges(HOLIDAY_RANGES);

/** 某时刻的北京时间日期键（`yyyy-mm-dd`）。 */
export function beijingDateKey(ms) {
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** 该时刻所在的北京时间日历日是否为中国法定节假日（放假日期）。 */
export function isHoliday(ms) {
  return HOLIDAY_DAYS.has(beijingDateKey(ms));
}

/** 是否收录了某一年（北京时间年份）的节假日安排；未收录时界面可能把节假日当高峰。 */
export function hasHolidayYear(year) {
  const prefix = `${year}-`;
  for (const day of HOLIDAY_DAYS) {
    if (day.startsWith(prefix)) return true;
  }
  return false;
}

/** 某时刻是否为高峰时段（按北京时间；法定节假日全天与周末恒为空闲）。 */
export function isPeak(ms) {
  const now = Number.isFinite(ms) ? ms : Date.now();
  if (isHoliday(now)) return false; // 法定节假日：全天空闲
  const d = new Date(now + SHANGHAI_OFFSET_MS);
  if (PEAK_WEEKDAYS_ONLY) {
    const dow = d.getUTCDay(); // 0 = 周日
    if (dow === 0 || dow === 6) return false;
  }
  const h = d.getUTCHours();
  return PEAK_WINDOWS.some(([start, end]) => h >= start && h < end);
}

/**
 * 距下一个计费时段边界的剩余时间（供卡片显示倒计时）。
 *
 * 与 isPeak 同源同口径（北京时间、工作日、PEAK_WINDOWS 半开区间），只是换一个视图：
 * 返回「下一次 isPeak 结果发生翻转」的时刻。注意空闲时段里的下一次切换**不等于**下一个
 * 整点：
 *   · 12:00–14:00 午休 → 下一次切换是 14:00（高峰开始）；
 *   · 周五 18:00 之后、整个周末 → 下一次切换是下周一 09:00（跨 2 天多）。
 * 因此倒计时必须能显示「天」。
 *
 * 实现：逐分钟向前探测（上限 16 天：覆盖春节这类"长假最后一天 18:00 → 假期后
 * 第一个工作日 09:00"的最长空档，2026 年春节为 10 天半）。纯算术，无时区/日历依赖。
 * 任何口径变更必须同时改 isPeak / PEAK_WINDOWS / PEAK_WEEKDAYS_ONLY / HOLIDAY_RANGES，
 * 以及 lib/client.js 里为浏览器侧镜像的同名常量（那边无法 import 本模块）。
 *
 * @returns {{ peak: boolean, at: number, ms: number }} peak=切换后所处的时段，
 *   at=切换发生的时刻（ms 时间戳，新时段在此刻生效），ms=剩余毫秒（不会为负）。
 */
export function nextChange(ms) {
  const now = Number.isFinite(ms) ? ms : Date.now();
  const current = isPeak(now);
  // 逐分钟探测（上限 16 天：覆盖"春节长假 → 假期后首个工作日早晨"的最长空档）
  for (let step = 1; step <= 16 * 24 * 60; step += 1) {
    const at = now + step * 60 * 1000;
    const peak = isPeak(at);
    if (peak !== current) return { peak, at, ms: Math.max(0, at - now) };
  }
  // 理论上不可达（不变量：一周内必有边界）；兜底给"下一天 09:00"方向的最小值
  return { peak: !current, at: now, ms: 0 };
}

/** 模型家族名（用于官方改名后的兜底匹配）。 */
function familyOf(id) {
  const m = /(flash|pro|chat|reasoner)/.exec(id);
  return m ? m[1] : null;
}

const has = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);

/** 别名（旧名 → 现名）。 */
function aliasOf(id) {
  if (typeof id !== 'string' || id === '') return undefined;
  return MODEL_ALIASES[id];
}

/** 在价格表里找模型：精确 → 别名 → 同家族唯一匹配。 */
function lookupId(id) {
  if (typeof id !== 'string' || id === '') return null;
  if (has(PRICE_TABLE, id)) return { id, via: 'exact' };
  const alias = aliasOf(id);
  if (alias && has(PRICE_TABLE, alias)) return { id: alias, via: 'alias' };
  const fam = familyOf(id);
  if (fam) {
    const hits = Object.keys(PRICE_TABLE).filter((k) => familyOf(k) === fam);
    // 仅在家族唯一时匹配，避免把 flash 档算成 pro 档。
    if (hits.length === 1) return { id: hits[0], via: 'family' };
  }
  return null;
}

/**
 * 解析模型的计价条目：精确 → 别名 → 同家族唯一匹配 → chat 档兜底。
 * @returns {{ price: object, id: string, via: 'exact'|'alias'|'family'|'fallback', known: boolean }}
 */
function lookup(model) {
  const found = lookupId(model);
  if (found) return { price: PRICE_TABLE[found.id], id: found.id, via: found.via, known: true };
  return { price: PRICE_TABLE['deepseek-chat'], id: 'deepseek-chat', via: 'fallback', known: false };
}

/** 模型是否能解析出价格（内置表精确命中 / 别名 / 家族匹配）。 */
export function isKnownModel(model) {
  return lookup(model).known;
}

/**
 * 某模型在某一时刻的单位价格（元/百万 tokens）。
 * 未知模型回退 chat 档；known=false 供调用方提示，避免静默算错。
 * via 说明取价路径（exact / alias / family / fallback），供排查与回归测试。
 */
export function unitAt(model, ms) {
  const found = lookup(model);
  const p = found.price;
  const tier = isPeak(ms) ? 0 : 1;
  return {
    input: p.input[tier],
    cacheRead: p.cacheRead[tier],
    cacheWrite: p.cacheWrite,
    output: p.output[tier],
    model: found.id,
    requested: typeof model === 'string' ? model : '',
    known: found.known,
    via: found.via,
  };
}
