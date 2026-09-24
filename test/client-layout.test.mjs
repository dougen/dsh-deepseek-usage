// dsh-deepseek-usage — 卡片布局回归测试（node --test）。
//
// 背景 1：0.6.0 把"当前档单价"那一行从"右侧内容宽度"改成"整行 flex 容器"时，
// 误用了 justify-content: space-between——容器只有一个子元素时 space-between
// 会把它推到最左边，单价就跑到卡片左侧了。
// 背景 2（0.9.0）：卡片去技术化。此前的"价格来源提示"与"提示态/普通态点击切换"
// 已整体删除：卡片上只保留余额、当前档单价、状态圆点与「距下次峰谷切换倒计时」；
// 圆点不再有任何 title（历史上它塞过同步时间与价格表路径）；插件的内部概念
// （同步状态、计价来源、pricing.json、模型改名）一律不出现在卡片文本里。
// 唯一的交互是点击卡片刷新；只有余额类错误才把卡片置空。
//
// 这里用最小 react shim 渲染出组件树，直接断言：
//   · 常态：金额行 + 底部单价行（justifyContent: flex-end，单价恒靠右）+ 圆点 + 倒计时；
//   · 圆点没有 title，卡片文本里没有任何内部词（pricing.json / 本地价格表 / 未同步…）；
//   · 倒计时由数据里的 next.at 驱动，缺 next 时本地兜底，绝不出现 NaN / 负数；
//   · 只有 errors 非空才置空卡片（minHeight 兜住高度），此时不画余额/单价/圆点/倒计时；
//   · 窄卡片（!wide）仍显示余额与圆点，没有错误文字。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** 把 lib/client.js 当作浏览器脚本执行，取回插件注册对象。 */
function loadRegistration() {
  let registration = null;
  const window = { __ModuleLoader__: { load: (reg) => { registration = reg; } } };
  // eslint-disable-next-line no-new-func
  new Function('window', SRC)(window);
  assert.ok(registration, 'client.js 应通过 window.__ModuleLoader__.load 注册');
  return registration;
}

/**
 * 最小 react shim：只够把组件函数跑完并拿到元素树。
 * data 喂给第 1 个 state（卡片数据），initial[0] 喂给第 3 个 state（倒计时心跳 tick）。
 */
function makeReact(data, initial = []) {
  const values = [data, "", false];
  for (let i = 0; i < initial.length; i += 1) values[2 + i] = initial[i];
  const setters = [];
  return {
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.flat().filter((c) => c !== null && c !== undefined && c !== false),
    }),
    useState: () => {
      const i = setters.length;
      const set = (v) => {
        set.last = typeof v === "function" ? v(values[i]) : v;
        set.calls += 1;
      };
      set.calls = 0;
      setters.push(set);
      return [values[i], set];
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: () => ({ current: true }),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    __setters: setters,
  };
}

/** 最近一次渲染里的 state setters（下标同组件里 useState 的调用顺序）。 */
let lastSetters = [];

/** 渲染卡片元素树：wide 走侧边栏整宽卡片，false 走窄按钮。 */
function render(data, wide, initial) {
  const registration = loadRegistration();
  const react = makeReact(data, initial);
  const module = registration.factory((spec) => {
    if (spec === "react") return react;
    throw new Error(`unexpected require(${spec})`);
  });

  let component = null;
  const ctx = {
    locale: undefined,
    remote: undefined,
    slots: {
      inject: (_name, register) => register(),
      register: (_spec, comp) => { component = comp; },
    },
  };
  module.apply(ctx);
  assert.ok(component, '应注册卡片组件');
  // 注册的是 <UsageCell .../> 包装组件：先得到元素，再调用它拿到真正的 DOM 树。
  const element = component({ wide, ctx });
  assert.equal(typeof element.type, "function", "包装组件应返回 UsageCell 元素");
  const tree = element.type(element.props);
  lastSetters = react.__setters;
  return tree;
}

/** 渲染宽卡片，返回元素树。 */
const renderWide = (data, initial) => render(data, true, initial);

/** 渲染窄卡片，返回元素树。 */
const renderNarrow = (data, initial) => render(data, false, initial);

/** 纯函数（nextChange / isPeak / fmtCountdown）由 client.js 透出，用于确定性断言。 */
function internals() {
  const registration = loadRegistration();
  const module = registration.factory((spec) => {
    if (spec === "react") return makeReact(null);
    throw new Error(`unexpected require(${spec})`);
  });
  return module.__internals;
}

