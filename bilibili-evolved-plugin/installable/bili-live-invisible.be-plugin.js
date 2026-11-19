/**
 * Bilibili-Evolved 用户插件 · 直播隐身观看（biliLiveInvisible）
 *
 * 安装方式：BE 设置面板 → 插件 → 安装插件，把本文件全文粘贴进去。
 * （也可通过 BE 的「从 URL 安装」使用 raw 地址）
 *
 * 功能：
 *   1) 屏蔽统计/埋点/追踪上报（规则经 367 条真实抓包实测：遥测 26/26、误伤 0）
 *   2) 按 BiliLiveInvisible（lzghzr 的 Xposed 模块）语义改写身份字段：
 *      R1 含 is_anchor|hb|heart_beat → 删 access_key
 *      R2 含 not_mock_enter_effect   → room_id → "273022"（仅当键已存在）
 *      R3 含 uid 且含 group          → uid → 0
 *   覆盖 fetch / XHR / sendBeacon / WebSocket（含弹幕协议二进制帧），带兜底安全网。
 *
 * ⚠️ 插件在 BE 核心初始化后才安装拦截，BE 启动前的首屏请求无法覆盖；
 *    签名参数（w_rid/wts/csrf）不重算。仅供学习研究。
 * 仓库：https://github.com/xly2333/bili-live-invisible
 */
