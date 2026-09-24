// dsh-deepseek-usage — 价格表/模型改名解析测试（node --test）。
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setRemotePrices,
  setFilePrices,
  unitAt,
  isKnownModel,
  isPeak,
  nextChange,
  seedAliases,
  seedPrices,
  MODEL_ALIASES,
  DEFAULT_MODEL,
} from '../lib/pricing.js';

/** 北京时间 2026-09-10（周四）10:00 = 02:00Z → 高峰。 */
const PEAK_MS = Date.UTC(2026, 8, 10, 2, 0, 0);
/** 北京时间 2026-09-10（周四）13:00 = 05:00Z → 空闲。 */
const IDLE_MS = Date.UTC(2026, 8, 10, 5, 0, 0);
/** 北京时间 2026-09-12（周六）10:00 = 02:00Z → 周末恒为空闲。 */
const WEEKEND_MS = Date.UTC(2026, 8, 12, 2, 0, 0);

/** 2026-09-10 官方页的远端快照。 */
const REMOTE = {
  'deepseek-flash': { input: [2, 1], cacheRead: [0.04, 0.02], cacheWrite: 0, output: [8, 4] },
  'deepseek-v4-pro': { input: [9, 4.5], cacheRead: [0.3, 0.15], cacheWrite: 0, output: [27, 13.5] },
};

afterEach(() => {
  setRemotePrices(null);
  setFilePrices(null);
});

/** 本地价格表（pricing.json）一份快照：flash 用与官方不同的数字，便于区分层次。 */
const FILE_TABLE = {
  'deepseek-flash': { input: [3, 1.5], cacheRead: [0.06, 0.03], cacheWrite: 0, output: [12, 6] },
  'deepseek-chat': { input: [2, 2], cacheRead: [0.5, 0.5], cacheWrite: 0, output: [8, 8] },
};
const FILE_META = { path: 'D:\\dsh\\dsh-deepseek-usage\\pricing.json', updatedAt: 1789090582880, source: 'official', strategy: 'table', autoUpdate: true };

test('峰谷判定按北京时间，且周末恒为空闲', () => {
  assert.equal(isPeak(PEAK_MS), true);
  assert.equal(isPeak(IDLE_MS), false);
  assert.equal(isPeak(WEEKEND_MS), false);
});

// ---- 0.9.0：距下次峰谷切换（卡片倒计时的数据源）----
// 卡片在指示灯旁显示 `2d 15h` / `5h 47m` 这类时长，值就是 nextChange().ms。

/** 北京时间 2026-09-10（周四）某时某分 → UTC 时间戳（上海 = UTC+8）。 */
const bj = (day, hour, minute = 0) => Date.UTC(2026, 8, day, hour - 8, minute, 0);

test('nextChange：切换时刻按北京时间计算，空闲不总是"下一个整点"（含午休）', () => {
  const cases = [
    { from: bj(10, 8, 30), to: bj(10, 9), peak: true, why: '开盘前空闲 → 09:00 转高峰' },
    { from: bj(10, 10, 0), to: bj(10, 12), peak: false, why: '上午高峰 → 12:00 转空闲' },
    { from: bj(10, 12, 30), to: bj(10, 14), peak: true, why: '午休空闲 → 14:00 转高峰，而不是下一个整点' },
    { from: bj(10, 17, 59), to: bj(10, 18), peak: false, why: '下午高峰 → 18:00 转空闲' },
    { from: bj(10, 18, 30), to: bj(11, 9), peak: true, why: '晚间空闲 → 次日 09:00（跨日）' },
    { from: bj(11, 18, 30), to: bj(14, 9), peak: true, why: '周五晚 → 下周一 09:00（跨周末）' },
    { from: bj(12, 12, 0), to: bj(14, 9), peak: true, why: '周六 → 下周一 09:00' },
    { from: bj(13, 12, 0), to: bj(14, 9), peak: true, why: '周日 → 下周一 09:00' },
  ];
  for (const c of cases) {
    const got = nextChange(c.from);
    assert.equal(got.at, c.to, c.why);
    assert.equal(got.peak, c.peak, `${c.why}：切换后所处时段`);
    assert.equal(got.ms, c.to - c.from, `${c.why}：剩余毫秒`);
  }
});

