// 定价与峰谷规则的确定性断言（不依赖宿主运行时）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOLIDAY_TABLE_THROUGH_YEAR,
  expandHolidayRanges,
  hasHolidayCoverage,
  isPeak,
  nextChange,
  unitAt,
} from '../lib/pricing.js';

const at = (iso) => Date.parse(iso);
const PEAK = '2026-10-22T10:00:00+08:00'; // 周四 10:00，北京时间

test('只有官方路由上的官方模型计价', () => {
  const cases = [
    ['deepseek-flash', 'deepseek-official', true],
    ['deepseek-v4-pro', 'deepseek-official', true],
    ['deepseek-chat', 'deepseek-account', true],
    ['deepseek-v4-flash', 'deepseek-official', true], // 旧名别名
    ['deepseek-v4-flash-vision-exp', 'deepseek-official', true],
    // 第三方路由上的同名模型：按各自规则扣费，官方表不成立
    ['deepseek-v4.1-flash', 'workbuddy', false],
    ['deepseek-v4-flash', 'qwen-token-plan', false],
    ['deepseek-ai/deepseek-v4.1-flash', 'nvidia', false],
    ['deepseek-flash', 'opencode', false],
    // 官方路由上的非官方模型
    ['gpt-5-pro', 'deepseek-official', false],
    // provider 缺失：按非官方处理
    ['deepseek-flash', undefined, false],
    ['deepseek-flash', '', false],
  ];
  for (const [model, provider, expected] of cases) {
    const unit = unitAt(model, at(PEAK), provider);
    assert.equal(unit.known, expected, `${model} @ ${provider} 的 known 应为 ${expected}`);
  }
});

test('MiMo 按量路由取国内站实时价，套餐路由不显示 token 单价', () => {
  const pro = unitAt('mimo-v2.6-pro', at(PEAK), 'mimo');
  assert.equal(pro.known, true);
  assert.equal(pro.currency, 'CNY');
  assert.equal(pro.input, 3);
  assert.equal(pro.cacheRead, 0.025);
  assert.equal(pro.output, 6);
  assert.equal(pro.window, null, 'MiMo 当前快照没有分时段价');

  const flash = unitAt('mimo-v2.6-flash', at(PEAK), 'mimo');
  assert.equal(flash.input, 1);
  assert.equal(flash.cacheRead, 0.02);
  assert.equal(flash.output, 2);
  assert.equal(unitAt('mimo-v2.6-pro-ultraspeed', at(PEAK), 'mimo').input, 30);

  assert.equal(unitAt('mimo-v2.6-pro', at(PEAK), 'mimo-token-plan').known, false);
  assert.equal(unitAt('mimo-v2.6-pro', at(PEAK), 'openrouter').known, false);
});

test('家族词不再被当成官方模型（新模型不按上代价格计价）', () => {
  for (const model of ['deepseek-v5-pro', 'deepseek-prompt-helper', 'deepseek-router-proxy']) {
    const unit = unitAt(model, at(PEAK), 'deepseek-official');
    assert.equal(unit.known, false, `${model} 不在表里，应隐藏价格`);
    assert.equal(unit.via, 'fallback');
  }
});

test('模型名大小写与空白不影响判定', () => {
  assert.equal(unitAt('DEEPSEEK-FLASH', at(PEAK), 'deepseek-official').known, true);
  assert.equal(unitAt('  deepseek-flash  ', at(PEAK), 'deepseek-official').known, true);
});

test('官方模型的取价路径被记录下来', () => {
  assert.equal(unitAt('deepseek-flash', at(PEAK), 'deepseek-official').via, 'exact');
  assert.equal(unitAt('deepseek-v4-flash', at(PEAK), 'deepseek-official').via, 'alias');
  assert.equal(unitAt('gpt-5-pro', at(PEAK), 'deepseek-official').via, 'fallback');
});