/** 把元素树里的文本拼起来（用来看卡片上到底显示了什么）。 */
function text(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return (node.children || []).map(text).join("");
}

/** 深度优先找出满足条件的元素（会展开函数组件，如 Price）。 */
function find(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate);
      if (hit) return hit;
    }
    return null;
  }
  if (predicate(node)) return node;
  if (typeof node.type === "function") {
    const hit = find(node.type(node.props), predicate);
    if (hit) return hit;
  }
  for (const child of node.children || []) {
    const hit = find(child, predicate);
    if (hit) return hit;
  }
  return null;
}

/** 卡片底部那一行（绝对定位在右下角的单价行）。 */
const isBottomRow = (node) => !!node.props?.style && node.props.style.position === "absolute" && node.props.style.justifyContent === "flex-end" && typeof node.props.style.bottom === "number";

/** 金额那一行（余额 + 右侧「倒计时 + 圆点」的容器）。 */
const isAmountRow = (node) => !!node.props?.style && node.props.style.display === "flex" && node.props.style.alignItems === "baseline" && node.props.style.minHeight === 28;

/** 余额数字（宽卡片里 24px 的大字）。 */
const isBalanceText = (node) => node.props?.style?.fontSize === 24;

/** 峰谷指示灯（圆点）。 */
const isPeakDot = (node) => node.props?.style?.borderRadius === "50%";

/** 倒计时文字：与单价数字同一套样式（字重 600、可省略号截断），字号继承卡片正文 12px。 */
const isCountdown = (node) => node.props?.style?.textOverflow === "ellipsis" && node.props?.style?.fontWeight === 600 && node.props?.style?.fontSize === undefined;

/** 倒计时与圆点共用的那个 flex 行（两者同一行才能对齐）。 */
const isCornerGroup = (node) => !!node.props?.style && node.props.style.display === "flex" && node.props.style.alignItems === "center" && node.props.style.marginLeft === "auto";

/** 错误文字行（错误色 + pre-wrap + anywhere 换行）。 */
const isErrorNote = (node) => node.props?.style?.whiteSpace === "pre-wrap" && String(node.props?.style?.color).includes("state-error");

/** 卡片上绝不该出现的内部词（去技术化的核心断言）。 */
const INTERNAL_WORDS = ["pricing.json", "价格表", "未同步", "内置", "同步时间", "DEEPSEEK_USAGE_PRICE_FILE"];

/** 当前这一轮渲染里的某个 setter（下标同 useState 顺序：0=data 1=error 2=tick）。 */
const setterAt = (i) => lastSetters[i];

const BASE = {
  ok: true,
  balance: { total: 40.87, currency: "CNY" },
  tier: { input: 2, cacheRead: 0.04, output: 8, model: "deepseek-flash", known: true },
  peak: true,
  updatedAt: Date.now(),
  next: { peak: false, at: Date.now() + 2 * 3600 * 1000, ms: 2 * 3600 * 1000 },
  errors: [],
};

/** 每次取样时重算 next.at：倒计时按当前时刻求值，固定时间戳会因测试耗时偏移一分钟。 */
const withNext = (hours) => ({
  ...BASE,
  next: { peak: false, at: Date.now() + hours * 3600 * 1000, ms: hours * 3600 * 1000 },
});

test("常态：余额 + 右侧倒计时 + 圆点 + 靠右单价，且只出现这些内容", () => {
  const tree = renderWide(withNext(2));
  assert.ok(find(tree, isBalanceText), "应显示余额");
  assert.ok(find(tree, isPeakDot), "应显示峰谷圆点");
  assert.ok(find(tree, isCountdown), "应显示倒计时");

  const row = find(tree, isBottomRow);
  assert.ok(row, "应渲染出底部单价行");
  assert.equal(row.props.style.justifyContent, "flex-end", "不能用 space-between：单子元素会被推到最左侧");
  assert.equal(row.props.style.alignItems, "center", "单价行内部垂直居中");
  assert.equal(row.props.style.bottom, 2, "单价行贴右下角，bottom:2 是选定的观感（配合下内边距 12，价格墨迹距卡片底 3px、不被裁）");
  assert.equal(row.props.style.top, undefined, "不得改成整行铺满 + 居中（那会把价格推到余额正下方、远离右下角）");
  assert.equal(row.children.length, 1, "底部行只有单价一个子元素");
  assert.equal(row.children[0].children.length, 3, "应含 输入 / 输入缓存 / 输出 三项");

  const all = text(tree);
  assert.match(all, /40\.87/, "余额数字应出现");
  assert.match(all, /\d+h \d+m/, "倒计时应按英文单位显示剩余时间（如 2h 0m）");
  for (const word of INTERNAL_WORDS) {
    assert.equal(all.includes(word), false, `卡片上不该出现内部词：${word}`);
  }
});