test('nextChange：跨周末必须显示天数（>2 天），且所有边界都是精确瞬间', () => {
  const H = 3600 * 1000;
  const weekend = nextChange(bj(11, 18, 30));   // 周五 18:30 → 下周一 09:00
  assert.equal(Math.floor(weekend.ms / (24 * H)), 2, '跨周末应剩 2 天多');
  assert.equal(Math.floor(weekend.ms / H), 62, '周五 18:30 → 周一 09:00 = 62.5 小时');

  // 不变量：一周内任意时刻，下一次切换都严格在未来，且那一刻确实发生翻转；
  // 边界前一分钟仍属旧时段（不能"提前一分钟切价"）。
  for (let t = bj(10, 0); t < bj(17, 0); t += 7 * 60 * 1000) {
    const n = nextChange(t);
    assert.ok(n.ms > 0, '剩余时间必须为正');
    assert.ok(n.at > t, '切换时刻必须在未来');
    assert.notEqual(isPeak(n.at), isPeak(t), '切换时刻的时段必须与当前相反');
    assert.equal(isPeak(n.at - 1), isPeak(t), '边界前一分钟仍属旧时段');
  }
});

test('nextChange：倒计时到点后单价确实会换档（卡片显示与计价一致）', () => {
  setRemotePrices(REMOTE, { strategy: 'table' });
  for (const t of [bj(10, 10, 0), bj(10, 12, 30), bj(11, 18, 30)]) {
    const n = nextChange(t);
    const before = unitAt('deepseek-flash', t);
    const after = unitAt('deepseek-flash', n.at);
    assert.notDeepEqual(
      [before.input, before.cacheRead, before.output],
      [after.input, after.cacheRead, after.output],
      '倒计时归零那一刻，展示的档单价应当发生变化',
    );
  }
});

test('官方页同步后：现名精确命中，高峰/空闲取对应档', () => {
  setRemotePrices(REMOTE, { strategy: 'table' });
  const peak = unitAt('deepseek-flash', PEAK_MS);
  assert.equal(peak.via, 'remote');
  assert.equal(peak.source, 'remote');
  assert.deepEqual([peak.input, peak.cacheRead, peak.output], [2, 0.04, 8]);
  const idle = unitAt('deepseek-flash', IDLE_MS);
  assert.deepEqual([idle.input, idle.cacheRead, idle.output], [1, 0.02, 4]);
});

test('旧模型名（官方已改名）按别名映射到现名价格，不再落到内置旧价', () => {
  setRemotePrices(REMOTE, { strategy: 'table' });
  for (const legacy of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    assert.equal(MODEL_ALIASES[legacy], 'deepseek-flash');
    const u = unitAt(legacy, PEAK_MS);
    assert.equal(u.via, 'remote-alias');
    assert.equal(u.model, 'deepseek-flash');
    assert.equal(u.requested, legacy);
    assert.deepEqual([u.input, u.cacheRead, u.output], [2, 0.04, 8]);
  }
});

test('官方页未列出的同家族新名：唯一匹配时按该家族计价', () => {
  setRemotePrices({ 'deepseek-flash-latest': REMOTE['deepseek-flash'] }, { strategy: 'table' });
  const u = unitAt('deepseek-v5-flash', PEAK_MS);
  assert.equal(u.via, 'remote-family');
  assert.equal(u.model, 'deepseek-flash-latest');
});

test('家族不唯一时不猜（避免把 flash 算成 pro），落到内置/兜底', () => {
  setRemotePrices(REMOTE, { strategy: 'table' });
  const u = unitAt('deepseek-v5-unknown', PEAK_MS);
  assert.equal(u.known, false);
  assert.equal(u.via, 'fallback');
  assert.equal(u.source, 'seed');
});

test('远端未同步（抓取失败）：退回内置种子表并标记 source=seed', () => {
  setRemotePrices(null);
  const u = unitAt('deepseek-flash', PEAK_MS);
  assert.equal(u.known, true);
  assert.equal(u.via, 'seed');
  assert.equal(u.source, 'seed');
  // 内置表已更新到 2026-09 官方口径，不会退回更早的 deepseek-chat 档
  assert.deepEqual([u.input, u.cacheRead, u.output], [2, 0.04, 8]);
});

