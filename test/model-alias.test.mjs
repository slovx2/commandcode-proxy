// 模型名解析（写死，零配置）：把官方风格的裸名翻译成 CC 目录里的精确 ID。
// 目标场景：下游只需要写 deepseek-flash，不必知道 CC 目录里的 vendor 前缀。
//
// 契约（与 proxy.mjs 的 resolveBuiltinModelId 一致）：
//   - 含 "/" 的名字视为目录 ID，原样透传；
//   - 命中内置表（大小写/首尾空白归一）→ 用表里的精确 ID；
//   - 未命中且不含 "/" → 按同族 vendor 前缀补全（只补前缀，不改模型段大小写）；
//   - 其余原样（表外的名字行为与加这层之前完全一致）；
//   - 只改发往上游的 model，响应回显仍是客户端请求的名字。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };

async function wireModel(s, path, body, headers = AUTH) {
  const r = await s.proxy.post(path, body, headers);
  const json = await r.json();
  return { status: r.status, json, wire: s.mock.lastGenerate()?.body?.params?.model };
}

const chat = (model) => ({ model, messages: [{ role: 'user', content: 'hi' }] });

// ── ① 三个协议入口共用同一套解析（都经由 buildCcRequest）──

test('解析：chat/completions 用目录 ID 发上游，响应回显客户端名', async () => {
  const s = await setup();
  try {
    const { json, wire } = await wireModel(s, '/v1/chat/completions', chat('deepseek-flash'));
    assert.equal(wire, 'deepseek/deepseek-v4.1-flash', 'deepseek-flash 按官方现行名补成 4.1');
    assert.equal(json.model, 'deepseek-flash', '响应必须回显客户端请求的名字');
  } finally { await s.close(); }
});

test('解析：Anthropic /v1/messages 同样生效', async () => {
  const s = await setup();
  try {
    const { json, wire } = await wireModel(s, '/v1/messages',
      { model: 'deepseek-flash', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      { 'x-api-key': 'user_test' });
    assert.equal(wire, 'deepseek/deepseek-v4.1-flash');
    assert.equal(json.model, 'deepseek-flash');
  } finally { await s.close(); }
});

test('解析：Responses /v1/responses 同样生效', async () => {
  const s = await setup();
  try {
    const { json, wire } = await wireModel(s, '/v1/responses', { model: 'deepseek-flash', input: 'hi' });
    assert.equal(wire, 'deepseek/deepseek-v4.1-flash');
    assert.equal(json.model, 'deepseek-flash');
  } finally { await s.close(); }
});

// ── ② 内置表：精确映射（含大小写/空白归一）──

test('解析：内置表条目逐一映射（deepseek 旧名保留自身目录 ID）', async () => {
  const s = await setup();
  try {
    for (const [input, expected] of [
      ['deepseek-flash', 'deepseek/deepseek-v4.1-flash'],
      ['deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash'],
      ['deepseek-v4-flash', 'deepseek/deepseek-v4-flash'],
      ['deepseek-v4-flash-fast', 'deepseek/deepseek-v4-flash-fast'],
      ['deepseek-v4-pro', 'deepseek/deepseek-v4-pro'],
      ['kimi-k2.6', 'moonshotai/Kimi-K2.6'],
      ['glm-5.1', 'zai-org/GLM-5.1'],
      ['minimax-m3', 'MiniMaxAI/MiniMax-M3'],
      ['grok-4.6', 'xai/grok-4.6'],
      ['gemini-3.5-flash', 'google/gemini-3.5-flash'],
      ['mimo-v2.5', 'xiaomi/mimo-v2.5'],
    ]) {
      const { wire } = await wireModel(s, '/v1/chat/completions', chat(input));
      assert.equal(wire, expected, `${input} 应映射为 ${expected}`);
    }
  } finally { await s.close(); }
});

test('解析：大小写与首尾空白归一后仍命中内置表', async () => {
  const s = await setup();
  try {
    for (const [input, expected] of [
      ['DeepSeek-Flash', 'deepseek/deepseek-v4.1-flash'],
      ['  deepseek-flash  ', 'deepseek/deepseek-v4.1-flash'],
      ['KIMI-K2.6', 'moonshotai/Kimi-K2.6'],
    ]) {
      const { wire } = await wireModel(s, '/v1/chat/completions', chat(input));
      assert.equal(wire, expected, `${JSON.stringify(input)} 归一后应命中内置表`);
    }
  } finally { await s.close(); }
});

// ── ③ 同族前缀兜底：表外的新模型也能用 ──

test('解析：同族新模型按 vendor 前缀补全', async () => {
  const s = await setup();
  try {
    for (const [input, expected] of [
      ['deepseek-v4.5-pro', 'deepseek/deepseek-v4.5-pro'],
      ['kimi-k3', 'moonshotai/kimi-k3'],
      ['glm-6', 'zai-org/glm-6'],
      ['step-4-flash', 'stepfun/step-4-flash'],
    ]) {
      const { wire } = await wireModel(s, '/v1/chat/completions', chat(input));
      assert.equal(wire, expected, `${input} 应补 vendor 前缀`);
    }
  } finally { await s.close(); }
});

// ── ④ 不得误伤：已带前缀的名字与 CC 目录里的裸名原样透传 ──

test('解析：含 "/" 的名字（已是目录 ID）原样透传', async () => {
  const s = await setup();
  try {
    for (const input of ['deepseek/deepseek-v4.1-flash', 'moonshotai/Kimi-K2.6', 'Qwen/Qwen3.7-Max']) {
      const { wire } = await wireModel(s, '/v1/chat/completions', chat(input));
      assert.equal(wire, input, '目录 ID 不应被二次改写');
    }
  } finally { await s.close(); }
});

test('解析：claude-* / gpt-* 在 CC 目录里本就是裸名，不得补前缀', async () => {
  const s = await setup();
  try {
    for (const input of ['claude-sonnet-4-6', 'gpt-5.5', 'gpt-5.3-codex']) {
      const { wire } = await wireModel(s, '/v1/chat/completions', chat(input));
      assert.equal(wire, input);
    }
  } finally { await s.close(); }
});

test('解析：表外且不属前缀族的名字原样透传', async () => {
  const s = await setup();
  try {
    for (const input of ['llama-3.3-70b', 'my-custom-model']) {
      const { wire } = await wireModel(s, '/v1/chat/completions', chat(input));
      assert.equal(wire, input, '不认识的模型名必须原样透传，行为与加这层之前一致');
    }
  } finally { await s.close(); }
});

test('解析：原型链键名不会被误当作表内条目', async () => {
  const s = await setup();
  try {
    for (const input of ['constructor', '__proto__', 'toString']) {
      const { wire } = await wireModel(s, '/v1/chat/completions', chat(input));
      assert.equal(wire, input, `${input} 不在表里，必须原样透传`);
    }
  } finally { await s.close(); }
});