(() => {
  const R1_TRIGGERS = ['is_anchor', 'hb', 'heart_beat']
  const R2_TRIGGER = 'not_mock_enter_effect'
  const R3_KEY = 'uid'
  const R3_GATE = 'group'
  const TARGET_ROOM_ID = '273022'
  const DEBUG = false
  const log = (...a) => { if (DEBUG) console.info('[bili-live-invisible]', ...a) }

  function applyRewrites({ has, del, set, tag }) {
    const hits = []
    const trigger = R1_TRIGGERS.find(k => has(k))
    if (trigger && has('access_key')) { del('access_key'); hits.push(`R1(${trigger})`) }
    if (has(R2_TRIGGER) && has('room_id')) { set('room_id', TARGET_ROOM_ID); hits.push('R2') }
    if (has(R3_KEY) && has(R3_GATE)) { set(R3_KEY, 0); hits.push('R3') }
    if (hits.length) log(tag, hits.join('+'))
    return hits
  }

  function rewriteUrl(rawUrl) {
    let u
    try { u = new URL(rawUrl, location.href) } catch (_) { return rawUrl }
    const sp = u.searchParams
    if (![...sp.keys()].length) return rawUrl
    const hits = applyRewrites({
      has: k => sp.has(k), del: k => sp.delete(k), set: (k, v) => sp.set(k, String(v)),
      tag: 'url ' + u.pathname,
    })
    return hits.length ? u.toString() : rawUrl
  }

  function rewriteJsonText(text) {
    let obj
    try { obj = JSON.parse(text) } catch (_) { return null }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    const hits = applyRewrites({
      has: k => Object.prototype.hasOwnProperty.call(obj, k),
      del: k => { delete obj[k] },
      set: (k, v) => { obj[k] = v },
      tag: 'json',
    })
    return hits.length ? JSON.stringify(obj) : null
  }

  function rewriteFormText(text) {
    if (!/^[^=&\s]+=/.test(text)) return null
    let sp
    try { sp = new URLSearchParams(text) } catch (_) { return null }
    if (![...sp.keys()].length) return null
    const hits = applyRewrites({
      has: k => sp.has(k), del: k => sp.delete(k), set: (k, v) => sp.set(k, String(v)),
      tag: 'form',
    })
    return hits.length ? sp.toString() : null
  }

  function rewriteBody(body) {
    if (body == null) return null
    if (typeof body === 'string') return rewriteJsonText(body) || rewriteFormText(body)
    if (body instanceof URLSearchParams) {
      const hits = applyRewrites({
        has: k => body.has(k), del: k => body.delete(k), set: (k, v) => body.set(k, String(v)),
        tag: 'urlsearchparams',
      })
      return hits.length ? body : null
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const hits = applyRewrites({
        has: k => body.has(k), del: k => body.delete(k), set: (k, v) => body.set(k, String(v)),
        tag: 'formdata',
      })
      return hits.length ? body : null
    }
    return null
  }

  const STATIC_ASSET = /\.(js|css|png|jpe?g|gif|webp|svg|ico|ttf|woff2?|eot|svga|mp4|m4s|m3u8|wasm|map)(\?|#|$)/i
  const RULES = [
    { name: 'bili-data-log', test: u => /^https?:\/\/data\.bilibili\.com\//.test(u) },
    { name: 'bilivideo-data-log', test: u => /^https?:\/\/data\.bilivideo\.com\//.test(u) },
    { name: 'live-trace', test: u => /^https?:\/\/live-trace\.bilibili\.com\//.test(u) },
    { name: 'tracker-conf', test: u => /^https?:\/\/api\.live\.bilibili\.com\/xlive\/open-interface\/v2\/tracker\//.test(u) },
    { name: 'rum-collect', test: u => /^https?:\/\/rumt-zh\.com\/collect\//.test(u) },
    { name: 'third-party-log', test: u => /^https?:\/\/nlog\.daxuesoutijiang\.com\//.test(u) },
    { name: 'hdslb-log', test: u => /^https?:\/\/[^/]*hdslb\.com\/.*\/log\//i.test(u) && !STATIC_ASSET.test(u) },
    { name: 'x-report', test: u => /^https?:\/\/api\.live\.bilibili\.com\/.*\/report/i.test(u) },
    { name: 'msg-report', test: u => /MsgReport/i.test(u) },
    { name: 'heartbeat-http', test: u => /\/heart[_/]?beat/i.test(u) },
  ]
  const blockedRule = url => RULES.find(x => x.test(String(url)))
  const emptyOk = () => new Response('{"code":0}', { status: 200, headers: { 'Content-Type': 'application/json' } })

  function install() {
    // ── fetch ──
    const rawFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      try {
        let url = ''
        let body = null
        let isRequest = false
        if (typeof input === 'string') { url = input; body = init && init.body } else if (input && typeof input === 'object') { url = input.url || ''; isRequest = input instanceof Request; body = init && init.body }
        if (blockedRule(url)) return emptyOk()
        const newUrl = rewriteUrl(url)
        const newBody = rewriteBody(body)
        const urlChanged = newUrl !== url
        const bodyChanged = newBody !== null
        if (!urlChanged && !bodyChanged && !isRequest) return rawFetch(input, init)
        if (isRequest) {
          const req = input
          const method = String(req.method || 'GET').toUpperCase()
          if (method === 'GET' || method === 'HEAD') {
            if (!urlChanged) return rawFetch(req, init)
            return rawFetch(new Request(newUrl, { method: req.method, headers: req.headers, mode: req.mode, credentials: req.credentials, cache: req.cache, redirect: req.redirect, referrer: req.referrer, integrity: req.integrity }), init)
          }
          let bodyText = null
          let readFailed = false
          try { bodyText = await req.clone().text() } catch (_) { readFailed = true }
          if (readFailed) return rawFetch(req, init)
          const rewritten = bodyText ? rewriteJsonText(bodyText) : null
          const isJsonText = !!bodyText && /^\s*[[{]/.test(bodyText)
          if (!urlChanged && rewritten === null) return rawFetch(req, init)
          if (!isJsonText) return rawFetch(req, init)
          return rawFetch(new Request(newUrl, { method: req.method, headers: req.headers, body: rewritten !== null ? rewritten : bodyText, mode: req.mode, credentials: req.credentials, cache: req.cache, redirect: req.redirect, referrer: req.referrer, integrity: req.integrity }), init)
        }
        const nextInit = Object.assign({}, init || {})
        if (bodyChanged) nextInit.body = newBody
        return rawFetch(newUrl, nextInit)
      } catch (e) {
        log('fetch fallback', e)
        return rawFetch(input, init)
      }
    }

    // ── XMLHttpRequest ──
    const XHR = window.XMLHttpRequest
    if (XHR) {
      const rawOpen = XHR.prototype.open
      const rawSend = XHR.prototype.send
      XHR.prototype.open = function (method, url, ...rest) {
        try {
          this.__biliRawUrl = String(url)
          return rawOpen.apply(this, [method, rewriteUrl(this.__biliRawUrl), ...rest])
        } catch (e) {
          log('xhr.open fallback', e)
          return rawOpen.apply(this, [method, url, ...rest])
        }
      }
      XHR.prototype.send = function (body) {
        try {
          if (blockedRule(this.__biliRawUrl || '')) {
            const xhr = this
            setTimeout(() => {
              const text = '{"code":0}'
              Object.defineProperties(xhr, {
                readyState: { value: 4, configurable: true },
                status: { value: 200, configurable: true },
                statusText: { value: 'OK', configurable: true },
                responseText: { value: text, configurable: true },
                response: { value: text, configurable: true },
              })
              xhr.dispatchEvent(new Event('readystatechange'))
              xhr.dispatchEvent(new Event('load'))
              xhr.dispatchEvent(new Event('loadend'))
            }, 0)
            return
          }
          let newBody = null
          try { newBody = rewriteBody(body) } catch (_) { newBody = null }
          if (newBody === null) return rawSend.call(this, body)
          return rawSend.call(this, newBody)
        } catch (e) {
          log('xhr.send fallback', e)
          return rawSend.call(this, body)
        }
      }
    }

    // ── navigator.sendBeacon ──
    if (navigator.sendBeacon) {
      const rawBeacon = navigator.sendBeacon.bind(navigator)
      navigator.sendBeacon = (url, data) => {
        try {
          if (blockedRule(String(url))) return true
          const newUrl = rewriteUrl(String(url))
          let newBody = null
          try { newBody = rewriteBody(data) } catch (_) { newBody = null }
          return rawBeacon(newUrl, newBody === null ? data : newBody)
        } catch (e) {
          log('beacon fallback', e)
          return rawBeacon(url, data)
        }
      }
    }

    // ── WebSocket（含弹幕协议二进制帧）──
    const RawWS = window.WebSocket
    if (RawWS) {
      const strToBytes = s => {
        const out = new Uint8Array(s.length)
        for (let i = 0; i < s.length; i++) {
          const c = s.charCodeAt(i)
          if (c > 0xff) return null
          out[i] = c
        }
        return out
      }
      const rewriteFrame = data => {
        try {
          if (typeof data === 'string') {
            const asJson = rewriteJsonText(data)
            if (asJson !== null) return asJson
          }
          let bytes = null
          if (typeof data === 'string') {
            if (data.length > 16) bytes = strToBytes(data)
          } else if (data && typeof data.byteLength === 'number' && typeof data.slice === 'function') {
            bytes = new Uint8Array(data)
          } else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(data)) {
            bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          }
          if (!bytes || bytes.length <= 16) return null
          const td = new TextDecoder('utf-8')
          const enc = new TextEncoder()
          const newBody = rewriteJsonText(td.decode(bytes.subarray(16)))
          if (newBody !== null) {
            const bodyBytes = enc.encode(newBody)
            const out = new Uint8Array(16 + bodyBytes.length)
            out.set(bytes.subarray(0, 16))
            new DataView(out.buffer).setUint32(0, out.length, false)
            out.set(bodyBytes, 16)
            log('ws danmu frame rewritten', newBody.slice(0, 80))
            return out
          }
          const wholeNew = rewriteJsonText(td.decode(bytes))
          if (wholeNew !== null) return enc.encode(wholeNew)
          return null
        } catch (e) {
          log('ws frame error', e)
          return null
        }
      }
      const Wrapped = function (url, protocols) {
        const ws = protocols === undefined ? new RawWS(url) : new RawWS(url, protocols)
        const rawSend = ws.send.bind(ws)
        ws.send = data => {
          let next = null
          try { next = rewriteFrame(data) } catch (_) { next = null }
          return rawSend(next === null ? data : next)
        }
        return ws
      }
      Wrapped.prototype = RawWS.prototype
      Wrapped.CONNECTING = RawWS.CONNECTING
      Wrapped.OPEN = RawWS.OPEN
      Wrapped.CLOSING = RawWS.CLOSING
      Wrapped.CLOSED = RawWS.CLOSED
      window.WebSocket = Wrapped
    }

    window.__BILI_INVISIBLE__ = { version: '2.1.0-be', config: { DEBUG } }
  }

  return {
    name: 'biliLiveInvisible',
    displayName: '直播隐身观看',
    author: [{ name: 'xly2333', link: 'https://github.com/xly2333' }],
    setup: () => install(),
  }
})()
