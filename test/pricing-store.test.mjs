// dsh-deepseek-usage — 本地价格配置表（lib/pricing-store.js）测试（node --test）。
//
// 全程用 DEEPSEEK_USAGE_PRICE_FILE 指向工作区内的临时文件，绝不碰用户真实价格表。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultPriceFilePath,
  loadPriceTable,
  parsePriceTable,
  priceTableStat,
  savePriceTable,
} from '../lib/pricing-store.js';

const DIR = mkdtempSync(join(tmpdir(), 'dsh-usage-price-'));
/** 每个用例一个独立路径，避免相互污染。 */
let seq = 0;
const nextPath = () => join(DIR, `pricing-${seq += 1}.json`);

after(() => { rmSync(DIR, { recursive: true, force: true }); });

const FLASH = { input: [2, 1], cacheRead: [0.04, 0.02], cacheWrite: 0, output: [8, 4] };
const PRO = { input: [9, 4.5], cacheRead: [0.3, 0.15], cacheWrite: 0, output: [27, 13.5] };

test('路径：环境变量 DEEPSEEK_USAGE_PRICE_FILE 优先，否则落在 DSH_HOME 下', () => {
  const prevFile = process.env.DEEPSEEK_USAGE_PRICE_FILE;
  const prevHome = process.env.DSH_HOME;
  try {
    process.env.DEEPSEEK_USAGE_PRICE_FILE = 'D:\\tmp\\custom.json';
    assert.equal(defaultPriceFilePath(), 'D:\\tmp\\custom.json');
    delete process.env.DEEPSEEK_USAGE_PRICE_FILE;
    process.env.DSH_HOME = 'D:\\dsh-home';
    assert.match(defaultPriceFilePath(), /dsh-home[\\/]dsh-deepseek-usage[\\/]pricing\.json$/);
  } finally {
    if (prevFile === undefined) delete process.env.DEEPSEEK_USAGE_PRICE_FILE;
    else process.env.DEEPSEEK_USAGE_PRICE_FILE = prevFile;
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  }
});

test('文件不存在：exists=false、error=null、table=null（首次运行走内置快照）', () => {
  const result = loadPriceTable({ path: nextPath() });
  assert.equal(result.exists, false);
  assert.equal(result.error, null);
  assert.equal(result.table, null);
});

test('写入后可读回：模型 / 别名 / 元信息完整，且是给人看的缩进 JSON', () => {
  const path = nextPath();
  const written = savePriceTable(
    { models: { 'deepseek-flash': FLASH }, aliases: { 'deepseek-v4-flash': 'deepseek-flash' }, updatedAt: 1789090582880, updatedFrom: 'https://example.test/pricing', strategy: 'table' },
    { path },
  );
  assert.equal(written.path, path);
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes('\n  "models"'), '应为 2 空格缩进、便于手改');
  assert.ok(text.endsWith('\n'), '文件应以换行结尾');
  assert.ok(text.includes('autoUpdate'), '应带格式说明/开关字段');

  const loaded = loadPriceTable({ path });
  assert.equal(loaded.exists, true);
  assert.deepEqual(loaded.table.models['deepseek-flash'], FLASH);
  assert.deepEqual(loaded.table.aliases, { 'deepseek-v4-flash': 'deepseek-flash' });
  assert.equal(loaded.table.updatedAt, 1789090582880);
  assert.equal(loaded.table.updatedFrom, 'https://example.test/pricing');
  assert.equal(loaded.table.strategy, 'table');
  assert.equal(loaded.table.autoUpdate, true);
});

test('合并写回：官方条目覆盖同名项，用户自加条目保留', () => {
  const path = nextPath();
  savePriceTable({ models: { 'deepseek-flash': FLASH, 'my-gateway-model': PRO } }, { path });
  // 模拟官方同步：只带官方页列出的模型（价格变了）
  const officialFlash = { input: [3, 1.5], cacheRead: [0.06, 0.03], cacheWrite: 0, output: [12, 6] };
  savePriceTable({ models: { 'deepseek-flash': officialFlash }, updatedAt: 1789091000000, updatedFrom: 'official', strategy: 'flat' }, { path });

  const loaded = loadPriceTable({ path });
  assert.deepEqual(loaded.table.models['deepseek-flash'], officialFlash, '官方价应覆盖同名条目');
  assert.deepEqual(loaded.table.models['my-gateway-model'], PRO, '用户自加条目不能被冲掉');
  assert.equal(loaded.table.strategy, 'flat');
  assert.equal(loaded.table.updatedAt, 1789091000000);
});

