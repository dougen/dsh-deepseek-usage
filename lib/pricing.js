/**
 * dsh-deepseek-usage — 定价表（元 / 百万 tokens）。
 *
 * 价格来源优先级（0.7.0 起，三层）：
 * - remote（进程内最新）：DeepSeek 官方"模型 & 价格"页（lib/pricing-remote.js 抓取，
 *   每日首次访问/点击卡片时刷新），解析结果经 setRemotePrices() 注入本模块——官方调价
 *   只需页面更新，无需改本文件。
 * - file（本地价格配置表）：lib/pricing-store.js 维护的 pricing.json，内容是"上次同步到
 *   的官方价 + 用户手改的价"，经 setFilePrices() 注入。进程重启后 remote 层为空，卡片
 *   直接用它，因此不会再退回内置表（也就不会再出现"价格未同步（用内置表）"）。
 * - seed（内置兜底）：下方 PRICE_TABLE 内置种子表——DeepSeek 官方峰谷定价快照
 *   （2026-09-10，与当时官方价格页一致）。首次运行会拿它生成初始 pricing.json；
 *   只有"本地价格表缺失/损坏且官方页也拿不到"时才会真正被展示。
 *
 * 模型改名（0.6.0 起）：官方会把模型改名并把旧名保留为别名（如
 * deepseek-v4-flash / deepseek-v4-flash-vision-exp → deepseek-flash）。旧名若
 * 落到内置表就会长期显示过期价且无从察觉，因此：
 *   · MODEL_ALIASES 维护"旧名 → 现名"的显式映射；
 *   · 远端表查不到时先试别名，再试"同家族唯一匹配"（flash / pro / chat /
 *     reasoner），命中即按现名计价；
 *   · 两条路径都会在 unitAt() 的 via 字段里标出来源，供界面提示，避免静默算错。
 *
 * 峰谷（官方口径）：高峰时段为北京时间周一至周五 9:00–12:00、14:00–18:00，
 * 其余（含整个周末）为空闲时段；缓存写暂不计费（cacheWrite = 0）。
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
 * 内置种子表：input（缓存未命中）/ cacheRead（缓存命中）/ output 均为
 * [高峰, 空闲] 二元组；cacheWrite 为常量 0。
 * 只用于两处：首次运行生成 pricing.json（lib/pricing-store.js），以及"价格表缺失/
 * 损坏且官方页也拿不到"时的最后兜底；正常运行时都会被 file / remote 层覆盖。
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

/** 远端官方价格（setRemotePrices 注入，按模型覆盖种子表；key 与种子一致）。 */
let remoteTable = null;
/** 远端同步元信息（解析策略 / 抓取时间 / 来源），供界面展示同步状态。 */
let remoteMeta = null;
/** 本地价格配置表（setFilePrices 注入；重启后由它接管，见 lib/pricing-store.js）。 */
let fileTable = null;
/** 本地价格表元信息（路径 / 上次写入时间 / 来源）。 */
let fileMeta = null;
/** 本地价格表里的模型别名（旧名 → 现名），与内置 MODEL_ALIASES 合并使用。 */
let fileAliases = {};

/** 默认模型（当 agentDefaultModel 不可用时的展示默认）。 */
export const DEFAULT_MODEL = 'deepseek-flash';

/** 高峰时段窗口（北京时间，含起点不含终点）。 */
export const PEAK_WINDOWS = [[9, 12], [14, 18]];
/** 官方口径：高峰仅限周一至周五（北京时间），周末整天为空闲时段。 */
export const PEAK_WEEKDAYS_ONLY = true;
/** 高峰时段展示文案（中文）。 */
export const PEAK_HOURS_TEXT = '周一至周五 9:00–12:00、14:00–18:00（北京时间）';
/** 高峰时段展示文案（英文）。 */
export const PEAK_HOURS_TEXT_EN = 'Mon–Fri 9:00–12:00, 14:00–18:00 (Beijing Time)';

