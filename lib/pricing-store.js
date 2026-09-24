/**
 * dsh-deepseek-usage — 本地价格配置表（磁盘文件，lib/pricing.js 的数据源之一）。
 *
 * 为什么有这一层：价格同步状态原来只活在进程内存里，dsh 一重启就没了，于是重启后
 * 的第一张卡片只能用代码内置的价格表（表现为"价格未同步（用内置表）"）。现在把
 * "模型 → 档单价"从代码里抽出来存成配置文件：
 *
 *   启动  → 读本文件（上次同步到的官方价 / 用户手改的价）→ 卡片立刻有价
 *   每天/点击 → 拉官方价格页 → 合并回写本文件（官方条目覆盖同名项，用户自加条目保留）
 *
 * 路径解析优先级：
 *   1. 环境变量 DEEPSEEK_USAGE_PRICE_FILE（显式指定，测试/多实例用）
 *   2. <DSH_HOME|~/.dsh>/dsh-deepseek-usage/pricing.json
 *
 * 文件格式（JSON；允许**整行** `//` 注释，方便手改）：
 * {
 *   "version": 1,
 *   "autoUpdate": true,             // false = 手动模式：不再联网同步，直接用本表
 *   "updatedAt": 1789090582880,     // 上次写入时间（ms；也接受 ISO 字符串）
 *   "updatedFrom": "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
 *   "strategy": "table",            // 官方页解析策略（table=结构化表格 / flat=文本兜底 / seed=内置快照）
 *   "aliases": { "deepseek-v4-flash": "deepseek-flash" },
 *   "models": {
 *     "deepseek-flash": { "input": [2, 1], "cacheRead": [0.04, 0.02], "cacheWrite": 0, "output": [8, 4] }
 *   }
 * }
 * 单价单位：元 / 百万 tokens；input / cacheRead / output 均为 [高峰, 空闲] 两档
 * （cacheWrite 目前官方不计费，恒 0）。也接受"整个文件就是模型映射"的简写形式：
 * { "deepseek-flash": { "input": [2, 1], ... } }
 *
 * 写入策略：读-改-写 + 原子替换（先写同目录 .tmp 再 rename），避免半截文件。
 * 本文件不做任何网络访问，也不含运行时状态（解析 → 返回，交给调用方注入）。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 价格表文件格式版本（结构不兼容时递增）。 */
export const PRICE_FILE_VERSION = 1;
/** 价格表路径覆盖（便于测试与多实例）。 */
const FILE_ENV = "DEEPSEEK_USAGE_PRICE_FILE";
/** DSH 家目录覆盖（与 dsh-home-paths 的约定一致）。 */
const HOME_ENV = "DSH_HOME";
/** 插件在 DSH 家目录下的子目录 / 文件名。 */
const DIR_NAME = "dsh-deepseek-usage";
const FILE_NAME = "pricing.json";

/** 写进文件的格式说明（JSON 无注释，只能占一个字段）。 */
const FILE_COMMENT =
  "dsh-deepseek-usage 价格表：input/cacheRead/output 为 [高峰, 空闲] 两档单价，单位 元/百万 tokens；"
  + "autoUpdate=true 时插件每天首次使用（或点击卡片）会拉取官方价格页并回写本文件——"
  + "官方页列出的模型覆盖同名条目，你自己加的条目保留；autoUpdate=false 表示不再联网同步，完全以本表为准。"
  + "允许整行 // 注释。";

/** 当前生效的价格表路径（env > DSH_HOME/dsh-deepseek-usage/pricing.json > ~/.dsh/...）。 */
export function defaultPriceFilePath() {
  const fromEnv = process.env[FILE_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  const home = process.env[HOME_ENV];
  const base = typeof home === "string" && home.trim() !== "" ? home.trim() : join(homedir(), ".dsh");
  return join(base, DIR_NAME, FILE_NAME);
}

/** 只剥掉"整行 //"注释：URL 里的 `//` 在行中间，不会被误伤。 */
function stripLineComments(text) {
  return text
    .split(/\r?\n/)
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
}

/** [高峰, 空闲] 二元组校验。 */
const okPair = (v) => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(n) && n >= 0);

/** 时间容忍数字（ms）/ ISO 字符串。 */
function toMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** 清洗模型映射：非法条目丢弃并记入 dropped（缺失的档位回退到 input 档）。 */
function cleanModels(raw) {
  const models = {};
  const dropped = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { models, dropped };
  for (const [id, entry] of Object.entries(raw)) {
    if (typeof id !== "string" || id === "" || !entry || typeof entry !== "object" || Array.isArray(entry)) {
      dropped.push(String(id));
      continue;
    }
    const input = okPair(entry.input) ? entry.input.slice() : null;
    if (!input) {
      dropped.push(id);
      continue;
    }
    const cacheWrite = Number(entry.cacheWrite);
    models[id] = {
      input,
      cacheRead: okPair(entry.cacheRead) ? entry.cacheRead.slice() : input.slice(),
      cacheWrite: Number.isFinite(cacheWrite) && cacheWrite >= 0 ? cacheWrite : 0,
      output: okPair(entry.output) ? entry.output.slice() : input.slice(),
    };
  }
  return { models, dropped };
}

