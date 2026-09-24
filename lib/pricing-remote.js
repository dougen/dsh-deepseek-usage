/**
 * dsh-deepseek-usage — 官方"模型 & 价格"页抓取与解析（lib/pricing.js 的远端数据源）。
 *
 * 数据源： https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * 该页为静态站点、服务端直出 HTML：无需登录、无需浏览器执行 JS。
 * 官方调整价格/改版后页面随之更新，插件每日首次访问或点击卡片时重拉即可跟随，
 * 无需随官方改价更新内置价格表。
 *
 * ---------------------------------------------------------------------------
 * 解析策略（0.6.0 起按优先级依次尝试，任一成功即返回）
 *
 *   1. 结构化表格解析 parseTablePrices() —— 只依赖"表格 + `N元` 价格单元格"这一
 *      语义结构：
 *        · 模型列由表头行（单元格文本就是一个模型 id）确定，列序即价格列序；
 *        · 每行末尾连续的 `N元` 单元格就是各模型该行的价格；
 *        · 行内标签给出维度（缓存命中 / 缓存未命中 / 输出）与时段（空闲 / 高峰）。
 *      因此对页面导航、脚注、"输出长度"这类同名前缀文本、行序、rowspan/colspan
 *      合并不敏感——官方 2026-09 改版（模型改名 deepseek-v4-flash → deepseek-flash、
 *      表头结构变化）即属于这类"排版变化"，策略 1 不受影响。
 *
 *   2. 行主序纯文本兜底 parseFlatPrices() —— 0.5.x 的启发式（去标签后按
 *      "标签紧跟价格"顺序对齐）。仅在策略 1 失败时使用，用于表格被拆散、
 *      价格被渲染成非表格结构等少数情况。
 *
 * 两种策略共用同一套数值校验：三个维度 × 空闲/高峰 都必须"恰好每模型一格"、
 * 价格 > 0、高峰 ≥ 空闲、高峰/空闲 比值 ≤ 4。任一不满足即判该策略失败，
 * 全部失败则返回 null，由调用方（lib/index.js → lib/pricing.js）回退内置表，
 * 并把"未同步"状态透出到界面，不静默展示旧价。
 * ---------------------------------------------------------------------------
 *
 * 本文件不含运行时状态：fetchOfficialPrices() 取 HTML，parseOfficialPrices()
 * 解析为 { models, meta }；"每日一次"的节流与注入由 lib/index.js 负责，
 * 解析结果经 pricing.setRemotePrices() 注入。
 *
 * 自检（页面再次改版时可先用它离线定位）：
 *   node lib/pricing-remote.js --check                    # 联网拉取并打印解析结果
 *   node lib/pricing-remote.js --check --save page.html    # 顺带存档原始 HTML
 *   node lib/pricing-remote.js --check --html page.html    # 用本地存档 HTML 解析
 *   node lib/pricing-remote.js --check --json              # 机器可读输出
 */
import { pathToFileURL } from "node:url";

/** 官方价格页（中文，人民币计价）。 */
const DEFAULT_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
/** 可选环境变量覆盖（供镜像/代理场景）。 */
const URL_ENV = "DEEPSEEK_USAGE_PRICE_URL";
const USER_AGENT = "Mozilla/5.0 (compatible; dsh-deepseek-usage/0.6; official pricing auto-sync)";

const ENTITY_MAP = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&#39;': "'", '&apos;': "'",
};

/** 合法模型 id（官方页当前只列 deepseek-* 系列）。 */
const MODEL_ID = /^deepseek-[a-z0-9][a-z0-9.-]*$/;
/** 价格单元格：`1元` / `4.5 元` / `0.02元(3)`（容忍脚注与星号）。 */
const PRICE_CELL = /^(\d+(?:\.\d+)?)\s*元\s*(?:[（(]\d+[）)]|\*)*$/u;

const METRICS = ["input", "cacheRead", "output"];

/** 官方价格页 URL（可用环境变量 DEEPSEEK_USAGE_PRICE_URL 覆盖）。 */
export function officialPriceUrl() {
  const v = process.env[URL_ENV];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : DEFAULT_URL;
}

