# 媒体资源嗅探及下载 (Userscript)

一个运行在 Tampermonkey / Violentmonkey 等油猴引擎上的媒体嗅探脚本，能够自动抓取网页中的 `<video>` / `<audio>` 资源与网络请求中的 m3u8 / mp4 / mp3 / flv 流，并提供播放、复制、下载、录屏一体化能力。

> **版本**：2.0.0  
> **作者**：me  
> **运行环境**：Chrome / Edge / Firefox 浏览器 + 油猴扩展  
> **全局匹配**：`http://*/*` 与 `https://*/*`

---

## 一、功能清单

| # | 功能 | 说明 |
|---|------|------|
| 1 | **资源嗅探** | 同时监听 DOM 媒体元素、Network Performance API、Fetch / XHR 请求，自动汇总视频/音频 URL |
| 2 | **资源列表 UI** | 右上角悬浮面板，分类展示视频 / 音频，支持手动输入自定义链接 |
| 3 | **在线播放** | 集成 DPlayer + hls.js + flv.js，支持 m3u8 / mp4 / flv / mp3 多种格式播放 |
| 4 | **下载** | 分片并发下载 m3u8（可选去广告），直链下载 mp4 / mp3 / flv |
| 5 | **去广告** | 下载 m3u8 时自动识别并剔除广告 TS 分片（测试版，可能误杀） |
| 6 | **录屏** | 基于 `MediaRecorder` API + `qbMediaRecorder.js`，支持网页内录屏导出 mp4 |
| 7 | **解除复制限制** | 拦截 `copy / cut / contextmenu / selectstart / keydown`，禁用 `user-select:none` |
| 8 | **回到顶部** | 页面滚动时自动显示 "⇡" 返回按钮 |
| 9 | **画中画 + 刷新** | 播放面板内置画中画切换与视频刷新按钮 |
| 10 | **油猴菜单开关** | 运行时可切换自动弹窗 / 转码 / 去广告 / 解除复制 四项功能 |

---

## 二、脚本头部声明

```
@match            http(s)://*/*
@grant            unsafeWindow, GM_download, GM_setClipboard, GM_xmlhttpRequest,
                  GM_registerMenuCommand, GM_unregisterMenuCommand,
                  GM_setValue, GM_getValue, GM_addStyle, GM_addElement,
                  GM_getResourceText, GM_webRequest
@connect          *
@require          jQuery 3.7.1 / DPlayer 1.27.1 / layui 2.9.14 /
                  hls.js 1.5.13 / flv.js 1.6.2 / crypto-js 4.2.0 /
                  Trusted-Types Helper
@resource         LayuiCss, qbMediaRecorderJS
```

---

## 三、可配置开关（`set` 对象 + 油猴菜单）

| Key | 默认 | 含义 |
|-----|------|------|
| `auto_n`    | 0 关 | 嗅探到新资源是否自动展开列表面板 |
| `ffmpeg_n`  | 0 关 | m3u8 下载完成后是否调用浏览器内部转码（需硬件支持） |
| `ad_n`      | 1 开 | 下载 m3u8 时是否自动过滤广告分片 |
| `checked_n` | 1 开 | 是否解除网站文本选中限制 |

> 菜单命令由 `mkMenu()` 函数统一注册；手机端无菜单时以 `set[]` 硬编码为准。

---

## 四、核心模块与流程

### 4.1 初始化（IIFE 入口）

```
┌─ 读取 set[] 默认值
├─ 加载 Layui 皮肤（替换 iconfont CDN）
├─ 注入 qbMediaRecorderJS（仅顶层窗口，不在 iframe）
├─ 判断 platform（pc / phone）
├─ 注册油猴菜单（仅 pc）
├─ 根据窗口尺寸计算面板宽高 weight / weight1 / offset
├─ 向 DOM 注入：#MyUrls（资源面板）、#MyUpDown（悬浮按钮）、#GoTop（回到顶部）
└─ 注入全局 CSS 动画与样式
```

### 4.2 嗅探链路（四路并行）

```
① DOM 层
   遍历 <video> / <audio> 的 currentSrc / src 属性
   监听新增媒体元素（MutationObserver）

② Performance API
   performance.getEntriesByType('resource')
   按 initiatorType / name 正则匹配 m3u8 / mp4 / mp3 / flv

③ Network Hook
   重写 unsafeWindow.fetch → 拦截返回的 Request / Response URL
   重写 XMLHttpRequest.prototype.open → 捕获请求 URL
   重写 history.pushState / replaceState → 路由变化时刷新嗅探

④ 自定义注入
   unsafeWindow.scriptsList / url_lists / url_info / urls
   由页面内脚本通过 postMessage 上报额外资源
```

所有入口最终统一调用 **`addUrl(url, name, href)`** 去重并写入 `unsafeWindow.GM_D`，再异步渲染到面板。

### 4.3 列表 UI 渲染（`functionAll()`）

根据 URL 后缀分流到 "视频" 或 "音频" Tab，每一项生成：

```
[序号] [URL 输入框] [文件名] [下载/停止] [播放] [x 删除]
```

同时注册：`SaveUrl` / `StopSaveUrl` / `playUrl` / `rmUrl` / `downName input` 等事件。

### 4.4 播放（`dplayerUrl()`）

