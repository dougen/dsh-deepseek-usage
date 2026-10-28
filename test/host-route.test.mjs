// 宿主侧路由的确定性断言：信任围栏、错误文案不外泄、余额缺失不伪装成 0。
// `@deepseek-ai/dsh-credentials` 不在本地安装，用 loader 钩子给它一个桩。
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const CREDENTIALS_STUB = `
export function credentialRef(name) { return { kind: 'credential-ref', name }; }
export default { credentialRef };
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-credentials') {
      return { url: 'data:text/javascript,' + encodeURIComponent(CREDENTIALS_STUB), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { apply } = await import('../lib/index.js');

/**
 * 默认的 fetch 桩：返回一份正常余额。所有会打上游的用例都靠它，
 * 测试不联网（"回环地址的各种写法都被接受" 那个用例原本会真的打一次
 * api.deepseek.com）。
 *
 * 按 URL 分派：多提供商之后不同 provider 打不同端点，测试要能分别桩掉。
 * `routes` 的键是 URL 子串，值是响应体或 (url, init) => Response。
 * 上游调用同时记进 upstreamCalls，缓存分桶断言用它。
 */
let fetchRoutes = {};
let upstreamCalls = [];

const defaultFetch = async () => new Response(JSON.stringify({
  is_available: true,
  balance_infos: [{ total_balance: '12.34', currency: 'CNY' }],
}), { status: 200, headers: { 'content-type': 'application/json' } });

/** 分派桩：命中 routes 的用它的响应，否则回落默认余额。 */
const dispatchFetch = async (url, init) => {
  upstreamCalls.push(String(url));
  const key = Object.keys(fetchRoutes).find((k) => String(url).includes(k));
  if (key === undefined) return defaultFetch(url, init);
  const route = fetchRoutes[key];
  return typeof route === 'function' ? route(url, init) : route;
};

globalThis.fetch = dispatchFetch;
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; });

/**
 * 清掉路由表与调用记录，并把分派桩装回 globalThis.fetch。
 *
 * 既有用例在自己的 try/finally 里把 fetch 换成一次性桩再恢复 originalFetch；
 * 恢复后它仍是 dispatchFetch，但为防某个用例漏了 finally，这里显式装回。
 */
function resetFetch() {
  fetchRoutes = {};
  upstreamCalls = [];
  globalThis.fetch = dispatchFetch;
}

/** 造一个最小的 ctx：记录注册进来的路由，可注入凭据与取价。 */
let keySeq = 0;
function makeCtx(options = {}) {
  const routes = new Map();
  // 每个 ctx 用不同的 Key：宿主按 Key 值缓存账户快照，测试之间不能互相命中。
  keySeq += 1;
  const key = options.key === undefined ? `sk-test-${keySeq}` : options.key;
  const ctx = {
    logger: { warn() {} },
    credentials: {
      resolve: async (ref) => {
        // 引用名取自 options.refs（缺省只认 DEEPSEEK_API_KEY），
        // 让测试能为不同 provider 配不同密钥。
        const name = ref && typeof ref === 'object' && 'name' in ref ? ref.name : String(ref);
        const value = options.refs ? options.refs[name] : (name === 'DEEPSEEK_API_KEY' ? key : undefined);
        return value === undefined || value === null ? undefined : { value };
      },
      set: async () => {},
      unset: async () => {},
    },
    get(name) {
      if (name === 'agentDefaultModel') {
        return {
          currentSelection: () => ({
            provider: options.provider ?? 'deepseek-official',
            model: options.model ?? 'deepseek-flash',
          }),
        };
      }
      if (name === 'llm') {
        return {
          listProviders: () => (options.registered ?? [{ id: 'deepseek-official', name: 'DeepSeek' }]),
          listConfigurableProviders: () => (options.declared ?? []),
        };
      }
      return undefined;
    },
    effect(fn) {
      fn();
      return () => {};
    },
    webServer: {
      host: options.bindHost ?? '127.0.0.1',
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
  return { ctx, routes };
}

/** 造一个最小的 req/res。 */
function makeReq(headers = {}, url = '/api/deepseek-usage?lang=zh', method = 'GET') {
  return { headers, url, method };
}

/**
 * 造一个 POST /token 请求。宿主的 readBoundedText 需要 Response 形态
 * （headers.get + text），所以用真的 Response 提供这两样，再补上
 * req 的 method / url / headers。
 */
function makePost(payload, headers = {}) {
  const text = JSON.stringify(payload);
  const response = new Response(text, { headers: { 'content-type': 'application/json', ...headers } });
  return {
    method: 'POST',
    url: '/api/deepseek-usage/token',
    headers: {
      host: '127.0.0.1:64452',
      'content-type': 'application/json',
      ...headers,
      get: (name) => response.headers.get(name),
    },
    text: async () => text,
  };
}

function makeRes() {
  const res = {
    statusCode: 0,
    headersSent: false,
    body: undefined,
    writeHead(status) { res.statusCode = status; res.headersSent = true; },
    end(chunk) { res.body = chunk; },
  };
  return res;
}

async function call(route, req) {
  const res = makeRes();
  await route.handler(req, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

test('非 GET 方法被拒绝', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage'), makeReq({}, '/api/deepseek-usage', 'POST'));
  assert.equal(res.status, 405);
});

test('非本机 Host 被拒绝', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  for (const host of ['evil.example:64452', '10.0.0.7:64452']) {
    const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host }));
    assert.equal(res.status, 403, `${host} 应被拒绝`);
  }
});

test('回环地址的各种写法都被接受', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  for (const host of ['127.0.0.1:64452', '127.0.0.2:64452', 'localhost:64452', '[::1]:64452', '[::ffff:127.0.0.1]:64452']) {
    const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host }));
    assert.notEqual(res.status, 403, `${host} 应被接受`);
  }
});

test('监听器绑定的地址也被接受（--host 部署）', async () => {
  const { ctx, routes } = makeCtx({ bindHost: '10.0.0.7' });
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '10.0.0.7:64452' }));
  assert.notEqual(res.status, 403);
});

test('绑定地址是 IPv6 时同样认得出来', async () => {
  const { ctx, routes } = makeCtx({ bindHost: '::1' });
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '[::1]:64452' }));
  assert.notEqual(res.status, 403);
});

test('跨站请求与异源 Origin 被拒绝', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const route = routes.get('/api/deepseek-usage');
  const crossSite = await call(route, makeReq({ host: '127.0.0.1:64452', 'sec-fetch-site': 'cross-site' }));
  assert.equal(crossSite.status, 403);
  const foreignOrigin = await call(route, makeReq({ host: '127.0.0.1:64452', origin: 'http://evil.example' }));
  assert.equal(foreignOrigin.status, 403);
  const sameOrigin = await call(route, makeReq({ host: '127.0.0.1:64452', origin: 'http://127.0.0.1:64452' }));
  assert.notEqual(sameOrigin.status, 403);
});

test('未配置 Key 时只给出可行动的文案', async () => {
  const { ctx, routes } = makeCtx({ key: null });
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.errors, ['未配置 DEEPSEEK_API_KEY']);
  assert.equal(res.body.balance.total, null, '没有余额时是 null，不是 0');
});

test('Key 含非法字符时不把 Key 写进响应', async () => {
  const { ctx, routes } = makeCtx({ key: 'sk-live\nsecond-line' });
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.errors.length, 1);
  assert.ok(!JSON.stringify(res.body).includes('sk-live'), '响应里不得出现 Key');
  assert.ok(!JSON.stringify(res.body).includes('second-line'), '响应里不得出现 Key 的其余部分');
});

test('上游异常不会把异常原文送到浏览器', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED 10.0.0.7:443 (internal)'); };
  try {
    const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.errors, ['余额接口无法连接']);
    assert.ok(!JSON.stringify(res.body).includes('10.0.0.7'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('余额单飞按 Key 分桶：换 Key 不会复用旧 Key 的在途请求', async () => {
  // 第一次请求用 sk-A 并挂起（模拟慢响应）；期间凭据换成 sk-B，
  // 第二个请求必须发自己的上游调用，而不是复用 sk-A 的在途 promise。
  let holdFirst = true;
  globalThis.fetch = async () => {
    if (holdFirst) {
      holdFirst = false;
      return new Promise(() => {}); // 永不返回：模拟慢响应
    }
    return new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{ total_balance: '99.99', currency: 'CNY' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let currentKey = 'sk-A';
  const { ctx, routes } = makeCtx();
  ctx.credentials.resolve = async () => ({ value: currentKey });
  apply(ctx);
  const route = routes.get('/api/deepseek-usage');

  void call(route, makeReq({ host: '127.0.0.1:64452' })); // 挂起，不等它
  currentKey = 'sk-B';
  const second = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(second.body.balance.total, 99.99, '换 Key 后必须拿到新 Key 的余额');
});

test('放假日期表过期时宿主会告警（每天一次）', async () => {
  const warnings = [];
  const { ctx, routes } = makeCtx();
  ctx.logger = { warn: (m) => warnings.push(String(m)) };
  apply(ctx);

  // 表覆盖当年时不该告警。
  await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(warnings.filter((w) => w.includes('放假日期表未覆盖')).length, 0, '表覆盖当年时不应告警');

  // 把时钟拨到 2027：表还没覆盖那一年，必须告警，且文案要指出该改哪个常量。
  const realNow = Date.now;
  Date.now = () => realNow.call(Date) + 400 * 86400000; // 往后推 400 天
  try {
    await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
    const warns = warnings.filter((w) => w.includes('放假日期表未覆盖'));
    assert.equal(warns.length, 1, '表未覆盖当年时必须告警一次');
    assert.ok(warns[0].includes('HOLIDAY_TABLE_THROUGH_YEAR'), `告警文案应指出要改的常量，实际：${warns[0]}`);
  } finally {
    Date.now = realNow;
  }
});

test('宿主内部异常时返回 502，且不把异常原文送进响应', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  // 让 handler 内部抛异常，落到最外层的 catch（502 路径）。
  const realNow = Date.now;
  Date.now = () => { throw new Error('内部故障 sk-live-SECRET-KEY 片段'); };
  try {
    const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
    assert.equal(res.status, 502);
    assert.equal(res.body.message, '插件内部错误');
    assert.ok(!JSON.stringify(res.body).includes('SECRET'), '502 响应里不得出现异常原文');
  } finally {
    Date.now = realNow;
  }
});

test('余额缓存按 Key 分桶：换 Key 后不会命中旧 Key 的缓存', async () => {
  const upstream = [];
  globalThis.fetch = async () => {
    upstream.push('call');
    return new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{ total_balance: upstream.length === 1 ? '11.11' : '99.99', currency: 'CNY' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let currentKey = 'sk-cache-A';
  const { ctx, routes } = makeCtx();
  ctx.credentials.resolve = async () => ({ value: currentKey });
  apply(ctx);
  const route = routes.get('/api/deepseek-usage');

  const first = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(first.body.balance.total, 11.11);

  // 同一个 Key 再问：命中缓存，不再打上游。
  const again = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(again.body.balance.total, 11.11);
  assert.equal(upstream.length, 1, '同一个 Key 的第二次请求应命中缓存');

  // 换 Key：不能命中旧 Key 的缓存，必须打自己的上游调用。
  currentKey = 'sk-cache-B';
  const other = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(other.body.balance.total, 99.99, '换 Key 后必须拿到新 Key 的余额');
  assert.equal(upstream.length, 2, '换 Key 后必须重新打上游');
});

test('余额缺失时报错而不是伪装成 0 元', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ is_available: true, balance_infos: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
    assert.equal(res.body.balance.total, null, 'total 必须是 null');
    assert.deepEqual(res.body.errors, ['余额接口没有返回余额']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('响应体超限时按"无法解析"处理，不当成网络故障', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('x'.repeat(70 * 1024), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
    assert.deepEqual(res.body.errors, ['余额接口返回了无法解析的内容']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('账户不可用时给出可行动的文案', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    is_available: false,
    balance_infos: [{ total_balance: '1.00', currency: 'CNY' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
    assert.deepEqual(res.body.errors, ['账户当前不可用']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('官方路由上的模型给单价，第三方路由上的模型不给', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    is_available: true,
    balance_infos: [{ total_balance: '12.34', currency: 'CNY' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const official = makeCtx({ provider: 'deepseek-official', model: 'deepseek-flash' });
    apply(official.ctx);
    const a = await call(official.routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
    assert.equal(a.body.tier.known, true);
    // 单价随峰谷时段变化（高峰 2 / 空闲 1），断言"是表里的数"而不是某个具体值。
    assert.ok([1, 2].includes(a.body.tier.input), `单价应来自价格表，实际 ${a.body.tier.input}`);
    assert.equal(a.body.tier.model, 'deepseek-flash');

    const router = makeCtx({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' });
    apply(router.ctx);
    const b = await call(router.routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
    assert.equal(b.body.tier.known, false, '第三方路由的模型不该计价');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('假期路由也只接受本机来源', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const route = routes.get('/api/deepseek-usage/holidays');
  const ok = await call(route, makeReq({ host: '127.0.0.1:64452' }, '/api/deepseek-usage/holidays'));
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body.ranges));
  const denied = await call(route, makeReq({ host: 'evil.example' }, '/api/deepseek-usage/holidays'));
  assert.equal(denied.status, 403);
});

// ---- 多提供商账户 ---------------------------------------------------------

test('当前 provider 是 moonshotai 时返回 moonshot 余额，不是 DeepSeek 的', async () => {
  resetFetch();
  fetchRoutes = {
    'moonshot.ai/v1/users/me/balance': new Response(JSON.stringify({
      code: 0,
      data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  };
  const { ctx, routes } = makeCtx({
    provider: 'moonshotai',
    refs: { MOONSHOT_API_KEY: 'sk-moonshot' },
  });
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(res.status, 200);
  assert.equal(res.body.provider.id, 'moonshotai');
  assert.equal(res.body.provider.kind, 'balance');
  assert.equal(res.body.balance.total, 49.58894);
  assert.equal(res.body.balance.currency, 'USD');
  assert.deepEqual(res.body.errors, []);
});

test('订阅制 provider 返回最紧窗口的百分比，不返回余额', async () => {
  resetFetch();
  fetchRoutes = {
    'opencode.ai/zen/go/v1/usage': new Response(JSON.stringify({
      usage: {
        rolling: { status: 'ok', percent: 4, resetsAt: '2026-08-13T16:00:00.000Z' },
        weekly: { status: 'ok', percent: 34 },
        monthly: { status: 'ok', percent: 12 },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  };
  const { ctx, routes } = makeCtx({
    provider: 'opencode',
    refs: { OPENCODE_API_KEY: 'sk-oc' },
  });
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(res.body.provider.kind, 'usage');
  assert.equal(res.body.balance.total, null, '订阅制没有余额，必须是 null 而不是 0');
  assert.equal(res.body.usage.windows.length, 3);
  assert.equal(res.body.usage.windows[1].percent, 34, '周窗口是三者里最紧的');
  assert.deepEqual(res.body.errors, []);
});

test('订阅制路由上的 DeepSeek 模型：仍返回峰谷时段，但 known=false 不显示单价', async () => {
  resetFetch();
  fetchRoutes = {
    'opencode.ai/zen/go/v1/usage': new Response(JSON.stringify({
      usage: {
        rolling: { status: 'ok', percent: 12 },
        weekly: { status: 'ok', percent: 34 },
        monthly: { status: 'ok', percent: 56 },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  };
  const { ctx, routes } = makeCtx({
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    refs: { OPENCODE_GO_API_KEY: 'sk-oc-go' },
  });
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(res.body.provider.kind, 'usage');
  assert.equal(res.body.tier.known, false, '订阅制不走按 token 计价');
  assert.ok(res.body.tier.window === 'peak' || res.body.tier.window === 'idle', '仍应给出峰谷时段');
  assert.equal(res.body.peak, res.body.tier.window === 'peak');
  assert.ok(Number.isFinite(res.body.next.at), '应给出下一次峰谷切换时刻');
  assert.ok(res.body.next.at > Date.now(), '切换时刻必须在将来');
});

test('订阅制路由上的非 DeepSeek 模型：不虚构峰谷时段', async () => {
  resetFetch();
  fetchRoutes = {
    'opencode.ai/zen/go/v1/usage': new Response(JSON.stringify({
      usage: { rolling: { status: 'ok', percent: 12 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  };
  const { ctx, routes } = makeCtx({
    provider: 'opencode-go',
    model: 'minimax-m3',
    refs: { OPENCODE_GO_API_KEY: 'sk-oc-go' },
  });
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(res.body.tier.window, null);
  assert.equal(res.body.next.at, null);
});

test('provider 没有可查接口时卡片置空并说明原因，不显示任何数字', async () => {
  resetFetch();
  const { ctx, routes } = makeCtx({ provider: 'google' });
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(res.body.provider.kind, 'none');
  assert.equal(res.body.provider.reason, 'cloudAuthOnly');
  assert.equal(res.body.balance.total, null);
  assert.equal(res.body.usage, null);
  assert.equal(res.body.errors.length, 1);
  // 未在目录里声明时显示名就是路由 id 本身，所以是 `google` 而不是 `Google`。
  assert.match(res.body.errors[0], /当前插件不支持 google/);
  assert.equal(upstreamCalls.length, 0, '不可查的 provider 不该打任何上游');
});

test('未配密钥时文案点名该配的引用', async () => {
  resetFetch();
  const { ctx, routes } = makeCtx({ provider: 'moonshotai', refs: {} });
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(res.body.balance.total, null);
  assert.deepEqual(res.body.errors, ['未配置 MOONSHOTAI_API_KEY']);
});

test('OAuth provider：未填令牌时提示填写，不猜数字', async () => {
  resetFetch();
  const { ctx, routes } = makeCtx({ provider: 'anthropic', refs: {} });
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(res.body.provider.kind, 'oauth');
  assert.equal(res.body.usage, null);
  assert.deepEqual(res.body.errors, ['尚未填写该提供商的 OAuth 令牌']);
  assert.equal(upstreamCalls.length, 0);
});

test('OAuth provider：填了令牌后按限流头给出 5h/7d', async () => {
  resetFetch();
  fetchRoutes = {
    '/api/oauth/usage': new Response('{}', { status: 403 }),
    '/v1/messages': new Response('{}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-5h-utilization': '0.33',
        'anthropic-ratelimit-unified-5h-reset': '1789882800',
        'anthropic-ratelimit-unified-7d-utilization': '0.13',
      },
    }),
  };
  const { ctx, routes } = makeCtx({
    provider: 'anthropic',
    refs: { DSH_USAGE_CLAUDE_OAUTH_TOKEN: 'sk-ant-oat01-test' },
  });
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
  assert.deepEqual(res.body.errors, []);
  assert.deepEqual(res.body.usage.windows.map((w) => w.key), ['5h', '7d']);
  assert.equal(res.body.usage.windows[0].percent, 33);
  assert.equal(res.body.usage.windows[0].resetsAt, 1789882800000);
});

test('账户缓存按 provider + Key 分桶：换 provider 不命中旧读数', async () => {
  resetFetch();
  fetchRoutes = {
    'moonshot.ai/v1/users/me/balance': new Response(JSON.stringify({
      code: 0, data: { available_balance: 7 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  };
  const { ctx, routes } = makeCtx({ provider: 'moonshotai', refs: { MOONSHOT_API_KEY: 'sk-a' } });
  apply(ctx);
  const route = routes.get('/api/deepseek-usage');
  const first = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(first.body.balance.total, 7);
  const moonshotCalls = upstreamCalls.length;
  assert.equal(moonshotCalls, 1);

  // 同一个 Key 再问：命中缓存，不再打上游。
  const again = await call(route, makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(again.body.balance.total, 7);
  assert.equal(upstreamCalls.length, moonshotCalls, '缓存窗口内不得重复打上游');
});

test('/accounts?list=1：只回清单、不打上游，状态是待查询', async () => {
  resetFetch();
  const { ctx, routes } = makeCtx({
    provider: 'moonshotai',
    refs: { MOONSHOT_API_KEY: 'sk-list-mode' },
    registered: [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'moonshotai', name: 'Moonshot' }],
    declared: [{ provider: 'moonshotai', displayName: 'Moonshot' }],
  });
  apply(ctx);
  const res = await call(
    routes.get('/api/deepseek-usage/accounts'),
    makeReq({ host: '127.0.0.1:64452' }, '/api/deepseek-usage/accounts?list=1'),
  );
  assert.equal(res.status, 200);
  assert.ok(res.body.accounts.length > 0, '清单必须立刻给出卡片');
  assert.equal(upstreamCalls.length, 0, '清单模式不得打上游');
  for (const item of res.body.accounts) {
    if (item.kind === 'none') continue;
    assert.ok(['pending', 'no-key', 'no-token'].includes(item.status), `${item.id} 的状态应为待查询或未配置，实际 ${item.status}`);
    assert.equal(item.balance, null);
    assert.equal(item.usage, null);
  }
  const moonshot = res.body.accounts.find((a) => a.id === 'moonshotai');
  assert.equal(moonshot.status, 'pending', '已配密钥的应是待查询');
  assert.equal(moonshot.current, true);

  // 完整请求随后把读数补上，卡片不用换位置。
  fetchRoutes = {
    'moonshot.ai/v1/users/me/balance': new Response(JSON.stringify({
      code: 0, data: { available_balance: 8 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  };
  const full = await call(routes.get('/api/deepseek-usage/accounts'), makeReq({ host: '127.0.0.1:64452' }, '/api/deepseek-usage/accounts'));
  const fullMoonshot = full.body.accounts.find((a) => a.id === 'moonshotai');
  assert.equal(fullMoonshot.status, 'ok');
  assert.equal(fullMoonshot.balance.total, 8);
});

test('/accounts：收录规则与排序', async () => {
  resetFetch();
  fetchRoutes = {
    'moonshot.ai/v1/users/me/balance': new Response(JSON.stringify({
      code: 0, data: { available_balance: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  };
  const { ctx, routes } = makeCtx({
    provider: 'workbuddy',
    // 独立的 Key：账户缓存按 Key 分桶，复用前面用例的 Key 会命中它的读数。
    refs: { MOONSHOT_API_KEY: 'sk-accounts-listing' },
    registered: [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'workbuddy', name: 'Workbuddy' }],
    declared: [
      { provider: 'moonshotai', displayName: 'Moonshot' },
      { provider: 'google', displayName: 'Google' },
      { provider: 'workbuddy', displayName: 'Workbuddy' },
    ],
  });
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage/accounts'), makeReq({ host: '127.0.0.1:64452' }, '/api/deepseek-usage/accounts'));
  assert.equal(res.status, 200);
  const ids = res.body.accounts.map((a) => a.id);
  // 当前 provider 排最前。
  assert.equal(ids[0], 'workbuddy');
  assert.equal(res.body.accounts[0].current, true);
  // 受支持的与已配密钥的列出；未配密钥、不受支持、非当前的不列。
  assert.ok(ids.includes('moonshotai'), '已配密钥的应列出');
  assert.ok(ids.includes('deepseek-official'), '受支持的应列出');
  assert.equal(ids.includes('google'), false, '未配密钥且不受支持的不列');

  const moonshot = res.body.accounts.find((a) => a.id === 'moonshotai');
  assert.equal(moonshot.status, 'ok');
  assert.equal(moonshot.balance.total, 5);
  assert.equal(moonshot.kind, 'balance');
  // 引用名可以出现在响应里（它不是机密），用于告诉用户该配哪一个。
  assert.ok(moonshot.refs.includes('MOONSHOT_API_KEY'));

  const workbuddy = res.body.accounts.find((a) => a.id === 'workbuddy');
  assert.equal(workbuddy.kind, 'none');
  assert.equal(workbuddy.reason, 'unsupported');
});

test('/accounts：OAuth 行的令牌状态不回传令牌本身', async () => {
  resetFetch();
  const { ctx, routes } = makeCtx({
    provider: 'anthropic',
    refs: { DSH_USAGE_CLAUDE_OAUTH_TOKEN: 'sk-ant-SECRET-VALUE' },
    registered: [{ id: 'anthropic', name: 'Anthropic' }],
    declared: [{ provider: 'anthropic', displayName: 'Anthropic' }],
  });
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage/accounts'), makeReq({ host: '127.0.0.1:64452' }, '/api/deepseek-usage/accounts'));
  const anthropic = res.body.accounts.find((a) => a.id === 'anthropic');
  assert.equal(anthropic.kind, 'oauth');
  assert.deepEqual(anthropic.token, { configured: true });
  assert.ok(!JSON.stringify(res.body).includes('SECRET'), '响应里不得出现令牌');
  assert.ok(!JSON.stringify(res.body).includes('sk-ant-'), '响应里不得出现令牌');
});

test('/accounts：只在 DSH 里检测到 Claude / Codex 时收录其特征行', async () => {
  resetFetch();
  const declared = [
    { provider: 'moonshotai', displayName: 'Moonshot' },
    { provider: 'anthropic', displayName: 'Anthropic' },
    { provider: 'openai-codex', displayName: 'OpenAI Codex' },
  ];
  // 没有任何一条路由 / 当前选中 —— 两个 OAuth 提供商都不该收录。
  const absent = makeCtx({
    provider: 'moonshotai',
    refs: { MOONSHOT_API_KEY: 'sk-oauth-detect-none' },
    registered: [{ id: 'moonshotai', name: 'Moonshot' }],
    declared,
  });
  apply(absent.ctx);
  const none = await call(absent.routes.get('/api/deepseek-usage/accounts'), makeReq({ host: '127.0.0.1:64452' }, '/api/deepseek-usage/accounts'));
  assert.deepEqual(none.body.accounts.filter((a) => a.kind === 'oauth'), []);

  // 注册了 anthropic 路由 —— 只收录它，Codex 仍不出现。
  const partial = makeCtx({
    provider: 'moonshotai',
    refs: { MOONSHOT_API_KEY: 'sk-oauth-detect-partial' },
    registered: [{ id: 'anthropic', name: 'Anthropic' }],
    declared,
  });
  apply(partial.ctx);
  const some = await call(partial.routes.get('/api/deepseek-usage/accounts'), makeReq({ host: '127.0.0.1:64452' }, '/api/deepseek-usage/accounts'));
  assert.deepEqual(some.body.accounts.filter((a) => a.kind === 'oauth').map((a) => a.id), ['anthropic']);
});

test('/accounts：只接受本机 GET', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const route = routes.get('/api/deepseek-usage/accounts');
  const denied = await call(route, makeReq({ host: 'evil.example' }, '/api/deepseek-usage/accounts'));
  assert.equal(denied.status, 403);
  const post = await call(route, makeReq({}, '/api/deepseek-usage/accounts', 'POST'));
  assert.equal(post.status, 405);
});

test('/token：写入后立即可查，清除后回到未填写', async () => {
  resetFetch();
  const stored = {};
  const { ctx, routes } = makeCtx({
    provider: 'anthropic',
    refs: {},
    registered: [{ id: 'anthropic', name: 'Anthropic' }],
    declared: [{ provider: 'anthropic', displayName: 'Anthropic' }],
  });
  // 让 credentials.set/unset 真的落到 stored，宿主的缓存也要跟着失效。
  ctx.credentials.set = async (ref, value) => { stored[ref.name] = value; };
  ctx.credentials.unset = async (ref) => { delete stored[ref.name]; };
  ctx.credentials.resolve = async (ref) => (stored[ref.name] === undefined ? undefined : { value: stored[ref.name] });
  apply(ctx);
  const tokenRoute = routes.get('/api/deepseek-usage/token');

  // 写之前：未填写。
  const before = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
  assert.deepEqual(before.body.errors, ['尚未填写该提供商的 OAuth 令牌']);

  const written = await call(tokenRoute, makePost({ provider: 'anthropic', token: 'sk-ant-oat01-abc' }));
  assert.equal(written.status, 200);
  assert.equal(written.body.configured, true);
  assert.equal(stored.DSH_USAGE_CLAUDE_OAUTH_TOKEN, 'sk-ant-oat01-abc');
  assert.ok(!JSON.stringify(written.body).includes('sk-ant-oat01-abc'), '响应不得回传令牌');

  const cleared = await call(tokenRoute, makePost({ provider: 'anthropic', token: '' }));
  assert.equal(cleared.body.configured, false);
  assert.equal(stored.DSH_USAGE_CLAUDE_OAUTH_TOKEN, undefined);
});

test('/token：只接受本机 POST 与白名单内的 provider', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const route = routes.get('/api/deepseek-usage/token');
  const denied = await call(route, makeReq({ host: 'evil.example' }, '/api/deepseek-usage/token', 'POST'));
  assert.equal(denied.status, 403);
  const get = await call(route, makeReq({ host: '127.0.0.1:64452' }, '/api/deepseek-usage/token'));
  assert.equal(get.status, 405);
  const unknown = await call(route, makePost({ provider: 'workbuddy', token: 'x' }));
  assert.equal(unknown.status, 400);
  // 含换行的令牌不能进 HTTP 头，直接拒绝而不是把异常原文抛出去。
  const badKey = await call(route, makePost({ provider: 'anthropic', token: 'sk-ant\nsecond-line' }));
  assert.equal(badKey.status, 400);
  assert.ok(!JSON.stringify(badKey.body).includes('sk-ant'), '拒绝响应里不得出现令牌');
});

test('上游异常不会把异常原文送到浏览器（多提供商路径）', async () => {
  resetFetch();
  fetchRoutes = {
    'moonshot.ai': async () => { throw new Error('connect ECONNREFUSED 10.0.0.7:443 (internal)'); },
  };
  // 换一个没用过的 Key：账户缓存按 provider + 引用 + Key 分桶，
  // 复用前一个用例的 Key 会命中它的成功读数。
  const { ctx, routes } = makeCtx({ provider: 'moonshotai', refs: { MOONSHOT_API_KEY: 'sk-network-failure' } });
  apply(ctx);
  const res = await call(routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.errors, ['账户接口无法连接']);
  assert.ok(!JSON.stringify(res.body).includes('10.0.0.7'), '异常原文不得进响应');
});



test('非 DeepSeek provider 的按量计费模型：路由返回单价与计费区间', async () => {
  resetFetch();

  // 全天一价的 provider：有单价、币种，tier.window 为 null，不带倒计时。
  const zai = makeCtx({ provider: 'zai', model: 'glm-4.6' });
  apply(zai.ctx);
  const flat = await call(zai.routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(flat.body.tier.known, true, '表里的模型应计价');
  assert.equal(flat.body.tier.currency, 'USD');
  assert.equal(flat.body.tier.input, 0.6);
  assert.equal(flat.body.tier.window, null, '全天一价时没有区间');
  assert.equal(flat.body.next.at, null);
  assert.equal(flat.body.peak, false);

  // 有分时段计费的 provider：返回当前区间与下一次切换时刻。
  const gateway = makeCtx({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017' });
  apply(gateway.ctx);
  const windowed = await call(gateway.routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(windowed.body.tier.known, true);
  assert.equal(windowed.body.tier.currency, 'USD');
  assert.ok(['peak', 'idle'].includes(windowed.body.tier.window), `应带区间，实际 ${windowed.body.tier.window}`);
  assert.equal(typeof windowed.body.next.at, 'number', '应带下一次切换时刻');
  assert.equal(windowed.body.peak, windowed.body.tier.window === 'peak', 'peak 与区间必须一致');

  // 两块表的模型都查不到时，和以前一样不计价。
  const unknown = makeCtx({ provider: 'zai', model: 'glm-9' });
  apply(unknown.ctx);
  const none = await call(unknown.routes.get('/api/deepseek-usage'), makeReq({ host: '127.0.0.1:64452' }));
  assert.equal(none.body.tier.known, false);
});
