// ==UserScript==
// @name         小说下载器-三站整合版
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  适配三个特定小说网站，支持智能验证码处理和多种下载优化
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

    class NovelDownloader {
        constructor() {
            this.config = {
                maxConcurrency: 3,
                delay: 1000,
                adaptiveDelay: true,
                maxDlPerMin: 30,
                chapterList: [],
                resultMap: {},
                isDownloading: false,
                completed: 0,
                cancel: false,
                retryCount: 5,
                minTxtLength: 100,
                verifyWaitTime: 5000,
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
                    name: '站点A',
                    hostPattern: null,
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
                    hostPattern: null,
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
                    hostPattern: null,
                    chapterSelector: 'ul.section-list.fix li a',
                    titleSelector: '',
                    titleSelectors: ['.info .top h1', '.xs-title'],
                    contentSelectors: ['article#chapterContent'],
                    contentExtractor: 'cContent',
                    hasVerify: true,
                    verifyKeywords: ['验证', 'verify', 'captcha', 'check', '安全', '人机']
                }
            };
            
            this.currentSite = null;
            
            this.init();
        }
        
        init() {
            this.loadProgress();
            this.createUI();
            this.registerMenu();
            console.log("📖 小说下载器-三站整合版 v1.0 已就绪");
        }
        
        registerMenu() {
            const self = this;
            GM_registerMenuCommand("🔍 扫描章节", () => {
                self.scanChapters();
            });
            GM_registerMenuCommand("⚙️ 设置参数", () => {
                self.showSettings();
            });
        }
        
        loadProgress() {
            const saved = GM_getValue('novelDownloader_progress');
            if (saved) {
                try {
                    const data = JSON.parse(saved);
                    this.config.completed = data.completed || 0;
                    this.config.resultMap = data.resultMap || {};
                    console.log(`📂 加载进度: ${this.config.completed}章`);
                } catch (e) {
                    console.warn('加载进度失败:', e);
                }
            }
        }
        
        saveProgress() {
            const data = {
                completed: this.config.completed,
                resultMap: this.config.resultMap
            };
            GM_setValue('novelDownloader_progress', JSON.stringify(data));
        }
        
        clearProgress() {
            GM_setValue('novelDownloader_progress', '');
            this.config.completed = 0;
            this.config.resultMap = {};
        }
        
        sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }
        
        detectVerify(html) {
            if (!this.currentSite || !this.currentSite.hasVerify) {
                return false;
            }
            
            const keywords = this.currentSite.verifyKeywords;
            const lowerHtml = html.toLowerCase();
            
            for (const keyword of keywords) {
                if (lowerHtml.includes(keyword.toLowerCase())) {
                    console.warn(`⚠️ 检测到验证码关键词: ${keyword}`);
                    return true;
                }
            }
            
            return false;
        }
        
        async getHtml(url, checkVerify = true, site = null) {
            const randomDelay = 500 + Math.random() * 1000;
            await this.sleep(randomDelay);

            return new Promise((resolve, reject) => {
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
                    onload: async (res) => {
                        const html = res.responseText;
                        console.log(`[getHtml] 请求返回HTML长度: ${html.length}`);
                        
                        if (checkVerify && site && site.hasVerify) {
                            const oldSite = this.currentSite;
                            this.currentSite = site;
                            try {
                                if (this.detectVerify(html)) {
                                    this.currentSite = oldSite;
                                    reject(new Error('VERIFY_DETECTED'));
                                    return;
                                }
                            } catch (e) {
                                this.currentSite = oldSite;
                                reject(e);
                                return;
                            }
                            this.currentSite = oldSite;
                        }
                        
                        resolve(html);
                    },
                    onerror: (e) => {
                        console.error('请求失败:', e);
                        reject(new Error('网络请求失败'));
                    },
                    ontimeout: () => {
                        console.error('请求超时:', url);
                        reject(new Error('请求超时'));
                    }
                });
            });
        }
        
        parse(html) {
            if (!html) return document.implementation.createHTMLDocument();
            const cleaned = html.replace(/data-novel-info="[^"]*"/g, 'data-novel-info=""');
            return new DOMParser().parseFromString(cleaned, "text/html");
        }
        
        getContent(doc, isLiveDom = false) {
            if (!this.currentSite || !this.currentSite.contentSelectors) {
                console.warn('无站点配置或无contentSelectors');
                console.log(`[正文] currentSite: ${this.currentSite ? this.currentSite.name : 'null'}`);
                return '';
            }
            
            const extractor = this.currentSite.contentExtractor || 'text';
            console.log(`[正文] 站点:${this.currentSite.name} 提取器:${extractor}, 是否实时DOM: ${isLiveDom}`);
            console.log(`[正文] contentSelectors: ${JSON.stringify(this.currentSite.contentSelectors)}`);
            
            for (const sel of this.currentSite.contentSelectors) {
                const el = doc.querySelector(sel);
                console.log(`[正文] 选择器 "${sel}": ${el ? '命中' : '未命中'}`);
                if (!el) continue;
                
                // 使用innerText（浏览器渲染后的文本）或textContent（源码文本）
                const textLength = isLiveDom ? (el.innerText ? el.innerText.length : 0) : (el.textContent || '').length;
                console.log(`[正文] 容器文本长度: ${textLength}`);
                
                if (el.innerHTML) {
                    console.log(`[正文] 容器HTML预览: ${el.innerHTML.substring(0, 200)}`);
                }
                
                const text = this.extractContent(el, extractor, isLiveDom);
                console.log(`[正文] 提取结果: ${text ? text.length + '字' : '空'}`);
                
                if (text && text.length >= this.config.minTxtLength) {
                    return text;
                }
            }
            
            console.warn('[正文] 所有选择器均未提取到有效内容');
            return '';
        }
        
        extractContent(container, type, isLiveDom = false) {
            const clone = container.cloneNode(true);
            // isLiveDom=true时使用innerText（浏览器渲染后的可见文本），否则使用textContent（源码文本）
            const originalText = isLiveDom ? (container.innerText || '') : (container.textContent || '');
            console.log(`[extractContent] 提取类型: ${type}, 是否实时DOM: ${isLiveDom}, 原始文本长度: ${originalText.length}`);
            
            // 精准删除广告和无关节点（按class/id精准删除）
            const removeSelectors = [
                'script', 'style', 'noscript', 'iframe', 'svg', 'img', 'canvas', 'video', 'audio',
                '.advertisement', '.ad', '.ads', '.advert', '.AD', '.gg', '.guanggao',
                '.comment', '.comments', '.review', '.recommend', '.related',
                '.share', '.social', '.footer', '.header', '.sidebar',
                '.navigation', '.nav', '.menu', '.popup', '.modal', '.dialog',
                '.btn', '.button', '.toolbar', '.tool-bar',
                '[style*="display:none"]', '[style*="display: none"]', '[style*="visibility:hidden"]',
                '.hidden', '.hide'
            ];
            clone.querySelectorAll(removeSelectors.join(',')).forEach(n => n.remove());
            const cleanedText = isLiveDom ? (clone.innerText || '') : (clone.textContent || '');
            console.log(`[extractContent] 清理后文本长度: ${cleanedText.length}`);
            
            if (type === 'divLine') {
                return this.extractDivLine(clone, isLiveDom);
            }
            
            if (type === 'pTags') {
                return this.extractPTags(clone, isLiveDom);
            }

            if (type === 'cContent') {
                return this.extractCContent(clone, isLiveDom);
            }

            return this.extractFallback(clone, isLiveDom);
        }
        
        extractDivLine(clone, isLiveDom = false) {
            const lines = clone.querySelectorAll('div.line');
            console.log(`[divLine] div.line数量: ${lines.length}`);
            
            if (lines.length >= 1) {
                const text = Array.from(lines)
                    .map(d => isLiveDom ? (d.innerText || '').trim() : (d.textContent || '').trim())
                    .filter(Boolean)
                    .join('\n\n');
                if (text.length > 0) return text;
            }
            return '';
        }
        
        extractPTags(clone, isLiveDom = false) {
            const ps = clone.querySelectorAll('p');
            console.log(`[pTags] p标签数量: ${ps.length}`);
            
            if (ps.length > 0) {
                return Array.from(ps)
                    .map(p => isLiveDom ? (p.innerText || '').trim() : (p.textContent || '').trim())
                    .filter(Boolean)
                    .join('\n\n');
            }
            return '';
        }

        extractCContent(clone, isLiveDom = false) {
            console.log(`[cContent] 开始提取, 是否实时DOM: ${isLiveDom}`);
            console.log(`[cContent] clone的文本长度: ${isLiveDom ? (clone.innerText || '').length : (clone.textContent || '').length}`);
            
            const section = clone.querySelector('section.read-section');
            console.log(`[cContent] section.read-section: ${section ? '找到' : '未找到'}`);
            
            const h3 = clone.querySelector('h3') || (section && section.querySelector('h3'));
            console.log(`[cContent] h3标题: ${h3 ? (isLiveDom ? (h3.innerText || '').trim() : (h3.textContent || '').trim()) : '未找到'}`);
            
            const contentDiv = clone.querySelector('.content_txt') || (section && section.querySelector('.content_txt'));
            console.log(`[cContent] .content_txt: ${contentDiv ? '找到' : '未找到'}`);
            
            let result = '';

            if (h3) {
                const titleText = isLiveDom ? (h3.innerText || '').trim() : (h3.textContent || '').trim();
                result += titleText + '\n\n';
                console.log(`[cContent] 获取标题: ${titleText}`);
            }

            if (contentDiv) {
                const ps = contentDiv.querySelectorAll('p');
                console.log(`[cContent] content_txt下p标签数量: ${ps.length}`);
                
                if (ps.length > 0) {
                    const pText = Array.from(ps)
                        .map(p => {
                            const text = isLiveDom ? (p.innerText || '').trim() : (p.textContent || '').trim();
                            console.log(`[cContent] p标签内容: "${text.substring(0, 50)}..."`);
                            return text;
                        })
                        .filter(Boolean)
                        .join('\n\n');
                    result += pText;
                    console.log(`[cContent] 从p标签提取的文本长度: ${pText.length}`);
                } else {
                    console.log(`[cContent] content_txt无p标签，使用文本`);
                    result += isLiveDom ? (contentDiv.innerText || '').trim() : (contentDiv.textContent || '').trim();
                }
            } else {
                console.log(`[cContent] 未找到.content_txt，尝试回退方案`);
                const ps = clone.querySelectorAll('p');
                console.log(`[cContent] 回退模式，p标签数量: ${ps.length}`);
                
                if (ps.length > 0) {
                    result += Array.from(ps)
                        .map(p => isLiveDom ? (p.innerText || '').trim() : (p.textContent || '').trim())
                        .filter(Boolean)
                        .join('\n\n');
                } else {
                    console.log(`[cContent] 回退模式也无p标签，使用纯文本`);
                    result += isLiveDom ? (clone.innerText || '').trim() : (clone.textContent || '').trim();
                }
            }

            console.log(`[cContent] 最终结果长度: ${result.length}`);
            console.log(`[cContent] 结果预览: "${result.substring(0, 100)}..."`);
            return result;
        }

        extractFallback(clone, isLiveDom = false) {
            const fallback = isLiveDom ? (clone.innerText || '').trim() : (clone.textContent || '').trim();
            console.log(`[兜底] 纯文本长度: ${fallback.length}`);
            return fallback;
        }
        
        clean(t) {
            if (!t) return "";
            
            // 1. 删除所有\r
            let text = t.replace(/\r/g, "");
            
            // 2. 连续多个换行（≥2）替换成一个换行
            text = text.replace(/\n{2,}/g, "\n");
            
            // 3. 首尾空白全部trim
            text = text.trim();
            
            // 4. 剔除乱码和特殊字符（保留中文、英文、数字、常见标点）
            // 可选：删除"本章完"、"未完待续"等标记
            text = text.replace(/本章完/g, "").replace(/未完待续/g, "").replace(/（未完待续）/g, "");
            
            // 5. 清理多余空格（保留段落间的空行）
            text = text.replace(/[ \t]+/g, " ").trim();
            
            return text;
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
                this.currentSite = task.site;
                console.log(`[下载] 站点: ${this.currentSite.name}, 章节: ${task.title}`);
                
                const html = await this.getHtml(task.url, true, task.site);
                console.log(`[请求] ${task.title} - HTML长度:${html ? html.length : 0}`);
                
                const doc = this.parse(html);
                let content = this.clean(this.getContent(doc, false));
                
                if (!content || content.length < this.config.minTxtLength) {
                    if (window.location.href === task.url || window.location.href.includes(task.url.split('/').pop())) {
                        console.log(`[下载] 静态请求未获取到正文，尝试从当前页面DOM提取`);
                        content = this.clean(this.getContent(document, true));
                        console.log(`[下载] 从当前DOM提取的正文长度: ${content.length}`);
                    }
                }
                
                if (content.length < this.config.minTxtLength) {
                    console.warn(`内容过短: ${task.title} (${content.length} 字符)`);
                }
                
                const result = `${task.title}\n\n${content}\n\n`;
                this.config.resultMap[task.globalIndex] = result;
                this.cache.set(task.url, result);
                
            } catch (e) {
                if (e.message === 'VERIFY_DETECTED') {
                    console.warn(`⚠️ 检测到验证码，停止下载: ${task.title}`);
                    this.config.resultMap[task.globalIndex] = `${task.title}\n\n遇到验证码，下载中断\n\n`;
                    this.saveProgress();
                    this.config.cancel = true;
                    return;
                }
                
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
            console.log(`[startDownload] 开始执行, isDownloading: ${this.config.isDownloading}`);
            if (this.config.isDownloading) {
                console.log('[startDownload] 已在下载中，返回');
                return;
            }

            let tasks = this.config.chapterList;
            console.log(`[startDownload] 原始章节列表: ${tasks.length}`);
            
            if (selectedIndices && selectedIndices.length > 0) {
                tasks = tasks.filter((_, idx) => selectedIndices.includes(idx));
            }
            console.log(`[startDownload] 过滤后任务数: ${tasks.length}`);

            if (tasks.length === 0) {
                console.log('[startDownload] 没有任务，显示通知');
                this.showNotice("请先选择要下载的章节");
                return;
            }

            const hasProgress = this.config.completed > 0 && Object.keys(this.config.resultMap).length > 0;
            if (hasProgress) {
                const completedCount = this.config.completed;
                const remainingCount = tasks.length - completedCount;
                console.log(`📂 检测到下载进度: 已完成${completedCount}章，剩余${remainingCount}章`);
                this.showNotice(`恢复下载: 已完成${completedCount}章，从第${completedCount + 1}章继续`);
                tasks = tasks.slice(completedCount);
            }

            this.config.isDownloading = true;
            this.config.cancel = false;
            if (!hasProgress) {
                this.config.completed = 0;
                this.config.resultMap = {};
            }
            this.config.currentTaskCount = tasks.length + (hasProgress ? this.config.completed : 0);

            const actionBtn = this.statusPanel.querySelector(".nd-btn-action");
            const saveBtn = this.statusPanel.querySelector(".nd-btn-save");
            
            if (actionBtn) {
                actionBtn.textContent = "⏹ 停止下载";
                actionBtn.style.background = "#f44336";
            }
            if (saveBtn) saveBtn.style.display = "none";

            const isSiteC = this.currentSite && this.currentSite.hasVerify;
            const batchSize = isSiteC ? 10 : tasks.length;
            const pauseTime = isSiteC ? 30000 : 0;

            const totalTaskCount = this.config.currentTaskCount;
            console.log(`开始下载 ${tasks.length} 个章节，站点C分批模式: ${isSiteC}, 每批${batchSize}章`);
            this.updateStatus(`${this.config.completed}/${totalTaskCount}`);

            let totalIndex = 0;
            let batchCount = 0;

            while (totalIndex < tasks.length && !this.config.cancel) {
                const batchEnd = Math.min(totalIndex + batchSize, tasks.length);
                const batchTasks = tasks.slice(totalIndex, batchEnd);
                batchCount++;

                console.log(`[startDownload] 第${batchCount}批: ${totalIndex + 1}-${batchEnd}/${tasks.length}`);
                this.updateStatus(`第${batchCount}批: ${this.config.completed}/${totalTaskCount}`);

                let dlCount = 0;
                const minPerMin = this.config.maxDlPerMin;
                let batchIndex = 0;

                const scheduleNext = async (waitTime) => {
                    while (batchIndex < batchTasks.length && !this.config.cancel) {
                        const currentIndex = batchIndex++;
                        console.log(`[scheduleNext] 处理任务 ${this.config.completed + 1}/${totalTaskCount}: ${batchTasks[currentIndex].title}`);
                        
                        if (minPerMin > 0) {
                            if (dlCount >= minPerMin) {
                                console.log('[scheduleNext] 达到每分钟限制，等待60秒');
                                await this.sleep(60000);
                                dlCount = 0;
                            }
                            dlCount++;
                        }

                        await this.downloadChapter(batchTasks[currentIndex]);

                        if (waitTime > 0) {
                            await this.sleep(waitTime);
                        } else if (this.config.adaptiveDelay && this.config.delay > 0) {
                            const delay = this.config.delay + Math.random() * 200;
                            await this.sleep(delay);
                        }
                    }
                };

                const concurrency = this.config.maxConcurrency;
                if (concurrency > 0) {
                    const workers = [];
                    const workerCount = Math.min(concurrency, batchTasks.length);
                    console.log(`[startDownload] 启动 ${workerCount} 个并发 workers`);
                    
                    for (let i = 0; i < workerCount; i++) {
                        workers.push(scheduleNext(this.config.delay));
                    }
                    await Promise.all(workers);
                } else {
                    const waitTime = Math.abs(concurrency) * 1000;
                    console.log(`[startDownload] 单线程模式，间隔 ${waitTime}ms`);
                    await scheduleNext(waitTime);
                }

                totalIndex = batchEnd;

                if (!this.config.cancel) {
                    console.log('[startDownload] 保存当前批次文件');
                    this.saveFile();
                    this.updateStatus(`已保存第${batchCount}批 (${this.config.completed}/${totalTaskCount})`);

                    if (totalIndex < tasks.length && pauseTime > 0) {
                        console.log(`[startDownload] C站限制，暂停 ${pauseTime / 1000}秒后继续...`);
                        this.updateStatus(`暂停中... ${pauseTime / 1000}秒后继续下一批`);
                        await this.sleep(pauseTime);
                    }
                }
            }

            console.log(`[startDownload] 下载循环结束，cancel: ${this.config.cancel}, completed: ${this.config.completed}/${totalTaskCount}`);

            if (!this.config.cancel) {
                console.log('[startDownload] 全部完成，清理进度');
                this.clearProgress();
                console.log("✅ 全部下载完成！");
            } else {
                console.log("⚠️ 用户取消下载");
            }

            this.config.isDownloading = false;
            
            if (actionBtn) {
                actionBtn.textContent = "▶ 开始下载";
                actionBtn.style.background = "";
            }
            if (saveBtn) saveBtn.style.display = "block";
            
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
            
            let txt = `${novelName}\n\n来源: ${window.location.href}\n下载时间: ${new Date().toLocaleString()}\n\n`;
            
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
            
            const sites = [this.sites.a, this.sites.b, this.sites.c];
            
            for (const site of sites) {
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
            console.log(`[scanChaptersBySite] 站点: ${site.name}, 链接数: ${links.length}`);
            
            links.forEach((el, idx) => {
                let title = '';
                
                if (site.numSelector) {
                    const numEl = el.querySelector(site.numSelector);
                    const titleEl = el.querySelector(site.titleSelector);
                    const num = numEl ? numEl.textContent.trim() : '';
                    const titleText = titleEl ? titleEl.textContent.trim() : '';
                    title = [num, titleText].filter(Boolean).join(' ');
                } else if (site.titleSelector) {
                    const titleEl = el.querySelector(site.titleSelector);
                    title = titleEl ? titleEl.textContent.trim() : el.textContent.trim();
                } else {
                    title = el.textContent.trim();
                }
                
                console.log(`[scanChaptersBySite] 第${idx}个链接, 标题: "${title.substring(0, 30)}...", href: ${el.href}`);
                
                if (title) {
                    this.config.chapterList.push({ 
                        idx, 
                        title, 
                        url: el.href, 
                        globalIndex: idx, 
                        site 
                    });
                }
            });
            
            console.log(`[scanChaptersBySite] 原始章节数: ${this.config.chapterList.length}`);
            this.finalizeChapters(site.name);
        }
        
        finalizeChapters(siteName) {
            const beforeCount = this.config.chapterList.length;
            const seenUrls = new Set();
            
            this.config.chapterList = this.config.chapterList.filter((item) => {
                if (seenUrls.has(item.url)) {
                    console.log(`[finalizeChapters] 过滤重复URL: ${item.url}`);
                    return false;
                }
                seenUrls.add(item.url);
                
                if (item.title.length < 2) {
                    console.log(`[finalizeChapters] 过滤短标题: "${item.title}"`);
                    return false;
                }
                return true;
            });
            
            this.config.chapterList.forEach((item, i) => {
                item.globalIndex = i;
            });
            
            console.log(`📋 ${siteName}: ${beforeCount} -> ${this.config.chapterList.length} 章`);
            
            if (this.progressLabel) {
                this.progressLabel.textContent = `已扫描: ${this.config.chapterList.length} 章`;
            }
            
            this.showNotice(`✅ 检测到 ${this.config.chapterList.length} 个章节`);
        }
        
        initShadow() {
            if (this.shadowContainer) return;
            
            this.shadowContainer = document.createElement("div");
            this.shadowContainer.id = "novel-downloader-root";
            this.shadowContainer.style.cssText = "all: initial; display: block;";
            this.shadowRoot = this.shadowContainer.attachShadow({ mode: "open" });
            
            const style = document.createElement("style");
            style.textContent = this.getStyles();
            this.shadowRoot.appendChild(style);
        }
        
        getStyles() {
            return `
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
                    width: 320px;
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
                .nd-panel-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 12px;
                }
                .nd-panel-header h3 {
                    margin: 0;
                    color: #333;
                    font-size: 15px;
                    font-weight: bold;
                }
                .nd-panel-header .nd-version {
                    color: #888;
                    font-size: 11px;
                }
                .nd-close-btn {
                    width: 24px;
                    height: 24px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: #f0f0f0;
                    border: none;
                    border-radius: 50%;
                    color: #666;
                    font-size: 14px;
                    cursor: pointer;
                    transition: all 0.2s;
                    line-height: 1;
                    padding: 0;
                }
                .nd-close-btn:hover {
                    background: #e0e0e0;
                    color: #333;
                }
                .nd-status {
                    margin: 12px 0;
                    padding: 10px;
                    background: #f5f5f5;
                    border-radius: 5px;
                    text-align: center;
                }
                .nd-current-chapter {
                    margin-top: 8px;
                    font-size: 12px;
                    color: #666;
                    word-break: break-all;
                }
                .nd-actions {
                    display: flex;
                    gap: 8px;
                    margin-top: 14px;
                }
                .nd-btn-primary {
                    flex: 1;
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
                .nd-btn-primary:disabled {
                    background: #cccccc;
                    cursor: not-allowed;
                    opacity: 0.6;
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
                .nd-btn-download {
                    flex: 1;
                    padding: 10px;
                    background: #4CAF50;
                    color: white;
                    border: none;
                    border-radius: 5px;
                    cursor: pointer;
                    font-size: 13px;
                    font-weight: bold;
                }
                .nd-btn-download:hover {
                    background: #45a049;
                }
                .nd-btn-action {
                    flex: 1;
                    padding: 10px;
                    background: #4CAF50;
                    color: white;
                    border: none;
                    border-radius: 5px;
                    cursor: pointer;
                    font-size: 13px;
                    font-weight: bold;
                    transition: background 0.2s;
                }
                .nd-btn-action:hover {
                    opacity: 0.9;
                }
                .nd-notice {
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    z-index: 2147483647;
                    padding: 12px 20px;
                    background-color: #2196F3;
                    color: white;
                    border-radius: 8px;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                    font-size: 14px;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    animation: slideIn 0.3s ease;
                }
                @keyframes slideIn {
                    from {
                        transform: translateX(100%);
                        opacity: 0;
                    }
                    to {
                        transform: translateX(0);
                        opacity: 1;
                    }
                }
            `;
        }
        
        createUI() {
            this.initShadow();
            
            this.downloadBtn = document.createElement("div");
            this.downloadBtn.id = "novel-downloader-btn";
            this.downloadBtn.className = "nd-btn";
            this.downloadBtn.innerHTML = '<span class="nd-btn-text">📖 下载小说</span>';
            this.downloadBtn.onclick = () => this.transformToPanel();
            
            this.shadowRoot.appendChild(this.downloadBtn);
            document.body.appendChild(this.shadowContainer);
        }
        
        transformToPanel() {
            if (this.statusPanel) return;
            
            this.downloadBtn.className = "nd-panel";
            this.downloadBtn.innerHTML = `
                <div class="nd-panel-header">
                    <div>
                        <h3>📖 小说下载器</h3>
                        <span class="nd-version">v1.1</span>
                    </div>
                    <button class="nd-close-btn" title="隐藏面板">✕</button>
                </div>
                <div class="nd-status">
                    <div class="nd-progress-label">点击开始扫描...</div>
                    <div class="nd-current-chapter"></div>
                </div>
                <div class="nd-actions">
                    <button class="nd-btn nd-btn-action nd-btn-start">▶ 开始扫描</button>
                    <button class="nd-btn nd-btn-save" style="display:none;">💾 保存</button>
                </div>
            `;
            
            this.statusPanel = this.downloadBtn;
            this.progressLabel = this.statusPanel.querySelector(".nd-progress-label");
            this.progressCurrent = this.statusPanel.querySelector(".nd-current-chapter");
            
            const closeBtn = this.statusPanel.querySelector(".nd-close-btn");
            const actionBtn = this.statusPanel.querySelector(".nd-btn-action");
            const saveBtn = this.statusPanel.querySelector(".nd-btn-save");
            
            closeBtn.onclick = () => this.hideStatusPanel();
            actionBtn.onclick = () => {
                if (this.config.isDownloading) {
                    this.cancelDownload();
                } else {
                    this.autoScanAndShowDownload();
                }
            };
            saveBtn.onclick = () => this.saveFile();
        }
        
        autoScanAndShowDownload() {
            this.config.chapterList = [];
            this.currentSite = null;
            
            const sites = [this.sites.a, this.sites.b, this.sites.c];
            
            for (const site of sites) {
                const links = document.querySelectorAll(site.chapterSelector);
                if (links.length > 0) {
                    this.currentSite = site;
                    console.log(`📋 匹配: ${site.name} (${links.length} 章)`);
                    this.scanChaptersBySite(links, site);
                    
                    if (this.config.chapterList.length > 0) {
                        const hasProgress = this.config.completed > 0 && Object.keys(this.config.resultMap).length > 0;
                        const progressHint = hasProgress ? ` (已下载${this.config.completed}章，将自动跳过)` : '';
                        this.updateStatus(`已扫描 ${this.config.chapterList.length} 章${progressHint}，开始下载...`);
                        const actionBtn = this.statusPanel.querySelector(".nd-btn-action");
                        if (actionBtn) {
                            actionBtn.textContent = "⏹ 停止下载";
                            actionBtn.style.background = "#f44336";
                        }
                        this.showNotice(`扫描成功，共 ${this.config.chapterList.length} 章${progressHint}，开始下载`);
                        this.startDownload();
                    } else {
                        this.updateStatus("未找到章节");
                        this.showNotice("未检测到章节链接");
                    }
                    return;
                }
            }
            
            this.updateStatus("未检测到章节");
            this.showNotice("未检测到章节链接，请确保当前页面是目录页");
        }
        
        hideStatusPanel() {
            if (!this.downloadBtn) return;
            
            this.downloadBtn.className = "nd-btn";
            this.downloadBtn.innerHTML = '<span class="nd-btn-text">📖 下载小说</span>';
            this.downloadBtn.onclick = () => this.transformToPanel();
            this.downloadBtn.style.display = "block";
            
            this.statusPanel = null;
            this.progressLabel = null;
            this.progressCurrent = null;
        }
        
        updateStatus(text) {
            if (this.progressLabel) {
                this.progressLabel.textContent = text;
            }
        }
        
        updateCurrentChapter(text) {
            if (this.progressCurrent) {
                this.progressCurrent.textContent = text;
            }
        }
        
        cancelDownload() {
            this.config.cancel = true;
            this.updateStatus("正在取消...");
            console.log("用户请求取消下载");
        }
        
        showNotice(message) {
            const notice = document.createElement("div");
            notice.className = "nd-notice";
            notice.textContent = message;
            
            this.shadowRoot.appendChild(notice);
            
            setTimeout(() => {
                if (notice.parentNode) {
                    notice.parentNode.removeChild(notice);
                }
            }, 3000);
        }
        
        showSettings() {
            const currentConcurrency = this.config.maxConcurrency;
            const currentDelay = this.config.delay;
            const currentMaxDl = this.config.maxDlPerMin;
            
            const input = prompt(
                `设置参数（JSON格式）:\n` +
                `maxConcurrency: 并发数（当前: ${currentConcurrency}）\n` +
                `delay: 延迟毫秒（当前: ${currentDelay}）\n` +
                `maxDlPerMin: 每分钟最大下载数（当前: ${currentMaxDl}）\n\n` +
                `示例: {"maxConcurrency": 3, "delay": 1000, "maxDlPerMin": 30}`,
                JSON.stringify({
                    maxConcurrency: currentConcurrency,
                    delay: currentDelay,
                    maxDlPerMin: currentMaxDl
                })
            );
            
            if (input) {
                try {
                    const settings = JSON.parse(input);
                    if (settings.maxConcurrency !== undefined) this.config.maxConcurrency = settings.maxConcurrency;
                    if (settings.delay !== undefined) this.config.delay = settings.delay;
                    if (settings.maxDlPerMin !== undefined) this.config.maxDlPerMin = settings.maxDlPerMin;
                    
                    this.showNotice("设置已保存");
                    console.log("设置已更新:", settings);
                } catch (e) {
                    this.showNotice("设置格式错误");
                }
            }
        }
    }

    const downloader = new NovelDownloader();
})();