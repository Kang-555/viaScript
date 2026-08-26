// ==UserScript==
// @name       单连续下载
// @namespace    http://tampermonkey.net/
// @version      2.5
// @description  网页m3u8嗅探下载；m3u8分片直接拼接为TS文件；AES‑128解密；适配Via/Kiwi手机浏览器
// @author       You
// @license      MIT
// @match        *://*/*
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==


(function () {
    'use strict';

    // ==========================================
    // 等待body就绪工具，解决document‑start下body不存在问题
    // ==========================================
    const waitBody = () => new Promise(resolve => {
        if (document.body) return resolve(document.body);
        const observer = new MutationObserver(() => {
            if (document.body) {
                observer.disconnect();
                resolve(document.body);
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    });

    // ==========================================
    // 1. 全局配置
    // ==========================================
    const Config = {
        scanInterval: 2000,
        uiId: 'gm-sniffer-v2-ts',
        isMobile: /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent),
        maxThreads: 4,
        maxRetries: 3,
        retryDelay: 1000,
        chunkSize: 256 * 1024,
        colors: {
            primary: window.self === window.top ? '#4caf50' : '#e91e63',
            background: 'rgba(0, 0, 0, 0.85)',
            text: '#ffffff'
        }
    };

    // ==========================================
    // 2. 工具函数库
    // ==========================================
    const Utils = {
        formatBytes: (bytes) => {
            if (bytes == null || bytes <= 0) return '0 B';
            const units = ['B', 'KB', 'MB', 'GB'];
            let i = 0;
            let v = bytes;
            while (v >= 1024 && i < units.length - 1) {
                v /= 1024;
                i++;
            }
            return `${v.toFixed(v < 10 && i > 0 ? 2 : 1)} ${units[i]}`;
        },

        formatTime: (seconds) => {
            if (!isFinite(seconds) || seconds <= 0) return '--:--';
            seconds = Math.floor(seconds);
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = seconds % 60;
            const pad = (n) => n.toString().padStart(2, '0');
            return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
        },

        formatTimeInput: (seconds) => {
            const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
            const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
            const s = Math.floor(seconds % 60).toString().padStart(2, '0');
            return h + m + s;
        },

        parseTimeInput: (str) => {
            if (!str) return 0;
            const s = String(str).padStart(6, '0');
            if (s.length !== 6) return 0;
            const h = parseInt(s.substring(0, 2)) || 0;
            const m = parseInt(s.substring(2, 4)) || 0;
            const sec = parseInt(s.substring(4, 6)) || 0;
            return h * 3600 + m * 60 + sec;
        },

        request: (url, isBinary = false, onProgress = null) => {
            return new Promise((resolve, reject) => {
                let lastLoaded = 0;
                let lastTime = Date.now();
                let speed = 0;
                const xhr = GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    responseType: isBinary ? 'arraybuffer' : 'text',
                    headers: { 'Referer': location.href, 'Origin': location.origin },
                    timeout: 60000,
                    onprogress: (evt) => {
                        if (!onProgress) return;
                        const now = Date.now();
                        const delta = now - lastTime;
                        if (delta >= 200) {
                            const dl = evt.loaded - lastLoaded;
                            speed = (dl * 1000) / delta;
                            lastLoaded = evt.loaded;
                            lastTime = now;
                        }
                        onProgress(evt.loaded, evt.total, speed);
                    },
                    onload: (res) => {
                        if (res.status >= 200 && res.status < 300) {
                            if (onProgress && res.response && typeof res.response === 'object' && res.response.byteLength) {
                                try { onProgress(res.response.byteLength, res.response.byteLength, speed); } catch (e) { }
                            }
                            resolve(res.response);
                        } else reject(new Error(`HTTP Error ${res.status}`));
                    },
                    onerror: (err) => reject(err),
                    ontimeout: () => reject(new Error('Timeout'))
                });
            });
        },

        sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

        createElement: (tag, attrs = {}, children = []) => {
            const element = document.createElement(tag);
            for (const [key, value] of Object.entries(attrs)) {
                if (value === false || value === null || value === undefined) continue;
                if (key === 'style' && typeof value === 'object') Object.assign(element.style, value);
                else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.substring(2).toLowerCase(), value);
                else element.setAttribute(key, value);
            }
            const childList = Array.isArray(children) ? children : [children];
            childList.forEach(child => {
                if (child instanceof Node) element.appendChild(child);
                else if (child !== null && child !== undefined) element.appendChild(document.createTextNode(String(child)));
            });
            return element;
        },

        downloadBlob: (blob, filename) => {
            if (blob.size === 0) {
                alert('下载失败：文件大小为 0B');
                return;
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                a.remove();
                URL.revokeObjectURL(url);
            }, 30000);
        },

        getFilename: (url) => {
            const cleanUrl = url.split('?')[0];
            let name = cleanUrl.split('/').pop();
            if (!name || name.trim() === '' || name === '/') name = `video_${Date.now()}.ts`;
            return decodeURIComponent(name);
        },

        resolveUrl: (baseUrl, relativeUrl) => {
            if (relativeUrl.startsWith('http')) return relativeUrl;
            if (relativeUrl.startsWith('/')) {
                const u = new URL(baseUrl);
                return u.origin + relativeUrl;
            }
            const path = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
            return path + relativeUrl;
        },

        copyToClipboard: (text) => {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                return navigator.clipboard.writeText(text);
            }
            return new Promise((resolve, reject) => {
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                try {
                    document.execCommand('copy');
                    resolve();
                } catch (e) {
                    reject(e);
                }
                textarea.remove();
            });
        }
    };

    // ==========================================
    // 3. AES‑128解密模块
    // ==========================================
    const AESCrypto = {
        hexToBytes: (hex) => {
            if (!hex) return null;
            const cleanHex = hex.replace(/^0x/i, '');
            const bytes = new Uint8Array(cleanHex.length / 2);
            for (let i = 0; i < cleanHex.length; i += 2) {
                bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
            }
            return bytes;
        },
        sequenceToIV: (sequenceNumber) => {
            const buffer = new ArrayBuffer(16);
            const view = new DataView(buffer);
            view.setUint32(12, sequenceNumber, false);
            return new Uint8Array(buffer);
        },
        decrypt: async (data, key, iv) => {
            try {
                const algorithm = { name: 'AES-CBC', iv: iv };
                const cryptoKey = await window.crypto.subtle.importKey('raw', key, algorithm, false, ['decrypt']);
                return new Uint8Array(await window.crypto.subtle.decrypt(algorithm, cryptoKey, data));
            } catch (error) {
                console.error('[Crypto] 解密错误:', error);
                return null;
            }
        }
    };

    // ==========================================
    // 4. 事件总线
    // ==========================================
    const Bus = {
        events: {},
        on(event, callback) {
            if (!this.events[event]) this.events[event] = [];
            this.events[event].push(callback);
        },
        emit(event, data) {
            if (this.events[event]) this.events[event].forEach(cb => cb(data));
        }
    };

    // ==========================================
    // 5. 网络嗅探器
    // ==========================================
    class Sniffer {
        constructor() {
            this.seenUrls = new Set();
            this.paused = false;
            this.rules = {
                m3u8: /\.m3u8($|\?)|application\/.*mpegurl/i,
                mp4: /\.mp4($|\?)|video\/mp4/i,
                mov: /\.mov($|\?)|video\/quicktime/i
            };
        }

        start() {
            this.hookFetch();
            this.hookXHR();
            setInterval(() => this.scanPerformance(), Config.scanInterval);
        }

        pause() {
            this.paused = true;
        }

        resume() {
            this.paused = false;
        }

        detect(url, contentType = '') {
            if (!url || this.paused) return;
            if (url.match(/^data:|^blob:|\.(png|jpg|jpeg|gif|css|js|woff|svg)($|\?)/i)) return;

            const cleanKey = url.split('?')[0];
            if (this.seenUrls.has(cleanKey)) return;

            const typeStr = contentType ? contentType.toLowerCase() : '';

            for (const [type, regex] of Object.entries(this.rules)) {
                if (regex.test(url) || regex.test(typeStr)) {
                    this.seenUrls.add(cleanKey);
                    console.log(`[嗅探] 发现 ${type}: ${url}`);
                    Bus.emit('video-found', { url, type });
                    return;
                }
            }
        }

        hookFetch() {
            const targetWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            if (!targetWindow.fetch) return;
            const originalFetch = targetWindow.fetch;
            const self = this;
            targetWindow.fetch = async (...args) => {
                const url = args[0] instanceof Request ? args[0].url : args[0];
                const response = await originalFetch.apply(targetWindow, args);
                try {
                    const clone = response.clone();
                    clone.headers.forEach((val, key) => {
                        if (key.toLowerCase() === 'content-type') self.detect(url, val);
                    });
                } catch (e) { }
                return response;
            };
        }

        hookXHR() {
            const targetWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            if (!targetWindow.XMLHttpRequest) return;
            const originalXHR = targetWindow.XMLHttpRequest;
            const self = this;
            class HijackedXHR extends originalXHR {
                open(method, url, ...args) {
                    this._requestUrl = url;
                    super.open(method, url, ...args);
                }
                send(...args) {
                    this.addEventListener('readystatechange', () => {
                        if (this.readyState === 4) {
                            try {
                                const contentType = this.getResponseHeader('content-type');
                                self.detect(this.responseURL || this._requestUrl, contentType);
                            } catch (e) { }
                        }
                    });
                    super.send(...args);
                }
            }
            targetWindow.XMLHttpRequest = HijackedXHR;
        }

        scanPerformance() {
            if (!window.performance || this.paused) return;
            performance.getEntriesByType('resource').forEach(entry => this.detect(entry.name));
        }
    }

    // ==========================================
    // 6. 下载管理器
    // ==========================================
    class VideoWriter {
        constructor() {
            this.buffers = [];
            this.totalSize = 0;
        }

        async addFile(name, data) {
            const uint8 = data instanceof Uint8Array ? data : new Uint8Array(data);
            this.buffers.push(uint8);
            this.totalSize += uint8.length;
        }

        async close(filename) {
            if (this.buffers.length === 0) {
                throw new Error('下载失败：获取分片数据为空');
            }
            const tsBlob = new Blob(this.buffers, { type: 'video/mp2t' });
            Utils.downloadBlob(tsBlob, filename.replace(/\.zip$/i, '.ts'));
        }

        clear() {
            this.buffers = [];
            this.totalSize = 0;
        }
    }

    /**
     * 解析m3u8，返回 {segments, timeList, totalDuration, targetDuration}
     * timeList: [{idx, dur, tStart, tEnd}]
     */
    const parseM3u8 = async (url) => {
        let content = await Utils.request(url);
        // 处理主m3u8多码率
        if (content.includes('#EXT-X-STREAM-INF')) {
            const lines = content.split('\n');
            let bestBandwidth = 0;
            let bestUrl = null;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                    const bandwidth = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) || [0, 0])[1]);
                    const nextLine = lines[i + 1]?.trim();
                    if (nextLine && !nextLine.startsWith('#') && bandwidth > bestBandwidth) {
                        bestBandwidth = bandwidth;
                        bestUrl = Utils.resolveUrl(url, nextLine);
                    }
                }
            }
            if (bestUrl) {
                url = bestUrl;
                content = await Utils.request(url);
            }
        }

        const lines = content.split('\n');
        const segments = [];
        const timeList = [];
        let currentKey = null, currentIV = null, sequence = 0;
        let currentInf = 0;
        let timeAcc = 0;
        let targetDuration = 10;

        for (const line of lines) {
            const l = line.trim();
            if (!l) continue;
            if (l.startsWith('#EXT-X-TARGETDURATION')) {
                targetDuration = parseInt(l.split(':')[1]) || 10;
            } else if (l.startsWith('#EXT-X-KEY')) {
                const method = (l.match(/METHOD=([^,]+)/) || [])[1];
                const uri = (l.match(/URI="([^"]+)"/) || [])[1];
                const ivHex = (l.match(/IV=(0x[\da-f]+)/i) || [])[1];
                if (method === 'AES-128' && uri) {
                    currentKey = Utils.resolveUrl(url, uri);
                    currentIV = ivHex ? AESCrypto.hexToBytes(ivHex) : null;
                }
            } else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
                sequence = parseInt(l.split(':')[1]);
            } else if (l.startsWith('#EXTINF:')) {
                currentInf = parseFloat(l.match(/#EXTINF:([\d.]+)/)[1]);
            } else if (!l.startsWith('#')) {
                const segObj = {
                    url: Utils.resolveUrl(url, l),
                    key: currentKey,
                    iv: currentIV,
                    seq: sequence++,
                    dur: currentInf
                };
                segments.push(segObj);
                timeList.push({
                    idx: segments.length - 1,
                    dur: currentInf,
                    tStart: timeAcc,
                    tEnd: timeAcc + currentInf
                });
                timeAcc += currentInf;
            }
        }
        if (segments.length === 0) throw new Error('未解析到TS分片');
        return { url, segments, timeList, totalDuration: timeAcc, targetDuration };
    };

    /**
     * 根据起止秒数，换算分片下标
     */
    const timeToSegmentIndex = (timeList, beginSec, endSec) => {
        let startIdx = 0;
        let endIdx = timeList.length - 1;
        for (let i = 0; i < timeList.length; i++) {
            const item = timeList[i];
            if (item.tEnd >= beginSec) {
                startIdx = i;
                break;
            }
        }
        for (let i = timeList.length - 1; i >= 0; i--) {
            const item = timeList[i];
            if (item.tStart <= endSec) {
                endIdx = i;
                break;
            }
        }
        return { startIdx, endIdx };
    };

    const downloadM3u8BySegments = async (segments, keyCache, onProgress, writer, startIdx = null, endIdx = null) => {
        let workSegments = [...segments];
        if (Number.isInteger(startIdx) && Number.isInteger(endIdx)) {
            workSegments = workSegments.slice(startIdx, endIdx + 1);
            if (workSegments.length === 0) throw new Error("分片范围过滤后为空");
        }
        console.log('[downloadM3u8BySegments] 待下载分片数:', workSegments.length, '线程数:', Math.min(Config.maxThreads, workSegments.length));

        let nextIndex = 0;
        const results = new Array(workSegments.length);
        let completedCount = 0;
        let failCount = 0;
        let totalBytes = 0;
        let lastProgressUpdate = 0;
        const taskStartTs = Date.now();
        let lastSpeedReport = 0;
        let movingSpeed = 0;

        const updateProgress = (force = false) => {
            const now = Date.now();
            if (!force && now - lastProgressUpdate < 150) return;
            lastProgressUpdate = now;
            const elapsed = (now - taskStartTs) / 1000;
            const overallPercent = (completedCount / workSegments.length) * 100;
            const segProgress = workSegments.length > 0 ? completedCount / workSegments.length : 0;
            const etaSec = elapsed > 0 && segProgress > 0 && segProgress < 1
                ? (elapsed / segProgress) * (1 - segProgress)
                : 0;
            const speedStr = movingSpeed > 0 ? `${Utils.formatBytes(movingSpeed)}/s` : '-- KB/s';
            const failInfo = failCount > 0 ? ` [失败${failCount}]` : '';
            const text = `${overallPercent.toFixed(0)}% | ${completedCount}/${workSegments.length}分片 | ${Utils.formatBytes(totalBytes)} | ${speedStr} | ETA ${Utils.formatTime(etaSec)}${failInfo}`;
            onProgress(overallPercent, text, { completedCount, total: workSegments.length, totalBytes, speed: movingSpeed });
        };

        const worker = async () => {
            while (nextIndex < workSegments.length) {
                const index = nextIndex++;
                const segment = workSegments[index];
                let rawData = null;
                let retries = Config.maxRetries;
                let lastError = null;

                while (!rawData && retries >= 0) {
                    try {
                        let segmentLoaded = 0;
                        const data = await Utils.request(segment.url, true, (loaded, total, speed) => {
                            if (loaded > segmentLoaded) {
                                const delta = loaded - segmentLoaded;
                                segmentLoaded = loaded;
                                totalBytes += delta;
                            }
                        });
                        if (segment.key) {
                            const key = keyCache.get(segment.key);
                            if (!key) throw new Error(`密钥未找到: ${segment.key}`);
                            const iv = segment.iv || AESCrypto.sequenceToIV(segment.seq);
                            const decrypted = await AESCrypto.decrypt(data, key, iv);
                            if (!decrypted) throw new Error('AES解密失败');
                            rawData = decrypted.buffer;
                        } else {
                            rawData = data;
                        }
                    } catch (e) {
                        lastError = e;
                        retries--;
                        if (retries >= 0) {
                            const delay = Math.min(Config.retryDelay * Math.pow(2, Config.maxRetries - retries - 1), 10000);
                            console.warn(`[downloadM3u8BySegments] 分片#${segment.seq} 请求失败，剩余重试${retries}次（延时${delay}ms）:`, e.message);
                            await Utils.sleep(delay);
                        }
                    }
                }

                if (!rawData) {
                    failCount++;
                    console.error(`[downloadM3u8BySegments] 分片#${segment.seq} 最终失败，已重试${Config.maxRetries}次:`, lastError?.message || '未知错误');
                    results[index] = new Uint8Array(0);
                } else {
                    results[index] = new Uint8Array(rawData);
                }

                completedCount++;

                const now = Date.now();
                if (now - lastSpeedReport >= 500) {
                    const elapsed = (now - taskStartTs) / 1000;
                    movingSpeed = elapsed > 0 ? totalBytes / elapsed : 0;
                    lastSpeedReport = now;
                }

                updateProgress();
            }
        };

        const threads = Array(Math.min(Config.maxThreads, workSegments.length)).fill(null).map(() => worker());
        await Promise.all(threads);

        updateProgress(true);
        console.log(`[downloadM3u8BySegments] 下载完成: 成功${workSegments.length - failCount}个，失败${failCount}个，总字节${totalBytes}`);

        const segResults = [];
        for (let i = 0; i < results.length; i++) {
            if (results[i] && results[i].length > 0) {
                await writer.addFile('', results[i]);
                segResults.push({ dur: workSegments[i].dur, seq: workSegments[i].seq });
            } else {
                console.warn(`[downloadM3u8BySegments] 跳过空分片#${i}`);
            }
        }

        if (segResults.length === 0) {
            throw new Error('所有分片均下载失败');
        }
        return segResults;
    };

    const downloadMp4 = async (url, onProgress, writer) => {
        if (Config.isMobile) {
            try {
                if (confirm(`${Utils.getFilename(url)}\n是否调用浏览器自带下载器？\n(省流量、不闪退、速度快)`)) {
                    const a = document.createElement('a');
                    a.href = url;
                    const fname = Utils.getFilename(url);
                    a.download = fname.replace(/[\\/:*?"<>|]/g, '_');
                    document.body.appendChild(a);
                    a.click();
                    setTimeout(() => a.remove(), 1000);
                    onProgress(100, '调用浏览器原生下载', null);
                    return { nativeDl: true };
                }
            } catch (e) {
                console.warn('[downloadMp4] 原生下载方式失败，回退到脚本下载:', e);
            }
        }
        console.log('[downloadMp4] 开始下载:', url);
        const taskStartTs = Date.now();
        let lastProgressUpdate = 0;
        let loadedBytes = 0;
        let totalBytes = 0;
        const data = await Utils.request(url, true, (loaded, total, speed) => {
            loadedBytes = loaded;
            totalBytes = total;
            const now = Date.now();
            if (now - lastProgressUpdate < 200) return;
            lastProgressUpdate = now;
            const elapsed = (now - taskStartTs) / 1000;
            const percent = total > 0 ? (loaded / total) * 100 : 0;
            const etaSec = speed > 0 && total > 0 ? (total - loaded) / speed : 0;
            const text = `${percent.toFixed(1)}% | ${Utils.formatBytes(loaded)}${total > 0 ? '/' + Utils.formatBytes(total) : ''} | ${Utils.formatBytes(speed)}/s${etaSec > 0 ? ' | ETA ' + Utils.formatTime(etaSec) : ''}`;
            onProgress(percent, text, { totalBytes: loaded, speed });
        });
        const size = data ? (data.byteLength || data.length || 0) : 0;
        if (totalBytes === 0) totalBytes = size;
        const elapsed = (Date.now() - taskStartTs) / 1000;
        const avgSpeed = elapsed > 0 ? totalBytes / elapsed : 0;
        await writer.addFile(Utils.getFilename(url), new Uint8Array(data));
        onProgress(100, `完成 ${Utils.formatBytes(totalBytes)} | 均速 ${Utils.formatBytes(avgSpeed)}/s`, { totalBytes, speed: avgSpeed });
        console.log('[downloadMp4] 下载完成:', Utils.getFilename(url), '大小:', totalBytes);
        return { nativeDl: false };
    };

    // ==========================================
    // 6.5 通用下载任务入口
    // ==========================================
    const TaskRunner = async (url, type, onProgress, opt = {}) => {
        const safeName = (document.title || 'video').replace(/[\\/:*?"<>|]/g, ' ').trim();
        let filename = type === 'm3u8' ? safeName + '.ts' : safeName + '.mp4';
        console.log('[TaskRunner] 开始:', { url, type, opt });

        const writer = new VideoWriter();
        try {
            if (type === 'm3u8') {
                onProgress(0, '解析m3u8...', null);
                const parseResult = await parseM3u8(url);
                const { segments, timeList } = parseResult;
                console.log('[TaskRunner] 解析完成, 分片数:', segments.length);

                let startIdx = opt.startIdx ?? null;
                let endIdx = opt.endIdx ?? null;

                if (opt.beginSec !== undefined && opt.endSec !== undefined) {
                    const mapped = timeToSegmentIndex(timeList, opt.beginSec, opt.endSec);
                    startIdx = mapped.startIdx;
                    endIdx = mapped.endIdx;
                    console.log('[TaskRunner] 时间换算分片:', startIdx, '-', endIdx);
                }

                const keyCache = new Map();
                const uniqueKeys = [...new Set(segments.filter(s => s.key).map(s => s.key))];
                if (uniqueKeys.length > 0) {
                    onProgress(0, '获取加密密钥...', null);
                    for (const keyUrl of uniqueKeys) {
                        const keyData = await Utils.request(keyUrl, true);
                        keyCache.set(keyUrl, new Uint8Array(keyData));
                    }
                }
                console.log('[TaskRunner] 开始下载分片');
                await downloadM3u8BySegments(segments, keyCache, onProgress, writer, startIdx, endIdx);
                console.log('[TaskRunner] 分片下载完成');
                onProgress(100, '保存中...', null);
                console.log('[TaskRunner] 生成TS文件:', filename);
                await writer.close(filename);
                console.log('[TaskRunner] TS文件生成完成');
                onProgress(100, '下载完成', null);
            } else {
                onProgress(0, '下载中...', null);
                const dlResult = await downloadMp4(url, onProgress, writer);
                if (dlResult.nativeDl) {
                    console.log('[TaskRunner] 原生下载已触发，跳过打包');
                    return { nativeDl: true };
                }
                onProgress(100, '保存中...', null);
                console.log('[TaskRunner] 生成文件:', filename);
                await writer.close(filename);
                console.log('[TaskRunner] 文件生成完成');
                onProgress(100, '下载完成', null);
            }
            return { nativeDl: false };
        } catch (error) {
            console.error('[TaskRunner] 错误:', error);
            throw error;
        }
    };

    // ==========================================
    // 7. UI悬浮面板
    // ==========================================
    class UI {
        constructor(sniffer) {
            this.sniffer = sniffer;
            this.root = null;
            this.host = null;
            this.shadow = null;
            this.resources = [];
            this.currentPanel = 'sniffer'; // 'sniffer' | 'download'
            this.selectedResource = null;
            this.downloadState = {
                status: 'idle',
                progressText: '',
                error: null
            };
            this.inited = false;
            Bus.on('video-found', (data) => {
                this.addResource(data);
            });
        }

        async init() {
            if (this.inited) return;
            await waitBody();
            if (document.getElementById(Config.uiId)) return;

            this.host = Utils.createElement('div', {
                id: Config.uiId,
                style: { position: 'fixed', bottom: 'calc(65px + env(safe-area-inset-bottom))', left: '10px', zIndex: 999999 }
            });

            try {
                this.shadow = this.host.attachShadow({ mode: 'open' });
            } catch (e) {
                this.shadow = this.host;
            }

            const style = Utils.createElement('style');
            style.textContent = `
                :host, #${Config.uiId} { font-family: sans-serif; font-size: 11px; }
                .box {
                    width: min(320px, calc(100vw - 20px)); max-height: 240px; background: ${Config.colors.background}; color: ${Config.colors.text};
                    border: 1px solid ${Config.colors.primary}; border-radius: 6px;
                    backdrop-filter: blur(5px); display: flex; flex-direction: column;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.5);
                }
                .head {
                    padding: 6px 8px; background: rgba(255,255,255,0.08);
                    display: flex; align-items: center; justify-content: space-between;
                    border-bottom: 1px solid rgba(255,255,255,0.1);
                    font-weight: bold; color: ${Config.colors.primary};
                }
                .head-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .head-btn {
                    background: transparent; border: 1px solid ${Config.colors.primary};
                    color: ${Config.colors.primary}; padding: 2px 6px; border-radius: 3px;
                    cursor: pointer; font-size: 10px; margin-left: 4px;
                }
                .list { max-height: 220px; overflow-y: auto; padding: 4px 0; }
                .item {
                    padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.06);
                }
                .item:last-child { border-bottom: none; }
                .item-type {
                    display: inline-block; background: ${Config.colors.primary}; color: #000;
                    padding: 1px 4px; border-radius: 2px; font-weight: bold; font-size: 9px;
                    margin-right: 4px;
                }
                .item-type.mp4 { background: #2196F3; color: #fff; }
                .item-name { font-weight: bold; margin-bottom: 2px; }
                .item-info { color: #aaa; font-size: 10px; margin-bottom: 4px; }
                .item-btns { display: flex; gap: 4px; }
                .btn {
                    border: none; padding: 4px 8px; border-radius: 3px; cursor: pointer;
                    font-size: 10px; font-weight: bold;
                }
                .btn-copy { background: #555; color: white; }
                .btn-select { background: ${Config.colors.primary}; color: #000; }
                .btn-download {
                    flex: 1; background: ${Config.colors.primary}; color: #000;
                    font-weight: bold; padding: 6px 8px;
                }
                .btn-download:disabled { opacity: 0.6; cursor: not-allowed; }
                .btn-clear { background: #f44336; color: white; }
                .btn-back { background: transparent; border: 1px solid ${Config.colors.primary}; color: ${Config.colors.primary}; }
                .btn-row { display: flex; gap: 4px; margin-top: 6px; }
                .download-info {
                    margin-top: 4px; padding: 4px 6px; color: #aaa; font-size: 10px;
                    border-top: 1px solid rgba(255,255,255,0.06);
                    background: rgba(0,0,0,0.2); border-radius: 3px;
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                    min-height: 16px;
                }
                .mode-row { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
                .mode-row input[type="radio"] { margin: 0; accent-color: ${Config.colors.primary}; }
                .mode-row label { cursor: pointer; display: flex; align-items: center; gap: 2px; }
                .input-row { display: flex; gap: 4px; align-items: center; margin-bottom: 4px; }
                .input-row input {
                    flex: 1; padding: 4px 6px; border: 1px solid #333; border-radius: 3px;
                    background: #0f3460; color: #fff; font-size: 10px; min-width: 50px;
                }
                .filename-edit {
                    cursor: pointer; border-bottom: 1px dashed #aaa;
                }
                .filename-edit:hover { color: ${Config.colors.primary}; }
                .filename-input {
                    flex: 1; padding: 2px 4px; border: 1px solid ${Config.colors.primary};
                    border-radius: 3px; background: #0f3460; color: #fff; font-size: 11px;
                }
                .empty-tip { padding: 16px; text-align: center; color: #666; }
                .status-bar {
                    padding: 4px 8px; border-top: 1px solid rgba(255,255,255,0.1);
                    font-size: 10px; color: #aaa;
                }
            `;

            this.root = Utils.createElement('div', { class: 'box' });
            this.shadow.appendChild(style);
            this.shadow.appendChild(this.root);
            document.body.appendChild(this.host);

            this.inited = true;
            this.renderSnifferPanel();
        }

        addResource({ url, type }) {
            const normalizedType = type === 'm3u8' ? 'm3u8' : 'mp4';
            const exists = this.resources.some(r => r.url === url);
            if (exists) return;
            this.resources.unshift({
                url,
                type: normalizedType,
                filename: null,
                duration: null,
                segmentCount: null,
                encrypted: false,
                parseStatus: 'pending'
            });
            if (this.inited && this.currentPanel === 'sniffer') this.renderSnifferPanel();
        }

        renderSnifferPanel() {
            this.currentPanel = 'sniffer';
            this.root.innerHTML = '';

            const head = Utils.createElement('div', { class: 'head' }, [
                Utils.createElement('span', { class: 'head-title' }, '视频嗅探'),
                Utils.createElement('button', {
                    class: 'head-btn',
                    onclick: () => this.toggleSniffer()
                }, this.sniffer.paused ? '继续嗅探' : '停止嗅探')
            ]);
            this.root.appendChild(head);

            const list = Utils.createElement('div', { class: 'list' });
            if (this.resources.length === 0) {
                list.innerHTML = '<div class="empty-tip">等待嗅探视频资源...</div>';
            } else {
                this.resources.forEach((item, idx) => {
                    const itemEl = Utils.createElement('div', { class: 'item' });

                    const typeTag = Utils.createElement('span', {
                        class: 'item-type' + (item.type === 'mp4' ? ' mp4' : '')
                    }, item.type.toUpperCase());

                    const nameEl = Utils.createElement('div', { class: 'item-name' }, Utils.getFilename(item.url));

                    const infoParts = [];
                    if (item.duration !== null) infoParts.push(Utils.formatTime(item.duration));
                    if (item.segmentCount !== null) infoParts.push(item.segmentCount + '片');
                    if (item.encrypted) infoParts.push('AES');
                    else if (item.segmentCount !== null) infoParts.push('未加密');

                    const infoEl = Utils.createElement('div', { class: 'item-info' }, infoParts.join(' | '));

                    const btnsEl = Utils.createElement('div', { class: 'item-btns' }, [
                        Utils.createElement('button', {
                            class: 'btn btn-copy',
                            onclick: (e) => { e.stopPropagation(); this.copyUrl(item.url); }
                        }, '复制'),
                        Utils.createElement('button', {
                            class: 'btn btn-select',
                            onclick: (e) => { e.stopPropagation(); this.selectResource(item); }
                        }, '选择')
                    ]);

                    itemEl.appendChild(typeTag);
                    itemEl.appendChild(nameEl);
                    itemEl.appendChild(infoEl);
                    itemEl.appendChild(btnsEl);
                    list.appendChild(itemEl);

                    // 后台解析m3u8
                    if (item.type === 'm3u8' && item.parseStatus === 'pending') {
                        item.parseStatus = 'parsing';
                        this.parseResourceInfo(item);
                    }
                });
            }
            this.root.appendChild(list);

            const statusBar = Utils.createElement('div', {
                class: 'status-bar'
            }, `共${this.resources.length}个资源 | ${this.sniffer.paused ? '已停止嗅探' : '嗅探中...'}`);
            this.root.appendChild(statusBar);
        }

        async parseResourceInfo(item) {
            try {
                const parseResult = await parseM3u8(item.url);
                item.duration = parseResult.totalDuration;
                item.segmentCount = parseResult.segments.length;
                item.encrypted = parseResult.segments.some(s => s.key);
                item.parseStatus = 'done';
                if (this.currentPanel === 'sniffer') this.renderSnifferPanel();
            } catch (e) {
                console.warn('[解析失败]', item.url, e.message);
                item.parseStatus = 'error';
            }
        }

        toggleSniffer() {
            if (this.sniffer.paused) {
                this.sniffer.resume();
            } else {
                this.sniffer.pause();
            }
            if (this.currentPanel === 'sniffer') this.renderSnifferPanel();
        }

        copyUrl(url) {
            Utils.copyToClipboard(url).then(() => {
                alert('已复制链接');
            }).catch(() => {
                alert('复制失败');
            });
        }

        selectResource(item) {
            this.sniffer.pause();
            this.selectedResource = item;
            this.downloadState = {
                status: 'idle',
                progressText: '',
                error: null
            };
            this.renderDownloadPanel();
        }

        renderDownloadPanel() {
            this.currentPanel = 'download';
            this.root.innerHTML = '';
            const item = this.selectedResource;
            if (!item) return;

            const head = Utils.createElement('div', { class: 'head' }, [
                Utils.createElement('span', { class: 'head-title' }, '下载：'),
                this.renderFileName(item),
                Utils.createElement('button', {
                    class: 'head-btn',
                    onclick: () => this.renderSnifferPanel()
                }, '返回列表')
            ]);
            this.root.appendChild(head);

            const body = Utils.createElement('div', { style: 'padding: 6px 8px;' });

            // 信息行
            const infoParts = [];
            if (item.duration !== null) infoParts.push('时长: ' + Utils.formatTime(item.duration));
            if (item.segmentCount !== null) infoParts.push('分片: ' + item.segmentCount);
            if (item.encrypted) infoParts.push('AES');
            else if (item.segmentCount !== null) infoParts.push('未加密');

            if (infoParts.length > 0) {
                body.appendChild(Utils.createElement('div', {
                    style: 'color: #aaa; font-size: 10px; margin-bottom: 6px;'
                }, infoParts.join(' | ')));
            }

            // 下载范围
            if (item.type === 'm3u8') {
                body.appendChild(Utils.createElement('div', {
                    style: 'color: #aaa; font-size: 10px; margin-bottom: 4px;'
                }, '── 下载范围 ──'));

                const timeStartVal = item.duration !== null ? Utils.formatTimeInput(0) : '';
                const timeEndVal = item.duration !== null ? Utils.formatTimeInput(item.duration) : '';

                const timeModeRow = Utils.createElement('div', { class: 'mode-row' }, [
                    Utils.createElement('input', { type: 'radio', name: 'dlMode', value: 'time', id: 'modeTime', checked: 'true' }),
                    Utils.createElement('label', { for: 'modeTime' }, '时间'),
                    Utils.createElement('input', { id: 'timeStart', type: 'text', inputmode: 'numeric', pattern: '\d*', value: timeStartVal, placeholder: '000000', style: 'width: 70px;' }),
                    Utils.createElement('span', { style: 'color: #aaa;' }, '-'),
                    Utils.createElement('input', { id: 'timeEnd', type: 'text', inputmode: 'numeric', pattern: '\d*', value: timeEndVal, placeholder: '000000', style: 'width: 70px;' })
                ]);
                body.appendChild(timeModeRow);

                const segModeRow = Utils.createElement('div', { class: 'mode-row' }, [
                    Utils.createElement('input', { type: 'radio', name: 'dlMode', value: 'seg', id: 'modeSeg' }),
                    Utils.createElement('label', { for: 'modeSeg' }, '切片'),
                    Utils.createElement('input', { id: 'segStart', type: 'text', inputmode: 'numeric', pattern: '\d*', value: '0', placeholder: '起始', style: 'width: 50px;', disabled: 'true' }),
                    Utils.createElement('span', { style: 'color: #aaa;' }, '-'),
                    Utils.createElement('input', { id: 'segEnd', type: 'text', inputmode: 'numeric', pattern: '\d*', value: item.segmentCount !== null ? String(item.segmentCount - 1) : '', placeholder: '结束', style: 'width: 50px;', disabled: 'true' })
                ]);
                body.appendChild(segModeRow);

                const timeRadio = timeModeRow.querySelector('#modeTime');
                const segRadio = segModeRow.querySelector('#modeSeg');
                const handleModeSwitch = () => {
                    const isTime = timeRadio.checked;
                    timeModeRow.querySelectorAll('input[type="number"]').forEach(i => i.disabled = !isTime);
                    segModeRow.querySelectorAll('input[type="number"]').forEach(i => i.disabled = isTime);
                };
                timeRadio.onclick = handleModeSwitch;
                segRadio.onclick = handleModeSwitch;
            }

            // 按钮行
            const btnRow = Utils.createElement('div', { class: 'btn-row' });
            const clearBtn = Utils.createElement('button', { class: 'btn btn-clear' }, '清空');
            const downloadBtn = Utils.createElement('button', {
                class: 'btn btn-download',
                disabled: this.downloadState.status === 'downloading'
            }, this.getDownloadBtnText());

            clearBtn.onclick = () => this.clearDownload();
            downloadBtn.onclick = () => this.runDownload(item, downloadBtn);

            btnRow.appendChild(clearBtn);
            btnRow.appendChild(downloadBtn);
            body.appendChild(btnRow);

            // 下载进度信息
            const infoEl = Utils.createElement('div', { class: 'download-info', id: 'downloadInfo' });
            infoEl.textContent = this.getDownloadInfoHtml();
            body.appendChild(infoEl);

            this.root.appendChild(body);
        }

        renderFileName(item) {
            const filename = item.filename || document.title || 'video';
            const span = Utils.createElement('span', {
                class: 'filename-edit',
                onclick: () => this.startEditFileName(span, item)
            }, filename);
            return span;
        }

        startEditFileName(span, item) {
            const input = Utils.createElement('input', {
                class: 'filename-input',
                type: 'text',
                value: span.textContent
            });
            input.onblur = () => this.finishEditFileName(input, span, item);
            input.onkeydown = (e) => { if (e.key === 'Enter') input.blur(); };
            span.replaceWith(input);
            input.focus();
            input.select();
        }

        finishEditFileName(input, span, item) {
            item.filename = input.value || document.title;
            input.replaceWith(span);
            span.textContent = item.filename;
        }

        getDownloadBtnText() {
            switch (this.downloadState.status) {
                case 'downloading': return '下载中...';
                case 'done': return '重新下载';
                case 'error': return '重试';
                default: return '下载';
            }
        }

        getDownloadInfoHtml() {
            const ds = this.downloadState;
            if (ds.status === 'downloading') {
                return ds.progressText || '准备中...';
            } else if (ds.status === 'done') {
                return '下载完成';
            } else if (ds.status === 'error') {
                return `下载失败: ${ds.error || '未知错误'}`;
            }
            return '';
        }

        collectDownloadOpt(item) {
            const opt = {};
            const modeEl = this.root.querySelector('input[name="dlMode"]:checked');
            const mode = modeEl ? modeEl.value : 'time';

            if (mode === 'seg') {
                const segStart = this.root.querySelector('#segStart')?.value;
                const segEnd = this.root.querySelector('#segEnd')?.value;
                if (segStart !== '' && segEnd !== '') {
                    opt.startIdx = parseInt(segStart);
                    opt.endIdx = parseInt(segEnd);
                }
            } else {
                const timeStart = this.root.querySelector('#timeStart')?.value;
                const timeEnd = this.root.querySelector('#timeEnd')?.value;
                if (timeStart && timeEnd) {
                    opt.beginSec = Utils.parseTimeInput(timeStart);
                    opt.endSec = Utils.parseTimeInput(timeEnd);
                }
            }
            return opt;
        }

        clearDownload() {
            if (this.downloadState.status === 'downloading') {
                if (!confirm('确定要终止当前下载吗？')) return;
            }
            this.downloadState = {
                status: 'idle',
                progressText: '',
                error: null
            };
            this.renderDownloadPanel();
        }

        async runDownload(item, btn) {
            if (this.downloadState.status === 'downloading') return;

            const opt = item.type === 'm3u8' ? this.collectDownloadOpt(item) : {};
            console.log('[UI.runDownload] target:', item.url, 'opt:', opt);

            this.downloadState.status = 'downloading';
            btn.disabled = true;
            btn.textContent = '解析中...';

            const onProgress = (percent, text, data) => {
                this.downloadState.progressText = text;
                btn.textContent = text.length > 20 ? text.substring(0, 20) + '...' : text;
                const infoEl = this.root.querySelector('#downloadInfo');
                if (infoEl) infoEl.textContent = text;
            };

            try {
                const result = await TaskRunner(item.url, item.type, onProgress, opt);
                if (result.nativeDl) {
                    this.downloadState.status = 'done';
                    this.downloadState.progressText = '原生下载已启动';
                } else {
                    this.downloadState.status = 'done';
                    this.downloadState.progressText = '下载完成';
                }
            } catch (error) {
                console.error('[UI.runDownload] 失败:', error);
                this.downloadState.status = 'error';
                this.downloadState.error = error.message;
                alert(`下载错误: ${error.message || error}`);
            } finally {
                const currentBtn = this.root.querySelector('.btn-download');
                if (currentBtn) {
                    currentBtn.disabled = false;
                    currentBtn.textContent = this.getDownloadBtnText();
                }
                const infoEl = this.root.querySelector('#downloadInfo');
                if (infoEl) infoEl.textContent = this.getDownloadInfoHtml();
            }
        }
    }

    // 启动
    const sniffer = new Sniffer();
    sniffer.start();

    const ui = new UI(sniffer);
    ui.init();
})();