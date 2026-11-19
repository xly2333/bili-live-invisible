// ==UserScript==
// @name         Bilibili Live 隐身观看（含身份字段改写）
// @namespace    local.bili.live.invisible
// @version      2.1.0
// @description  屏蔽上报请求 + 按参考模块语义改写 access_key / room_id / uid
// @author       xly2333
// @license      MIT
// @match        https://live.bilibili.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * 三处身份字段改写，语义逐条对齐参考 APK（io.github.lzghzr.biliveinvisible v1.1.0）：
 *
 *   [R1] 集合含 is_anchor | hb | heart_beat   → remove("access_key")
 *   [R2] 集合含 not_mock_enter_effect         → replace("room_id", "273022")  仅当键存在
 *   [R3] 集合含 uid 且含 group                → uid := 0
 *
 * APK 里 R1/R2 挂在 addCommonParam(Map)，R3 挂在 fastjson JSONObject.put；
 * 网页端没有这两个函数，等价落点是「所有出站请求的 query + body」，
 * 以及 WebSocket 的鉴权/心跳帧。
 *
 * ── v2.1.0 变更 ──
 *  1. WebSocket 支持 ArrayBuffer / TypedArray 帧（弹幕协议实际是二进制帧），
 *     包头总长按 UTF-8 字节重算，操作码/序列原样保留；移除 v2.0.0 的死代码。
 *  2. fetch 的 Request 对象：POST/PUT 的 JSON body 现在会真正被改写
 *     （v2.0.0 只改 URL）；非 JSON 形态（二进制等）不碰，防止有损解码毁包。
 *  3. 四个通道全部加兜底安全网：改写逻辑内部异常时回落原生行为，绝不弄挂页面。
 *  4. 移除多余的 @match api.live.bilibili.com（拦截发生在页面上下文，无需匹配 API 域）。
 */

