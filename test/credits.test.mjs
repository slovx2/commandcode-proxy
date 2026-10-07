// 额度端点：/v1/cc/credits（原样透传 CC credits）与 /v1/user/balance
// （合成 DeepSeek 按量付费余额形状，供网关的余额探测消费）。
//
// 契约：
//   - 两个端点都用「调用方带来的 key」去查 CC，代理侧不存凭据；
//   - 缺 key → 401；上游 401/403 原样透传；其余上游异常 → 502；
//     任何失败都不得返回“余额看起来正常”的假数据；
//   - 余额 = monthlyCredits + purchasedCredits + freeCredits（USD）；
//   - is_available=false 当窗口打满（windowLimits.exceeded / fiveHour / weekly）
//     或 belowThreshold=true —— 下游据此停调该账号；
//   - base_url 带不带 /v1 都能命中（/v1/user/balance 与 /user/balance）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };

/** 造一个只回额度 JSON 的 mock 上游；creditsBody/status 可定制。 */
function creditsUpstream({ body, status = 200 } = {}) {
  const payload = body ?? {
    credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 9.5, purchasedCredits: 0.4, freeCredits: 0.076708 },
    windowLimits: {
      limited: true,
      exceeded: null,
      fiveHour: { used: 0.02, cap: 3, exceeded: false, resetAt: 1789669097956 },
      weekly: { used: 0.02, cap: 6, exceeded: false, resetAt: 1790255897956 },
    },
  };
  return {
    onRequest: (req, res) => {
      if (req.url === '/alpha/billing/credits') {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(status === 200 ? JSON.stringify(payload) : JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED' } }));
      }
      // 其余路径（fingerprint/lifecycle）落到默认处理
    },
  };
}

async function getBalance(s, path = '/v1/user/balance', headers = AUTH) {
  const r = await s.proxy.get(path, { headers });
  return { status: r.status, json: await r.json() };
}

test('额度：/v1/user/balance 合成 DeepSeek 余额形状（各来源求和）', async () => {
  const s = await setup(creditsUpstream());
  try {
    const { status, json } = await getBalance(s);
    assert.equal(status, 200);
    assert.equal(json.is_available, true);
    assert.deepEqual(json.balance_infos, [{ currency: 'USD', total_balance: 9.976708 }]);
  } finally { await s.close(); }
});

test('额度：base_url 不带 /v1 时 /user/balance 同样可用', async () => {
  const s = await setup(creditsUpstream());
  try {
    const { status, json } = await getBalance(s, '/user/balance');
    assert.equal(status, 200);
    assert.equal(json.balance_infos[0].currency, 'USD');
  } finally { await s.close(); }
});

test('额度：窗口打满 → is_available=false（下游据此停调）', async () => {
  const s = await setup(creditsUpstream({
    body: {
      credits: { monthlyCredits: 9.5, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: { exceeded: false, fiveHour: { used: 3, cap: 3, exceeded: true }, weekly: { used: 1, cap: 6, exceeded: false } },
    },
  }));
  try {
    const { json } = await getBalance(s);
    assert.equal(json.is_available, false, '5h 窗口打满必须报不可用');
    assert.equal(json.balance_infos[0].total_balance, 9.5, '余额仍然如实上报');
  } finally { await s.close(); }
});

test('额度：belowThreshold=true → is_available=false', async () => {
  const s = await setup(creditsUpstream({
    body: { credits: { monthlyCredits: 0.1, purchasedCredits: 0, freeCredits: 0, belowThreshold: true }, windowLimits: {} },
  }));
  try {
    const { json } = await getBalance(s);
    assert.equal(json.is_available, false);
  } finally { await s.close(); }
});

test('额度：缺 key → 401，不去打上游', async () => {
  const s = await setup(creditsUpstream());
  try {
    const r = await s.proxy.get('/v1/user/balance');
    assert.equal(r.status, 401);
    assert.equal(s.mock.seen.filter(x => x.url === '/alpha/billing/credits').length, 0);
  } finally { await s.close(); }
});

test('额度：上游 401 原样透传，不伪造余额', async () => {
  const s = await setup(creditsUpstream({ status: 401 }));
  try {
    const { status, json } = await getBalance(s);
    assert.equal(status, 401);
    assert.equal(json.is_available, undefined);
  } finally { await s.close(); }
});

test('额度：上游 5xx → 502，不伪造余额', async () => {
  const s = await setup(creditsUpstream({ status: 500 }));
  try {
    const { status, json } = await getBalance(s);
    assert.equal(status, 502);
    assert.equal(json.balance_infos, undefined);
  } finally { await s.close(); }
});

test('额度：/v1/cc/credits 原样透传 CC JSON（含窗口与重置时间）', async () => {
  const s = await setup(creditsUpstream());
  try {
    const r = await s.proxy.get('/v1/cc/credits', { headers: AUTH });
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.credits.monthlyCredits, 9.5);
    assert.equal(json.windowLimits.fiveHour.cap, 3);
    assert.ok(json.windowLimits.fiveHour.resetAt);
  } finally { await s.close(); }
});