/** 清洗别名映射（旧名 → 现名）。 */
function cleanAliases(raw) {
  const aliases = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return aliases;
  for (const [from, to] of Object.entries(raw)) {
    if (typeof from === "string" && from !== "" && typeof to === "string" && to !== "") aliases[from] = to;
  }
  return aliases;
}

/** 按键名排序（让文件 diff 稳定、便于人读）。 */
function sorted(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * 解析价格表 JSON 文本。
 * @throws 根节点/模型条目完全不合法时抛错（调用方据此判定"文件损坏"）。
 * @returns {{ doc: { version, autoUpdate, updatedAt, updatedFrom, strategy, aliases, models }, dropped: string[] }}
 */
export function parsePriceTable(text) {
  const raw = JSON.parse(stripLineComments(String(text)));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("价格表根节点必须是对象");

  // 显式结构（带 models/autoUpdate/... 字段）与简写结构（整个文件就是模型映射）都支持。
  const explicit = ["models", "aliases", "autoUpdate", "updatedAt", "updatedFrom", "strategy", "version"].some(
    (k) => raw[k] !== undefined,
  );
  const { models, dropped } = cleanModels(explicit ? raw.models : raw);
  if (Object.keys(models).length === 0) {
    throw new Error("价格表里没有可用模型条目（每项至少要有 input: [高峰, 空闲]）");
  }
  return {
    doc: {
      version: Number.isFinite(Number(raw.version)) ? Number(raw.version) : PRICE_FILE_VERSION,
      autoUpdate: raw.autoUpdate !== false,
      updatedAt: toMs(raw.updatedAt),
      updatedFrom: typeof raw.updatedFrom === "string" && raw.updatedFrom !== "" ? raw.updatedFrom : null,
      strategy: typeof raw.strategy === "string" && raw.strategy !== "" ? raw.strategy : null,
      aliases: explicit ? sorted(cleanAliases(raw.aliases)) : {},
      models: sorted(models),
    },
    dropped,
  };
}

/**
 * 读取价格表文件。
 * @returns {{ path: string, exists: boolean, error: string|null, table: object|null, warnings: string[] }}
 *   exists=false 表示文件不存在（首次运行，error 为 null）；table=null 且 error 非空表示文件损坏。
 */
export function loadPriceTable(options = {}) {
  const path = options.path ?? defaultPriceFilePath();
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : void 0;
    return {
      path,
      exists: false,
      error: code === "ENOENT" ? null : error instanceof Error ? error.message : String(error),
      table: null,
      warnings: [],
    };
  }
  try {
    const { doc, dropped } = parsePriceTable(text);
    return {
      path,
      exists: true,
      error: null,
      table: doc,
      warnings: dropped.length > 0 ? [`忽略 ${dropped.length} 个无法解析的模型条目：${dropped.join(", ")}`] : [],
    };
  } catch (error) {
    return {
      path,
      exists: true,
      error: error instanceof Error ? error.message : String(error),
      table: null,
      warnings: [],
    };
  }
}

/** 文件状态（用于"手改价格表后免重启生效"的变更探测）。 */
export function priceTableStat(options = {}) {
  const path = options.path ?? defaultPriceFilePath();
  try {
    const st = statSync(path);
    return { path, exists: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { path, exists: false, mtimeMs: 0, size: 0 };
  }
}

/**
 * 合并写回价格表：patch.models / patch.aliases 覆盖同名项，其余条目（含用户自加模型）
 * 保留；未给出的字段沿用磁盘上的旧值。写盘为"临时文件 + rename"原子替换。
 * @returns {{ path: string, doc: object }}
 */
export function savePriceTable(patch = {}, options = {}) {
  const path = options.path ?? defaultPriceFilePath();
  const base = loadPriceTable({ path }).table ?? {
    version: PRICE_FILE_VERSION,
    autoUpdate: true,
    updatedAt: null,
    updatedFrom: null,
    strategy: null,
    aliases: {},
    models: {},
  };
  const { models } = cleanModels({ ...base.models, ...(patch.models ?? {}) });
  const aliases = cleanAliases({ ...base.aliases, ...(patch.aliases ?? {}) });
  const doc = {
    $comment: FILE_COMMENT,
    version: PRICE_FILE_VERSION,
    autoUpdate: patch.autoUpdate ?? base.autoUpdate ?? true,
    updatedAt: patch.updatedAt ?? Date.now(),
    updatedFrom: patch.updatedFrom ?? base.updatedFrom ?? null,
    strategy: patch.strategy ?? base.strategy ?? null,
    aliases: sorted(aliases),
    models: sorted(models),
  };

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不影响报错 */
    }
    throw error;
  }
  return { path, doc };
}