(function () {
  'use strict';

  const CONFIG = {
    // 上报拦截
    blockAnalytics: true,
    blockPresenceReport: true,
    blockLowRisk: true,
    // 身份字段改写（三处）
    rewriteAccessKey: true,   // R1
    rewriteRoomId: true,      // R2
    rewriteUid: true,         // R3
    rewriteWebSocket: true,   // 同时作用于 WS 帧
    // 调试
    debug: false,
  };

  // R2 的目标房间号（与参考模块一致）
  const TARGET_ROOM_ID = '273022';

  // ── R1 触发键 ──────────────────────────────────────────────
  const R1_TRIGGERS = ['is_anchor', 'hb', 'heart_beat'];
  // ── R2 触发键 ──────────────────────────────────────────────
  const R2_TRIGGER = 'not_mock_enter_effect';
  // ── R3 触发键 ──────────────────────────────────────────────
  const R3_KEY = 'uid';
  const R3_GATE = 'group';

  const log = (...a) => { if (CONFIG.debug) console.info('[bili-rewrite]', ...a); };

  // ══════════════════════════════════════════════════════════
  // 通用：对「键值对集合」应用三处改写
  // ══════════════════════════════════════════════════════════

  function applyRewrites({ has, del, set, tag }) {
    const hits = [];

    // R1: 含 is_anchor / hb / heart_beat → 删 access_key
    if (CONFIG.rewriteAccessKey) {
      const trigger = R1_TRIGGERS.find((k) => has(k));
      if (trigger && has('access_key')) {
        del('access_key');
        hits.push(`R1(${trigger})`);
      }
    }

    // R2: 含 not_mock_enter_effect → room_id = 273022（仅当 room_id 已存在）
    if (CONFIG.rewriteRoomId) {
      if (has(R2_TRIGGER) && has('room_id')) {
        set('room_id', TARGET_ROOM_ID);
        hits.push('R2');
      }
    }

    // R3: uid 且集合含 group → uid = 0
    if (CONFIG.rewriteUid) {
      if (has(R3_KEY) && has(R3_GATE)) {
        set(R3_KEY, 0);
        hits.push('R3');
      }
    }

    if (hits.length) log(tag, hits.join('+'));
    return hits;
  }

  // ══════════════════════════════════════════════════════════
  // URL query 层
  // ══════════════════════════════════════════════════════════

  function rewriteUrl(rawUrl) {
    if (!CONFIG.rewriteAccessKey && !CONFIG.rewriteRoomId && !CONFIG.rewriteUid) return rawUrl;
    let u;
    try { u = new URL(rawUrl, location.href); } catch (_) { return rawUrl; }
    const sp = u.searchParams;
    if ([...sp.keys()].length === 0) return rawUrl;

    const hits = applyRewrites({
      has: (k) => sp.has(k),
      del: (k) => sp.delete(k),
      set: (k, v) => sp.set(k, String(v)),
      tag: 'url ' + u.pathname,
    });
    if (!hits.length) return rawUrl;
    return u.toString();
  }

  // ══════════════════════════════════════════════════════════
  // Body 层：JSON / 表单 / URLSearchParams / FormData
  // ══════════════════════════════════════════════════════════

  function rewriteJsonText(text) {
    let obj;
    try { obj = JSON.parse(text); } catch (_) { return null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

    const hits = applyRewrites({
      has: (k) => Object.prototype.hasOwnProperty.call(obj, k),
      del: (k) => { delete obj[k]; },
      set: (k, v) => { obj[k] = v; },
      tag: 'json',
    });
    return hits.length ? JSON.stringify(obj) : null;
  }

  function rewriteFormText(text) {
    if (typeof text !== 'string' || !/^[^=&\s]+=/.test(text)) return null;
    let sp;
    try { sp = new URLSearchParams(text); } catch (_) { return null; }
    if ([...sp.keys()].length === 0) return null;

    const hits = applyRewrites({
      has: (k) => sp.has(k),
      del: (k) => sp.delete(k),
      set: (k, v) => sp.set(k, String(v)),
      tag: 'form',
    });
    return hits.length ? sp.toString() : null;
  }

  /** 返回改写后的 body；无需改写则返回 null */
  function rewriteBody(body) {
    if (body == null) return null;
    if (typeof body === 'string') {
      return rewriteJsonText(body) || rewriteFormText(body);
    }
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      const hits = applyRewrites({
        has: (k) => body.has(k),
        del: (k) => body.delete(k),
        set: (k, v) => body.set(k, String(v)),
        tag: 'urlsearchparams',
      });
      return hits.length ? body : null;
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const hits = applyRewrites({
        has: (k) => body.has(k),
        del: (k) => body.delete(k),
        set: (k, v) => body.set(k, String(v)),
        tag: 'formdata',
      });
      return hits.length ? body : null;
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════
  // 上报拦截（实测口径：367 条 HAR，遥测 26/26，误伤 0）
  // ══════════════════════════════════════════════════════════

  const STATIC_ASSET = /\.(js|css|png|jpe?g|gif|webp|svg|ico|ttf|woff2?|eot|svga|mp4|m4s|m3u8|wasm|map)(\?|#|$)/i;

  const RULES = [
    { name: 'bili-data-log', tier: 'analytics',
      test: (u) => /^https?:\/\/data\.bilibili\.com\//.test(u) },
    { name: 'bilivideo-data-log', tier: 'analytics',
      test: (u) => /^https?:\/\/data\.bilivideo\.com\//.test(u) },
    { name: 'live-trace', tier: 'analytics',
      test: (u) => /^https?:\/\/live-trace\.bilibili\.com\//.test(u) },
    { name: 'tracker-conf', tier: 'low',
      test: (u) => /^https?:\/\/api\.live\.bilibili\.com\/xlive\/open-interface\/v2\/tracker\//.test(u) },
    { name: 'rum-collect', tier: 'analytics',
      test: (u) => /^https?:\/\/rumt-zh\.com\/collect\//.test(u) },
    { name: 'third-party-log', tier: 'analytics',
      test: (u) => /^https?:\/\/nlog\.daxuesoutijiang\.com\//.test(u) },
    { name: 'hdslb-log', tier: 'low',
      test: (u) => /^https?:\/\/[^/]*hdslb\.com\/.*\/log\//i.test(u) && !STATIC_ASSET.test(u) },
    { name: 'x-report', tier: 'low',
      test: (u) => /^https?:\/\/api\.live\.bilibili\.com\/.*\/report/i.test(u) },
    { name: 'msg-report', tier: 'low',
      test: (u) => /MsgReport/i.test(u) },
    { name: 'heartbeat-http', tier: 'low',
      test: (u) => /\/heart[_/]?beat/i.test(u) },
  ];

  const ruleEnabled = (r) =>
    r.tier === 'analytics' ? CONFIG.blockAnalytics
      : r.tier === 'low' ? CONFIG.blockLowRisk && CONFIG.blockPresenceReport
        : false;

  const blockedRule = (url) => {
    const u = String(url);
    const r = RULES.find((x) => ruleEnabled(x) && x.test(u));
    if (r) log('blocked', r.name, u);
    return r;
  };

  const EMPTY_OK = () => new Response('{"code":0}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  // ══════════════════════════════════════════════════════════
  // fetch（整段安全网：内部异常一律回落原生 fetch）
  // ══════════════════════════════════════════════════════════

  const rawFetch = window.fetch;
  if (rawFetch) {
    window.fetch = function (input, init) {
      try {
        let url = '';
        let body = null;
        let isRequest = false;

        if (typeof input === 'string') {
          url = input;
          body = init && init.body;
        } else if (input && typeof input === 'object') {
          url = input.url || '';
          isRequest = typeof Request !== 'undefined' && input instanceof Request;
          body = init && init.body;
        }

        // 1) 拦截上报（优先于改写：被拦的请求整条丢弃）
        if (blockedRule(url)) return Promise.resolve(EMPTY_OK());

        // 2) 改写
        const newUrl = rewriteUrl(url);
        const newBody = rewriteBody(body);
        const urlChanged = newUrl !== url;
        const bodyChanged = newBody !== null;

        // Request 对象的 body 在对象自身上（init.body 通常为空），必须进入异步分支才检查得到
        if (!urlChanged && !bodyChanged && !isRequest) return rawFetch.apply(this, arguments);

        // 3) Request 对象：异步读 body，只对 JSON 形态改写（防二进制被毁），其余原样放行
        if (isRequest) {
          return (async () => {
            try {
              const method = String((input && input.method) || 'GET').toUpperCase();

              // GET/HEAD：无 body，只需处理 URL 改写
              if (method === 'GET' || method === 'HEAD') {
                if (!urlChanged) return rawFetch.call(this, input, init);
                const req = new Request(newUrl, {
                  method: input.method,
                  headers: input.headers,
                  mode: input.mode,
                  credentials: input.credentials,
                  cache: input.cache,
                  redirect: input.redirect,
                  referrer: input.referrer,
                  integrity: input.integrity,
                });
                return rawFetch.call(this, req, init);
              }

              // 有 body：读文本，仅 JSON 形态参与改写/重建
              let bodyText = null;
              let readFailed = false;
              try { bodyText = await input.clone().text(); }
              catch (_) { readFailed = true; }
              if (readFailed) return rawFetch.call(this, input, init); // 无法安全重建，放行原始

              const rewritten = bodyText ? rewriteJsonText(bodyText) : null;
              const isJsonText = !!bodyText && /^\s*[[{]/.test(bodyText);

              // URL 没变且 body 无需改写 → 原样放行（不重建，零干扰）
              if (!urlChanged && rewritten === null) return rawFetch.call(this, input, init);
              // URL 变了但 body 是非 JSON 形态 → 不重建（防二进制被有损解码毁掉），放行原始
              if (!isJsonText) return rawFetch.call(this, input, init);

              const req = new Request(newUrl, {
                method: input.method,
                headers: input.headers,
                body: rewritten !== null ? rewritten : bodyText,
                mode: input.mode,
                credentials: input.credentials,
                cache: input.cache,
                redirect: input.redirect,
                referrer: input.referrer,
                integrity: input.integrity,
              });
              return rawFetch.call(this, req, init);
            } catch (e) {
              log('request rebuild fallback', e && e.message);
              return rawFetch.call(this, input, init);
            }
          })();
        }

        const nextInit = Object.assign({}, init || {});
        if (bodyChanged) nextInit.body = newBody;
        return rawFetch.call(this, newUrl, nextInit);
      } catch (e) {
        log('fetch fallback', e && e.message);
        return rawFetch.apply(this, arguments);
      }
    };
  }

  // ══════════════════════════════════════════════════════════
  // XMLHttpRequest
  // ══════════════════════════════════════════════════════════

  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const rawOpen = XHR.prototype.open;
    const rawSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      try {
        this.__biliRawUrl = String(url);
        this.__biliUrl = rewriteUrl(this.__biliRawUrl);
        const args = Array.prototype.slice.call(arguments);
        args[1] = this.__biliUrl;
        return rawOpen.apply(this, args);
      } catch (e) {
        log('xhr.open fallback', e && e.message);
        return rawOpen.apply(this, arguments);
      }
    };

    XHR.prototype.send = function (body) {
      try {
        if (blockedRule(this.__biliRawUrl || this.__biliUrl)) {
          const xhr = this;
          setTimeout(() => {
            const text = '{"code":0}';
            Object.defineProperties(xhr, {
              readyState: { value: 4, configurable: true },
              status: { value: 200, configurable: true },
              statusText: { value: 'OK', configurable: true },
              responseText: { value: text, configurable: true },
              response: { value: text, configurable: true },
            });
            xhr.dispatchEvent(new Event('readystatechange'));
            xhr.dispatchEvent(new Event('load'));
            xhr.dispatchEvent(new Event('loadend'));
          }, 0);
          return undefined;
        }

        let newBody = null;
        try { newBody = rewriteBody(body); } catch (_) { newBody = null; }
        if (newBody === null) return rawSend.apply(this, arguments);
        const args = Array.prototype.slice.call(arguments);
        args[0] = newBody;
        return rawSend.apply(this, args);
      } catch (e) {
        log('xhr.send fallback', e && e.message);
        return rawSend.apply(this, arguments);
      }
    };
  }

  // ══════════════════════════════════════════════════════════
  // navigator.sendBeacon
  // ══════════════════════════════════════════════════════════

  if (navigator.sendBeacon) {
    const rawBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      try {
        if (blockedRule(url)) return true;
        const newUrl = rewriteUrl(url);
        let newBody = null;
        try { newBody = rewriteBody(data); } catch (_) { newBody = null; }
        return rawBeacon(newUrl, newBody === null ? data : newBody);
      } catch (e) {
        log('beacon fallback', e && e.message);
        return rawBeacon(url, data);
      }
    };
  }

  // ══════════════════════════════════════════════════════════
  // WebSocket：改写鉴权/心跳帧里的身份字段
  //   ① 纯 JSON 字符串帧 → 返回改写后的字符串
  //   ② 弹幕协议帧（16B 包头 + JSON）：ArrayBuffer / TypedArray /
  //      二进制字符串都支持；改写后按 UTF-8 字节长度重写包头总长，
  //      头长/版本/操作码/序列原样保留，输出 Uint8Array
  // ══════════════════════════════════════════════════════════

  if (CONFIG.rewriteWebSocket && window.WebSocket) {
    const RawWS = window.WebSocket;

    // 二进制字符串 → 字节；含 >0xFF 码元则不是二进制字符串，返回 null
    const strToBytes = (s) => {
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c > 0xff) return null;
        out[i] = c;
      }
      return out;
    };

    const rewriteFrame = (data) => {
      try {
        // ① 纯 JSON 字符串帧
        if (typeof data === 'string') {
          const asJson = rewriteJsonText(data);
          if (asJson !== null) return asJson;
        }

        // ② 统一转字节视图
        let bytes = null;
        if (typeof data === 'string') {
          if (data.length > 16) bytes = strToBytes(data);
        } else if (data && typeof data.byteLength === 'number' && typeof data.slice === 'function') {
          bytes = new Uint8Array(data);                     // ArrayBuffer
        } else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(data)) {
          bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength); // TypedArray
        }
        if (!bytes || bytes.length <= 16) return null;

        const td = new TextDecoder('utf-8', { fatal: false });
        const enc = new TextEncoder();

        // ③ 弹幕协议帧：偏移 16 起 JSON → 改写 + 重写包头总长（大端）
        const newBody = rewriteJsonText(td.decode(bytes.subarray(16)));
        if (newBody !== null) {
          const bodyBytes = enc.encode(newBody);
          const out = new Uint8Array(16 + bodyBytes.length);
          out.set(bytes.subarray(0, 16));                   // 原包头整体保留
          const dv = new DataView(out.buffer);
          dv.setUint32(0, out.length, false);               // 仅重写总长
          out.set(bodyBytes, 16);
          log('ws danmu frame rewritten', newBody.slice(0, 80));
          return out;
        }

        // ④ 整帧是 JSON 的字节形态
        const wholeNew = rewriteJsonText(td.decode(bytes));
        if (wholeNew !== null) return enc.encode(wholeNew);
        return null;
      } catch (e) {
        log('ws frame error', e && e.message);
        return null;
      }
    };

    const Wrapped = function (url, protocols) {
      const ws = protocols === undefined ? new RawWS(url) : new RawWS(url, protocols);
      const rawSend = ws.send.bind(ws);
      ws.send = function (data) {
        let next = null;
        try { next = rewriteFrame(data); } catch (_) { next = null; }
        return rawSend(next === null ? data : next);
      };
      return ws;
    };
    Wrapped.prototype = RawWS.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Wrapped[k] = RawWS[k];
    window.WebSocket = Wrapped;
  }

  // ══════════════════════════════════════════════════════════
  // 运行期开关
  // ══════════════════════════════════════════════════════════

  window.__BILI_INVISIBLE__ = {
    version: '2.1.0',
    config: CONFIG,
    targetRoomId: TARGET_ROOM_ID,
    rules: RULES.map((r) => ({ name: r.name, tier: r.tier })),
    set(key, value) {
      if (key in CONFIG) CONFIG[key] = value;
      return CONFIG;
    },
    // 供测试/排查：手动改写一个对象
    rewriteObject(obj) {
      return applyRewrites({
        has: (k) => Object.prototype.hasOwnProperty.call(obj, k),
        del: (k) => { delete obj[k]; },
        set: (k, v) => { obj[k] = v; },
        tag: 'manual',
      });
    },
  };
})();