/** 常见 HTML 实体解码（含数字实体）。 */
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (Number.isFinite(code)) {
        try { return String.fromCodePoint(code); } catch {}
      }
      return m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITY_MAP, e.toLowerCase()) ? ENTITY_MAP[e.toLowerCase()] : m;
  });
}

/** 去标签 + 解码实体 + 空白收敛，得到单元格纯文本（`<br>` 视作空格）。 */
function cellText(fragment) {
  return decodeEntities(
    String(fragment)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

/** 把 HTML 拍平成"行主序纯文本"：去脚本/样式/标签，连续空白收敛为单个空格。 */
function flattenHtml(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

/** 去脚注标记（`(1)` / `（2）`），得到干净的单元格文本。 */
function withoutFootnotes(s) {
  return s.replace(/[（(]\d+[）)]/g, '').trim();
}

/** 从一行文本判断计费维度。 */
function metricOf(text) {
  if (/缓存\s*命中/.test(text)) return 'cacheRead';
  if (/缓存\s*未命中|输入/.test(text)) return 'input';
  if (/输出/.test(text)) return 'output';
  return null;
}

/** 从一行文本判断峰谷时段。 */
function tierOf(text) {
  if (/空闲时段|非高峰|off[\s-]?peak/i.test(text)) return 'idle';
  if (/高峰时段|peak/i.test(text)) return 'peak';
  return null;
}

/**
 * 把一行拆成"末尾连续的价格单元格 + 其余标签单元格"。
 * colspan 会展开（合并单元格的价格视为各列同价）。
 */
function splitPriceRow(cells) {
  const prices = [];
  let i = cells.length - 1;
  for (; i >= 0; i -= 1) {
    const m = PRICE_CELL.exec(cells[i].text);
    if (!m) break;
    const n = Number(m[1]);
    for (let k = 0; k < cells[i].colspan; k += 1) prices.push(n);
  }
  prices.reverse();
  return { prices, labels: cells.slice(0, i + 1) };
}

/** 解析一张 `<table>` 的所有行 → 单元格数组（含 colspan）。 */
function tableRows(tableHtml) {
  const rows = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = rowRe.exec(tableHtml)) !== null) {
    const cells = [];
    const cellRe = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let cell;
    while ((cell = cellRe.exec(row[1])) !== null) {
      const attrs = cell[2] || '';
      const span = /colspan\s*=\s*"?(\d+)/i.exec(attrs);
      cells.push({
        text: cellText(cell[3]),
        colspan: span ? Math.max(1, Number(span[1])) : 1,
      });
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/** 组装模型表。ids 顺序即各价格数组的下标顺序。 */
function buildModels(ids, pricePairs) {
  const models = {};
  ids.forEach((id, i) => {
    models[id] = {
      input: [pricePairs.input.peak[i], pricePairs.input.idle[i]],
      cacheRead: [pricePairs.cacheRead.peak[i], pricePairs.cacheRead.idle[i]],
      cacheWrite: 0,
      output: [pricePairs.output.peak[i], pricePairs.output.idle[i]],
    };
  });
  return models;
}

/**
 * 保守数值校验：价格 > 0，高峰 ≥ 空闲，且高峰/空闲 比值不超合理范围
 * （当前官档为 ×2，留一倍余量）。
 */
function numbersLookSane(models) {
  for (const e of Object.values(models)) {
    for (const key of METRICS) {
      const [peak, idle] = e[key];
      if (!(peak > 0 && idle > 0 && peak >= idle && peak / idle <= 4)) return false;
    }
  }
  return true;
}

/**
 * 策略 1：结构化表格解析。
 * @returns {Record<string, object> | null}
 */
export function parseTablePrices(html) {
  const tables = String(html).match(/<table\b[\s\S]*?<\/table>/gi);
  if (!tables) return null;

  for (const table of tables) {
    const rows = tableRows(table);

    // 表头行：含至少一个"单元格文本就是模型 id"的单元格。
    let ids = null;
    for (const row of rows) {
      const found = [];
      for (const c of row) {
        const t = withoutFootnotes(c.text);
        if (MODEL_ID.test(t) && !found.includes(t)) found.push(t);
      }
      if (found.length > 0) { ids = found; break; }
    }
    if (!ids) continue;
    const n = ids.length;

    // 逐行收集价格：维度 × 时段 → 各模型价格。
    const slots = {
      input: { idle: [], peak: [], flat: null },
      cacheRead: { idle: [], peak: [], flat: null },
      output: { idle: [], peak: [], flat: null },
    };
    let lastMetric = null;
    for (const row of rows) {
      const { prices, labels } = splitPriceRow(row);
      if (prices.length === 0) continue;
      const labelText = labels.map((c) => c.text).join(' ');
      const metric = metricOf(labelText) || lastMetric;
      if (!metric || !slots[metric]) continue;
      lastMetric = metric;
      if (prices.length !== n) continue; // 与模型列数不符的行直接跳过（会被完整性校验拦下）
      const tier = tierOf(labelText);
      if (tier) {
        if (slots[metric][tier].length === 0) slots[metric][tier] = prices;
      } else if (slots[metric].flat === null) {
        slots[metric].flat = prices; // 单一时段（官方取消峰谷）时，同一价同时用于高峰/空闲
      }
    }

    const pairs = {};
    let complete = true;
    for (const metric of METRICS) {
      const s = slots[metric];
      if (s.idle.length === n && s.peak.length === n) {
        pairs[metric] = { peak: s.peak, idle: s.idle };
      } else if (s.flat && s.flat.length === n) {
        pairs[metric] = { peak: s.flat, idle: s.flat };
      } else {
        complete = false;
        break;
      }
    }
    if (!complete) continue;

    const models = buildModels(ids, pairs);
    if (!numbersLookSane(models)) continue;
    return models;
  }
  return null;
}

/**
 * 策略 2：行主序纯文本兜底（0.5.x 启发式）。
 * @returns {Record<string, object> | null}
 */
export function parseFlatPrices(html) {
  const flat = flattenHtml(html);

  // 定位价格表区域：模型细节标题之后、并发限制行之前（排除导航/脚注噪音）。
  const start = flat.indexOf('模型细节');
  const end = start === -1 ? -1 : flat.indexOf('并发限制', start);
  const region = start !== -1 && end > start ? flat.slice(start, end) : flat;

  // 模型 id：区域内按首次出现顺序收集（表头在前，脚注/重复被去重）。
  const ids = [];
  for (const m of region.matchAll(/deepseek-[a-z0-9-]+/g)) {
    if (!ids.includes(m[0])) ids.push(m[0]);
  }
  if (ids.length === 0) return null;

  // 结构化 token 游走：metric 标签 →（空闲/高峰）× 紧随其后的价格数字。
  // 注意排除"输出长度"这类前缀相同的非价格行（0.5.x 曾在此处误判）。
  const TOKEN = /缓存命中|缓存未命中|空闲时段|高峰时段|输出(?!\s*长度)(?=\s)|(\d+(?:\.\d+)?)\s*元/g;
  const slots = {
    input: { idle: [], peak: [] },
    cacheRead: { idle: [], peak: [] },
    output: { idle: [], peak: [] },
  };
  let metric = null;
  let tier = null;
  for (const m of region.matchAll(TOKEN)) {
    const t = m[0];
    if (t === '缓存命中') { metric = 'cacheRead'; tier = null; continue; }
    if (t === '缓存未命中') { metric = 'input'; tier = null; continue; }
    if (t === '输出') { metric = 'output'; tier = null; continue; }
    if (t === '空闲时段') { tier = 'idle'; continue; }
    if (t === '高峰时段') { tier = 'peak'; continue; }
    // 仅当处于某 (metric, tier) 上下文时才收数字，否则忽略（如并发数、上下文长度）。
    if (m[1] !== undefined && metric && tier) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) slots[metric][tier].push(n);
    }
  }

  const n = ids.length;
  const pairs = {};
  for (const key of METRICS) {
    if (slots[key].idle.length !== n || slots[key].peak.length !== n) return null;
    pairs[key] = { peak: slots[key].peak, idle: slots[key].idle };
  }

  const models = buildModels(ids, pairs);
  return numbersLookSane(models) ? models : null;
}

/**
 * 解析官方价格页 HTML（先结构化表格，再文本兜底）。
 * @returns {{ models: Record<string, {input:number[],cacheRead:number[],cacheWrite:0,output:number[]}>, meta:{source:string,weekdayPeakOnly:boolean,strategy:'table'|'flat'} } | null}
 */
export function parseOfficialPrices(html) {
  const flat = flattenHtml(html);

  let models = parseTablePrices(html);
  let strategy = 'table';
  if (!models) {
    models = parseFlatPrices(html);
    strategy = 'flat';
  }
  if (!models) return null;

  // 页面脚注若仍写"周一至周五"，记入 meta（峰谷窗口本身以内置配置为准；
  // 脚注位于价格表之后，因此扫整页文本）。
  return {
    models,
    meta: { source: officialPriceUrl(), weekdayPeakOnly: /周一至周五/.test(flat), strategy },
  };
}

/**
 * 拉取官方价格页原始 HTML。
 * @throws 网络失败 / HTTP 非 2xx
 */
export async function fetchPricingHtml(opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 12000;
  const url = officialPriceUrl();
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`pricing page HTTP ${res.status}`);
  return res.text();
}

/**
 * 拉取并解析官方价格页。
 * @returns {{ models, meta: {source, weekdayPeakOnly, strategy, fetchedAt} }}
 * @throws 网络失败 / HTTP 非 2xx / 解析失败（无可用的完整价格表）
 */
export async function fetchOfficialPrices(opts = {}) {
  const html = await fetchPricingHtml(opts);
  const parsed = parseOfficialPrices(html);
  if (!parsed) throw new Error('pricing page parse failed (official page layout changed?)');
  parsed.meta.fetchedAt = Date.now();
  return parsed;
}

// ---------------------------------------------------------------------------
// 自检 CLI：node lib/pricing-remote.js --check [--html <文件>] [--save <文件>] [--json]
// ---------------------------------------------------------------------------
const CLI_ARGS = new Set(['--check', '-c', '--json', '--html', '--save', '--help', '-h']);

function isDirectRun() {
  const arg = process.argv[1];
  if (!arg) return false;
  try { return import.meta.url === pathToFileURL(arg).href; } catch { return false; }
}

function formatTable(models) {
  const lines = [];
  for (const [id, e] of Object.entries(models)) {
    lines.push(
      `${id.padEnd(32)} 输入 ${e.input[0]}/${e.input[1]}  缓存 ${e.cacheRead[0]}/${e.cacheRead[1]}  输出 ${e.output[0]}/${e.output[1]}  (元/百万tokens，高峰/空闲)`,
    );
  }
  return lines.join('\n');
}

async function cli() {
  const argv = process.argv.slice(2);
  const usage = '用法: node lib/pricing-remote.js --check [--html <文件>] [--save <文件>] [--json]';
  if (argv.includes('--help') || argv.includes('-h') || !argv.some((a) => CLI_ARGS.has(a))) {
    console.log(usage);
    return 0;
  }
  const htmlFlag = argv.indexOf('--html');
  const saveFlag = argv.indexOf('--save');
  const asJson = argv.includes('--json');
  const { readFileSync, writeFileSync } = await import('node:fs');
  try {
    let html;
    if (htmlFlag !== -1 && argv[htmlFlag + 1]) {
      html = readFileSync(argv[htmlFlag + 1], 'utf8');
    } else {
      html = await fetchPricingHtml({ timeoutMs: 15000 });
    }
    // 先存档再解析：即使解析失败，原始页面也已留下，便于离线迭代解析策略。
    if (saveFlag !== -1 && argv[saveFlag + 1]) {
      writeFileSync(argv[saveFlag + 1], html);
      if (!asJson) console.log(`已存档原始 HTML: ${argv[saveFlag + 1]}`);
    }
    const parsed = parseOfficialPrices(html);
    if (!parsed) throw new Error('解析失败（策略 table / flat 均未通过校验，官方页可能改版）');
    parsed.meta.fetchedAt = Date.now();
    if (asJson) {
      console.log(JSON.stringify(parsed, null, 2));
    } else {
      console.log(`来源: ${parsed.meta.source}`);
      console.log(`解析策略: ${parsed.meta.strategy}    模型数: ${Object.keys(parsed.models).length}`);
      console.log(formatTable(parsed.models));
      console.log('OK: 价格表解析正常');
    }
    return 0;
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    console.error('提示：用 --save <文件> 存档页面、再用 --html <文件> 离线复现，然后调整本文件的解析策略。');
    return 1;
  }
}

if (isDirectRun()) {
  cli().then((code) => { process.exitCode = code; });
}
