// provider 映射解析的确定性断言：识别顺序、引用顺序、非法配置的丢弃。
// 解析层是纯函数，不联网、不依赖宿主服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountCapabilityOf, aliasableProviderIds, candidateRefsOf } from '../lib/accounts.js';
import { createProviderResolver, normalizeAliases } from '../lib/providers.js';

test('可映射集合含 balance / usage / OAuth 路由，排除账号登录与同账户路由', () => {
  const ids = aliasableProviderIds();
  assert.ok(ids.includes('deepseek-official'));
  assert.ok(ids.includes('opencode-go'));
  assert.ok(ids.includes('kimi-coding'));
  assert.ok(ids.includes('minimax-cn'));
  // OAuth 目标：凭据是订阅令牌，由插件页单独写入凭据服务。
  assert.ok(ids.includes('anthropic'));
  assert.ok(ids.includes('openai-codex'));
  // 账号登录路由（grant）与同账户的 pi-ai DeepSeek 路由不作为目标。
  assert.equal(ids.includes('deepseek-account'), false);
  assert.equal(ids.includes('deepseek'), false);
  assert.equal(ids.includes('google'), false);
  for (const id of ids) {
    const kind = accountCapabilityOf(id).kind;
    assert.ok(kind !== 'none', `${id} 不该出现在可映射集合里`);
  }
});

test('映射到 OAuth 目标：不产生凭据引用，令牌由凭据服务提供', () => {
  const { aliases, warnings } = normalizeAliases([
    { provider: 'dsh-codex', capability: 'openai-codex', refs: ['SOME_REF'] },
  ]);
  assert.deepEqual(warnings, []);
  const resolver = createProviderResolver(aliases);
  const resolved = resolver.resolve('dsh-codex');
  assert.equal(resolved.via, 'alias');
  assert.equal(resolved.capabilityId, 'openai-codex');
  assert.equal(resolved.entry.kind, 'oauth');
  assert.deepEqual(resolved.refs, [], 'OAuth 目标不读 API Key 引用');
  assert.deepEqual([...resolver.capabilityIds], ['openai-codex']);
});

test('可映射集合里同账户的 DeepSeek 路由只留一条', () => {
  const ids = aliasableProviderIds();
  assert.ok(ids.includes('deepseek-official'));
  // `deepseek` 是 pi-ai 目录里读同一笔余额的另一条路由：仍按内置 id 识别，
  // 但不再作为映射目标，免得下拉里出现两个同名同账户的选项。
  assert.equal(ids.includes('deepseek'), false);
  assert.equal(accountCapabilityOf('deepseek').kind, 'balance', '内置识别不受影响');
  // 每个目标的名字唯一：再出现同账户的重复选项时，这条断言先失败。
  const names = ids.map((id) => accountCapabilityOf(id).displayName);
  assert.equal(new Set(names).size, names.length, `映射目标名字重复：${names.join(', ')}`);
});

test('归一化：trim、去重、丢弃非法项', () => {
  const { aliases, warnings } = normalizeAliases([
    { provider: ' dsh-opencode-go ', capability: 'opencode-go', refs: ['OPENCODE_API_KEY', 'bad-ref', 'OPENCODE_API_KEY'] },
    { provider: 'dsh-opencode-go', capability: 'moonshotai' }, // 重复：取第一条
    { provider: '', capability: 'zai' },
    { provider: 'acme', capability: 'no-such-provider' },
    'not-an-object',
  ]);
  assert.equal(aliases.size, 1);
  const alias = aliases.get('dsh-opencode-go');
  assert.equal(alias.provider, 'dsh-opencode-go');
  assert.equal(alias.capability, 'opencode-go');
  assert.deepEqual(alias.refs, ['OPENCODE_API_KEY']);
  assert.ok(warnings.length >= 4, `非法项都应记 warning，实际 ${warnings.length}`);
});

test('归一化：非数组配置整份忽略', () => {
  const { aliases, warnings } = normalizeAliases({ 'dsh-opencode-go': 'opencode-go' });
  assert.equal(aliases.size, 0);
  assert.equal(warnings.length, 1);
  assert.equal(normalizeAliases(undefined).warnings.length, 0);
  assert.equal(normalizeAliases(null).aliases.size, 0);
});

test('归一化：解包 schemastery volatile 引用对象', () => {
  // volatile() 字段经 Cordis 校验后是 { get() } 引用对象，不是普通数组。
  const raw = { get: () => [{ provider: 'dsh-opencode-go', capability: 'opencode-go', refs: ['OPENCODE_API_KEY'] }] };
  const { aliases, warnings } = normalizeAliases(raw);
  assert.deepEqual(warnings, []);
  assert.equal(aliases.get('dsh-opencode-go').capability, 'opencode-go');
  // get() 抛错时只记 warning，不把插件启动拖垮。
  const broken = normalizeAliases({ get: () => { throw new Error('boom'); } });
  assert.equal(broken.aliases.size, 0);
  assert.equal(broken.warnings.length, 1);
});

test('识别顺序：精确 id 永远优先，映射不能覆盖内置路由', () => {
  const { aliases } = normalizeAliases([{ provider: 'opencode-go', capability: 'moonshotai' }]);
  const resolver = createProviderResolver(aliases);
  const exact = resolver.resolve('opencode-go');
  assert.equal(exact.via, 'exact');
  assert.equal(exact.capabilityId, 'opencode-go');
  assert.deepEqual(exact.refs, candidateRefsOf('opencode-go'));
});

test('映射解析：refs 顺序为 显式 → 派生 → 能力表默认', () => {
  const { aliases } = normalizeAliases([
    { provider: 'dsh-opencode-go', capability: 'opencode-go', refs: ['OPENCODE_API_KEY'] },
  ]);
  const resolver = createProviderResolver(aliases);
  const resolved = resolver.resolve('dsh-opencode-go');
  assert.equal(resolved.via, 'alias');
  assert.equal(resolved.capabilityId, 'opencode-go');
  assert.equal(resolved.entry.id, 'opencode-go');
  assert.deepEqual(resolved.refs, [
    'OPENCODE_API_KEY',
    'DSH_OPENCODE_GO_API_KEY',
    'OPENCODE_GO_API_KEY',
  ]);
});

test('映射解析：大小写与空白不影响匹配', () => {
  const { aliases } = normalizeAliases([{ provider: 'DSH-Opencode-Go', capability: 'opencode-go' }]);
  const resolver = createProviderResolver(aliases);
  assert.equal(resolver.resolve('  dsh-opencode-go ').via, 'alias');
  assert.equal(resolver.resolve('DSH-OPENCODE-GO').capabilityId, 'opencode-go');
});

test('未识别与空 id 返回 null', () => {
  const resolver = createProviderResolver(normalizeAliases([]).aliases);
  assert.equal(resolver.resolve('dsh-opencode-go'), null);
  assert.equal(resolver.resolve(''), null);
  assert.equal(resolver.resolve(null), null);
  assert.equal(resolver.resolve(42), null);
  // 已知但不可查的 provider 仍然返回条目（调用方据此给出原因），不是 null。
  const google = resolver.resolve('google');
  assert.equal(google.via, 'exact');
  assert.equal(google.entry.kind, 'none');
});

test('OAuth 路由不产生 API Key 引用', () => {
  const resolver = createProviderResolver(normalizeAliases([]).aliases);
  assert.deepEqual(resolver.resolve('anthropic').refs, []);
});