test('峰谷窗口按北京时间判定', () => {
  const day = (hhmm) => at(`2026-10-22T${hhmm}:00+08:00`);
  assert.equal(isPeak(day('08:59')), false, '09:00 前');
  assert.equal(isPeak(day('09:00')), true, '09:00 起');
  assert.equal(isPeak(day('11:59')), true, '12:00 前仍是高峰');
  assert.equal(isPeak(day('12:00')), false, '12:00 起空闲');
  assert.equal(isPeak(day('13:59')), false, '午休');
  assert.equal(isPeak(day('14:00')), true, '14:00 起');
  assert.equal(isPeak(day('17:59')), true, '18:00 前仍是高峰');
  assert.equal(isPeak(day('18:00')), false, '18:00 起空闲');
});

test('周末与法定节假日恒为空闲', () => {
  assert.equal(isPeak(at('2026-10-24T10:00:00+08:00')), false, '周六');
  assert.equal(isPeak(at('2026-10-25T10:00:00+08:00')), false, '周日');
  assert.equal(isPeak(at('2026-10-01T10:00:00+08:00')), false, '国庆');
  assert.equal(isPeak(at('2026-02-16T10:00:00+08:00')), false, '春节');
});

test('倒计时落在精确的整点边界上', () => {
  const n = nextChange(at('2026-10-22T11:00:00+08:00'));
  assert.equal(new Date(n.at).toISOString(), '2026-10-22T04:00:00.000Z', '12:00 切出高峰');
  assert.equal(n.peak, false);

  const n2 = nextChange(at('2026-10-22T12:00:00+08:00'));
  assert.equal(new Date(n2.at).toISOString(), '2026-10-22T06:00:00.000Z', '14:00 切入高峰');
  assert.equal(n2.peak, true);

  // 周五 18:00 之后 → 下周一 09:00
  const n3 = nextChange(at('2026-10-23T18:00:00+08:00'));
  assert.equal(new Date(n3.at).toISOString(), '2026-10-26T01:00:00.000Z');
});

test('找不到切换点时 at 为 null（调用方据此显示占位符）', () => {
  // 把 32 天内所有整点边界都判成"不翻转"，才能走到兜底分支。
  // 用一份把每一天都变成节假日的集合：isPeak 恒为 false，没有任何边界会翻转。
  const everyDayHoliday = new Set();
  for (let day = 1; day <= 31; day += 1) {
    const d = String(day).padStart(2, '0');
    everyDayHoliday.add(`2026-11-${d}`);
    everyDayHoliday.add(`2026-12-${d}`);
  }
  const start = at('2026-11-01T00:00:00+08:00');
  const n = nextChange(start, everyDayHoliday);
  assert.equal(n.at, null, '没有翻转点时必须返回 null，而不是"此刻"');
  assert.equal(n.ms, 0);
  // 同一时刻的正常集合仍应给出精确边界。
  const normal = nextChange(start);
  assert.equal(typeof normal.at, 'number');
  assert.ok(normal.at > start);
});

test('放假日期表的覆盖年份是显式声明的', () => {
  assert.equal(hasHolidayCoverage(at('2026-10-22T10:00:00+08:00')), true);
  assert.equal(hasHolidayCoverage(at('2027-06-01T10:00:00+08:00')), false);
  assert.equal(HOLIDAY_TABLE_THROUGH_YEAR, 2026);
});

test('放假日期表里的非法日期被跳过，不得滚动到别的日子', () => {
  // 2027-02-30 不是合法日期；Date.parse 会把它滚到 03-02，
  // 那会让一个不存在的日子变成真的假日。
  const days = expandHolidayRanges([['2027-02-30', '2027-03-02']]);
  assert.equal(days.size, 0, '非法日期不得产生任何假日');
  assert.equal(days.has('2027-03-02'), false);
  // 合法的一段照常展开。
  const ok = expandHolidayRanges([['2027-02-28', '2027-03-01']]);
  assert.equal(ok.size, 2);
  assert.equal(ok.has('2027-02-28'), true);
  assert.equal(ok.has('2027-03-01'), true);
});

test('单价取自表内数字', () => {
  const peak = unitAt('deepseek-flash', at(PEAK), 'deepseek-official');
  assert.equal(peak.input, 2);
  assert.equal(peak.cacheRead, 0.04);
  assert.equal(peak.output, 8);
  const offPeak = unitAt('deepseek-flash', at('2026-10-22T13:00:00+08:00'), 'deepseek-official');
  assert.equal(offPeak.input, 1, '空闲时段单价减半');
  assert.equal(offPeak.output, 4);
});

