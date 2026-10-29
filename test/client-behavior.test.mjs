// 客户端行为验证：并发乱序、重试阶梯、卸载后不写状态。
// 用真实的 lib/client.js + 可控 fetch + 迷你 React 运行时。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/**
 * 组件的心跳（30s interval）与补请求定时器会让 Node 的事件循环一直活着，
 * 测试进程就退不出来。这里把 interval 换成 unref 的版本：它照样被记录、
 * 照样能被触发，但不再阻止进程退出。
 */
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const handle = realSetInterval(fn, ms, ...rest);
  handle.unref?.();
  return handle;
};

// ---- 迷你 React：支持状态、effect、依赖比较 ----
function makeRuntime() {
  const state = [];
  const effects = [];
  let cursor = 0;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }),
    useState: (init) => {
      const i = cursor++;
      if (!(i in state)) state[i] = typeof init === 'function' ? init() : init;
      return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v; }];
    },
    useRef: (init) => {
      const i = cursor++;
      if (!(i in state)) state[i] = { current: init };
      return state[i];
    },
    useMemo: (fn, deps) => {
      const i = cursor++;
      const prev = state[i];
      if (!prev || deps.some((d, k) => !Object.is(d, prev.deps[k]))) state[i] = { deps, value: fn() };
      return state[i].value;
    },
    useCallback: (fn, deps) => {
      const i = cursor++;
      const prev = state[i];
      if (!prev || deps.some((d, k) => !Object.is(d, prev.deps[k]))) state[i] = { deps, fn };
      return state[i].fn;
    },
    useEffect: (fn, deps) => {
      const i = cursor++;
      const prev = state[i];
      if (!prev || deps.some((d, k) => !Object.is(d, prev.deps[k]))) {
        state[i] = { deps };
        effects.push({ fn, i });
      }
    },
    useSyncExternalStore: (_sub, snap) => snap(),
  };
  return {
    react,
    state,
    /** 渲染一次并执行新增的 effect（模拟 React 的 commit）。 */
    render(fn) {
      cursor = 0;
      const out = fn();
      const pending = effects.splice(0, effects.length);
      const cleanups = [];
      for (const e of pending) {
        const cleanup = e.fn();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      }
      return { out, cleanups };
    },
  };
}

/** 迷你 DSH locale 服务里 en 的词典（真实 locale 服务会返回译文，这里按需镜像一份）。 */
const EN_DICT = {
  'price.input': 'Input',
  'price.cache': 'Input cache',
  'price.output': 'Output',
  'price.perMillion': 'Price per 1M tokens',
  'currency.CNY': 'CNY',
  'currency.USD': 'USD',
  'hint.peak': 'Peak pricing in',
  'hint.idle': 'Off-peak pricing in',
  'hint.switching': 'Price change imminent',
  'status.peak': 'Peak hours',
  'status.idle': 'Off-peak hours',
  'status.error': 'Balance unavailable',
  'status.unavailable': 'This provider has no query API',
  'card.label': 'Account usage, click to refresh',
};

/** 载入 client.js 并拿到注册进 sidebar.footer.action 槽位的组件。lang 决定界面语言。 */
function loadClient(runtime, lang = 'zh') {
  return loadSlots(runtime, lang)['sidebar.footer.action'];
}

/** 载入 client.js 并返回按槽位名索引的注册组件表。 */
function loadSlots(runtime, lang = 'zh') {
  const win = { __ModuleLoader__: { load: (def) => { win.__def = def; } } };
  new Function('window', 'require', source)(win, (id) => (id === 'react' ? runtime.react : {}));
  const mod = win.__def.factory((id) => (id === 'react' ? runtime.react : {}));
  const registered = {};
  const ctx = {
    locale: {
      subscribe: () => () => {},
      getSnapshot: () => ({ active: lang, locales: [], revision: 0 }),
      // 绑定命名空间后的翻译函数：返回原 key 表示"没这份译文"，组件会回退中文词典。
      bind: () => (k) => (lang === 'en' ? EN_DICT[k] ?? k : k),
      register: () => {},
    },
    remote: { $on: () => () => {} },
    effect: (fn) => { fn(); return () => {}; },
    slots: {
      // 按槽位名分派：本插件注册两个槽位（sidebar.footer.action 与
      // plugins.detail.section），测试各自取自己要的那个。
      inject: (_n, fn) => fn(),
      register: (meta, comp) => { registered[meta.name] = comp; },
    },
  };
  mod.apply(ctx);
  return registered;
}

/** 渲染槽位组件：它返回的是一个元素，真正的组件在 element.type 里。 */
function renderCard(Comp, runtime, props = { wide: true }) {
  const element = Comp(props);
  return runtime.render(() => element.type(element.props));
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node.children) return node.children.map(textOf).join('');
  return '';
}

