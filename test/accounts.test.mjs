// 多提供商账户查询的确定性断言：能力表、候选引用、各解析器、限流头兜底。
// 解析器是纯函数，不联网；makeAccountReader 的取数路径用桩 fetch 覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountCapabilityOf,
  candidateRefsOf,
  makeAccountReader,
  oauthProviderOf,
  parseClaudeOAuthUsage,
  parseClaudeRateLimitHeaders,
  parseCodexUsage,
  parseDeepSeekBalance,
  parseKimiCodingUsage,
  parseMiniMaxRemains,
  parseMoonshotBalance,
  parseOpenCodeUsage,
  parseOpenRouterCredits,
  parseOpenRouterKey,
  parseZaiBalance,
  supportedProviderIds,
  unsupportedReasonOf,
} from '../lib/accounts.js';

test('能力表覆盖三类 provider', () => {
  assert.equal(accountCapabilityOf('deepseek-official').kind, 'balance');
  assert.equal(accountCapabilityOf('moonshotai').kind, 'balance');
  assert.equal(accountCapabilityOf('zai').kind, 'balance');
  assert.equal(accountCapabilityOf('openrouter').kind, 'balance');
  assert.equal(accountCapabilityOf('kimi-coding').kind, 'usage');
  assert.equal(accountCapabilityOf('opencode-go').kind, 'usage');
  assert.equal(accountCapabilityOf('minimax-cn').kind, 'usage');
  assert.equal(accountCapabilityOf('anthropic').kind, 'oauth');
  assert.equal(accountCapabilityOf('openai-codex').kind, 'oauth');
  assert.equal(accountCapabilityOf('google').kind, 'none');
  assert.equal(accountCapabilityOf('azure').reason, 'cloudAuthOnly');
  assert.equal(accountCapabilityOf('github-copilot').reason, 'oauthOnly');
  // 未登记的 provider：无法判断，不是"不支持"。
  assert.equal(accountCapabilityOf('workbuddy'), null);
  assert.equal(accountCapabilityOf(''), null);
  assert.equal(accountCapabilityOf(null), null);
});

test('大小写与空白不影响能力判定', () => {
  assert.equal(accountCapabilityOf('  MoonshotAI ').kind, 'balance');
  assert.equal(accountCapabilityOf('KIMI-CODING').kind, 'usage');
});

test('候选引用：派生引用在前，适配器原生环境名在后', () => {
  assert.deepEqual(candidateRefsOf('moonshotai'), ['MOONSHOTAI_API_KEY', 'MOONSHOT_API_KEY']);
  assert.deepEqual(candidateRefsOf('minimax-cn'), ['MINIMAX_CN_API_KEY', 'MINIMAX_API_KEY']);
  assert.deepEqual(candidateRefsOf('zai'), ['ZAI_API_KEY', 'ZAI_CODING_CN_API_KEY']);
  // OAuth 与非 balance/usage 类不参与 API Key 解析。
  assert.deepEqual(candidateRefsOf('anthropic'), []);
  assert.deepEqual(candidateRefsOf('google'), []);
});

test('OAuth 提供商的令牌引用固定，不与其他引用冲突', () => {
  assert.equal(oauthProviderOf('anthropic').tokenRef, 'DSH_USAGE_CLAUDE_OAUTH_TOKEN');
  assert.equal(oauthProviderOf('openai-codex').tokenRef, 'DSH_USAGE_CODEX_OAUTH_TOKEN');
  assert.equal(oauthProviderOf('openai-codex').accountRef, 'DSH_USAGE_CODEX_ACCOUNT_ID');
  assert.equal(oauthProviderOf('moonshotai'), null);
});

test('受支持列表不含 none 类', () => {
  const ids = supportedProviderIds();
  assert.ok(ids.includes('deepseek-official'));
  assert.ok(ids.includes('anthropic'));
  assert.equal(ids.includes('google'), false);
  assert.equal(ids.includes('azure'), false);
  for (const id of ids) assert.notEqual(accountCapabilityOf(id).kind, 'none');
});