test("圆点：没有任何 title（历史上它塞过同步时间与价格表路径）", () => {
  const tree = renderWide(withNext(2));
  const dot = find(tree, isPeakDot);
  assert.ok(dot, "应显示峰谷圆点");
  assert.equal(dot.props.title, undefined, "圆点不得再有 hover");
  // 窄卡片同样不得残留 hover
  const narrow = renderNarrow(withNext(2));
  assert.equal(find(narrow, isPeakDot).props.title, undefined, "窄卡片圆点也不得有 hover");
});

test("倒计时与圆点同一行居中，且圆点留在卡片右上角（回归：曾被贴到余额基线 / 又被压到卡片中线）", () => {
  const tree = renderWide(withNext(2));
  const countdown = find(tree, isCountdown);
  assert.ok(countdown, "应渲染倒计时");
  assert.equal(countdown.props.style.whiteSpace, "nowrap");
  assert.equal(countdown.props.style.overflow, "hidden", "窄宽度下不溢出卡片");
  // 两者必须是同一个 flex 行的兄弟节点，靠 alignItems:center 对齐，
  // 而不是各自绝对定位（那正是"时间标签太靠下"的根因）。
  const group = find(tree, isCornerGroup);
  assert.ok(group, "倒计时与圆点应放在同一个 flex 行里");
  assert.equal(group.props.style.alignItems, "center", "同一行内居中，两者垂直中心才会重合");
  assert.equal(group.props.style.alignSelf, "flex-start", "整组必须靠顶：圆点要留在卡片右上角（曾误用 center，把圆点压到卡片中线）");
  assert.equal(group.props.style.marginTop, -4, "用负 margin 把整组顶到角落（实测圆点距卡片顶 8px）；不能用 paddingTop，那会把卡片撑大");
  assert.equal(group.props.style.marginRight, -3, "右侧同理（实测圆点距卡片右 8px）");
  assert.deepEqual(group.children, [countdown, find(tree, isPeakDot)], "顺序应为「倒计时 + 圆点」");
  assert.equal(countdown.props.style.position, undefined, "倒计时不再脱离文档流自行定位");
  const amountRow = find(tree, isAmountRow);
  assert.ok(amountRow, "金额行应容纳余额与右侧整组");
  assert.ok(amountRow.children.includes(group), "整组应在金额行内、靠右（marginLeft:auto）");
});

test("倒计时优先用宿主 next.at；缺 next 时本地兜底，不出现 NaN / 负数", () => {
  // 有 next：约 2 小时（取整可能落到 1h 59m，不断言精确分钟，免得测试时长抖动导致 flaky）
  assert.match(text(renderWide(withNext(2))), /\d+h \d+m/);
  // 缺 next：本地按当前时刻推算（周末必然指向下周一 09:00 北京时间），不能崩、不能 NaN
  const noNext = { ...BASE };
  delete noNext.next;
  const all = text(renderWide(noNext));
  assert.equal(all.includes("NaN"), false, "兜底不得产生 NaN");
  assert.equal(/-\d/.test(all), false, "倒计时不得出现负数");
  assert.ok(find(renderWide(noNext), isCountdown), "缺 next 时仍应显示倒计时");
  // 已经过去的 next.at（宿主时钟偏差）→ 显示 switching，不显示负数
  const past = { ...BASE, next: { peak: false, at: Date.now() - 60000, ms: -60000 } };
  assert.match(text(renderWide(past)), /switching/);
});

test("点击卡片：只刷新（不再有提示态/普通态切换）", () => {
  const tree = renderWide(withNext(2));
  tree.props.onClick();
  assert.equal(setterAt(2).calls, 0, "点击不该改任何展示状态（tick 不变）");
});

test("只有余额类错误才置空卡片：不画余额/单价/圆点/倒计时，minHeight 兜高度", () => {
  const tree = renderWide({ ...BASE, errors: ["未配置 DEEPSEEK_API_KEY"] });
  assert.match(text(tree), /未配置 DEEPSEEK_API_KEY/, "错误原因要写出来");
  assert.equal(find(tree, isBalanceText), null, "置空后不该再画余额");
  assert.equal(find(tree, isBottomRow), null, "置空后不该再画单价行");
  assert.equal(find(tree, isPeakDot), null, "置空后不该再画圆点");
  assert.equal(find(tree, isCountdown), null, "置空后不该再画倒计时");
  assert.equal(tree.props.style.minHeight, 54, "空白卡片保持常态高度（54px），侧边栏不跳动");
});

