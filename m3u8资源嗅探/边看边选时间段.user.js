// ==UserScript==
// @name         m3u8可视化拖拽选段下载【最终完整版】
// @namespace    http://tampermonkey.net/
// @version      3.0-final
// @description  网页m3u8嗅探、可视化拖拽选段预览、AES-128解密、分片拼接TS、手机电脑通用
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
    // 工具扩展
    // ==========================================
    const T = {
        title: '嗅探器',
        copy: '复制',
        preview: '预览',
        download: '下载'
    };

    // 秒数转 HH:MM:SS
    function formatTimeHMS(sec) {
        if (!isFinite(sec) || sec <= 0) return '00:00:00';
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
    }

    // 加载HLS播放器
    function loadHlsScript() {
        return new Promise(resolve => {
            if (window.Hls) return resolve(window.Hls);
            const s = document.createElement('script');
            s.src = "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js";
            s.onload = () => resolve(window.Hls);
            document.head.appendChild(s);
        });
    }

    // 等待body就绪
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
    // 全局配置
    // ==========================================
    const Config = {
        scanInterval: 2000,
        uiId: 'gm-sniffer-v30-final',
        isMobile: /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent),
        maxThreads: 4,
        maxRetries: 3,
        retryDelay: 1000,
        chunkSize: 256 * 1024,
        colors: {
            primary: window.self === window.top ? '#4caf50' : '#e91e63',
            background: 'rgba(0, 0, 0, 0.9)',
            text: '#ffffff'
        }
    };

    // ==========================================
    // 工具函数库
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

        request: (url, isBinary = false, onProgress = null) => {
            return new Promise((resolve, reject) => {
                let lastLoaded = 0;
                let lastTime = Date.now();
                let speed = 0;
                GM_xmlhttpRequest({
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

        toSeconds: (s) => {
            const parts = String(s).split(':').map(Number);
            if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
            if (parts.length === 2) return parts[0] * 60 + parts[1];
            return Number(s) || 0;
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
    // AES‑128解密模块
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
    // 文件名处理
    // ==========================================
    const getSafeFileName = () => {
        let title = document.title || "video";
        return title.replace(/[\\/:*?"<>|]/g, " ").trim();
    };

    // ==========================================
    // 事件总线
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
    // 网络嗅探器
    // ==========================================
    class Sniffer {
        constructor() {
            this.seenUrls = new Set();
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

        detect(url, contentType = '') {
            if (!url) return;
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
            targetWindow.fetch = async (...args) => {
                const url = args[0] instanceof Request ? args[0].url : args[0];
                const response = await originalFetch.apply(targetWindow, args);
                try {
                    const clone = response.clone();
                    clone.headers.forEach((val, key) => {
                        if (key.toLowerCase() === 'content-type') this.detect(url, val);
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
            if (!window.performance) return;
            performance.getEntriesByType('resource').forEach(entry => this.detect(entry.name));
        }
    }

    // ==========================================
    // 文件写入器
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
                alert('下载失败：获取分片数据为空');
                return;
            }
            const tsBlob = new Blob(this.buffers, { type: 'video/mp2t' });
            Utils.downloadBlob(tsBlob, filename.replace(/\.zip$/i, '.ts'));
        }
    }

    // ==========================================
    // M3U8解析
    // ==========================================
    const parseM3u8 = async (url) => {
        let content = await Utils.request(url);
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

    // ==========================================
    // M3U8下载
    // ==========================================
    const downloadM3u8BySegments = async (segments, keyCache, onProgress, writer, startIdx = null, endIdx = null) => {
        let workSegments = [...segments];
        if (Number.isInteger(startIdx) && Number.isInteger(endIdx)) {
            workSegments = workSegments.slice(startIdx, endIdx + 1);
            if (workSegments.length === 0) throw new Error("分片范围过滤后为空");
        }

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
            const completedInfo = `${completedCount}/${workSegments.length}`;
            const failInfo = failCount > 0 ? ` [失败${failCount}]` : '';
            const text = `${overallPercent.toFixed(0)}% | ${completedInfo} 分片 | ${Utils.formatBytes(totalBytes)} | ${speedStr} | ETA ${Utils.formatTime(etaSec)}${failInfo}`;
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
                            await Utils.sleep(delay);
                        }
                    }
                }

                if (!rawData) {
                    failCount++;
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

        const segResults = [];
        for (let i = 0; i < results.length; i++) {
            if (results[i] && results[i].length > 0) {
                await writer.addFile('', results[i]);
                segResults.push({ dur: workSegments[i].dur, seq: workSegments[i].seq });
            }
        }
        if (segResults.length === 0) throw new Error('所有分片均下载失败');
        return segResults;
    };

    // ==========================================
    // MP4下载
    // ==========================================
    const downloadMp4 = async (url, onProgress, writer) => {
        if (Config.isMobile) {
            try {
                if (confirm(`${Utils.getFilename(url)}\n是否调用浏览器自带下载器？`)) {
                    const a = document.createElement('a');
                    a.href = url;
                    const fname = Utils.getFilename(url).replace(/[\\/:*?"<>|]/g, '_');
                    a.download = fname;
                    document.body.appendChild(a);
                    a.click();
                    setTimeout(() => a.remove(), 1000);
                    onProgress(100, '调用浏览器原生下载', null);
                    return { nativeDl: true };
                }
            } catch (e) { }
        }
        onProgress(0, '初始化中...', null);
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
        return { nativeDl: false };
    };

    // ==========================================
    // 下载任务入口
    // ==========================================
    window.TaskRunner = async (url, type, btn, opt = {}) => {
        const originalText = btn ? btn.textContent : '';
        const safeName = getSafeFileName();
        let filename = type === 'm3u8' ? safeName + '.ts' : safeName + '.mp4';

        const writer = new VideoWriter();
        try {
            if (type === 'm3u8') {
                if (btn) btn.textContent = '解析m3u8...';
                const parseResult = await parseM3u8(url);
                const { segments, timeList } = parseResult;

                let startIdx = opt.startIdx ?? null;
                let endIdx = opt.endIdx ?? null;

                if (opt.beginSec !== undefined && opt.endSec !== undefined) {
                    const mapped = timeToSegmentIndex(timeList, opt.beginSec, opt.endSec);
                    startIdx = mapped.startIdx;
                    endIdx = mapped.endIdx;
                }

                const keyCache = new Map();
                const uniqueKeys = [...new Set(segments.filter(s => s.key).map(s => s.key))];
                if (uniqueKeys.length > 0) {
                    if (btn) btn.textContent = '获取加密密钥...';
                    for (const keyUrl of uniqueKeys) {
                        const keyData = await Utils.request(keyUrl, true);
                        keyCache.set(keyUrl, new Uint8Array(keyData));
                    }
                }

                if (btn) btn.textContent = '分片下载中...';
                await downloadM3u8BySegments(segments, keyCache, (pct, txt) => { if (btn) btn.textContent = txt || pct + '%'; }, writer, startIdx, endIdx);

                if (btn) btn.textContent = '保存中...';
                await writer.close(filename);
                if (btn) btn.textContent = '下载完成';
            } else {
                if (btn) btn.textContent = '下载中...';
                const dlResult = await downloadMp4(url, (pct, txt) => { if (btn) btn.textContent = txt || pct + '%'; }, writer);
                if (dlResult.nativeDl) {
                    if (btn) btn.textContent = '原生下载已启动';
                    return;
                }
                if (btn) btn.textContent = '保存中...';
                await writer.close(filename);
                if (btn) btn.textContent = '下载完成';
            }
        } catch (error) {
            console.error('[TaskRunner] 错误:', error);
            if (btn) btn.textContent = '下载失败';
            alert(`下载错误: ${error.message || error}`);
            throw error;
        }
    };

    // ==========================================
    // UI主界面 + 可视化拖拽预览选段【新增核心功能】
    // ==========================================
    class UI {
        constructor() {
            this.root = null;
            this.list = null;
            this.toggleBtn = null;
            this.resources = [];
            this.openIndex = -1;
            this.inited = false;
            Bus.on('video-found', (data) => {
                this.addResource(data);
            });
        }

        // 可视化拖拽预览选段
        async openPreviewSelectSegment(resourceUrl) {
            await loadHlsScript();
            let parseResult;
            try {
                parseResult = await parseM3u8(resourceUrl);
            } catch (e) {
                alert("解析m3u8失败：" + e.message);
                return;
            }
            const { totalDuration } = parseResult;

            const wrapper = document.createElement('div');
            const shadow = wrapper.attachShadow({ mode: 'open' });
            shadow.innerHTML = `
            <style>
            *{margin:0;padding:0;box-sizing:border-box;font-family:sans-serif}
            .ov{position:fixed;inset:0;background:#000;z-index:999999;overflow-y:auto}
            .close{position:fixed;top:12px;right:12px;padding:6px 12px;background:rgba(255,255,255,0.15);backdrop-filter:blur(4px);color:#fff;border:none;border-radius:6px;z-index:10}
            video{width:100vw;height:auto;display:block}
            .editor{background:#111;color:#fff;padding:16px}
            .track{width:100%;height:8px;background:#333;border-radius:4px;position:relative;margin:10px 0}
            .fill{position:absolute;height:100%;background:#4caf50;border-radius:4px}
            .thumb{width:16px;height:16px;background:#4caf50;border-radius:50%;position:absolute;top:-4px;margin-left:-8px;cursor:grab}
            .btn{padding:8px 14px;border:none;border-radius:6px;margin:4px;font-size:13px}
            .ok{background:#4caf50;color:#000;font-weight:bold}
            .time-text{font-size:14px;margin:4px 0}
            </style>
            <div class="ov">
                <button class="close">×关闭</button>
                <video id="pv" controls autoplay playsinline></video>
                <div class="editor">
                    <div class="time-text">起始时间:<span class="t1">00:00:00</span></div>
                    <div class="track track-s"><div class="fill"></div><div class="thumb thumb-s"></div></div>
                    <div class="time-text">结束时间:<span class="t2">00:00:00</span></div>
                    <div class="track track-e"><div class="fill"></div><div class="thumb thumb-e"></div></div>
                    <div style="margin-top:12px">
                        <button class="btn ok confirm">✅ 确定并回填时间</button>
                    </div>
                </div>
            </div>
            `;
            document.body.appendChild(wrapper);
            const root = shadow;
            const video = root.querySelector("#pv");
            let hls = null;

            if (Hls.isSupported()) {
                hls = new Hls();
                hls.loadSource(resourceUrl);
                hls.attachMedia(video);
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = resourceUrl;
            }

            let localStart = 0;
            let localEnd = Math.min(60, totalDuration);
            const t1El = root.querySelector('.t1');
            const t2El = root.querySelector('.t2');

            function bindSlider(trackSel, thumbSel, isStart) {
                const track = root.querySelector(trackSel);
                const thumb = root.querySelector(thumbSel);
                const fill = track.querySelector('.fill');
                let dragging = false;
                function setByX(clientX) {
                    const rect = track.getBoundingClientRect();
                    let pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                    const sec = pct * totalDuration;
                    if (isStart) {
                        localStart = Math.min(sec, localEnd);
                        video.currentTime = localStart;
                        t1El.textContent = formatTimeHMS(localStart);
                    } else {
                        localEnd = Math.max(sec, localStart);
                        video.currentTime = localEnd;
                        t2El.textContent = formatTimeHMS(localEnd);
                    }
                    thumb.style.left = pct * 100 + '%';
                    fill.style.width = pct * 100 + '%';
                }
                const move = e => {
                    if (!dragging) return;
                    const x = e.touches ? e.touches[0].clientX : e.clientX;
                    setByX(x);
                }
                thumb.addEventListener('mousedown', () => dragging = true);
                thumb.addEventListener('touchstart', () => dragging = true, { passive: true });
                document.addEventListener('mousemove', move);
                document.addEventListener('touchmove', move, { passive: true });
                const up = () => dragging = false;
                document.addEventListener('mouseup', up);
                document.addEventListener('touchend', up);
            }
            bindSlider('.track-s', '.thumb-s', true);
            bindSlider('.track-e', '.thumb-e', false);

            const close = () => {
                if (hls) hls.destroy();
                wrapper.remove();
            }
            root.querySelector('.close').onclick = close;

            return new Promise(resolve => {
                root.querySelector('.confirm').onclick = () => {
                    close();
                    resolve({
                        startHms: formatTimeHMS(localStart),
                        endHms: formatTimeHMS(localEnd),
                        startSec: localStart,
                        endSec: localEnd
                    })
                }
            })
        }

        async init() {
            if (this.inited) return;
            await waitBody();
            if (document.getElementById(Config.uiId)) return;

            const host = Utils.createElement('div', {
                id: Config.uiId,
                style: { position: 'fixed', bottom: 'calc(20px + env(safe-area-inset-bottom))', left: '20px', zIndex: 999999 }
            });

            let shadow = null;
            try {
                shadow = host.attachShadow({ mode: 'open' });
            } catch (e) {
                shadow = host;
            }

            const style = Utils.createElement('style');
            style.textContent = `
                :host, #${Config.uiId} { font-family: sans-serif; font-size: 12px; }
                .box {
                    width: min(340px, calc(100vw - 40px)); background: ${Config.colors.background}; color: ${Config.colors.text};
                    border: 1px solid ${Config.colors.primary}; border-radius: 8px;
                    backdrop-filter: blur(5px); display: flex; flex-direction: column;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.5);
                }
                .head {
                    padding: 8px 12px; background: rgba(255,255,255,0.08);
                    display: flex; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1);
                    font-weight: bold; color: ${Config.colors.primary};
                }
                .list { max-height: 260px; overflow-y: auto; padding: 4px 0; }
                .item { border-bottom: 1px solid rgba(255,255,255,0.06); }
                .item:last-child { border-bottom: none; }
                .item-head {
                    padding: 8px 12px; cursor: pointer; display: flex; gap: 8px;
                    align-items: center; transition: background 0.15s;
                }
                .item-head:hover { background: rgba(255,255,255,0.05); }
                .tag {
                    background: ${Config.colors.primary}; color: #000;
                    padding: 2px 6px; border-radius: 3px; font-weight: bold; font-size: 10px;
                    flex-shrink: 0;
                }
                .tag.mp4 { background: #2196F3; color: #fff; }
                .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .chevron { transition: transform 0.2s; color: #888; font-size: 10px; }
                .item.open .chevron { transform: rotate(90deg); }
                .item.open .item-head { background: rgba(76,175,80,0.1); }
                .item-body {
                    display: none;
                    padding: 10px 12px;
                    background: rgba(0,0,0,0.35);
                    border-top: 1px solid rgba(255,255,255,0.08);
                }
                .item.open .item-body { display: block; }
                .section-title { font-size: 11px; color: #aaa; margin: 6px 0 4px; }
                .mode-row { display: flex; gap: 12px; margin-bottom: 6px; font-size: 11px; }
                .mode-row label { cursor: pointer; display: flex; align-items: center; gap: 4px; }
                .input-row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; flex-wrap:wrap; }
                .input-row label { min-width: 48px; color: #aaa; font-size: 11px; }
                .input-row input {
                    flex: 1; padding: 6px 8px; border: 1px solid #333; border-radius: 4px;
                    background: #0f3460; color: #fff; font-size: 11px; min-width: 60px;
                }
                button { border: none; padding: 6px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }
                .btn-primary {
                    flex: 1; background: ${Config.colors.primary}; color: #000;
                    font-weight: bold; padding: 7px 8px;
                }
                .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
                .btn-secondary { background: #2196F3; color: #fff; }
                .btn-copy { background: #555; color: white; }
                .btn-row { display: flex; gap: 6px; margin-top: 8px; flex-wrap:wrap; }
                .empty-tip { padding: 20px; text-align: center; color: #666; }
                .toggle-btn {
                    position: fixed; bottom: calc(20px + env(safe-area-inset-bottom)); left: 20px; width: 44px; height: 44px;
                    border-radius: 50%; background: ${Config.colors.primary}; color: #000;
                    display: flex; align-items: center; justify-content: center;
                    font-size: 18px; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,0.3);
                    border: none; z-index: 999998;
                }
            `;

            const head = Utils.createElement('div', { class: 'head' }, '视频嗅探下载器');
            this.list = Utils.createElement('div', { class: 'list' });
            this.root = Utils.createElement('div', { class: 'box' }, [head, this.list]);

            this.toggleBtn = Utils.createElement('button', { class: 'toggle-btn' }, 'V');
            this.toggleBtn.onclick = () => {
                const isHidden = this.root.style.display === 'none';
                this.root.style.display = isHidden ? 'flex' : 'none';
                this.toggleBtn.textContent = isHidden ? 'V' : 'X';
            };

            shadow.appendChild(style);
            shadow.appendChild(this.root);
            if (shadow !== host) shadow.appendChild(this.toggleBtn);
            else host.appendChild(this.toggleBtn);

            document.body.appendChild(host);
            this.root.style.display = 'none';
            this.inited = true;
            this.renderList();
        }

        addResource({ url, type }) {
            const normalizedType = type === 'm3u8' ? 'm3u8' : 'mp4';
            const exists = this.resources.some(r => r.url === url);
            if (exists) return;
            this.resources.unshift({ url, type: normalizedType });
            if (this.inited) this.renderList();
        }

        toggleItem(index) {
            this.openIndex = this.openIndex === index ? -1 : index;
            this.renderList();
        }

        copyUrl(url) {
            Utils.copyToClipboard(url).then(() => {
                alert('已复制链接');
            }).catch(() => {
                alert('复制失败');
            });
        }

        collectM3u8Opt(item, body) {
            const opt = {};
            const modeEl = body.querySelector('input[name="dlMode-' + item.id + '"]:checked');
            const mode = modeEl ? modeEl.value : 'time';
            if (mode === 'seg') {
                const segStart = body.querySelector('#segStart-' + item.id)?.value;
                const segEnd = body.querySelector('#segEnd-' + item.id)?.value;
                if (segStart !== '' && segEnd !== '') {
                    opt.startIdx = parseInt(segStart);
                    opt.endIdx = parseInt(segEnd);
                }
            } else {
                const timeStart = body.querySelector('#timeStart-' + item.id)?.value;
                const timeEnd = body.querySelector('#timeEnd-' + item.id)?.value;
                if (timeStart !== '' && timeEnd !== '') {
                    opt.beginSec = Utils.toSeconds(timeStart);
                    opt.endSec = Utils.toSeconds(timeEnd);
                }
            }
            return opt;
        }

        runDownload(item, body, btn) {
            const opt = item.type === 'm3u8' ? this.collectM3u8Opt(item, body) : {};
            btn.textContent = '下载中...';
            btn.disabled = true;

            window.TaskRunner(item.url, item.type, btn, opt)
                .then(() => {
                    btn.textContent = '下载完成';
                    btn.disabled = true;
                })
                .catch((e) => {
                    btn.textContent = '下载失败';
                    console.error('[UI.runDownload] 失败:', e);
                })
                .finally(() => {
                    setTimeout(() => {
                        btn.textContent = '开始下载';
                        btn.disabled = false;
                    }, 3000);
                });
        }

        renderList() {
            if (!this.inited || !this.list) return;
            this.list.innerHTML = '';
            if (this.resources.length === 0) {
                this.list.innerHTML = '<div class="empty-tip">暂无资源</div>';
                return;
            }

            this.resources.forEach((item, idx) => {
                item.id = item.id || ('r' + idx + '_' + Math.random().toString(36).slice(2, 6));
                const isOpen = this.openIndex === idx;
                const itemEl = Utils.createElement('div', { class: 'item' + (isOpen ? ' open' : '') });

                const headEl = Utils.createElement('div', { class: 'item-head', onclick: () => this.toggleItem(idx) }, [
                    Utils.createElement('span', { class: 'tag ' + item.type }, item.type.toUpperCase()),
                    Utils.createElement('span', { class: 'name', title: item.url }, Utils.getFilename(item.url)),
                    Utils.createElement('span', { class: 'chevron' }, '>')
                ]);

                itemEl.appendChild(headEl);

                if (isOpen) {
                    const bodyEl = Utils.createElement('div', { class: 'item-body' });
                    const fileNameRow = Utils.createElement('div', { style: 'margin-bottom:6px;word-break:break-all;font-size:11px;color:#aaa;' },
                        '目标：' + Utils.getFilename(item.url)
                    );
                    bodyEl.appendChild(fileNameRow);

                    const urlRow = Utils.createElement('div', { style: 'margin-bottom:8px;word-break:break-all;font-size:10px;color:#666;max-height:40px;overflow:auto;' },
                        item.url
                    );
                    bodyEl.appendChild(urlRow);

                    if (item.type === 'm3u8') {
                        bodyEl.appendChild(Utils.createElement('div', { class: 'section-title' }, '下载范围'));

                        const modeRow = Utils.createElement('div', { class: 'mode-row' }, [
                            Utils.createElement('label', {}, [
                                Utils.createElement('input', {
                                    type: 'radio',
                                    name: 'dlMode-' + item.id,
                                    value: 'time',
                                    checked: 'true'
                                }),
                                ' 时间范围'
                            ]),
                            Utils.createElement('label', {}, [
                                Utils.createElement('input', {
                                    type: 'radio',
                                    name: 'dlMode-' + item.id,
                                    value: 'seg'
                                }),
                                ' 切片范围'
                            ])
                        ]);
                        bodyEl.appendChild(modeRow);

                        const timeRow = Utils.createElement('div', { class: 'input-row time-row' }, [
                            Utils.createElement('label', {}, '时间:'),
                            Utils.createElement('input', { id: 'timeStart-' + item.id, type: 'text', value: '00:00:00', placeholder: 'HH:MM:SS' }),
                            Utils.createElement('span', {}, '-'),
                            Utils.createElement('input', { id: 'timeEnd-' + item.id, type: 'text', placeholder: 'HH:MM:SS' })
                        ]);
                        bodyEl.appendChild(timeRow);

                        const segRow = Utils.createElement('div', { class: 'input-row seg-row', style: 'display:none;' }, [
                            Utils.createElement('label', {}, '切片:'),
                            Utils.createElement('input', { id: 'segStart-' + item.id, type: 'number', min: '0', value: '0', placeholder: '起始' }),
                            Utils.createElement('span', {}, '-'),
                            Utils.createElement('input', { id: 'segEnd-' + item.id, type: 'number', min: '0', placeholder: '结束' })
                        ]);
                        bodyEl.appendChild(segRow);

                        modeRow.querySelectorAll('input[type="radio"]').forEach(radio => {
                            radio.addEventListener('change', () => {
                                const selected = radio.value;
                                timeRow.style.display = selected === 'time' ? 'flex' : 'none';
                                segRow.style.display = selected === 'seg' ? 'flex' : 'none';
                            });
                        });

                        const previewBtn = Utils.createElement('button', {
                            class: 'btn btn-secondary',
                            style: 'width:100%;margin-bottom:6px;'
                        }, '🎬 预览并选择时间段');
                        previewBtn.addEventListener('click', async () => {
                            try {
                                const result = await this.openPreviewSelectSegment(item.url);
                                if (result) {
                                    const startInput = bodyEl.querySelector('#timeStart-' + item.id);
                                    const endInput = bodyEl.querySelector('#timeEnd-' + item.id);
                                    if (startInput) startInput.value = result.startHms;
                                    if (endInput) endInput.value = result.endHms;
                                    const timeRadio = bodyEl.querySelector('input[name="dlMode-' + item.id + '"][value="time"]');
                                    if (timeRadio) {
                                        timeRadio.checked = true;
                                        timeRow.style.display = 'flex';
                                        segRow.style.display = 'none';
                                    }
                                }
                            } catch (e) {
                                console.error('预览选择失败:', e);
                            }
                        });
                        bodyEl.appendChild(previewBtn);

                        const btnRow = Utils.createElement('div', { class: 'btn-row' });
                        const copyBtn = Utils.createElement('button', { class: 'btn btn-copy' }, '复制链接');
                        copyBtn.addEventListener('click', () => this.copyUrl(item.url));
                        const downloadBtn = Utils.createElement('button', { class: 'btn btn-primary' }, '开始下载');
                        downloadBtn.addEventListener('click', () => this.runDownload(item, bodyEl, downloadBtn));
                        btnRow.appendChild(copyBtn);
                        btnRow.appendChild(downloadBtn);
                        bodyEl.appendChild(btnRow);
                    } else {
                        const btnRow = Utils.createElement('div', { class: 'btn-row' });
                        const copyBtn = Utils.createElement('button', { class: 'btn btn-copy' }, '复制链接');
                        copyBtn.addEventListener('click', () => this.copyUrl(item.url));
                        const downloadBtn = Utils.createElement('button', { class: 'btn btn-primary' }, '开始下载');
                        downloadBtn.addEventListener('click', () => this.runDownload(item, bodyEl, downloadBtn));
                        btnRow.appendChild(copyBtn);
                        btnRow.appendChild(downloadBtn);
                        bodyEl.appendChild(btnRow);
                    }
                }

                itemEl.appendChild(bodyEl);
            });
        }
    }

    const sniffer = new Sniffer();
    sniffer.start();

    const ui = new UI();
    ui.init();
})();