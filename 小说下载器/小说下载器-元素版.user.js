// ==UserScript==
// @name         小说下载器-元素版
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  适配特定小说网站结构，带状态面板和多种优化
// @author       You
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==/UserScript==

class NovelDownloader {
  constructor() {
    // 配置
    this.config = {
      maxConcurrency: 4,
      delay: 500,
      adaptiveDelay: true,
      chapterList: [],
      resultMap: {},
      isDownloading: false,
      completed: 0,
      cancel: false,
      retryCount: 3,
    };
    
    // 缓存
    this.cache = new Map();
    
    // UI元素
    this.downloadBtn = null;
    this.statusPanel = null;
    this.progressLabel = null;
    this.progressFill = null;
    this.cancelButton = null;
    this.chapterSelector = null;
    
    // 网站适配规则
    this.siteRules = {
      'default': {
        chapterSelectors: [
          '.novel-list a', 
          '.chapter_list a', 
          '#list a', 
          '.menu-list a', 
          '.detail-page_catalog-item a',
          '#chapters .novel-list a',  // 新增：#chapters 下的 .novel-list
        ],
        titleSelectors: [
          '.dx-title.detail-page__title', 
          '.detail-page__title', 
          '.book-title', 
          '.novel-title',
          '.info h1',  // 新增：.info 下的 h1 标签
        ],
        contentSelectors: ['#content', '.content', '.novel-content', '#chapter-content'],
      }
    };
    
    this.init();
  }
  