/** 深度收集元素树上的所有节点（含自身）。 */
function nodesOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    node.forEach((n) => nodesOf(n, out));
    return out;
  }
  if (typeof node !== 'object') return out;
  out.push(node);
  if (node.children) node.children.forEach((n) => nodesOf(n, out));
  return out;
}

/** 计费区间指示灯：role="img" 的 8px 定位盒子（45px 的仪表盘同样是 role="img"，靠宽度区分）。 */
function isDotNode(node) {
  return !!(node.props && node.props.role === 'img' && node.props.style && node.props.style.width === 8);
}

const okResponse = (total) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    balance: { total, currency: 'CNY' },
    tier: { input: 2, cacheRead: 0.04, output: 8, known: true, currency: 'CNY', window: 'idle' },
    next: { at: Date.now() + 3_600_000 },
    peak: false,
    errors: [],
  }),
});

/** 可定制的宿主响应：峰谷状态与下次切换时刻由用例指定。 */
const stateResponse = (peak, nextAt) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    provider: { id: 'deepseek-official', kind: 'balance' },
    balance: { isAvailable: true, total: 5.35, currency: 'CNY' },
    tier: {
      input: 2, cacheRead: 0.04, output: 8, model: 'deepseek-flash', known: true,
      currency: 'CNY', window: peak ? 'peak' : 'idle',
    },
    next: { at: nextAt },
    peak,
    updatedAt: Date.now(),
    errors: [],
  }),
});

/** 旧宿主的响应：tier 里没有 window / currency 两个新字段。 */
const legacyResponse = (peak, nextAt) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    provider: { id: 'deepseek-official', kind: 'balance' },
    balance: { isAvailable: true, total: 5.35, currency: 'CNY' },
    tier: { input: 2, cacheRead: 0.04, output: 8, model: 'deepseek-flash', known: true },
    next: { at: nextAt },
    peak,
    errors: [],
  }),
});

/** 非 DeepSeek provider 的按量计费响应：价格表命中，全天一价（window: null）。 */
const providerPriceResponse = (over = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    provider: { id: 'zai', displayName: 'Z.ai (GLM)', kind: 'balance', reason: null },
    balance: { isAvailable: true, total: 8.5, currency: 'USD' },
    tier: {
      input: 0.6, cacheRead: 0.11, output: 2.2, model: 'glm-4.6', known: true,
      currency: 'USD', window: null,
    },
    next: { peak: false, at: null, ms: 0 },
    peak: false,
    updatedAt: Date.now(),
    errors: [],
    ...over,
  }),
});

/** 订阅用量形态的宿主响应（provider.kind = usage）。 */
const usageResponse = (windows) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    provider: { id: 'opencode', displayName: 'OpenCode', kind: 'usage', reason: null },
    balance: { isAvailable: null, total: null, currency: null },
    usage: { plan: null, windows },
    tier: { input: 2, known: false },
    next: { at: Date.now() + 3_600_000 },
    peak: false,
    errors: [],
  }),
});

/** 不可查 provider 的宿主响应：errors 里带一句原因，读数全空。 */
const unsupportedResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    provider: { id: 'workbuddy', displayName: 'Workbuddy', kind: 'none', reason: 'unsupported' },
    balance: { isAvailable: null, total: null, currency: null },
    usage: null,
    tier: { input: 2, known: false },
    next: { at: Date.now() + 3_600_000 },
    peak: false,
    errors: ['当前插件不支持 Workbuddy'],
  }),
});

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 可控 fetch：把请求挂起，测试自己决定何时、以什么结果返回。 */
function makePendingFetch() {
  const pending = [];
  globalThis.fetch = (url) => new Promise((resolve) => pending.push({ url, resolve }));
  return {
    pending,
    usage: () => pending.filter((p) => p.url.startsWith('/api/deepseek-usage?')),
  };
}

test('晚到的旧响应不覆盖新数据', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  assert.equal(usage().length, 1, '挂载后应发出一次余额请求');

  renderCard(Comp, runtime).out.props.onClick();
  assert.equal(usage().length, 2, '点击应发出第二次余额请求');

  usage()[1].resolve(okResponse(999));
  await flush();
  assert.ok(textOf(renderCard(Comp, runtime).out).includes('999.00'));

  usage()[0].resolve(okResponse(1));
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  assert.ok(text.includes('999.00'), `旧响应不得覆盖新数据，实际 ${text}`);
});

test('晚到的旧失败不抹掉新余额', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  renderCard(Comp, runtime).out.props.onClick();
  usage()[1].resolve(okResponse(777));
  await flush();
  usage()[0].resolve({ ok: false, status: 500, json: async () => ({ ok: false, message: 'boom' }) });
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  assert.ok(text.includes('777.00'), `旧失败不得抹掉新余额，实际 ${text}`);
  assert.ok(!text.includes('boom'), '旧失败的文案不应上屏');
});