/** 某时刻的北京时间小时（0–23）。 */
export function shanghaiHour(ms) {
  return new Date(ms + SHANGHAI_OFFSET_MS).getUTCHours();
}

/** 某时刻是否为高峰时段（按北京时间；周末非工作日恒为空闲）。 */
export function isPeak(ms) {
  const d = new Date(ms + SHANGHAI_OFFSET_MS);
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
 * 实现：逐分钟向前探测（上限 8 天），纯算术，无时区/日历依赖。
 * 任何口径变更必须同时改 isPeak / PEAK_WINDOWS / PEAK_WEEKDAYS_ONLY，以及
 * lib/client.js 里为浏览器侧镜像的同名常量（那边无法 import 本模块）。
 *
 * @returns {{ peak: boolean, at: number, ms: number }} peak=切换后所处的时段，
 *   at=切换发生的时刻（ms 时间戳，新时段在此刻生效），ms=剩余毫秒（不会为负）。
 */
export function nextChange(ms) {
  const now = Number.isFinite(ms) ? ms : Date.now();
  const current = isPeak(now);
  // 逐分钟探测（上限 8 天：覆盖"周五晚 → 下周一早"的最长空档）
  for (let step = 1; step <= 8 * 24 * 60; step += 1) {
    const at = now + step * 60 * 1000;
    const peak = isPeak(at);
    if (peak !== current) return { peak, at, ms: Math.max(0, at - now) };
  }
  // 理论上不可达（不变量：一周内必有边界）；兜底给"下一天 09:00"方向的最小值
  return { peak: !current, at: now, ms: 0 };
}

/** 清洗一张价格表（形状校验 + 档位回退），供 remote / file 两层共用。 */
function cleanTable(table) {
  if (!table || typeof table !== 'object') return null;
  const okPair = (v) => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(n) && n >= 0);
  const clean = {};
  for (const [id, e] of Object.entries(table)) {
    if (typeof id !== 'string' || id === '' || !e || typeof e !== 'object') continue;
    const input = okPair(e.input) ? e.input : null;
    if (!input) continue;
    clean[id] = {
      input,
      cacheRead: okPair(e.cacheRead) ? e.cacheRead : input,
      cacheWrite: 0,
      output: okPair(e.output) ? e.output : input,
    };
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

/** 注入远端官方价格（parseOfficialPrices 的结果）；传 null/空表即清除回下一层。 */
export function setRemotePrices(table, meta) {
  remoteTable = cleanTable(table);
  remoteMeta = remoteTable && meta && typeof meta === 'object' ? { ...meta } : null;
}

/** 远端同步元信息（未同步/同步失败时为 null）。 */
export function remotePriceMeta() {
  return remoteMeta ? { ...remoteMeta } : null;
}

/** 远端价格表是否可用。 */
export function hasRemotePrices() {
  return remoteTable !== null;
}

/**
 * 注入本地价格配置表（lib/pricing-store.js 的读取结果）。
 * @param table 模型映射（models 字段）
 * @param meta 元信息（path / updatedAt / source / strategy / autoUpdate）
 * @param aliases 文件里的模型别名（旧名 → 现名），与内置 MODEL_ALIASES 合并
 */
export function setFilePrices(table, meta, aliases) {
  fileTable = cleanTable(table);
  fileMeta = fileTable && meta && typeof meta === 'object' ? { ...meta } : null;
  fileAliases = aliases && typeof aliases === 'object' && !Array.isArray(aliases) ? { ...aliases } : {};
}

/** 本地价格表元信息（未载入时为 null）。 */
export function filePriceMeta() {
  return fileMeta ? { ...fileMeta } : null;
}

/** 本地价格表是否可用。 */
export function hasFilePrices() {
  return fileTable !== null;
}

/** 内置种子价格表快照（深拷贝；用于首次运行生成 pricing.json）。 */
export function seedPrices() {
  return JSON.parse(JSON.stringify(PRICE_TABLE));
}

/** 内置模型改名映射快照（用于首次运行生成 pricing.json）。 */
export function seedAliases() {
  return { ...MODEL_ALIASES };
}

/** 模型家族名（用于官方改名后的兜底匹配）。 */
function familyOf(id) {
  const m = /(flash|pro|chat|reasoner)/.exec(id);
  return m ? m[1] : null;
}

const has = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);

/** 别名（旧名 → 现名）：本地价格表的 aliases 覆盖内置 MODEL_ALIASES。 */
function aliasOf(id) {
  if (typeof id !== 'string' || id === '') return undefined;
  return has(fileAliases, id) ? fileAliases[id] : MODEL_ALIASES[id];
}

/** 在某一层价格表里找模型：精确 → 别名 → 同家族唯一匹配。 */
function layerLookup(table, tag, id) {
  if (!table || typeof id !== 'string' || id === '') return null;
  if (has(table, id)) return { id, via: tag };
  const alias = aliasOf(id);
  if (alias && has(table, alias)) return { id: alias, via: `${tag}-alias` };
  const fam = familyOf(id);
  if (fam) {
    const hits = Object.keys(table).filter((k) => familyOf(k) === fam);
    // 仅在家族唯一时匹配，避免把 flash 档算成 pro 档。
    if (hits.length === 1) return { id: hits[0], via: `${tag}-family` };
  }
  return null;
}

/**
 * 解析模型的计价条目（优先级：remote → file → seed → chat 兜底）。
 * @returns {{ price: object, id: string, via: 'remote'|'remote-alias'|'remote-family'|'file'|'file-alias'|'file-family'|'alias'|'seed'|'fallback', source: 'remote'|'file'|'seed', known: boolean }}
 */
function lookup(model) {
  const remote = layerLookup(remoteTable, 'remote', model);
  if (remote) return { price: remoteTable[remote.id], id: remote.id, via: remote.via, source: 'remote', known: true };

  // 进程重启后 remote 层为空 → 先用本地价格表（上次同步到的官方价 / 用户手改价）。
  const file = layerLookup(fileTable, 'file', model);
  if (file) return { price: fileTable[file.id], id: file.id, via: file.via, source: 'file', known: true };

  // 本地表也没有（首次运行、文件损坏、或模型确实不在表里）→ 内置种子兜底。
  const alias = aliasOf(model);
  if (alias && has(PRICE_TABLE, alias)) {
    return { price: PRICE_TABLE[alias], id: alias, via: 'alias', source: 'seed', known: true };
  }
  if (has(PRICE_TABLE, model)) {
    return { price: PRICE_TABLE[model], id: model, via: 'seed', source: 'seed', known: true };
  }
  return { price: PRICE_TABLE['deepseek-chat'], id: 'deepseek-chat', via: 'fallback', source: 'seed', known: false };
}

/** 模型是否能解析出价格（远端精确/别名/家族，或本地表/内置表）。 */
export function isKnownModel(model) {
  return lookup(model).known;
}

/**
 * 某模型在某一时刻的单位价格（元/百万 tokens）。
 * 未知模型回退 chat 档；known=false 供调用方提示，避免静默算错。
 * via 说明取价路径，source 说明价格来自哪一层（remote 官方页本次同步 / file 本地价格表 /
 * seed 内置兜底）；layerAt 是该层数据的时间戳（remote.fetchedAt / file.updatedAt），
 * 供界面说明"这份价是什么时候同步的"。
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
    source: found.source,
    layerAt:
      found.source === 'remote'
        ? (remoteMeta && Number.isFinite(remoteMeta.fetchedAt) ? remoteMeta.fetchedAt : null)
        : found.source === 'file'
          ? (fileMeta && Number.isFinite(fileMeta.updatedAt) ? fileMeta.updatedAt : null)
          : null,
  };
}
