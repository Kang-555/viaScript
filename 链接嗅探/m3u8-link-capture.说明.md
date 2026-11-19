# M3U8 链接捕获器（增强版）

> 油猴 (Tampermonkey) 用户脚本。在任意网页深度嗅探 m3u8 / mpd / mp4 / flv / webm 等流媒体链接，支持多时间段裁剪 + 一键复制完整 N_m3u8DL-RE 命令。纯本地运行，不上传任何数据。

**版本**: 2.0  
**运行时机**: `@run-at document-start`（必须，否则播放器初始化请求会漏抓）  
**依赖权限**: `unsafeWindow`（页面主上下文 hook）、`GM_setClipboard`、`GM_registerMenuCommand`

---

## 一、快速上手

1. 安装 Tampermonkey / Violentmonkey / ScriptCat 等油猴扩展；
2. 新建脚本，粘贴 `m3u8-link-capture.user.js` 全部内容并保存；
3. 打开任意视频站，播放视频；
4. 看右下角 badge 数字增加 → 点击展开面板；
5. 点 `📌 选它生成` 选定链接 → 到「⏱ 时间段」tab 设置裁剪范围 → 到「⚡ 生成命令」tab 复制。

---

## 二、嗅探手段一览

脚本采用 **"网络层 + JS 内部 + DOM 层 + 路由层"** 四层钩子 + `findMedia` 递归遍历，覆盖目前网页视频的绝大多数加载方式。

### 2.1 网络层

| 钩子 | 嗅探内容 |
|------|---------|
| `fetch` | 请求 URL 本身 → 响应体 clone 后读文本：m3u8 / JSON 对象 / 16 字节 key |
| `XMLHttpRequest.prototype.open` | URL → load 事件里 sniff responseText / responseArrayBuffer / response 对象 |
| `PerformanceObserver` | 实时监听新资源条目（比旧 `setInterval` 更高效，增量推送不重复） |

### 2.2 JS 内部（对抗动态生成）

很多视频站不会在 URL 里暴露 m3u8 地址，而是通过 JS 运行时拼接出来——这层就是抓这些"藏在代码深处"的链接：

| 钩子 | 嗅探内容 |
|------|---------|
| `JSON.parse` | 递归遍历所有 parsed JSON 字段，找 URL / 16 字节 key / m3u8 文本 |
| `TextDecoder.prototype.decode` | 抓到以 `#EXTM3U` 开头的解码结果 |
| `String.prototype.indexOf` | 搜索 `#EXTM3U` 关键字后截取后续文本 |
| `String.fromCharCode` (Proxy) | 逐字符拼接 m3u8 + 检测 32 位 hex key |
| `Array.prototype.slice` | `end=16, length=32` 时截取疑似 key |
| `Array.prototype.join` | 拼出 `#EXTM3U` 开头文本 / 24 字符 base64 key |
| `btoa` | 24 字符 base64 key / m3u8 base64 编码 |
| `atob` | base64 解码后是 m3u8 / mpd XML |
| `escape` | 24 字符 base64 key（部分网站用 escape 处理 key） |
| `Uint8Array / Uint16Array / Uint32Array` 构造 | 16 字节数据 → DRM 解密 key（自动处理 byte order） |
| `Int8Array / Uint8Array.prototype.subarray` | key 截取场景 |
| `DataView` | `byteLength = 16 / 32` 时检测 key |

### 2.3 DOM 层

| 钩子 | 嗅探内容 |
|------|---------|
| `video[src] / source[src]` + MutationObserver | 实时盯 `<video>` / `<source>` 标签的 `src` 属性变化 |
| 内联 `<script>` 正则扫描 | 扫页面里写死的 m3u8 URL（`script:not([src])`） |

### 2.4 路由层

| 钩子 | 嗅探内容 |
|------|---------|
| `history.pushState / replaceState` | SPA 页面路由切换后自动重扫 DOM |
| `postMessage` | 拦截站内消息里藏的 URL + iframe → top window 自动转发 |

### 2.5 findMedia 递归遍历