test('失败按阶梯补请求；成功一次会取消待发的补请求并复位阶梯', async () => {
  const delays = [];
  const realSetTimeout = globalThis.setTimeout;
  let scheduled = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms >= 1000) {
      delays.push(ms);
      scheduled.push(fn);
    }
    return realSetTimeout(fn, ms, ...rest);
  };
  let mode = 'fail';
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return mode === 'fail'
      ? { ok: false, status: 500, json: async () => ({ ok: false, message: 'x' }) }
      : okResponse(42);
  };

  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  await flush();
  assert.ok(delays.includes(4000), `失败后应安排 4s 补请求，实际 ${delays.join(',')}`);

  // 补请求还挂着的时候，一次成功必须把它撤掉：否则它到点后再打一发，
  // 若那次失败就会把刚拿到的余额换成错误态。
  // 4s 的阶梯等不起，改为直接验证"待发的那个定时器被清掉了"。
  const cleared = [];
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.clearTimeout = (handle) => {
    cleared.push(handle);
    return realClearTimeout(handle);
  };
  const before = calls.length;
  mode = 'ok';
  renderCard(Comp, runtime).out.props.onClick();
  await flush();
  assert.equal(delays.length, 1, `成功后不应再安排补请求，实际 ${delays.join(',')}`);
  assert.ok(cleared.length > 0, '成功后必须清掉待发的补请求定时器');
  globalThis.clearTimeout = realClearTimeout;
  globalThis.setTimeout = realSetTimeout;
});

test('一次失败后再成功：错误文案消失，余额显示出来', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  // 第一次失败
  usage()[0].resolve({ ok: false, status: 500, json: async () => ({ ok: false, message: 'boom' }) });
  await flush();
  let text = textOf(renderCard(Comp, runtime).out);
  assert.ok(text.includes('boom'), `失败时应显示错误，实际 ${text}`);

  // 再点一次并成功
  renderCard(Comp, runtime).out.props.onClick();
  usage()[1].resolve(okResponse(6.66));
  await flush();
  text = textOf(renderCard(Comp, runtime).out);
  assert.ok(text.includes('6.66'), `成功后应显示余额，实际 ${text}`);
  assert.ok(!text.includes('boom'), '成功后错误文案必须消失');
});

test('宿主返回的假期表覆盖内置表：峰谷判定跟着宿主走', async () => {
  // 宿主可以把接下来 11 天标成假期。那些天里没有高峰/空闲翻转点，
  // 下一个切换点要等到第 12 天（一个工作日）的 09:00 —— 倒计时会显示"十几天"。
  // 若组件用的是内置表而不是宿主返回的这份，倒计时会指向今天的下一个整点（不到一天）。
  const { pending } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);

  const ranges = [];
  const base = Date.now();
  for (let i = 0; i < 11; i += 1) {
    // 假期按北京时间的日历日算，这里也要用北京日期（比 UTC 多 8 小时）。
    const d = new Date(base + i * 86400000 + 8 * 3600_000);
    ranges.push([d.toISOString().slice(0, 10), d.toISOString().slice(0, 10)]);
  }
  const holidays = pending.find((p) => p.url.includes('/holidays'));
  assert.ok(holidays, '挂载后应拉一次假期表');
  holidays.resolve({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, ranges }),
  });
  await flush();

  const usage = pending.find((p) => p.url.startsWith('/api/deepseek-usage?'));
  usage.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      provider: { id: 'deepseek-official', kind: 'balance' },
      balance: { total: 1, currency: 'CNY' },
      tier: { input: 2, known: true, currency: 'CNY', window: 'peak' },
      next: { at: null, ms: 0 },
      peak: true,
      errors: [],
    }),
  });
  await flush();

  const out = renderCard(Comp, runtime).out;
  // 剩余时间只放在指示灯的悬浮说明里（卡片上不再显示倒计时文本）。
  const titles = nodesOf(out).map((n) => n.props && n.props.title).filter((t) => typeof t === 'string');
  const hint = titles.find((t) => t.includes('还剩'));
  assert.ok(hint, `悬浮说明应给出剩余时间，实际 ${JSON.stringify(titles)}`);
  // 宿主表生效时至少还有 10 天。不能写死 10/11——11 天假往后可能撞上周末
  // （例如从周二起算，第 12 天才是工作日 09:00），天数取决于当天是周几。
  const days = /(\d+) 天/.exec(hint);
  assert.ok(days, `悬浮说明应以"天"显示，实际 ${hint}`);
  assert.ok(Number(days[1]) >= 10, `悬浮说明应按宿主的假期表指向十几天后，实际 ${hint}`);
});

test('卸载后不再写入状态', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  const { cleanups } = renderCard(Comp, runtime);
  cleanups.forEach((c) => c());
  usage()[0].resolve(okResponse(1));
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  assert.ok(!text.includes('1.00'), `卸载后不得写入状态，实际 ${text}`);
});

// ---- 多提供商账户读数的渲染 ----------------------------------------------