test('手改格式容错：允许整行 // 注释、ISO 时间、缺失档位回退到 input 档', () => {
  const path = nextPath();
  writeFileSync(path, [
    '// 我自己维护的价格表',
    '{',
    '  "autoUpdate": false,',
    '  "updatedAt": "2026-09-11T01:36:22.880Z",',
    '  "models": {',
    '    // 只写 input，其它档按 input 兜底',
    '    "deepseek-flash": { "input": [2, 1] }',
    '  }',
    '}',
  ].join('\n'), 'utf8');

  const loaded = loadPriceTable({ path });
  assert.equal(loaded.error, null);
  assert.equal(loaded.table.autoUpdate, false);
  assert.equal(loaded.table.updatedAt, Date.parse('2026-09-11T01:36:22.880Z'));
  assert.deepEqual(loaded.table.models['deepseek-flash'], {
    input: [2, 1], cacheRead: [2, 1], cacheWrite: 0, output: [2, 1],
  });
});

test('简写形式：整个文件就是"模型 → 价格"映射', () => {
  const path = nextPath();
  writeFileSync(path, JSON.stringify({ 'deepseek-flash': FLASH, 'deepseek-v4-pro': PRO }), 'utf8');
  const loaded = loadPriceTable({ path });
  assert.equal(loaded.error, null);
  assert.deepEqual(Object.keys(loaded.table.models).sort(), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(loaded.table.autoUpdate, true, '简写形式默认开启自动同步');
});

test('非法条目被丢弃并给出警告；整份无法解析时报错但不写盘', () => {
  const path = nextPath();
  writeFileSync(path, JSON.stringify({
    models: {
      'deepseek-flash': FLASH,
      'broken-model': { input: [1] },          // 不是 [高峰, 空闲] 二元组
      'not-an-object': 3,
    },
  }), 'utf8');
  const loaded = loadPriceTable({ path });
  assert.equal(loaded.error, null);
  assert.deepEqual(Object.keys(loaded.table.models), ['deepseek-flash']);
  assert.equal(loaded.warnings.length, 1);
  assert.match(loaded.warnings[0], /broken-model/);

  const bad = nextPath();
  writeFileSync(bad, '{ 这不是 JSON', 'utf8');
  const broken = loadPriceTable({ path: bad });
  assert.equal(broken.exists, true);
  assert.ok(broken.error, '损坏文件应给出 error');
  assert.equal(broken.table, null);
  assert.equal(readFileSync(bad, 'utf8'), '{ 这不是 JSON', '不覆盖用户文件');
});

test('parsePriceTable：空表 / 非对象根节点直接抛错', () => {
  assert.throws(() => parsePriceTable('[]'));
  assert.throws(() => parsePriceTable('{ "models": {} }'));
});

test('原子写：目录不存在会自动创建，且不残留 .tmp 文件', () => {
  const path = join(DIR, 'nested', 'deeper', 'pricing.json');
  savePriceTable({ models: { 'deepseek-flash': FLASH } }, { path });
  assert.deepEqual(loadPriceTable({ path }).table.models['deepseek-flash'], FLASH);
  assert.deepEqual(readdirSync(join(DIR, 'nested', 'deeper')), ['pricing.json'], '不应留下临时文件');
});

test('priceTableStat：文件不存在时 exists=false，写入后 mtime 有值', () => {
  const path = nextPath();
  assert.equal(priceTableStat({ path }).exists, false);
  savePriceTable({ models: { 'deepseek-flash': FLASH } }, { path });
  const stat = priceTableStat({ path });
  assert.equal(stat.exists, true);
  assert.ok(stat.mtimeMs > 0);
  assert.ok(stat.size > 0);
});
