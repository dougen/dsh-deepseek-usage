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
  parseMiMoBalance,
  parseMiMoTokenPlan,
  parseMiniMaxRemains,
  parseMoonshotBalance,
  parseOpenCodeUsage,
  parseOpenRouterCredits,
  parseOpenRouterKey,
  parseZaiBalance,
  parseZaiCodingQuota,
  supportedProviderIds,
  unsupportedReasonOf,
} from '../lib/accounts.js';

test('能力表覆盖三类 provider', () => {
  assert.equal(accountCapabilityOf('deepseek-official').kind, 'balance');
  assert.equal(accountCapabilityOf('moonshotai').kind, 'balance');
  assert.equal(accountCapabilityOf('zai').kind, 'balance');
  // Z.ai 的两条订阅路由：国内 Coding Plan 是 DSH 内置路由，海外那条供映射。
  assert.equal(accountCapabilityOf('zai-coding-cn').kind, 'usage');
  assert.equal(accountCapabilityOf('zai-coding').kind, 'usage');
  assert.equal(accountCapabilityOf('openrouter').kind, 'balance');
  assert.equal(accountCapabilityOf('mimo').kind, 'balance');
  assert.equal(accountCapabilityOf('mimo-token-plan').kind, 'usage');
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

test('provider 路由 id 别名归一：chatgpt-codex 走同一份 Codex 订阅能力', () => {
  // 第三方 Codex 插件把同一家订阅接口注册成 `chatgpt-codex`；不归一化时会被判成
  // 「不支持的提供商」，卡片整张置空。
  const alias = accountCapabilityOf('chatgpt-codex');
  assert.equal(alias.kind, 'oauth');
  assert.equal(alias.id, 'openai-codex');
  assert.equal(alias.tokenRef, 'DSH_USAGE_CODEX_OAUTH_TOKEN');
  assert.equal(accountCapabilityOf('ChatGPT-Codex').kind, 'oauth');
  assert.equal(oauthProviderOf('chatgpt-codex').tokenRef, 'DSH_USAGE_CODEX_OAUTH_TOKEN');
  assert.equal(oauthProviderOf('chatgpt-codex').usage.path, '/backend-api/wham/usage');
  // 别名不是独立条目：受支持 id 全集里不会多出一条重复行。
  assert.equal(supportedProviderIds().includes('chatgpt-codex'), false);
});

test('候选引用：派生引用在前，适配器原生环境名在后', () => {
  assert.deepEqual(candidateRefsOf('moonshotai'), ['MOONSHOTAI_API_KEY', 'MOONSHOT_API_KEY']);
  assert.deepEqual(candidateRefsOf('minimax-cn'), ['MINIMAX_CN_API_KEY', 'MINIMAX_API_KEY']);
  assert.deepEqual(candidateRefsOf('zai'), ['ZAI_API_KEY', 'ZAI_CODING_CN_API_KEY']);
  // 国内 Coding Plan 路由只认自己的 Key：按量 Key 读不到套餐。
  assert.deepEqual(candidateRefsOf('zai-coding-cn'), ['ZAI_CODING_CN_API_KEY']);
  assert.deepEqual(candidateRefsOf('zai-coding'), ['ZAI_CODING_API_KEY', 'ZAI_API_KEY']);
  assert.deepEqual(candidateRefsOf('mimo'), ['MIMO_API_KEY']);
  assert.deepEqual(candidateRefsOf('mimo-token-plan'), ['MIMO_TOKEN_PLAN_API_KEY']);
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

  // 可用性是账户级状态：没有 balance_infos 时也要报 unavailable，而不是 empty。
  for (const body of [
    { is_available: false },
    { is_available: false, balance_infos: [] },
    { is_available: false, balance_infos: [{ currency: 'CNY' }] },
  ]) {
    assert.equal(parseDeepSeekBalance(body).code, 'unavailable');
  }
});

test('DeepSeek 余额：多币种钱包取有余额的那个，不被空的 USD 盖住', () => {
  const mainland = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
      { currency: 'CNY', total_balance: '58.74', granted_balance: '0.00', topped_up_balance: '58.74' },
    ],
  });
  assert.equal(mainland.ok, true);
  assert.equal(mainland.balance.total, 58.74);
  assert.equal(mainland.balance.currency, 'CNY');

  // 没有数值的钱包不参与挑选。
  const withMissing = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [{ currency: 'USD' }, { currency: 'CNY', total_balance: '9.00' }],
  });
  assert.equal(withMissing.balance.total, 9);
  assert.equal(withMissing.balance.currency, 'CNY');

  // 只有 USD 有钱时不能被 CNY 的 0 盖住——按余额挑，不硬编码币种。
  const intl = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [{ currency: 'USD', total_balance: '10.00' }, { currency: 'CNY', total_balance: '0.00' }],
  });
  assert.equal(intl.balance.total, 10);
  assert.equal(intl.balance.currency, 'USD');

  // 两个都有钱：大陆账号优先 CNY。
  const both = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [{ currency: 'USD', total_balance: '2.00' }, { currency: 'CNY', total_balance: '58.74' }],
  });
  assert.equal(both.balance.total, 58.74);
  assert.equal(both.balance.currency, 'CNY');

  // 全为 0 时退回第一条，保持原有取值顺序。
  const zero = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [{ currency: 'USD', total_balance: '0.00' }, { currency: 'CNY', total_balance: '0.00' }],
  });
  assert.equal(zero.balance.total, 0);
  assert.equal(zero.balance.currency, 'USD');
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