test('不可查原因分类', () => {
  assert.equal(unsupportedReasonOf('google'), 'cloudAuthOnly');
  assert.equal(unsupportedReasonOf('amazon-bedrock'), 'cloudAuthOnly');
  assert.equal(unsupportedReasonOf('github-copilot'), 'oauthOnly');
  assert.equal(unsupportedReasonOf('workbuddy'), null);
});

// ---- 解析器 ---------------------------------------------------------------

test('DeepSeek 余额：正常、缺失、不可用', () => {
  const ok = parseDeepSeekBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00' }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.balance.total, 110);
  assert.equal(ok.balance.currency, 'CNY');
  assert.equal(ok.balance.isAvailable, true);

  // 缺失 total → empty，不是 0。
  const empty = parseDeepSeekBalance({ is_available: true, balance_infos: [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'empty');

  const missing = parseDeepSeekBalance({ is_available: true, balance_infos: [{ currency: 'CNY' }] });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'empty');

  const down = parseDeepSeekBalance({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] });
  assert.equal(down.ok, false);
  assert.equal(down.code, 'unavailable');
});

test('Moonshot 余额：业务码非 0 是 shape', () => {
  const ok = parseMoonshotBalance({ code: 0, data: { available_balance: 49.58894 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.balance.total, 49.58894);
  // 接口不返回币种，由调用方按 host 补。
  assert.equal(ok.balance.currency, null);

  // code 非 0 且有 data → shape（业务错误）。
  assert.equal(parseMoonshotBalance({ code: 401, data: { available_balance: 1 } }).code, 'shape');
  // code 非 0 且没有 data → 同样 shape（错误响应不该被读成"没有数据"）。
  assert.equal(parseMoonshotBalance({ code: 401, data: {} }).code, 'shape');
  // code 为 0 但没有可用数值 → empty。
  assert.equal(parseMoonshotBalance({ code: 0, data: {} }).code, 'empty');
  // 整个 body 不是预期形状 → shape。
  assert.equal(parseMoonshotBalance({}).code, 'shape');
});

test('智谱余额：success false 是 shape，空 data 是 empty', () => {
  const ok = parseZaiBalance({ success: true, data: { balance: 42.5, availableBalance: 42.5 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.balance.total, 42.5);
  assert.equal(ok.balance.currency, 'CNY');

  assert.equal(parseZaiBalance({ success: false, msg: 'nope' }).code, 'shape');
  assert.equal(parseZaiBalance({ success: true, data: {} }).code, 'empty');
  assert.equal(parseZaiBalance({}).code, 'shape');
});

test('OpenRouter：单 Key 无限额时回落总余额', () => {
  const withLimit = parseOpenRouterKey({ data: { limit: 100, limit_remaining: 37.66 } });
  assert.equal(withLimit.ok, true);
  assert.equal(withLimit.balance.total, 37.66);

  // limit_remaining 为 null → empty（调用方据此回落 /api/v1/credits）。
  assert.equal(parseOpenRouterKey({ data: { limit: null, limit_remaining: null } }).code, 'empty');
  assert.equal(parseOpenRouterKey({}).code, 'shape');

  const credits = parseOpenRouterCredits({ data: { total_credits: 100.5, total_usage: 25.75 } });
  assert.equal(credits.ok, true);
  assert.equal(credits.balance.total, 74.75);
  assert.equal(parseOpenRouterCredits({ data: { total_credits: 10 } }).code, 'empty');
});

test('Kimi Coding 用量：300 分钟映射 5h，7 天映射 7d', () => {
  const body = {
    usage: {
      limits: [
        { window: { duration: 300, timeUnit: 'MINUTE' }, detail: { usedPercent: 25, resetTime: 1789882800 } },
        { window: { duration: 604800, timeUnit: 'SECOND' }, detail: { used_percent: 40 } },
      ],
    },
  };
  const out = parseKimiCodingUsage(body);
  assert.equal(out.ok, true);
  assert.deepEqual(out.usage.windows.map((w) => w.key), ['5h', '7d']);
  assert.equal(out.usage.windows[0].percent, 25);
  assert.equal(out.usage.windows[0].resetsAt, 1789882800000);

  assert.equal(parseKimiCodingUsage({ usage: { limits: [] } }).code, 'empty');
  assert.equal(parseKimiCodingUsage({}).code, 'shape');
  // 没有任何可用百分度的条目 → empty，不猜 0。
  assert.equal(parseKimiCodingUsage({ usage: { limits: [{ window: { duration: 300 }, detail: {} }] } }).code, 'empty');
});

test('Kimi Coding 用量：真实字段（limit/used 计数、usages 比例池）也能凑出多窗口', () => {
  // 社区实测形态：顶层 usage 给周额度计数，limits[] 给 5 小时窗口，
  // usages.* 给比例池（used_ratio 0..1），其中包含月窗口。
  const body = {
    usage: {
      limit: '1000',
      used: '250',
      remaining: '750',
      resetTime: '2026-11-02T00:00:00.000Z',
      limits: [
        { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', used: '10', resetTime: '2026-10-28T18:00:00.000Z' } },
      ],
    },
    usages: {
      limit_5h: { used_ratio: 0.5, reset_time: '2026-10-28T18:00:00.000Z' },
      limit_month_total: { used_ratio: 0.8, reset_time: '2026-11-28T00:00:00.000Z' },
    },
  };
  const out = parseKimiCodingUsage(body);
  assert.equal(out.ok, true);
  const byKey = Object.fromEntries(out.usage.windows.map((w) => [w.key, w]));
  assert.equal(byKey['7d'].percent, 25, '周窗口由 used/limit 换算');
  assert.equal(byKey['5h'].percent, 50, '同 key 取更高的已用百分比（usages 的比例池）');
  assert.equal(byKey['30d'].percent, 80, '月窗口来自 limit_month_total');
  assert.equal(byKey['5h'].resetsAt, Date.parse('2026-10-28T18:00:00.000Z'));

  // 只有 usages 比例池、没有 usage 时同样可读。
  const ratioOnly = parseKimiCodingUsage({ usages: { limit_5h: { used_ratio: 0.25 } } });
  assert.equal(ratioOnly.ok, true);
  assert.deepEqual(ratioOnly.usage.windows.map((w) => w.key), ['5h']);
  assert.equal(ratioOnly.usage.windows[0].percent, 25);
});

test('OpenCode 用量：非 ok 状态的窗口被跳过', () => {
  const body = {
    usage: {
      rolling: { status: 'ok', percent: 12, resetsAt: '2026-08-13T16:00:00.000Z' },
      weekly: { status: 'ok', percent: 34 },
      monthly: { status: 'unsubscribed' },
    },
  };
  const out = parseOpenCodeUsage(body);
  assert.equal(out.ok, true);
  assert.deepEqual(out.usage.windows.map((w) => w.key), ['5h', '7d']);
  assert.equal(out.usage.windows[0].resetsAt, Date.parse('2026-08-13T16:00:00.000Z'));
  assert.equal(parseOpenCodeUsage({ usage: {} }).code, 'empty');
  assert.equal(parseOpenCodeUsage({}).code, 'shape');
});

test('MiniMax 用量：取最紧窗口，百分比可换算', () => {
  const body = {
    base_resp: { status_code: 0 },
    model_remains: [
      { current_interval_remaining_percent: 80, end_time: 1790000000 },
      { current_interval_remaining_percent: 20, end_time: 1790000001 },
    ],
  };
  const out = parseMiniMaxRemains(body);
  assert.equal(out.ok, true);
  assert.equal(out.usage.windows.length, 1);
  assert.equal(out.usage.windows[0].percent, 80, '取剩余最少（用得最多）的那条');
  assert.equal(out.usage.windows[0].key, 'cycle');

  // 只有总数与剩余数时按差值换算。
  const counts = parseMiniMaxRemains({
    base_resp: { status_code: 0 },
    model_remains: [{ current_interval_total_count: 1000, current_interval_remaining_count: 250 }],
  });
  assert.equal(counts.ok, true);
  assert.equal(counts.usage.windows[0].percent, 75);

  assert.equal(parseMiniMaxRemains({ base_resp: { status_code: 1004 }, model_remains: [] }).code, 'shape');
  assert.equal(parseMiniMaxRemains({ model_remains: [] }).code, 'empty');
  assert.equal(parseMiniMaxRemains({}).code, 'empty');
});

test('MiniMax 用量：区间 + 周窗口各取最紧的桶', () => {
  const body = {
    base_resp: { status_code: 0 },
    model_remains: [
      {
        current_interval_remaining_percent: 80,
        end_time: 1790000000000,
        current_weekly_remaining_percent: 40,
        weekly_end_time: 1790500000000,
      },
      {
        current_interval_remaining_percent: 20,
        end_time: 1790000001000,
        current_weekly_remaining_percent: 70,
        weekly_end_time: 1790500001000,
      },
    ],
  };
  const out = parseMiniMaxRemains(body);
  assert.equal(out.ok, true);
  const byKey = Object.fromEntries(out.usage.windows.map((w) => [w.key, w]));
  assert.equal(byKey.cycle.percent, 80, '区间窗口取两个桶里用得最多的');
  assert.equal(byKey.cycle.resetsAt, 1790000001000);
  assert.equal(byKey['7d'].percent, 60, '周窗口取两个桶里用得最多的（剩余 40 → 已用 60）');
  assert.equal(byKey['7d'].resetsAt, 1790500000000);
});

test('Claude OAuth 用量：null 窗口跳过', () => {
  const body = {
    five_hour: { utilization: 33, resets_at: '2026-04-11T07:00:00.528743+00:00' },
    seven_day: { utilization: 13, resets_at: '2026-04-17T00:59:59.951713+00:00' },
    seven_day_opus: null,
  };
  const out = parseClaudeOAuthUsage(body);
  assert.equal(out.ok, true);
  assert.deepEqual(out.usage.windows.map((w) => w.key), ['5h', '7d']);
  assert.equal(out.usage.windows[0].percent, 33);

  assert.equal(parseClaudeOAuthUsage({ five_hour: null, seven_day: null }).code, 'empty');
  assert.equal(parseClaudeOAuthUsage({}).code, 'empty');
});

test('Claude OAuth 用量：Opus 专属周窗口用独立 key，不和 7 天合并', () => {
  const out = parseClaudeOAuthUsage({
    five_hour: { utilization: 10 },
    seven_day: { utilization: 20 },
    seven_day_opus: { utilization: 90, resets_at: '2026-11-01T00:00:00.000Z' },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.usage.windows.map((w) => w.key), ['5h', '7d', '7d-opus']);
  assert.equal(out.usage.windows[2].percent, 90);
});

test('Claude 限流头：0..1 缩放成 0..100，秒转毫秒', () => {
  const out = parseClaudeRateLimitHeaders({
    'anthropic-ratelimit-unified-5h-utilization': '0.27',
    'anthropic-ratelimit-unified-5h-reset': '1789882800',
    'anthropic-ratelimit-unified-7d-utilization': '0.95',
    'anthropic-ratelimit-unified-7d-reset': '1790348400',
  });
  assert.notEqual(out, null);
  assert.deepEqual(out.usage.windows.map((w) => w.key), ['5h', '7d']);
  assert.equal(out.usage.windows[0].percent, 27);
  assert.equal(out.usage.windows[0].resetsAt, 1789882800000);

  // 一个窗口也没有 → null（调用方据此判断"这个令牌读不到用量"）。
  assert.equal(parseClaudeRateLimitHeaders({}), null);
  assert.equal(parseClaudeRateLimitHeaders({ 'anthropic-ratelimit-unified-status': 'allowed' }), null);
  // 非数字被忽略，不当成 0。
  assert.equal(parseClaudeRateLimitHeaders({ 'anthropic-ratelimit-unified-5h-utilization': 'n/a' }), null);
  // 数组形态取第一个值。
  const arr = parseClaudeRateLimitHeaders({ 'anthropic-ratelimit-unified-5h-utilization': ['0.42', '0.99'] });
  assert.equal(arr.usage.windows[0].percent, 42);
  // 缺 reset 头的窗口仍然给出（resetsAt 为 null）。
  const noReset = parseClaudeRateLimitHeaders({ 'anthropic-ratelimit-unified-7d-utilization': '0.5' });
  assert.equal(noReset.usage.windows[0].percent, 50);
  assert.equal(noReset.usage.windows[0].resetsAt, null);
});

test('Codex 用量：窗口 + credits.balance', () => {
  const body = {
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 6, reset_at: 1738300000 },
      secondary_window: { used_percent: 24, reset_at: 1738900000 },
    },
    credits: { has_credits: true, unlimited: false, balance: 820.6969075 },
  };
  const out = parseCodexUsage(body);
  assert.equal(out.ok, true);
  assert.deepEqual(out.usage.windows.map((w) => w.key), ['5h', '7d']);
  assert.equal(out.usage.windows[0].percent, 6);
  assert.equal(out.balance.total, 820.6969075);
  assert.equal(out.balance.currency, 'USD');
  assert.equal(out.usage.plan, 'plus');

  // 没有 credits 时 balance 为 null，窗口照常。
  const noCredits = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 1 } } });
  assert.equal(noCredits.ok, true);
  assert.equal(noCredits.balance, null);
  // unlimited 不当成余额。
  const unlimited = parseCodexUsage({ rate_limit: {}, credits: { has_credits: true, unlimited: true } });
  assert.equal(unlimited.balance, null);
  assert.equal(unlimited.code, 'empty');
  assert.equal(parseCodexUsage({}).code, 'shape');
});