test('内置表也查不到的历史名：按 chat 档展示并标记 unknown', () => {
  setRemotePrices(null);
  const u = unitAt('deepseek-something-new', PEAK_MS);
  assert.equal(u.known, false);
  assert.equal(u.via, 'fallback');
  assert.equal(u.model, 'deepseek-chat');
});

test('默认模型是官方页当前在列的 deepseek-flash', () => {
  assert.equal(DEFAULT_MODEL, 'deepseek-flash');
  assert.equal(isKnownModel(DEFAULT_MODEL), true);
});

// ---- 0.7.0：本地价格表（file 层）----
// 核心场景：dsh 重启后进程内没有官方价（remote 层为空），此时应当直接用本地价格表，
// 而不是退回内置种子表（这正是"每次重启后卡片显示用内置表"的根因）。

test('重启后（remote 层为空）：本地价格表接管，source=file 而不是 seed', () => {
  setFilePrices(FILE_TABLE, FILE_META);
  const peak = unitAt('deepseek-flash', PEAK_MS);
  assert.equal(peak.via, 'file');
  assert.equal(peak.source, 'file');
  assert.equal(peak.known, true);
  assert.deepEqual([peak.input, peak.cacheRead, peak.output], [3, 0.06, 12]);
  // layerAt 给出"这份价是什么时候同步的"，供界面说明
  assert.equal(peak.layerAt, FILE_META.updatedAt);
  const idle = unitAt('deepseek-flash', IDLE_MS);
  assert.deepEqual([idle.input, idle.cacheRead, idle.output], [1.5, 0.03, 6]);
});

test('本次已同步到官方价时：remote 层优先于本地价格表', () => {
  setFilePrices(FILE_TABLE, FILE_META);
  setRemotePrices(REMOTE, { strategy: 'table', fetchedAt: 1789091000000 });
  const u = unitAt('deepseek-flash', PEAK_MS);
  assert.equal(u.via, 'remote');
  assert.equal(u.source, 'remote');
  assert.deepEqual([u.input, u.cacheRead, u.output], [2, 0.04, 8]);
  assert.equal(u.layerAt, 1789091000000);
});

test('本地价格表里没有的模型：仍按内置种子兜底（source=seed）', () => {
  setFilePrices(FILE_TABLE, FILE_META);
  const u = unitAt('deepseek-reasoner', PEAK_MS);
  assert.equal(u.via, 'seed');
  assert.equal(u.source, 'seed');
  assert.deepEqual([u.input, u.cacheRead, u.output], [4, 1, 16]);
});

test('本地价格表的别名（aliases）覆盖内置改名映射，且带 file- 前缀', () => {
  setFilePrices(FILE_TABLE, FILE_META, { 'deepseek-v4-flash': 'deepseek-chat' });
  const u = unitAt('deepseek-v4-flash', PEAK_MS);
  assert.equal(u.via, 'file-alias');
  assert.equal(u.source, 'file');
  assert.equal(u.model, 'deepseek-chat', '文件里的别名优先于内置 MODEL_ALIASES');
  assert.equal(MODEL_ALIASES['deepseek-v4-flash'], 'deepseek-flash', '内置映射本身不变');
});

test('本地价格表的同家族唯一匹配：via=file-family', () => {
  setFilePrices({ 'deepseek-flash-latest': FILE_TABLE['deepseek-flash'] }, FILE_META);
  const u = unitAt('deepseek-v5-flash', PEAK_MS);
  assert.equal(u.via, 'file-family');
  assert.equal(u.source, 'file');
  assert.equal(u.model, 'deepseek-flash-latest');
});

test('本地价格表为空/非法时不接管：仍走内置种子', () => {
  setFilePrices({}, FILE_META);
  const u = unitAt('deepseek-flash', PEAK_MS);
  assert.equal(u.via, 'seed');
  assert.equal(u.source, 'seed');
  assert.equal(u.layerAt, null);
});

test('内置快照可导出（首次运行生成 pricing.json 用），且是深拷贝', () => {
  const a = seedPrices();
  assert.ok(a['deepseek-flash'] && a['deepseek-v4-pro'] && a['deepseek-chat'] && a['deepseek-reasoner']);
  a['deepseek-flash'].input[0] = 999;
  assert.notEqual(seedPrices()['deepseek-flash'].input[0], 999, '改动快照不应污染内置表');
  assert.deepEqual(seedAliases(), MODEL_ALIASES);
});

