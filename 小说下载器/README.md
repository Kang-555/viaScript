# 小说下载器 - 元素版 (v5.0)

> 一个油猴（Tampermonkey）脚本，用于在小说网站目录页一键批量下载小说，自动保存为 TXT 文件。

---

## 一、名词解释

| 名词 | 解释 |
|------|------|
| **油猴脚本** | 浏览器扩展，允许你给任意网页添加自定义功能 |
| **目录页** | 小说的"章节列表"页面，不是看小说正文的页面 |
| **选择器 (CSS Selector)** | 一种语法，用来精确选中页面上的 HTML 元素，类似"用路径找到页面元素" |
| **并发** | 同时发起多个下载请求，比如同时下载 20 章 |
| **DOM** | 页面的结构树，浏览器把 HTML 解析成一棵"树"，每个标签是一个"节点" |
| **Shadow DOM** | 浏览器隔离机制，让脚本的 UI 不被原页面样式干扰 |
| **专属正文** | 每个站点有自己固定的正文 DOM 结构，用精准选择器直接定位 |

---

## 二、安装步骤

```
1. 安装 Tampermonkey 浏览器扩展
   → 打开 Chrome/Edge 扩展商店搜索 "Tampermonkey" 安装

2. 创建新脚本
   → 点击浏览器右上角 Tampermonkey 图标 → 添加新脚本

3. 粘贴代码
   → 打开 小说下载器-元素版.user.js → 全选复制 → 粘贴到 Tampermonkey 编辑器 → 保存

4. 打开小说目录页
   → 页面右侧会出现 "下载小说" 按钮
```

---

## 三、使用流程

```
┌─────────────────────────────────────────────────────────────────────┐
│ 第1步：打开小说目录页                                                  │
│   ↓                                                                 │
│ 第2步：点击 "下载小说" 按钮                                            │
│   ↓                                                                 │
│ 第3步：脚本自动扫描页面，匹配站点规则                                    │
│   ↓                                                                 │
│ 第4步：显示设置面板                                                    │
│   · 站点标识 (a / b) · 章节数                                         │
│   · 下载全部 / 自定义范围 / 前N章                                     │
│   · 并发线程 / 延迟 / 每分钟限频                                       │
│   ↓                                                                 │
│ 第5步：点击 "开始下载"                                                 │
│   ↓                                                                 │
│ 第6步：显示进度面板                                                    │
│   · 当前进度 (如 15/120)                                              │
│   · 当前下载的章节标题                                                  │
│   · 可随时点 "取消下载"                                               │
│   ↓                                                                 │
│ 第7步：下载完成，自动保存为 TXT 文件                                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 四、核心原理

### 4.1 整体流程图

```
                              ┌─────────────────────┐
                              │   用户点击下载按钮    │
                              └──────────┬──────────┘
                                         ↓
                              ┌─────────────────────┐
                              │  scanChapters()     │
                              │  扫描章节列表        │
                              └──────────┬──────────┘
                                         ↓
                    ┌─────────────────────────────────┐
                    │   依次尝试站点选择器              │
                    │                                 │
                    │   先试 a.chapterSelector 命中？   │
                    │   再试 b.chapterSelector 命中？   │
                    │   都没命中 → 提示未检测到         │
                    └────────────────┬────────────────┘
                                     ↓
                    ┌─────────────────────────────────┐
                    │   遍历章节链接 (按页面顺序)         │
                    │   · a: badge + title 拼标题      │
                    │   · b: h4 取标题                 │
                    │   · 去重 → 重新编号              │
                    │   · 每个任务绑定 site 配置        │
                    └────────────────┬────────────────┘
                                     ↓
                              ┌─────────────────────┐
                              │   显示设置面板         │
                              └──────────┬──────────┘
                                         ↓
                              ┌─────────────────────┐
                              │ startDownload()     │
                              │ 并发下载章节          │
                              └──────────┬──────────┘
                                     ↓
                    ┌─────────────────────────────────┐
                    │   downloadChapter()  单章下载     │
                    │                                 │
                    │   getHtml() → 请求章节页面       │
                    │   parse() → 解析DOM             │
                    │   getContent() → 专属正文提取    │
                    │   clean() → 清洗文本             │
                    └────────────────┬────────────────┘
                                     ↓
                              ┌─────────────────────┐
                              │   saveFile()        │
                              │ 保存为 TXT 文件       │
                              └─────────────────────┘
```

### 4.2 为什么用"专属正文"而不是"智能算法"？

**之前的问题：**
```
早期版本使用"智能正文算法"（extractMainContent），它的做法是：
  - 遍历页面所有 div/span/article 等标签
  - 计算每个块的文字数量
  - 取文字最多的块作为正文