test('非 DeepSeek provider：命中按量计费表才计价，币种跟表走，全天一价无区间', () => {
  const zai = unitAt('glm-4.6', at(PEAK), 'zai');
  assert.equal(zai.known, true);
  assert.equal(zai.currency, 'USD');
  assert.equal(zai.input, 0.6);
  assert.equal(zai.cacheRead, 0.11);
  assert.equal(zai.output, 2.2);
  assert.equal(zai.window, null, '全天一价：没有计费区间');
  assert.equal(zai.next, null);
  assert.equal(zai.via, 'exact', '与 DeepSeek 共用同一套查表路径，via 口径一致');

  const kimi = unitAt('kimi-k2.7-code', at(PEAK), 'moonshotai');
  assert.equal(kimi.known, true);
  assert.equal(kimi.currency, 'USD');

  const minimaxCn = unitAt('MiniMax-M3.1-Flash', at(PEAK), 'minimax-cn');
  assert.equal(minimaxCn.known, true, '模型 id 大小写不影响命中');
  assert.equal(minimaxCn.currency, 'CNY');
  assert.equal(minimaxCn.input, 1);
});

test('价格表外的模型与 provider 不猜价格', () => {
  assert.equal(unitAt('glm-9', at(PEAK), 'zai').known, false);
  assert.equal(unitAt('glm-4.6', at(PEAK), 'unknown-provider').known, false);
  assert.equal(unitAt('glm-4.6', at(PEAK), '').known, false);
  // 官方路由上的非 DeepSeek 模型同样不猜。
  assert.equal(unitAt('glm-4.6', at(PEAK), 'deepseek-official').known, false);
  // provider 大小写与首尾空白不影响查表。
  assert.equal(unitAt('GLM-4.6', at(PEAK), ' ZAI ').known, true);
});

test('有分时段计费的模型：按区间取价并给出下一次切换（OpenRouter 上的 DeepSeek）', () => {
  const id = 'deepseek/deepseek-v4.1-flash-1017';
  // 工作日 10:00（北京时间）= UTC 02:00，OpenRouter 的贵的一侧。
  const peak = unitAt(id, at('2026-10-22T10:00:00+08:00'), 'openrouter');
  assert.equal(peak.window, 'peak');
  assert.equal(peak.input, 0.3);
  assert.equal(peak.cacheRead, 0.006);
  assert.equal(peak.output, 1.2);
  assert.equal(new Date(peak.next.at).toISOString(), '2026-10-22T04:00:00.000Z', '12:00 切到便宜的一侧');

  // 工作日 13:00（午休）：便宜的一侧。
  const off = unitAt(id, at('2026-10-22T13:00:00+08:00'), 'openrouter');
  assert.equal(off.window, 'idle');
  assert.equal(off.input, 0.15);
  assert.equal(off.output, 0.6);
  assert.equal(new Date(off.next.at).toISOString(), '2026-10-22T06:00:00.000Z', '14:00 切回贵的一侧');

  // 周六全天便宜，下一次切换要到周一 09:00。
  const weekend = unitAt(id, at('2026-10-24T10:00:00+08:00'), 'openrouter');
  assert.equal(weekend.window, 'idle');
  assert.equal(new Date(weekend.next.at).toISOString(), '2026-10-26T01:00:00.000Z');
});

test('网关的分时段没有法定节假日概念：国庆工作日照样按贵的一侧', () => {
  const id = 'deepseek/deepseek-v4.1-flash-1017';
  const day = at('2026-10-01T10:00:00+08:00'); // 周四，国庆
  const viaGateway = unitAt(id, day, 'openrouter');
  assert.equal(viaGateway.window, 'peak', 'OpenRouter 的时段只看 UTC 星期，不认中国节假日');
  assert.equal(viaGateway.input, 0.3);
  // 同一个模型走 DeepSeek 官方路由时，节假日全天是免峰价。
  const official = unitAt('deepseek-flash', day, 'deepseek-official');
  assert.equal(official.window, 'idle');
  assert.equal(official.input, 1);
});
