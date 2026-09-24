// dsh-deepseek-usage — 官方价格页解析测试（node --test）。
//
// 夹具 test/fixtures/official-pricing-zh.html 是 2026-09-10 官方价格页存档
// （该版把模型名从 deepseek-v4-flash 改为 deepseek-flash，表头结构也变了）。
// 官方再次改版时：先把新页面另存为夹具，再跑 `node --test test/` 定位是哪种
// 策略失效，最后用 `node lib/pricing-remote.js --check --html <存档>` 迭代。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOfficialPrices, parseTablePrices, parseFlatPrices } from '../lib/pricing-remote.js';

const FIXTURE = new URL('./fixtures/official-pricing-zh.html', import.meta.url);
const page = readFileSync(FIXTURE, 'utf8');

test('当前官方页：结构化表格策略解析出全部模型与峰谷价', () => {
  const r = parseOfficialPrices(page);
  assert.ok(r, '应解析成功');
  assert.equal(r.meta.strategy, 'table');
  assert.equal(r.meta.weekdayPeakOnly, true);
  assert.deepEqual(Object.keys(r.models), ['deepseek-flash', 'deepseek-v4-pro']);
  // [高峰, 空闲]
  assert.deepEqual(r.models['deepseek-flash'].input, [2, 1]);
  assert.deepEqual(r.models['deepseek-flash'].cacheRead, [0.04, 0.02]);
  assert.deepEqual(r.models['deepseek-flash'].output, [8, 4]);
  assert.deepEqual(r.models['deepseek-v4-pro'].input, [9, 4.5]);
  assert.deepEqual(r.models['deepseek-v4-pro'].cacheRead, [0.3, 0.15]);
  assert.deepEqual(r.models['deepseek-v4-pro'].output, [27, 13.5]);
});

test('当前官方页：文本兜底策略同样给出相同结果（互为交叉校验）', () => {
  assert.deepEqual(parseFlatPrices(page), parseTablePrices(page));
});

test('表头/行序变化不影响结构化策略（行序颠倒仍正确对齐）', () => {
  const html = `<table>
    <tr><td colspan="3">模型</td><td>deepseek-v4-pro<sup>(2)</sup></td><td>deepseek-flash<sup>(1)</sup></td></tr>
    <tr><td>价格</td><td>百万tokens输入<br>（缓存命中）</td><td>空闲时段</td><td>0.15元</td><td>0.02元</td></tr>
    <tr><td>高峰时段</td><td>0.30元</td><td>0.04元</td></tr>
    <tr><td>百万tokens输入<br>（缓存未命中）</td><td>空闲时段</td><td>4.5元</td><td>1元</td></tr>
    <tr><td>高峰时段</td><td>9.0元</td><td>2元</td></tr>
    <tr><td>百万tokens输出</td><td>空闲时段</td><td>13.5元</td><td>4元</td></tr>
    <tr><td>高峰时段</td><td>27.0元</td><td>8元</td></tr>
  </table>`;
  const models = parseTablePrices(html);
  assert.ok(models);
  // 列序由表头决定：pro 在前
  assert.deepEqual(Object.keys(models), ['deepseek-v4-pro', 'deepseek-flash']);
  assert.deepEqual(models['deepseek-flash'].input, [2, 1]);
  assert.deepEqual(models['deepseek-v4-pro'].output, [27, 13.5]);
});

test('合并单元格（colspan）价格按各列同价展开', () => {
  const html = `<table>
    <tr><td>模型</td><td>deepseek-flash</td><td>deepseek-v4-pro</td></tr>
    <tr><td>百万tokens输入（缓存命中）</td><td colspan="2">0.02元</td></tr>
    <tr><td>百万tokens输入（缓存未命中）</td><td>1元</td><td>4.5元</td></tr>
    <tr><td>百万tokens输出</td><td>4元</td><td>13.5元</td></tr>
  </table>`;
  const models = parseTablePrices(html);
  assert.ok(models);
  assert.deepEqual(models['deepseek-flash'].cacheRead, [0.02, 0.02]);
  assert.deepEqual(models['deepseek-v4-pro'].cacheRead, [0.02, 0.02]);
});