所有钩子捕获到非字符串的对象/JSON 后，统一走 `findMedia(data, depth)`：

```
depth ≤ 20（防死循环）
  ├─ string 值 → 判 URL / m3u8 文本 / data: URL / MPD
  ├─ object 值 → 递归
  ├─ Array[16] / ArrayBuffer(16) → 判 DRM key
  └─ 入 Map 去重
```

---

## 三、反对抗设计

每一个劫持的原生 API 都做了两层伪装，让网站反爬虫检测失效：

1. **`registerNativeStr(hooked, orig)`** —— 把原始 `Function.prototype.toString.call(orig)` 存到 `hooked.__catNativeStr`；
2. **顶层 `Function.prototype.toString` Proxy** —— 当网站代码检查 `hookedFn.toString()` 时，Proxy 拦截返回预存的原生串。

```
网站代码: fetch.toString()    ← Proxy 拦截 → 返回 "[native code]"
                           ↑ 即使 fetch 被我们替换过
```

---

## 四、UI 概览（3 tab 紧凑面板）

### 右下角 badge（常驻）

```
┌──────────────┐
│ 📺 m3u8  12  │   ← 右下角圆形徽章，显示捕获数量
└──────────────┘
       点击展开
           ↓
┌─────────────────────────────────────┐
│ ◆ 🔗链接 ◆ ⏱时间段 ◆ ⚡生成 ◆ ×  │   ← 右上角 × 关闭
├─────────────────────────────────────┤
│ 📌 共 12 个链接 | 🔑 3 个 key        │
│ ┌─ key 复制区 ──────────────────┐  │   ← 检测到的 DRM key
│ │ base64key... [复制]            │  │
│ └────────────────────────────────┘  │
│ ─────────────────────────────────── │
│ 📺 m3u8/hls/fmp4.m3u8               │
│ [📌 选它生成] [复制链接] [复制命令] │
│ 🎬 mp4/segment1.mp4                 │
│ [📌 选它生成] [复制链接] [复制命令] │
└─────────────────────────────────────┘
```

### Tab 1 🔗 链接

- 按发现顺序列出所有 URL，带扩展名标签（m3u8 / mp4 / key / ...）
- 每行三个操作：**选它生成**（跳到时间段 tab）/ **复制链接** / **复制命令**（跳过中间环节直接生成）
- 检测到 DRM key 时顶部出现黄色高亮区域，可逐个复制

### Tab 2 ⏱ 时间段

- 只有 m3u8 / mpd 格式出现（mp4 / mp3 / flv 是直链，整段下载）
- **6 位数字 HHMMSS 输入**：`000030` = 00:00:30
- 整行留空 = 下载整段（不加 `--custom-range`）
- 可加多个时间段，每个时间段单独生成一条命令
- 文件名自动取页面 title，可手动编辑

### Tab 3 ⚡ 生成命令

```bash
# N_m3u8DL-RE 下载命令
# 视频: https://cdn.example.com/hls/video.m3u8
# Referer: https://www.example.com/play?id=123

# ===== 第 1 段 =====
N_m3u8DL-RE "https://cdn.example.com/hls/video.m3u8" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0" \
  -H "Referer: https://www.example.com/play?id=123" \
  --thread-count 8 --download-retry-count 5 \
  --log-level info --auto-select \
  --custom-range "00:00:30-00:01:30" \
  --save-name "视频名01"

# ===== 第 2 段 =====
N_m3u8DL-RE "https://cdn.example.com/hls/video.m3u8" \
  ... --custom-range "00:02:30-00:04:00" --save-name "视频名02"
```

- 生成的命令**可编辑**（手改 URL / UA / 文件名）
- 一键**复制全部**到剪贴板 / **下载 .txt** 脚本文件
- MP4 直链自动走 `curl`（不需要 N_m3u8DL-RE，没有时间裁剪）

---

## 五、命令参数说明

