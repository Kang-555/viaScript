// ==UserScript==
// @name       M3U8嗅探下载器
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  网页m3u8/mp4嗅探下载；多任务队列串行调度；AES-128解密；时间/分片截取；Tab切换面板
// @author       You
// @license      MIT
// @match        *://*/*
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_abort_download
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==


(function () {
    'use strict';

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

    const IS_MOBILE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    // ==========================================
    // 1. 全局配置
    // ==========================================
    const Config = {
        scanInterval: 2000,
        uiId: 'gm-sniffer-v2-ts',
        maxThreads: IS_MOBILE ? 10 : 30,
        maxThreadsCap: IS_MOBILE ? 15 : 50,
        adaptiveThreading: true,
        maxRetries: 3,
        retryDelay: 1000,
        primaryColor: window.self === window.top ? '#4caf50' : '#e91e63'
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

        request: (url, isBinary = false, onProgress = null, cancelCheck = null) => {
            return new Promise((resolve, reject) => {
                let lastLoaded = 0;
                let lastTime = Date.now();
                let speed = 0;
                let cancelled = false;
                let xhr = null;
                let cancelTimer = null;

                if (cancelCheck) {
                    cancelTimer = setInterval(() => {
                        if (cancelCheck()) {
                            clearInterval(cancelTimer);
                            cancelled = true;
                            if (xhr) { try { xhr.abort(); } catch (e) { } }
                            reject(new Error('Cancelled'));
                        }
                    }, 100);
                }

                xhr = GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    responseType: isBinary ? 'arraybuffer' : 'text',
                    headers: { 'Referer': location.href },
                    timeout: 60000,
                    onprogress: (evt) => {
                        if (!onProgress || cancelled) return;
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
                        if (cancelled) return;
                        if (cancelTimer) { clearInterval(cancelTimer); cancelTimer = null; }
                        if (res.status >= 200 && res.status < 300) {
                            if (onProgress && res.response && typeof res.response === 'object' && res.response.byteLength) {
                                try { onProgress(res.response.byteLength, res.response.byteLength, speed); } catch (e) { }
                            }
                            resolve(res.response);
                        } else reject(new Error(`HTTP Error ${res.status}`));
                    },
                    onerror: (err) => {
                        if (cancelled) return;
                        if (cancelTimer) { clearInterval(cancelTimer); cancelTimer = null; }
                        reject(err);
                    },
                    ontimeout: () => {
                        if (cancelTimer) { clearInterval(cancelTimer); cancelTimer = null; }
                        reject(new Error('Timeout'));
                    }
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

        resolveUrl: (baseUrl, relativeUrl) => new URL(relativeUrl, baseUrl).href,

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
    // 3. AES-128解密模块
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
                mp4: /\.(mp4|mov)($|\?)|video\/(mp4|quicktime)/i
            };
        }

        start() {
            this.hookFetch();
            this.hookXHR();
            setInterval(() => this.scanPerformance(), Config.scanInterval);
        }

        pause() { this.paused = true; }
        resume() { this.paused = false; }

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
    // 6. 下载引擎 (底层，零改动)
    // ==========================================
    class VideoWriter {
        constructor() { this.buffers = []; }
        async addFile(data) {
            this.buffers.push(data instanceof Uint8Array ? data : new Uint8Array(data));
        }
        async close(filename) {
            if (this.buffers.length === 0) throw new Error('下载失败：分片数据为空');
            Utils.downloadBlob(new Blob(this.buffers, { type: 'video/mp2t' }), filename);
        }
        clear() { this.buffers = []; }
    }

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
            if (bestUrl) { url = bestUrl; content = await Utils.request(url); }
        }
        const lines = content.split('\n');
        const segments = [];
        const timeList = [];
        let currentKey = null, currentIV = null, sequence = 0;
        let currentInf = 0, timeAcc = 0, targetDuration = 10;
        for (const line of lines) {
            const l = line.trim();
            if (!l) continue;
            if (l.startsWith('#EXT-X-TARGETDURATION')) { targetDuration = parseInt(l.split(':')[1]) || 10; }
            else if (l.startsWith('#EXT-X-KEY')) {
                const method = (l.match(/METHOD=([^,]+)/) || [])[1];
                const uri = (l.match(/URI="([^"]+)"/) || [])[1];
                const ivHex = (l.match(/IV=(0x[\da-f]+)/i) || [])[1];
                if (method === 'AES-128' && uri) {
                    currentKey = Utils.resolveUrl(url, uri);
                    currentIV = ivHex ? AESCrypto.hexToBytes(ivHex) : null;
                }
            } else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE')) { sequence = parseInt(l.split(':')[1]); }
            else if (l.startsWith('#EXTINF:')) { currentInf = parseFloat(l.match(/#EXTINF:([\d.]+)/)[1]); }
            else if (!l.startsWith('#')) {
                const segObj = { url: Utils.resolveUrl(url, l), key: currentKey, iv: currentIV, seq: sequence++, dur: currentInf };
                segments.push(segObj);
                timeList.push({ idx: segments.length - 1, dur: currentInf, tStart: timeAcc, tEnd: timeAcc + currentInf });
                timeAcc += currentInf;
            }
        }
        if (segments.length === 0) throw new Error('未解析到TS分片');
        return { url, segments, timeList, totalDuration: timeAcc, targetDuration };
    };

    const timeToSegmentIndex = (timeList, beginSec, endSec) => {
        let startIdx = 0, endIdx = timeList.length - 1;
        for (let i = 0; i < timeList.length; i++) {
            if (timeList[i].tEnd >= beginSec) { startIdx = i; break; }
        }
        for (let i = timeList.length - 1; i >= 0; i--) {
            if (timeList[i].tStart <= endSec) { endIdx = i; break; }
        }
        return { startIdx, endIdx };
    };

    const downloadM3u8BySegments = async (segments, keyCache, onProgress, writer, startIdx = null, endIdx = null, cancelCheck = null) => {
        let workSegments = [...segments];
        if (Number.isInteger(startIdx) && Number.isInteger(endIdx)) {
            workSegments = workSegments.slice(startIdx, endIdx + 1);
            if (workSegments.length === 0) throw new Error("分片范围过滤后为空");
        }
        let currentThreads = Config.maxThreads;
        if (Config.adaptiveThreading && workSegments.length > 20) {
            currentThreads = Math.min(15, workSegments.length);
        }
        console.log('[downloadM3u8BySegments] 待下载分片数:', workSegments.length, '初始线程数:', currentThreads, '上限:', Config.maxThreadsCap);

        let nextIndex = 0;
        const results = new Array(workSegments.length).fill(null);
        let nextReadyIdx = 0;
        let completedCount = 0, failCount = 0, totalBytes = 0;
        let lastProgressUpdate = 0;
        const taskStartTs = Date.now();
        let lastSpeedReport = 0, movingSpeed = 0;
        let appendPromise = Promise.resolve();

        const updateProgress = (force = false) => {
            const now = Date.now();
            if (!force && now - lastProgressUpdate < 150) return;
            lastProgressUpdate = now;
            const elapsed = (now - taskStartTs) / 1000;
            const overallPercent = (completedCount / workSegments.length) * 100;
            const segProgress = workSegments.length > 0 ? completedCount / workSegments.length : 0;
            const etaSec = elapsed > 0 && segProgress > 0 && segProgress < 1
                ? (elapsed / segProgress) * (1 - segProgress) : 0;
            const speedStr = movingSpeed > 0 ? `${Utils.formatBytes(movingSpeed)}/s` : '-- KB/s';
            const failInfo = failCount > 0 ? ` [失败${failCount}]` : '';
            const text = `${overallPercent.toFixed(0)}% | ${completedCount}/${workSegments.length}分片 | ${Utils.formatBytes(totalBytes)} | ${speedStr} | ETA ${Utils.formatTime(etaSec)}${failInfo}`;
            onProgress(overallPercent, text, { completedCount, total: workSegments.length, totalBytes, speed: movingSpeed });
        };

        const worker = async () => {
            while (nextIndex < workSegments.length) {
                if (cancelCheck && cancelCheck()) break;
                const index = nextIndex++;
                const segment = workSegments[index];
                let rawData = null, retries = Config.maxRetries, lastError = null;
                while (!rawData && retries >= 0) {
                    if (cancelCheck && cancelCheck()) break;
                    try {
                        let segmentLoaded = 0;
                        const data = await Utils.request(segment.url, true, (loaded, total, speed) => {
                            if (loaded > segmentLoaded) {
                                const delta = loaded - segmentLoaded;
                                segmentLoaded = loaded;
                                totalBytes += delta;
                            }
                        }, cancelCheck);
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

                if (Config.adaptiveThreading && completedCount >= 20 && completedCount % 20 === 0) {
                    const failRate = failCount / completedCount;
                    if (failRate > 0.3 && currentThreads > 5) {
                        const drop = Math.min(5, currentThreads - 5);
                        currentThreads -= drop;
                        console.log(`[downloadM3u8BySegments] 自适应降线程: 失败率${(failRate * 100).toFixed(0)}%, ${currentThreads + drop} → ${currentThreads}`);
                    } else if (failRate < 0.1 && currentThreads < Config.maxThreadsCap) {
                        const add = Math.min(10, Config.maxThreadsCap - currentThreads);
                        if (add > 0) {
                            console.log(`[downloadM3u8BySegments] 自适应加线程: ${currentThreads} → ${currentThreads + add}`);
                            currentThreads += add;
                            activeWorkers += add;
                            for (let i = 0; i < add; i++) {
                                worker().then(onWorkerExit);
                            }
                        }
                    }
                }

                appendPromise = appendPromise.then(async () => {
                    while (nextReadyIdx < workSegments.length && results[nextReadyIdx] !== null) {
                        if (cancelCheck && cancelCheck()) return;
                        const segData = results[nextReadyIdx];
                        if (segData.length > 0) {
                            await writer.addFile(segData);
                        } else {
                            console.warn(`[downloadM3u8BySegments] 跳过空分片#${nextReadyIdx}`);
                        }
                        results[nextReadyIdx] = null;
                        nextReadyIdx++;
                    }
                });

                const now = Date.now();
                if (now - lastSpeedReport >= 500) {
                    const elapsed = (now - taskStartTs) / 1000;
                    movingSpeed = elapsed > 0 ? totalBytes / elapsed : 0;
                    lastSpeedReport = now;
                }
                updateProgress();
            }
        };

        let activeWorkers = 0;
        let allWorkersDone = null;
        const workerCompletion = new Promise(resolve => { allWorkersDone = resolve; });
        const onWorkerExit = () => { activeWorkers--; if (activeWorkers === 0) allWorkersDone(); };

        activeWorkers = Math.min(currentThreads, workSegments.length);
        for (let i = 0; i < activeWorkers; i++) {
            worker().then(onWorkerExit);
        }
        await workerCompletion;
        await appendPromise;
        if (cancelCheck && cancelCheck()) return;

        updateProgress(true);
        const successCount = workSegments.length - failCount;
        console.log(`[downloadM3u8BySegments] 下载完成: 成功${successCount}个，失败${failCount}个，总字节${totalBytes}`);

        if (successCount === 0) throw new Error('所有分片均下载失败');
        return { successCount, failCount, totalBytes };
    };

    const downloadMp4 = async (url, saveName, onProgress, cancelCheck = null) => {
        console.log('[downloadMp4] GM_download 原生下载:', url);
        const fname = (saveName || Utils.getFilename(url)).replace(/[\\/:*?"<>|]/g, '_');
        onProgress(0, '已提交浏览器下载', null);
        return new Promise((resolve, reject) => {
            const jobId = GM_download({
                url, name: fname,
                onload: () => resolve({ nativeDl: true }),
                onerror: (err) => reject(new Error(err.error || '下载失败'))
            });
            if (jobId && typeof jobId === 'number') {
                const checkCancel = setInterval(() => {
                    if (cancelCheck && cancelCheck()) {
                        clearInterval(checkCancel);
                        try { GM_abort_download(jobId); } catch (e) { }
                        reject(new Error('Cancelled'));
                    }
                }, 200);
            }
        });
    };

    const TaskRunner = async (url, type, onProgress, opt = {}, cancelCheck = null) => {
        const safeName = (document.title || 'video').replace(/[\\/:*?"<>|]/g, ' ').trim();
        const filename = type === 'm3u8' ? safeName + '.ts' : safeName + '.mp4';
        const bail = () => cancelCheck && cancelCheck() ? true : false;

        try {
            if (type === 'm3u8') {
                onProgress(0, '解析m3u8...', null);
                if (bail()) return { cancelled: true };
                const { segments, timeList } = await parseM3u8(url);

                let startIdx = opt.startIdx ?? null, endIdx = opt.endIdx ?? null;
                if (opt.beginSec !== undefined && opt.endSec !== undefined) {
                    ({ startIdx, endIdx } = timeToSegmentIndex(timeList, opt.beginSec, opt.endSec));
                }

                const keyCache = new Map();
                const uniqueKeys = [...new Set(segments.filter(s => s.key).map(s => s.key))];
                if (uniqueKeys.length > 0) {
                    onProgress(0, '获取加密密钥...', null);
                    if (bail()) return { cancelled: true };
                    const keyResults = await Promise.all(uniqueKeys.map(keyUrl =>
                        Utils.request(keyUrl, true).then(data => [keyUrl, new Uint8Array(data)])
                    ));
                    for (const [keyUrl, keyData] of keyResults) keyCache.set(keyUrl, keyData);
                }

                if (bail()) return { cancelled: true };
                const writer = new VideoWriter();
                try {
                    await downloadM3u8BySegments(segments, keyCache, onProgress, writer, startIdx, endIdx, cancelCheck);
                    if (bail()) return { cancelled: true };
                    await writer.close(filename);
                    onProgress(100, '下载完成', null);
                    return { nativeDl: false };
                } finally { writer.clear(); }
            } else {
                onProgress(0, '下载中...', null);
                if (bail()) return { cancelled: true };
                await downloadMp4(url, filename, onProgress, cancelCheck);
                onProgress(100, '下载完成', null);
                return { nativeDl: true };
            }
        } catch (error) {
            if (error.message === 'Cancelled') return { cancelled: true };
            throw error;
        }
    };

    // ==========================================
    // 7. 下载队列管理器
    // ==========================================
    class QueueManager {
        constructor() {
            this.tasks = new Map();
            this.activeId = null;
            this.isRunning = false;
            this.nextId = 1;
        }

        addTask(item, opt) {
            const taskId = this.nextId++;
            const task = {
                id: taskId,
                item: { ...item },
                opt: { ...opt },
                status: 'waiting',
                progress: { percent: 0, text: '', completedCount: 0, totalBytes: 0, speed: 0 },
                cancelFlag: false,
                error: null
            };
            this.tasks.set(taskId, task);
            Bus.emit('queue:task-added', task);
            this.schedule();
            return taskId;
        }

        schedule() {
            if (this.isRunning) return;
            if (this.activeId !== null) return;
            const next = this.findNextWaiting();
            if (!next) return;

            this.isRunning = true;
            this.activeId = next.id;
            next.status = 'downloading';
            Bus.emit('queue:task-start', next);

            this.runTask(next).finally(() => {
                this.activeId = null;
                this.isRunning = false;
                this.schedule();
            });
        }

        findNextWaiting() {
            for (const t of this.tasks.values()) {
                if (t.status === 'waiting') return t;
            }
            return null;
        }

        async runTask(task) {
            try {
                const saveName = task.item.filename || document.title || 'video';
                task.item.filename = saveName;
                const result = await TaskRunner(
                    task.item.url,
                    task.item.type,
                    (percent, text, data) => {
                        task.progress.percent = percent;
                        task.progress.text = text;
                        Object.assign(task.progress, data || {});
                        Bus.emit('queue:task-progress', task);
                    },
                    task.opt,
                    () => task.cancelFlag
                );
                if (result && result.cancelled) {
                    task.status = 'cancelled';
                    Bus.emit('queue:task-cancelled', task);
                } else {
                    task.status = 'done';
                    Bus.emit('queue:task-done', task);
                }
            } catch (err) {
                if (task.cancelFlag) {
                    task.status = 'cancelled';
                    Bus.emit('queue:task-cancelled', task);
                } else {
                    task.status = 'error';
                    task.error = err.message;
                    Bus.emit('queue:task-error', task);
                }
            }
        }

        cancelTask(taskId) {
            const task = this.tasks.get(taskId);
            if (!task) return;
            task.cancelFlag = true;
            if (task.status === 'waiting') {
                task.status = 'cancelled';
                Bus.emit('queue:task-cancelled', task);
            }
        }

        removeTask(taskId) {
            this.tasks.delete(taskId);
            Bus.emit('queue:task-removed', taskId);
        }

        clearCompleted() {
            for (const [id, t] of this.tasks) {
                if (t.status === 'done' || t.status === 'error' || t.status === 'cancelled') {
                    this.tasks.delete(id);
                    Bus.emit('queue:task-removed', id);
                }
            }
        }

        get counts() {
            let downloading = 0, waiting = 0;
            for (const t of this.tasks.values()) {
                if (t.status === 'downloading') downloading++;
                else if (t.status === 'waiting') waiting++;
            }
            return { downloading, waiting, total: this.tasks.size };
        }
    }

    // ==========================================
    // 8. UIProxy (UI 内部类，管理单任务 DOM)
    // ==========================================
    class UIProxy {
        constructor(taskId, rowEl, statusEl, timeEl, infoEl, btnsEl, queueRef) {
            this.taskId = taskId;
            this.rowEl = rowEl;
            this.statusEl = statusEl;
            this.timeEl = timeEl;
            this.infoEl = infoEl;
            this.btnsEl = btnsEl;
            this.queue = queueRef;
        }

        formatTimeRange(task) {
            const opt = task.opt || {};
            const item = task.item || {};
            if (item.type !== 'm3u8') return '';
            if (opt.beginSec !== undefined && opt.endSec !== undefined) {
                return `${Utils.formatTime(opt.beginSec)} - ${Utils.formatTime(opt.endSec)}`;
            }
            if (item.duration) return Utils.formatTime(item.duration);
            return '';
        }

        updateProgress(task) {
            const p = task.progress;
            if (task.item.type === 'm3u8') {
                const segPart = `${p.completedCount}/${p.total ?? '?'}分片`;
                const bytesPart = p.totalBytes ? Utils.formatBytes(p.totalBytes) : '';
                this.infoEl.textContent = [segPart, bytesPart].filter(Boolean).join(' | ');
            } else {
                this.infoEl.textContent = p.text || '';
            }
        }

        updateStatus(task) {
            const s = task.status;
            this.statusEl.className = 'q-status q-status-' + s;
            const labelMap = { waiting: '等待中', downloading: '下载中', done: '完成', error: '失败', cancelled: '已取消' };
            this.statusEl.textContent = labelMap[s] || s;
            this.timeEl.textContent = this.formatTimeRange(task);

            this.btnsEl.innerHTML = '';
            if (s === 'waiting' || s === 'downloading') {
                this.btnsEl.appendChild(Utils.createElement('button', {
                    class: 'btn btn-cancel',
                    onclick: () => this.queue.cancelTask(this.taskId)
                }, '取消'));
            } else {
                this.btnsEl.appendChild(Utils.createElement('button', {
                    class: 'btn btn-remove',
                    onclick: () => this.queue.removeTask(this.taskId)
                }, '移除'));
            }

            if (s === 'waiting') this.infoEl.textContent = '等待中...';
            else if (s === 'cancelled') this.infoEl.textContent = '已取消';
            else if (s === 'error') this.infoEl.textContent = '错误: ' + (task.error || '未知');
            else if (s === 'done') this.infoEl.textContent = this.infoEl.textContent || '下载完成';
        }

        destroy() {
            this.rowEl.remove();
        }
    }

    // ==========================================
    // 9. UI 主类 (Tab 面板)
    // ==========================================
    class UI {
        constructor(sniffer) {
            this.sniffer = sniffer;
            this.queue = new QueueManager();
            this.resources = [];
            this.settingItem = null;
            this.currentTab = 'sniffer';
            this.addBtnFeedbackTimer = null;
            this.inited = false;

            this.$ = {
                host: null, shadow: null, root: null,
                tabHeader: null, tabBody: null,
                panelSniffer: null, panelSetting: null, panelQueue: null
            };

            const ui = this;

            this.snifferTab = {
                dom: { listEl: null, emptyTip: null, statusBar: null, topBtn: null },
                resourceDomMap: new Map(),

                ensurePanel() {
                    const p = ui.$.panelSniffer;
                    if (this.dom.listEl) return;

                    const topBar = Utils.createElement('div', {
                        class: 'queue-header-bar', style: 'justify-content:flex-end;'
                    }, [
                        Utils.createElement('button', { class: 'head-btn' }, ui.sniffer.paused ? '继续嗅探' : '停止嗅探')
                    ]);
                    p.appendChild(topBar);
                    this.dom.topBtn = topBar.querySelector('.head-btn');

                    this.dom.listEl = Utils.createElement('div', { class: 'sniffer-list' });
                    this.dom.emptyTip = Utils.createElement('div', { class: 'empty-tip' }, '等待嗅探视频资源...');
                    this.dom.listEl.appendChild(this.dom.emptyTip);
                    p.appendChild(this.dom.listEl);

                    this.dom.statusBar = Utils.createElement('div', { class: 'sniffer-status' }, '');
                    p.appendChild(this.dom.statusBar);

                    this.dom.listEl.addEventListener('click', (e) => {
                        const btn = e.target.closest('button');
                        if (!btn) return;
                        const row = btn.closest('.sniffer-item');
                        if (!row) return;
                        const item = ui.resources.find(r => r.url === row.dataset.rid);
                        if (!item) return;
                        if (btn.classList.contains('btn-copy')) {
                            Utils.copyToClipboard(item.url).then(() => alert('已复制')).catch(() => alert('复制失败'));
                        } else if (btn.classList.contains('btn-select')) {
                            ui.selectResource(item);
                        }
                    });
                    this.dom.topBtn.addEventListener('click', () => {
                        ui.sniffer.paused ? ui.sniffer.resume() : ui.sniffer.pause();
                        this.dom.topBtn.textContent = ui.sniffer.paused ? '继续嗅探' : '停止嗅探';
                        this.updateStatus();
                    });

                    for (const item of ui.resources) {
                        this.dom.listEl.appendChild(this.createRow(item));
                    }
                    this.dom.emptyTip.style.display = ui.resources.length ? 'none' : 'block';
                    this.updateStatus();
                },

                render() {
                    this.ensurePanel();
                    this.dom.topBtn.textContent = ui.sniffer.paused ? '继续嗅探' : '停止嗅探';
                    this.updateStatus();
                },

                createRow(item) {
                    const row = Utils.createElement('div', { class: 'sniffer-item' });
                    row.appendChild(Utils.createElement('span', {
                        class: 'item-type' + (item.type === 'mp4' ? ' mp4' : '')
                    }, item.type.toUpperCase()));
                    row.appendChild(Utils.createElement('div', { class: 'item-name' }, Utils.getFilename(item.url)));
                    row.appendChild(Utils.createElement('div', { class: 'item-info' }, ''));
                    row.appendChild(Utils.createElement('div', { class: 'item-btns' }, [
                        Utils.createElement('button', { class: 'btn btn-copy' }, '复制'),
                        Utils.createElement('button', { class: 'btn btn-select' }, '选择')
                    ]));
                    row.dataset.rid = item.url;
                    this.resourceDomMap.set(item, row);
                    this.updateRow(row, item);
                    return row;
                },

                updateRow(rowEl, item) {
                    const parts = [];
                    if (item.duration !== null) parts.push(Utils.formatTime(item.duration));
                    if (item.segmentCount !== null) parts.push(item.segmentCount + '片');
                    if (item.encrypted) parts.push('AES');
                    else if (item.segmentCount !== null) parts.push('未加密');
                    rowEl.querySelector('.item-info').textContent = parts.join(' | ');
                },

                updateStatus() {
                    if (!this.dom.statusBar) return;
                    this.dom.statusBar.textContent =
                        `共${ui.resources.length}个资源 | ${ui.sniffer.paused ? '已停止嗅探' : '嗅探中...'}`;
                },

                addResource({ url, type }) {
                    const normalizedType = type === 'm3u8' ? 'm3u8' : 'mp4';
                    const item = {
                        url, type: normalizedType,
                        filename: null, duration: null, segmentCount: null,
                        encrypted: false, parseStatus: 'pending'
                    };
                    ui.resources.unshift(item);
                    if (this.dom.listEl) {
                        this.dom.emptyTip.style.display = 'none';
                        this.dom.listEl.prepend(this.createRow(item));
                        if (item.type === 'm3u8') {
                            item.parseStatus = 'parsing';
                            ui.parseResourceInfo(item);
                        }
                        this.updateStatus();
                    } else {
                        this.ensurePanel();
                    }
                }
            };

            this.setting = {
                dom: {
                    root: null, filenameEl: null, infoEl: null, m3u8Wrap: null,
                    modeTime: null, modeSeg: null,
                    timeStart: null, timeEnd: null, segStart: null, segEnd: null
                },

                ensurePanel() {
                    const p = ui.$.panelSetting;
                    if (this.dom.root) return;

                    const body = Utils.createElement('div', { class: 'setting-body' });

                    this.dom.filenameEl = Utils.createElement('div', { class: 'filename-edit' }, '');
                    body.appendChild(this.dom.filenameEl);

                    this.dom.infoEl = Utils.createElement('div', { class: 'setting-info' }, '');
                    body.appendChild(this.dom.infoEl);

                    const m3u8Wrap = Utils.createElement('div', { class: 'setting-m3u8' });
                    m3u8Wrap.appendChild(Utils.createElement('div', { class: 'setting-info', style: 'margin-top:6px;' }, '── 下载范围 ──'));

                    const timeRow = Utils.createElement('div', { class: 'mode-row' }, [
                        Utils.createElement('input', { type: 'radio', name: 'dlMode', value: 'time', id: 'modeTime', checked: 'true' }),
                        Utils.createElement('label', { for: 'modeTime' }, '时间'),
                        Utils.createElement('input', { id: 'timeStart', type: 'text', inputmode: 'numeric', pattern: '\\d*', placeholder: '000000', style: 'width:70px;' }),
                        Utils.createElement('span', { style: 'color:#aaa;' }, '-'),
                        Utils.createElement('input', { id: 'timeEnd', type: 'text', inputmode: 'numeric', pattern: '\\d*', placeholder: '000000', style: 'width:70px;' })
                    ]);
                    m3u8Wrap.appendChild(timeRow);

                    const segRow = Utils.createElement('div', { class: 'mode-row' }, [
                        Utils.createElement('input', { type: 'radio', name: 'dlMode', value: 'seg', id: 'modeSeg' }),
                        Utils.createElement('label', { for: 'modeSeg' }, '切片'),
                        Utils.createElement('input', { id: 'segStart', type: 'text', inputmode: 'numeric', pattern: '\\d*', value: '0', placeholder: '起始', style: 'width:50px;', disabled: 'true' }),
                        Utils.createElement('span', { style: 'color:#aaa;' }, '-'),
                        Utils.createElement('input', { id: 'segEnd', type: 'text', inputmode: 'numeric', pattern: '\\d*', placeholder: '结束', style: 'width:50px;', disabled: 'true' })
                    ]);
                    m3u8Wrap.appendChild(segRow);

                    this.dom.modeTime = timeRow.querySelector('#modeTime');
                    this.dom.modeSeg = segRow.querySelector('#modeSeg');
                    this.dom.timeStart = timeRow.querySelector('#timeStart');
                    this.dom.timeEnd = timeRow.querySelector('#timeEnd');
                    this.dom.segStart = segRow.querySelector('#segStart');
                    this.dom.segEnd = segRow.querySelector('#segEnd');

                    const handleModeSwitch = () => {
                        const isTime = this.dom.modeTime.checked;
                        [this.dom.timeStart, this.dom.timeEnd].forEach(i => i.disabled = !isTime);
                        [this.dom.segStart, this.dom.segEnd].forEach(i => i.disabled = isTime);
                    };
                    this.dom.modeTime.onclick = handleModeSwitch;
                    this.dom.modeSeg.onclick = handleModeSwitch;

                    body.appendChild(m3u8Wrap);

                    const btnRow = Utils.createElement('div', { class: 'btn-row' });
                    const addBtn = Utils.createElement('button', { class: 'btn-queue-add' }, '加入下载队列');
                    addBtn.onclick = () => this.addToQueue(addBtn);
                    btnRow.appendChild(addBtn);
                    btnRow.appendChild(Utils.createElement('button', { class: 'btn-back-sniff', onclick: () => ui.switchTab('sniffer') }, '返回嗅探'));
                    body.appendChild(btnRow);

                    p.appendChild(body);
                    this.dom.root = body;
                    this.dom.m3u8Wrap = m3u8Wrap;
                },

                render() {
                    this.ensurePanel();
                    const p = ui.$.panelSetting;
                    if (!ui.settingItem) {
                        p.innerHTML = '<div class="empty-tip">请先在嗅探面板选择一个资源</div>';
                        this.dom.root.style.display = 'none';
                        return;
                    }
                    if (p.querySelector('.empty-tip')) p.innerHTML = '';
                    this.dom.root.style.display = '';

                    const item = ui.settingItem;
                    this.dom.filenameEl.textContent = item.filename || Utils.getFilename(item.url);

                    const infoParts = [];
                    infoParts.push(item.type === 'm3u8' ? '类型: M3U8' : '类型: MP4');
                    if (item.duration !== null) infoParts.push('时长: ' + Utils.formatTime(item.duration));
                    if (item.segmentCount !== null) infoParts.push('分片: ' + item.segmentCount);
                    if (item.encrypted) infoParts.push('AES加密');
                    else if (item.segmentCount !== null) infoParts.push('未加密');
                    this.dom.infoEl.textContent = infoParts.join(' | ');

                    const isM3u8 = item.type === 'm3u8';
                    this.dom.m3u8Wrap.style.display = isM3u8 ? '' : 'none';
                    if (isM3u8) {
                        const ts = item.duration !== null ? Utils.formatTimeInput(0) : '';
                        const te = item.duration !== null ? Utils.formatTimeInput(item.duration) : '';
                        this.dom.timeStart.value = ts;
                        this.dom.timeEnd.value = te;
                        this.dom.segStart.value = '0';
                        this.dom.segEnd.value = item.segmentCount !== null ? String(item.segmentCount - 1) : '';
                        this.dom.modeTime.checked = true;
                        this.dom.modeTime.onclick?.();
                    }

                    this.bindFilenameEdit(this.dom.filenameEl, item);
                },

                bindFilenameEdit(nameSpan, item) {
                    if (!nameSpan || nameSpan.classList.contains('filename-input')) return;
                    nameSpan.onclick = () => {
                        const input = document.createElement('textarea');
                        input.className = 'filename-input';
                        input.value = item.filename || Utils.getFilename(item.url);
                        input.rows = 1;
                        input.addEventListener('input', () => {
                            input.style.height = 'auto';
                            input.style.height = input.scrollHeight + 'px';
                        });
                        input.onkeydown = (e) => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); input.blur(); }
                        };
                        input.onblur = () => {
                            item.filename = input.value.trim() || Utils.getFilename(item.url);
                            nameSpan.textContent = item.filename;
                            input.replaceWith(nameSpan);
                            this.dom.filenameEl = nameSpan;
                        };
                        nameSpan.replaceWith(input);
                        this.dom.filenameEl = input;
                        input.focus(); input.select();
                        input.style.height = 'auto';
                        input.style.height = input.scrollHeight + 'px';
                    };
                },

                collectOpt() {
                    const opt = {};
                    const modeEl = this.dom.root?.querySelector('input[name="dlMode"]:checked');
                    const mode = modeEl ? modeEl.value : 'time';
                    if (mode === 'seg') {
                        const segStart = this.dom.segStart?.value;
                        const segEnd = this.dom.segEnd?.value;
                        if (segStart !== '' && segEnd !== '') {
                            opt.startIdx = parseInt(segStart);
                            opt.endIdx = parseInt(segEnd);
                        }
                    } else {
                        const timeStart = this.dom.timeStart?.value;
                        const timeEnd = this.dom.timeEnd?.value;
                        if (timeStart && timeEnd) {
                            opt.beginSec = Utils.parseTimeInput(timeStart);
                            opt.endSec = Utils.parseTimeInput(timeEnd);
                        }
                    }
                    return opt;
                },

                addToQueue(btn) {
                    const item = ui.settingItem;
                    if (!item) return;
                    const opt = item.type === 'm3u8' ? this.collectOpt() : {};
                    console.log('[UI] 入队:', { url: item.url, type: item.type, opt });
                    const taskId = ui.queue.addTask(item, opt);
                    btn.textContent = `已入队 #${taskId}`;
                    btn.disabled = true;
                    if (ui.addBtnFeedbackTimer) clearTimeout(ui.addBtnFeedbackTimer);
                    ui.addBtnFeedbackTimer = setTimeout(() => {
                        btn.textContent = '加入下载队列';
                        btn.disabled = false;
                    }, 1500);
                }
            };

            this.queueUI = {
                dom: { listEl: null, headerSpan: null },
                proxies: new Map(),

                ensurePanel() {
                    const p = ui.$.panelQueue;
                    if (this.dom.listEl) return;

                    const headerBar = Utils.createElement('div', { class: 'queue-header-bar' }, [
                        Utils.createElement('span', {}),
                        Utils.createElement('button', {
                            class: 'btn btn-clear-all',
                            onclick: () => {
                                ui.queue.clearCompleted();
                                this.render();
                            }
                        }, '全部移除')
                    ]);
                    this.dom.headerSpan = headerBar.querySelector('span');
                    p.appendChild(headerBar);

                    this.dom.listEl = Utils.createElement('div', { class: 'queue-list' });
                    p.appendChild(this.dom.listEl);
                },

                render() {
                    this.ensurePanel();
                    const existingIds = new Set([...this.dom.listEl.querySelectorAll('.queue-row')].map(r => +r.dataset.tid));
                    const allTasks = [...ui.queue.tasks.values()].sort((a, b) => a.id - b.id);

                    for (const task of allTasks) {
                        if (!existingIds.has(task.id)) {
                            this.createRow(task);
                        } else if (!this.proxies.has(task.id)) {
                            const rowEl = this.dom.listEl.querySelector(`.queue-row[data-tid="${task.id}"]`);
                            if (rowEl) this.rebindRow(task, rowEl);
                        }
                    }
                    if (allTasks.length === 0) {
                        if (!this.dom.listEl.querySelector('.empty-tip')) {
                            this.dom.listEl.innerHTML = '<div class="empty-tip">队列为空</div>';
                        }
                    } else {
                        const tip = this.dom.listEl.querySelector('.empty-tip');
                        if (tip) tip.remove();
                    }
                    this.updateHeader();
                },

                updateHeader() {
                    if (!this.dom.headerSpan) return;
                    this.dom.headerSpan.textContent =
                        `队列: ${ui.queue.counts.total} | 下载中 ${ui.queue.counts.downloading} | 等待 ${ui.queue.counts.waiting}`;
                },

                createRow(task) {
                    const rowEl = Utils.createElement('div', { class: 'queue-row' });
                    rowEl.dataset.tid = task.id;
                    const nameEl = Utils.createElement('span', { class: 'queue-row-name' }, task.item.filename || Utils.getFilename(task.item.url));
                    const statusEl = Utils.createElement('span', { class: 'q-status q-status-' + task.status });
                    const timeEl = Utils.createElement('span', { class: 'queue-row-time' });
                    const infoEl = Utils.createElement('span', { class: 'queue-row-info' });
                    const btnsEl = Utils.createElement('span', { class: 'queue-row-inline' });

                    rowEl.appendChild(Utils.createElement('div', { class: 'queue-row-head' }, [nameEl, statusEl]));
                    rowEl.appendChild(Utils.createElement('div', { class: 'queue-row-foot' }, [timeEl, infoEl, btnsEl]));
                    this.dom.listEl.appendChild(rowEl);

                    const proxy = new UIProxy(task.id, rowEl, statusEl, timeEl, infoEl, btnsEl, ui.queue);
                    proxy.updateStatus(task);
                    if (task.progress.text) proxy.updateProgress(task);
                    this.proxies.set(task.id, proxy);
                },

                rebindRow(task, rowEl) {
                    const statusEl = rowEl.querySelector('.q-status');
                    const timeEl = rowEl.querySelector('.queue-row-time');
                    const infoEl = rowEl.querySelector('.queue-row-info');
                    const btnsEl = rowEl.querySelector('.queue-row-inline');
                    const proxy = new UIProxy(task.id, rowEl, statusEl, timeEl, infoEl, btnsEl, ui.queue);
                    proxy.updateStatus(task);
                    if (task.progress.text) proxy.updateProgress(task);
                    this.proxies.set(task.id, proxy);
                },

                onAdded(task) {
                    if (!this.dom.listEl) { this.ensurePanel(); this.render(); return; }
                    if (!this.dom.listEl.querySelector(`.queue-row[data-tid="${task.id}"]`)) {
                        this.createRow(task);
                        const tip = this.dom.listEl.querySelector('.empty-tip');
                        if (tip) tip.remove();
                    }
                    this.updateHeader();
                },

                onStatus(task) {
                    const proxy = this.proxies.get(task.id);
                    if (proxy) proxy.updateStatus(task);
                    this.updateHeader();
                },

                onProgress(task) {
                    const proxy = this.proxies.get(task.id);
                    if (proxy) proxy.updateProgress(task);
                },

                onRemoved(taskId) {
                    const proxy = this.proxies.get(taskId);
                    if (proxy) {
                        proxy.destroy();
                        this.proxies.delete(taskId);
                    }
                    const row = this.dom.listEl?.querySelector(`.queue-row[data-tid="${taskId}"]`);
                    if (row) row.remove();
                    this.updateHeader();
                }
            };

            Bus.on('video-found', d => this.snifferTab.addResource(d));
            Bus.on('queue:task-added', t => this.queueUI.onAdded(t));
            Bus.on('queue:task-start', t => this.queueUI.onStatus(t));
            Bus.on('queue:task-progress', t => this.queueUI.onProgress(t));
            Bus.on('queue:task-done', t => this.queueUI.onStatus(t));
            Bus.on('queue:task-error', t => this.queueUI.onStatus(t));
            Bus.on('queue:task-cancelled', t => this.queueUI.onStatus(t));
            Bus.on('queue:task-removed', id => this.queueUI.onRemoved(id));
        }

        async init() {
            if (this.inited) return;
            await waitBody();
            if (document.getElementById(Config.uiId)) return;

            const host = Utils.createElement('div', {
                id: Config.uiId,
                style: { position: 'fixed', bottom: 'calc(3px + env(safe-area-inset-bottom))', left: '10px', zIndex: 999999 }
            });
            this.$.host = host;

            try {
                this.$.shadow = host.attachShadow({ mode: 'open' });
            } catch (e) {
                this.$.shadow = host;
            }

            const style = Utils.createElement('style');
            style.textContent = this.buildStyles();
            this.$.shadow.appendChild(style);

            this.$.root = Utils.createElement('div', { class: 'main-panel' });

            this.$.tabHeader = Utils.createElement('div', { class: 'tab-header' }, [
                Utils.createElement('button', { class: 'tab-btn active', 'data-tab': 'sniffer' }, '嗅探资源'),
                Utils.createElement('button', { class: 'tab-btn', 'data-tab': 'download-setting' }, '下载配置'),
                Utils.createElement('button', { class: 'tab-btn', 'data-tab': 'queue' }, '下载队列'),
                Utils.createElement('span', { class: 'close-btn', title: '收起' }, '×')
            ]);
            this.$.tabHeader.querySelectorAll('.tab-btn').forEach(btn => {
                btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
            });
            this.$.tabHeader.querySelector('.close-btn').addEventListener('click', () => {
                host.style.display = (host.style.display === 'none') ? '' : 'none';
            });
            this.$.root.appendChild(this.$.tabHeader);

            this.$.tabBody = Utils.createElement('div', { class: 'tab-body' });
            this.$.panelSniffer = Utils.createElement('div', { class: 'tab-panel active', 'data-panel': 'sniffer' });
            this.$.panelSetting = Utils.createElement('div', { class: 'tab-panel', 'data-panel': 'download-setting' });
            this.$.panelQueue = Utils.createElement('div', { class: 'tab-panel', 'data-panel': 'queue' });
            this.$.tabBody.appendChild(this.$.panelSniffer);
            this.$.tabBody.appendChild(this.$.panelSetting);
            this.$.tabBody.appendChild(this.$.panelQueue);
            this.$.root.appendChild(this.$.tabBody);

            this.$.shadow.appendChild(this.$.root);
            document.body.appendChild(host);

            this.inited = true;
            this.snifferTab.ensurePanel();
        }

        buildStyles() {
            const p = Config.primaryColor;
            return `
                :host, #${Config.uiId} {
                    --p: ${p}; --bg: rgba(0,0,0,.85); --text: #fff;
                    --dim: #aaa; --divider: rgba(255,255,255,.08);
                    --danger: #f44336; --info: #2196F3; --warn: #ff9800;
                    font: 11px/1 sans-serif; color: var(--text);
                }
                .main-panel {
                    width: min(340px, calc(100vw - 20px)); max-height: 400px;
                    background: var(--bg); border: 1px solid var(--p); border-radius: 6px;
                    backdrop-filter: blur(5px); box-shadow: 0 2px 10px rgba(0,0,0,.5);
                    display: flex; flex-direction: column; overflow: hidden;
                }
                .tab-header {
                    display: flex; background: rgba(255,255,255,.04);
                    border-bottom: 1px solid var(--divider);
                }
                .tab-btn {
                    flex: 1; padding: 7px 4px; background: 0; border: 0; cursor: pointer;
                    color: var(--dim); font-weight: bold; border-bottom: 2px solid transparent;
                }
                .tab-btn.active { color: var(--p); border-bottom-color: var(--p); }
                .close-btn {
                    padding: 4px 10px; color: #888; cursor: pointer; font-size: 14px;
                    user-select: none; border-left: 1px solid var(--divider);
                }
                .close-btn:hover { color: #fff; }
                .tab-body { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
                .tab-panel { display: none; flex: 1; overflow-y: auto; padding: 4px 0; }
                .tab-panel.active { display: block; }

                .sniffer-item, .queue-row { padding: 6px 8px; border-bottom: 1px solid var(--divider); }
                .sniffer-item:last-child, .queue-row:last-child { border-bottom: none; }

                .item-type {
                    display: inline-block; padding: 1px 4px; border-radius: 2px;
                    font-weight: bold; font-size: 9px; margin-right: 4px;
                    background: var(--p); color: #000;
                }
                .item-type.mp4 { background: var(--info); color: #fff; }
                .item-name, .queue-row-name { font-weight: bold; }
                .item-name { margin-bottom: 2px; word-break: break-all; }
                .item-info, .sniffer-status, .setting-info, .queue-row-info { color: var(--dim); font-size: 10px; }
                .item-info { margin-bottom: 4px; }

                .item-btns, .btn-row, .mode-row { display: flex; gap: 4px; align-items: center; }
                .btn-row { margin: 8px 4px 4px; }
                .mode-row { margin: 4px; }

                button { border-radius: 3px; cursor: pointer; font-weight: bold; border: 0; }
                .btn { padding: 4px 8px; font-size: 10px; }
                .btn-copy { background: #555; color: #fff; }
                .btn-select, .btn-queue-add { background: var(--p); color: #000; }
                .btn-queue-add { flex: 1; padding: 6px 8px; font-size: 11px; }
                .btn-queue-add:disabled { opacity: .6; cursor: default; }
                .btn-remove, .btn-clear-all { background: var(--danger); color: #fff; }
                .btn-cancel { background: var(--warn); color: #000; }
                .head-btn, .btn-back-sniff {
                    background: transparent; border: 1px solid var(--p); color: var(--p); padding: 2px 6px; font-size: 10px;
                }
                .btn-back-sniff { padding: 6px 8px; }
                .queue-row-inline .btn { padding: 2px 6px; font-size: 9px; }
                .queue-header-bar .btn { padding: 3px 6px; font-size: 9px; }

                .sniffer-status, .queue-header-bar {
                    padding: 4px 8px; display: flex; justify-content: space-between; align-items: center;
                }
                .sniffer-status { border-top: 1px solid var(--divider); }
                .queue-header-bar { border-bottom: 1px solid var(--divider); }

                .empty-tip { padding: 16px; text-align: center; color: #666; }

                input[type="text"] {
                    flex: 1; padding: 4px 6px; border: 1px solid #333; border-radius: 3px;
                    background: #0f3460; color: #fff; font-size: 10px; min-width: 50px;
                }
                .mode-row input[type="radio"] { margin: 0; accent-color: var(--p); }
                .mode-row label { cursor: pointer; }
                .filename-edit {
                    cursor: pointer; border-bottom: 1px dashed var(--dim);
                    flex: 1; word-break: break-all; overflow: hidden; margin: 4px;
                }
                .filename-edit:hover { color: var(--p); }
                textarea.filename-input {
                    width: 100%; padding: 2px 4px; border: 1px solid var(--p); border-radius: 3px;
                    background: #0f3460; color: #fff; font-size: 11px; font-family: inherit;
                }
                .setting-body { padding: 4px; }
                .setting-info { padding: 0 4px; }

                .queue-row-head, .queue-row-foot { display: flex; align-items: center; gap: 6px; }
                .queue-row-time { color: #777; font-size: 9px; flex-shrink: 0; min-width: 70px; }
                .queue-row-name, .queue-row-info { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }

                .q-status { font-size: 9px; padding: 1px 5px; border-radius: 2px; font-weight: bold; flex-shrink: 0; }
                .q-status-waiting { background: #607d8b; color: #fff; }
                .q-status-downloading { background: var(--p); color: #000; }
                .q-status-done { background: var(--info); color: #fff; }
                .q-status-error { background: var(--danger); color: #fff; }
                .q-status-cancelled { background: #888; color: #fff; }
            `;
        }

        switchTab(name) {
            if (this.currentTab === name) return;
            this.currentTab = name;

            this.$.tabHeader.querySelectorAll('.tab-btn').forEach(b =>
                b.classList.toggle('active', b.dataset.tab === name));
            this.$.tabBody.querySelectorAll('.tab-panel').forEach(p =>
                p.classList.toggle('active', p.dataset.panel === name));

            const map = { 'sniffer': 'snifferTab', 'download-setting': 'setting', 'queue': 'queueUI' };
            this[map[name]].render();
        }

        async parseResourceInfo(item) {
            try {
                const parseResult = await parseM3u8(item.url);
                item.duration = parseResult.totalDuration;
                item.segmentCount = parseResult.segments.length;
                item.encrypted = parseResult.segments.some(s => s.key);
                item.parseStatus = 'done';
            } catch (e) {
                console.warn('[解析失败]', item.url, e.message);
                item.parseStatus = 'error';
            }
            const rowEl = this.snifferTab.resourceDomMap.get(item);
            if (rowEl) this.snifferTab.updateRow(rowEl, item);
        }

        selectResource(item) {
            this.settingItem = item;
            this.switchTab('download-setting');
        }
    }

    const sniffer = new Sniffer();
    sniffer.start();

    const ui = new UI(sniffer);
    ui.init();
})();