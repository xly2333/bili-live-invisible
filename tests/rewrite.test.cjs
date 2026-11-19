/**
 * bili-live-invisible 语义测试（28 条，vm 沙箱内真实执行脚本）。
 * 覆盖：R1/R2/R3 改写语义、fetch/XHR/sendBeacon/WebSocket 四通道、
 *       弹幕协议二进制帧、Request 对象 body、拦截优先交互。
 *
 * 运行：node tests/rewrite.test.cjs
 * 注：用例中的 uid/roomid 均为占位假值。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = path.resolve(__dirname, '..', 'bili-live-invisible.user.js');
const src = fs.readFileSync(SCRIPT, 'utf8');

// 占位假值（勿填真实账号信息）
const UID = 10001;
const ROOM = 1024;
const SAFE = 'https://api.live.bilibili.com/xlive/web-room/v1/dM/group';      // 不被上报规则命中的载体
const BLOCKED = 'https://data.bilivideo.com/log/web/te9Kl';                    // 被上报规则命中的载体

const seen = [];

function makeSandbox() {
  class FakeResponse {
    constructor(body, init) {
      this._body = body; this.status = (init && init.status) || 200;
    }
    text() { return Promise.resolve(this._body); }
    json() { return Promise.resolve(JSON.parse(this._body)); }
    clone() { return this; }
  }
  class FakeRequest {
    constructor(url, init = {}) {
      this.url = url; this.method = init.method || 'GET';
      this.headers = init.headers || {}; this._body = init.body;
    }
    clone() { const s = this; return { text: async () => (s._body == null ? '' : String(s._body)) }; }
  }
  class FakeXHR {
    open(m, u) { this.__u = u; }
    send(b) { seen.push({ via: 'xhr', url: this.__u, body: b }); }
    addEventListener() {} dispatchEvent() {} setRequestHeader() {}
  }
  class FakeWS {
    constructor(url) { this.url = url; this.__sent = []; }
    send(d) { this.__sent.push(d); }
  }
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;

  const sandbox = {
    console: { info: () => {} },
    setTimeout, clearTimeout, Promise, JSON, String, Object, RegExp, Error, Array,
    ArrayBuffer, DataView, Uint8Array, URL, URLSearchParams, FormData,
    TextEncoder, TextDecoder,
    Event: class { constructor(t) { this.type = t; } },
    Response: FakeResponse, Request: FakeRequest,
    XMLHttpRequest: FakeXHR, WebSocket: FakeWS,
    navigator: { sendBeacon: (u, d) => { seen.push({ via: 'beacon', url: u, body: d }); return true; } },
    location: { href: 'https://live.bilibili.com/' + ROOM },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const body = (init && init.body !== undefined) ? init.body
      : (input && typeof input === 'object' && input._body !== undefined) ? input._body
        : undefined;
    seen.push({ via: 'fetch', url, body, input });
    return Promise.resolve(new FakeResponse('{"code":0}', { status: 200 }));
  };
  return sandbox;
}

const sandbox = makeSandbox();
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'bili-live-invisible.user.js' });

function danmuFrame(withGroup) {
  const payload = withGroup
    ? { uid: UID, roomid: ROOM, key: 'k', group: 'g', proto: [3] }
    : { uid: UID, roomid: ROOM, key: 'k', proto: [3] };
  const bodyBytes = new TextEncoder().encode(JSON.stringify(payload));
  const frame = new Uint8Array(16 + bodyBytes.length);
  const dv = new DataView(frame.buffer);
  dv.setUint32(0, frame.length, false);
  dv.setUint16(4, 16, false);
  dv.setUint16(6, 1, false);
  dv.setUint32(8, 7, false);   // AUTH op
  dv.setUint32(12, 1, false);  // seq
  frame.set(bodyBytes, 16);
  return frame;
}

const CASES = [
  // ══ R1 ══
  { id: 'R1-is_anchor', expect: 'R1 删 access_key（is_anchor 触发）',
    run: () => sandbox.fetch(`https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByUser?room_id=${ROOM}&is_anchor=1&access_key=SECRET_TOKEN_ABC`),
    check: (r) => !/access_key/.test(r.url) && /is_anchor=1/.test(r.url) },
  { id: 'R1-hb', expect: 'R1 删 access_key（hb 触发）',
    run: () => sandbox.fetch(`https://api.live.bilibili.com/xlive/heartbeat?hb=1&access_key=SECRET_TOKEN_ABC&room_id=1`),
    check: (r) => !/access_key/.test(r.url) },
  { id: 'R1-heart_beat-body', expect: 'R1 删 access_key（heart_beat 触发·body）',
    run: () => sandbox.fetch('https://api.live.bilibili.com/xlive/foo', { method: 'POST', body: JSON.stringify({ heart_beat: 1, access_key: 'SECRET_TOKEN_ABC', room_id: 1 }) }),
    check: (r) => !/access_key/.test(String(r.body)) },
  { id: 'R1-negative', expect: '无触发键 → access_key 保留',
    run: () => sandbox.fetch(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=${ROOM}&access_key=SECRET_TOKEN_ABC`),
    check: (r) => /access_key=SECRET_TOKEN_ABC/.test(r.url) },

  // ══ R2 ══
  { id: 'R2-query', expect: 'R2 room_id→273022（query 载体）',
    run: () => sandbox.fetch(`https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByUser?room_id=${ROOM}&from=0&not_mock_enter_effect=1&web_location=4`),
    check: (r) => /room_id=273022/.test(r.url) && !/room_id=1024/.test(r.url) },
  { id: 'R2-body', expect: 'R2 body room_id→273022',
    run: () => sandbox.fetch('https://api.live.bilibili.com/xlive/web-room/v1/index/roomEntryAction', { method: 'POST', body: JSON.stringify({ room_id: ROOM, platform: 'pc', not_mock_enter_effect: 1 }) }),
    check: (r) => /"room_id":"273022"/.test(String(r.body)) },
  { id: 'R2-negative', expect: '无触发键 → room_id 不变',
    run: () => sandbox.fetch(`https://api.live.bilibili.com/xlive/web-room/v1/giftPanel/roomGiftList?platform=pc&room_id=${ROOM}`),
    check: (r) => /room_id=1024/.test(r.url) },
  { id: 'R2-only-if-present', expect: 'replace 语义：room_id 键不存在时不新建',
    run: () => sandbox.fetch('https://api.live.bilibili.com/xlive/x?not_mock_enter_effect=1'),
    check: (r) => !/room_id/.test(r.url) },

  // ══ R3 ══
  { id: 'R3-body', expect: 'R3 uid→0（含 group 门控）',
    run: () => sandbox.fetch(SAFE, { method: 'POST', body: JSON.stringify({ uid: UID, group: 1, buvid: 'B' }) }),
    check: (r) => /"uid":0/.test(String(r.body)) && !/10001/.test(String(r.body)) },
  { id: 'R3-negative-no-group', expect: '无 group 门控 → uid 保持原值',
    run: () => sandbox.fetch(SAFE, { method: 'POST', body: JSON.stringify({ uid: UID, buvid: 'B' }) }),
    check: (r) => /10001/.test(String(r.body)) },
  { id: 'R3-xhr', expect: 'R3 在 XHR 路径生效',
    run: () => { const x = new sandbox.XMLHttpRequest(); x.open('POST', SAFE); x.send(JSON.stringify({ uid: UID, group: 1 })); },
    check: (r) => /"uid":0/.test(String(r.body)) },
  { id: 'R3-ws-json', expect: 'R3 在 WS 纯 JSON 帧生效',
    run: () => {
      const ws = new sandbox.WebSocket('wss://broadcastlv.chat.bilibili.com/sub');
      ws.send(JSON.stringify({ uid: UID, group: 'x', cmd: 'auth' }));
      return { url: 'wss://ws', body: ws.__sent[0] };
    },
    check: (r) => /"uid":0/.test(String(r.body)) },

  // ══ 组合与通道 ══
  { id: 'ALL-three', expect: 'R1+R2+R3 同时生效',
    run: () => sandbox.fetch(`https://api.live.bilibili.com/xlive/x?is_anchor=1&access_key=T&room_id=${ROOM}&not_mock_enter_effect=1&uid=999&group=1`),
    check: (r) => !/access_key/.test(r.url) && /room_id=273022/.test(r.url) && /uid=0/.test(r.url) },
  { id: 'PATH-xhr-r2', expect: 'XHR 路径 R2',
    run: () => { const x = new sandbox.XMLHttpRequest(); x.open('GET', `https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByUser?room_id=${ROOM}&not_mock_enter_effect=1`); x.send(); },
    check: (r) => /room_id=273022/.test(r.url) },
  { id: 'PATH-beacon-r1', expect: 'sendBeacon 路径 R1',
    run: () => sandbox.navigator.sendBeacon('https://data.bilibili.com/log/web?hb=1&access_key=T'),
    check: (r) => !/access_key/.test(r.url) },
  { id: 'PATH-request-obj', expect: 'Request 对象路径 R2（仅 URL）',
    run: () => sandbox.fetch(new sandbox.Request(`https://api.live.bilibili.com/xlive/x?room_id=${ROOM}&not_mock_enter_effect=1`)),
    check: (r) => /room_id=273022/.test(r.url) },

  // ══ 拦截与改写的交互 ══
  { id: 'ORDER-block-wins', expect: '上报端点：整条丢弃，不进入改写',
    run: () => sandbox.fetch(BLOCKED, { method: 'POST', body: JSON.stringify({ uid: UID, group: 1 }) }),
    check: (r) => r.__blocked === true && r.url === '' },
  { id: 'ORDER-block-data', expect: 'data.bilibili.com 仍被拦截',
    run: () => sandbox.fetch('https://data.bilibili.com/log/web?x=1'),
    check: (r) => r.__blocked === true },
  { id: 'ORDER-no-block-danmu', expect: 'getDanmuInfo 不被拦截（弹幕必需）',
    run: () => sandbox.fetch(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=${ROOM}`),
    check: (r) => r.__blocked !== true && /getDanmuInfo/.test(r.url) },

  // ══ v2.1.0：二进制 WS 帧 ══
  { id: 'WS-binary-ArrayBuffer', expect: '弹幕二进制帧（ArrayBuffer）：uid→0 + 包头字节总长重算 + op/seq 保留',
    run: () => {
      const ws = new sandbox.WebSocket('wss://broadcastlv.chat.bilibili.com/sub');
      ws.send(danmuFrame(true).buffer);
      return { url: 'ws', body: ws.__sent[0] };
    },
    check: (r) => {
      if (!r.body || typeof r.body.length !== 'number') return false;
      const buf = Buffer.from(r.body.buffer || r.body);
      return buf.readUInt32BE(0) === r.body.length
        && JSON.parse(buf.subarray(16).toString('utf8')).uid === 0
        && buf.readUInt32BE(8) === 7 && buf.readUInt32BE(12) === 1;
    } },
  { id: 'WS-binary-TypedArray', expect: '弹幕二进制帧（TypedArray）：同样改写',
    run: () => {
      const ws = new sandbox.WebSocket('wss://broadcastlv.chat.bilibili.com/sub');
      ws.send(danmuFrame(true));
      return { url: 'ws', body: ws.__sent[0] };
    },
    check: (r) => {
      const buf = Buffer.from(r.body.buffer || r.body);
      return JSON.parse(buf.subarray(16).toString('utf8')).uid === 0;
    } },
  { id: 'WS-binary-string', expect: '弹幕二进制字符串帧：改写并输出字节（UTF-8 长度正确）',
    run: () => {
      const ws = new sandbox.WebSocket('wss://broadcastlv.chat.bilibili.com/sub');
      const f = danmuFrame(true); let s = '';
      for (let i = 0; i < f.length; i++) s += String.fromCharCode(f[i]);
      ws.send(s);
      return { url: 'ws', body: ws.__sent[0] };
    },
    check: (r) => {
      const buf = Buffer.from(r.body.buffer || r.body);
      return buf.readUInt32BE(0) === buf.length && JSON.parse(buf.subarray(16).toString('utf8')).uid === 0;
    } },
  { id: 'WS-binary-nomatch', expect: '无 uid/group 的二进制帧：原对象透传，不被破坏',
    run: () => {
      const ws = new sandbox.WebSocket('wss://broadcastlv.chat.bilibili.com/sub');
      const f = danmuFrame(false);
      ws.send(f.buffer);
      return { url: 'ws', body: ws.__sent[0], original: f.buffer };
    },
    check: (r) => r.body === r.original },

  // ══ v2.1.0：Request body / 表单 ══
  { id: 'REQ-json-body', expect: 'Request 对象 POST JSON body：uid→0',
    run: () => sandbox.fetch(new sandbox.Request(SAFE, { method: 'POST', body: JSON.stringify({ uid: UID, group: 1, buvid: 'B' }) })),
    check: (r) => /"uid":0/.test(String(r.body)) && !/10001/.test(String(r.body)) },
  { id: 'REQ-json-keep', expect: 'Request 对象 POST JSON 无触发键：原样保留',
    run: () => sandbox.fetch(new sandbox.Request(SAFE, { method: 'POST', body: JSON.stringify({ foo: 'bar' }) })),
    check: (r) => /"foo":"bar"/.test(String(r.body)) },
  { id: 'REQ-binary-fallback', expect: 'Request 对象 POST 非 JSON body：回落原始 Request，不毁包',
    run: () => sandbox.fetch(new sandbox.Request(SAFE, { method: 'POST', body: 'plain-not-json' })),
    check: (r) => r.url === SAFE && String(r.body) === 'plain-not-json' },
  { id: 'BODY-form-string', expect: '表单字符串 body：uid→0',
    run: () => sandbox.fetch(SAFE, { method: 'POST', body: 'uid=99999&group=1&x=1' }),
    check: (r) => r.body === 'uid=0&group=1&x=1' },
  { id: 'BODY-urlsearchparams', expect: 'URLSearchParams 实例 body：uid→0（就地改写）',
    run: () => sandbox.fetch(SAFE, { method: 'POST', body: new sandbox.URLSearchParams('uid=99999&group=1') }),
    check: (r) => String(r.body) === 'uid=0&group=1' },
];

(async () => {
  const results = [];
  for (const c of CASES) {
    seen.length = 0;
    let blocked = false;
    let explicit = null;
    try {
      const ret = c.run();
      if (ret && typeof ret.then === 'function') {
        const res = await ret;
        if (res && typeof res.text === 'function') {
          const t = await res.text();
          if (t === '{"code":0}' && seen.length === 0) blocked = true;
        }
      } else if (ret && typeof ret === 'object' && 'url' in ret) {
        explicit = ret;
      }
      if (!explicit && seen.length === 0 && !blocked) await new Promise((r) => setTimeout(r, 30));
    } catch (e) {
      results.push({ id: c.id, expect: c.expect, ok: false, error: String(e) });
      continue;
    }
    const rec = explicit || seen[seen.length - 1] || { url: '', body: '' };
    rec.__blocked = blocked;
    let ok = false;
    try { ok = !!c.check(rec); } catch (_) { ok = false; }
    results.push({
      id: c.id, expect: c.expect, ok, blocked,
      gotUrl: String(rec.url || '').slice(0, 120),
      gotBody: rec.body instanceof Uint8Array ? `[Uint8Array ${rec.body.length}B]` : String(rec.body).slice(0, 160),
    });
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== bili-live-invisible 语义实测: ${pass}/${results.length} 通过 ===\n`);
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(22)} ${r.expect}`);
    if (!r.ok) {
      console.log('      url :', r.gotUrl);
      console.log('      body:', r.gotBody);
      if (r.error) console.log('      err :', r.error);
    }
  }
  if (pass !== results.length) process.exitCode = 1;
})();
