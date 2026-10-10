// 带图请求的上游兼容处理（fork 扩展）：
//   - deepseek 厂商的图片按官方 CLI 的做法压缩（长边 1200、JPEG q95、带透明通道的 PNG 保持 PNG）；
//   - deepseek/deepseek-v4.1-flash 带图时改走 deepseek/deepseek-v4.1-flash-fast；
//   - 纯文本请求、其他厂商的模型一律不动；任何失败原样放行。
// 断言的是**发到 mock 上游的 CC 请求体**：压缩和分流都只发生在这一侧，响应里看不出来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Jimp, JimpMime } from 'jimp';
import { setup } from './helpers.mjs';

const AUTH = { Authorization: 'Bearer user_test' };
const FLASH = 'deepseek/deepseek-v4.1-flash';
const FAST = 'deepseek/deepseek-v4.1-flash-fast';

/** 生成一张带噪声的测试图（噪声让 PNG 压不小，贴近真实截图的体积）。 */
async function makeImage(width, height, { alpha = false, mime = JimpMime.png } = {}) {
  const image = new Jimp({ width, height, color: 0xffffffff });
  const data = image.bitmap.data;
  let seed = width * 31 + height;
  for (let i = 0; i < data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = seed & 0xff;
    data[i + 1] = (seed >> 8) & 0xff;
    data[i + 2] = (seed >> 16) & 0xff;
    data[i + 3] = alpha && i % 8 === 0 ? 128 : 255;
  }
  const buffer = await image.getBuffer(mime);
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

const chatWithImage = (model, url) => ({
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url } }] }],
});

async function sendChat(s, body) {
  const r = await s.proxy.post('/v1/chat/completions', body, AUTH);
  assert.equal(r.status, 200, await r.clone().text());
  await r.text();
  return s.mock.lastGenerate().body.params;
}

const imageOf = (params) => params.messages.at(-1).content.find(c => c.type === 'image');
async function decode(part) {
  const [, mime, b64] = /^data:([^;]+);base64,(.*)$/s.exec(part.image);
  const image = await Jimp.fromBuffer(Buffer.from(b64, 'base64'));
  return { mime, width: image.bitmap.width, height: image.bitmap.height, bytes: Buffer.from(b64, 'base64').length };
}

test('deepseek 带图：图片缩到长边 1200 并转 JPEG，模型改走 fast', async () => {
  const s = await setup();
  try {
    const url = await makeImage(1600, 1000);
    const params = await sendChat(s, chatWithImage('deepseek-flash', url));
    assert.equal(params.model, FAST);
    const part = imageOf(params);
    assert.equal(part.mimeType, 'image/jpeg');
    const out = await decode(part);
    assert.equal(out.mime, 'image/jpeg');
    assert.deepEqual([out.width, out.height], [1200, 750]);
    assert.ok(part.image.length < url.length, '压缩后应更小');
    assert.match(s.proxy.logs(), /Image request prepared/);
  } finally { await s.close(); }
});

test('deepseek 纯文本：模型与内容都不动', async () => {
  const s = await setup();
  try {
    const params = await sendChat(s, { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(params.model, FLASH);
    assert.doesNotMatch(s.proxy.logs(), /Image request prepared/);
  } finally { await s.close(); }
});

test('其他厂商带图：模型与图片字节原样', async () => {
  const s = await setup();
  try {
    const url = await makeImage(1600, 1000);
    const params = await sendChat(s, chatWithImage('claude-sonnet-4-6', url));
    assert.equal(params.model, 'claude-sonnet-4-6');
    assert.equal(imageOf(params).image, url);
  } finally { await s.close(); }
});

test('带透明通道的 PNG 保持 PNG，只缩尺寸', async () => {
  const s = await setup();
  try {
    const url = await makeImage(1000, 2000, { alpha: true });
    const part = imageOf(await sendChat(s, chatWithImage(FLASH, url)));
    const out = await decode(part);
    assert.equal(part.mimeType, 'image/png');
    assert.deepEqual([out.mime, out.width, out.height], ['image/png', 600, 1200]);
  } finally { await s.close(); }
});

test('已经很小的 JPEG 不重新编码（再编码只会变大）', async () => {
  const s = await setup();
  try {
    const big = new Jimp({ width: 800, height: 600, color: 0x336699ff });
    const url = `data:image/jpeg;base64,${(await big.getBuffer(JimpMime.jpeg, { quality: 60 })).toString('base64')}`;
    const params = await sendChat(s, chatWithImage(FLASH, url));
    assert.equal(imageOf(params).image, url);
    assert.equal(params.model, FAST, '不压缩也照样分流');
  } finally { await s.close(); }
});

test('损坏的图片原样放行，请求不失败', async () => {
  const s = await setup();
  try {
    const url = 'data:image/png;base64,' + Buffer.from('not an image at all').toString('base64');
    const params = await sendChat(s, chatWithImage(FLASH, url));
    assert.equal(imageOf(params).image, url);
    assert.equal(params.model, FAST);
  } finally { await s.close(); }
});

test('同一张图两次请求输出字节一致，第二次命中缓存', async () => {
  const s = await setup();
  try {
    const url = await makeImage(1500, 1500);
    const first = imageOf(await sendChat(s, chatWithImage(FLASH, url))).image;
    const second = imageOf(await sendChat(s, chatWithImage(FLASH, url))).image;
    assert.equal(first, second);
    assert.match(s.proxy.logs(), /"cacheHits":1/);
  } finally { await s.close(); }
});

test('/v1/responses 与 /v1/messages 的图片同样压缩并分流', async () => {
  const s = await setup();
  try {
    const url = await makeImage(1600, 1000);
    let r = await s.proxy.post('/v1/responses', {
      model: FLASH,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: url }] }],
    }, AUTH);
    assert.equal(r.status, 200, await r.clone().text());
    await r.text();
    let params = s.mock.lastGenerate().body.params;
    assert.equal(params.model, FAST);
    assert.equal(imageOf(params).mimeType, 'image/jpeg');

    const b64 = url.slice(url.indexOf(',') + 1);
    r = await s.proxy.post('/v1/messages', {
      model: FLASH, max_tokens: 64,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
      ] }],
    }, { ...AUTH, 'anthropic-version': '2023-06-01' });
    assert.equal(r.status, 200, await r.clone().text());
    await r.text();
    params = s.mock.lastGenerate().body.params;
    assert.equal(params.model, FAST);
    assert.equal(imageOf(params).mimeType, 'image/jpeg');
  } finally { await s.close(); }
});

test('两个开关置空后关闭压缩与分流', async () => {
  const s = await setup({ env: { CC_IMAGE_COMPACT_VENDORS: '', CC_IMAGE_MODEL_ROUTES: '' } });
  try {
    const url = await makeImage(1600, 1000);
    const params = await sendChat(s, chatWithImage(FLASH, url));
    assert.equal(params.model, FLASH);
    assert.equal(imageOf(params).image, url);
  } finally { await s.close(); }
});
