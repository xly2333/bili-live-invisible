/**
 * Bilibili Evolved 插件 · 直播隐身观看 · 完整版 (live.invisibleView.full)
 *
 * ⚠️ 本文件不进 Bilibili Evolved 官方功能库（其贡献范围不接受绕过账号限制类功能），
 *    仅以 URL 安装方式在 BE 中手动添加: 组件管理 → 从 URL 安装 → 本文件的直链。
 *    与官方收录的 `live.invisibleView`（纯上报拦截）装其一会自动去重, 不会双重打补丁。
 *
 * 构建形态: UMD (libraryExport: 'plugin'), 与官方 webpack 产物加载语义一致。
 * 引擎与独立用户脚本 v2.1.0 完全同源: https://github.com/xly2333/bili-live-invisible
 *
 *   [R1] 集合含 is_anchor | hb | heart_beat   → remove("access_key")
 *   [R2] 集合含 not_mock_enter_effect         → replace("room_id", "273022")  仅当键存在
 *   [R3] 集合含 uid 且含 group                → uid := 0
 */
!function (root, factory) {
  if (typeof exports === 'object' && typeof module === 'object') { module.exports = factory() }
  else if (typeof define === 'function' && define.amd) { define([], factory) }
  else if (typeof exports === 'object') { exports['live/bili-live-invisible-full'] = factory() }
  else { root['live/bili-live-invisible-full'] = factory() }
}(globalThis, function () {
  'use strict';

  function installInvisible(pageWindow) {
    if (!pageWindow || pageWindow.__BILI_INVISIBLE__) return false;

    var W = pageWindow;
    var URLC = W.URL;
    var RequestC = W.Request;
    var ResponseC = W.Response;
    var USPC = W.URLSearchParams;
    var FDC = W.FormData;
    var EventC = W.Event;
    var XHRC = W.XMLHttpRequest;

    var CONFIG = {
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
    var TARGET_ROOM_ID = '273022';

    var R1_TRIGGERS = ['is_anchor', 'hb', 'heart_beat'];
    var R2_TRIGGER = 'not_mock_enter_effect';
    var R3_KEY = 'uid';
    var R3_GATE = 'group';

    var log = function () {
      if (CONFIG.debug) console.info.apply(console, ['[bili-rewrite]'].concat([].slice.call(arguments)));
    };

    // ════════════════════════════════════════════════════════
    // 通用：对「键值对集合」应用三处改写
    // ════════════════════════════════════════════════════════

    function applyRewrites(hooks) {
      var hits = [];

      // R1: 含 is_anchor / hb / heart_beat → 删 access_key
      if (CONFIG.rewriteAccessKey) {
        var trigger = null;
        for (var i = 0; i < R1_TRIGGERS.length; i++) {
          if (hooks.has(R1_TRIGGERS[i])) { trigger = R1_TRIGGERS[i]; break; }
        }
        if (trigger && hooks.has('access_key')) {
          hooks.del('access_key');
          hits.push('R1(' + trigger + ')');
        }
      }

      // R2: 含 not_mock_enter_effect → room_id = 273022（仅当 room_id 已存在）
      if (CONFIG.rewriteRoomId) {
        if (hooks.has(R2_TRIGGER) && hooks.has('room_id')) {
          hooks.set('room_id', TARGET_ROOM_ID);
          hits.push('R2');
        }
      }

      // R3: uid 且集合含 group → uid = 0
      if (CONFIG.rewriteUid) {
        if (hooks.has(R3_KEY) && hooks.has(R3_GATE)) {
          hooks.set(R3_KEY, 0);
          hits.push('R3');
        }
      }

      if (hits.length) log(hooks.tag, hits.join('+'));
      return hits;
    }

    // ════════════════════════════════════════════════════════
    // URL query 层
    // ════════════════════════════════════════════════════════

    function rewriteUrl(rawUrl) {
      if (!CONFIG.rewriteAccessKey && !CONFIG.rewriteRoomId && !CONFIG.rewriteUid) return rawUrl;
      var u;
      try { u = new URLC(rawUrl, W.location && W.location.href); } catch (e) { return rawUrl; }
      var sp = u.searchParams;
      if ([...sp.keys()].length === 0) return rawUrl;

      var hits = applyRewrites({
        has: function (k) { return sp.has(k); },
        del: function (k) { sp.delete(k); },
        set: function (k, v) { sp.set(k, String(v)); },
        tag: 'url ' + u.pathname,
      });
      if (!hits.length) return rawUrl;
      return u.toString();
    }

    // ════════════════════════════════════════════════════════
    // Body 层：JSON / 表单 / URLSearchParams / FormData
    // ════════════════════════════════════════════════════════

    function rewriteJsonText(text) {
      var obj;
      try { obj = JSON.parse(text); } catch (e) { return null; }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

      var hits = applyRewrites({
        has: function (k) { return Object.prototype.hasOwnProperty.call(obj, k); },
        del: function (k) { delete obj[k]; },
        set: function (k, v) { obj[k] = v; },
        tag: 'json',
      });
      return hits.length ? JSON.stringify(obj) : null;
    }

    function rewriteFormText(text) {
      if (typeof text !== 'string' || !/^[^=&\s]+=/.test(text)) return null;
      var sp;
      try { sp = new USPC(text); } catch (e) { return null; }
      if ([...sp.keys()].length === 0) return null;

      var hits = applyRewrites({
        has: function (k) { return sp.has(k); },
        del: function (k) { sp.delete(k); },
        set: function (k, v) { sp.set(k, String(v)); },
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
      if (USPC && body instanceof USPC) {
        var hits1 = applyRewrites({
          has: function (k) { return body.has(k); },
          del: function (k) { body.delete(k); },
          set: function (k, v) { body.set(k, String(v)); },
          tag: 'urlsearchparams',
        });
        return hits1.length ? body : null;
      }
      if (FDC && body instanceof FDC) {
        var hits2 = applyRewrites({
          has: function (k) { return body.has(k); },
          del: function (k) { body.delete(k); },
          set: function (k, v) { body.set(k, String(v)); },
          tag: 'formdata',
        });
        return hits2.length ? body : null;
      }
      return null;
    }

    // ════════════════════════════════════════════════════════
    // 上报拦截（实测口径：367 条 HAR，遥测 26/26，误伤 0）
    // ════════════════════════════════════════════════════════

    var STATIC_ASSET = /\.(js|css|png|jpe?g|gif|webp|svg|ico|ttf|woff2?|eot|svga|mp4|m4s|m3u8|wasm|map)(\?|#|$)/i;

    var RULES = [
      { name: 'bili-data-log', tier: 'analytics',
        test: function (u) { return /^https?:\/\/data\.bilibili\.com\//.test(u); } },
      { name: 'bilivideo-data-log', tier: 'analytics',
        test: function (u) { return /^https?:\/\/data\.bilivideo\.com\//.test(u); } },
      { name: 'live-trace', tier: 'analytics',
        test: function (u) { return /^https?:\/\/live-trace\.bilibili\.com\//.test(u); } },
      { name: 'tracker-conf', tier: 'low',
        test: function (u) { return /^https?:\/\/api\.live\.bilibili\.com\/xlive\/open-interface\/v2\/tracker\//.test(u); } },
      { name: 'rum-collect', tier: 'analytics',
        test: function (u) { return /^https?:\/\/rumt-zh\.com\/collect\//.test(u); } },
      { name: 'third-party-log', tier: 'analytics',
        test: function (u) { return /^https?:\/\/nlog\.daxuesoutijiang\.com\//.test(u); } },
      { name: 'hdslb-log', tier: 'low',
        test: function (u) { return /^https?:\/\/[^/]*hdslb\.com\/.*\/log\//i.test(u) && !STATIC_ASSET.test(u); } },
      { name: 'x-report', tier: 'low',
        test: function (u) { return /^https?:\/\/api\.live\.bilibili\.com\/.*\/report/i.test(u); } },
      { name: 'msg-report', tier: 'low',
        test: function (u) { return /MsgReport/i.test(u); } },
      { name: 'heartbeat-http', tier: 'low',
        test: function (u) { return /\/heart[_/]?beat/i.test(u); } },
    ];

    var ruleEnabled = function (r) {
      return r.tier === 'analytics' ? CONFIG.blockAnalytics
        : r.tier === 'low' ? CONFIG.blockLowRisk && CONFIG.blockPresenceReport
          : false;
    };

    var blockedRule = function (url) {
      var u = String(url);
      var r = null;
      for (var i = 0; i < RULES.length; i++) {
        if (ruleEnabled(RULES[i]) && RULES[i].test(u)) { r = RULES[i]; break; }
      }
      if (r) log('blocked', r.name, u);
      return r;
    };

    var EMPTY_OK = function () {
      return new ResponseC('{"code":0}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    // ════════════════════════════════════════════════════════
    // fetch（整段安全网：内部异常一律回落原生 fetch）
    // ════════════════════════════════════════════════════════

    var rawFetch = W.fetch;
    if (typeof rawFetch === 'function') {
      W.fetch = function (input, init) {
        try {
          var url = '';
          var body = null;
          var isRequest = false;

          if (typeof input === 'string') {
            url = input;
            body = init && init.body;
          } else if (input && typeof input === 'object') {
            url = input.url || '';
            isRequest = typeof RequestC === 'function' && input instanceof RequestC;
            body = init && init.body;
          }

          // 1) 拦截上报（优先于改写：被拦的请求整条丢弃）
          if (blockedRule(url)) return Promise.resolve(EMPTY_OK());

          // 2) 改写
          var newUrl = rewriteUrl(url);
          var newBody = rewriteBody(body);
          var urlChanged = newUrl !== url;
          var bodyChanged = newBody !== null;

          // Request 对象的 body 在对象自身上（init.body 通常为空），必须进入异步分支才检查得到
          if (!urlChanged && !bodyChanged && !isRequest) return rawFetch.apply(this, arguments);

          var self = this;
          // 3) Request 对象：异步读 body，只对 JSON 形态改写（防二进制被毁），其余原样放行
          if (isRequest) {
            return (async function () {
              try {
                var method = String((input && input.method) || 'GET').toUpperCase();

                // GET/HEAD：无 body，只需处理 URL 改写
                if (method === 'GET' || method === 'HEAD') {
                  if (!urlChanged) return rawFetch.call(self, input, init);
                  var reqGet = new RequestC(newUrl, {
                    method: input.method,
                    headers: input.headers,
                    mode: input.mode,
                    credentials: input.credentials,
                    cache: input.cache,
                    redirect: input.redirect,
                    referrer: input.referrer,
                    integrity: input.integrity,
                  });
                  return rawFetch.call(self, reqGet, init);
                }

                // 有 body：读文本，仅 JSON 形态参与改写/重建
                var bodyText = null;
                var readFailed = false;
                try { bodyText = await input.clone().text(); }
                catch (e) { readFailed = true; }
                if (readFailed) return rawFetch.call(self, input, init); // 无法安全重建，放行原始

                var rewritten = bodyText ? rewriteJsonText(bodyText) : null;
                var isJsonText = !!bodyText && /^\s*[[{]/.test(bodyText);

                // URL 没变且 body 无需改写 → 原样放行（不重建，零干扰）
                if (!urlChanged && rewritten === null) return rawFetch.call(self, input, init);
                // URL 变了但 body 是非 JSON 形态 → 不重建（防二进制被有损解码毁掉），放行原始
                if (!isJsonText) return rawFetch.call(self, input, init);

                var req = new RequestC(newUrl, {
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
                return rawFetch.call(self, req, init);
              } catch (e) {
                log('request rebuild fallback', e && e.message);
                return rawFetch.call(self, input, init);
              }
            })();
          }

          var nextInit = Object.assign({}, init || {});
          if (bodyChanged) nextInit.body = newBody;
          return rawFetch.call(self, newUrl, nextInit);
        } catch (e) {
          log('fetch fallback', e && e.message);
          return rawFetch.apply(this, arguments);
        }
      };
    }

    // ════════════════════════════════════════════════════════
    // XMLHttpRequest
    // ════════════════════════════════════════════════════════

    if (XHRC && XHRC.prototype) {
      var rawOpen = XHRC.prototype.open;
      var rawSend = XHRC.prototype.send;

      XHRC.prototype.open = function (method, url) {
        try {
          this.__biliRawUrl = String(url);
          this.__biliUrl = rewriteUrl(this.__biliRawUrl);
          var args1 = [].slice.call(arguments);
          args1[1] = this.__biliUrl;
          return rawOpen.apply(this, args1);
        } catch (e) {
          log('xhr.open fallback', e && e.message);
          return rawOpen.apply(this, arguments);
        }
      };

      XHRC.prototype.send = function (body) {
        try {
          if (blockedRule(this.__biliRawUrl || this.__biliUrl)) {
            var xhr = this;
            setTimeout(function () {
              var text = '{"code":0}';
              Object.defineProperties(xhr, {
                readyState: { value: 4, configurable: true },
                status: { value: 200, configurable: true },
                statusText: { value: 'OK', configurable: true },
                responseText: { value: text, configurable: true },
                response: { value: text, configurable: true },
              });
              xhr.dispatchEvent(new EventC('readystatechange'));
              xhr.dispatchEvent(new EventC('load'));
              xhr.dispatchEvent(new EventC('loadend'));
            }, 0);
            return undefined;
          }

          var newBody = null;
          try { newBody = rewriteBody(body); } catch (e) { newBody = null; }
          if (newBody === null) return rawSend.apply(this, arguments);
          var args2 = [].slice.call(arguments);
          args2[0] = newBody;
          return rawSend.apply(this, args2);
        } catch (e) {
          log('xhr.send fallback', e && e.message);
          return rawSend.apply(this, arguments);
        }
      };
    }

    // ════════════════════════════════════════════════════════
    // navigator.sendBeacon
    // ════════════════════════════════════════════════════════

    if (W.navigator && typeof W.navigator.sendBeacon === 'function') {
      var rawBeacon = W.navigator.sendBeacon.bind(W.navigator);
      W.navigator.sendBeacon = function (url, data) {
        try {
          if (blockedRule(url)) return true;
          var newUrl = rewriteUrl(url);
          var newBody = null;
          try { newBody = rewriteBody(data); } catch (e) { newBody = null; }
          return rawBeacon(newUrl, newBody === null ? data : newBody);
        } catch (e) {
          log('beacon fallback', e && e.message);
          return rawBeacon(url, data);
        }
      };
    }

    // ════════════════════════════════════════════════════════
    // WebSocket：改写鉴权/心跳帧里的身份字段
    //   ① 纯 JSON 字符串帧 → 返回改写后的字符串
    //   ② 弹幕协议帧（16B 包头 + JSON）：ArrayBuffer / TypedArray /
    //      二进制字符串都支持；改写后按 UTF-8 字节长度重写包头总长，
    //      头长/版本/操作码/序列原样保留，输出 Uint8Array
    // ════════════════════════════════════════════════════════

    if (CONFIG.rewriteWebSocket && W.WebSocket) {
      var RawWS = W.WebSocket;

      // 二进制字符串 → 字节；含 >0xFF 码元则不是二进制字符串，返回 null
      var strToBytes = function (s) {
        var out = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) {
          var c = s.charCodeAt(i);
          if (c > 0xff) return null;
          out[i] = c;
        }
        return out;
      };

      var rewriteFrame = function (data) {
        try {
          // ① 纯 JSON 字符串帧
          if (typeof data === 'string') {
            var asJson = rewriteJsonText(data);
            if (asJson !== null) return asJson;
          }

          // ② 统一转字节视图
          var bytes = null;
          if (typeof data === 'string') {
            if (data.length > 16) bytes = strToBytes(data);
          } else if (data && typeof data.byteLength === 'number' && typeof data.slice === 'function') {
            bytes = new Uint8Array(data);                     // ArrayBuffer
          } else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(data)) {
            bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength); // TypedArray
          }
          if (!bytes || bytes.length <= 16) return null;

          var td = new TextDecoder('utf-8', { fatal: false });
          var enc = new TextEncoder();

          // ③ 弹幕协议帧：偏移 16 起 JSON → 改写 + 重写包头总长（大端）
          var newBody = rewriteJsonText(td.decode(bytes.subarray(16)));
          if (newBody !== null) {
            var bodyBytes = enc.encode(newBody);
            var out = new Uint8Array(16 + bodyBytes.length);
            out.set(bytes.subarray(0, 16));                   // 原包头整体保留
            var dv = new DataView(out.buffer);
            dv.setUint32(0, out.length, false);               // 仅重写总长
            out.set(bodyBytes, 16);
            log('ws danmu frame rewritten', newBody.slice(0, 80));
            return out;
          }

          // ④ 整帧是 JSON 的字节形态
          var wholeNew = rewriteJsonText(td.decode(bytes));
          if (wholeNew !== null) return enc.encode(wholeNew);
          return null;
        } catch (e) {
          log('ws frame error', e && e.message);
          return null;
        }
      };

      var Wrapped = function (url, protocols) {
        var ws = protocols === undefined ? new RawWS(url) : new RawWS(url, protocols);
        var rawWsSend = ws.send.bind(ws);
        ws.send = function (data) {
          var next = null;
          try { next = rewriteFrame(data); } catch (e) { next = null; }
          return rawWsSend(next === null ? data : next);
        };
        return ws;
      };
      Wrapped.prototype = RawWS.prototype;
      var WS_KEYS = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
      for (var k = 0; k < WS_KEYS.length; k++) Wrapped[WS_KEYS[k]] = RawWS[WS_KEYS[k]];
      W.WebSocket = Wrapped;
    }

    // ════════════════════════════════════════════════════════
    // 运行期开关
    // ════════════════════════════════════════════════════════

    W.__BILI_INVISIBLE__ = {
      version: '2.1.0-be-full.1',
      config: CONFIG,
      targetRoomId: TARGET_ROOM_ID,
      rules: RULES.map(function (r) { return { name: r.name, tier: r.tier }; }),
      set: function (key, value) {
        if (key in CONFIG) CONFIG[key] = value;
        return CONFIG;
      },
      // 供测试/排查：手动改写一个对象
      rewriteObject: function (obj) {
        return applyRewrites({
          has: function (k) { return Object.prototype.hasOwnProperty.call(obj, k); },
          del: function (k) { delete obj[k]; },
          set: function (k, v) { obj[k] = v; },
          tag: 'manual',
        });
      },
    };

    return true;
  }

  return {
    name: 'live.invisibleView.full',
    displayName: '直播隐身观看 · 完整版',
    description: '上报拦截 + 身份字段改写 (R1/R2/R3). 不在官方功能库收录范围, 请从作者仓库以 URL 方式安装.',
    author: { name: 'xly2333', link: 'https://github.com/xly2333' },
    async setup() {
      // BE 运行在 userscript sandbox 中, 必须通过 unsafeWindow 打页面补丁;
      // 独立运行 (直接 eval / 手动安装) 时回落到当前 window
      var pageWindow =
        (typeof unsafeWindow !== 'undefined' && unsafeWindow) ||
        (typeof window !== 'undefined' && window) ||
        globalThis;
      installInvisible(pageWindow);
    },
  };
});