test("卡片底部留白：常态 padding 下内边距 16px（避免倒计时与单价行挤在一起）", () => {
  const tree = renderWide(withNext(2));
  assert.equal(tree.props.style.padding, "8px 10px 12px", "底部内边距要略大于顶部（给单价行留位置），且要够让价格墨迹完整留在卡片内");
});

test("倒计时文字样式 = 单价数字样式（同字号继承、同字重 600、同次要色）", () => {
  const tree = renderWide(withNext(2));
  const countdown = find(tree, isCountdown);
  assert.ok(countdown, "应渲染倒计时");
  assert.equal(countdown.props.style.fontWeight, 600, "字重必须与单价数字一致（Price 里的数字是 600）");
  assert.equal(countdown.props.style.fontSize, undefined, "不写死字号，继承卡片正文 12px —— 与单价数字同一套样式");

  // 右下角单价组：三个 Price span 各自带 color，数字 span 再覆盖 font-weight。
  // 注意：测试的 react shim 会把 Price(...) 直接求值，所以这里看到的就是最终 span。
  const row = find(tree, isBottomRow);
  const stockGroup = row.children[0];
  assert.equal(stockGroup.children.length, 3, "应是 输入 / 输入缓存 / 输出 三项");
  for (const item of stockGroup.children) {
    assert.equal(item.props.style.color, countdown.props.style.color, "单价与倒计时必须用同一个次要色");
  }
  const priceNum = find(stockGroup, (n) => n.props?.style?.fontWeight === 600);
  assert.ok(priceNum, "单价数字应是 font-weight 600");
  assert.equal(priceNum.props.style.fontSize, undefined, "单价数字同样继承 12px");
});

test("错误文字可换行、不溢出卡片（长 URL / 异常文本）", () => {
  const tree = renderWide({ ...BASE, errors: ["余额获取失败: fetch failed https://api.deepseek.com/user/balance"] });
  const err = find(tree, isErrorNote);
  assert.ok(err, "错误行应渲染");
  assert.equal(err.props.style.fontSize, 12);
  assert.equal(err.props.style.whiteSpace, "pre-wrap", "应可换行显示全文");
  assert.equal(err.props.style.overflowWrap, "anywhere", "超长串必须能断行，不溢出卡片边框");
  assert.equal(err.props.style.textOverflow, undefined, "不再用省略号截断错误");
});

test("★ 回归：内部信息（同步状态 / 计价来源 / 价格表路径）绝不进入卡片", () => {
  // 旧版会因为这些 pricing 字段而把卡片置空并显示"未同步 / 本地价格表 / pricing.json"。
  // 现在无论宿主报什么来源，卡片都照常显示数字，且文本里没有这些词。
  const cases = [
    { source: "file", via: "file", syncOk: true, mode: "auto", syncing: false, file: { path: "C:\\Users\\me\\.dsh\\dsh-deepseek-usage\\pricing.json" } },
    { source: "file", via: "file", syncOk: false, mode: "auto", syncing: false, syncError: "fetch failed", file: { path: "C:\\Users\\me\\.dsh\\dsh-deepseek-usage\\pricing.json" } },
    { source: "seed", via: "seed", syncOk: false, mode: "auto", syncing: true },
    { source: "seed", via: "alias", syncOk: false, mode: "auto", syncing: false, used: "deepseek-flash", requested: "deepseek-v4-flash" },
    { source: "file", via: "file", syncOk: false, mode: "manual", file: { path: "C:\\Users\\me\\.dsh\\dsh-deepseek-usage\\pricing.json", autoUpdate: false } },
    { source: "seed", via: "fallback", syncOk: false, mode: "auto", used: "deepseek-chat" },
  ];
  for (const pricing of cases) {
    const tree = renderWide({ ...BASE, pricing });
    const all = text(tree);
    assert.ok(find(tree, isBalanceText), `pricing=${pricing.source}/${pricing.via} 时应照常显示余额`);
    assert.ok(find(tree, isCountdown), "应照常显示倒计时");
    for (const word of INTERNAL_WORDS) {
      assert.equal(all.includes(word), false, `pricing=${pricing.source}/${pricing.via} 时卡片出现内部词：${word}`);
    }
    // 圆点上也不能挂内部信息
    assert.equal(find(tree, isPeakDot).props.title, undefined);
  }
});