test('订阅用量形态：一张卡片里同时渲染所有窗口', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  usage()[0].resolve(usageResponse([
    { key: '5h', percent: 4, resetsAt: null },
    { key: '7d', percent: 34, resetsAt: Date.now() + 86_400_000 },
  ]));
  await flush();
  const out = renderCard(Comp, runtime).out;
  const text = textOf(out);
  // 每个窗口一个仪表盘：百分比在弧内，周期缩写徽章在底部缺口。
  assert.ok(text.includes('5H'), `应显示 5 小时徽章，实际 ${text}`);
  assert.ok(text.includes('7D'), `应显示 7 天徽章，实际 ${text}`);
  // 弧内只显示剩余量（不带百分号），字号 15；完整百分比留到悬浮说明。
  const numbers = nodesOf(out).filter((n) => n.props && n.props.style && n.props.style.fontSize === 15).map(textOf);
  assert.deepEqual(numbers, ['96', '66'], `弧内应显示剩余量（不带百分号），实际 ${JSON.stringify(numbers)}`);
  assert.ok(!text.includes('%'), `卡片上不再显示百分号，实际 ${text}`);
  assert.ok(!text.includes('—'), `拿到数据后不应有占位符，实际 ${text}`);
  // 完整周期名与重置倒计时在悬浮说明里（环内放不下）。
  const titles = nodesOf(out).map((n) => n.props && n.props.title).filter((t) => typeof t === 'string');
  assert.ok(titles.some((t) => t.includes('5 小时：已用 4%')), `5 小时窗口应有完整悬浮说明，实际 ${titles.join(' | ')}`);
  assert.ok(titles.some((t) => t.includes('7 天：已用 34%，')), `7 天窗口的悬浮说明应带重置倒计时，实际 ${titles.join(' | ')}`);
});

test('订阅用量 + 峰谷时段：只显示指示灯（悬浮给剩余时间），不显示单价行', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  usage()[0].resolve({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      provider: { id: 'opencode-go', displayName: 'OpenCode Go', kind: 'usage', reason: null },
      balance: { isAvailable: null, total: null, currency: null },
      usage: { plan: null, windows: [{ key: '5h', percent: 12, resetsAt: null }, { key: '30d', percent: 56, resetsAt: null }] },
      tier: { input: null, cacheRead: null, output: null, known: false, currency: 'CNY', window: 'peak' },
      next: { peak: false, at: Date.now() + 3 * 3_600_000 },
      peak: true,
      updatedAt: Date.now(),
      errors: [],
    }),
  });
  await flush();
  const out = renderCard(Comp, runtime).out;
  const text = textOf(out);
  // 峰谷指示灯：橙色状态点，剩余时间只在悬浮说明里。
  const dots = nodesOf(out).filter((n) => n.props && n.props.role === 'img' && n.props['aria-label']);
  assert.ok(dots.some((n) => n.props['aria-label'] === '高峰时段'), `应有高峰指示灯，实际 ${JSON.stringify(dots.map((n) => n.props['aria-label']))}`);
  assert.ok(dots.some((n) => typeof n.props.title === 'string' && n.props.title.includes('还剩')), '指示灯的悬浮说明应给出剩余时间');
  assert.ok(!/2h \d+m/.test(text), `卡片上不应再显示倒计时文本，实际 ${text}`);
  // 订阅制不显示单价行（价格数字 0.04 不应出现）。
  assert.ok(!text.includes('0.04'), `订阅卡片不应显示单价，实际 ${text}`);
});

test('订阅用量形态：接口返回三个档位时三个都上屏并按 5H→7D→1M 排列', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  usage()[0].resolve(usageResponse([
    { key: '30d', percent: 58, resetsAt: Date.now() + 86400_000 },
    { key: '5h', percent: 1, resetsAt: null },
    { key: '7d', percent: 24, resetsAt: null },
  ]));
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  const at5h = text.indexOf('5H');
  const at7d = text.indexOf('7D');
  const at1m = text.indexOf('1M');
  assert.ok(at5h >= 0 && at7d > at5h && at1m > at7d, `窗口应按 5H→7D→1M 排列，实际 ${text}`);
  const numbers = nodesOf(renderCard(Comp, runtime).out).filter((n) => n.props && n.props.style && n.props.style.fontSize === 15).map(textOf);
  assert.deepEqual(numbers, ['99', '76', '42'], `三个窗口都要显示剩余量，实际 ${JSON.stringify(numbers)}`);
});

/** 订阅形态的宿主响应：三个窗口固定，计费区间由用例决定。 */
const subscriptionResponse = (tier, peaks = false) => ({
  ok: true,
  status: 200,
  json: async () => ({
    ok: true,
    provider: { id: 'opencode-go', displayName: 'OpenCode Go', kind: 'usage', reason: null },
    balance: { isAvailable: null, total: null, currency: null },
    usage: {
      plan: null,
      windows: [
        { key: '5h', percent: 12, resetsAt: null },
        { key: '7d', percent: 34, resetsAt: null },
        { key: '30d', percent: 56, resetsAt: null },
      ],
    },
    tier,
    next: { peak: false, at: null, ms: 0 },
    peak: peaks,
    updatedAt: Date.now(),
    errors: [],
  }),
});

