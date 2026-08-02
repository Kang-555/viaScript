// ==UserScript==
// @name         小说下载器-元素版
// @namespace    http://tampermonkey.net/
// @version      5.1
// @description  适配特定小说网站结构，带状态面板和多种优化
// @author       You
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==/UserScript==

class NovelDownloader {
  constructor() {
    this.config = {
      maxConcurrency: 20,
      delay: 0,
      adaptiveDelay: true,
      maxDlPerMin: 0,
      chapterList: [],
      resultMap: {},
      isDownloading: false,
      completed: 0,
      cancel: false,
      retryCount: 5,
    };
    
    this.cache = new Map();
    this.shadowRoot = null;
    this.shadowContainer = null;
    
    this.downloadBtn = null;
    this.statusPanel = null;
    this.progressLabel = null;
    this.progressCurrent = null;
    this.chapterSelector = null;
    
    this.sites = {
      a: {
        name: 'a',
        host: /fanqienovel\.com$/,
        chapterSelector: 'a.detail-page__catalog-item',
        numSelector: '.detail-page__chapter-badge',
        titleSelector: '.detail-page__chapter-title',
        titleSelectors: ['.dx-title.detail-page__title', '.detail-page__title'],
        contentSelectors: ['main.dx-container.app-content', 'div.article'],
        contentExtractor: 'divLine',
      },
      b: {
        name: 'b',
        host: /qidian\.com$/,
        chapterSelector: '#chapters .novel-list a',
        titleSelector: 'h4',
        titleSelectors: ['.book-title', 'h1.book-title'],
        contentSelectors: ['#content'],
        contentExtractor: 'pTags',
      }
    };
    this.currentSite = null;
    
    this.init();
  }
  
  init() {
    this.loadProgress();
    const matched = this.matchSite();
    if (matched) {
      this.createUI();
      console.log(`📖 小说下载器v5.0已就绪 (${matched.name})`);
    } else {
      console.log("📖 小说下载器v5.0 未匹配站点，不注入UI");
    }
  }
  