```
┌─ 检测文件后缀 m3u8 / flv / 其他
├─ 构造 DPlayer 配置：
│    ├─ video.url = 真实资源
│    ├─ video.type = 'hls' | 'flv' | 'auto'
│    └─ video.customType 注入 hls.js / flv.js
├─ layer.open 弹出播放器容器
├─ 绑定画中画 / 刷新按钮
└─ 双击视频 → 全屏 toggle
```

### 4.5 下载（并发分片 + 合并）

```
SaveUrl.click
  │
  ├─ 直链资源 (mp4 / mp3 / flv)
  │    └─ GM_download({ url, name, onprogress, onload, onerror })
  │
  └─ m3u8 资源
       ├─ GM_xmlhttpRequest 拉取主 m3u8 内容
       ├─ 解析 EXTINF / EXT-X-KEY / 分片列表
       ├─ 【ad_n=1】调用 Ts 过滤逻辑（见 4.6）
       ├─ 并发 GM_xmlhttpRequest 拉取全部 TS 分片
       ├─ 按顺序 Blob 合并
       ├─ 【ffmpeg_n=1】调用浏览器 ffmpeg.wasm 转码 mp4
       └─ URL.createObjectURL → GM_download 导出
```

### 4.6 m3u8 广告过滤

两处完全相同的过滤逻辑（分别服务于两个下载入口）：

```
Ts = m3u8 文本中的分片列表段
  │
  ├─ 正则定位广告特征：
  │    ├─ "#EXT-X-DATERANGE" 标记区间
  │    ├─ 分片 URL 包含 "ad" / "advert" / "commercial" / "pre-roll"
  │    └─ 时长异常短的连续分片
  │
  ├─ num1 = 广告起始位置
  ├─ num2 = 广告结束位置
  ├─ ad_ts = Ts.slice(num1, num2 + 20)   // 额外吞掉尾部换行
  └─ Ts = Ts.replace(ad_ts, "")           // 从 playlist 中剔除
```

> 若目标站点广告采用服务端混淆 / KEY 轮换 / 同域同路径无特征分片，此过滤可能误杀正片。此时关闭 `ad_n` 即可。

### 4.7 录屏（`LupinStart` / `LupinStop`）

```
LupinStart.click
  └─ navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
     └─ qbMediaRecorder.js 包装录制
        └─ 实时显示时长 / 码率
           └─ onstop → Blob → URL → GM_download("录屏 yyyy-mm-dd hh-mm-ss.mp4")
```

### 4.8 解除复制限制

在 `window.onload` 与滚动事件中持续执行：

```
┌─ 移除 / 禁用：
│    ├─ event.preventDefault on copy / cut / contextmenu / selectstart
│    ├─ document.body.style.userSelect = 'text'
│    ├─ 所有 *.user-select-none → 移除该 class
│    └─ onkeydown 拦截屏蔽 Ctrl+C / Ctrl+A 的站点脚本
│
└─ 兜底：document.addEventListener('copy', true) 捕获阶段重新派发
```

### 4.9 Bilibili 特殊处理（`biliVideo()`）

针对 B 站分段 DASH，主动解析 `window.__playinfo__`，拼接音视频轨后合并为可下载 mp4。

---

## 五、关键 DOM ID 速查

| ID | 作用 |
|----|------|
| `#MyUpDown` | 右上角悬浮 ➕ 按钮，点击展开/收起 |
| `#MyUrls` | 主面板容器（视频/音频 Tab + 列表） |
| `#Allurl` | 工具栏：录屏 / 停止 / 下载全部 / 复制全部 / 清空 |
| `#GoTop` | 右下角回到顶部按钮 |
| `.MyVideo` / `.MyAudio` | 两个 Tab 面板 |
| `.SaveUrl` / `.StopSaveUrl` / `.playUrl` / `.rmUrl` | 列表项操作按钮 |

---

## 六、平台差异

| | PC | 手机 |
|--|----|------|
| 油猴菜单 | ✅ 注册 4 项开关 | ❌ 无菜单，走 `set[]` |
| 面板尺寸 | 固定 800×600 / 550×700 | 跟随屏幕宽度缩放（含 zoom 适配） |
| 悬浮按钮 | 右上角 | 右上角（更小） |

---

## 七、已知限制

1. **m3u8 加密**：若分片使用 `EXT-X-KEY` 且服务端拒绝跨域取 key，下载会失败（浏览器同源策略）。
2. **ssai / 服务端拼接广告**：广告与正片在同一 TS 内时无法被文本级过滤，只能下载后本地裁剪。
3. **ffmpeg 转码**：需要浏览器启用 WebCodecs / SharedArrayBuffer，普通 Chrome 默认关闭。
4. **录屏权限**：首次启动需用户授权窗口 / 屏幕共享。
5. **Trust-Types**：脚本已引入 Trusted-Types Helper，若页面 CSP 极严仍可能被拦截。

---

## 八、版本变更（相对原版 v1.991）

| 版本 | 变更 |
|------|------|
| 2.0.0 | 移除 `@antifeature ads`；移除首次打开自动弹窗（`FirstOpen` / `me` / `ad` 标志位）；移除油猴菜单中的 "支持作者" 入口；更新作者 / license / name / description |