test('订阅用量形态：指示灯显隐不改变仪表盘阵列的宽度', async () => {
  /** 渲染一次订阅卡片，取回仪表盘网格节点与指示灯节点。 */
  const renderOf = async (tier) => {
    globalThis.fetch = async () => subscriptionResponse(tier);
    const runtime = makeRuntime();
    const Comp = loadClient(runtime);
    renderCard(Comp, runtime);
    await flush();
    const nodes = nodesOf(renderCard(Comp, runtime).out);
    return {
      grid: nodes.find((n) => n.props && n.props.style && n.props.style.display === 'grid'),
      dots: nodes.filter((n) => isDotNode(n) && n.props.title),
    };
  };

  // 有指示灯：宿主填了计费区间。
  const withDot = await renderOf({ input: null, cacheRead: null, output: null, known: false, currency: 'CNY', window: 'peak' });
  // 没有指示灯：全天一价（window 为空）或数据里没有计费区间。
  const withoutDot = await renderOf({ input: 2, known: false });

  assert.ok(withDot.grid && withoutDot.grid, '订阅形态应渲染仪表盘网格');
  assert.equal(withDot.dots.length, 1, '有计费区间时应有指示灯');
  assert.equal(withoutDot.dots.length, 0, '没有计费区间时不应有指示灯');
  assert.equal(withDot.grid.props.style.paddingRight, 16, '指示灯占位的宽度应固定为 16px');
  assert.equal(withoutDot.grid.props.style.paddingRight, 16, '指示灯不渲染时也要保留同样的右侧让位，仪表盘宽度才不变');
});

test('订阅用量形态：指示灯与仪表盘弧共用同一套低饱和度强调色', async () => {
  const GREEN = 'color-mix(in srgb, var(--dsw-alias-state-success-primary, rgb(34,160,80)) 55%, #808080)';
  const AMBER = 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, rgb(230,120,0)) 55%, #808080)';
  const RED = 'color-mix(in srgb, var(--dsw-alias-state-error-primary, rgb(200,40,40)) 55%, #808080)';

  /** 渲染一次并取出指示灯颜色与两条仪表盘弧色（已用 84% → 剩余弧变红）。 */
  const colorsOf = async (peak) => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        provider: { id: 'opencode-go', displayName: 'OpenCode Go', kind: 'usage', reason: null },
        balance: { isAvailable: null, total: null, currency: null },
        usage: {
          plan: null,
          windows: [
            { key: '5h', percent: 12, resetsAt: null },
            { key: '30d', percent: 84, resetsAt: null },
          ],
        },
        tier: { input: null, cacheRead: null, output: null, known: false, currency: 'CNY', window: peak ? 'peak' : 'idle' },
        next: { peak: false, at: null, ms: 0 },
        peak,
        updatedAt: Date.now(),
        errors: [],
      }),
    });
    const runtime = makeRuntime();
    const Comp = loadClient(runtime);
    renderCard(Comp, runtime);
    await flush();
    const nodes = nodesOf(renderCard(Comp, runtime).out);
    const dot = nodes.find((n) => isDotNode(n));
    // 圆点本体是 dot 里的 SVG 圆，颜色写在 circle 的 style.fill 上。
    const disc = dot && dot.children && dot.children[0] && dot.children[0].children;
    const arcs = nodes
      .filter((n) => n.type === 'circle' && n.props && n.props.style && typeof n.props.style.stroke === 'string')
      .map((n) => n.props.style.stroke);
    return { dot: disc && disc[0] && disc[0].props.style.fill, arcs };
  };

  const idle = await colorsOf(false);
  assert.equal(idle.dot, GREEN, `空闲时指示灯应与仪表盘剩余弧同色，实际 ${idle.dot}`);
  assert.deepEqual(idle.arcs, [GREEN, RED], `仪表盘弧应为低饱和度绿/红，实际 ${JSON.stringify(idle.arcs)}`);

  const peak = await colorsOf(true);
  assert.equal(peak.dot, AMBER, `高峰时指示灯应为低饱和度黄色，实际 ${peak.dot}`);
  assert.deepEqual(peak.arcs, [GREEN, RED]);
});

test('不可查的 provider：卡片置空说明原因，且不出现任何数字', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  usage()[0].resolve(unsupportedResponse());
  await flush();
  const text = textOf(renderCard(Comp, runtime).out);
  assert.ok(text.includes('当前插件不支持 Workbuddy'), `应显示原因，实际 ${text}`);
  // 不画读数、单价、圆点：卡片里只有那句原因。
  assert.ok(!/\d+%/.test(text), `不得出现百分比，实际 ${text}`);
  assert.ok(!text.includes('¥') && !text.includes('$'), `不得出现币种符号，实际 ${text}`);
});