  init() {
    this.loadProgress();
    this.createUI();
    console.log("📖 小说下载器v3.0已就绪");
  }
  
  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  
  // 请求HTML（带编码自动检测和请求头伪装）
  async getHtml(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        timeout: 15000,
        responseType: "blob",
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': window.location.href,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
        },
        onload: (res) => {
          this.decodeHtml(res.response, resolve, reject);
        },
        onerror: reject,
        ontimeout: reject,
      });
    });
  }
  
  // 编码自动检测
  decodeHtml(blob, resolve, reject) {
    const encodings = ['utf-8', 'gbk', 'gb2312', 'big5', 'gb18030'];
    let index = 0;
    
    const tryDecode = () => {
      if (index >= encodings.length) {
        reject(new Error('无法识别编码'));
        return;
      }
      
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result;
        if (text.includes('\uFFFD')) {
          index++;
          tryDecode();
        } else {
          resolve(text);
        }
      };
      reader.onerror = () => {
        index++;
        tryDecode();
      };
      reader.readAsText(blob, encodings[index]);
    };
    
    tryDecode();
  }
  
  parse(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }
  
  getSiteRule() {
    const domain = window.location.hostname;
    for (const [site, rule] of Object.entries(this.siteRules)) {
      if (domain.includes(site)) return rule;
    }
    return this.siteRules['default'];
  }
  
  getContent(doc) {
    const rule = this.getSiteRule();
    for (const selector of rule.contentSelectors) {
      const el = doc.querySelector(selector);
      if (el) {
        const ps = el.querySelectorAll("p");
        if (ps.length) {
          return Array.from(ps)
            .map((p) => p.innerText.trim())
            .filter(Boolean)
            .join("\n\n");
        }
        return el.innerText.trim();
      }
    }
    return "";
  }
  
  clean(t) {
    return t?.replace(/\n{3,}/g, "\n\n").trim() || "";
  }
  
  // 下载单章（带重试机制和缓存）
  async downloadChapter(task, retry = this.config.retryCount) {
    if (this.config.cancel) return;
    
    // 使用当前任务总数计算进度
    const totalTasks = this.config.currentTaskCount || this.config.chapterList.length;
    this.updateStatus(`${this.config.completed + 1}/${totalTasks}`);
    
    // 检查缓存
    if (this.cache.has(task.url)) {
      // 使用 globalIndex 存储，保证顺序正确
      this.config.resultMap[task.globalIndex] = this.cache.get(task.url);
      this.config.completed++;
      console.log(`✅ 缓存完成: ${task.title}`);
      return;
    }
    
    try {
      const html = await this.getHtml(task.url);
      const doc = this.parse(html);
      const content = this.clean(this.getContent(doc));
      
      if (content.length < 50) {
        console.warn(`⚠️ 内容过短: ${task.title} (${content.length} 字符)`);
      }
      
      const result = `${task.title}\n\n${content}\n\n`;
      // 使用 globalIndex 存储，保证顺序正确
      this.config.resultMap[task.globalIndex] = result;
      this.cache.set(task.url, result);
      console.log(`✅ 完成: ${task.title}`);
      
    } catch (e) {
      if (retry > 0) {
        console.log(`🔄 重试 ${task.title} (剩余${retry}次)`);
        await this.sleep(1000);
        await this.downloadChapter(task, retry - 1);
        return;
      }
      console.error(`❌ 失败: ${task.title} - ${e.message}`);
      // 使用 globalIndex 存储
      this.config.resultMap[task.globalIndex] = `${task.title}\n\n下载失败: ${e.message}\n\n`;
    }
    
    this.config.completed++;
    this.saveProgress();
  }
  
  // 并发下载（带自适应延迟）
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
    this.config.currentTaskCount = tasks.length;  // 保存当前任务数量
    
    console.log(`🚀 开始下载 ${tasks.length} 个章节...`);
    this.updateStatus(`0/${tasks.length}`);
    
    let index = 0;
    const worker = async () => {
      while (index < tasks.length && !this.config.cancel) {
        await this.downloadChapter(tasks[index++]);
        const delay = this.config.adaptiveDelay ? 
          this.config.delay + Math.random() * 200 : 
          this.config.delay;
        await this.sleep(delay);
      }
    };
    
    await Promise.all(Array(this.config.maxConcurrency).fill(0).map(worker));
    
    if (!this.config.cancel) {
      this.saveFile();
      this.clearProgress();
      console.log("✅ 全部下载完成！");
    } else {
      console.log("⚠️ 用户取消下载");
    }
    
    this.config.isDownloading = false;
    this.hideStatusPanel();
  }
  
  saveFile() {
    let fileName = "未命名小说.txt";
    let novelName = "未命名小说";
    
    const rule = this.getSiteRule();
    let novelTitleEl = null;
    
    for (const selector of rule.titleSelectors) {
      novelTitleEl = document.querySelector(selector);
      if (novelTitleEl) break;
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
    
    // 按 globalIndex 顺序输出，保证章节顺序正确
    // 只输出有内容的章节（支持部分章节下载）
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
  
  // 从URL中提取章节序号
  extractChapterNumber(url) {
    // 匹配常见的URL模式：
    // /chapter/123/456.html → 456
    // /c/123.html → 123
    // /123.html → 123
    // chapter_123.html → 123
    
    const patterns = [
      /chapter\/\d+\/(\d+)(?:\.html)?/,   // /chapter/123/456.html
      /\/c\/(\d+)(?:\.html)?/,             // /c/123.html
      /\/(\d+)(?:\.html)?$/,               // /123.html
      /chapter[_-](\d+)/i,                 // chapter_123 或 chapter-123
      /(\d+)(?:\.html)?$/,                 // 123.html
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return parseInt(match[1], 10);
    }
    return null;
  }
  
  scanChapters() {
    this.config.chapterList = [];
    const rule = this.getSiteRule();
    
    const selector = rule.chapterSelectors.join(', ');
    const chapterLinks = document.querySelectorAll(selector);
    
    let idx = 0;
    chapterLinks.forEach((a) => {
      let titleElement = a.querySelector("h4");
      if (!titleElement) titleElement = a.querySelector(".detail-page-chapter-title");
      if (!titleElement) titleElement = a.querySelector("span");
      if (!titleElement) titleElement = a.querySelector("div");
      if (!titleElement) titleElement = a;
      
      if (titleElement) {
        const title = titleElement.textContent.trim();
        if (title.length > 0) {
          // 从URL提取序号
          const chapterNum = this.extractChapterNumber(a.href);
          
          this.config.chapterList.push({
            idx: idx++,
            title: title,
            url: a.href,
            chapterNum: chapterNum,  // 新增：URL中的章节序号
            globalIndex: 0,          // 新增：全局排序索引
          });
        }
      }
    });
    
    // 去重
    const seenUrls = new Set();
    this.config.chapterList = this.config.chapterList.filter((item) => {
      if (seenUrls.has(item.url)) return false;
      seenUrls.add(item.url);
      return true;
    });
    
    // 关键：按章节序号排序
    // 优先按URL序号排序，序号缺失时按原始顺序
    this.config.chapterList.sort((a, b) => {
      // 都有序号时按序号排序
      if (a.chapterNum !== null && b.chapterNum !== null) {
        return a.chapterNum - b.chapterNum;
      }
      // 都没有序号时按原始顺序
      return a.idx - b.idx;
    });
    
    // 分配全局索引（下载时用这个索引存储）
    this.config.chapterList.forEach((item, i) => {
      item.globalIndex = i;
    });
    
    console.log(`📋 检测到 ${this.config.chapterList.length} 个章节`);
    if (this.config.chapterList.length > 0) {
      console.log("前3个章节:", this.config.chapterList.slice(0, 3));
    }
  }
  
  createUI() {
    this.downloadBtn = document.createElement("button");
    this.downloadBtn.textContent = "📖 下载小说";
    this.downloadBtn.style.cssText = `
      position: fixed;
      right: 20px;
      top: 50%;
      z-index: 999999;
      padding: 12px 20px;
      background-color: #4CAF50;
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 16px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      transition: all 0.3s ease;
    `;
    
    this.downloadBtn.onmouseover = () => {
      this.downloadBtn.style.transform = "scale(1.05)";
      this.downloadBtn.style.boxShadow = "0 4px 12px rgba(0,0,0,0.3)";
    };
    
    this.downloadBtn.onmouseout = () => {
      this.downloadBtn.style.transform = "scale(1)";
      this.downloadBtn.style.boxShadow = "0 2px 8px rgba(0,0,0,0.2)";
    };
    
    this.downloadBtn.onclick = () => {
      this.scanChapters();
      if (this.config.chapterList.length > 0) {
        this.showChapterSelector();
      } else {
        this.showNotice("未检测到章节链接，请确保当前页面是目录页");
      }
    };
    
    document.body.appendChild(this.downloadBtn);
  }
  
  showChapterSelector() {
    this.downloadBtn.style.display = "none";
    
    this.chapterSelector = document.createElement("div");
    this.chapterSelector.style.cssText = `
      position: fixed;
      right: 20px;
      top: 50%;
      transform: translateY(-50%);
      z-index: 999999;
      width: 320px;
      max-height: 60vh;
      padding: 20px;
      background-color: white;
      border: 1px solid #e0e0e0;
      border-radius: 10px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.15);
      font-size: 14px;
      line-height: 1.5;
      overflow: hidden;
    `;
    
    this.chapterSelector.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
        <h3 style="margin: 0; color: #333;">选择章节</h3>
        <span style="color: #666; font-size: 12px;">共 ${this.config.chapterList.length} 章</span>
      </div>
      <div style="display: flex; gap: 8px; margin-bottom: 15px;">
        <button id="selectAllBtn" style="flex: 1; padding: 6px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer;">全选</button>
        <button id="selectNoneBtn" style="flex: 1; padding: 6px; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer;">取消</button>
        <button id="selectRangeBtn" style="flex: 1; padding: 6px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer;">范围</button>
      </div>
      <div id="chapterListContainer" style="max-height: 300px; overflow-y: auto; margin-bottom: 15px; border: 1px solid #eee; border-radius: 5px; padding: 5px;">
        ${this.config.chapterList.map((ch, i) => `
          <label style="display: block; padding: 5px 8px; cursor: pointer; border-radius: 3px; transition: background 0.2s;">
            <input type="checkbox" checked class="chapter-checkbox" data-idx="${i}">
            <span style="margin-left: 8px;">${ch.title}</span>
          </label>
        `).join('')}
      </div>
      <div style="display: flex; gap: 10px;">
        <button id="startDownloadBtn" style="flex: 2; padding: 10px; background: #4CAF50; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 14px;">开始下载</button>
        <button id="closeSelectorBtn" style="flex: 1; padding: 10px; background: #9E9E9E; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 14px;">关闭</button>
      </div>
    `;
    
    document.body.appendChild(this.chapterSelector);
    
    // 绑定事件
    document.getElementById('selectAllBtn').onclick = () => {
      document.querySelectorAll('.chapter-checkbox').forEach(cb => cb.checked = true);
    };
    
    document.getElementById('selectNoneBtn').onclick = () => {
      document.querySelectorAll('.chapter-checkbox').forEach(cb => cb.checked = false);
    };
    
    document.getElementById('selectRangeBtn').onclick = () => {
      const start = prompt('起始章节（从0开始）:');
      const end = prompt('结束章节（不包含）:');
      if (start !== null && end !== null) {
        const startIdx = parseInt(start);
        const endIdx = parseInt(end);
        document.querySelectorAll('.chapter-checkbox').forEach((cb, i) => {
          cb.checked = i >= startIdx && i < endIdx;
        });
      }
    };
    
    document.getElementById('startDownloadBtn').onclick = () => {
      const selectedIndices = Array.from(document.querySelectorAll('.chapter-checkbox:checked'))
        .map(cb => parseInt(cb.dataset.idx));
      
      if (selectedIndices.length === 0) {
        this.showNotice("请至少选择一个章节");
        return;
      }
      
      this.chapterSelector.remove();
      this.chapterSelector = null;
      this.showStatusPanel();
      this.startDownload(selectedIndices);
    };
    
    document.getElementById('closeSelectorBtn').onclick = () => {
      this.chapterSelector.remove();
      this.chapterSelector = null;
      this.downloadBtn.style.display = "block";
    };
  }
  
  showStatusPanel() {
    this.statusPanel = document.createElement("div");
    this.statusPanel.style.cssText = `
      position: fixed;
      right: 20px;
      top: 50%;
      transform: translateY(-50%);
      z-index: 999999;
      width: 250px;
      padding: 20px;
      background-color: white;
      border: 1px solid #e0e0e0;
      border-radius: 10px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.15);
      font-size: 14px;
      line-height: 1.5;
    `;
    
    // 进度条
    this.statusPanel.innerHTML = `
      <div style="margin-bottom: 10px; color: #333; font-weight: bold;">📥 下载中...</div>
      <div style="width: 100%; height: 6px; background-color: #eee; border-radius: 3px; overflow: hidden; margin-bottom: 10px;">
        <div id="progress-fill" style="height: 100%; background: linear-gradient(90deg, #4CAF50, #8BC34A); width: 0%; transition: width 0.3s ease;"></div>
      </div>
      <div id="download-progress" style="color: #666; text-align: center; margin-bottom: 15px;">进度：0/0</div>
      <button id="cancelDownloadBtn" style="width: 100%; padding: 10px; background-color: #f44336; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 14px;">取消下载</button>
    `;
    
    this.progressLabel = document.getElementById('download-progress');
    this.progressFill = document.getElementById('progress-fill');
    
    document.getElementById('cancelDownloadBtn').onclick = () => {
      this.config.cancel = true;
      this.progressLabel.textContent = "正在取消...";
    };
    
    document.body.appendChild(this.statusPanel);
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
      const [current, total] = progress.split('/').map(Number);
      const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
      this.progressLabel.textContent = `进度：${progress} (${percentage}%)`;
      
      if (this.progressFill) {
        this.progressFill.style.width = `${percentage}%`;
      }
    }
  }
  
  showNotice(message) {
    const notice = document.createElement("div");
    notice.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background-color: #f44336;
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      z-index: 9999999;
      font-size: 16px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      animation: slideDown 0.3s ease;
    `;
    
    const style = document.createElement('style');
    style.textContent = `
      @keyframes slideDown {
        from { transform: translateX(-50%) translateY(-20px); opacity: 0; }
        to { transform: translateX(-50%) translateY(0); opacity: 1; }
      }
    `;
    document.head.appendChild(style);
    
    notice.textContent = message;
    document.body.appendChild(notice);
    
    setTimeout(() => {
      if (notice.parentNode) {
        notice.remove();
      }
      style.remove();
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