test('GLM Coding Plan 个人套餐额度：三类池子按 type/unit/number 归到窗口，percentage 是已用', () => {
  const out = parseZaiCodingQuota({
    code: 200,
    msg: '操作成功',
    success: true,
    data: {
      level: 'lite',
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1, nextResetTime: 1778753640304 },
        { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 100, currentValue: 0, remaining: 100, percentage: 0, nextResetTime: 1781345721976 },
        // 文档示例里没有周额度；补一条验证顺序与 key。
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 34.5, nextResetTime: 1780000000 },
      ],
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.balance, null);
  assert.equal(out.usage.plan, 'GLM Coding Lite');
  assert.deepEqual(out.usage.windows, [
    { key: '5h', percent: 1, resetsAt: 1778753640304 },
    { key: '7d', percent: 34.5, resetsAt: 1780000000000 },
    { key: 'mcp', percent: 0, resetsAt: 1781345721976 },
  ]);
});

test('GLM Coding Plan 个人套餐额度：接口只返回的池子才画，认不出的条目不猜', () => {
  // 新版个人积分套餐按 credit 计；周额度缺失时卡片上就没有 7d。
  const credits = parseZaiCodingQuota({
    success: true,
    data: {
      level: 'PRO',
      limits: [
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 12, nextResetTime: '2026-11-27T10:00:00.000Z' },
        // 同样是 token 池但不是 5 小时：不归到任何窗口。
        { type: 'TOKENS_LIMIT', unit: 3, number: 200, percentage: 80 },
      ],
    },
  });
  assert.equal(credits.ok, true);
  assert.equal(credits.usage.plan, 'GLM Coding Pro');
  assert.deepEqual(credits.usage.windows, [{ key: '5h', percent: 12, resetsAt: Date.parse('2026-11-27T10:00:00.000Z') }]);

  // percentage 缺失：按同一条的 已用/总量 折算；连总数也没有就不画，不当成 0%。
  const derived = parseZaiCodingQuota({
    data: {
      limits: [
        { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 200, currentValue: 50, remaining: 150 },
        { type: 'TOKENS_LIMIT', unit: 3, number: 5 },
      ],
    },
  });
  assert.deepEqual(derived.usage.windows, [{ key: 'mcp', percent: 25, resetsAt: null }]);

  // 越界值截到 0–100。
  const clamped = parseZaiCodingQuota({
    data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 140 }, { type: 'TOKENS_LIMIT', unit: 6, percentage: -5 }] },
  });
  assert.deepEqual(clamped.usage.windows.map((w) => w.percent), [100, 0]);
});

