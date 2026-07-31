// ==UserScript==
// @name         小说下载器-自动爬取版
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  在正文页提取文本，根据下一章链接请求循环爬取
// @author       You
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    class AutoNovelCrawler {
        constructor() {
            this.config = {
                isCrawling: false,
                isManualMode: false,
                chapters: [],
                currentChapterIndex: 0,
                selectedChapters: new Set(),
                delay: 1500,
                minContentLength: 100,
                lastScrollTop: 0,
            };

            this.shadowRoot = null;
            this.shadowContainer = null;
            this.controlBtn = null;
            this.statusPanel = null;

            this.nextBtnSelectors = [
                '.next a',
                '.next-chapter a',
                '#next a',
                'a[href*="next"]',
                '.page-next a',
                '.chapter-next a',
                'a.btn-next',
                'a.next',
            ];

            this.contentSelectors = [
                'article#chapterContent',
                '#content',
                '.content',
                '.article',
                '.read-content',
                '.chapter-content',
                '.content_txt',
            ];

            this.titleSelectors = [
                'h1',
                '.title',
                '.chapter-title',
                'h2',
                'h3',
                '.xs-title',
            ];

            this.init();
        }

        init() {
            this.tabId = this.generateTabId();
            this.loadChapters();
            this.createUI();
            console.log("📖 小说自动爬取器 v1.0 已就绪");
        }

        generateTabId() {
            return 'tab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        }

        getStorageKey() {
            return 'autoNovelCrawler_chapters_' + this.tabId;
        }

        loadChapters() {
            const saved = GM_getValue(this.getStorageKey());
            if (saved) {
                try {
                    this.config.chapters = JSON.parse(saved);
                    for (let i = 0; i < this.config.chapters.length; i++) {
                        this.config.selectedChapters.add(i);
                    }
                    console.log(`📂 加载已保存章节: ${this.config.chapters.length} 章`);
                } catch (e) {
                    console.warn('加载章节失败:', e);
                }
            }
        }

        saveChapters() {
            GM_setValue(this.getStorageKey(), JSON.stringify(this.config.chapters));
        }

        sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        parseHtml(html) {
            if (!html) return document.implementation.createHTMLDocument();
            return new DOMParser().parseFromString(html, "text/html");
        }

        async getHtml(url) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "GET",
                    url,
                    timeout: 15000,
                    overrideMimeType: "text/html;charset=utf-8",
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': window.location.href,
                    },
                    onload: (res) => resolve(res.responseText),
                    onerror: (e) => reject(new Error('网络请求失败')),
                    ontimeout: () => reject(new Error('请求超时')),
                });
            });
        }

        getCurrentTitle(doc) {
            const targetDoc = doc || document;
            for (const selector of this.titleSelectors) {
                const el = targetDoc.querySelector(selector);
                if (el && el.textContent.trim()) {
                    return el.textContent.trim();
                }
            }
            return targetDoc.title || '未知章节';
        }

        getCurrentContent(doc) {
            const targetDoc = doc || document;
            for (const selector of this.contentSelectors) {
                const el = targetDoc.querySelector(selector);
                if (el) {
                    return this.extractContent(el);
                }
            }
            return '';
        }

        extractContent(container) {
            const clone = container.cloneNode(true);
            clone.querySelectorAll('script,style,noscript,iframe,.ad,.ads,.advertisement').forEach(n => n.remove());

            const ps = clone.querySelectorAll('p');
            if (ps.length > 0) {
                return Array.from(ps)
                    .map(p => p.textContent.trim())
                    .filter(Boolean)
                    .join('\n\n');
            }

            return clone.textContent.trim();
        }

        cleanText(text) {
            if (!text) return '';
            let result = text.replace(/\r/g, '');
            result = result.replace(/\n{3,}/g, '\n\n');
            return result.trim();
        }

        findNextUrl(doc) {
            const targetDoc = doc || document;
            
            for (const selector of this.nextBtnSelectors) {
                try {
                    const el = targetDoc.querySelector(selector);
                    if (el && el.href) return el.href;
                } catch (e) {}
            }

            const allLinks = targetDoc.querySelectorAll('a');
            for (const link of allLinks) {
                const text = link.textContent.trim();
                if ((text.includes('下一章') || text.includes('下一')) && link.href) {
                    return link.href;
                }
            }

            return null;
        }

        async startCrawl() {
            if (this.config.isCrawling) {
                console.log('⚠️ 正在爬取中');
                return;
            }

            this.config.isCrawling = true;
            console.log('🚀 开始自动爬取...');
            this.updateStatus();

            let currentUrl = window.location.href;
            let chapterCount = 0;

            while (this.config.isCrawling) {
                try {
                    console.log(`📖 正在请求: ${currentUrl}`);
                    this.updateCurrentUrl(currentUrl);

                    const html = await this.getHtml(currentUrl);
                    const doc = this.parseHtml(html);

                    const title = this.getCurrentTitle(doc);
                    const content = this.getCurrentContent(doc);

                    if (!content || content.length < this.config.minContentLength) {
                        console.warn(`⚠️ 章节内容为空或过短`);
                        break;
                    }

                    const nextUrl = this.findNextUrl(doc);

                    const exists = this.config.chapters.some(c => c.url === currentUrl);
                    if (!exists) {
                        const chapter = {
                            title: title,
                            content: this.cleanText(content),
                            url: currentUrl,
                            nextUrl: nextUrl,
                            timestamp: Date.now(),
                        };
                        this.config.chapters.push(chapter);
                        this.saveChapters();
                        chapterCount++;
                        console.log(`📚 已保存 [${chapterCount}]: ${title}`);
                        this.updateChapterCount();
                    } else {
                        console.log(`⏭️ 已存在，跳过`);
                        break;
                    }

                    if (!nextUrl) {
                        console.log('⚠️ 未找到下一章链接，切换到手动下滑模式');
                        this.startManualMode();
                        return;
                    }

                    currentUrl = nextUrl;
                    console.log(`⏳ 等待 ${this.config.delay}ms...`);
                    await this.sleep(this.config.delay);

                } catch (e) {
                    console.error(`❌ 请求失败: ${e.message}`);
                    break;
                }
            }

            this.config.isCrawling = false;
            this.updateStatus();
            console.log(`✅ 爬取完成！共 ${chapterCount} 章`);
        }

        stopCrawl() {
            this.config.isCrawling = false;
            this.config.isManualMode = false;
            this.removeScrollListener();
            console.log('⏹️ 已停止');
            this.updateStatus();
        }

        startManualMode() {
            this.config.isManualMode = true;
            this.config.isCrawling = true;
            this.config.currentChapterIndex = this.config.chapters.length;
            console.log('🔄 进入手动下滑模式，请向下滚动页面');
            this.updateStatus();
            this.addScrollListener();
        }

        addScrollListener() {
            this.scrollHandler = () => this.handleScroll();
            window.addEventListener('scroll', this.scrollHandler, { passive: true });
        }

        removeScrollListener() {
            if (this.scrollHandler) {
                window.removeEventListener('scroll', this.scrollHandler);
                this.scrollHandler = null;
            }
        }

        handleScroll() {
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
            const scrollHeight = document.documentElement.scrollHeight;
            const clientHeight = document.documentElement.clientHeight;

            if (scrollTop <= this.config.lastScrollTop) {
                this.config.lastScrollTop = scrollTop;
                return;
            }

            this.config.lastScrollTop = scrollTop;

            const content = this.getCurrentContent(document);
            if (!content || content.length < this.config.minContentLength) {
                return;
            }

            const exists = this.config.chapters.some(c => c.url === window.location.href);
            if (exists) {
                return;
            }

            const title = this.getCurrentTitle(document);
            const nextUrl = this.findNextUrl(document);

            const chapter = {
                title: title,
                content: this.cleanText(content),
                url: window.location.href,
                nextUrl: nextUrl,
                timestamp: Date.now(),
                isManual: true,
            };

            this.config.chapters.push(chapter);
            this.config.currentChapterIndex = this.config.chapters.length;
            this.config.selectedChapters.add(this.config.chapters.length - 1);
            this.saveChapters();

            console.log(`📚 手动已保存 [${this.config.chapters.length}]: ${title}`);
            this.updateChapterCount();
            this.updateStatus();
        }

        exportAll() {
            if (this.config.chapters.length === 0) {
                alert('没有可导出的章节');
                return;
            }

            const sorted = [...this.config.chapters].sort((a, b) => a.timestamp - b.timestamp);
            let novelTitle = '未命名小说';
            if (sorted.length > 0) {
                novelTitle = sorted[0].title.replace(/第\d+章\s*/g, '').trim() || '未命名小说';
            }

            let content = `${novelTitle}\n\n共 ${sorted.length} 章\n\n`;
            content += '='.repeat(50) + '\n\n';

            sorted.forEach((ch) => {
                content += `${ch.title}\n\n${ch.content}\n\n${'-'.repeat(30)}\n\n`;
            });

            const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${novelTitle}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            console.log(`💾 已导出: ${novelTitle} (${sorted.length} 章)`);
        }

        exportSelected() {
            if (this.config.chapters.length === 0) {
                alert('没有可导出的章节');
                return;
            }

            const selected = this.config.chapters.filter((_, idx) => this.config.selectedChapters.has(idx));
            if (selected.length === 0) {
                alert('请先选择要导出的章节');
                return;
            }

            const sorted = [...selected].sort((a, b) => a.timestamp - b.timestamp);
            let novelTitle = '未命名小说';
            if (sorted.length > 0) {
                novelTitle = sorted[0].title.replace(/第\d+章\s*/g, '').trim() || '未命名小说';
            }

            let content = `${novelTitle}\n\n共 ${sorted.length} 章\n\n`;
            content += '='.repeat(50) + '\n\n';

            sorted.forEach((ch) => {
                content += `${ch.title}\n\n${ch.content}\n\n${'-'.repeat(30)}\n\n`;
            });

            const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${novelTitle}_选中章节.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            console.log(`💾 已导出选中: ${novelTitle} (${sorted.length} 章)`);
        }

        clearData() {
            if (confirm('确定要清空所有数据吗？')) {
                this.config.chapters = [];
                this.config.selectedChapters = new Set();
                this.config.currentChapterIndex = 0;
                GM_setValue(this.getStorageKey(), '');
                this.updateStatus();
                this.updateChapterList();
                console.log('🗑️ 已清空');
            }
        }

        createUI() {
            this.initShadow();

            this.controlBtn = document.createElement('button');
            this.controlBtn.className = 'anc-btn';
            this.controlBtn.textContent = '📖 自动爬取';
            this.controlBtn.onclick = () => this.showPanel();

            this.shadowRoot.appendChild(this.controlBtn);
            document.body.appendChild(this.shadowContainer);
        }

        initShadow() {
            if (this.shadowContainer) return;

            this.shadowContainer = document.createElement('div');
            this.shadowContainer.id = 'auto-novel-crawler-root';
            this.shadowContainer.style.cssText = 'all: initial; display: block;';
            this.shadowRoot = this.shadowContainer.attachShadow({ mode: 'open' });

            const style = document.createElement('style');
            style.textContent = this.getStyles();
            this.shadowRoot.appendChild(style);
        }

        getStyles() {
            return `
                @media (max-width: 480px) {
                    .anc-panel {
                        right: 10px !important;
                        left: 10px !important;
                        width: auto !important;
                        top: 10px !important;
                        transform: none !important;
                        padding: 12px !important;
                    }
                    .anc-header {
                        flex-direction: column;
                        align-items: flex-start;
                        gap: 8px;
                    }
                    .anc-header-info {
                        width: 100%;
                    }
                    .anc-actions {
                        flex-wrap: wrap;
                    }
                    .anc-actions button {
                        min-width: calc(50% - 4px);
                    }
                    .anc-range-select {
                        flex-direction: column;
                        gap: 8px;
                    }
                    .anc-range-select input {
                        width: 100%;
                    }
                }
                .anc-btn {
                    position: fixed;
                    right: 20px;
                    top: 50%;
                    z-index: 2147483647;
                    padding: 12px 20px;
                    background: #2196F3;
                    color: white;
                    border: none;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: bold;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                    font-family: sans-serif;
                }
                .anc-btn:hover { background: #1976D2; }
                .anc-panel {
                    position: fixed;
                    right: 10px;
                    top: 10px;
                    z-index: 2147483647;
                    width: 320px;
                    max-height: calc(100vh - 20px);
                    padding: 15px;
                    background: #fff;
                    border: 1px solid #e0e0e0;
                    border-radius: 12px;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.15);
                    font-size: 14px;
                    font-family: sans-serif;
                    color: #333;
                    overflow-y: auto;
                }
                .anc-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 12px;
                }
                .anc-header-info {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .anc-header h3 { margin: 0; color: #2196F3; font-size: 16px; }
                .anc-header .anc-current-title {
                    font-size: 13px;
                    color: #2196F3;
                    font-weight: bold;
                    max-width: 200px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .anc-close {
                    background: none;
                    border: none;
                    font-size: 20px;
                    cursor: pointer;
                    color: #999;
                    padding: 4px 8px;
                }
                .anc-close:hover { color: #333; }
                .anc-actions {
                    display: flex;
                    gap: 6px;
                    margin-bottom: 10px;
                    flex-wrap: wrap;
                }
                .anc-btn-primary {
                    flex: 1;
                    padding: 8px 10px;
                    background: #2196F3;
                    color: white;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 12px;
                    font-weight: bold;
                }
                .anc-btn-primary:hover { background: #1976D2; }
                .anc-btn-primary:disabled { background: #ccc; cursor: not-allowed; }
                .anc-btn-success {
                    flex: 1;
                    padding: 8px 10px;
                    background: #4CAF50;
                    color: white;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 12px;
                    font-weight: bold;
                }
                .anc-btn-success:hover { background: #388E3C; }
                .anc-btn-danger {
                    flex: 1;
                    padding: 8px 10px;
                    background: #f44336;
                    color: white;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 12px;
                    font-weight: bold;
                }
                .anc-btn-danger:hover { background: #d32f2f; }
                .anc-range-select {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    margin-bottom: 10px;
                    padding: 8px;
                    background: #f5f5f5;
                    border-radius: 6px;
                }
                .anc-range-select input {
                    width: 50px;
                    padding: 4px;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    font-size: 12px;
                    text-align: center;
                }
                .anc-range-select span {
                    font-size: 12px;
                    color: #666;
                }
                .anc-range-select button {
                    padding: 4px 8px;
                    font-size: 11px;
                    background: #2196F3;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                }
                .anc-range-select button:hover { background: #1976D2; }
                .anc-chapter-list-container {
                    max-height: 250px;
                    overflow-y: auto;
                    border: 1px solid #e0e0e0;
                    border-radius: 6px;
                    margin-bottom: 10px;
                }
                .anc-chapter-list-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 8px;
                    background: #f5f5f5;
                    border-bottom: 1px solid #e0e0e0;
                    position: sticky;
                    top: 0;
                }
                .anc-chapter-list-header label {
                    font-size: 12px;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                }
                .anc-chapter-item {
                    display: flex;
                    align-items: center;
                    padding: 6px 8px;
                    border-bottom: 1px solid #f0f0f0;
                    font-size: 12px;
                    gap: 6px;
                }
                .anc-chapter-item:last-child {
                    border-bottom: none;
                }
                .anc-chapter-item input {
                    margin: 0;
                }
                .anc-chapter-item .anc-chapter-title {
                    flex: 1;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .anc-btn-small {
                    padding: 2px 6px;
                    font-size: 11px;
                    background: #9e9e9e;
                    color: white;
                    border: none;
                    border-radius: 3px;
                    cursor: pointer;
                }
                .anc-btn-small:hover { background: #757575; }
                .anc-manual-mode {
                    color: #ff9800;
                    font-weight: bold;
                }
                .anc-status-bar {
                    display: flex;
                    justify-content: space-between;
                    font-size: 12px;
                    color: #666;
                    margin-bottom: 8px;
                }
            `;
        }

        showPanel() {
            if (this.statusPanel) {
                this.statusPanel.style.display = 'block';
                this.updateStatus();
                this.updateChapterList();
                return;
            }

            this.statusPanel = document.createElement('div');
            this.statusPanel.className = 'anc-panel';
            this.statusPanel.innerHTML = `
                <div class="anc-title">
                    <h3>📖 自动爬取器</h3>
                    <button class="anc-close">×</button>
                </div>
                <div class="anc-status">
                    <div class="anc-status-item">
                        <span>状态:</span>
                        <span class="anc-status-value">就绪</span>
                    </div>
                    <div class="anc-status-item">
                        <span>当前章节:</span>
                        <span class="anc-current-chapter">-</span>
                    </div>
                    <div class="anc-status-item">
                        <span>已爬取:</span>
                        <span class="anc-count">0 章</span>
                    </div>
                    <div class="anc-status-item">
                        <span>当前URL:</span>
                        <span class="anc-url">-</span>
                    </div>
                </div>
                <div class="anc-actions">
                    <button class="anc-btn-primary anc-start">▶️ 开始</button>
                    <button class="anc-btn-danger anc-stop" disabled>⏹️ 停止</button>
                </div>
                <div class="anc-chapter-list-container">
                    <div class="anc-chapter-list-header">
                        <label><input type="checkbox" class="anc-select-all" checked> 全选</label>
                        <button class="anc-btn-small anc-deselect-all">取消</button>
                    </div>
                    <div class="anc-chapter-list"></div>
                </div>
                <div class="anc-actions">
                    <button class="anc-btn-success anc-export">💾 导出全部</button>
                    <button class="anc-btn-success anc-export-selected">📤 导出选中</button>
                </div>
                <div class="anc-actions">
                    <button class="anc-btn-danger anc-clear">🗑️ 清空</button>
                </div>
            `;

            this.statusPanel.querySelector('.anc-close').onclick = () => this.hidePanel();
            this.statusPanel.querySelector('.anc-start').onclick = () => {
                this.startCrawl();
                this.statusPanel.querySelector('.anc-start').disabled = true;
                this.statusPanel.querySelector('.anc-stop').disabled = false;
            };
            this.statusPanel.querySelector('.anc-stop').onclick = () => {
                this.stopCrawl();
                this.statusPanel.querySelector('.anc-start').disabled = false;
                this.statusPanel.querySelector('.anc-stop').disabled = true;
            };
            this.statusPanel.querySelector('.anc-export').onclick = () => this.exportAll();
            this.statusPanel.querySelector('.anc-export-selected').onclick = () => this.exportSelected();
            this.statusPanel.querySelector('.anc-clear').onclick = () => this.clearData();
            this.statusPanel.querySelector('.anc-select-all').onchange = (e) => this.toggleSelectAll(e.target.checked);
            this.statusPanel.querySelector('.anc-deselect-all').onclick = () => this.toggleSelectAll(false);

            this.shadowRoot.appendChild(this.statusPanel);
            this.controlBtn.style.display = 'none';
            this.updateStatus();
            this.updateChapterList();
        }

        hidePanel() {
            if (this.statusPanel) this.statusPanel.style.display = 'none';
            if (this.controlBtn) this.controlBtn.style.display = 'block';
        }

        updateStatus() {
            if (!this.statusPanel) return;
            const status = this.statusPanel.querySelector('.anc-status-value');
            const count = this.statusPanel.querySelector('.anc-count');
            const currentChapter = this.statusPanel.querySelector('.anc-current-chapter');
            const currentTitle = this.statusPanel.querySelector('.anc-current-title');

            let statusText = '就绪';
            if (this.config.isCrawling) {
                if (this.config.isManualMode) {
                    statusText = '🟠 手动下滑模式';
                } else {
                    statusText = '🟢 自动爬取中...';
                }
            }

            if (status) status.textContent = statusText;
            if (count) count.textContent = `${this.config.chapters.length} 章`;
            if (currentChapter) {
                currentChapter.textContent = this.config.chapters.length > 0
                    ? `第 ${this.config.currentChapterIndex + 1} 章`
                    : '-';
            }
            if (currentTitle && this.config.chapters.length > 0) {
                const lastChapter = this.config.chapters[this.config.chapters.length - 1];
                currentTitle.textContent = lastChapter.title;
            } else if (currentTitle) {
                currentTitle.textContent = document.title || '当前页面';
            }
        }

        updateCurrentUrl(url) {
            if (!this.statusPanel) return;
            const urlEl = this.statusPanel.querySelector('.anc-url');
            if (urlEl) {
                urlEl.textContent = url.length > 35 ? '...' + url.slice(-32) : url;
            }
        }

        updateChapterCount() {
            if (!this.statusPanel) return;
            const count = this.statusPanel.querySelector('.anc-count');
            if (count) count.textContent = `${this.config.chapters.length} 章`;
        }

        updateChapterList() {
            if (!this.statusPanel) return;
            const listContainer = this.statusPanel.querySelector('.anc-chapter-list');
            if (!listContainer) return;

            listContainer.innerHTML = '';

            this.config.chapters.forEach((chapter, idx) => {
                const item = document.createElement('div');
                item.className = 'anc-chapter-item';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = this.config.selectedChapters.has(idx);
                checkbox.onchange = (e) => {
                    if (e.target.checked) {
                        this.config.selectedChapters.add(idx);
                    } else {
                        this.config.selectedChapters.delete(idx);
                    }
                    this.updateSelectAllCheckbox();
                };

                const title = document.createElement('span');
                title.className = 'anc-chapter-title';
                title.textContent = chapter.isManual ? `🔰 ${chapter.title}` : chapter.title;

                item.appendChild(checkbox);
                item.appendChild(title);
                listContainer.appendChild(item);
            });

            this.updateSelectAllCheckbox();
        }

        updateSelectAllCheckbox() {
            if (!this.statusPanel) return;
            const selectAll = this.statusPanel.querySelector('.anc-select-all');
            if (selectAll && this.config.chapters.length > 0) {
                selectAll.checked = this.config.selectedChapters.size === this.config.chapters.length;
            }
        }

        toggleSelectAll(checked) {
            this.config.selectedChapters = new Set();
            if (checked) {
                for (let i = 0; i < this.config.chapters.length; i++) {
                    this.config.selectedChapters.add(i);
                }
            }
            this.updateChapterList();
        }
    }

    new AutoNovelCrawler();
})();