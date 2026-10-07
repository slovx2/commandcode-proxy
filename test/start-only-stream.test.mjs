// 上游只发 start 就断开（无任何输出、无 finish、无 error）：线上大图片请求的真实形态。
// 根因是「上游没有正常走完 finish」，必须与 chat 端点一致报可重试的 502，
// 不能被零输出判定抢先误报成 429 "zero output tokens"（下游会当成限流处理）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
const ANTH = { 'x-api-key': 'user_test' };
const START_ONLY = ['{"type":"start"}'];
const PARTIAL = ['{"type":"start"}', '{"type":"text-start"}', '{"type":"text-delta","text":"partial"}'];

const cases = [
  ['chat 流式', '/v1/chat/completions', { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }, AUTH],
  ['chat 非流式', '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, AUTH],
  ['messages 流式', '/v1/messages', { model: 'm', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }, ANTH],
  ['messages 非流式', '/v1/messages', { model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }, ANTH],
  ['responses 流式', '/v1/responses', { model: 'm', stream: true, input: 'hi' }, AUTH],
  ['responses 非流式', '/v1/responses', { model: 'm', input: 'hi' }, AUTH],
];

for (const [name, path, body, headers] of cases) {
  test(`只有 start 就断开：${name} → 502 upstream_error（不是 429）`, async () => {
    const s = await setup({ ndjson: START_ONLY });
    try {
      const r = await s.proxy.post(path, body, headers);
      const text = await r.text();
      assert.equal(r.status, 502, `应回 502，实际 ${r.status}: ${text.slice(0, 200)}`);
      assert.ok(text.includes('no finish event'), '错误信息要点明根因');
      assert.ok(!text.includes('zero output tokens'), '不能误报成零输出');
      assert.match(s.proxy.logs(), /Upstream stream incomplete .*"reason":"no finish event"/);
    } finally { await s.close(); }
  });
}

test('已写出部分内容后断开：responses 流式 → response.failed，不报 completed', async () => {
  const s = await setup({ ndjson: PARTIAL });
  try {
    const r = await s.proxy.post('/v1/responses', { model: 'm', stream: true, input: 'hi' }, AUTH);
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(text.includes('response.failed'));
    assert.ok(!text.includes('response.completed'));
  } finally { await s.close(); }
});

test('已写出部分内容后断开：messages 流式 → event: error，不发 message_stop', async () => {
  const s = await setup({ ndjson: PARTIAL });
  try {
    const r = await s.proxy.post('/v1/messages',
      { model: 'm', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }, ANTH);
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(text.includes('event: error'));
    assert.ok(!text.includes('event: message_stop'));
  } finally { await s.close(); }
});

test('真正的零输出（有 finish、outputTokens=0）：responses / messages 流式仍回 429', async () => {
  const s = await setup({ ndjson: ['{"type":"start"}', '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":5,"outputTokens":0}}'] });
  try {
    const a = await s.proxy.post('/v1/responses', { model: 'm', stream: true, input: 'hi' }, AUTH);
    assert.equal(a.status, 429);
    await a.text();
    const b = await s.proxy.post('/v1/messages',
      { model: 'm', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }, ANTH);
    assert.equal(b.status, 429);
    await b.text();
  } finally { await s.close(); }
});