结果：经常抓不到正确内容，或混入广告、评论等噪声。
```

**现在的解决方案：**
```
每个站点在配置里直接声明：
  - 正文容器选择器 (contentSelectors)
  - 正文提取器类型 (contentExtractor)

下载时直接用这些精准规则，不需要任何"猜测"。

好处：
  · 100% 可控，不会乱抓
  · 速度更快，不需要遍历整个 DOM
  · 逻辑简单，出了问题容易排查
```

### 4.3 站点配置结构

```javascript
this.sites = {
    a: {
        name: 'a',
        chapterSelector: 'ul.detail-page__catalog-list a.detail-page__catalog-item',
        numSelector: '.detail-page__chapter-badge',
        titleSelector: '.detail-page__chapter-title',
        titleSelectors: ['.dx-title.detail-page__title', '.detail-page__title'],
        contentSelectors: ['main.dx-container.app-content', 'div.article'],
        contentExtractor: 'divLine',
    },
    b: {
        name: 'b',
        chapterSelector: '#chapters .novel-list a',
        titleSelector: 'h4',
        titleSelectors: ['.book-title', 'h1.book-title'],
        contentSelectors: ['#content'],
        contentExtractor: 'pTags',
    }
};
```

**每个字段含义：**

| 字段 | 作用 | 举例 |
|------|------|------|
| `chapterSelector` | 目录页选择章节链接 | `ul li a` |
| `numSelector` | 章节序号元素（可选） | `.badge` |
| `titleSelector` | 章节标题元素 | `h4` |
| `titleSelectors` | 小说标题（用于文件名） | `.book-title` |
| `contentSelectors` | 正文容器选择器（可多个兜底） | `['main...', 'div.article']` |
| `contentExtractor` | 正文提取方式 | `divLine` / `pTags` |

### 4.4 专属正文提取器

#### a 站点 — divLine 提取器

```
a 站点 DOM 结构：
<main class="dx-container app-content">
    <div class="article">
        <div class="line"> 大干王朝，青州郡内。</div>
        <div class="line"> 少年抬起头，目光坚定。</div>
        <div class="line"> ... </div>
    </div>
</main>

提取逻辑：
  1. 用 contentSelectors 找到容器（main 或 div.article）
  2. 在容器内查找所有 div.line 元素
  3. 拼接每个 div.line 的文本 → 就是小说正文
```

#### b 站点 — pTags 提取器

```
b 站点 DOM 结构：
<div id="content">
    <p>第一章 初入江湖</p>
    <p>青山绿水，鸟语花香。</p>
    <p> ... </p>
</div>

提取逻辑：
  1. 用 contentSelectors 找到容器（#content）
  2. 在容器内查找所有 <p> 标签
  3. 拼接每个 <p> 的文本 → 就是小说正文
```

### 4.5 站点识别方式

**不依赖域名**，通过 **CSS 选择器直接匹配 DOM**：

```
scanChapters() 执行顺序：
    1. querySelectorAll(sites.a.chapterSelector) → 命中？→ 用 a 规则
    2. querySelectorAll(sites.b.chapterSelector) → 命中？→ 用 b 规则
    3. 全部未命中 → 提示"未检测到章节链接"
```

### 4.6 章节提取流程

**站点 a：**
```
每个 <a> 元素：
    ├── .detail-page__chapter-badge  → "第1章"
    └── .detail-page__chapter-title  → "狂信徒"
        拼接: "第1章 狂信徒"
```

**站点 b：**
```
每个 <a> 元素：
    └── h4 子元素 → "第一章 初入江湖"
```

**章节编号**：直接使用 DOM 遍历顺序，不解析 URL、不解析 badge 数字。

### 4.7 HTML 请求方式

使用 `overrideMimeType` + `responseText` 直接获取 UTF-8 文本：

```javascript
GM_xmlhttpRequest({
    method: "GET",
    url,
    overrideMimeType: "text/html;charset=utf-8",  // 告诉服务器返回 UTF-8
    onload: (res) => resolve(res.responseText),   // 直接拿到字符串
});
```

**为什么不用 blob + 编码检测？**
早期版本用 blob + FileReader 逐个尝试 utf-8/gbk/gb18030 解码。
这种方式在某些情况下会破坏 HTML 内容（尤其是 GBK 页面的特殊字符）。
`overrideMimeType` 方式由浏览器内部处理编码，更稳定。

### 4.8 为什么要清理 data-novel-info 属性？

a 站点的 main 标签有一个属性：
```html
<main class="dx-container app-content" data-novel-info='{"media_id":"","novel_id":"26502",...}'>
```

这个属性内部的引号在某些情况下会破坏 HTML 解析，导致 DOMParser 无法正确识别 class。
因此在解析前会移除这个属性：
```javascript
const cleaned = html.replace(/data-novel-info="[^"]*"/g, 'data-novel-info=""');
```

### 4.9 章节任务绑定站点配置

每个章节任务在扫描时就绑定了站点的完整配置：
```javascript
chapterList.push({ idx, title, url, globalIndex, site });
```

下载时直接使用任务自带的 site 配置：
```javascript
this.currentSite = task.site;  // 直接使用该章节所属站点
const content = this.clean(this.getContent(doc));
```

这样即使同时下载不同站点的章节，也能各自使用正确的选择器。

### 4.10 并发下载原理

```
假设：并发=5，共100章