test('不可查的 provider：卡片文字不是错误色', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  usage()[0].resolve(unsupportedResponse());
  await flush();
  const out = renderCard(Comp, runtime).out;

  // 找到承载原因文字的那个 div，读它的 color。
  let reasonColor = null;
  const walk = (node) => {
    if (!node || typeof node !== 'object' || reasonColor !== null) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const kids = node.children ?? [];
    const isReason = kids.some((c) => typeof c === 'string' && c.includes('当前插件不支持'));
    if (isReason && node.props && node.props.style) reasonColor = node.props.style.color;
    kids.forEach(walk);
  };
  walk(out);

  // `kind: none` 不是错误：用次要文字色陈述事实，不是错误红。
  const ERR = 'var(--dsw-alias-state-error-primary, rgb(200,40,40))';
  assert.notEqual(reasonColor, ERR, `不可查的提供商不该用错误色，实际 ${reasonColor}`);
  assert.equal(reasonColor, 'var(--dsw-alias-label-secondary, rgba(0,0,0,.55))');
});

test('折叠态下不可查且无错误时整块不渲染', async () => {
  const { usage } = makePendingFetch();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime, { wide: false });
  // 先回一个 kind=none 但无错误的响应（构造上不该出现，但渲染要稳）。
  usage()[0].resolve({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      provider: { id: 'workbuddy', displayName: 'Workbuddy', kind: 'none', reason: 'unsupported' },
      balance: { isAvailable: null, total: null, currency: null },
      usage: null,
      tier: { input: 2, known: false },
      next: { at: Date.now() + 3_600_000 },
      peak: false,
      errors: [],
    }),
  });
  await flush();
  assert.equal(renderCard(Comp, runtime, { wide: false }).out, null, '折叠态没有可显示内容时返回 null');
});

// ---- 插件页状态表 ---------------------------------------------------------

/** 收集一处 props.style 里出现的颜色值。 */
function colorOf(node) {
  const style = node && node.props && node.props.style;
  return style && typeof style === 'object' && typeof style.color === 'string' ? style.color : null;
}

test('状态表：不支持的提供商显示"不适用"而非红色"查询失败"', async () => {
  const runtime = makeRuntime();
  const slots = loadSlots(runtime);
  const Section = slots['plugins.detail.section'];
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      current: 'deepseek-official',
      accounts: [
        { id: 'deepseek-official', displayName: 'DeepSeek', kind: 'balance', status: 'ok', refs: [], token: null, balance: { isAvailable: true, total: 110, currency: 'CNY' }, usage: null, current: true, reason: null },
        { id: 'moonshotai', displayName: 'Moonshot', kind: 'balance', status: 'error', refs: [], token: null, balance: null, usage: null, current: false, reason: null },
        { id: 'google', displayName: 'Google', kind: 'none', status: 'error', refs: [], token: null, balance: null, usage: null, current: false, reason: 'cloudAuthOnly' },
      ],
      errors: [],
    }),
  });
  const el = Section({ t: (k) => k, subject: { kind: 'bundle', pkg: { name: '@dougen/dsh-deepseek-usage' } } });
  runtime.render(() => el.type(el.props));
  await flush();
  const { out } = runtime.render(() => el.type(el.props));

  const statuses = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const text = (node.children ?? []).filter((c) => typeof c === 'string').join('');
    if (text.startsWith('accounts.status.')) statuses.push({ text, color: colorOf(node) });
    (node.children ?? []).forEach(walk);
  };
  walk(out);

  const byText = Object.fromEntries(statuses.map((s) => [s.text, s.color]));
  // "可查询"用与侧边栏指示灯、仪表盘弧相同的低饱和度绿色。
  assert.equal(byText['accounts.status.ok'], 'color-mix(in srgb, var(--dsw-alias-state-success-primary, rgb(34,160,80)) 55%, #808080)');
  // 真失败仍然标红：这是用户需要行动的信号。
  assert.equal(byText['accounts.status.error'], 'var(--dsw-alias-state-error-primary, rgb(200,40,40))');
  // 不支持的提供商：中性 tertiary 色，不是错误色。
  assert.equal(byText['accounts.status.unsupported'], 'var(--dsw-alias-label-tertiary, rgba(0,0,0,.4))');
  assert.ok(!Object.hasOwn(byText, 'accounts.status.error') || byText['accounts.status.unsupported'] !== byText['accounts.status.error']);
});

