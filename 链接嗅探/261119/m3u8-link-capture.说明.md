# M3U8 链接捕获器 —— 实现说明

> 油猴 (Tampermonkey) 用户脚本，在任意网页中嗅探 `.m3u8` / `.mpd` 流媒体链接，提供一键复制链接或生成下载命令。纯本地运行，不上传任何数据。

---

## 一、整体架构

脚本采用 **"三层捕获 + 统一入库 + 面板展示"** 的结构：

```
┌──────────────────────────────────────────────────┐
│                 捕获层（三种手段）                  │
│  ① hook fetch   ② hook XHR   ③ 扫描 Performance  │
└──────────────────────┬───────────────────────────┘
                       │  add(raw)
                       ▼
              ┌─────────────────┐
              │  Map 去重入库    │ ← 上限 200 条
              └────────┬────────┘
                       │  变更即 render()
                       ▼
              ┌─────────────────┐
              │  右下角 UI 面板   │  badge（计数） + panel（列表）
              └─────────────────┘
```

- **存储**：`links = new Map()`，key 是规范化后的 URL，value 是入库时间戳。Map 天然去重。
- **上限**：`MAX = 200`，防止长时间观看导致内存泄漏。
- **触发时机**：`@run-at document-start` + `unsafeWindow`，确保 hook 尽早生效，抢在播放器代码之前。

---

## 二、三种捕获手段

### 1. Hook `fetch`（[#L33-44](file:///d:/devProjects/Crx/viaScript/链接嗅探/m3u8-link-capture.user.js#L33-L44)）

```js
const origFetch = w.fetch;
w.fetch = function (input) { /* 先嗅探，再透传给原 fetch */ };
```

- **覆盖场景**：现代播放器（如 hls.js、dash.js）大量使用 `fetch` 加载 m3u8 / mpd。
- **参数兼容**：`input` 可能是字符串 URL，也可能是 `Request` 对象，代码用 `input.url` 兜底。
- **注意**：必须在 `document-start` 注入，否则播放器初始化请求会漏抓。

### 2. Hook `XMLHttpRequest.open`（[#L47-53](file:///d:/devProjects/Crx/viaScript/链接嗅探/m3u8-link-capture.user.js#L47-L53)）

```js
const origOpen = w.XMLHttpRequest.prototype.open;
w.XMLHttpRequest.prototype.open = function () { /* 嗅探 arguments[1]，再透传 */ };
```

- **覆盖场景**：老牌播放器或兼容模式下仍使用 XHR。
- **位置**：挂在 `XMLHttpRequest.prototype` 上，对页面所有 XHR 实例生效。

### 3. 扫描 `Performance` 资源表 + DOM `video/source`（[#L56-66](file:///d:/devProjects/Crx/viaScript/链接嗅探/m3u8-link-capture.user.js#L56-L66)）

```js
setInterval(function () {
  // a) performance.getEntriesByType('resource')
  // b) querySelectorAll('video[src], source[src]')
}, 1500);
```

- **为什么需要轮询？**
  - 脚本加载前已发出的请求，hook 赶不上，但 Performance 表里有记录；
  - 某些 CDN / 播放器不走 fetch/XHR，直接通过 `<video src="...m3u8">` 赋值，DOM 查询能兜住；
  - `setInterval` 每 1.5s 扫一次，成本很低（两次 API 调用）。
- **注意**：Performance 资源条目的 `name` 字段就是完整 URL。

---

## 三、统一入库 `add(raw)`（[#L21-30](file:///d:/devProjects/Crx/viaScript/链接嗅探/m3u8-link-capture.user.js#L21-L30)）

三个入口都调用同一个 `add`，做了四层校验：

| 步骤 | 代码 | 目的 |
|------|------|------|
| 1 | `!/\.m3u8|\.mpd/i.test(raw)` | 快速过滤非流媒体链接 |
| 2 | `new URL(raw, location.href).href` | 补全相对路径 → 绝对 URL |
| 3 | `!/^https?:/.test(url)` | 排除 data: / blob: / file: |
| 4 | `links.has(url) \|\| links.size < MAX` | 去重 + 上限保护 |

校验通过后才写入 Map 并触发 `render()` 更新 UI。

---

## 四、UI 与交互（[#L104-166](file:///d:/devProjects/Crx/viaScript/链接嗅探/m3u8-link-capture.user.js#L104-L166)）

