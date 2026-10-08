// 按模型供应商分流上游代理（CC_UPSTREAM_PROXY_BY_VENDOR）。
//
// 契约：
//   - 只有生成请求（/alpha/generate）按模型供应商选代理；claude-* → anthropic，gpt-* → openai，
//     带斜杠的 ID 取斜杠前的厂商名；
//   - 预请求（fingerprint / lifecycle）、模型目录、额度查询一律走默认路由（CC_UPSTREAM_PROXY 或直连）；
//   - 供应商值为 'direct' 时强制直连，即使配了全局代理；
//   - 任一代理地址非法 → 拒绝启动。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { allocPort, closeServer, startMockUpstream, startProxy } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
const chat = (model) => ({ model, messages: [{ role: 'user', content: 'hi' }] });

/** 录制型 CONNECT 代理：只做裸字节转发，记录每次隧道的目标。 */
async function startConnectProxy() {
  const port = await allocPort();
  const connects = [];
  const server = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, clientSocket, head) => {
    connects.push(req.url);
    const [host, p] = req.url.split(':');
    const upstream = net.connect(Number(p), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}`, connects, close: () => closeServer(server) };
}

test('分流：claude 走 anthropic 代理，其余生成与预请求走默认代理，direct 强制直连', async () => {
  const mock = await startMockUpstream();
  const anthropicProxy = await startConnectProxy();
  const defaultProxy = await startConnectProxy();
  const proxy = await startProxy({
    upstreamPort: mock.port,
    env: {
      CC_UPSTREAM_PROXY: defaultProxy.url,
      CC_UPSTREAM_PROXY_BY_VENDOR: `Anthropic=${anthropicProxy.url}, openai=direct`,
    },
  });
  try {
    // ① 非 claude：预请求 + 生成都经默认代理，anthropic 代理不碰
    let r = await proxy.post('/v1/chat/completions', chat('deepseek/deepseek-v4-flash'), AUTH);
    assert.equal(r.status, 200, await r.text());
    const initNonGenerate = mock.seen.filter(s => s.url !== '/alpha/generate').length;
    assert.ok(initNonGenerate >= 1, '首个请求应触发预请求');
    assert.equal(defaultProxy.connects.length, initNonGenerate + 1, '预请求与生成都应经默认代理');
    assert.equal(anthropicProxy.connects.length, 0);

    // ② claude-*：生成经 anthropic 代理，默认代理不增加
    const before = defaultProxy.connects.length;
    r = await proxy.post('/v1/messages',
      { model: 'claude-sonnet-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] },
      { 'x-api-key': 'user_test' });
    assert.equal(r.status, 200, await r.text());
    assert.equal(mock.lastGenerate().body.params.model, 'claude-sonnet-5-5');
    assert.equal(anthropicProxy.connects.length, 1, 'claude 生成请求应经 anthropic 代理');
    assert.equal(defaultProxy.connects.length, before);

    // ③ openai=direct：不经任何代理，但上游照常收到生成请求
    const generates = mock.generateCount();
    r = await proxy.post('/v1/chat/completions', chat('gpt-5.5'), AUTH);
    assert.equal(r.status, 200, await r.text());
    assert.equal(mock.generateCount(), generates + 1);
    assert.equal(anthropicProxy.connects.length, 1);
    assert.equal(defaultProxy.connects.length, before);

    // 启动日志列出路由，键已归一为小写
    assert.match(proxy.logs(), /Upstream proxy routes/);
    assert.match(proxy.logs(), /"anthropic":"http:\/\/127\.0\.0\.1:\d+"/);
    assert.match(proxy.logs(), /"openai":"\(direct\)"/);
  } finally {
    await proxy.kill(); await anthropicProxy.close(); await defaultProxy.close(); await mock.close();
  }
});

test('分流：只配供应商代理时，未命中的模型与预请求直连', async () => {
  const mock = await startMockUpstream();
  const anthropicProxy = await startConnectProxy();
  const proxy = await startProxy({
    upstreamPort: mock.port,
    env: { CC_UPSTREAM_PROXY_BY_VENDOR: `anthropic=${anthropicProxy.url}` },
  });
  try {
    let r = await proxy.post('/v1/chat/completions', chat('deepseek/deepseek-v4-flash'), AUTH);
    assert.equal(r.status, 200, await r.text());
    assert.equal(anthropicProxy.connects.length, 0, '非 claude 请求与预请求都应直连');

    r = await proxy.post('/v1/chat/completions', chat('claude-opus-5-5'), AUTH);
    assert.equal(r.status, 200, await r.text());
    assert.equal(anthropicProxy.connects.length, 1);
  } finally {
    await proxy.kill(); await anthropicProxy.close(); await mock.close();
  }
});

test('分流：供应商代理地址非法 → 拒绝启动', async () => {
  const mock = await startMockUpstream();
  try {
    await assert.rejects(
      startProxy({ upstreamPort: mock.port, env: { CC_UPSTREAM_PROXY_BY_VENDOR: 'anthropic=socks5://127.0.0.1:1080' } }),
      /refusing to start/,
    );
  } finally { await mock.close(); }
});