test('Codex 用量：窗口 key 跟着 limit_window_seconds 走，缺字段才按位置回退', () => {
  const windowsFromSeconds = parseCodexUsage({
    rate_limit: {
      primary_window: { used_percent: 5, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 50, limit_window_seconds: 604800 },
    },
  });
  assert.deepEqual(windowsFromSeconds.usage.windows.map((w) => w.key), ['5h', '7d']);

  // 位置与长度对不上时按长度标注，不硬套 primary=5h。
  const swapped = parseCodexUsage({
    rate_limit: {
      primary_window: { used_percent: 5, limit_window_seconds: 604800 },
      secondary_window: { used_percent: 50, limit_window_seconds: 3600 },
    },
  });
  assert.deepEqual(swapped.usage.windows.map((w) => w.key), ['7d', '1h']);

  // 只有位置字段时保留历史口径。
  const positional = parseCodexUsage({
    rate_limit: { primary_window: { used_percent: 6 }, secondary_window: { used_percent: 24 } },
  });
  assert.deepEqual(positional.usage.windows.map((w) => w.key), ['5h', '7d']);
});

// ---- 取数路径（桩 fetch）--------------------------------------------------

/** 造一个按 URL 分派的桩 fetch。 */
function stubFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (key === undefined) throw new Error(`unexpected fetch: ${url}`);
    const route = routes[key];
    if (typeof route === 'function') return route(url, init);
    const { status = 200, body = {}, headers = {} } = route;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { impl, calls };
}

