// /v1/responses：工具调用与工具结果必须成对落到上游。Chat 上游要求 tool 消息紧跟
// 带同名 tool_calls 的 assistant 回合，孤立的 tool 消息会让整轮 400（"Messages with
// role 'tool' must be a response to a preceding message with 'tool_calls'"），且历史
// 每轮重放、会话从此卡死。断言的是**发到 mock 上游的 CC 请求体**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
const user = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const customCall = (id, name, input) => ({ type: 'custom_tool_call', call_id: id, name, input });
const customOut = (id, output) => ({ type: 'custom_tool_call_output', call_id: id, output });
const fnOut = (id, output) => ({ type: 'function_call_output', call_id: id, output });

async function send(s, input) {
  const r = await s.proxy.post('/v1/responses', { model: 'm', input }, AUTH);
  assert.equal(r.status, 200);
  await r.text();
  return s.mock.lastGenerate().body.params.messages;
}

const toolCallsOf = (msg) => (msg.content || []).filter(c => c && c.type === 'tool-call');
const toolResultsOf = (msg) => (msg.content || []).filter(c => c && c.type === 'tool-result');

test('responses：custom_tool_call 与其输出成对转成 tool-call / tool-result（原实现丢弃调用）', async () => {
  const s = await setup();
  try {
    const msgs = await send(s, [
      user('查一下'),
      customCall('call_1', 'exec', 'await tools.exec_command({cmd:"ls"})'),
      customOut('call_1', [{ type: 'input_text', text: 'ok' }]),
      user('继续'),
    ]);
    assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant', 'tool', 'user']);
    const [call] = toolCallsOf(msgs[1]);
    assert.equal(call.toolCallId, 'call_1');
    assert.equal(call.toolName, 'exec');
    assert.deepEqual(call.input, { input: 'await tools.exec_command({cmd:"ls"})' });
    const [result] = toolResultsOf(msgs[2]);
    assert.equal(result.toolCallId, 'call_1');
    assert.equal(result.toolName, 'exec');
  } finally { await s.close(); }
});

test('responses：custom 调用 + function_call_output（网关只降级了输出）仍能配对', async () => {
  const s = await setup();
  try {
    const msgs = await send(s, [
      user('查一下'),
      customCall('call_1', 'exec', 'a'),
      fnOut('call_1', 'ok'),
    ]);
    assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant', 'tool']);
    assert.equal(toolResultsOf(msgs[2])[0].toolCallId, 'call_1');
  } finally { await s.close(); }
});

test('responses：找不到发起方的 tool 结果被丢弃，不再触发上游 400', async () => {
  const s = await setup();
  try {
    const msgs = await send(s, [
      user('查一下'),
      fnOut('call_missing', 'ok'),
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] },
      user('继续'),
    ]);
    assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant', 'user']);
  } finally { await s.close(); }
});