Worker 1:  第1章 → 第6章 → 第11章 → ...
Worker 2:  第2章 → 第7章 → 第12章 → ...
Worker 3:  第3章 → 第8章 → 第13章 → ...
Worker 4:  第4章 → 第9章 → 第14章 → ...
Worker 5:  第5章 → 第10章 → 第15章 → ...

5 个 Worker 同时工作，速度提升约 5 倍
```

### 4.11 进度保存与恢复

```
下载进度保存到 localStorage：
  {
    url: "当前页面URL",
    completed: 50,          // 已完成50章
    resultMap: {...},       // 已下载的内容
    chapterList: [...],     // 章节列表
    timestamp: 1234567890   // 保存时间
  }

有效期：24 小时
→ 刷新页面后，24小时内可恢复之前的进度
```

---

## 五、扩展支持新站点

在 `sites` 对象中添加一个新键值对：

```javascript
this.sites = {
    a: { ... },
    b: { ... },
    // 新增站点：
    c: {
        name: 'c',
        chapterSelector: '.章节列表的CSS选择器',
        numSelector: '.章节序号选择器（可选）',
        titleSelector: '.章节标题选择器',
        titleSelectors: ['.小说标题选择器'],
        contentSelectors: ['正文容器选择器'],
        contentExtractor: 'divLine'  // 或 'pTags'，或 'text'（兜底）
    }
};
```

然后在 `scanChapters()` 中增加匹配：

```javascript
const sites = [this.sites.a, this.sites.b, this.sites.c];
// ...
```

**如何找到选择器？**
1. 打开目标网站的目录页
2. 按 F12 打开开发者工具
3. 用元素选择工具（箭头图标）点击章节链接
4. 查看该元素的 class 或其他属性
5. 写成 CSS 选择器格式

---

## 六、配置参数说明

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 并发线程 | 20 | 同时下载的章节数，建议 5-10 |
| 延迟(ms) | 0 | 每章之间的间隔时间 |
| 每分钟限频 | 0 | 0 表示不限频 |
| 重试次数 | 5 | 下载失败后自动重试次数 |

---

## 七、调试指南

如果正文提取为空，打开控制台（F12 → Console）查看日志：

```
[请求] 第1章 - HTML长度: 12345
[请求] HTML预览: <main class="dx-container app-content"...   ← 确认HTML正确获取

[正文] 站点:a 提取器:divLine
[正文] 选择器 "main.dx-container.app-content": 命中         ← 确认选择器匹配
[正文] 容器文本长度: 2000
[divLine] div.line数量: 15                                  ← 确认提取器工作
[正文] 提取结果: 1800字
```

**常见问题排查：**

| 日志现象 | 可能原因 | 解决方法 |
|---------|---------|---------|
| `HTML长度: 0` 或很小 | 请求失败/编码错误 | 降低并发，增加延迟 |
| `选择器 "..." : 未命中` | 选择器写错了/页面结构变了 | 用 F12 检查实际 DOM 结构 |
| `div.line数量: 0` | 提取器类型不对 | 改用 pTags 或 text |
| `所有选择器均未提取到有效内容` | 容器选择器正确但提取器不对 | 检查该站点正文的 HTML 标签 |

---

## 八、常见问题

**Q: 点击下载按钮没反应？**
A: 请确保当前页面是**目录页**（有章节列表的页面），不是章节阅读页。

**Q: 提示"未检测到章节链接"？**
A: 当前页面结构可能不在支持范围内。按 F12 打开控制台查看详细日志。

**Q: 下载的 TXT 文件名不对？**
A: 脚本会尝试提取页面标题，如果失败会用 `<title>` 标签内容。

**Q: 正文抓取为空？**
A: 打开控制台查看 `[正文]` 开头的日志，看选择器是否命中、提取器是否工作。

**Q: 下载很慢或失败？**
A: 降低并发数（建议 5-10），增加延迟时间。