test('官方取消峰谷（无时段标签）时：同一价同时用于高峰与空闲', () => {
  const html = `<table>
    <tr><td>模型</td><td>deepseek-flash</td><td>deepseek-v4-pro</td></tr>
    <tr><td>百万tokens输入（缓存命中）</td><td>0.02元</td><td>0.15元</td></tr>
    <tr><td>百万tokens输入（缓存未命中）</td><td>1元</td><td>4.5元</td></tr>
    <tr><td>百万tokens输出</td><td>4元</td><td>13.5元</td></tr>
  </table>`;
  const models = parseTablePrices(html);
  assert.ok(models);
  assert.deepEqual(models['deepseek-flash'].input, [1, 1]);
  assert.deepEqual(models['deepseek-v4-pro'].output, [13.5, 13.5]);
});

test('非表格（旧版纯文本）页面走文本兜底策略', () => {
  const html = `<html><body><h2>模型细节</h2>
    <p>deepseek-v4-flash deepseek-v4-pro</p>
    <p>缓存命中 空闲时段 0.05元 0.15元 高峰时段 0.1元 0.3元</p>
    <p>缓存未命中 空闲时段 1.5元 4.5元 高峰时段 3元 9元</p>
    <p>输出 空闲时段 4.5元 13.5元 高峰时段 9元 27元</p>
    <h2>并发限制</h2><p>2500 500</p></body></html>`;
  const r = parseOfficialPrices(html);
  assert.ok(r);
  assert.equal(r.meta.strategy, 'flat');
  assert.deepEqual(r.models['deepseek-v4-flash'].input, [3, 1.5]);
  assert.deepEqual(r.models['deepseek-v4-pro'].output, [27, 13.5]);
});

test('文本兜底不会被“输出长度”这类同名前缀带偏', () => {
  const html = `<html><body><h2>模型细节</h2>
    <p>deepseek-flash deepseek-v4-pro</p>
    <p>缓存命中 空闲时段 0.02元 0.15元 高峰时段 0.04元 0.30元</p>
    <p>缓存未命中 输出长度 最大 384K 空闲时段 1元 4.5元 高峰时段 2元 9元</p>
    <p>输出 空闲时段 4元 13.5元 高峰时段 8元 27元</p>
    <h2>并发限制</h2><p>2500 500</p></body></html>`;
  const models = parseFlatPrices(html);
  assert.ok(models, '输出长度不应把价格算到输出档');
  assert.deepEqual(models['deepseek-flash'].input, [2, 1]);
  assert.deepEqual(models['deepseek-flash'].output, [8, 4]);
});

test('数据不完整或数值不合理时返回 null（由调用方回退内置表）', () => {
  assert.equal(parseOfficialPrices('<html><body><p>没有价格</p></body></html>'), null);
  // 缺少输出档
  const missing = `<table>
    <tr><td>模型</td><td>deepseek-flash</td></tr>
    <tr><td>百万tokens输入（缓存未命中）</td><td>空闲时段</td><td>1元</td></tr>
    <tr><td>高峰时段</td><td>2元</td></tr>
  </table>`;
  assert.equal(parseTablePrices(missing), null);
  // 空闲价高于高峰价（明显错位）
  const inverted = `<table>
    <tr><td>模型</td><td>deepseek-flash</td></tr>
    <tr><td>百万tokens输入（缓存命中）</td><td>空闲时段</td><td>9元</td></tr>
    <tr><td>高峰时段</td><td>1元</td></tr>
    <tr><td>百万tokens输入（缓存未命中）</td><td>空闲时段</td><td>1元</td></tr>
    <tr><td>高峰时段</td><td>2元</td></tr>
    <tr><td>百万tokens输出</td><td>空闲时段</td><td>4元</td></tr>
    <tr><td>高峰时段</td><td>8元</td></tr>
  </table>`;
  assert.equal(parseTablePrices(inverted), null);
});