### 组件结构

```
badge（右下角圆形计数）
  │  点击切换显示
  ▼
panel（弹出面板）
  ├─ 标题栏：域名 + "清空" 按钮
  └─ 列表区：每行显示 URL（>160 字符截断）
              ├─ [复制链接]
              └─ [复制下载命令]
```

- **z-index**：badge/panel 用 `2147483646`，toast 用 `2147483647`（接近 JS 最大整数），确保压过网站所有弹窗。
- **宽度**：`width:min(520px, 90vw)`，兼顾桌面宽屏和手机。
- **渲染时机**：`add` 成功 → `render()`，清空 → `render()`，确保 UI 与 Map 同步。

### 复制逻辑（[#L68-80](file:///d:/devProjects/Crx/viaScript/链接嗅探/m3u8-link-capture.user.js#L68-L80)）

```
GM_setClipboard 存在？ → 用油猴 API（更稳，跨域不拦截）
  否则 → 兜底用 textarea + execCommand('copy')
```

复制后调 `toast('已复制')` 给用户反馈，1.2s 自动消失。

### 下载命令生成（[#L82-86](file:///d:/devProjects/Crx/viaScript/链接嗅探/m3u8-link-capture.user.js#L82-L86)）

生成 [N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE) 命令行：

```
N_m3u8DL-RE "<url>" --auto-select
  -H "Referer: <当前站点 origin>/"
  -H "User-Agent: <当前浏览器 UA>"
```

- `--auto-select`：自动选择最佳音视频轨道；
- `-H Referer`：很多视频站校验 Referer，不带会 403；
- `-H User-Agent`：模拟浏览器 UA，避免被 CDN 拦截；
- UA 里的双引号会被替换掉，防止破坏 shell 引号。

### 油猴菜单（[#L172-174](file:///d:/devProjects/Crx/viaScript/链接嗅探/m3u8-link-capture.user.js#L172-L174)）

注册了 "显示/隐藏 M3U8 捕获面板" 菜单项，调用 `badge.click()` 切换面板显隐。

---

## 五、`init` 启动流程（[#L168-176](file:///d:/devProjects/Crx/viaScript/链接嗅探/m3u8-link-capture.user.js#L168-L176)）

```
init()
  ├─ document.body 还没出来？→ 50ms 后重试
  ├─ build()   → 创建 badge 和 panel DOM
  ├─ render()  → 渲染初始状态（空列表）
  └─ GM_registerMenuCommand → 注册菜单
```

因为 `@run-at document-start` 比 `<body>` 还早，所以必须轮询等 DOM 就绪才能 appendChild。

---

## 六、为什么用 `unsafeWindow`？

```js
const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
```

油猴沙箱里的 `window` 是隔离副本，hook 它对页面真实的 `fetch`/`XHR` 无效。必须拿到页面真正的 `window`（即 `unsafeWindow`），hook 才能作用于播放器代码。普通浏览器环境（无油猴）则回退到 `window` 本身。

---

## 七、边界情况与设计取舍

| 场景 | 处理方式 |
|------|----------|
| 相对路径 URL | `new URL(raw, location.href)` 规范化 |
| `data:` / `blob:` URL | 正则 `/^https?:/` 排除 |
| URL 中含双引号（UA） | `.replace(/"/g, '')` 破坏 shell 的可能性 |
| 大量链接 | `MAX=200` 硬上限，超了不再入库 |
| 页面 DOM 还没准备好 | `setTimeout(init, 50)` 自旋等待 |
| 轮询 Performance 表的性能 | 1.5s 间隔 × 两次 API 调用，可忽略 |
| hook 冲突（已有脚本 hook 过 fetch） | 先到先得；本脚本 `@run-at document-start` 优先注入 |
| 播放器在 iframe 内 | iframe 有独立 window，主脚本无法 hook 子框架 → 这是已知局限 |

---

## 八、快速上手

1. 安装 Tampermonkey / Violentmonkey 等油猴扩展；
2. 新建脚本，粘贴 `m3u8-link-capture.user.js` 全部内容并保存；
3. 打开任意视频站，播放视频；
4. 看右下角 badge 数字增加，点击展开面板；
5. 按需点 "复制链接" 或 "复制下载命令"。
