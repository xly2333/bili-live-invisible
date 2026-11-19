# bili-live-invisible

B 站直播间网页脚本（Tampermonkey / Violentmonkey 用户脚本），两层能力：

1. **上报拦截** —— 屏蔽统计/埋点/追踪请求。规则表基于 367 条真实抓包（HAR）逐条实测：**遥测 26/26 全拦，误伤 0**。
2. **身份字段改写** —— 按 [BiliLiveInvisible](https://github.com/lzghzr/bilibili-live-invisible)（Xposed 模块）的语义，改写 `access_key` / `room_id` / `uid` 三个身份字段（R1/R2/R3），**28 条沙箱用例全过**。

> ⚠️ 仅供学习研究，使用即代表你自行承担账号风险。同一公开直播流不登录（无痕窗口）本就可看——本脚本只是把「游客化」自动化了，并非解锁受限内容。

## 安装

1. 安装 Tampermonkey（或 Violentmonkey）。
2. 新建脚本，粘贴 `bili-live-invisible.user.js` 全文，保存。
3. 打开 `https://live.bilibili.com/<房间号>`，自动生效。

## 三处身份字段改写

语义逐条对齐 BiliLiveInvisible 的反编译结果：

| 编号 | 触发条件 | 动作 | 原模块逻辑 |
| --- | --- | --- | --- |
| **R1** | 集合含 `is_anchor` \| `hb` \| `heart_beat` | 删除 `access_key` | `map.remove("access_key")` |
| **R2** | 集合含 `not_mock_enter_effect` | `room_id` → `"273022"`（**仅当键已存在**，`replace` 语义） | `map.replace("room_id","273022")` |
| **R3** | 集合含 `uid` **且** 含 `group` | `uid` → `0` | fastjson `put` 拦截，`args[1]=0` |

原模块挂在 `addCommonParam(Map)` 与 fastjson `JSONObject.put`；网页端没有这两个函数，等价落点是**所有出站请求的 query + body + WebSocket 帧**：

| 通道 | 覆盖 |
| --- | --- |
| `fetch` | URL query、JSON body（含 `Request` 对象的 body，异步读取重建）、`URLSearchParams`、`FormData` |
| `XMLHttpRequest` | `open` 改 URL、`send` 改 body |
| `navigator.sendBeacon` | URL + body |
| `WebSocket` | 纯 JSON 字符串帧；**弹幕协议二进制帧**（16B 包头 + JSON，支持 ArrayBuffer/TypedArray/二进制字符串，改写后按 UTF-8 字节重算包头总长，操作码/序列保留） |

四个通道均有兜底安全网：改写逻辑内部异常时回落原生行为，不会弄挂页面。

## 上报拦截规则

| 规则 | 状态 | HAR 命中 | 说明 |
| --- | --- | ---: | --- |
| `data.bilibili.com/*` | 实测 | 13 / 20 | 站点统计/埋点主通道（`/log/web`、`/v2/log/web`、`/gol/postweb`） |
| `data.bilivideo.com/*` | 实测 | 4 | bilivideo 侧日志上报 |
| `live-trace.bilibili.com/*` | 实测 | 1 | 直播追踪（参数带 room_id） |
| `api.live.bilibili.com/xlive/open-interface/v2/tracker/*` | 实测·低风险 | 1 | tracker SDK 配置下发，拦掉即静默 |
| `rumt-zh.com/collect/*` | 实测 | 3 | 第三方 RUM 采集 |
| `nlog.daxuesoutijiang.com/*` | 实测 | 4 | 第三方 log（疑插件注入） |
| `hdslb.com/**/log/*`（排除静态扩展名） | 已修正 | 0 | 只拦真实上报路径，不误伤静态 JS |
| `**/report*`、`MsgReport`、`heart_beat`（HTTP 形式） | 推断 | 0 | 两版 HAR 均未出现，保留观察 |

**明确放行**（拦了会出问题）：`stats.cdnjtzy.com/stats/EncodeSwitch.json`（播放器编码切换）、`getDanmuInfo`（弹幕必需）、`*.m3u8` / `*.m4s`（媒体流本体）。

**顺序**：拦截优先于改写——被上报规则命中的请求整条丢弃，不进入改写流程。

## 效果边界与未验证项

- **签名参数（`w_rid` / `wts` / `csrf`）不重算**。改写 query 后签名可能与参数不匹配，服务端若校验会拒绝——这是最大的未验证点。
- 服务端是否接受改写后的请求未实测（需真实账号 + 抓包对比）。
- TLS 层、IP、`buvid` 等设备指纹不在本脚本作用范围。
- `Blob` 形态的 WS 帧未处理（异步读取与 `send` 同步语义冲突），弹幕实际使用 ArrayBuffer，已覆盖。
- 在线人数是聚合值，主播/观众一般看不到「你个人」在线。

## 调参

```js
__BILI_INVISIBLE__.set('blockAnalytics', false);    // 关统计类拦截
__BILI_INVISIBLE__.set('blockLowRisk', false);      // 关低风险拦截
__BILI_INVISIBLE__.set('rewriteAccessKey', false);  // 关 R1
__BILI_INVISIBLE__.set('rewriteRoomId', false);     // 关 R2
__BILI_INVISIBLE__.set('rewriteUid', false);        // 关 R3
__BILI_INVISIBLE__.set('rewriteWebSocket', false);  // 关 WS 帧改写
__BILI_INVISIBLE__.set('debug', true);              // 打印拦截与改写日志
```

## 测试

```bash
node tests/rewrite.test.cjs
```

28 条用例（沙箱内真实执行脚本，覆盖 R1/R2/R3 语义、四通道、二进制 WS 帧、Request body、拦截优先交互）。

## Bilibili-Evolved 版

- 插件源码（BE 官方仓库形态）：`bilibili-evolved-plugin/registry/lib/plugins/bili-live-invisible/`（`index.ts` + `interceptor.ts` + `index.md`）
- 可安装版：`bilibili-evolved-plugin/installable/bili-live-invisible.be-plugin.js` —— BE 设置面板 → 插件 → 安装插件，粘贴全文即可
- 已向上游提交收录 PR（the1812/Bilibili-Evolved#5918）；⚠️ 插件在 BE 核心初始化后才安装拦截，BE 启动前的首屏请求无法覆盖，详见 `index.md`

## Credits

- 语义参考：[lzghzr/bilibili-live-invisible](https://github.com/lzghzr/bilibili-live-invisible)（Xposed 模块）
- 拦截架构参考：Bilibili-Evolved 的 `document-start` 接管思路

## License

[MIT](./LICENSE)
