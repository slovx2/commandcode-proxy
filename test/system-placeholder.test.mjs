// 无 system prompt 时的占位（issue #17）：CC 缺省 system 会注入 ~7.5K token 默认提示词，故发占位。
// Anthropic 拒收纯空白 system（400 "text content blocks must contain non-whitespace text"），
// Claude 模型改用非空白的 '.'，其余模型保持空格。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };

async function wireSystem(s, model) {
  const r = await s.proxy.post('/v1/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }] }, AUTH);
  assert.equal(r.status, 200, await r.text());
  return s.mock.lastGenerate().body.params.system;
}

test('占位：claude 模型用非空白占位，其余模型用空格', async () => {
  const s = await setup();
  try {
    assert.deepEqual(await wireSystem(s, 'claude-sonnet-5-5'), [{ type: 'text', text: '.' }]);
    assert.deepEqual(await wireSystem(s, 'deepseek/deepseek-v4-flash'), [{ type: 'text', text: ' ' }]);
  } finally { await s.close(); }
});

test('占位：客户端带 system 时原样发送，不加占位', async () => {
  const s = await setup();
  try {
    const r = await s.proxy.post('/v1/chat/completions', {
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }],
    }, AUTH);
    assert.equal(r.status, 200, await r.text());
    const system = s.mock.lastGenerate().body.params.system;
    assert.ok(JSON.stringify(system).includes('be brief'));
    assert.ok(!system.some(b => b.text === '.' || b.text === ' '));
  } finally { await s.close(); }
});