test('额度：查询上游时带上调用方的 key 与 CLI 版本头', async () => {
  const s = await setup(creditsUpstream());
  try {
    await getBalance(s);
    const hit = s.mock.seen.find(x => x.url === '/alpha/billing/credits');
    assert.ok(hit, '必须请求 CC 的 credits 端点');
    assert.equal(hit.headers.authorization, 'Bearer user_test');
    assert.ok(hit.headers['x-command-code-version'], '带上 CLI 版本头，与 generate 路径保持一致');
  } finally { await s.close(); }
});

// ── 通用「用量窗口」规范：/v1/usage/windows ──

test('窗口：/v1/usage/windows 返回总额度 + 5h/weekly 两档（含百分比与重置时间）', async () => {
  const s = await setup(creditsUpstream({
    body: {
      credits: { monthlyCredits: 9, purchasedCredits: 0.5, freeCredits: 0.25 },
      windowLimits: {
        fiveHour: { used: 0.75, cap: 3, exceeded: false, resetAt: 1789669097956 },
        weekly: { used: 3, cap: 6, exceeded: false, resetAt: 1790255897956 },
      },
    },
  }));
  try {
    const r = await s.proxy.get('/v1/usage/windows', { headers: AUTH });
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.object, 'usage_windows');
    assert.equal(json.is_available, true);
    assert.equal(json.balance.currency, 'USD');
    assert.equal(json.balance.total, 9.75, '总额度 = 月度 + 购买 + 赠送');
    assert.deepEqual(json.windows.map(w => w.window), ['5h', 'weekly']);
    const [five, weekly] = json.windows;
    assert.equal(five.used_percent, 25, '0.75/3 → 25%');
    assert.equal(weekly.used_percent, 50, '3/6 → 50%');
    assert.match(five.reset_at, /^\d{4}-\d{2}-\d{2}T.*Z$/, 'reset_at 必须是 RFC3339');
  } finally { await s.close(); }
});

test('窗口：窗口打满 → is_available=false（下游可据此停调）', async () => {
  const s = await setup(creditsUpstream({
    body: {
      credits: { monthlyCredits: 9, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: { fiveHour: { used: 3, cap: 3, exceeded: true }, weekly: { used: 1, cap: 6, exceeded: false } },
    },
  }));
  try {
    const json = await (await s.proxy.get('/v1/usage/windows', { headers: AUTH })).json();
    assert.equal(json.is_available, false);
    assert.equal(json.windows[0].used_percent, 100);
  } finally { await s.close(); }
});

test('窗口：base_url 不带 /v1 时 /usage/windows 同样可用', async () => {
  const s = await setup(creditsUpstream());
  try {
    const r = await s.proxy.get('/usage/windows', { headers: AUTH });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).object, 'usage_windows');
  } finally { await s.close(); }
});

test('窗口：上游返回 404 时按规范回 404（下游隐藏窗口，不报错）', async () => {
  const s = await setup(creditsUpstream({ status: 404 }));
  try {
    const r = await s.proxy.get('/v1/usage/windows', { headers: AUTH });
    assert.equal(r.status, 404);
    const json = await r.json();
    assert.equal(json.error.type, 'unsupported');
    assert.equal(json.windows, undefined, '不得伪造窗口数据');
  } finally { await s.close(); }
});
