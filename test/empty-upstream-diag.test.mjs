// 零输出诊断日志：上游 200 但没有任何输出时，代理回 429，同时必须留下一条可排查的
// 「形状」日志（事件计数 / finishReason / usage / 请求块计数与长度），且不能带出任何内容。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
const SECRET = 'SECRET_PROMPT_TEXT_9f3a';
const SECRET_TOOL = 'secret_tool_name_7b1c';
const IMAGE = 'data:image/png;base64,' + 'A'.repeat(64);

// 上游只发信号事件 + 0 输出的 finish，外加一行无法解析的垃圾
const EMPTY = [
  '{"type":"start"}',
  '{"type":"start-step"}',
  'not-json-garbage',
  '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":1234,"outputTokens":0,"cachedInputTokens":1000}}',
];

const tools = [{ type: 'function', function: { name: SECRET_TOOL, description: SECRET, parameters: { type: 'object', properties: {} } } }];

const cases = [
  ['chat stream', '/v1/chat/completions', {
    model: 'm', stream: true, tools,
    messages: [{ role: 'system', content: SECRET }, { role: 'user', content: [{ type: 'text', text: SECRET }, { type: 'image_url', image_url: { url: IMAGE } }] }],
  }],
  ['chat non-stream', '/v1/chat/completions', {
    model: 'm', tools, messages: [{ role: 'user', content: SECRET }],
  }],
  ['messages stream', '/v1/messages', {
    model: 'm', max_tokens: 100, stream: true, system: SECRET, messages: [{ role: 'user', content: SECRET }],
  }],
  ['messages non-stream', '/v1/messages', {
    model: 'm', max_tokens: 100, messages: [{ role: 'user', content: SECRET }],
  }],
  ['responses stream', '/v1/responses', {
    model: 'm', stream: true, instructions: SECRET, input: [{ role: 'user', content: SECRET }],
  }],
  ['responses non-stream', '/v1/responses', {
    model: 'm', input: [{ role: 'user', content: SECRET }],
  }],
];

for (const [name, path, body] of cases) {
  test(`零输出诊断：${name} 记录形状日志且不含内容`, async () => {
    const s = await setup({ ndjson: EMPTY });
    try {
      const headers = path === '/v1/messages' ? { 'x-api-key': 'user_test' } : AUTH;
      const r = await s.proxy.post(path, body, headers);
      await r.text();
      // 流式且已开始写出时可能是 200 + 错误事件；未开始时是 429
      if (!body.stream) assert.equal(r.status, 429);

      let line = '';
      for (let i = 0; i < 20 && !line; i++) {
        line = s.proxy.logs().split('\n').find(l => l.includes('Empty upstream response (zero output)')) || '';
        if (!line) await sleep(50);
      }
      assert.ok(line, '必须记录零输出诊断日志');
      const data = JSON.parse(line.slice(line.indexOf('{')));
      assert.equal(data.path, path);
      assert.equal(data.stream, body.stream === true);
      assert.equal(data.upstreamStatus, 200);
      assert.equal(data.upstream.finishReason, 'stop');
      assert.equal(data.upstream.usage.outputTokens, 0);
      assert.equal(data.upstream.usage.inputTokens, 1234);
      assert.equal(data.upstream.unparsedLines, 1);
      assert.equal(data.upstream.eventCounts.finish, 1);
      assert.equal(data.upstream.eventCounts.start, 1);
      assert.ok(data.request.messages >= 1);
      assert.ok(data.request.parts.text >= 1);
      assert.ok(data.request.partChars.text >= SECRET.length);

      const all = s.proxy.logs();
      assert.ok(!all.includes(SECRET), '日志不得包含提示词/消息内容');
      assert.ok(!all.includes(SECRET_TOOL), '日志不得包含工具名');
      assert.ok(!all.includes('AAAAAAAA'), '日志不得包含图片数据');
      assert.ok(!all.includes('user_test'), '日志不得包含 key');
    } finally { await s.close(); }
  });
}

test('零输出诊断：图片按块计数与长度记录', async () => {
  const s = await setup({ ndjson: EMPTY });
  try {
    const r = await s.proxy.post('/v1/chat/completions', {
      model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: IMAGE } }] }],
    }, AUTH);
    await r.text();
    const line = s.proxy.logs().split('\n').find(l => l.includes('Empty upstream response (zero output)'));
    const data = JSON.parse(line.slice(line.indexOf('{')));
    assert.equal(data.request.parts.image, 1);
    assert.equal(data.request.partChars.image, IMAGE.length);
    assert.deepEqual(data.request.lastParts, ['text', 'image']);
  } finally { await s.close(); }
});
