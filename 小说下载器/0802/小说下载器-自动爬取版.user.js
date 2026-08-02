// ==UserScript==
// @name         小说下载器-自动爬取版
// @namespace    http://tampermonkey.net/
// @version      1.4
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
                isPaused: false,
                isManualMode: false,
                chapters: [],
                currentChapterIndex: 0,
                selectedChapters: new Set(),
                delay: 2500,
                minContentLength: 100,
                lastScrollTop: 0,
                novelName: '',
                lastCrawlUrl: '',
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
                '.chapter-title',
                'h1.chapter-title',
                'h2.chapter-title',
                '.bookname h1',
                '.chapter h1',
                '.read h1',
                '.xs-title',
                '.title',
                'h1',
                'h2',
                'h3',
            ];

            this.init();
        }

        // ========== 初始化 ==========

        /** 初始化：生成Tab ID、加载章节、创建UI */
        init() {
            this.tabId = this.generateTabId();
            this.loadChapters();
            this.createUI();
            console.log("📖 小说自动爬取器 v1.0 已就绪");
        }

        /** 生成唯一Tab ID，用于区分不同标签页的数据 */
        generateTabId() {
            return 'tab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        }

        /** 获取当前标签页的存储键名 */
        getStorageKey() {
            return 'autoNovelCrawler_chapters_' + this.tabId;
        }

        // ========== 数据持久化 ==========

        /** 从 GM_storage 加载已保存的章节 */
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

        /** 保存章节数据到 GM_storage */
        saveChapters() {
            GM_setValue(this.getStorageKey(), JSON.stringify(this.config.chapters));
        }

        // ========== 工具方法 ==========

        /** 延迟函数 */
        sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        /** 解析HTML字符串为DOM文档 */
        parseHtml(html) {
            if (!html) return document.implementation.createHTMLDocument();
            return new DOMParser().parseFromString(html, "text/html");
        }

        // ========== 网络请求 ==========

        /** 使用 GM_xmlhttpRequest 获取网页HTML */
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

        // ========== 标题提取 ==========

        /**
         * 获取章节标题（四级优先级）
         * 1. 正文区域内的标题元素（如 article h3）
         * 2. 网页<title>标签拆分
         * 3. 正文内容正则匹配
         * 4. CSS选择器兜底
         */
        getCurrentTitle(doc) {
            const targetDoc = doc || document;
            
            const articleTitle = this.extractArticleTitle(targetDoc);
            if (articleTitle) {
                return articleTitle;
            }
            
            if (targetDoc.title && targetDoc.title.trim()) {
                const parsed = this.parsePageTitle(targetDoc.title);
                if (parsed.chapterTitle) {
                    return parsed.chapterTitle;
                }
            }
            
            const content = this.getCurrentContent(targetDoc);
            if (content) {
                const titleFromContent = this.extractTitleFromContent(content);
                if (titleFromContent) {
                    return titleFromContent;
                }
            }
            
            for (const selector of this.titleSelectors) {
                const el = targetDoc.querySelector(selector);
                if (el && el.textContent.trim()) {
                    return el.textContent.trim();
                }
            }
            
            return '未知章节';
        }

        /** 提取正文区域内的标题元素（如 <article><h3>第1章 XXX</h3></article>） */
        extractArticleTitle(doc) {
            const article = doc.querySelector('article, .content_txt, #chapterContent');
            if (!article) return null;
            
            const headings = article.querySelectorAll('h3, h2, h1');
            for (const heading of headings) {
                const text = heading.textContent.trim();
                if (!text) continue;
                
                const chapterPattern = /^第[零一二三四五六七八九十百千万\d]+[章节卷回部集篇幕]/;
                if (chapterPattern.test(text)) {
                    return text;
                }
            }
            
            return null;
        }

        /**
         * 拆分网页标题
         * 支持格式：第X章 章节名_小说名-xx
         * 返回：{ chapterTitle, novelName }
         */
        parsePageTitle(title) {
            const patterns = [
                /^(第[零一二三四五六七八九十百千万\d]+[章节卷回部集篇幕][^_\-|]+)[_|\-](.+?)[_|\-].+$/,
                /^(第[零一二三四五六七八九十百千万\d]+[章节卷回部集篇幕][^_\-|]+)[_|\-](.+)$/,
                /^(第[零一二三四五六七八九十百千万\d]+[章节卷回部集篇幕].+)$/,
            ];
            
            for (const pattern of patterns) {
                const match = title.trim().match(pattern);
                if (match) {
                    return {
                        chapterTitle: match[1].trim(),
                        novelName: match[2] ? match[2].trim() : null,
                    };
                }
            }
            
            return { chapterTitle: title.trim(), novelName: null };
        }

        /** 从正文内容中用正则匹配章节标题（取前5行） */
        extractTitleFromContent(content) {
            const lines = content.split('\n');
            const firstLines = lines.slice(0, 5).filter(line => line.trim());
            
            if (firstLines.length === 0) return null;
            
            const chapterPatterns = [
                /^第[零一二三四五六七八九十百千万\d]+[章节卷回部集篇幕].{0,50}$/,
                /^第[零一二三四五六七八九十百千万\d]+[章节卷回部集篇幕]/,
                /^[卷第][零一二三四五六七八九十百千万\d]+[章节卷回部集篇幕]/,
            ];
            
            for (const line of firstLines) {
                const trimmed = line.trim();
                if (trimmed.length > 80) continue;
                
                for (const pattern of chapterPatterns) {
                    const match = trimmed.match(pattern);
                    if (match) {
                        const titleMatch = trimmed.match(/^(第[零一二三四五六七八九十百千万\d]+[章节卷回部集篇幕][^.。!！?？\n]{0,50})/);
                        if (titleMatch) {
                            return titleMatch[1].trim();
                        }
                        return trimmed;
                    }
                }
            }
            
            return null;
        }

        // ========== 正文提取 ==========

        /** 遍历选择器查找正文容器 */
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

        /** 提取正文内容，移除干扰元素 */
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

        /** 清理文本：移除\r，合并多余空行 */
        cleanText(text) {
            if (!text) return '';
            let result = text.replace(/\r/g, '');
            result = result.replace(/\n{3,}/g, '\n\n');
            return result.trim();
        }

        // ========== 下一章查找 ==========

        /** 查找下一章链接（优先匹配选择器，其次匹配包含"下一章"的链接） */
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

        // ========== 爬取控制 ==========

        /** 开始/继续自动爬取 */
        async startCrawl() {
            if (this.config.isCrawling && !this.config.isPaused) {
                console.log('⚠️ 正在爬取中');
                return;
            }

            if (this.config.isPaused) {
                this.config.isPaused = false;
                console.log('▶️ 继续爬取...');
                this.updateStatus();
                return;
            }

            this.config.isCrawling = true;
            this.config.isPaused = false;
            console.log('🚀 开始自动爬取...');
            this.updateStatus();

            let currentUrl = this.config.lastCrawlUrl || window.location.href;
            let chapterCount = 0;

            while (this.config.isCrawling) {
                if (this.config.isPaused) {
                    await this.sleep(500);
                    continue;
                }

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
                        this.updateChapterList();
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
                    this.config.lastCrawlUrl = currentUrl;
                    const randomDelay = this.config.delay + (Math.random() - 0.5) * 1000;
                    console.log(`⏳ 等待 ${Math.round(randomDelay)}ms...`);
                    await this.sleep(randomDelay);

                } catch (e) {
                    console.error(`❌ 请求失败: ${e.message}`);
                    break;
                }
            }

            this.config.isCrawling = false;
            this.config.isPaused = false;
            this.updateStatus();
            console.log(`✅ 爬取完成！共 ${chapterCount} 章`);
        }

        /** 暂停爬取 */
        pauseCrawl() {
            if (!this.config.isCrawling) return;
            this.config.isPaused = true;
            console.log('⏸️ 已暂停');
            this.updateStatus();
        }

        /** 继续爬取 */
        resumeCrawl() {
            if (!this.config.isPaused) return;
            this.config.isPaused = false;
            console.log('▶️ 继续爬取');
            this.updateStatus();
        }

        /** 停止爬取（重置所有状态） */
        stopCrawl() {
            this.config.isCrawling = false;
            this.config.isPaused = false;
            this.config.isManualMode = false;
            this.config.lastCrawlUrl = '';
            this.removeScrollListener();
            console.log('⏹️ 已停止');
            this.updateStatus();
        }

        // ========== 手动下滑模式 ==========

        /** 进入手动下滑模式 */
        startManualMode() {
            this.config.isManualMode = true;
            this.config.isCrawling = true;
            this.config.currentChapterIndex = this.config.chapters.length;
            console.log('🔄 进入手动下滑模式，请向下滚动页面');
            this.updateStatus();
            this.addScrollListener();
        }

        /** 添加滚动监听 */
        addScrollListener() {
            this.scrollHandler = () => this.handleScroll();
            window.addEventListener('scroll', this.scrollHandler, { passive: true });
        }

        /** 移除滚动监听 */
        removeScrollListener() {
            if (this.scrollHandler) {
                window.removeEventListener('scroll', this.scrollHandler);
                this.scrollHandler = null;
            }
        }

        /** 处理滚动事件：检测是否到达页面底部，自动保存当前章节 */
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

        // ========== 按钮事件处理 ==========

        /** 处理开始/暂停/继续按钮点击 */
        handleToggleCrawl() {
            if (!this.config.isCrawling) {
                this.startCrawl();
            } else if (!this.config.isPaused) {
                this.pauseCrawl();
            } else {
                this.resumeCrawl();
            }
        }

        // ========== 导出功能 ==========

        /** 智能导出：有选中导出选中，无选中导出全部 */
        smartExport() {
            if (this.config.chapters.length === 0) {
                alert('没有可导出的章节');
                return;
            }

            const hasSelected = this.config.selectedChapters.size > 0;
            if (hasSelected) {
                this.exportSelected();
            } else {
                this.exportAll();
            }
        }

        /** 导出所有章节 */
        exportAll() {
            if (this.config.chapters.length === 0) {
                alert('没有可导出的章节');
                return;
            }

            const sorted = [...this.config.chapters].sort((a, b) => a.timestamp - b.timestamp);
            let novelTitle = this.config.novelName || '未命名小说';
            
            if (novelTitle === '未命名小说' && sorted.length > 0) {
                const parsed = this.parsePageTitle(document.title);
                if (parsed.novelName) {
                    novelTitle = parsed.novelName;
                    this.config.novelName = novelTitle;
                } else {
                    novelTitle = sorted[0].title.replace(/第[零一二三四五六七八九十百千万\d]+[章节卷回部集篇幕]\s*/g, '').trim() || '未命名小说';
                }
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

            console.log(`已导出: ${novelTitle} (${sorted.length} 章)`);
        }

        /** 导出选中章节 */
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
            let novelTitle = this.config.novelName || '未命名小说';
            
            if (novelTitle === '未命名小说' && sorted.length > 0) {
                const parsed = this.parsePageTitle(document.title);
                if (parsed.novelName) {
                    novelTitle = parsed.novelName;
                } else {
                    novelTitle = sorted[0].title.replace(/第[零一二三四五六七八九十百千万\d]+[章节卷回部集篇幕]\s*/g, '').trim() || '未命名小说';
                }
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

            console.log(`已导出选中: ${novelTitle} (${sorted.length} 章)`);
        }

        // ========== UI创建 ==========

        /** 创建浮动按钮和面板 */
        createUI() {
            this.initShadow();

            this.controlBtn = document.createElement('button');
            this.controlBtn.className = 'anc-btn';
            this.controlBtn.textContent = '📖 霸道';
            this.controlBtn.style.cssText = 'position: fixed; top: 100px; right: 10px; z-index: 999999;';
            this.controlBtn.onclick = () => this.showPanel();

            this.shadowRoot.appendChild(this.controlBtn);
            document.body.appendChild(this.shadowContainer);
        }

        /** 初始化Shadow DOM */
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

        /** 获取面板样式 */
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
                    .anc-title {
                        flex-direction: row !important;
                        align-items: center !important;
                    }
                    .anc-actions {
                        flex-wrap: wrap;
                    }
                    .anc-actions button {
                        min-width: calc(50% - 4px);
                    }
                }
                .anc-btn {
                    position: fixed;
                    right: 20px;
                    top: 20px;
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
                .anc-title {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 12px;
                }
                .anc-title h3 {
                    margin: 0;
                    color: #2196F3;
                    font-size: 16px;
                }
                .anc-close {
                    background: none;
                    border: none;
                    font-size: 24px;
                    cursor: pointer;
                    color: #999;
                    padding: 8px 12px;
                    min-width: 44px;
                    min-height: 44px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    line-height: 1;
                }
                .anc-close:hover { color: #333; }
                .anc-actions {
                    display: flex;
                    gap: 8px;
                    margin-bottom: 12px;
                    flex-wrap: wrap;
                }
                .anc-btn-primary {
                    flex: 1;
                    padding: 10px 12px;
                    background: #2196F3;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 13px;
                    font-weight: 500;
                    transition: background 0.2s;
                }
                .anc-btn-primary:hover { background: #1976D2; }
                .anc-btn-primary:disabled { background: #ccc; cursor: not-allowed; }
                .anc-btn-success {
                    flex: 1;
                    padding: 8px 10px;
                    background: #4CAF50;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
                    font-weight: 500;
                    transition: background 0.2s;
                }
                .anc-btn-success:hover { background: #388E3C; }
                .anc-btn-danger {
                    flex: 1;
                    padding: 8px 10px;
                    background: #f44336;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
                    font-weight: 500;
                    transition: background 0.2s;
                }
                .anc-btn-danger:hover { background: #d32f2f; }
                .anc-range-select {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                }
                .anc-range-select input {
                    width: 45px;
                    padding: 3px 4px;
                    border: 1px solid #ddd;
                    border-radius: 3px;
                    font-size: 12px;
                    text-align: center;
                }
                .anc-range-select span {
                    font-size: 12px;
                    color: #666;
                }
                .anc-range-select button {
                    padding: 3px 8px;
                    font-size: 12px;
                    background: #2196F3;
                    color: white;
                    border: none;
                    border-radius: 3px;
                    cursor: pointer;
                }
                .anc-range-select button:hover { background: #1976D2; }
                .anc-chapter-list-container {
                    max-height: 300px;
                    overflow-y: auto;
                    border: 1px solid #e0e0e0;
                    border-radius: 4px;
                    margin-bottom: 12px;
                }
                .anc-chapter-list-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 8px 10px;
                    background: #f5f5f5;
                    border-bottom: 1px solid #e0e0e0;
                    position: sticky;
                    top: 0;
                    z-index: 1;
                    gap: 8px;
                }
                .anc-chapter-list-header label {
                    font-size: 13px;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    cursor: pointer;
                    white-space: nowrap;
                }
                .anc-range-select {
                    display: flex;
                    align-items: center;
                    gap: 3px;
                    flex-shrink: 0;
                }
                .anc-range-select input {
                    width: 40px;
                    padding: 2px 3px;
                    border: 1px solid #ddd;
                    border-radius: 3px;
                    font-size: 12px;
                    text-align: center;
                }
                .anc-range-select span {
                    font-size: 12px;
                    color: #666;
                }
                .anc-range-select button {
                    padding: 2px 6px;
                    font-size: 12px;
                    background: #2196F3;
                    color: white;
                    border: none;
                    border-radius: 3px;
                    cursor: pointer;
                    white-space: nowrap;
                }
                .anc-range-select button:hover { background: #1976D2; }
                .anc-chapter-item {
                    display: flex;
                    align-items: center;
                    padding: 8px 12px;
                    border-bottom: 1px solid #f0f0f0;
                    font-size: 13px;
                    gap: 8px;
                    cursor: pointer;
                    transition: background 0.15s;
                }
                .anc-chapter-item:hover {
                    background: #f8f9fa;
                }
                .anc-chapter-item:last-child {
                    border-bottom: none;
                }
                .anc-chapter-item input {
                    margin: 0;
                    cursor: pointer;
                }
                .anc-chapter-item .anc-chapter-title {
                    flex: 1;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    color: #333;
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
                    <h3>自动爬取器</h3>
                    <button class="anc-close">×</button>
                </div>
                <div class="anc-status">
                    <div class="anc-status-item">
                        <span>状态:</span>
                        <span class="anc-status-value">就绪</span>
                    </div>
                    <div class="anc-status-item">
                        <span>已爬取:</span>
                        <span class="anc-count">0 章</span>
                    </div>
                    <div class="anc-status-item">
                        <span>最新标题:</span>
                        <span class="anc-latest-title">-</span>
                    </div>
                    <div class="anc-status-item">
                        <span>最新URL:</span>
                        <span class="anc-latest-url">-</span>
                    </div>
                </div>
                <div class="anc-actions">
                    <button class="anc-btn-primary anc-toggle-crawl">▶ 开始</button>
                    <button class="anc-btn-success anc-export-btn">💾 导出全部</button>
                </div>
                <div class="anc-chapter-list-container">
                    <div class="anc-chapter-list-header">
                        <label><input type="checkbox" class="anc-select-all" checked> 全选</label>
                        <div class="anc-range-select">
                            <input type="number" class="anc-range-start" placeholder="从" min="1">
                            <span>-</span>
                            <input type="number" class="anc-range-end" placeholder="到" min="1">
                            <button class="anc-btn-small anc-select-range">选中</button>
                        </div>
                    </div>
                    <div class="anc-chapter-list"></div>
                </div>
            `;

            this.statusPanel.querySelector('.anc-close').onclick = () => this.hidePanel();
            this.statusPanel.querySelector('.anc-toggle-crawl').onclick = () => this.handleToggleCrawl();
            this.statusPanel.querySelector('.anc-export-btn').onclick = () => this.smartExport();
            this.statusPanel.querySelector('.anc-select-all').onchange = (e) => this.toggleSelectAll(e.target.checked);
            this.statusPanel.querySelector('.anc-select-range').onclick = () => this.selectRange();

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
            const latestTitle = this.statusPanel.querySelector('.anc-latest-title');
            const latestUrl = this.statusPanel.querySelector('.anc-latest-url');
            const toggleBtn = this.statusPanel.querySelector('.anc-toggle-crawl');
            const exportBtn = this.statusPanel.querySelector('.anc-export-btn');

            let statusText = '就绪';
            if (this.config.isCrawling) {
                if (this.config.isPaused) {
                    statusText = '⏸️ 已暂停';
                } else if (this.config.isManualMode) {
                    statusText = '🟠 手动下滑模式';
                } else {
                    statusText = '🟢 自动爬取中...';
                }
            }

            if (status) status.textContent = statusText;
            if (count) count.textContent = `${this.config.chapters.length} 章`;
            if (this.config.chapters.length > 0) {
                const lastChapter = this.config.chapters[this.config.chapters.length - 1];
                if (latestTitle) latestTitle.textContent = lastChapter.title;
                if (latestUrl) {
                    const shortUrl = lastChapter.url.length > 40 ? '...' + lastChapter.url.slice(-37) : lastChapter.url;
                    latestUrl.textContent = shortUrl;
                }
            } else {
                if (latestTitle) latestTitle.textContent = '-';
                if (latestUrl) latestUrl.textContent = '-';
            }

            if (toggleBtn) {
                if (this.config.isCrawling && !this.config.isPaused) {
                    toggleBtn.textContent = '⏸ 暂停';
                } else if (this.config.isPaused) {
                    toggleBtn.textContent = '▶ 继续';
                } else {
                    toggleBtn.textContent = '▶ 开始';
                }
            }

            if (exportBtn) {
                const hasSelected = this.config.selectedChapters.size > 0;
                exportBtn.textContent = hasSelected ? `📤 导出选中(${this.config.selectedChapters.size})` : '💾 导出全部';
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

        selectRange() {
            if (!this.statusPanel) return;
            const startInput = this.statusPanel.querySelector('.anc-range-start');
            const endInput = this.statusPanel.querySelector('.anc-range-end');
            
            if (!startInput || !endInput) return;
            
            const start = parseInt(startInput.value) - 1; // 用户输入从1开始，内部从0开始
            const end = parseInt(endInput.value) - 1;
            
            if (isNaN(start) || isNaN(end)) {
                alert('请输入有效的章节范围');
                return;
            }
            
            if (start < 0 || end < 0 || start > end) {
                alert('章节范围无效');
                return;
            }
            
            if (end >= this.config.chapters.length) {
                alert(`超出范围，当前只有 ${this.config.chapters.length} 章`);
                return;
            }
            
            // 先清空选中，再选中范围
            this.config.selectedChapters = new Set();
            for (let i = start; i <= end; i++) {
                this.config.selectedChapters.add(i);
            }
            
            this.updateChapterList();
        }
    }

    new AutoNovelCrawler();
})();