| 参数 | 作用 |
|------|------|
| `--auto-select` | 自动选择最佳音视频轨道 |
| `--thread-count 8` | 8 线程并行下载 |
| `--download-retry-count 5` | 失败重试 5 次 |
| `--custom-range "HH:MM:SS-HH:MM:SS"` | 时间裁剪（仅 m3u8/mpd 支持） |
| `--save-name "xxx"` | 保存文件名（自动加 `.mp4` 后缀） |
| `-H "User-Agent: ..."` | 模拟浏览器 UA，避免 CDN 拦截 |
| `-H "Referer: ..."` | 很多视频站校验 Referer，不带会 403 |

---

## 六、边界情况与已知局限

| 场景 | 处理方式 |
|------|---------|
| iframe 内视频 | 主脚本注入到 `unsafeWindow`，iframe 有独立 `window`，通过 `postMessage` 自动转发到 `window.top` |
| Service Worker 里的请求 | 抓不到（浏览器安全机制），但 Performance 资源表通常会有记录 |
| 完全走 MSE 无 URL 播放 | cat-catch 扩展里有 `SourceBuffer.appendBuffer` 代理层直接抓二进制分片，油猴脚本做不到 |
| Worker 内部发起的请求 | Blob Worker 的源码动态加载在油猴里需要额外序列化，当前版本未覆盖（绝大多数视频网站不启 Worker） |
| 相对路径 URL | `addBaseUrl(base, text)` 自动补全 |
| `data:` / `blob:` URL | 正则 `/^https?:/` 排除；m3u8 的 data URL 会尝试 base64 解码 |
| URL 中含双引号（UA / Referer） | `.replace(/"/g, '')` 避免破坏 shell 引号 |
| 大量链接 | `MAX_LINKS=500`，超过后自动清理一半去重集合 |
| 大量 key | `MAX_KEYS=200` 上限 |
| hook 冲突（已有脚本 hook 过 fetch） | 先到先得；本脚本 `@run-at document-start` 优先注入 |
| 扩展 webRequest 层 | **未实现** — Chrome 扩展独有的 API，油猴做不到 |

---

## 七、目录内文件

```
链接嗅探/
├── m3u8-link-capture.user.js   # 主脚本（1141 行）
├── m3u8-link-capture.说明.md    # 本文件
└── README.md                    #（如果需要）
```

---

## 八、调试技巧

- **Console 临时开关**：在油猴脚本里的 `// hookFetch();` 等函数调用前加 `//` 可临时禁用单个 hook，方便定位哪条链路上抓到了目标 URL。
- **查看当前嗅探状态**：右下角 badge 显示数字，点开面板可以看到完整列表。
- **油猴菜单**：Tampermonkey 图标 → 用户脚本命令 →
  - `🔗 显示/隐藏媒体嗅探面板` —— 切换面板显隐
  - `📋 一键复制最新命令` —— 抓完视频直接点这个复制命令

---

## 九、与 cat-catch 扩展的关系

本脚本从 cat-catch 2.7.4 扩展中移植了**深度嗅探层**（search.js + Function.prototype.toString 伪装），但：

| 能力 | 本油猴脚本 | cat-catch 扩展 |
|------|:---------:|:-------------:|
| 13 种原生 API 劫持 | ✅ | ✅ |
| findMedia 递归遍历 | ✅ | ✅ |
| Function.prototype.toString 伪装 | ✅ | ✅ |
| Chrome webRequest 网络层拦截 | ❌ | ✅ |
| MSE SourceBuffer.appendBuffer 代理 | ❌ | ✅ |
| Worker 内部继续嗅探 | ❌ | ✅ |
| WebRTC 录制 | ❌ | ✅ |
| 自动下载 + ffmpeg 合并 | ❌ | ✅ |
| ARIA2 RPC / MQTT / 远程命令 | ❌ | ✅ |
| **跨浏览器** | ✅ | ❌ 仅限 Chrome / Firefox / Edge |
| **秒级修改生效** | ✅ | ❌ Service Worker 5 分钟被杀 |
| **手机可用** | ✅（ScriptCat iOS / Tampermonkey Android） | ❌ |
