# 代码审核记录（v2.0.0 → v2.1.0）

审核对象：`bili-live-invisible.user.js` 全文（4 个拦截通道 + 3 处改写 + 规则表）。
方法：逐行人工审读 + vm 沙箱真实执行 + 28 条用例回归。

## 发现并修复

| # | 严重度 | 问题 | 修复 |
| --- | --- | --- | --- |
| 1 | P1 | **WS 二进制帧完全未覆盖**：`rewriteFrame` 只处理 string，而弹幕协议实际发 ArrayBuffer/TypedArray（auth 帧即二进制），R3 最可能的载体恰好在此 | 统一转字节视图，支持 ArrayBuffer / TypedArray / 二进制字符串；改写后按 **UTF-8 字节长度** 重写包头总长（原实现用字符串长度，多字节内容会算错导致服务端丢帧），操作码/序列原样保留，输出 `Uint8Array` |
| 2 | P1 | **包头构造含死代码**：`dv.setUint32(8, dv.getUint32(8,false), false)` 对零缓冲读写无意义，随后又被覆盖 | 删除；改为保留原包头 16 字节、仅重写总长字段 |
| 3 | P2 | **Request 对象 body 改写是空话**：`isRequest` 分支只从 `init.body` 取值，走 `new Request(url,{body})` 的调用拿不到；且短路判断 `!urlChanged && !bodyChanged` 在异步分支之前放行，JSON body 永远读不到 | `isRequest` 时强制进入异步分支：`clone().text()` 读 body，仅对 JSON 形态改写；URL 无变化且 body 无需改写时零干扰放行 |
| 4 | P2 | **二进制 body 毁包风险**：`Request.clone().text()` 对二进制 body 有损解码，直接重建会破坏请求 | 形态门卫：仅 `JSON.parse` 成功或 `^\s*[[{]` 开头的文本参与重建；其他形态整体回落原始 Request |
| 5 | P2 | **无兜底安全网**：改写逻辑任何一处抛异常都会让页面请求直接失败 | 四通道逐层 try/catch，异常一律回落原生行为 |
| 6 | P3 | **@match 多余**：`api.live.bilibili.com` 只在直接导航 API URL 时生效 | 移除，仅保留 `live.bilibili.com/*` |

## 审读后保持不变（有意为之）

- **拦截优先于改写**：被上报规则命中的请求整条丢弃，不进入改写流程（有专项用例固定此行为）。
- **R2 的 `replace` 语义**：`room_id` 键不存在时不新建（区别于 `put`，有专项用例）。
- **R3 的双键门控**：`uid` 与 `group` 同时存在才改写。
- XHR 被拦时以 `Object.defineProperties` 伪造 200 响应：保持 v2.0.0 行为（`responseType='json'` 等场景未覆盖，见下）。

## 已知限制

| 限制 | 说明 |
| --- | --- |
| 签名不重算 | `w_rid`/`wts`/`csrf` 与改写后的参数可能不匹配，服务端校验会拒绝 |
| `Blob` WS 帧未处理 | 异步读取与 `send` 同步语义冲突；弹幕实际用 ArrayBuffer，已覆盖 |
| XHR `responseType` | 伪造响应只写 `responseText`/`response` 文本，`responseType='json'` 场景靠 `response` 兜底 |
| 表单启发式 | `rewriteFormText` 依赖 `xxx=` 形态判断，非标准 body 可能漏判（JSON 优先，先试 JSON 再试表单） |

## 测试

| 套件 | 数量 | 结果 |
| --- | ---: | --- |
| v2.0.0 语义回归（R1/R2/R3、四通道、拦截交互） | 19 | 19/19 |
| v2.1.0 新增（二进制 WS ×4、Request body ×3、表单/URLSearchParams ×2） | 9 | 9/9 |
| 上报拦截（两版 HAR 全量 URL 417+367 条） | — | 遥测 26/26，误伤 0 |

## 隐私说明

本仓库不包含任何抓包产物（HAR、DEX 分析、证据包）——其中含真实 uid、`csrf`、`buvid` 等个人标识。测试用例全部使用假 uid（10001）/ 假房间号（1024）。