test("窄卡片：仍显示余额与圆点，没有错误文字（没有文字空间）", () => {
  const tree = renderNarrow({ ...BASE, errors: ["未配置 DEEPSEEK_API_KEY"] });
  const all = text(tree);
  assert.match(all, /40\.87/, "窄卡片照常显示余额");
  assert.ok(find(tree, isPeakDot), "窄卡片照常显示圆点");
  assert.equal(all.includes("未配置"), false, "窄卡片不显示错误文字");
});

// ---- 纯函数：倒计时格式化与边界（供卡片显示与走字使用）----

test("fmtCountdown：英文单位、最多两级、不足一分钟显示 switching", () => {
  const { fmtCountdown } = internals();
  const MIN = 60 * 1000;
  assert.equal(fmtCountdown(3 * 1440 * MIN + 2 * 60 * MIN), "3d 2h");
  assert.equal(fmtCountdown(2 * 1440 * MIN + 15 * 60 * MIN), "2d 15h");
  assert.equal(fmtCountdown(5 * 60 * MIN + 47 * MIN), "5h 47m");
  assert.equal(fmtCountdown(23 * MIN), "23m");
  assert.equal(fmtCountdown(59 * 1000), "switching", "不足 1 分钟");
  assert.equal(fmtCountdown(0), "switching");
  assert.equal(fmtCountdown(-5000), "switching", "不得出现负数");
  assert.equal(fmtCountdown(NaN), "switching");
  assert.equal(fmtCountdown(59 * MIN + 59 * 1000), "59m", "向下取整，避免还剩 59 秒却显示 1m");
});

test("nextChange：按北京时间求下一次切换，覆盖午休 / 跨日 / 跨周末", () => {
  const { nextChange, isPeak } = internals();
  const H = 3600 * 1000;
  /** 北京时间某日 09:00 的 UTC 时间戳（上海 = UTC+8；2026-09-10 是周四）。 */
  const bj = (day, hour, minute = 0) => Date.UTC(2026, 8, day, hour - 8, minute, 0);

  const cases = [
    { at: bj(10, 8, 30), expect: bj(10, 9), peak: true, why: "开盘前空闲 → 09:00 转高峰" },
    { at: bj(10, 10, 0), expect: bj(10, 12), peak: false, why: "上午高峰 → 12:00 转空闲" },
    { at: bj(10, 12, 30), expect: bj(10, 14), peak: true, why: "午休空闲 → 14:00 转高峰（不是下一个整点）" },
    { at: bj(10, 17, 59), expect: bj(10, 18), peak: false, why: "下午高峰 → 18:00 转空闲" },
    { at: bj(10, 18, 30), expect: bj(11, 9), peak: true, why: "晚间空闲 → 次日 09:00（跨日）" },
    { at: bj(11, 18, 30), expect: bj(14, 9), peak: true, why: "周五晚 → 下周一 09:00（跨周末，两天多）" },
    { at: bj(12, 12, 0), expect: bj(14, 9), peak: true, why: "周六 → 下周一 09:00" },
    { at: bj(13, 12, 0), expect: bj(14, 9), peak: true, why: "周日 → 下周一 09:00" },
  ];
  for (const c of cases) {
    const got = nextChange(c.at);
    assert.equal(got.at, c.expect, c.why);
    assert.equal(got.peak, c.peak, `${c.why}：切换后时段`);
    assert.equal(got.ms, c.expect - c.at, `${c.why}：剩余毫秒`);
  }

  // 周五晚到周一早超过 2 天：天数必须被显示出来
  const weekend = nextChange(bj(11, 18, 30));
  assert.equal(Math.floor(weekend.ms / (24 * H)), 2, "跨周末应剩 2 天多");

  // 不变量：一周内任意时刻，下一次切换都严格在未来，且那一刻确实翻转
  for (let t = bj(10, 0); t < bj(17, 0); t += 7 * 60 * 1000) {
    const n = nextChange(t);
    assert.ok(n.ms > 0, "剩余时间必须为正");
    assert.ok(n.at > t, "切换时刻必须在未来");
    assert.notEqual(isPeak(n.at), isPeak(t), "切换时刻的时段必须与当前相反");
    assert.equal(isPeak(n.at - 1), isPeak(t), "边界前一分钟仍属旧时段（切换是精确瞬间）");
  }
});