  matchSite() {
    const sites = [this.sites.a, this.sites.b];
    for (const site of sites) {
      if (site.host && site.host.test(location.hostname)) return site;
    }
    return null;
  }
  
  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  
  async getHtml(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        timeout: 15000,
        overrideMimeType: "text/html;charset=utf-8",
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': window.location.href,
        },
        onload: (res) => resolve(res.responseText),
        onerror: reject,
        ontimeout: reject,
      });
    });
  }
  
  parse(html) {
    if (!html) return document.implementation.createHTMLDocument();
    const cleaned = html.replace(/data-novel-info="[^"]*"/g, 'data-novel-info=""');
    return new DOMParser().parseFromString(cleaned, "text/html");
  }
  
  getContent(doc) {
    if (!this.currentSite || !this.currentSite.contentSelectors) {
      console.warn('无站点配置或无contentSelectors');
      return '';
    }
    
    const extractor = this.currentSite.contentExtractor || 'text';
    console.log(`[正文] 站点:${this.currentSite.name} 提取器:${extractor}`);
    
    for (const sel of this.currentSite.contentSelectors) {
      const el = doc.querySelector(sel);
      console.log(`[正文] 选择器 "${sel}": ${el ? '命中' : '未命中'}`);
      if (!el) continue;
      console.log(`[正文] 容器文本长度: ${(el.textContent || '').trim().length}`);
      const text = this.extractContent(el, extractor);
      console.log(`[正文] 提取结果: ${text ? text.length + '字' : '空'}`);
      if (text && text.length >= 50) return text;
    }
    
    console.warn('[正文] 所有选择器均未提取到有效内容');
    return '';
  }
  
  extractContent(container, type) {
    const clone = container.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,iframe,svg,img,canvas,video,audio,.advertisement,.ad,.ads,.comment,.comments,.review,.recommend,.related,.share,.social,.footer,.header,.sidebar,.navigation,.nav,.menu,.popup,.modal,.dialog').forEach(n => n.remove());
    
    if (type === 'divLine') {
      const lines = clone.querySelectorAll('div.line');
      console.log(`[divLine] div.line数量: ${lines.length}`);
      if (lines.length >= 1) {
        const text = Array.from(lines)
          .map(d => d.textContent.trim())
          .filter(Boolean)
          .join('\n\n');
        if (text.length > 0) return text;
      }
    }
    
    if (type === 'pTags') {
      const ps = clone.querySelectorAll('p');
      console.log(`[pTags] p标签数量: ${ps.length}`);
      if (ps.length > 0) {
        return Array.from(ps)
          .map(p => p.textContent.trim())
          .filter(Boolean)
          .join('\n\n');
      }
    }
    
    const fallback = clone.textContent.trim();
    console.log(`[兜底] 纯文本长度: ${fallback.length}`);
    return fallback;
  }
  
  clean(t) {
    return t?.replace(/\n{3,}/g, "\n\n").trim() || "";
  }
  
  async downloadChapter(task, retry = this.config.retryCount) {
    if (this.config.cancel) return;
    
    const totalTasks = this.config.currentTaskCount || this.config.chapterList.length;
    this.updateStatus(`${this.config.completed + 1}/${totalTasks}`);
    this.updateCurrentChapter(task.title);
    
    if (this.cache.has(task.url)) {
      this.config.resultMap[task.globalIndex] = this.cache.get(task.url);
      this.config.completed++;
      return;
    }
    
    try {
      const html = await this.getHtml(task.url);
      console.log(`[请求] ${task.title} - HTML长度:${html ? html.length : 0}`);
      if (html && html.length > 0) {
        console.log(`[请求] HTML预览: ${html.substring(0, 300)}`);
      }
      const doc = this.parse(html);
      this.currentSite = task.site;
      const content = this.clean(this.getContent(doc));
      
      if (content.length < 50) {
        console.warn(`内容过短: ${task.title} (${content.length} 字符)`);
      }
      
      const result = `${task.title}\n\n${content}\n\n`;
      this.config.resultMap[task.globalIndex] = result;
      this.cache.set(task.url, result);
      
    } catch (e) {
      if (retry > 0) {
        await this.sleep(1000 + Math.random() * 1000);
        return await this.downloadChapter(task, retry - 1);
      }
      console.error(`下载失败: ${task.title} - ${e.message}`);
      this.config.resultMap[task.globalIndex] = `${task.title}\n\n下载失败: ${e.message}\n\n`;
    }
    
    this.config.completed++;
    this.saveProgress();
  }
  
  async startDownload(selectedIndices = null) {
    if (this.config.isDownloading) return;
    
    let tasks = this.config.chapterList;
    if (selectedIndices && selectedIndices.length > 0) {
      tasks = tasks.filter((_, idx) => selectedIndices.includes(idx));
    }
    
    if (tasks.length === 0) {
      this.showNotice("请先选择要下载的章节");
      return;
    }
    
    this.config.isDownloading = true;
    this.config.cancel = false;
    this.config.completed = 0;
    this.config.resultMap = {};
    this.config.currentTaskCount = tasks.length;
    
    const concurrency = this.config.maxConcurrency;
    const minPerMin = this.config.maxDlPerMin;
    let dlCount = 0;
    let index = 0;
    
    console.log(`开始下载 ${tasks.length} 个章节，并发 ${Math.abs(concurrency)} 线程...`);
    this.updateStatus(`0/${tasks.length}`);
    
    const scheduleNext = async (waitTime) => {
      while (index < tasks.length && !this.config.cancel) {
        if (minPerMin > 0) {
          if (dlCount >= minPerMin) {
            await this.sleep(60000);
            dlCount = 0;
          }
          dlCount++;
        }
        
        await this.downloadChapter(tasks[index]);
        index++;
        
        if (waitTime > 0) {
          await this.sleep(waitTime);
        } else if (this.config.adaptiveDelay && this.config.delay > 0) {
          const delay = this.config.delay + Math.random() * 200;
          await this.sleep(delay);
        }
      }
    };
    
    if (concurrency > 0) {
      const workers = [];
      for (let i = 0; i < concurrency && i < tasks.length; i++) {
        workers.push(scheduleNext(this.config.delay));
      }
      await Promise.all(workers);
    } else {
      const waitTime = Math.abs(concurrency) * 1000;
      await scheduleNext(waitTime);
    }
    
    if (!this.config.cancel) {
      this.saveFile();
      this.clearProgress();
      console.log("全部下载完成！");
    } else {
      console.log("用户取消下载");
    }
    
    this.config.isDownloading = false;
    this.hideStatusPanel();
  }
  
  saveFile() {
    let fileName = "未命名小说.txt";
    let novelName = "未命名小说";
    
    const site = this.currentSite;
    let novelTitleEl = null;
    
    if (site && site.titleSelectors) {
      for (const selector of site.titleSelectors) {
        novelTitleEl = document.querySelector(selector);
        if (novelTitleEl) break;
      }
    }
    
    const titleMatch = document.querySelector("title");
    
    if (novelTitleEl) {
      let rawTitle = novelTitleEl.textContent.trim();
      rawTitle = rawTitle.replace(/[<>:"/\\|?*]/g, "_");
      fileName = rawTitle + ".txt";
      novelName = novelTitleEl.textContent.trim();
    } else if (titleMatch) {
      let rawTitle = titleMatch.textContent.trim();
      rawTitle = rawTitle.replace(/[<>:"/\\|?*]/g, "_");
      fileName = rawTitle + ".txt";
      novelName = titleMatch.textContent.trim();
    }
    
    console.log(`💾 文件名: ${fileName}`);
    
    let txt = `${novelName}\n\n`;
    
    Object.keys(this.config.resultMap)
      .map(Number)
      .sort((a, b) => a - b)
      .forEach((index) => {
        const content = this.config.resultMap[index];
        if (content) {
          txt += content;
        }
      });
    
    const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
    
    if (window.navigator.msSaveOrOpenBlob) {
      window.navigator.msSaveOrOpenBlob(blob, fileName);
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    }
    
    console.log(`✅ 文件已保存: ${fileName}`);
  }
  
  scanChapters() {
    this.config.chapterList = [];
    this.currentSite = null;
    
    const sites = [this.sites.a, this.sites.b];
    for (const site of sites) {
      if (site.host && !site.host.test(location.hostname)) continue;
      const links = document.querySelectorAll(site.chapterSelector);
      if (links.length > 0) {
        this.currentSite = site;
        console.log(`📋 匹配: ${site.name} (${links.length} 章)`);
        this.scanChaptersBySite(links, site);
        return;
      }
    }
    this.showNotice("未检测到章节链接，请确保当前页面是目录页");
  }
  
  scanChaptersBySite(links, site) {
    links.forEach((el, idx) => {
      let title = '';
      if (site.numSelector) {
        const numEl = el.querySelector(site.numSelector);
        const titleEl = el.querySelector(site.titleSelector);
        const num = numEl ? numEl.textContent.trim() : '';
        const titleText = titleEl ? titleEl.textContent.trim() : '';
        title = [num, titleText].filter(Boolean).join(' ');
      } else {
        const titleEl = el.querySelector(site.titleSelector);
        title = titleEl ? titleEl.textContent.trim() : el.textContent.trim();
      }
      if (title) {
        this.config.chapterList.push({ idx, title, url: el.href, globalIndex: idx, site });
      }
    });
    this.finalizeChapters(site.name);
  }
  
  finalizeChapters(siteName) {
    const seenUrls = new Set();
    this.config.chapterList = this.config.chapterList.filter((item) => {
      if (seenUrls.has(item.url)) return false;
      seenUrls.add(item.url);
      return item.title.length >= 2;
    });
    
    this.config.chapterList.forEach((item, i) => {
      item.globalIndex = i;
    });
    
    console.log(`📋 ${siteName}: ${this.config.chapterList.length} 章`);
  }
  
  initShadow() {
    if (this.shadowContainer) return;
    this.shadowContainer = document.createElement("div");
    this.shadowContainer.id = "novel-downloader-root";
    this.shadowContainer.style.cssText = "all: initial; display: block;";
    this.shadowRoot = this.shadowContainer.attachShadow({ mode: "open" });
    
    const style = document.createElement("style");
    style.textContent = `
      .nd-btn {
        position: fixed;
        right: 20px;
        top: 50%;
        z-index: 2147483647;
        padding: 12px 20px;
        background-color: #4CAF50;
        color: white;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-size: 14px;
        font-weight: bold;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        transition: all 0.3s ease;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .nd-btn:hover {
        transform: scale(1.05);
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      }
      .nd-btn:active {
        transform: scale(0.98);
      }
      .nd-panel {
        position: fixed;
        right: 20px;
        top: 50%;
        transform: translateY(-50%);
        z-index: 2147483647;
        width: 280px;
        padding: 16px;
        background-color: #ffffff;
        border: 1px solid #e0e0e0;
        border-radius: 10px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.15);
        font-size: 13px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #333;
        box-sizing: border-box;
      }
      .nd-panel-title {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
      }
      .nd-panel-title h3 {
        margin: 0;
        color: #333;
        font-size: 15px;
        font-weight: bold;
      }
      .nd-panel-title span {
        color: #888;
        font-size: 11px;
      }
      .nd-mode-group {
        margin-bottom: 10px;
      }
      .nd-mode-option {
        display: flex;
        align-items: center;
        padding: 6px 8px;
        background: #f5f5f5;
        border-radius: 5px;
        cursor: pointer;
        margin-bottom: 6px;
      }
      .nd-mode-option input[type="radio"] {
        margin-right: 8px;
        cursor: pointer;
      }
      .nd-range-inputs {
        display: flex;
        gap: 6px;
        padding-left: 24px;
        align-items: center;
      }
      .nd-range-inputs input[type="number"] {
        width: 70px;
        padding: 5px;
        border: 1px solid #ddd;
        border-radius: 4px;
        font-size: 12px;
      }
      .nd-range-inputs span {
        color: #888;
        font-size: 12px;
      }
      .nd-settings {
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid #eee;
      }
      .nd-settings-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
      }
      .nd-settings-row label {
        color: #666;
        font-size: 12px;
      }
      .nd-settings-row input[type="number"] {
        width: 80px;
        padding: 4px 6px;
        border: 1px solid #ddd;
        border-radius: 4px;
        font-size: 12px;
        text-align: right;
      }
      .nd-settings-tip {
        color: #999;
        font-size: 11px;
        margin-top: 4px;
      }
      .nd-actions {
        display: flex;
        gap: 8px;
        margin-top: 14px;
      }
      .nd-btn-primary {
        flex: 2;
        padding: 10px;
        background: #4CAF50;
        color: white;
        border: none;
        border-radius: 5px;
        cursor: pointer;
        font-size: 13px;
        font-weight: bold;
      }
      .nd-btn-primary:hover {
        background: #45a049;
      }
      .nd-btn-secondary {
        flex: 1;
        padding: 10px;
        background: #9E9E9E;
        color: white;
        border: none;
        border-radius: 5px;
        cursor: pointer;
        font-size: 13px;
      }
      .nd-btn-secondary:hover {
        background: #757575;
      }
      .nd-progress-panel {
        position: fixed;
        right: 20px;
        top: 50%;
        transform: translateY(-50%);
        z-index: 2147483647;
        width: 260px;
        padding: 18px;
        background-color: #ffffff;
        border: 1px solid #e0e0e0;
        border-radius: 10px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.15);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .nd-progress-title {
        margin-bottom: 8px;
        color: #333;
        font-weight: bold;
        font-size: 14px;
      }
      .nd-progress-text {
        color: #333;
        text-align: center;
        margin-bottom: 8px;
        font-size: 15px;
        font-weight: bold;
      }
      .nd-progress-current {
        color: #666;
        text-align: center;
        margin-bottom: 15px;
        font-size: 13px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .nd-btn-cancel {
        width: 100%;
        padding: 10px;
        background-color: #f44336;
        color: white;
        border: none;
        border-radius: 5px;
        cursor: pointer;
        font-size: 13px;
      }
      .nd-btn-cancel:hover {
        background-color: #d32f2f;
      }
      .nd-notice {
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background-color: #f44336;
        color: white;
        padding: 12px 24px;
        border-radius: 8px;
        z-index: 2147483647;
        font-size: 14px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        animation: nd-slideDown 0.3s ease;
      }
      @keyframes nd-slideDown {
        from { transform: translateX(-50%) translateY(-20px); opacity: 0; }
        to { transform: translateX(-50%) translateY(0); opacity: 1; }
      }
    `;
    this.shadowRoot.appendChild(style);
    document.body.appendChild(this.shadowContainer);
  }
  
  createUI() {
    this.initShadow();
    
    this.downloadBtn = document.createElement("button");
    this.downloadBtn.className = "nd-btn";
    this.downloadBtn.textContent = "下载小说";
    
    this.downloadBtn.onclick = () => {
      this.scanChapters();
      if (this.config.chapterList.length > 0) {
        this.showChapterSelector();
      } else {
        this.showNotice("未检测到章节链接，请确保当前页面是目录页");
      }
    };
    
    this.shadowRoot.appendChild(this.downloadBtn);
  }
  
  showChapterSelector() {
    this.downloadBtn.style.display = "none";
    const total = this.config.chapterList.length;
    const siteName = this.currentSite ? this.currentSite.name : 'unknown';
    
    this.chapterSelector = document.createElement("div");
    this.chapterSelector.className = "nd-panel";
    
    this.chapterSelector.innerHTML = `
      <div class="nd-panel-title">
        <h3>下载设置</h3>
        <span>${siteName} · ${total}章</span>
      </div>
      
      <div class="nd-mode-group">
        <label class="nd-mode-option">
          <input type="radio" name="dlMode" value="all" checked>
          <span>下载全部（1 - ${total}）</span>
        </label>
      </div>
      
      <div class="nd-mode-group">
        <label class="nd-mode-option">
          <input type="radio" name="dlMode" value="range">
          <span>自定义范围</span>
        </label>
        <div class="nd-range-inputs">
          <input type="number" id="rangeStart" min="1" max="${total}" value="1">
          <span>至</span>
          <input type="number" id="rangeEnd" min="1" max="${total}" value="${total}">
        </div>
      </div>
      
      <div class="nd-mode-group">
        <label class="nd-mode-option">
          <input type="radio" name="dlMode" value="firstN">
          <span>仅下载前 N 章</span>
        </label>
        <div class="nd-range-inputs">
          <span>前</span>
          <input type="number" id="firstN" min="1" max="${total}" value="10">
          <span>章</span>
        </div>
      </div>
      
      <div class="nd-settings">
        <div class="nd-settings-row">
          <label>并发线程</label>
          <input type="number" id="concurrencyInput" min="-20" max="50" value="${this.config.maxConcurrency}">
        </div>
        <div class="nd-settings-row">
          <label>延迟(ms)</label>
          <input type="number" id="delayInput" min="0" max="5000" value="${this.config.delay}">
        </div>
        <div class="nd-settings-row">
          <label>每分钟限频</label>
          <input type="number" id="maxPerMinInput" min="0" max="1000" value="${this.config.maxDlPerMin}" placeholder="0不限">
        </div>
        <div class="nd-settings-tip">并发为负表示单线程，值越大间隔越长</div>
      </div>
      
      <div class="nd-actions">
        <button id="startDownloadBtn" class="nd-btn-primary">开始下载</button>
        <button id="closeSelectorBtn" class="nd-btn-secondary">关闭</button>
      </div>
    `;
    
    this.shadowRoot.appendChild(this.chapterSelector);
    
    this.chapterSelector.querySelector('#startDownloadBtn').onclick = () => {
      const mode = this.chapterSelector.querySelector('input[name="dlMode"]:checked').value;
      let selectedIndices = [];
      
      if (mode === 'all') {
        selectedIndices = this.config.chapterList.map((_, i) => i);
      } else if (mode === 'range') {
        const s = parseInt(this.chapterSelector.querySelector('#rangeStart').value) || 1;
        const e = parseInt(this.chapterSelector.querySelector('#rangeEnd').value) || total;
        const startIdx = Math.max(0, s - 1);
        const endIdx = Math.min(total, e);
        for (let i = startIdx; i < endIdx; i++) selectedIndices.push(i);
      } else if (mode === 'firstN') {
        const n = parseInt(this.chapterSelector.querySelector('#firstN').value) || 10;
        for (let i = 0; i < Math.min(n, total); i++) selectedIndices.push(i);
      }
      
      if (selectedIndices.length === 0) {
        this.showNotice("没有选择任何章节");
        return;
      }
      
      this.config.maxConcurrency = parseInt(this.chapterSelector.querySelector('#concurrencyInput').value) || 20;
      this.config.delay = parseInt(this.chapterSelector.querySelector('#delayInput').value) || 0;
      this.config.maxDlPerMin = parseInt(this.chapterSelector.querySelector('#maxPerMinInput').value) || 0;
      
      this.chapterSelector.remove();
      this.chapterSelector = null;
      this.showStatusPanel();
      setTimeout(() => {
        this.startDownload(selectedIndices);
      }, 100);
    };
    
    this.chapterSelector.querySelector('#closeSelectorBtn').onclick = () => {
      this.chapterSelector.remove();
      this.chapterSelector = null;
      this.downloadBtn.style.display = "block";
    };
  }
  
  showStatusPanel() {
    this.statusPanel = document.createElement("div");
    this.statusPanel.className = "nd-progress-panel";
    
    this.statusPanel.innerHTML = `
      <div class="nd-progress-title">下载中...</div>
      <div id="progressText" class="nd-progress-text">0/0</div>
      <div id="progressCurrent" class="nd-progress-current">准备开始...</div>
      <button id="cancelBtn" class="nd-btn-cancel">取消下载</button>
    `;
    
    this.shadowRoot.appendChild(this.statusPanel);
    
    this.progressLabel = this.statusPanel.querySelector('#progressText');
    this.progressCurrent = this.statusPanel.querySelector('#progressCurrent');
    
    this.statusPanel.querySelector('#cancelBtn').onclick = () => {
      this.config.cancel = true;
      this.progressLabel.textContent = "已取消";
    };
  }
  
  hideStatusPanel() {
    if (this.statusPanel) {
      this.statusPanel.remove();
      this.statusPanel = null;
    }
    if (this.chapterSelector) {
      this.chapterSelector.remove();
      this.chapterSelector = null;
    }
    if (this.downloadBtn) {
      this.downloadBtn.style.display = "block";
    }
  }
  
  updateStatus(progress) {
    if (this.progressLabel) {
      this.progressLabel.textContent = progress;
    }
  }
  
  updateCurrentChapter(title) {
    if (this.progressCurrent) {
      this.progressCurrent.textContent = title;
    }
  }
  
  showNotice(message) {
    const notice = document.createElement("div");
    notice.className = "nd-notice";
    notice.textContent = message;
    this.shadowRoot.appendChild(notice);
    
    setTimeout(() => {
      if (notice.parentNode) {
        notice.remove();
      }
    }, 3000);
  }
  
  saveProgress() {
    try {
      localStorage.setItem('novel_download_progress', JSON.stringify({
        url: window.location.href,
        completed: this.config.completed,
        resultMap: this.config.resultMap,
        chapterList: this.config.chapterList,
        timestamp: Date.now(),
      }));
    } catch (e) {
      console.warn('无法保存进度:', e);
    }
  }
  
  loadProgress() {
    try {
      const saved = localStorage.getItem('novel_download_progress');
      if (saved) {
        const data = JSON.parse(saved);
        // 只恢复24小时内的进度
        if (data.url === window.location.href && Date.now() - data.timestamp < 24 * 60 * 60 * 1000) {
          this.config.completed = data.completed || 0;
          this.config.resultMap = data.resultMap || {};
          this.config.chapterList = data.chapterList || [];
          console.log(`📤 恢复进度: ${this.config.completed}/${this.config.chapterList.length}`);
        }
      }
    } catch (e) {
      console.warn('无法加载进度:', e);
    }
  }
  
  clearProgress() {
    try {
      localStorage.removeItem('novel_download_progress');
    } catch (e) {
      console.warn('无法清除进度:', e);
    }
  }
}

new NovelDownloader();