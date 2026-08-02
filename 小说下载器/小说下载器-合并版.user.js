// ==UserScript==
// @name         小说下载器-合并版
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  融合三站整合版与自动爬取版：目录页批量模式 + 正文页链路模式，统一数据结构与断点续传
// @author       You
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const VERSION = '2.2';
    const STORAGE_KEY = 'novelDownloaderMerged_progress';

    class NovelDownloaderMerged {
        constructor() {
            // ========== 运行时配置 ==========
            this.config = {
                mode: null,                  // 'batch' | 'chain' | null
                isRunning: false,
                isPaused: false,
                cancel: false,

                // 批量模式参数
                maxConcurrency: 3,
                delay: 1000,
                adaptiveDelay: true,
                maxDlPerMin: 30,
                retryCount: 5,
                minTxtLength: 100,

                // 链路模式参数
                chainDelay: 2500,

                // 状态
                chapters: [],                // 统一数据结构：{title, content, url, nextUrl, timestamp, status, error}
                urlSet: new Set(),           // URL 去重集合（运行时重建）
                novelName: '',
                lastUrl: '',                 // 上次处理到的 URL（续传起点参考）
                pendingVerifyChapter: null,  // {title, url, globalIndex}
                currentSite: null,           // 当前站点配置（运行时）
                chapterList: [],             // 批量模式：扫描出的任务列表
                currentTaskCount: 0,
            };

            // ========== 站点配置 ==========
            // host 为字符串或正则；为空时仅在选择器命中时启用
            this.sites = {
                a: {
                    name: '站点A',
                    host: null,
                    chapterSelector: 'ul.detail-page__catalog-list a.detail-page__catalog-item',
                    numSelector: '.detail-page__chapter-badge',
                    titleSelector: '.detail-page__chapter-title',
                    titleSelectors: ['.dx-title.detail-page__title', '.detail-page__title'],
                    contentSelectors: ['main.dx-container.app-content', 'div.article'],
                    contentExtractor: 'divLine',
                    hasVerify: false,
                    verifyKeywords: []
                },
                b: {
                    name: '站点B',
                    host: null,
                    chapterSelector: '#chapters .novel-list a',
                    titleSelector: 'h4',
                    titleSelectors: ['.book-title', 'h1.book-title'],
                    contentSelectors: ['#content'],
                    contentExtractor: 'pTags',
                    hasVerify: false,
                    verifyKeywords: []
                },
                c: {
                    name: '站点C',
                    host: null,
                    chapterSelector: 'ul.section-list.fix li a',
                    titleSelector: '',
                    titleSelectors: ['.info .top h1', '.xs-title'],
                    contentSelectors: ['article#chapterContent'],
                    contentExtractor: 'cContent',
                    hasVerify: true,
                    verifyKeywords: ['验证', 'verify', 'captcha', 'check', '安全', '人机']
                }
            };

            // ========== 通用兜底选择器（链路模式 / 未知站点）==========
            this.genericSelectors = {
                contentSelectors: [
                    'article#chapterContent',
                    '#content',
                    '#chapterContent',
                    '#BookText',
                    '#nr1',
                    '.content',
                    '.article',
                    '.read-content',
                    '.chapter-content',
                    '.content_txt',
                    '.novel-content',
                    '.read-section',
                    '.read_main',
                    '.box_con',
                    'main.dx-container.app-content',
                    'article',
                    'main'
                ],
                titleSelectors: [
                    'h1.chapter-title', 'h2.chapter-title', '.chapter-title',
                    '.bookname h1', '.chapter h1', '.read h1',
                    '.xs-title', '.dx-title.detail-page__title',
                    '.detail-page__title', '.info .top h1',
                    '.title', 'h1', 'h2', 'h3'
                ],
                nextBtnSelectors: [
                    '.next a', '.next-chapter a', '#next a',
                    'a[href*="next"]', '.page-next a', '.chapter-next a',
                    'a.btn-next', 'a.next',
                    '.detail-page__nav-next a',
                    '.section-list a:last-child'
                ]
            };

            // ========== DOM 引用 ==========
            this.shadowRoot = null;
            this.shadowContainer = null;
            this.panel = null;
            this.statusLabel = null;
            this.currentChapterLabel = null;
            this.countLabel = null;
            this.actionBtn = null;
            this.saveBtn = null;
            this.scanBtn = null;
            this.chapterListContainer = null;
            this.scrollHandler = null;

            this.init();
        }

        // ========== 初始化 ==========

        init() {
            this.loadProgress();
            this.createUI();
            this.registerMenu();
            this.detectMode();

            // 未识别页面 + 无历史进度时，默认隐藏 UI（通过菜单显示）
            if (!this.config.mode && this.config.chapters.length === 0) {
                if (this.panel) this.panel.style.display = 'none';
                console.log('[init] 未识别页面类型，UI 已隐藏，可通过菜单显示');
                return;
            }

            if (this.config.pendingVerifyChapter) {
                this.updateStatus(`⚠️ 第${this.config.chapters.length + 1}章待验证，已保存 ${this.config.chapters.length} 章。完成验证后点击继续`, 'warn');
            } else if (this.config.chapters.length > 0) {
                this.updateStatus(`已恢复进度: ${this.config.chapters.length} 章，点击开始继续`);
            } else if (this.config.mode) {
                this.updateStatus(`已检测到${this.config.mode === 'batch' ? '目录页（批量模式）' : '正文页（链路模式）'}，点击扫描/开始`);
            }
            console.log(`📖 小说下载器-合并版 v${VERSION} 已就绪`);
        }

        registerMenu() {
            const self = this;
            GM_registerMenuCommand("显示/隐藏面板", () => {
                if (!self.panel) return;
                const willShow = self.panel.style.display === 'none';
                self.panel.style.display = willShow ? 'block' : 'none';
                if (willShow && !self.config.mode) {
                    self.detectMode();
                    if (self.config.mode) {
                        self.updateStatus(`已检测到${self.config.mode === 'batch' ? '目录页（批量模式）' : '正文页（链路模式）'}`);
                    } else {
                        self.updateStatus('未识别页面类型，请手动操作', 'warn');
                    }
                }
            });
            GM_registerMenuCommand("🔍 重新检测模式", () => {
                self.detectMode();
                if (self.panel) self.panel.style.display = 'block';
                if (self.config.mode) {
                    self.updateStatus(`已检测到${self.config.mode === 'batch' ? '目录页（批量模式）' : '正文页（链路模式）'}`, 'ok');
                } else {
                    self.updateStatus('未识别页面类型', 'warn');
                }
            });
            GM_registerMenuCommand("🗑️ 清空进度", () => {
                if (confirm('确定清空所有下载进度？')) {
                    self.clearProgress();
                    self.updateStatus('已清空进度');
                    self.updateChapterList();
                }
            });
            GM_registerMenuCommand("⚙️ 设置参数", () => {
                self.showSettings();
            });
        }

        /** 自动检测当前页面应使用的模式 */
        detectMode() {
            // 优先匹配站点配置（目录页判定）
            for (const key of ['a', 'b', 'c']) {
                const site = this.sites[key];
                if (site.host) {
                    const hostOk = typeof site.host === 'string'
                        ? location.host.includes(site.host)
                        : site.host.test(location.host);
                    if (!hostOk) continue;
                }
                const links = document.querySelectorAll(site.chapterSelector);
                if (links.length > 0) {
                    this.config.mode = 'batch';
                    this.config.currentSite = site;
                    console.log(`[detectMode] 批量模式 - ${site.name} (${links.length} 章)`);
                    return;
                }
            }

            // 兜底：尝试通用目录选择器（任意 a 链接 ≥ 10 视为目录）
            // 避免误判，要求链接数量充足
            const allCatalogGuesses = document.querySelectorAll('ul li a, .chapter-list a, .catalog a');
            if (allCatalogGuesses.length >= 10) {
                this.config.mode = 'batch';
                this.config.currentSite = null;
                console.log(`[detectMode] 批量模式（通用兜底，${allCatalogGuesses.length} 个候选链接）`);
                return;
            }

            // 正文页判定：命中正文选择器即视为正文页（不强求 nextUrl，运行时再找）
            // 原逻辑要求同时命中正文选择器和下一章链接，手机端常因无"下一章"文字链接而识别失败
            for (const sel of this.genericSelectors.contentSelectors) {
                const el = document.querySelector(sel);
                if (el) {
                    const text = (el.textContent || '').trim();
                    if (text.length >= this.config.minTxtLength) {
                        this.config.mode = 'chain';
                        console.log(`[detectMode] 链路模式（正文页，选择器: ${sel}, 文本长度: ${text.length}）`);
                        return;
                    }
                }
            }

            // 兜底 2：检测任何含较多文本的疑似正文容器（class/id 含 content/article/chapter/read）
            const suspectSelectors = [
                '[class*="content"]', '[class*="article"]',
                '[class*="chapter"]', '[class*="read-content"]',
                '[id*="content"]', '[id*="chapter"]',
                'article', 'main'
            ];
            for (const sel of suspectSelectors) {
                const el = document.querySelector(sel);
                if (el) {
                    const text = (el.textContent || '').trim();
                    if (text.length >= this.config.minTxtLength * 3) {
                        this.config.mode = 'chain';
                        this.config.currentSite = null;
                        console.log(`[detectMode] 链路模式（正文页兜底，选择器: ${sel}, 文本长度: ${text.length}）`);
                        return;
                    }
                }
            }

            this.config.mode = null;
            console.log('[detectMode] 未识别页面类型');
        }

        /** 判断是否为移动端浏览器 */
        isMobile() {
            if (this._isMobile !== undefined) return this._isMobile;
            const ua = navigator.userAgent.toLowerCase();
            const isUa = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile/i.test(ua);
            const isScreen = window.innerWidth <= 768;
            this._isMobile = isUa || isScreen;
            return this._isMobile;
        }

        // ========== 持久化 ==========

        loadProgress() {
            const saved = GM_getValue(STORAGE_KEY);
            if (!saved) return;
            try {
                const data = JSON.parse(saved);
                this.config.chapters = data.chapters || [];
                this.config.urlSet = new Set(this.config.chapters.map(c => c.url));
                this.config.novelName = data.novelName || '';
                this.config.lastUrl = data.lastUrl || '';
                this.config.pendingVerifyChapter = data.pendingVerifyChapter || null;
                console.log(`📂 恢复进度: ${this.config.chapters.length} 章, lastUrl=${this.config.lastUrl || '无'}`);
            } catch (e) {
                console.warn('加载进度失败:', e);
            }
        }

        saveProgress() {
            const data = {
                chapters: this.config.chapters,
                novelName: this.config.novelName,
                lastUrl: this.config.lastUrl,
                pendingVerifyChapter: this.config.pendingVerifyChapter
            };
            GM_setValue(STORAGE_KEY, JSON.stringify(data));
        }

        clearProgress() {
            GM_setValue(STORAGE_KEY, '');
            this.config.chapters = [];
            this.config.urlSet = new Set();
            this.config.novelName = '';
            this.config.lastUrl = '';
            this.config.pendingVerifyChapter = null;
            this.config.chapterList = [];
            this.config.currentTaskCount = 0;
        }

        // ========== 工具 ==========

        sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        /** 带倒计时的 sleep：每秒更新状态栏显示剩余秒数 */
        async sleepWithCountdown(totalMs, prefixMsg = '等待') {
            const totalSec = Math.ceil(totalMs / 1000);
            for (let sec = totalSec; sec > 0; sec--) {
                if (this.config.cancel) break;
                this.updateStatus(`${prefixMsg} ${sec}秒`);
                await this.sleep(1000);
            }
        }

        parseHtml(html) {
            if (!html) return document.implementation.createHTMLDocument();
            const cleaned = html.replace(/data-novel-info="[^"]*"/g, 'data-novel-info=""');
            return new DOMParser().parseFromString(cleaned, "text/html");
        }

        // ========== 网络层 ==========

        detectVerify(html, site) {
            if (!site || !site.hasVerify) return false;
            const lower = html.toLowerCase();
            for (const kw of site.verifyKeywords) {
                if (lower.includes(kw.toLowerCase())) {
                    console.warn(`⚠️ 检测到验证码关键词: ${kw}`);
                    return true;
                }
            }
            return false;
        }

        /**
         * 获取 HTML，自带验证码检测
         * 抛出 Error('VERIFY_DETECTED') 表示命中验证码
         */
        getHtml(url, site = null) {
            const randomDelay = 300 + Math.random() * 700;
            return new Promise((resolve, reject) => {
                setTimeout(() => {
                    GM_xmlhttpRequest({
                        method: "GET",
                        url,
                        timeout: 20000,
                        overrideMimeType: "text/html;charset=utf-8",
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                            'Referer': window.location.href,
                            'Connection': 'keep-alive'
                        },
                        onload: (res) => {
                            const html = res.responseText;
                            if (this.detectVerify(html, site)) {
                                reject(new Error('VERIFY_DETECTED'));
                                return;
                            }
                            resolve(html);
                        },
                        onerror: () => reject(new Error('网络请求失败')),
                        ontimeout: () => reject(new Error('请求超时'))
                    });
                }, randomDelay);
            });
        }

        /**
         * 带重试的 HTML 获取
         * - VERIFY_DETECTED 不重试，直接抛出
         * - 其他错误重试 retryCount 次
         */
        async getHtmlWithRetry(url, site, retry = this.config.retryCount) {
            let lastErr;
            for (let i = 0; i <= retry; i++) {
                if (this.config.cancel) throw new Error('CANCELLED');
                try {
                    return await this.getHtml(url, site);
                } catch (e) {
                    if (e.message === 'VERIFY_DETECTED') throw e;
                    lastErr = e;
                    console.warn(`[getHtmlWithRetry] 第${i + 1}次失败: ${e.message}, ${url}`);
                    if (i < retry) await this.sleep(800 + Math.random() * 600);
                }
            }
            throw lastErr;
        }

        // ========== 内容提取 ==========

        /**
         * 提取正文
         * @param {Document} doc 解析后的文档
         * @param {boolean} isLiveDom 是否实时 DOM（决定用 innerText 还是 textContent）
         */
        getContent(doc, isLiveDom = false) {
            const site = this.config.currentSite;
            const selectors = site && site.contentSelectors
                ? site.contentSelectors
                : this.genericSelectors.contentSelectors;
            const extractor = site && site.contentExtractor ? site.contentExtractor : 'auto';

            for (const sel of selectors) {
                const el = doc.querySelector(sel);
                if (!el) continue;
                const text = this.extractContent(el, extractor, isLiveDom);
                if (text && text.length >= this.config.minTxtLength) {
                    return text;
                }
            }
            return '';
        }

        extractContent(container, type, isLiveDom = false) {
            const clone = container.cloneNode(true);

            // 精准删除广告和无关节点
            const removeSelectors = [
                'script', 'style', 'noscript', 'iframe', 'svg', 'img', 'canvas', 'video', 'audio',
                '.advertisement', '.ad', '.ads', '.advert', '.gg', '.guanggao',
                '.comment', '.comments', '.review', '.recommend', '.related',
                '.share', '.social', '.footer', '.header', '.sidebar',
                '.navigation', '.nav', '.menu', '.popup', '.modal', '.dialog',
                '.btn', '.button', '.toolbar', '.tool-bar',
                '[style*="display:none"]', '[style*="display: none"]', '[style*="visibility:hidden"]',
                '.hidden', '.hide'
            ];
            clone.querySelectorAll(removeSelectors.join(',')).forEach(n => n.remove());

            if (type === 'divLine') return this.extractDivLine(clone, isLiveDom);
            if (type === 'pTags') return this.extractPTags(clone, isLiveDom);
            if (type === 'cContent') return this.extractCContent(clone, isLiveDom);
            return this.extractAuto(clone, isLiveDom);
        }

        getText(el, isLiveDom) {
            return isLiveDom ? (el.innerText || '') : (el.textContent || '');
        }

        extractDivLine(clone, isLiveDom) {
            const lines = clone.querySelectorAll('div.line');
            if (lines.length >= 1) {
                const text = Array.from(lines)
                    .map(d => this.getText(d, isLiveDom).trim())
                    .filter(Boolean)
                    .join('\n\n');
                if (text.length > 0) return text;
            }
            return this.extractAuto(clone, isLiveDom);
        }

        extractPTags(clone, isLiveDom) {
            const ps = clone.querySelectorAll('p');
            if (ps.length > 0) {
                return Array.from(ps)
                    .map(p => this.getText(p, isLiveDom).trim())
                    .filter(Boolean)
                    .join('\n\n');
            }
            return '';
        }

        extractCContent(clone, isLiveDom) {
            const section = clone.querySelector('section.read-section');
            const h3 = clone.querySelector('h3') || (section && section.querySelector('h3'));
            const contentDiv = clone.querySelector('.content_txt') || (section && section.querySelector('.content_txt'));
            let result = '';

            if (h3) {
                result += this.getText(h3, isLiveDom).trim() + '\n\n';
            }

            if (contentDiv) {
                const ps = contentDiv.querySelectorAll('p');
                if (ps.length > 0) {
                    result += Array.from(ps)
                        .map(p => this.getText(p, isLiveDom).trim())
                        .filter(Boolean)
                        .join('\n\n');
                } else {
                    result += this.getText(contentDiv, isLiveDom).trim();
                }
            } else {
                // 回退：全 p 标签
                const ps = clone.querySelectorAll('p');
                if (ps.length > 0) {
                    result += Array.from(ps)
                        .map(p => this.getText(p, isLiveDom).trim())
                        .filter(Boolean)
                        .join('\n\n');
                } else {
                    result += this.getText(clone, isLiveDom).trim();
                }
            }
            return result;
        }

        extractAuto(clone, isLiveDom) {
            const ps = clone.querySelectorAll('p');
            if (ps.length > 0) {
                return Array.from(ps)
                    .map(p => this.getText(p, isLiveDom).trim())
                    .filter(Boolean)
                    .join('\n\n');
            }
            return this.getText(clone, isLiveDom).trim();
        }

        cleanText(t) {
            if (!t) return "";
            let text = t.replace(/\r/g, "");
            // 保留段落间双换行，仅压缩 3+ 换行为 2
            text = text.replace(/\n{3,}/g, "\n\n");
            text = text.replace(/本章完/g, "").replace(/未完待续/g, "").replace(/（未完待续）/g, "");
            text = text.replace(/[ \t]+/g, " ").trim();
            return text;
        }

        // ========== 标题提取 ==========

        /**
         * 获取章节标题
         * 优先级（调整后）：
         * 1. 网页 <title> 拆分（站点已格式化）
         * 2. 站点配置的 titleSelectors
         * 3. 正文区域内 h1/h3（匹配章节正则）
         * 4. 正文内容前 5 行正则
         * 5. 通用 titleSelectors 兜底
         */
        getTitle(doc, url = '') {
            // 1. <title> 优先
            if (doc.title && doc.title.trim()) {
                const parsed = this.parsePageTitle(doc.title);
                if (parsed.chapterTitle) return parsed.chapterTitle;
            }

            // 2. 站点配置
            const site = this.config.currentSite;
            if (site && site.titleSelectors) {
                for (const sel of site.titleSelectors) {
                    const el = doc.querySelector(sel);
                    if (el && el.textContent.trim()) return el.textContent.trim();
                }
            }

            // 3. 正文区域内 h1/h3（章节正则）
            const articleTitle = this.extractArticleTitle(doc);
            if (articleTitle) return articleTitle;

            // 4. 正文前 5 行正则
            const content = this.getContent(doc, false);
            if (content) {
                const fromContent = this.extractTitleFromContent(content);
                if (fromContent) return fromContent;
            }

            // 5. 通用兜底
            for (const sel of this.genericSelectors.titleSelectors) {
                const el = doc.querySelector(sel);
                if (el && el.textContent.trim()) return el.textContent.trim();
            }

            // 6. URL 兜底
            if (url) {
                const urlMatch = url.match(/\/([^\/]+?)(?:\.\w+)?(?:[?#].*)?$/);
                if (urlMatch) return decodeURIComponent(urlMatch[1]);
            }
            return '未知章节';
        }

        extractArticleTitle(doc) {
            const article = doc.querySelector('article, .content_txt, #chapterContent, main.dx-container');
            if (!article) return null;
            const headings = article.querySelectorAll('h3, h2, h1');
            for (const heading of headings) {
                const text = heading.textContent.trim();
                if (!text) continue;
                const chapterPattern = /^第[零一二三四五六七八九十百千万\d]+[章节卷回部集篇幕]/;
                if (chapterPattern.test(text)) return text;
            }
            return null;
        }

        parsePageTitle(title) {
            const patterns = [
                /^(第[零一二三四五六七八九十百千万\d]+[章节卷回部集篇幕][^_\-|]+)[_|\-](.+?)[_|\-].+$/,
                /^(第[零一二三四五六七八九十百千万\d]+[章节卷回部集篇幕][^_\-|]+)[_|\-](.+)$/,
                /^(第[零一二三四五六七八九十百千万\d]+[章节卷回部集篇幕].+)$/
            ];
            for (const pattern of patterns) {
                const match = title.trim().match(pattern);
                if (match) {
                    if (match[2]) {
                        this.config.novelName = this.config.novelName || match[2].trim();
                    }
                    return { chapterTitle: match[1].trim(), novelName: match[2] ? match[2].trim() : null };
                }
            }
            return { chapterTitle: title.trim(), novelName: null };
        }

        extractTitleFromContent(content) {
            const lines = content.split('\n').slice(0, 5).filter(l => l.trim());
            if (lines.length === 0) return null;
            const chapterPatterns = [
                /^第[零一二三四五六七八九十百千万\d]+[章节卷回部集篇幕].{0,50}$/,
                /^第[零一二三四五六七八九十百千万\d]+[章节卷回部集篇幕]/
            ];
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.length > 80) continue;
                for (const pattern of chapterPatterns) {
                    if (trimmed.match(pattern)) {
                        const titleMatch = trimmed.match(/^(第[零一二三四五六七八九十百千万\d]+[章节卷回部集篇幕][^.。!！?？\n]{0,50})/);
                        return titleMatch ? titleMatch[1].trim() : trimmed;
                    }
                }
            }
            return null;
        }

        // ========== 下一章查找 ==========

        findNextUrl(doc) {
            const targetDoc = doc || document;

            // 1. 站点配置的下一章选择器（如有）
            const site = this.config.currentSite;
            if (site && site.nextBtnSelectors) {
                for (const sel of site.nextBtnSelectors) {
                    try {
                        const url = this.extractUrlFromElement(targetDoc.querySelector(sel));
                        if (url) return url;
                    } catch (e) {}
                }
            }

            // 2. 通用选择器（含手机端常见）
            const mobileExtra = [
                '.pt-next a', '.pt-next', '.btn-next',
                '#btnNext', '#btn-next', '.next-btn',
                '.m-nav a:last-child', '.nav-btn-next',
                'a[rel="next"]', 'link[rel="next"]'
            ];
            const allSelectors = [...this.genericSelectors.nextBtnSelectors, ...mobileExtra];
            for (const sel of allSelectors) {
                try {
                    const url = this.extractUrlFromElement(targetDoc.querySelector(sel));
                    if (url) return url;
                } catch (e) {}
            }

            // 3. 文本匹配（精确匹配优先，含"下章"等简写）
            const allLinks = targetDoc.querySelectorAll('a, button, [role="button"], [onclick]');
            const exactTexts = ['下一章', '下章', '下一页', '下页', '下一节', '下节', '下篇', 'Next', 'next', 'NEXT', '›', '»', '▷'];
            for (const link of allLinks) {
                const text = (link.textContent || '').trim();
                if (exactTexts.includes(text)) {
                    const url = this.extractUrlFromElement(link);
                    if (url) return url;
                }
            }
            // 包含匹配
            for (const link of allLinks) {
                const text = (link.textContent || '').trim();
                if (text.length > 20) continue; // 跳过过长的（通常是正文）
                if (text.includes('下一章') || text.includes('下章') ||
                    text.includes('下一页') || text.includes('下页') ||
                    /^next$/i.test(text)) {
                    const url = this.extractUrlFromElement(link);
                    if (url) return url;
                }
            }

            // 4. 解析 onclick / data-* 属性中的 URL
            const jsEls = targetDoc.querySelectorAll('[onclick], [data-href], [data-url], [data-next]');
            for (const el of jsEls) {
                const url = this.extractUrlFromElement(el);
                if (url) return url;
            }

            return null;
        }

        /**
         * 从元素提取 URL：
         * - <a href> 标准
         * - button / div 的 data-href / data-url / data-next
         * - onclick 中的 location.href=xxx / window.open(xxx)
         */
        extractUrlFromElement(el) {
            if (!el) return null;

            // 1. 标准 href
            if (el.href && this.isSameOrigin(el.href)) {
                return el.href;
            }

            // 2. data-* 属性
            const dataAttrs = ['data-href', 'data-url', 'data-next', 'data-link'];
            for (const attr of dataAttrs) {
                const val = el.getAttribute(attr);
                if (val) {
                    const resolved = this.resolveUrl(val);
                    if (resolved && this.isSameOrigin(resolved)) return resolved;
                }
            }

            // 3. onclick 属性解析
            const onclick = el.getAttribute('onclick');
            if (onclick) {
                const url = this.extractUrlFromJs(onclick);
                if (url) {
                    const resolved = this.resolveUrl(url);
                    if (resolved && this.isSameOrigin(resolved)) return resolved;
                }
            }

            return null;
        }

        /** 从 JS 代码片段中提取 URL 字符串 */
        extractUrlFromJs(code) {
            if (!code) return null;
            const patterns = [
                /location\.href\s*=\s*['"]([^'"]+)['"]/,
                /window\.open\s*\(\s*['"]([^'"]+)['"]/,
                /location\.replace\s*\(\s*['"]([^'"]+)['"]/,
                /location\.assign\s*\(\s*['"]([^'"]+)['"]/,
                /['"]([^'"]*?)['"]\s*\/\/\s*next/i
            ];
            for (const p of patterns) {
                const m = code.match(p);
                if (m && m[1]) return m[1];
            }
            // 兜底：提取所有字符串字面量，找第一个像 URL 的
            const strMatches = code.match(/['"]([^'"]+)['"]/g) || [];
            for (const s of strMatches) {
                const val = s.slice(1, -1);
                if (/\.(html?|php|aspx?|jsp|\/\d+)/i.test(val) || /^\/[^\/]/.test(val)) {
                    return val;
                }
            }
            return null;
        }

        /** 解析相对 URL 为绝对 URL */
        resolveUrl(url) {
            if (!url) return null;
            try {
                return new URL(url, window.location.href).href;
            } catch (e) {
                return null;
            }
        }

        isSameOrigin(url) {
            try {
                const u = new URL(url, window.location.href);
                return u.origin === window.location.origin;
            } catch (e) {
                return false;
            }
        }

        // ========== 章节存储与去重 ==========

        /** 添加章节到结果集，返回 true 表示新增，false 表示已存在 */
        addChapter(chapter) {
            if (this.config.urlSet.has(chapter.url)) return false;
            this.config.chapters.push(chapter);
            this.config.urlSet.add(chapter.url);
            this.config.lastUrl = chapter.url;
            this.saveProgress();
            return true;
        }

        /**
         * 构建 url -> globalIndex 映射表
         * 数据源：config.chapterList（扫描时记录的原始目录顺序）
         * 用于排序时查表，确保无论 chapter 是否携带 globalIndex 字段都能正确排序
         */
        getGlobalIndexMap() {
            const map = new Map();
            const list = this.config.chapterList || [];
            list.forEach((item, i) => {
                if (item.url && !map.has(item.url)) {
                    map.set(item.url, typeof item.globalIndex === 'number' ? item.globalIndex : i);
                }
            });
            return map;
        }

        /** 获取排序后的章节列表（用 Map 映射 globalIndex，回退到 timestamp） */
        getSortedChapters() {
            const idxMap = this.getGlobalIndexMap();
            const hasMap = idxMap.size > 0;
            return [...this.config.chapters].sort((a, b) => {
                // 优先用 chapterList 的 url→globalIndex 映射（批量模式 + 续传混合场景）
                if (hasMap) {
                    const ai = idxMap.get(a.url);
                    const bi = idxMap.get(b.url);
                    if (typeof ai === 'number' && typeof bi === 'number') {
                        return ai - bi;
                    }
                    // 映射表缺失时，按 chapter 自带 globalIndex
                    if (typeof a.globalIndex === 'number' && typeof b.globalIndex === 'number') {
                        return a.globalIndex - b.globalIndex;
                    }
                }
                // 链路模式或无目录信息：按 timestamp
                if (typeof a.globalIndex === 'number' && typeof b.globalIndex === 'number') {
                    return a.globalIndex - b.globalIndex;
                }
                return (a.timestamp || 0) - (b.timestamp || 0);
            });
        }

        /** 更新指定 URL 的章节内容（用于失败重试） */
        updateChapter(url, updates) {
            const idx = this.config.chapters.findIndex(c => c.url === url);
            if (idx === -1) return false;
            Object.assign(this.config.chapters[idx], updates);
            this.saveProgress();
            return true;
        }

        /** 获取续传起点 URL */
        getResumeUrl() {
            // 优先用最后一章的 nextUrl（链路模式）
            if (this.config.chapters.length > 0) {
                const last = this.config.chapters[this.config.chapters.length - 1];
                if (last.nextUrl) return last.nextUrl;
            }
            // 兜底用 lastUrl
            if (this.config.lastUrl) return this.config.lastUrl;
            // 首次启动用当前页 URL
            return window.location.href;
        }

        // ========== 通用：下载单章 ==========

        /**
         * 下载单章并返回 chapter 对象
         * 命中验证码时抛出 Error('VERIFY_DETECTED')
         * 其他失败时抛出 Error(message)
         */
        async downloadOne(url, site) {
            const html = await this.getHtmlWithRetry(url, site);
            const doc = this.parseHtml(html);
            const title = this.getTitle(doc, url);
            const content = this.cleanText(this.getContent(doc, false));

            // 静态 HTML 抓不到时，尝试从当前页面 DOM 提取（仅当 URL 匹配当前页）
            if ((!content || content.length < this.config.minTxtLength) &&
                (window.location.href === url || window.location.href.includes(url.split('/').pop()))) {
                const liveContent = this.cleanText(this.getContent(document, true));
                if (liveContent.length > content.length) {
                    return {
                        title, content: liveContent, url,
                        nextUrl: this.findNextUrl(doc),
                        timestamp: Date.now(), status: 'ok', error: ''
                    };
                }
            }

            if (content.length < this.config.minTxtLength) {
                console.warn(`内容过短: ${title} (${content.length} 字符)`);
            }

            return {
                title, content, url,
                nextUrl: this.findNextUrl(doc),
                timestamp: Date.now(),
                status: content.length < this.config.minTxtLength ? 'short' : 'ok',
                error: content.length < this.config.minTxtLength ? `内容过短(${content.length})` : ''
            };
        }

        // ========== 批量模式：目录页扫描 ==========

        scanChapters() {
            this.config.chapterList = [];

            // 优先匹配站点配置
            for (const key of ['a', 'b', 'c']) {
                const site = this.sites[key];
                if (site.host) {
                    const hostOk = typeof site.host === 'string'
                        ? location.host.includes(site.host)
                        : site.host.test(location.host);
                    if (!hostOk) continue;
                }
                const links = document.querySelectorAll(site.chapterSelector);
                if (links.length > 0) {
                    this.config.currentSite = site;
                    this.scanChaptersBySite(links, site);
                    return this.config.chapterList.length;
                }
            }

            // 兜底：用通用选择器尝试
            const genericLinks = document.querySelectorAll('ul li a, .chapter-list a, .catalog a');
            if (genericLinks.length >= 10) {
                this.config.currentSite = null;
                this.scanChaptersBySite(genericLinks, null);
                return this.config.chapterList.length;
            }

            return 0;
        }

        scanChaptersBySite(links, site) {
            links.forEach((el, idx) => {
                let title = '';
                if (site && site.numSelector) {
                    const numEl = el.querySelector(site.numSelector);
                    const titleEl = el.querySelector(site.titleSelector);
                    const num = numEl ? numEl.textContent.trim() : '';
                    const titleText = titleEl ? titleEl.textContent.trim() : '';
                    title = [num, titleText].filter(Boolean).join(' ');
                } else if (site && site.titleSelector) {
                    const titleEl = el.querySelector(site.titleSelector);
                    title = titleEl ? titleEl.textContent.trim() : el.textContent.trim();
                } else {
                    title = el.textContent.trim();
                }

                if (title && title.length >= 2 && el.href) {
                    this.config.chapterList.push({
                        idx, title, url: el.href, globalIndex: idx, site
                    });
                }
            });

            // 去重 URL
            const seen = new Set();
            this.config.chapterList = this.config.chapterList.filter(item => {
                if (seen.has(item.url)) return false;
                seen.add(item.url);
                return true;
            });
            // 重新分配 globalIndex
            this.config.chapterList.forEach((item, i) => { item.globalIndex = i; });

            console.log(`[scanChaptersBySite] ${site ? site.name : '通用'}: ${this.config.chapterList.length} 章`);
        }

        // ========== 批量模式：下载 ==========

        async startBatch() {
            const tasks = this.config.chapterList;
            if (tasks.length === 0) {
                this.showNotice('请先扫描章节');
                return;
            }

            // 过滤已下载的（基于 urlSet 去重）
            const remaining = tasks.filter(t => !this.config.urlSet.has(t.url));
            const skipCount = tasks.length - remaining.length;
            if (skipCount > 0) {
                this.showNotice(`跳过已下载 ${skipCount} 章，剩余 ${remaining.length} 章`);
            }

            this.config.isRunning = true;
            this.config.cancel = false;
            this.config.currentTaskCount = tasks.length;
            this.updateRunningUI(true);

            const site = this.config.currentSite;
            const isSiteC = site && site.hasVerify;
            const batchSize = isSiteC ? 10 : remaining.length;
            const pauseTime = isSiteC ? 30000 : 0;
            // C 站反爬严格：保留原延迟；A/B 站放宽（并发更高、延迟更短）
            const effDelay = isSiteC ? this.config.delay : Math.max(300, Math.floor(this.config.delay / 3));
            const effConcurrency = isSiteC ? this.config.maxConcurrency : Math.min(8, this.config.maxConcurrency * 2);

            let totalIndex = 0;
            let batchCount = 0;

            while (totalIndex < remaining.length && !this.config.cancel) {
                const batchEnd = Math.min(totalIndex + batchSize, remaining.length);
                const batchTasks = remaining.slice(totalIndex, batchEnd);
                batchCount++;
                this.updateStatus(`第${batchCount}批: ${this.config.chapters.length}/${tasks.length}`);

                let dlCount = 0;
                let batchIndex = 0;
                const minPerMin = this.config.maxDlPerMin;

                const scheduleNext = async (waitTime) => {
                    while (batchIndex < batchTasks.length && !this.config.cancel) {
                        const currentIndex = batchIndex++;
                        const task = batchTasks[currentIndex];
                        this.updateCurrentChapter(task.title);
                        this.updateStatus(`下载中: ${this.config.chapters.length + 1}/${tasks.length}`);

                        if (minPerMin > 0 && dlCount >= minPerMin) {
                            await this.sleepWithCountdown(60000, '达到每分钟限制，等待');
                            dlCount = 0;
                        }
                        dlCount++;

                        try {
                            const chapter = await this.downloadOne(task.url, task.site);
                            chapter.globalIndex = task.globalIndex;  // 保留原始顺序
                            this.addChapter(chapter);

                            // 若刚通过的正是待验证章，清除标记
                            if (this.config.pendingVerifyChapter &&
                                this.config.pendingVerifyChapter.url === task.url) {
                                this.config.pendingVerifyChapter = null;
                                this.saveProgress();
                            }

                            this.updateChapterList();
                            this.updateStatus(`已下载: ${this.config.chapters.length}/${tasks.length}`);
                        } catch (e) {
                            if (e.message === 'VERIFY_DETECTED') {
                                this.handleVerifyDetected(task);
                                return;
                            }
                            if (e.message === 'CANCELLED') return;
                            console.error(`下载失败: ${task.title} - ${e.message}`);
                            this.addChapter({
                                title: task.title, content: '', url: task.url,
                                nextUrl: null, timestamp: Date.now(),
                                status: 'failed', error: e.message
                            });
                            this.updateChapterList();
                        }

                        if (waitTime > 0) {
                            await this.sleep(waitTime);
                        } else if (this.config.adaptiveDelay && effDelay > 0) {
                            await this.sleep(effDelay + Math.random() * 200);
                        }
                    }
                };

                const concurrency = effConcurrency;
                if (concurrency > 0) {
                    const workerCount = Math.min(concurrency, batchTasks.length);
                    const workers = [];
                    for (let i = 0; i < workerCount; i++) {
                        workers.push(scheduleNext(effDelay));
                    }
                    await Promise.all(workers);
                } else {
                    await scheduleNext(Math.abs(concurrency) * 1000);
                }

                totalIndex = batchEnd;

                if (!this.config.cancel && totalIndex < remaining.length && pauseTime > 0) {
                    await this.sleepWithCountdown(pauseTime, 'C站限制，暂停');
                }
            }

            this.config.isRunning = false;
            this.updateRunningUI(false);

            if (!this.config.cancel) {
                this.updateStatus(`✅ 批量下载完成 (${this.config.chapters.length} 章)，点击💾保存导出`, 'ok');
                this.showNotice(`✅ 全部完成，共 ${this.config.chapters.length} 章`);
                // 完成后清空持久化存储，刷新页面即可开始下载下一本（内存中 chapters 保留供用户点保存导出）
                GM_setValue(STORAGE_KEY, '');
            } else if (this.config.pendingVerifyChapter) {
                this.updateStatus(`⚠️ 验证码拦截，已保存 ${this.config.chapters.length} 章。完成验证后点击继续`, 'warn');
            } else {
                this.updateStatus(`已停止 (${this.config.chapters.length}/${tasks.length})`);
            }
        }

        // ========== 链路模式：下一章循环 ==========

        async startChain() {
            if (this.config.isRunning && !this.config.isPaused) {
                console.log('⚠️ 已在运行中');
                return;
            }

            // 从暂停恢复
            if (this.config.isPaused) {
                this.config.isPaused = false;
                this.updateStatus('▶️ 继续爬取...');
                return;
            }

            this.config.isRunning = true;
            this.config.isPaused = false;
            this.config.cancel = false;
            this.updateRunningUI(true);

            const site = this.config.currentSite;
            const isSiteC = site && site.hasVerify;

            // 续传起点：优先用最后一章的 nextUrl，避免重复抓已存章
            let currentUrl = this.getResumeUrl();
            console.log(`[startChain] 起点: ${currentUrl}`);
            let chapterCount = 0;

            while (this.config.isRunning) {
                if (this.config.cancel) break;
                if (this.config.isPaused) {
                    await this.sleep(500);
                    continue;
                }

                // 已存在则跳过（取下一章）
                if (this.config.urlSet.has(currentUrl)) {
                    // 找已存章的 nextUrl
                    const exist = this.config.chapters.find(c => c.url === currentUrl);
                    if (exist && exist.nextUrl) {
                        currentUrl = exist.nextUrl;
                        continue;
                    } else {
                        // 无 nextUrl 信息，需要重新请求获取
                        console.log(`[startChain] 已存章无 nextUrl，重新请求: ${currentUrl}`);
                    }
                }

                try {
                    this.updateCurrentChapter(currentUrl);
                    this.updateStatus(`爬取中: ${this.config.chapters.length + 1} 章`);

                    const site = this.config.currentSite;
                    const chapter = await this.downloadOne(currentUrl, site);

                    if (!chapter.content || chapter.content.length < this.config.minTxtLength) {
                        console.warn(`⚠️ 内容过短，可能是末页或反爬`);
                    }

                    const added = this.addChapter(chapter);
                    if (!added) {
                        console.log(`⏭️ 已存在，跳过: ${chapter.title}`);
                    } else {
                        chapterCount++;
                        this.updateChapterList();
                        this.updateStatus(`已爬取: ${this.config.chapters.length} 章`);
                        console.log(`📚 已保存 [${chapterCount}]: ${chapter.title}`);
                    }

                    // 清除待验证标记
                    if (this.config.pendingVerifyChapter &&
                        this.config.pendingVerifyChapter.url === currentUrl) {
                        this.config.pendingVerifyChapter = null;
                        this.saveProgress();
                    }

                    if (!chapter.nextUrl) {
                        console.log('⚠️ 未找到下一章链接，切换到手动下滑模式');
                        this.updateStatus('未找到下一章，切换手动下滑模式');
                        this.startManualMode();
                        return;
                    }

                    // 下一章就是当前章则跳出（防止死循环）
                    if (chapter.nextUrl === currentUrl) {
                        console.warn('⚠️ 下一章URL与当前相同，停止');
                        break;
                    }

                    currentUrl = chapter.nextUrl;
                    // C 站保留原 chainDelay；A/B 站放宽为 1/3
                    const baseDelay = isSiteC ? this.config.chainDelay : Math.max(500, Math.floor(this.config.chainDelay / 3));
                    const randomDelay = baseDelay + (Math.random() - 0.5) * 1000;
                    await this.sleep(randomDelay);

                } catch (e) {
                    if (e.message === 'VERIFY_DETECTED') {
                        this.handleVerifyDetected({
                            title: '未知', url: currentUrl, globalIndex: this.config.chapters.length
                        });
                        return;
                    }
                    if (e.message === 'CANCELLED') break;
                    console.error(`❌ 请求失败: ${e.message}`);
                    await this.sleepWithCountdown(5000, `请求失败: ${e.message}，重试`);
                    // 不 break，继续重试同 URL
                }
            }

            this.config.isRunning = false;
            this.config.isPaused = false;
            this.updateRunningUI(false);

            if (!this.config.cancel) {
                this.updateStatus(`✅ 链路爬取完成，共 ${this.config.chapters.length} 章，点击💾保存导出`, 'ok');
                // 完成后清空持久化存储，刷新即可下载下一本
                GM_setValue(STORAGE_KEY, '');
            } else if (this.config.pendingVerifyChapter) {
                this.updateStatus(`⚠️ 验证码拦截，已保存 ${this.config.chapters.length} 章。完成验证后点击继续`);
            } else {
                this.updateStatus(`已停止 (${this.config.chapters.length} 章)`);
            }
        }

        pauseChain() {
            if (!this.config.isRunning) return;
            this.config.isPaused = true;
            this.updateStatus('⏸️ 已暂停');
            this.updateRunningUI(true);
        }

        // ========== 手动下滑模式（链路模式 fallback） ==========

        startManualMode() {
            this.config.isPaused = false;
            this.config.cancel = false;
            this.config.isRunning = true;
            this.updateStatus('🔄 手动下滑模式，请向下滚动页面');
            this.addScrollListener();
        }

        addScrollListener() {
            if (this.scrollHandler) return;
            let debounce = null;
            let lastScrollHeight = 0;
            this.scrollHandler = () => {
                if (debounce) clearTimeout(debounce);
                debounce = setTimeout(() => {
                    const scrollHeight = document.documentElement.scrollHeight;
                    // 仅在页面高度变化时提取
                    if (scrollHeight === lastScrollHeight) return;
                    lastScrollHeight = scrollHeight;

                    const content = this.getContent(document, true);
                    if (!content || content.length < this.config.minTxtLength) return;

                    const url = window.location.href;
                    if (this.config.urlSet.has(url)) return;

                    const title = this.getTitle(document, url);
                    const nextUrl = this.findNextUrl(document);
                    this.addChapter({
                        title, content: this.cleanText(content), url, nextUrl,
                        timestamp: Date.now(), status: 'ok', error: '', isManual: true
                    });
                    this.updateChapterList();
                    this.updateStatus(`手动保存: ${this.config.chapters.length} 章`);
                }, 500);
            };
            window.addEventListener('scroll', this.scrollHandler, { passive: true });
        }

        removeScrollListener() {
            if (this.scrollHandler) {
                window.removeEventListener('scroll', this.scrollHandler);
                this.scrollHandler = null;
            }
        }

        // ========== 验证码处理（方案 A） ==========

        handleVerifyDetected(task) {
            console.warn(`⚠️ 验证码拦截: ${task.title}`);
            this.config.pendingVerifyChapter = {
                title: task.title, url: task.url, globalIndex: task.globalIndex
            };
            this.config.cancel = true;
            this.saveProgress();
            this.saveFile();
            this.config.isRunning = false;
            this.updateRunningUI(false);
            this.updateStatus(`⚠️ 第${this.config.chapters.length + 1}章触发验证码，已保存 ${this.config.chapters.length} 章。请在浏览器完成验证后点击继续`);
            this.showNotice(`⚠️ 验证码拦截，已保存 ${this.config.chapters.length} 章`);
        }

        // ========== 取消 ==========

        cancelDownload() {
            this.config.cancel = true;
            this.config.isPaused = false;
            this.config.isRunning = false;
            this.removeScrollListener();
            this.updateStatus('正在停止...');
            this.updateRunningUI(false);
        }

        // ========== UI 构建 ==========

        createUI() {
            // 防重复创建
            if (document.getElementById('novel-downloader-merged-container')) return;

            this.shadowContainer = document.createElement('div');
            this.shadowContainer.id = 'novel-downloader-merged-container';
            this.shadowContainer.style.cssText = 'position:fixed;z-index:999999;';
            document.body.appendChild(this.shadowContainer);

            this.shadowRoot = this.shadowContainer.attachShadow({ mode: 'open' });

            const style = document.createElement('style');
            style.textContent = `
                :host, * { all: initial; box-sizing: border-box; }
                style { display: none !important; }
                .panel {
                    position: fixed; top: 16px; right: 16px;
                    width: 360px; max-width: calc(100vw - 32px); max-height: 80vh;
                    background: #fff; border-radius: 10px;
                    box-shadow: 0 6px 24px rgba(0,0,0,0.18);
                    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
                    font-size: 13px; color: #222;
                    display: flex; flex-direction: column;
                    overflow: hidden;
                    -webkit-tap-highlight-color: transparent;
                }
                .header {
                    padding: 10px 14px; background: linear-gradient(135deg, #4a90e2, #357abd);
                    color: #fff; display: flex; justify-content: space-between; align-items: center;
                    font-weight: 600; cursor: move; user-select: none;
                }
                .header .title { font-size: 14px; }
                .header .ver { font-size: 11px; opacity: 0.8; }
                .close-btn {
                    cursor: pointer; font-size: 18px; line-height: 1;
                    width: 26px; height: 26px; text-align: center;
                    border-radius: 50%; background: rgba(255,255,255,0.2);
                    display: flex; align-items: center; justify-content: center;
                }
                .close-btn:hover { background: rgba(255,255,255,0.35); }
                .body { padding: 12px 14px; overflow-y: auto; flex: 1; -webkit-overflow-scrolling: touch; }
                .status-box {
                    padding: 8px 10px; background: #f5f7fa;
                    border-radius: 6px; margin-bottom: 10px;
                    min-height: 32px; font-size: 12px; color: #555;
                    border-left: 3px solid #4a90e2; word-break: break-all;
                }
                .status-box.warn { border-left-color: #f5a623; background: #fff8e1; }
                .status-box.error { border-left-color: #e74c3c; background: #fdecea; }
                .status-box.ok { border-left-color: #27ae60; background: #eafaf1; }
                .chapter-info {
                    font-size: 11px; color: #888; margin-bottom: 8px;
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                }
                .btn-row {
                    display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap;
                }
                .btn {
                    flex: 1; min-width: 70px; padding: 8px 8px;
                    border: none; border-radius: 5px; cursor: pointer;
                    font-size: 12px; color: #fff; font-weight: 500;
                    transition: opacity 0.15s;
                }
                .btn:hover { opacity: 0.9; }
                .btn:active { opacity: 0.7; }
                .btn:disabled { opacity: 0.5; cursor: not-allowed; }
                .btn-scan { background: #6c757d; }
                .btn-start { background: #27ae60; }
                .btn-pause { background: #f5a623; }
                .btn-stop { background: #e74c3c; }
                .btn-save { background: #4a90e2; }
                .count-line {
                    display: flex; justify-content: space-between;
                    margin-bottom: 6px; font-size: 12px; color: #666;
                }
                .count-line a { color: #4a90e2; cursor: pointer; text-decoration: underline; padding: 4px 0; }
                .chapter-list {
                    border: 1px solid #eee; border-radius: 5px;
                    max-height: 200px; overflow-y: auto;
                    background: #fafafa;
                    -webkit-overflow-scrolling: touch;
                }
                .chapter-item {
                    padding: 8px 10px; font-size: 12px; color: #444;
                    border-bottom: 1px solid #f0f0f0;
                    display: flex; align-items: center; gap: 8px;
                    cursor: pointer;
                }
                .chapter-item:hover { background: #eef5ff; }
                .chapter-item input[type="checkbox"] {
                    margin: 0; cursor: pointer;
                    width: 16px; height: 16px;
                    appearance: auto; -webkit-appearance: auto;
                    accent-color: #4a90e2;
                }
                .chapter-item .status-dot {
                    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
                }
                .chapter-item .status-dot.ok { background: #27ae60; }
                .chapter-item .status-dot.failed { background: #e74c3c; }
                .chapter-item .status-dot.short { background: #f5a623; }
                .chapter-item .title-text {
                    flex: 1; white-space: nowrap;
                    overflow: hidden; text-overflow: ellipsis;
                }
                .range-box {
                    display: flex; gap: 4px; align-items: center;
                    margin-top: 6px; font-size: 11px; color: #666;
                    flex-wrap: wrap;
                }
                .range-box input {
                    width: 50px; padding: 5px 4px; border: 1px solid #ccc;
                    border-radius: 3px; font-size: 12px;
                }
                .range-box button {
                    padding: 5px 10px; background: #6c757d; color: #fff;
                    border: none; border-radius: 3px; cursor: pointer; font-size: 12px;
                }

                /* 手机端适配 */
                @media (max-width: 768px) {
                    .panel {
                        top: auto; bottom: 0; right: 0; left: 0;
                        width: 100%; max-width: 100%;
                        max-height: 60vh;
                        border-radius: 10px 10px 0 0;
                        box-shadow: 0 -4px 20px rgba(0,0,0,0.15);
                    }
                    .header { padding: 12px 14px; cursor: move; }
                    .header .title { font-size: 15px; }
                    .body { padding: 10px 12px; }
                    .status-box { font-size: 13px; padding: 10px 12px; }
                    .btn { padding: 11px 6px; font-size: 13px; min-width: 60px; }
                    .chapter-item { padding: 10px; font-size: 13px; }
                    .chapter-item input[type="checkbox"] { width: 20px; height: 20px; }
                    .chapter-item .status-dot { width: 10px; height: 10px; }
                    .range-box input { width: 60px; padding: 7px 4px; font-size: 13px; }
                    .range-box button { padding: 7px 12px; font-size: 13px; }
                    .count-line a { padding: 6px 4px; }
                }

                /* 折叠态（手机端最小化） */
                .panel.collapsed { max-height: 42px; overflow: hidden; }
                .panel.collapsed .body { display: none; }
            `;
            this.shadowRoot.appendChild(style);

            this.panel = document.createElement('div');
            this.panel.className = 'panel';
            this.panel.innerHTML = `
                <div class="header">
                    <span><span class="title">📖 小说下载器</span> <span class="ver">v${VERSION}</span></span>
                    <span class="close-btn" title="隐藏面板">×</span>
                </div>
                <div class="body">
                    <div class="status-box" id="status-box">就绪</div>
                    <div class="chapter-info" id="chapter-info"></div>
                    <div class="btn-row">
                        <button class="btn btn-scan" id="btn-scan">🔍 扫描</button>
                        <button class="btn btn-start" id="btn-start">▶ 开始</button>
                        <button class="btn btn-pause" id="btn-pause" style="display:none">⏸ 暂停</button>
                        <button class="btn btn-stop" id="btn-stop" style="display:none">⏹ 停止</button>
                        <button class="btn btn-save" id="btn-save">💾 保存</button>
                    </div>
                    <div class="count-line">
                        <span>章节列表 <span id="chapter-count">0</span></span>
                        <span>
                            <a id="select-all">全选</a> |
                            <a id="select-none">取消</a> |
                            <a id="select-invert">反选</a>
                        </span>
                    </div>
                    <div class="range-box">
                        范围:
                        <input type="number" id="range-start" placeholder="起" min="1">
                        -
                        <input type="number" id="range-end" placeholder="止" min="1">
                        <button id="range-apply">应用</button>
                    </div>
                    <div class="chapter-list" id="chapter-list"></div>
                </div>
            `;
            this.shadowRoot.appendChild(this.panel);

            // 缓存引用
            this.statusLabel = this.shadowRoot.getElementById('status-box');
            this.currentChapterLabel = this.shadowRoot.getElementById('chapter-info');
            this.countLabel = this.shadowRoot.getElementById('chapter-count');
            this.chapterListContainer = this.shadowRoot.getElementById('chapter-list');
            this.scanBtn = this.shadowRoot.getElementById('btn-scan');
            this.actionBtn = this.shadowRoot.getElementById('btn-start');
            this.pauseBtn = this.shadowRoot.getElementById('btn-pause');
            this.stopBtn = this.shadowRoot.getElementById('btn-stop');
            this.saveBtn = this.shadowRoot.getElementById('btn-save');

            // 事件
            this.shadowRoot.querySelector('.close-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.panel.style.display = 'none';
            });
            this.scanBtn.addEventListener('click', () => this.handleScanClick());
            this.actionBtn.addEventListener('click', () => this.handleActionClick());
            this.pauseBtn.addEventListener('click', () => this.handlePauseClick());
            this.stopBtn.addEventListener('click', () => this.cancelDownload());
            this.saveBtn.addEventListener('click', () => this.handleSaveClick());

            this.shadowRoot.getElementById('select-all').addEventListener('click', () => this.selectAll(true));
            this.shadowRoot.getElementById('select-none').addEventListener('click', () => this.selectAll(false));
            this.shadowRoot.getElementById('select-invert').addEventListener('click', () => this.invertSelect());
            this.shadowRoot.getElementById('range-apply').addEventListener('click', () => this.applyRange());

            // 拖动支持
            this.enableDrag();

            // 初始化章节列表
            this.updateChapterList();
        }

        /** 启用面板拖动（header 区域） */
        enableDrag() {
            const header = this.shadowRoot.querySelector('.header');
            if (!header || !this.panel) return;

            let isDragging = false;
            let startX = 0, startY = 0;
            let startLeft = 0, startTop = 0;
            let dragMoved = false;

            const onDown = (e) => {
                // 点击关闭按钮不触发拖动
                if (e.target.classList.contains('close-btn')) return;
                isDragging = true;
                dragMoved = false;
                const touch = e.touches ? e.touches[0] : e;
                startX = touch.clientX;
                startY = touch.clientY;

                const rect = this.panel.getBoundingClientRect();
                startLeft = rect.left;
                startTop = rect.top;

                // 切换为绝对定位
                this.panel.style.left = startLeft + 'px';
                this.panel.style.top = startTop + 'px';
                this.panel.style.right = 'auto';
                this.panel.style.bottom = 'auto';

                e.preventDefault();
            };

            const onMove = (e) => {
                if (!isDragging) return;
                const touch = e.touches ? e.touches[0] : e;
                const dx = touch.clientX - startX;
                const dy = touch.clientY - startY;
                if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;

                let newLeft = startLeft + dx;
                let newTop = startTop + dy;

                // 边界约束
                const maxLeft = window.innerWidth - this.panel.offsetWidth;
                const maxTop = window.innerHeight - 42;
                newLeft = Math.max(0, Math.min(newLeft, maxLeft));
                newTop = Math.max(0, Math.min(newTop, maxTop));

                this.panel.style.left = newLeft + 'px';
                this.panel.style.top = newTop + 'px';
            };

            const onUp = (e) => {
                if (!isDragging) return;
                isDragging = false;
                // 未移动且为手机端 → 切换折叠态
                if (!dragMoved && this.isMobile()) {
                    this.panel.classList.toggle('collapsed');
                }
            };

            header.addEventListener('mousedown', onDown);
            header.addEventListener('touchstart', onDown, { passive: false });
            document.addEventListener('mousemove', onMove);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('mouseup', onUp);
            document.addEventListener('touchend', onUp);
        }

        // ========== UI 状态更新 ==========

        updateStatus(text, type = '') {
            if (!this.statusLabel) return;
            this.statusLabel.textContent = text;
            this.statusLabel.className = 'status-box ' + type;
        }

        updateCurrentChapter(text) {
            if (this.currentChapterLabel) {
                this.currentChapterLabel.textContent = text ? `当前: ${text}` : '';
            }
        }

        updateChapterList() {
            if (!this.chapterListContainer) return;
            // UI 列表按 globalIndex/timestamp 排序，保证显示顺序正确
            const chapters = this.getSortedChapters();
            if (this.countLabel) this.countLabel.textContent = chapters.length;

            // 性能：超过 200 章仅渲染前 200（避免卡顿）
            const limit = 200;
            const renderList = chapters.length > limit
                ? chapters.slice(0, limit)
                : chapters;

            this.chapterListContainer.innerHTML = renderList.map((c, i) => {
                const dotClass = c.status === 'ok' ? 'ok' : (c.status === 'failed' ? 'failed' : 'short');
                const escaped = (c.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                return `<div class="chapter-item" data-idx="${i}">
                    <input type="checkbox" ${c._selected ? 'checked' : ''} data-idx="${i}">
                    <span class="status-dot ${dotClass}"></span>
                    <span class="title-text" title="${escaped}">${escaped}</span>
                </div>`;
            }).join('');

            if (chapters.length > limit) {
                const notice = document.createElement('div');
                notice.className = 'chapter-item';
                notice.style.justifyContent = 'center';
                notice.style.color = '#999';
                notice.textContent = `... 仅显示前 ${limit} 章，共 ${chapters.length} 章`;
                this.chapterListContainer.appendChild(notice);
            }

            // 绑定 checkbox
            this.chapterListContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                cb.addEventListener('change', (e) => {
                    const idx = parseInt(e.target.dataset.idx);
                    if (this.config.chapters[idx]) {
                        this.config.chapters[idx]._selected = e.target.checked;
                    }
                });
            });
        }

        updateRunningUI(isRunning) {
            if (!this.actionBtn) return;
            if (isRunning) {
                this.actionBtn.style.display = 'none';
                this.pauseBtn.style.display = 'block';
                this.stopBtn.style.display = 'block';
                this.scanBtn.disabled = true;
            } else {
                this.actionBtn.style.display = 'block';
                this.pauseBtn.style.display = 'none';
                this.stopBtn.style.display = 'none';
                this.scanBtn.disabled = false;
            }
        }

        showNotice(msg) {
            console.log('[Notice]', msg);
            // 不再使用 alert 弹窗打断操作，仅更新状态栏
            if (this.statusLabel) {
                this.statusLabel.textContent = msg;
            }
        }

        // ========== UI 事件处理 ==========

        handleScanClick() {
            if (this.config.mode === 'batch') {
                const count = this.scanChapters();
                if (count > 0) {
                    this.updateStatus(`✅ 扫描到 ${count} 章，点击开始下载`, 'ok');
                    this.showNotice(`扫描到 ${count} 章`);
                } else {
                    this.updateStatus('未扫描到章节，请确认在目录页', 'warn');
                }
            } else if (this.config.mode === 'chain') {
                this.updateStatus('链路模式无需扫描，直接点击开始', 'warn');
            } else {
                this.detectMode();
                if (this.config.mode) {
                    this.handleScanClick();
                } else {
                    this.updateStatus('未识别页面类型，请手动选择', 'error');
                }
            }
        }

        handleActionClick() {
            if (!this.config.mode) {
                this.detectMode();
                if (!this.config.mode) {
                    this.updateStatus('未识别页面类型', 'error');
                    return;
                }
            }

            if (this.config.mode === 'batch') {
                if (this.config.chapterList.length === 0) {
                    this.scanChapters();
                }
                if (this.config.chapterList.length === 0) {
                    this.updateStatus('未扫描到章节', 'warn');
                    return;
                }
                this.startBatch();
            } else {
                this.startChain();
            }
        }

        handlePauseClick() {
            if (this.config.mode === 'chain') {
                if (this.config.isPaused) {
                    this.config.isPaused = false;
                    this.updateStatus('▶️ 继续爬取...');
                    this.pauseBtn.textContent = '⏸ 暂停';
                } else {
                    this.pauseChain();
                    this.pauseBtn.textContent = '▶ 继续';
                }
            } else {
                // 批量模式不支持暂停，仅停止
                this.updateStatus('批量模式不支持暂停，请用停止', 'warn');
            }
        }

        handleSaveClick() {
            this.saveFile();
        }

        // ========== 选择控制 ==========

        selectAll(selected) {
            this.config.chapters.forEach(c => { c._selected = selected; });
            this.updateChapterList();
        }

        invertSelect() {
            this.config.chapters.forEach(c => { c._selected = !c._selected; });
            this.updateChapterList();
        }

        applyRange() {
            const startEl = this.shadowRoot.getElementById('range-start');
            const endEl = this.shadowRoot.getElementById('range-end');
            const start = parseInt(startEl.value);
            const end = parseInt(endEl.value);
            if (!start || !end || start < 1 || end < start) {
                this.updateStatus('范围无效，请输入起止章节号', 'warn');
                return;
            }
            const max = this.config.chapters.length;
            const s = Math.min(start, max);
            const e = Math.min(end, max);
            this.config.chapters.forEach((c, i) => {
                c._selected = (i >= s - 1 && i <= e - 1);
            });
            this.updateChapterList();
            this.updateStatus(`已选择第 ${s}-${e} 章`, 'ok');
        }

        // ========== 导出 ==========

        saveFile() {
            const chapters = this.config.chapters;
            if (chapters.length === 0) {
                this.showNotice('没有可导出的章节');
                return;
            }

            const selected = chapters.filter(c => c._selected);
            const list = selected.length > 0 ? selected : chapters;
            // 用 Map 映射 url→globalIndex 确保顺序正确（兼容续传/混合场景）
            const sorted = this.getSortedChapters().filter(c =>
                selected.length > 0 ? c._selected : true
            );

            const parts = [];
            for (const c of sorted) {
                if (c.status === 'failed' || !c.content) {
                    parts.push(`${c.title}\n\n[下载失败: ${c.error || '未知错误'}]\n\n`);
                } else {
                    parts.push(`${c.title}\n\n${c.content}\n\n`);
                }
            }
            const text = parts.join('');

            const novelName = this.config.novelName || '未命名小说';
            const filename = `${novelName}.txt`;

            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);

            this.updateStatus(`✅ 已导出 ${list.length} 章到 ${filename}`, 'ok');
        }

        // ========== 设置 ==========

        showSettings() {
            const c = this.config;
            const input = prompt(
                '参数设置（JSON 格式）\n' +
                'maxConcurrency: 并发数\n' +
                'delay: 批量模式间隔(ms)\n' +
                'chainDelay: 链路模式间隔(ms)\n' +
                'retryCount: 重试次数\n' +
                'minTxtLength: 最小正文长度\n' +
                'maxDlPerMin: 每分钟上限(0=不限)\n\n' +
                '留空取消，输入 JSON 保存',
                JSON.stringify({
                    maxConcurrency: c.maxConcurrency,
                    delay: c.delay,
                    chainDelay: c.chainDelay,
                    retryCount: c.retryCount,
                    minTxtLength: c.minTxtLength,
                    maxDlPerMin: c.maxDlPerMin
                }, null, 2)
            );
            if (!input) return;
            try {
                const data = JSON.parse(input);
                Object.assign(c, data);
                GM_setValue('novelDownloaderMerged_settings', JSON.stringify(data));
                this.showNotice('设置已保存');
            } catch (e) {
                this.showNotice('JSON 解析失败: ' + e.message);
            }
        }
    }

    new NovelDownloaderMerged();
})();