test('取数：DeepSeek 端点由宿主注入', async () => {
  const { impl, calls } = stubFetch({ '/user/balance': { body: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34' }] } } });
  const reader = makeAccountReader({ fetchImpl: impl, deepseekUrl: 'https://api.deepseek.com/user/balance' });
  const out = await reader.read(accountCapabilityOf('deepseek-official'), 'sk-test');
  assert.equal(out.ok, true);
  assert.equal(out.balance.total, 12.34);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
});

test('取数：Moonshot 国际站失败后回落国内站，币种按 host 补', async () => {
  const { impl, calls } = stubFetch({
    'api.moonshot.ai': { status: 500, body: {} },
    'api.moonshot.cn': { body: { code: 0, data: { available_balance: 8.5 } } },
  });
  const reader = makeAccountReader({ fetchImpl: impl });
  const out = await reader.read(accountCapabilityOf('moonshotai'), 'sk-test');
  assert.equal(out.ok, true);
  assert.equal(out.balance.total, 8.5);
  assert.equal(out.balance.currency, 'CNY');
  assert.equal(calls.length, 2, '第一个 host 失败后应尝试第二个');
});

test('取数：OpenRouter 单 Key 无限额时回落总余额', async () => {
  const { impl, calls } = stubFetch({
    '/api/v1/key': { body: { data: { limit: null, limit_remaining: null } } },
    '/api/v1/credits': { body: { data: { total_credits: 50, total_usage: 20 } } },
  });
  const reader = makeAccountReader({ fetchImpl: impl });
  const out = await reader.read(accountCapabilityOf('openrouter'), 'sk-test');
  assert.equal(out.ok, true);
  assert.equal(out.balance.total, 30);
  assert.equal(calls.length, 2);
});

test('取数：OpenCode 用量接口同时带 Authorization 与 x-api-key', async () => {
  const { impl, calls } = stubFetch({ '/zen/go/v1/usage': { body: { usage: { rolling: { status: 'ok', percent: 4 } } } } });
  const reader = makeAccountReader({ fetchImpl: impl });
  const out = await reader.read(accountCapabilityOf('opencode'), 'sk-test');
  assert.equal(out.ok, true);
  assert.equal(out.usage.windows[0].percent, 4);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
  assert.equal(calls[0].init.headers['x-api-key'], 'sk-test');
});

test('取数：Claude 403 时回落最小推理请求读限流头', async () => {
  const { impl, calls } = stubFetch({
    '/api/oauth/usage': { status: 403, body: { error: { type: 'permission_error' } } },
    '/v1/messages': {
      body: {},
      headers: {
        'anthropic-ratelimit-unified-5h-utilization': '0.33',
        'anthropic-ratelimit-unified-5h-reset': '1789882800',
        'anthropic-ratelimit-unified-7d-utilization': '0.13',
      },
    },
  });
  const reader = makeAccountReader({ fetchImpl: impl });
  const out = await reader.read(accountCapabilityOf('anthropic'), 'sk-ant-token');
  assert.equal(out.ok, true);
  assert.deepEqual(out.usage.windows.map((w) => w.key), ['5h', '7d']);
  assert.equal(out.usage.windows[0].percent, 33);
  assert.equal(calls[1].init.method, 'POST', '兜底是一次推理请求');
  assert.equal(calls[1].init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(JSON.parse(calls[1].init.body).max_tokens, 1);
});

test('取数：Claude 401 且兜底也读不到时报令牌失效，不静默当成没有数据', async () => {
  // 401 会触发限流头兜底；兜底本身拿不到窗口时报 unauthorized，
  // 让宿主给出"重新填写令牌"而不是"没有数据"。
  const { impl } = stubFetch({
    '/api/oauth/usage': { status: 401, body: {} },
    '/v1/messages': { status: 429, body: {} },
  });
  const reader = makeAccountReader({ fetchImpl: impl });
  const out = await reader.read(accountCapabilityOf('anthropic'), 'sk-ant-token');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'unauthorized');
});

test('取数：Codex 带 ChatGPT-Account-Id 头', async () => {
  const { impl, calls } = stubFetch({
    '/backend-api/wham/usage': { body: { rate_limit: { primary_window: { used_percent: 6 } }, credits: { has_credits: true, balance: 10 } } },
  });
  const reader = makeAccountReader({ fetchImpl: impl });
  const out = await reader.read(accountCapabilityOf('openai-codex'), 'token', { accountId: 'acc-123' });
  assert.equal(out.ok, true);
  assert.equal(out.balance.total, 10);
  assert.equal(calls[0].init.headers['ChatGPT-Account-Id'], 'acc-123');
});

test('取数：超时与网络错误分类', async () => {
  const timeoutReader = makeAccountReader({ fetchImpl: async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; } });
  const timed = await timeoutReader.read(accountCapabilityOf('moonshotai'), 'sk');
  assert.equal(timed.code, 'timeout');

  const networkReader = makeAccountReader({ fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); } });
  const net = await networkReader.read(accountCapabilityOf('moonshotai'), 'sk');
  assert.equal(net.code, 'network');
});

test('取数：超限响应体按 shape 处理', async () => {
  const reader = makeAccountReader({
    fetchImpl: async () => new Response('x'.repeat(70 * 1024), { status: 200, headers: { 'content-type': 'text/plain' } }),
  });
  const out = await reader.read(accountCapabilityOf('moonshotai'), 'sk');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'shape');
});
