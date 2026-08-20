// ==UserScript==
// @name         视频嗅探下载器
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  网页m3u8/mp4视频嗅探下载；m3u8分片ZIP打包+本地m3u8索引；AES‑128解密；适配Via浏览器
// @author       You
// @license      MIT
// @match        *://*/*
// @connect      *
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==


(function() {
    'use strict';

    // ==========================================
    // 0. 中文提示配置
    // ==========================================
    const T = {
        title: '嗅探器',
        copy: '复制',
        preview: '预览',
        download: '下载'
    };

    // ==========================================
    // 1. 全局配置
    // ==========================================
    const Config = {
        scanInterval: 2000,
        uiId: 'gm‑sniffer‑v23‑ts',
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
                                try { onProgress(res.response.byteLength, res.response.byteLength, speed); } catch(e) {}
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
                const algorithm = { name: 'AES‑CBC', iv: iv };
                const cryptoKey = await window.crypto.subtle.importKey('raw', key, algorithm, false, ['decrypt']);
                return new Uint8Array(await window.crypto.subtle.decrypt(algorithm, cryptoKey, data));
            } catch (error) {
                console.error('[Crypto] 解密错误:', error);
                return null;
            }
        }
    };

    // ==========================================
    // 4. 工具函数
    // ==========================================
    const getSafeFileName = () => {
        let title = document.title || "video";
        return title.replace(/[\\/:*?"<>|]/g, " ").trim();
    };

    const openTsPreviewPage = (tsList, encryptInfo, originM3u8Url, totalDuration) => {
        const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>M3U8预览 - ${getSafeFileName()}</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{padding:16px;font-family:system-ui;font-size:14px;background:#1a1a2e;color:#eee}
h2{margin-bottom:12px;color:#4caf50}
.player-box{background:#16213e;border-radius:8px;padding:12px;margin-bottom:16px}
video{width:100%;max-height:420px;background:#000;border-radius:4px}
.info{background:#16213e;border-radius:8px;padding:12px;display:grid;grid-template-columns:1fr 1fr;gap:8px}
.info p{margin:4px 0;word-break:break-all}
.label{color:#888}
.value{color:#4caf50;font-weight:bold}
.encrypt-yes{color:#ff6b6b}
.encrypt-no{color:#4caf50}
a{color:#2196F3}
</style></head><body>
<h2>M3U8 预览</h2>
<div class="player-box">
<video id="player" controls></video>
</div>
<div class="info">
<div><span class="label">原始地址：</span><br><a target="_blank" href="${originM3u8Url}">${originM3u8Url}</a></div>
<div><span class="label">加密状态：</span><br>${encryptInfo.enable ? '<span class="encrypt-yes">AES-128加密</span>' : '<span class="encrypt-no">未加密</span>'}</div>
<div><span class="label">分片总数：</span><br><span class="value">${tsList.length}</span></div>
<div><span class="label">总时长：</span><br><span class="value">${totalDuration.toFixed(1)} 秒</span></div>
</div>
<script>
const video = document.getElementById('player');
let currentHls = null;
function loadVideo(url){
  if(currentHls){ currentHls.destroy(); currentHls = null; }
  if(Hls.isSupported()){
    currentHls = new Hls();
    currentHls.loadSource(url);
    currentHls.attachMedia(video);
    currentHls.on(Hls.Events.MANIFEST_PARSED, ()=> video.play().catch(()=>{}));
  } else if(video.canPlayType('application/vnd.apple.mpegurl')){
    video.src = url;
    video.play().catch(()=>{});
  }
}
loadVideo('${originM3u8Url}');
<\/script>
</body></html>`;
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const previewUrl = URL.createObjectURL(blob);
        window.open(previewUrl, '_blank');
    };

    // ==========================================
    // 5. 事件总线
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
    // 6. 网络嗅探器
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
                    Bus.emit('video‑found', { url, type });
                    return;
                }
            }
        }

        hookFetch() {
            const targetWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            const originalFetch = targetWindow.fetch;
            if (!originalFetch) return;
            targetWindow.fetch = async (...args) => {
                const url = args[0] instanceof Request ? args[0].url : args[0];
                const response = await originalFetch.apply(targetWindow, args);
                try {
                    const clone = response.clone();
                    clone.headers.forEach((val, key) => {
                        if (key.toLowerCase() === 'content‑type') this.detect(url, val);
                    });
                } catch (e) { }
                return response;
            };
        }

        hookXHR() {
            const targetWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            const originalXHR = targetWindow.XMLHttpRequest;
            if (!originalXHR) return;
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
                                const contentType = this.getResponseHeader('content‑type');
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
    // 6. 下载管理器
    // ==========================================
    class VideoWriter {
        constructor() {
            this.zip = new JSZip();
            this.fileCount = 0;
            this.tsFileCount = 0;
        }

        async addFile(name, data) {
            const isText = typeof data === 'string';
            const isTs = /\.ts$/i.test(name);
            const compressionOptions = isText ? { compression: 'DEFLATE', compressionOptions: { level: 9 } } : null;
            this.zip.file(name, data, compressionOptions);
            this.fileCount++;
            if (isTs) this.tsFileCount++;
        }

        async close(filename) {
            if (this.fileCount === 0) {
                alert('下载失败：获取分片数据为空');
                return;
            }
            const zipBlob = await this.zip.generateAsync({
                type: 'blob',
                compression: 'DEFLATE',
                compressionOptions: { level: 1 }
            });
            Utils.downloadBlob(zipBlob, filename.replace(/\.ts$/i, '.zip'));
        }
    }

    /**
     * 解析m3u8，返回 {segments, timeList, totalDuration, targetDuration}
     * timeList: [{idx, dur, tStart, tEnd}]
     */
    const parseM3u8 = async (url) => {
        let content = await Utils.request(url);
        // 处理主m3u8多码率
        if (content.includes('#EXT‑X‑STREAM‑INF')) {
            const lines = content.split('\n');
            let bestBandwidth = 0;
            let bestUrl = null;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('#EXT‑X‑STREAM‑INF')) {
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
            } else if (l.startsWith('#EXT‑X‑KEY')) {
                const method = (l.match(/METHOD=([^,]+)/) || [])[1];
                const uri = (l.match(/URI="([^"]+)"/) || [])[1];
                const ivHex = (l.match(/IV=(0x[\da‑f]+)/i) || [])[1];
                if (method === 'AES‑128' && uri) {
                    currentKey = Utils.resolveUrl(url, uri);
                    currentIV = ivHex ? AESCrypto.hexToBytes(ivHex) : null;
                }
            } else if (l.startsWith('#EXT‑X‑MEDIA‑SEQUENCE')) {
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
        for(let i=0;i<timeList.length;i++){
            const item = timeList[i];
            if(item.tEnd >= beginSec){
                startIdx = i;
                break;
            }
        }
        for(let i=timeList.length-1;i>=0;i--){
            const item = timeList[i];
            if(item.tStart <= endSec){
                endIdx = i;
                break;
            }
        }
        return {startIdx, endIdx};
    };

    /**
     * 下载m3u8，支持分片下标过滤
     */
    /**
     * 生成本地播放用 m3u8 索引
     */
    const buildLocalM3u8 = (fileNames, targetDuration = 10, keyInfo = null) => {
        const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${targetDuration}`];
        if (keyInfo && keyInfo.uri) {
            lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="${keyInfo.uri}"`);
        }
        for (const name of fileNames) {
            lines.push(name);
        }
        lines.push('#EXT-X-ENDLIST');
        return lines.join('\n');
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

        const addedNames = [];
        for (let i = 0; i < results.length; i++) {
            if (results[i] && results[i].length > 0) {
                const fileName = `${i.toString().padStart(4, '0')}.ts`;
                await writer.addFile(fileName, results[i]);
                addedNames.push(fileName);
            } else {
                console.warn(`[downloadM3u8BySegments] 跳过空分片#${i}`);
            }
        }
        console.log(`[downloadM3u8BySegments] 已添加${addedNames.length}个分片到ZIP`);

        if (addedNames.length === 0) {
            throw new Error('所有分片均下载失败');
        }
        return addedNames;
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
        onProgress(0, '初始化中...', null);
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

    /**
     * 通用任务入口
     */
    window.TaskRunner = async (url, type, btn, opt = {}) => {
        const originalText = btn ? btn.textContent : '';
        const safeName = getSafeFileName();
        let filename = type === 'm3u8' ? safeName + '.zip' : safeName + '.mp4';
        console.log('[TaskRunner] 开始:', { url, type, opt });

        const writer = new VideoWriter();
        try {
            if (type === 'm3u8') {
                if (btn) btn.textContent = '解析m3u8...';
                const parseResult = await parseM3u8(url);
                const {segments, timeList, targetDuration} = parseResult;
                console.log('[TaskRunner] 解析完成, 分片数:', segments.length);

                let startIdx = opt.startIdx ?? null;
                let endIdx = opt.endIdx ?? null;

                if(opt.beginSec !== undefined && opt.endSec !== undefined){
                    const mapped = timeToSegmentIndex(timeList, opt.beginSec, opt.endSec);
                    startIdx = mapped.startIdx;
                    endIdx = mapped.endIdx;
                    console.log('[TaskRunner] 时间换算分片:', startIdx, '-', endIdx);
                } else if (startIdx === null || endIdx === null) {
                    console.log('[TaskRunner] 未指定分片/时间范围，将下载全部分片');
                }

                const keyCache = new Map();
                const uniqueKeys = [...new Set(segments.filter(s => s.key).map(s => s.key))];
                let keyInfoForPlaylist = null;
                if (uniqueKeys.length > 0) {
                    if (btn) btn.textContent = '获取加密密钥...';
                    for (const keyUrl of uniqueKeys) {
                        const keyData = await Utils.request(keyUrl, true);
                        keyCache.set(keyUrl, new Uint8Array(keyData));
                        if (!keyInfoForPlaylist) {
                            try {
                                const urlObj = new URL(keyUrl);
                                keyInfoForPlaylist = { uri: keyUrl };
                            } catch(e) {
                                keyInfoForPlaylist = { uri: keyUrl };
                            }
                        }
                    }
                }
                console.log('[TaskRunner] 开始下载分片');
                const addedNames = await downloadM3u8BySegments(segments, keyCache, (pct, txt) => { if (btn) btn.textContent = txt || pct + '%'; }, writer, startIdx, endIdx);
                console.log('[TaskRunner] 分片下载完成, 共', addedNames.length, '个');
                await writer.addFile('playlist.m3u8', buildLocalM3u8(addedNames, targetDuration, keyInfoForPlaylist));
                if (btn) btn.textContent = '保存中...';
                console.log('[TaskRunner] 生成ZIP:', filename);
                await writer.close(filename);
                console.log('[TaskRunner] ZIP生成完成');
                if (btn) btn.textContent = '完成';
            } else {
                if (btn) btn.textContent = '下载中...';
                const dlResult = await downloadMp4(url, (pct, txt) => { if (btn) btn.textContent = txt || pct + '%'; }, writer);
                if (dlResult.nativeDl) {
                    console.log('[TaskRunner] 原生下载已触发，跳过ZIP打包');
                    if (btn) btn.textContent = '原生下载已启动';
                    return;
                }
                if (btn) btn.textContent = '保存中...';
                console.log('[TaskRunner] 生成ZIP:', filename);
                await writer.close(filename);
                console.log('[TaskRunner] ZIP生成完成');
                if (btn) btn.textContent = '完成';
            }
        } catch (error) {
            console.error('[TaskRunner] 错误:', error);
            if (btn) btn.textContent = '错误';
            alert(`下载错误: ${error.message || error}`);
            throw error;
        }
    };

    // ==========================================
    // 7. UI悬浮面板
    // ==========================================
    class UI {
        constructor() {
            this.root = null;
            this.list = null;
            this.toggleBtn = null;
            this.resources = [];
            this.openIndex = -1;
            Bus.on('video-found', (data) => {
                if (!this.root) this.init();
                this.addResource(data);
            });
        }

        init() {
            if (document.getElementById(Config.uiId)) return;
            const host = Utils.createElement('div', {
                id: Config.uiId,
                style: { position: 'fixed', bottom: '20px', left: '20px', zIndex: 999999 }
            });
            const shadow = host.attachShadow({ mode: 'open' });

            const style = Utils.createElement('style');
            style.textContent = `
                :host { font-family: sans-serif; font-size: 12px; }
                .box {
                    width: 340px; background: ${Config.colors.background}; color: ${Config.colors.text};
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
                .input-row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
                .input-row label { min-width: 48px; color: #aaa; font-size: 11px; }
                .input-row input {
                    flex: 1; padding: 4px 8px; border: 1px solid #333; border-radius: 4px;
                    background: #0f3460; color: #fff; font-size: 11px; min-width: 0;
                }
                button { border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }
                .btn-primary {
                    flex: 1; background: ${Config.colors.primary}; color: #000;
                    font-weight: bold; padding: 6px 10px;
                }
                .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
                .btn-secondary { background: #2196F3; color: #fff; }
                .btn-copy { background: #555; color: white; }
                .btn-row { display: flex; gap: 6px; margin-top: 8px; }
                .empty-tip { padding: 20px; text-align: center; color: #666; }
                .toggle-btn {
                    position: fixed; bottom: 20px; left: 20px; width: 44px; height: 44px;
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
            shadow.appendChild(this.toggleBtn);
            (document.body || document.documentElement).appendChild(host);

            this.root.style.display = 'none';

            this.renderList();
        }

        addResource({ url, type }) {
            const normalizedType = type === 'm3u8' ? 'm3u8' : 'mp4';
            const exists = this.resources.some(r => r.url === url);
            if (exists) return;
            this.resources.unshift({ url, type: normalizedType });
            this.renderList();
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

        async previewM3u8(url) {
            try {
                const res = await parseM3u8(url);
                openTsPreviewPage(res.segments, {
                    enable: res.segments.some(s => s.key),
                    keyUrl: res.segments.find(s => s.key)?.key || null,
                    ivHex: null
                }, url, res.totalDuration);
            } catch (err) {
                alert('解析失败: ' + err.message);
            }
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
            console.log('[UI.runDownload] target:', item.url, 'opt:', opt);
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
                            radio.onchange = () => {
                                const isSeg = radio.value === 'seg';
                                timeRow.style.display = isSeg ? 'none' : 'flex';
                                segRow.style.display = isSeg ? 'flex' : 'none';
                            };
                        });

                        const btnRow = Utils.createElement('div', { class: 'btn-row' });
                        const mainBtn = Utils.createElement('button', { class: 'btn-primary' }, '开始下载');
                        mainBtn.onclick = () => this.runDownload(item, bodyEl, mainBtn);
                        const previewBtn = Utils.createElement('button', { class: 'btn-secondary' }, '预览');
                        previewBtn.onclick = (e) => { e.stopPropagation(); this.previewM3u8(item.url); };
                        const copyBtn = Utils.createElement('button', { class: 'btn-copy' }, '复制');
                        copyBtn.onclick = (e) => { e.stopPropagation(); this.copyUrl(item.url); };
                        btnRow.appendChild(mainBtn);
                        btnRow.appendChild(previewBtn);
                        btnRow.appendChild(copyBtn);
                        bodyEl.appendChild(btnRow);
                    } else {
                        const btnRow = Utils.createElement('div', { class: 'btn-row' });
                        const mainBtn = Utils.createElement('button', { class: 'btn-primary' }, '开始下载');
                        mainBtn.onclick = () => this.runDownload(item, bodyEl, mainBtn);
                        btnRow.appendChild(mainBtn);
                        bodyEl.appendChild(btnRow);

                        const subRow = Utils.createElement('div', { class: 'btn-row', style: 'margin-top:6px;' });
                        const copyBtn = Utils.createElement('button', { class: 'btn-copy' }, '复制');
                        copyBtn.onclick = (e) => { e.stopPropagation(); this.copyUrl(item.url); };
                        subRow.appendChild(copyBtn);
                        bodyEl.appendChild(subRow);
                    }

                    itemEl.appendChild(bodyEl);
                }

                this.list.appendChild(itemEl);
            });
        }
    }


    new Sniffer().start();
    new UI();
})();