test('状态表只出现在本插件的详情页', async () => {
  const runtime = makeRuntime();
  const Section = loadSlots(runtime)['plugins.detail.section'];
  const t = (k) => k;

  // 别的 bundle：不渲染。`plugins.detail.section` 是所有详情页共用的 slot，
  // 只判断 kind === 'bundle' 会让面板出现在每个插件页上。
  assert.equal(
    Section({ t, subject: { kind: 'bundle', pkg: { name: '@deepseek-ai/dsh-client-ui-cordis' } } }),
    null,
    '别的 bundle 的详情页不该出现本插件的面板',
  );
  // 行页面与官方插件页面同理。
  assert.equal(
    Section({ t, subject: { kind: 'row', pkg: { name: '@dougen/dsh-deepseek-usage' }, row: { rowId: 'x' } } }),
    null,
    '行页面不是 bundle 页面',
  );
  assert.equal(Section({ t, subject: { kind: 'item', id: 'agent-loop' } }), null, '官方插件页面不该出现');
  // subject 缺失也不能崩。
  assert.equal(Section({ t }), null);

  // 本插件的 bundle 页面：渲染一块 section（注册返回的是组件元素，
  // 真正的 <section> 在组件返回值里）。
  const own = Section({ t, subject: { kind: 'bundle', pkg: { name: '@dougen/dsh-deepseek-usage' } } });
  assert.notEqual(own, null);
  const rendered = runtime.render(() => own.type(own.props));
  assert.equal(rendered.out.type, 'section');
});

test('价格悬浮说明：整行命中，写清单位与三个档位，分两行', async () => {
  const cases = [
    ['zh', '每百万 token 价格', '输入 2 元 / 输入缓存 0.04 元 / 输出 8 元'],
    ['en', 'Price per 1M tokens', 'Input 2 CNY / Input cache 0.04 CNY / Output 8 CNY'],
  ];
  for (const [lang, line0, line1] of cases) {
    globalThis.fetch = async () => okResponse(5.35);
    const runtime = makeRuntime();
    const Comp = loadClient(runtime, lang);
    renderCard(Comp, runtime);
    await flush();

    // 单价说明只挂一处（整条单价行），图标与数字各自不再挂 title：命中区覆盖整行。
    const titled = nodesOf(renderCard(Comp, runtime).out).filter((n) => n.props && typeof n.props.title === 'string');
    const rows = titled.filter((n) => n.props.title.includes('\n'));
    assert.equal(rows.length, 1, `${lang}: 说明文字应只挂在单价行上`);

    const lines = rows[0].props.title.split('\n');
    assert.equal(lines.length, 2, `${lang}: 说明分两行：单位 + 三个档位`);
    assert.equal(lines[0], line0, `${lang}: 第一行是单位`);
    assert.equal(lines[1], line1, `${lang}: 第二行是三个档位`);

    // 挂了 title 的节点必须包住三个价格数字，否则鼠标落在数字上仍出不来说明。
    const row = textOf(rows[0]);
    for (const amount of ['2', '0.04', '8']) {
      assert.ok(row.includes(amount), `${lang}: 单价行应包含 ${amount}，实际 ${row}`);
    }
  }
});

test('峰谷切换的悬浮说明：指到倒计时/指示灯上，讲清离峰价还是谷价还有多久', async () => {
  /** 渲染一次卡片并取回所有悬浮说明。 */
  const titlesOf = async ({ lang, peak, offsetMs, wide = true }) => {
    globalThis.fetch = async () => stateResponse(peak, Date.now() + offsetMs);
    const runtime = makeRuntime();
    const Comp = loadClient(runtime, lang);
    renderCard(Comp, runtime, { wide });
    await flush();
    return nodesOf(renderCard(Comp, runtime, { wide }).out)
      .filter((n) => n.props && typeof n.props.title === 'string')
      .map((n) => n.props.title);
  };

  const in21 = 21 * 60000 + 30000; // 多给 30 秒，天数/分钟数不会因为用例本身的耗时跳一格

  // 现在空闲 → 下一次切到峰价；现在高峰 → 下一次切到谷价。
  const idle = await titlesOf({ lang: 'zh', peak: false, offsetMs: in21 });
  assert.ok(idle.includes('距离峰价还剩 21 分钟'), `空闲态实际 ${JSON.stringify(idle)}`);
  const peak = await titlesOf({ lang: 'zh', peak: true, offsetMs: in21 });
  assert.ok(peak.includes('距离谷价还剩 21 分钟'), `高峰态实际 ${JSON.stringify(peak)}`);

  // 不足 1 分钟时倒计时显示 switching，说明换成整句，不拼一个「0 分钟」。
  const soon = await titlesOf({ lang: 'zh', peak: false, offsetMs: 30000 });
  assert.ok(soon.includes('即将切换价格'), `即将切换实际 ${JSON.stringify(soon)}`);

  // 英文用英文单位词，天/小时两级同样展开。
  const en = await titlesOf({ lang: 'en', peak: true, offsetMs: (2 * 1440 + 15 * 60) * 60000 + 30000 });
  assert.ok(en.includes('Off-peak pricing in 2 days 15 hours'), `英文实际 ${JSON.stringify(en)}`);

  // 折叠态只有指示灯：说明挂在整块上，指向图标就能看到。
  const folded = await titlesOf({ lang: 'zh', peak: false, offsetMs: in21, wide: false });
  assert.deepEqual(folded, ['距离峰价还剩 21 分钟']);
});