test('GLM Coding Plan 个人套餐额度：没套餐是 noPlan，其它失败信封是 shape，成功但没有池子是 empty', () => {
  // 接口对「没有套餐」仍回 HTTP 200，只是信封是失败的；兼容空格和大小写。
  assert.equal(parseZaiCodingQuota({ code: 400, msg: '当前用户不存在coding plan', success: false }).code, 'noPlan');
  assert.equal(parseZaiCodingQuota({ code: 400, msg: '当前用户不存在 Coding Plan', success: false }).code, 'noPlan');
  assert.equal(parseZaiCodingQuota({ code: 404, msg: 'No Coding Plan found', success: false }).code, 'noPlan');
  assert.equal(parseZaiCodingQuota({ code: 403, msg: 'No coding plan permission', success: false }).code, 'shape');
  assert.equal(parseZaiCodingQuota({ code: 403, msg: 'No Coding Plan access permission', success: false }).code, 'shape');
  assert.equal(parseZaiCodingQuota({ code: 401, msg: '用户没有资格访问' }).code, 'shape');
  assert.equal(parseZaiCodingQuota({ code: 403, msg: '没有权限访问该接口' }).code, 'shape');
  assert.equal(parseZaiCodingQuota({ code: 401, msg: '令牌已过期或失效', success: false }).code, 'shape');
  assert.equal(parseZaiCodingQuota({ success: false }).code, 'shape');
  assert.equal(parseZaiCodingQuota([]).code, 'shape');
  assert.equal(parseZaiCodingQuota(null).code, 'shape');

  assert.equal(parseZaiCodingQuota({ code: 200, success: true, data: { level: 'lite', limits: [] } }).code, 'empty');
  assert.equal(parseZaiCodingQuota({ code: 200, data: { limits: [{ type: 'TIME_LIMIT', unit: 9, number: 1, percentage: 5 }] } }).code, 'empty');
  // 没有 code 字段、也没说失败的信封按成功处理（与 ZCode 的判定一致）。
  assert.equal(parseZaiCodingQuota({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 7 }] } }).usage.windows[0].percent, 7);
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

test('MiMo 余额：字符串金额、不可用状态与缺失字段', () => {
  const ok = parseMiMoBalance({
    object: 'balance',
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_available: '500.50', cash_balance: '100.50' }],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.balance.total, 500.5);
  assert.equal(ok.balance.currency, 'CNY');
  assert.equal(ok.balance.isAvailable, true);

  const down = parseMiMoBalance({ is_available: false, balance_infos: [{ currency: 'CNY', total_available: '1.00' }] });
  assert.equal(down.code, 'unavailable', '账户不可用优先于金额');

  assert.equal(parseMiMoBalance({ is_available: true }).code, 'shape');
  assert.equal(parseMiMoBalance({ is_available: true, balance_infos: [] }).code, 'empty');
  assert.equal(parseMiMoBalance({ is_available: true, balance_infos: [{ currency: 'CNY' }] }).code, 'empty');
  assert.equal(parseMiMoBalance({}).code, 'shape');
});

