// 大小写归一：CC 的模型 ID 大小写敏感（moonshotai/Kimi-K3 可用、moonshotai/kimi-k3 报 401），
// 代理用 /provider/v1/models 的实时目录把下游写法对齐成精确 ID，拉不到目录时退回内置表 + 前缀规则。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };

/** 目录里有 Kimi-K3、带前缀的 deepseek、以及裸名的 claude；用于验证大小写归一。 */
const CATALOG = {
  object: 'list',
  data: [
    { id: 'moonshotai/Kimi-K3' },
    { id: 'moonshotai/Kimi-K2.6' },
    { id: 'deepseek/deepseek-v4-flash' },
    { id: 'claude-opus-5-5' },
  ],
};

/** mock 上游：/provider/v1/models 返回目录；其余落到默认处理。 */
function catalogUpstream({ status = 200, body = CATALOG } = {}) {
  return {
    onRequest: (req, res) => {
      if (req.url === '/provider/v1/models') {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      }
    },
  };
}

async function wire(s, model, path = '/v1/chat/completions') {
  const payload = path === '/v1/responses'
    ? { model, input: 'hi' }
    : { model, messages: [{ role: 'user', content: 'hi' }] };
  await s.proxy.post(path, payload, path === '/v1/responses' ? AUTH : AUTH);
  return s.mock.lastGenerate()?.body?.params?.model;
}

test('大小写归一：目录里的 Kimi-K3 用小写/全大写/带前缀混写都能落到精确 ID', async () => {
  const s = await setup({ ...catalogUpstream(), env: { CC_USE_PROVIDER_MODELS: 'true' } });
  try {
    for (const input of ['kimi-k3', 'Kimi-K3', 'KIMI-K3', 'MOONSHOTAI/KIMI-K3', 'Moonshotai/kimi-K3']) {
      assert.equal(await wire(s, input), 'moonshotai/Kimi-K3', `${input} 应归一到目录 ID`);
    }
  } finally { await s.close(); }
});

test('大小写归一：Responses 路径同样生效（sub2api 用的就是这条）', async () => {
  const s = await setup({ ...catalogUpstream(), env: { CC_USE_PROVIDER_MODELS: 'true' } });
  try {
    assert.equal(await wire(s, 'kimi-k3', '/v1/responses'), 'moonshotai/Kimi-K3');
  } finally { await s.close(); }
});

test('大小写归一：目录里的裸名（claude-*）大小写不敏感', async () => {
  const s = await setup({ ...catalogUpstream(), env: { CC_USE_PROVIDER_MODELS: 'true' } });
  try {
    assert.equal(await wire(s, 'CLAUDE-OPUS-5-5'), 'claude-opus-5-5');
  } finally { await s.close(); }
});

test('内置别名仍优先于前缀兜底：deepseek-flash → deepseek/deepseek-v4.1-flash', async () => {
  const s = await setup({ ...catalogUpstream(), env: { CC_USE_PROVIDER_MODELS: 'true' } });
  try {
    assert.equal(await wire(s, 'DeepSeek-Flash'), 'deepseek/deepseek-v4.1-flash');
  } finally { await s.close(); }
});

test('目录不可用（5xx）时不影响请求：退回前缀兜底且不报错', async () => {
  const s = await setup({
    ...catalogUpstream({ status: 500, body: { error: 'boom' } }),
    env: { CC_USE_PROVIDER_MODELS: 'true' },
  });
  try {
    // 内置目录里也没有 Kimi-K3 → 前缀兜底保留客户端大小写（尽力而为）
    assert.equal(await wire(s, 'kimi-k2.6'), 'moonshotai/Kimi-K2.6', '内置目录仍可归一');
    assert.equal(await wire(s, 'llama-3.3-70b'), 'llama-3.3-70b', '未知名字原样透传');
  } finally { await s.close(); }
});

test('目录被禁用（CC_USE_PROVIDER_MODELS=false）时行为与加这层之前一致', async () => {
  const s = await setup({ env: { CC_USE_PROVIDER_MODELS: 'false' } });
  try {
    assert.equal(await wire(s, 'deepseek-flash'), 'deepseek/deepseek-v4.1-flash');
    assert.equal(await wire(s, 'claude-sonnet-4-6'), 'claude-sonnet-4-6');
  } finally { await s.close(); }
});