test('非 DeepSeek provider 的按量计费模型：显示单价行，全天一价时不画指示灯', async () => {
  globalThis.fetch = async () => providerPriceResponse();
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  await flush();

  const { out } = renderCard(Comp, runtime);
  const text = textOf(out);
  assert.ok(text.includes('0.6') && text.includes('0.11') && text.includes('2.2'), `应显示单价行，实际 ${text}`);

  // 全天一价：没有倒计时、没有指示灯，只有单价行那一条悬浮说明。
  const titles = nodesOf(out).filter((n) => n.props && typeof n.props.title === 'string').map((n) => n.props.title);
  assert.equal(titles.length, 1, `只应有单价行一条说明，实际 ${JSON.stringify(titles)}`);
  assert.ok(titles[0].includes('美元'), `币种应跟价格表（USD），实际 ${titles[0]}`);
  assert.ok(!/距离|还剩/.test(titles[0]), '全天一价的模型不该出现区间倒计时');
});

test('非 DeepSeek provider 有分时段计费时：和 DeepSeek 一样显示指示灯与倒计时', async () => {
  const in21 = 21 * 60000 + 30000;
  globalThis.fetch = async () => providerPriceResponse({
    provider: { id: 'moonshotai', displayName: 'Moonshot', kind: 'balance', reason: null },
    tier: {
      input: 6.5, cacheRead: 1.3, output: 27, model: 'kimi-k2.7-code', known: true,
      currency: 'CNY', window: 'idle',
    },
    peak: false,
    next: { peak: true, at: Date.now() + in21, ms: in21 },
  });
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  await flush();

  const { out } = renderCard(Comp, runtime);
  const titles = nodesOf(out).filter((n) => n.props && typeof n.props.title === 'string').map((n) => n.props.title);
  assert.ok(titles.includes('距离峰价还剩 21 分钟'), `应显示区间倒计时，实际 ${JSON.stringify(titles)}`);
  // 区间倒计时的指示灯带无障碍名称（高位/低位一侧）。
  const labeled = nodesOf(out).filter((n) => n.props && n.props['aria-label'] === '空闲时段');
  assert.equal(labeled.length, 1, '应有一个"空闲时段"的指示灯');
  const priceRow = titles.find((t) => t.includes('\n'));
  assert.ok(priceRow && priceRow.includes('元'), `单价行币种应为人民币，实际 ${priceRow}`);
});

test('非 DeepSeek provider 缺切换时刻时不在本地猜（不套用 DeepSeek 峰谷表）', async () => {
  globalThis.fetch = async () => providerPriceResponse({
    provider: { id: 'moonshotai', kind: 'balance' },
    tier: {
      input: 6.5, cacheRead: 1.3, output: 27, model: 'kimi-k2.7-code', known: true,
      currency: 'CNY', window: 'idle',
    },
    peak: false,
    next: { peak: true, at: null, ms: 0 },
  });
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  await flush();

  const out = renderCard(Comp, runtime).out;
  const titles = nodesOf(out).filter((n) => n.props && typeof n.props.title === 'string').map((n) => n.props.title);
  // 缺切换时刻：指示灯照常显示当前区间，但悬浮说明里不编一个剩余时间。
  assert.ok(titles.includes('空闲时段'), `缺切换时刻时应只显示当前区间，实际 ${JSON.stringify(titles)}`);
  assert.ok(!titles.some((t) => t.includes('还剩')), `不得用 DeepSeek 的峰谷口径本地补一个倒计时，实际 ${JSON.stringify(titles)}`);
});

test('旧宿主的响应（没有 tier.window）：指示灯与倒计时照旧，币种回退人民币', async () => {
  const in21 = 21 * 60000 + 30000;
  globalThis.fetch = async () => legacyResponse(false, Date.now() + in21);
  const runtime = makeRuntime();
  const Comp = loadClient(runtime);
  renderCard(Comp, runtime);
  await flush();

  const { out } = renderCard(Comp, runtime);
  const titles = nodesOf(out).filter((n) => n.props && typeof n.props.title === 'string').map((n) => n.props.title);
  assert.ok(titles.includes('距离峰价还剩 21 分钟'), `旧宿主也必须显示倒计时，实际 ${JSON.stringify(titles)}`);
  const dots = nodesOf(out).filter((n) => n.props && n.props['aria-label'] === '空闲时段');
  assert.equal(dots.length, 1, '旧宿主也必须显示指示灯');
  const priceRow = titles.find((t) => t.includes('\n'));
  assert.ok(priceRow && priceRow.includes('元'), `缺 currency 时按人民币显示，实际 ${priceRow}`);
});