test('MiMo Token Plan：周期积分换算已用百分比，重置时间按 UTC 解析', () => {
  const out = parseMiMoTokenPlan({
    object: 'token_plan',
    plan_code: 'pro',
    period: { start_at: '2026-09-21 23:59:59', end_at: '2027-09-21 23:59:59' },
    quota: { total_credits: 10000000, used_credits: 1500000, remaining_credits: 8500000 },
  });
  assert.equal(out.ok, true);
  assert.equal(out.balance, null);
  assert.equal(out.usage.plan, 'pro');
  assert.equal(out.usage.windows.length, 1);
  assert.equal(out.usage.windows[0].key, 'cycle');
  assert.equal(out.usage.windows[0].percent, 15);
  assert.equal(out.usage.windows[0].resetsAt, Date.parse('2027-09-21T23:59:59Z'));

  // 字符串计数照常换算；缺周期时重置时间为 null；总数非法时不猜。
  const stringCounts = parseMiMoTokenPlan({
    object: 'token_plan',
    quota: { total_credits: '100', used_credits: '25' },
  });
  assert.equal(stringCounts.usage.windows[0].percent, 25);
  assert.equal(stringCounts.usage.windows[0].resetsAt, null);
  assert.equal(parseMiMoTokenPlan({ object: 'token_plan', quota: { total_credits: 0, used_credits: 1 } }).code, 'empty');
  assert.equal(parseMiMoTokenPlan({ object: 'token_plan', quota: {} }).code, 'empty');
  assert.equal(parseMiMoTokenPlan({ object: 'balance', quota: { total_credits: 10, used_credits: 1 } }).code, 'shape');
  assert.equal(parseMiMoTokenPlan({}).code, 'shape');
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

test('Kimi Coding 用量：TIME_UNIT_* 枚举值正确映射成 5h/7d', () => {
  // 接口给的是 TIME_UNIT_MINUTE / TIME_UNIT_DAY，不是裸 MINUTE/DAY。
  // 不剥前缀会让窗口落到 cycle，卡片显示成「周期」。
  const out = parseKimiCodingUsage({
    usage: {
      limits: [
        { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', used: '10' } },
        { window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' }, detail: { limit: '100', used: '20' } },
      ],
    },
  });
  assert.equal(out.ok, true);
  const byKey = Object.fromEntries(out.usage.windows.map((w) => [w.key, w]));
  assert.equal(byKey['5h'].percent, 10);
  assert.equal(byKey['7d'].percent, 20);
  assert.equal(byKey.cycle, undefined);
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

test('取数：MiMo 余额与 Token Plan 各走官方端点', async () => {
  const { impl, calls } = stubFetch({
    '/v1/platform/balance': { body: { object: 'balance', is_available: true, balance_infos: [{ currency: 'CNY', total_available: '12.34' }] } },
    '/v1/platform/token_plan': { body: { object: 'token_plan', quota: { total_credits: 100, used_credits: 40 } } },
  });
  const reader = makeAccountReader({ fetchImpl: impl });
  const balance = await reader.read(accountCapabilityOf('mimo'), 'sk-mimo');
  assert.equal(balance.ok, true);
  assert.equal(balance.balance.total, 12.34);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-mimo');
  assert.match(calls[0].url, /api\.xiaomimimo\.com\/v1\/platform\/balance$/);

  const plan = await reader.read(accountCapabilityOf('mimo-token-plan'), 'tp-mimo');
  assert.equal(plan.ok, true);
  assert.equal(plan.usage.windows[0].percent, 40);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer tp-mimo');
  assert.match(calls[1].url, /token-plan-cn\.xiaomimimo\.com\/v1\/platform\/token_plan$/);
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

test('取数：GLM Coding Plan 个人套餐额度头是裸 Key（不加 Bearer），国内走 open.bigmodel.cn、海外走 api.z.ai', async () => {
  const quota = {
    code: 200,
    success: true,
    data: { level: 'lite', limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 9, nextResetTime: 1778753640304 }] },
  };
  const { impl, calls } = stubFetch({ '/api/monitor/usage/quota/limit': { body: quota } });
  const reader = makeAccountReader({ fetchImpl: impl });

  const cn = await reader.read(accountCapabilityOf('zai-coding-cn'), 'id.secret');
  assert.equal(cn.ok, true);
  assert.deepEqual(cn.usage.windows, [{ key: '5h', percent: 9, resetsAt: 1778753640304 }]);
  assert.match(calls[0].url, /^https:\/\/open\.bigmodel\.cn\/api\/monitor\/usage\/quota\/limit$/);
  assert.equal(calls[0].init.headers.Authorization, 'id.secret', '与 ZCode 一致：发裸 Key');
  assert.deepEqual(Object.keys(calls[0].init.headers).sort(), ['Accept', 'Authorization'], '个人套餐使用无作用域端点');
  assert.equal(calls[0].init.method, 'GET');

  const intl = await reader.read(accountCapabilityOf('zai-coding'), 'id.secret');
  assert.equal(intl.ok, true);
  assert.match(calls[1].url, /^https:\/\/api\.z\.ai\/api\/monitor\/usage\/quota\/limit$/);
  assert.equal(calls[1].init.headers.Authorization, 'id.secret');
  assert.deepEqual(Object.keys(calls[1].init.headers).sort(), ['Accept', 'Authorization'], '个人套餐使用无作用域端点');
});

test('取数：GLM Coding Plan 个人套餐国内主域失败时回落 bigmodel.cn，没套餐时给出 noPlan', async () => {
  const { impl, calls } = stubFetch({
    'open.bigmodel.cn': { status: 502, body: {} },
    'bigmodel.cn/api/monitor': { body: { code: 200, success: true, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 40 }] } } },
  });
  const reader = makeAccountReader({ fetchImpl: impl });
  const out = await reader.read(accountCapabilityOf('zai-coding-cn'), 'k');
  assert.equal(out.ok, true);
  assert.deepEqual(out.usage.windows.map((w) => w.key), ['7d']);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /^https:\/\/bigmodel\.cn\/api\/monitor\/usage\/quota\/limit$/);

  // 两边都回 401：不把 Key 或上游原文带出去，按无法解析处理。
  const denied = stubFetch({ '/api/monitor/usage/quota/limit': { status: 401, body: { code: 401, msg: '令牌已过期或失效' } } });
  const out2 = await makeAccountReader({ fetchImpl: denied.impl }).read(accountCapabilityOf('zai-coding-cn'), 'bad');
  assert.equal(out2.ok, false);
  assert.equal(out2.code, 'shape');
  assert.equal(denied.calls.length, 2, '主域失败后应尝试第二个 host');
});

test('取数：GLM Coding Plan 个人套餐国内网络异常和超时也回落 bigmodel.cn', async () => {
  const quota = {
    code: 200,
    success: true,
    data: { limits: [{ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 40 }] },
  };
  const network = stubFetch({
    'open.bigmodel.cn': () => { throw new TypeError('connect ECONNREFUSED'); },
    'bigmodel.cn/api/monitor': { body: quota },
  });
  const networkOut = await makeAccountReader({ fetchImpl: network.impl }).read(accountCapabilityOf('zai-coding-cn'), 'k');
  assert.equal(networkOut.ok, true);
  assert.deepEqual(networkOut.usage.windows.map((w) => w.key), ['7d']);
  assert.equal(network.calls.length, 2);

  const timeout = stubFetch({
    'open.bigmodel.cn': () => { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; },
    'bigmodel.cn/api/monitor': { body: quota },
  });
  const timeoutOut = await makeAccountReader({ fetchImpl: timeout.impl }).read(accountCapabilityOf('zai-coding-cn'), 'k');
  assert.equal(timeoutOut.ok, true);
  assert.deepEqual(timeoutOut.usage.windows.map((w) => w.key), ['7d']);
  assert.equal(timeout.calls.length, 2);

  const bothNetwork = stubFetch({
    'open.bigmodel.cn': () => { throw new TypeError('connect ECONNREFUSED'); },
    'bigmodel.cn/api/monitor': () => { throw new TypeError('connect ECONNREFUSED'); },
  });
  const bothNetworkOut = await makeAccountReader({ fetchImpl: bothNetwork.impl }).read(accountCapabilityOf('zai-coding-cn'), 'k');
  assert.equal(bothNetworkOut.code, 'network');
  assert.equal(bothNetwork.calls.length, 2);

  const bothTimeout = stubFetch({
    'open.bigmodel.cn': () => { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; },
    'bigmodel.cn/api/monitor': () => { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; },
  });
  const bothTimeoutOut = await makeAccountReader({ fetchImpl: bothTimeout.impl }).read(accountCapabilityOf('zai-coding-cn'), 'k');
  assert.equal(bothTimeoutOut.code, 'timeout');
  assert.equal(bothTimeout.calls.length, 2);
});

test('取数：GLM Coding Plan noPlan 不被 fallback 的认证错误覆盖', async () => {
  const { impl, calls } = stubFetch({
    'open.bigmodel.cn': { body: { code: 400, msg: '当前用户不存在 Coding Plan', success: false } },
    'bigmodel.cn/api/monitor': { status: 401, body: { code: 401, msg: '令牌已过期或失效', success: false } },
  });
  const out = await makeAccountReader({ fetchImpl: impl }).read(accountCapabilityOf('zai-coding-cn'), 'k');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'noPlan');
  assert.equal(calls.length, 1, 'noPlan 是账号级结论，不再请求 fallback');
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
  let timeoutCalls = 0;
  const timeoutReader = makeAccountReader({ fetchImpl: async () => { timeoutCalls++; const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; } });
  const timed = await timeoutReader.read(accountCapabilityOf('moonshotai'), 'sk');
  assert.equal(timed.code, 'timeout');
  assert.equal(timeoutCalls, 1, '未声明网络回落的能力不尝试第二个 host');

  let networkCalls = 0;
  const networkReader = makeAccountReader({ fetchImpl: async () => { networkCalls++; throw new Error('connect ECONNREFUSED'); } });
  const net = await networkReader.read(accountCapabilityOf('moonshotai'), 'sk');
  assert.equal(net.code, 'network');
  assert.equal(networkCalls, 1, '未声明网络回落的能力不尝试第二个 host');
});

test('取数：超限响应体按 shape 处理', async () => {
  const reader = makeAccountReader({
    fetchImpl: async () => new Response('x'.repeat(70 * 1024), { status: 200, headers: { 'content-type': 'text/plain' } }),
  });
  const out = await reader.read(accountCapabilityOf('moonshotai'), 'sk');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'shape');
});
