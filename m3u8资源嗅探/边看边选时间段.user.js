// ==UserScript==
// @name         m3u8可视化拖拽选段下载【重构修复嗅探版】
// @namespace    http://tampermonkey.net/
// @version      3.1‑fix‑sniff
// @description  修复嗅探失效，简化面板；网页m3u8嗅探、可视化拖拽选段预览、AES‑128解密、分片拼接TS、手机电脑通用
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
    // 工具函数
    // ==========================================
    function formatTimeHMS(sec) {
        if (!isFinite(sec) || sec <= 0) return '00:00:00';
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
    }

    function formatTime(seconds) {
        if (!isFinite(seconds) || seconds <= 0) return '--:--';
        seconds = Math.floor(seconds);
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        const pad = (n) => n.toString().padStart(2, '0');
        return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    }

    function formatBytes(bytes) {
        if (bytes == null || bytes <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let i = 0;
        let v = bytes;
        while (v >= 1024 && i < units.length - 1) {
            v /= 1024;
            i++;
        }
        return `${v.toFixed(v < 10 && i > 0 ? 2 : 1)} ${units[i]}`;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function toSeconds(s) {
        const parts = String(s).split(':').map(Number);
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return Number(s) || 0;
    }

    function resolveUrl(baseUrl, relativeUrl) {
        if (relativeUrl.startsWith('http')) return relativeUrl;
        if (relativeUrl.startsWith('/')) {
            const u = new URL(baseUrl);
            return u.origin + relativeUrl;
        }
        const path = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
        return path + relativeUrl;
    }

    function getFilename(url) {
        const cleanUrl = url.split('?')[0];
        let name = cleanUrl.split('/').pop();
        if (!name || name.trim() === '' || name === '/') name = `video_${Date.now()}.ts`;
        return decodeURIComponent(name);
    }

    function getSafeFileName() {
        let title = document.title || "video";
        return title.replace(/[\\/:*?"<>|]/g, " ").trim();
    }

    async function copyToClipboard(text) {
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

    function downloadBlob(blob, filename) {
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
    }

    function createElement(tag, attrs = {}, children = []) {
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
    }

    // ==========================================
    // GM请求封装
    // ==========================================
    function gmRequest(url, isBinary = false, onProgress = null) {
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
                        resolve(res.response);
                    } else reject(new Error(`HTTP Error ${res.status}`));
                },
                onerror: (err) => reject(err),
                ontimeout: () => reject(new Error('Timeout'))
            });
        });
    }

    // ==========================================
    // AES‑128解密
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
    // HLS加载
    // ==========================================
    function loadHlsScript() {
        return new Promise((resolve, reject) => {
            if (window.Hls) return resolve(window.Hls);
            const s = document.createElement('script');
            s.src = "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js";
            s.onload = () => resolve(window.Hls);
            s.onerror = () => reject(new Error("hls.js加载失败"));
            document.head.appendChild(s);
        });
    }

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
    // 【修复版嗅探器】重点改动
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
            setInterval(() => this.scanPerformance(), 2000);
        }

        detect(url, contentType = '') {
            if (!url) return;
            if (url.match(/^data:|^blob:|\.(png|jpg|jpeg|gif|css|js|woff|svg|ico)($|\?)/i)) return;
            const cleanKey = url.split('?')[0];
            if (this.seenUrls.has(cleanKey)) return;

            const typeStr = contentType ? contentType.toLowerCase() : '';
            for (const [type, regex] of Object.entries(this.rules)) {
                if (regex.test(url) || regex.test(typeStr)) {
                    this.seenUrls.add(cleanKey);
                    console.log(`[嗅探]发现 ${type}:`, url);
                    Bus.emit('video‑found', { url, type });
                    return;
                }
            }
        }

        hookFetch() {
            const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            if (!win.fetch) return;
            const originalFetch = win.fetch;
            win.fetch = async (...args) => {
                const req = args[0] instanceof Request ? args[0] : new Request(args[0]);
                const url = req.url;
                let contentType = req.headers.get('content‑type') || '';
                const resp = await originalFetch.apply(win, args);
                // 优先读取响应头，捕获m3u8
                try {
                    const ctype = resp.headers.get('content‑type');
                    if (ctype) contentType = ctype;
                } catch (e) { }
                this.detect(resp.url || url, contentType);
                return resp;
            };
        }

        hookXHR() {
            const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            if (!win.XMLHttpRequest) return;
            const OriginalXHR = win.XMLHttpRequest;
            const self = this;
            class HijackedXHR extends OriginalXHR {
                open(method, url, ...rest) {
                    this._reqUrl = url;
                    super.open(method, url, ...rest);
                }
                send(...args) {
                    this.addEventListener('readystatechange', () => {
                        if (this.readyState === 4) {
                            try {
                                const finalUrl = this.responseURL || this._reqUrl;
                                const ctype = this.getResponseHeader('content‑type');
                                self.detect(finalUrl, ctype);
                                // 额外：部分接口直接返回m3u8文本
                                if (typeof this.responseText === 'string' && this.responseText.includes('#EXTM3U')) {
                                    self.detect(finalUrl, 'application/x‑mpegurl');
                                }
                            } catch (e) { }
                        }
                    });
                    super.send(...args);
                }
            }
            win.XMLHttpRequest = HijackedXHR;
        }

        scanPerformance() {
            if (!window.performance?.getEntriesByType) return;
            performance.getEntriesByType('resource').forEach(entry => {
                this.detect(entry.name);
            });
        }
    }

    // ==========================================
    // TS时间戳修复器
    // ==========================================
    const TSPacketFixer = {
        TS_PACKET_SIZE: 188,
        SYNC_BYTE: 0x47,
        PCR_TIMEBASE: 90000,

        readPCR(buf, offset) {
            const pcrBase = (buf[offset] << 25) | (buf[offset + 1] << 17) | (buf[offset + 2] << 9) | (buf[offset + 3] << 1) | (buf[offset + 4] >> 7);
            const pcrExt = ((buf[offset + 4] >> 1) & 0x01) | ((buf[offset + 5] & 0x01) << 8);
            return pcrBase * 300 + pcrExt;
        },

        writePCR(buf, offset, pcrValue) {
            const pcrBase = Math.floor(pcrValue / 300);
            const pcrExt = pcrValue % 300;
            buf[offset] = (pcrBase >> 25) & 0xFF;
            buf[offset + 1] = (pcrBase >> 17) & 0xFF;
            buf[offset + 2] = (pcrBase >> 9) & 0xFF;
            buf[offset + 3] = (pcrBase >> 1) & 0xFF;
            buf[offset + 4] = ((pcrBase & 0x01) << 7) | ((pcrExt >> 8) & 0x01) | 0x10;
            buf[offset + 5] = pcrExt & 0xFF;
        },

        readPTS(buf, offset) {
            const b0 = buf[offset];
            const b1 = buf[offset + 1];
            const b2 = buf[offset + 2];
            const b3 = buf[offset + 3];
            const b4 = buf[offset + 4];
            let pts = 0;
            pts |= ((b0 & 0x0E) << 29);
            pts |= (b1 << 22);
            pts |= ((b2 & 0xFE) << 14);
            pts |= (b3 << 7);
            pts |= (b4 >> 1);
            return pts >>> 0;
        },

        writePTS(buf, offset, ptsValue) {
            const v = ptsValue >>> 0;
            buf[offset] = (buf[offset] & 0xF0) | ((v >> 29) & 0x0E);
            buf[offset + 1] = (v >> 22) & 0xFF;
            buf[offset + 2] = ((v >> 14) & 0xFE) | 0x01;
            buf[offset + 3] = (v >> 7) & 0xFF;
            buf[offset + 4] = ((v << 1) & 0xFE) | 0x01;
        },

        getPCRRanges(data) {
            let firstPCR = null;
            let lastPCR = null;
            const len = data.length;
            for (let i = 0; i + this.TS_PACKET_SIZE <= len; i += this.TS_PACKET_SIZE) {
                if (data[i] !== this.SYNC_BYTE) continue;
                const hasAdaptation = (data[i + 3] & 0x20) !== 0;
                if (!hasAdaptation) continue;
                const adaptationOffset = i + 4;
                const adaptationLength = data[adaptationOffset];
                if (adaptationLength <= 0 || adaptationOffset + 1 + adaptationLength > i + this.TS_PACKET_SIZE) continue;
                const pcrFlag = (data[adaptationOffset + 1] >> 4) & 0x01;
                if (!pcrFlag) continue;
                const pcrOffset = adaptationOffset + 2;
                const pcr = this.readPCR(data, pcrOffset);
                if (firstPCR === null) firstPCR = pcr;
                lastPCR = pcr;
            }
            return { firstPCR, lastPCR };
        },

        applyTimestampOffset(data, offset) {
            if (offset === 0) return data;
            const len = data.length;
            const result = new Uint8Array(data);
            for (let i = 0; i + this.TS_PACKET_SIZE <= len; i += this.TS_PACKET_SIZE) {
                if (result[i] !== this.SYNC_BYTE) continue;
                const hasAdaptation = (result[i + 3] & 0x20) !== 0;
                const hasPayload = (result[i + 3] & 0x10) !== 0;
                if (hasAdaptation) {
                    const adaptationOffset = i + 4;
                    const adaptationLength = result[adaptationOffset];
                    if (adaptationLength > 0 && adaptationOffset + 1 + adaptationLength <= i + this.TS_PACKET_SIZE) {
                        const pcrFlag = (result[adaptationOffset + 1] >> 4) & 0x01;
                        if (pcrFlag) {
                            const pcrOffset = adaptationOffset + 2;
                            const pcr = this.readPCR(result, pcrOffset);
                            this.writePCR(result, pcrOffset, (pcr + offset) >>> 0);
                        }
                    }
                }
                if (hasPayload) {
                    const payloadUnitStart = (result[i + 1] >> 6) & 0x01;
                    let payloadOffset = i + 4;
                    if (hasAdaptation) {
                        const adaptationLength = result[payloadOffset];
                        payloadOffset += 1 + adaptationLength;
                    }
                    if (payloadUnitStart && payloadOffset + 6 <= len) {
                        const streamId = result[payloadOffset];
                        if (streamId === 0xBD || (streamId >= 0xC0 && streamId <= 0xDF) || (streamId >= 0xE0 && streamId <= 0xEF)) {
                            const ptsDtsFlag = (result[payloadOffset + 3] >> 6) & 0x03;
                            const ptsOffset = payloadOffset + 3;
                            if ((ptsDtsFlag & 0x02) && ptsOffset + 5 <= len) {
                                const pts = this.readPTS(result, ptsOffset + 1);
                                this.writePTS(result, ptsOffset + 1, (pts + offset) >>> 0);
                            }
                            if (ptsDtsFlag === 0x03 && ptsOffset + 10 <= len) {
                                const dtsOffset = ptsOffset + 5;
                                const dts = this.readPTS(result, dtsOffset);
                                this.writePTS(result, dtsOffset, (dts + offset) >>> 0);
                            }
                        }
                    }
                }
            }
            return result;
        },

        fixTimestamps(buffers) {
            if (buffers.length === 0) return new Uint8Array(0);
            if (buffers.length === 1) return buffers[0];
            let cumulativeOffset = 0;
            let lastEndPCR = null;
            const fixedBuffers = [];
            for (let i = 0; i < buffers.length; i++) {
                const buf = buffers[i];
                const { firstPCR, lastPCR } = this.getPCRRanges(buf);
                if (lastEndPCR !== null && firstPCR !== null) {
                    const gap = lastEndPCR - firstPCR;
                    if (gap !== 0) {
                        cumulativeOffset += gap;
                        console.log(`[TSPacketFixer] 分片${i} 时间戳偏移: +${(gap / this.PCR_TIMEBASE).toFixed(2)}s (累计: ${(cumulativeOffset / this.PCR_TIMEBASE).toFixed(2)}s)`);
                    }
                }
                const fixedBuf = this.applyTimestampOffset(buf, cumulativeOffset);
                fixedBuffers.push(fixedBuf);
                if (lastPCR !== null) {
                    lastEndPCR = lastPCR + cumulativeOffset;
                }
            }
            const totalSize = fixedBuffers.reduce((sum, b) => sum + b.length, 0);
            const result = new Uint8Array(totalSize);
            let offset = 0;
            for (const fb of fixedBuffers) {
                result.set(fb, offset);
                offset += fb.length;
            }
            console.log(`[TSPacketFixer] 时间戳修复完成: ${buffers.length}个分片, 总时长偏移 ${(cumulativeOffset / this.PCR_TIMEBASE).toFixed(2)}s`);
            return result;
        }
    };

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
                alert('分片数据为空，无法保存');
                return;
            }
            const tsData = TSPacketFixer.fixTimestamps(this.buffers);
            const blob = new Blob([tsData], { type: 'video/mp2t' });
            downloadBlob(blob, filename.replace(/\.zip$/i, '.ts'));
        }
    }

    // ==========================================
    // M3U8解析
    // ==========================================
    async function parseM3u8(url) {
        let content = await gmRequest(url);
        // 处理多级m3u8
        if (content.includes('#EXT‑X‑STREAM‑INF')) {
            const lines = content.split('\n');
            let bestBandwidth = 0;
            let bestUrl = null;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('#EXT‑X‑STREAM‑INF')) {
                    const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) || [0, 0])[1]);
                    const nextLine = lines[i + 1]?.trim();
                    if (nextLine && !nextLine.startsWith('#') && bw > bestBandwidth) {
                        bestBandwidth = bw;
                        bestUrl = resolveUrl(url, nextLine);
                    }
                }
            }
            if (bestUrl) {
                url = bestUrl;
                content = await gmRequest(url);
            }
        }

        const lines = content.split('\n');
        const segments = [];
        const timeList = [];
        let currentKey = null, currentIV = null, sequence = 0;
        let currentInf = 0;
        let timeAcc = 0;

        for (const line of lines) {
            const l = line.trim();
            if (!l) continue;
            if (l.startsWith('#EXT‑X‑KEY')) {
                const method = (l.match(/METHOD=([^,]+)/) || [])[1];
                const uri = (l.match(/URI="([^"]+)"/) || [])[1];
                const ivHex = (l.match(/IV=(0x[\da‑f]+)/i) || [])[1];
                if (method === 'AES‑128' && uri) {
                    currentKey = resolveUrl(url, uri);
                    currentIV = ivHex ? AESCrypto.hexToBytes(ivHex) : null;
                }
            } else if (l.startsWith('#EXT‑X‑MEDIA‑SEQUENCE')) {
                sequence = parseInt(l.split(':')[1]);
            } else if (l.startsWith('#EXTINF:')) {
                currentInf = parseFloat(l.match(/#EXTINF:([\d.]+)/)[1]);
            } else if (!l.startsWith('#')) {
                segments.push({
                    url: resolveUrl(url, l),
                    key: currentKey,
                    iv: currentIV,
                    seq: sequence++,
                    dur: currentInf
                });
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
        return { url, segments, timeList, totalDuration: timeAcc };
    }

    function timeToSegmentIndex(timeList, beginSec, endSec) {
        let startIdx = 0;
        let endIdx = timeList.length - 1;
        for (let i = 0; i < timeList.length; i++) {
            if (timeList[i].tEnd >= beginSec) { startIdx = i; break; }
        }
        for (let i = timeList.length - 1; i >= 0; i--) {
            if (timeList[i].tStart <= endSec) { endIdx = i; break; }
        }
        return { startIdx, endIdx };
    }

    // ==========================================
    // m3u8分片下载
    // ==========================================
    async function downloadM3u8BySegments(segments, keyCache, onProgress, writer, segmentIndices = null) {
        let workSegments = [...segments];
        if (segmentIndices && segmentIndices.length > 0) {
            const indexSet = new Set(segmentIndices);
            workSegments = segments.filter((_, i) => indexSet.has(i));
            if (workSegments.length === 0) throw new Error("分片过滤后为空");
        }
        const maxThreads = 4;
        const maxRetries = 3;
        let nextIndex = 0;
        const results = new Array(workSegments.length);
        let completedCount = 0;
        let failCount = 0;
        let totalBytes = 0;
        const taskStartTs = Date.now();

        function updateProgress(force = false) {
            const now = Date.now();
            const elapsed = (now - taskStartTs) / 1000;
            const pct = (completedCount / workSegments.length) * 100;
            const speed = elapsed > 0 ? totalBytes / elapsed : 0;
            const etaSec = pct > 0 && pct < 100 ? (elapsed / (pct / 100)) * (1 - pct / 100) : 0;
            const text = `${pct.toFixed(0)}% | ${completedCount}/${workSegments.length} | ${formatBytes(totalBytes)} | ${formatBytes(speed)}/s ETA:${formatTime(etaSec)} ${failCount > 0 ? "失败:" + failCount : ""}`;
            onProgress(pct, text);
        }

        async function worker() {
            while (nextIndex < workSegments.length) {
                const idx = nextIndex++;
                const seg = workSegments[idx];
                let raw = null;
                let retry = maxRetries;
                while (!raw && retry >= 0) {
                    try {
                        const data = await gmRequest(seg.url, true);
                        if (seg.key) {
                            const keyBuf = keyCache.get(seg.key);
                            if (!keyBuf) throw new Error("密钥获取失败");
                            const iv = seg.iv || AESCrypto.sequenceToIV(seg.seq);
                            const dec = await AESCrypto.decrypt(data, keyBuf, iv);
                            if (!dec) throw new Error("AES解密失败");
                            raw = dec.buffer;
                        } else {
                            raw = data;
                        }
                    } catch (e) {
                        retry--;
                        if (retry >= 0) await sleep(800);
                    }
                }
                if (!raw) {
                    failCount++;
                    results[idx] = new Uint8Array(0);
                } else {
                    results[idx] = new Uint8Array(raw);
                    totalBytes += results[idx].byteLength;
                }
                completedCount++;
                updateProgress();
            }
        }

        const threadPool = Array(Math.min(maxThreads, workSegments.length)).fill(0).map(() => worker());
        await Promise.all(threadPool);
        updateProgress(true);

        for (let i = 0; i < results.length; i++) {
            if (results[i] && results[i].length > 0) await writer.addFile('', results[i]);
        }
    }

    // ==========================================
    // MP4下载
    // ==========================================
    async function downloadMp4(url, onProgress, writer) {
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        if (isMobile) {
            if (confirm("调用浏览器原生下载？")) {
                const a = createElement('a', { href: url, download: getFilename(url) });
                document.body.appendChild(a);
                a.click();
                a.remove();
                onProgress(100, "原生下载已触发");
                return { nativeDl: true };
            }
        }
        const buf = await gmRequest(url, true, (loaded, total) => {
            const pct = total ? (loaded / total) * 100 : 0;
            onProgress(pct, `${pct.toFixed(1)}% ${formatBytes(loaded)}`);
        });
        await writer.addFile('', new Uint8Array(buf));
        onProgress(100, "下载完成");
        return { nativeDl: false };
    }

    // ==========================================
    // 下载任务入口
    // ==========================================
    window.TaskRunner = async function (url, type, btn, opt = {}) {
        const originText = btn.textContent;
        const safeName = getSafeFileName();
        const filename = type === 'm3u8' ? safeName + '.ts' : safeName + '.mp4';
        const writer = new VideoWriter();
        try {
            if (type === 'm3u8') {
                btn.textContent = "解析m3u8...";
                const parseRet = await parseM3u8(url);
                let segmentIndices = null;
                if (opt.ranges && opt.ranges.length > 0) {
                    segmentIndices = [];
                    for (const r of opt.ranges) {
                        const mapped = timeToSegmentIndex(parseRet.timeList, r.start, r.end);
                        for (let i = mapped.startIdx; i <= mapped.endIdx; i++) {
                            if (!segmentIndices.includes(i)) segmentIndices.push(i);
                        }
                    }
                    segmentIndices.sort((a, b) => a - b);
                    console.log('[TaskRunner] 多段模式，选中分片数:', segmentIndices.length);
                } else if (opt.beginSec !== undefined && opt.endSec !== undefined) {
                    const mapped = timeToSegmentIndex(parseRet.timeList, opt.beginSec, opt.endSec);
                    segmentIndices = [];
                    for (let i = mapped.startIdx; i <= mapped.endIdx; i++) segmentIndices.push(i);
                    console.log('[TaskRunner] 单段时间换算分片:', mapped.startIdx, '-', mapped.endIdx);
                } else if (opt.startIdx !== undefined && opt.endIdx !== undefined) {
                    segmentIndices = [];
                    for (let i = opt.startIdx; i <= opt.endIdx; i++) segmentIndices.push(i);
                    console.log('[TaskRunner] 分片索引:', opt.startIdx, '-', opt.endIdx);
                } else {
                    console.log('[TaskRunner] 未指定分片/时间范围，将下载全部分片');
                }
                // 加载密钥
                const keyCache = new Map();
                const uniqueKeys = [...new Set(parseRet.segments.filter(s => s.key).map(s => s.key))];
                if (uniqueKeys.length > 0) {
                    btn.textContent = "获取解密密钥";
                    for (const kUrl of uniqueKeys) {
                        const kb = await gmRequest(kUrl, true);
                        keyCache.set(kUrl, new Uint8Array(kb));
                    }
                }
                btn.textContent = "分片下载中";
                await downloadM3u8BySegments(parseRet.segments, keyCache, (p, txt) => { btn.textContent = txt; }, writer, segmentIndices);
                btn.textContent = "保存文件";
                await writer.close(filename);
                btn.textContent = "✅下载完成";
            } else {
                btn.textContent = "下载中";
                await downloadMp4(url, (p, txt) => { btn.textContent = txt; }, writer);
                await writer.close(filename);
                btn.textContent = "✅下载完成";
            }
        } catch (err) {
            console.error(err);
            btn.textContent = "❌失败";
            alert(err.message);
        } finally {
            setTimeout(() => { btn.textContent = originText; }, 3000);
        }
    };

    // ==========================================
    // 可视化拖拽选段弹窗
    // ==========================================
    async function openPreviewSelectSegment(m3u8Url) {
        await loadHlsScript();
        const parseRet = await parseM3u8(m3u8Url);
        const totalDuration = parseRet.totalDuration;

        const overlay = createElement('div', {
            style: {
                position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
                background: '#000', zIndex: '999999', overflowY: 'auto'
            }
        });
        const closeBtn = createElement('button', {
            style: { position: 'fixed', top: 10, right: 10, zIndex: 100, padding: '4px 10px' }
        }, "关闭");
        const video = createElement('video', { controls: true, autoplay: true, playsinline: true, style: { width: '100%' } });
        const editorWrap = createElement('div', { style: { background: '#1a1a1a', color: '#fff', padding: '14px' } });

        let hlsInst = null;
        if (Hls.isSupported()) {
            hlsInst = new Hls();
            hlsInst.loadSource(m3u8Url);
            hlsInst.attachMedia(video);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = m3u8Url;
        }

        let startSec = 0;
        let endSec = Math.min(60, totalDuration);

        const t1Text = createElement('div', {}, `起始：${formatTimeHMS(startSec)}`);
        const t2Text = createElement('div', {}, `结束：${formatTimeHMS(endSec)}`);

        // 简单拖拽轨道
        function buildSlider(labelText, isStart, onChange) {
            const wrap = createElement('div', { style: { margin: '8px 0' } });
            const track = createElement('div', { style: { width: '100%', height: '8px', background: '#333', borderRadius: '4px', position: 'relative' } });
            const fill = createElement('div', { style: { position: 'absolute', height: '100%', background: '#4caf50', borderRadius: '4px', width: '0%' } });
            const thumb = createElement('div', { style: { width: '16px', height: '16px', borderRadius: '50%', background: '#4caf50', position: 'absolute', top: '-4px', marginLeft: '-8px', cursor: 'grab' } });
            track.appendChild(fill);
            track.appendChild(thumb);
            wrap.appendChild(createElement('div', {}, labelText));
            wrap.appendChild(track);

            let dragging = false;
            function setPos(clientX) {
                const rect = track.getBoundingClientRect();
                let pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                const sec = pct * totalDuration;
                thumb.style.left = `${pct * 100}%`;
                fill.style.width = `${pct * 100}%`;
                onChange(sec);
            }
            thumb.addEventListener('mousedown', () => dragging = true);
            thumb.addEventListener('touchstart', (e) => { dragging = true; }, { passive: true });
            document.addEventListener('mousemove', (e) => { if (dragging) setPos(e.clientX); });
            document.addEventListener('touchmove', (e) => {
                if (dragging) setPos(e.touches[0].clientX);
            }, { passive: true });
            document.addEventListener('mouseup', () => dragging = false);
            document.addEventListener('touchend', () => dragging = false);
            return { wrap, setPos };
        }

        const sliderStart = buildSlider("起始时间", true, (sec) => {
            startSec = Math.min(sec, endSec);
            video.currentTime = startSec;
            t1Text.textContent = `起始：${formatTimeHMS(startSec)}`;
        });
        const sliderEnd = buildSlider("结束时间", false, (sec) => {
            endSec = Math.max(sec, startSec);
            video.currentTime = endSec;
            t2Text.textContent = `结束：${formatTimeHMS(endSec)}`;
        });

        const confirmBtn = createElement('button', {
            style: { marginTop: '10px', padding: '8px 14px', background: '#4caf50', border: 'none', borderRadius: '4px', fontWeight: 'bold' }
        }, "✅确定回填时间");

        editorWrap.appendChild(t1Text);
        editorWrap.appendChild(sliderStart.wrap);
        editorWrap.appendChild(t2Text);
        editorWrap.appendChild(sliderEnd.wrap);
        editorWrap.appendChild(confirmBtn);

        overlay.appendChild(closeBtn);
        overlay.appendChild(video);
        overlay.appendChild(editorWrap);
        document.body.appendChild(overlay);

        function closeOverlay() {
            if (hlsInst) hlsInst.destroy();
            overlay.remove();
        }
        closeBtn.onclick = closeOverlay;

        return new Promise((resolve) => {
            confirmBtn.onclick = () => {
                closeOverlay();
                resolve({
                    startHms: formatTimeHMS(startSec),
                    endHms: formatTimeHMS(endSec),
                    startSec, endSec
                });
            };
        });
    }

    // ==========================================
    // 简化UI面板（移除shadow DOM）
    // ==========================================
    class SimpleUI {
        constructor() {
            this.resources = [];
            this.openIndex = -1;
            this.panel = null;
            this.toggleBtn = null;
            this.listEl = null;
            Bus.on('video‑found', (d) => this.addResource(d));
        }

        async init() {
            if (document.querySelector('#m3u8‑sniffer‑panel')) return;
            // 等待body
            await new Promise(res => {
                if (document.body) return res();
                const ob = new MutationObserver(() => {
                    if (document.body) { ob.disconnect(); res(); }
                });
                ob.observe(document.documentElement, { childList: true, subtree: true });
            });

            // 悬浮开关按钮
            this.toggleBtn = createElement('button', {
                id: 'm3u8‑sniffer‑toggle',
                style: {
                    position: 'fixed', bottom: '16px', left: '16px', width: '42px', height: '42px',
                    borderRadius: '50%', background: '#4caf50', border: 'none', zIndex: '999990',
                    fontWeight: 'bold', fontSize: '16px', boxShadow: '0 2px 8px #0004'
                }
            }, "S");

            // 主面板
            this.panel = createElement('div', {
                id: 'm3u8‑sniffer‑panel',
                style: {
                    position: 'fixed', bottom: '64px', left: '16px', width: 'min(320px, calc(100vw‑32px))',
                    background: 'rgba(0,0,0,0.85)', color: '#fff', borderRadius: '8px',
                    border: '1px solid #4caf50', zIndex: '999990', display: 'none', fontSize: '12px',
                    maxHeight: '70vh', overflow: 'hidden', backdropFilter: 'blur(4px)'
                }
            });
            const head = createElement('div', {
                style: { padding: '8px 10px', background: '#222', fontWeight: 'bold', color: '#4caf50' }
            }, "视频嗅探下载器");
            this.listEl = createElement('div', { style: { overflowY: 'auto', maxHeight: '400px' } });
            this.panel.appendChild(head);
            this.panel.appendChild(this.listEl);

            this.toggleBtn.onclick = () => {
                const hidden = this.panel.style.display === 'none';
                this.panel.style.display = hidden ? 'block' : 'none';
                this.toggleBtn.textContent = hidden ? "S" : "X";
            };

            document.body.appendChild(this.toggleBtn);
            document.body.appendChild(this.panel);
            this.render();
        }

        addResource({ url, type }) {
            const t = type === 'm3u8' ? 'm3u8' : 'mp4';
            const exist = this.resources.some(r => r.url === url);
            if (exist) return;
            this.resources.unshift({ url, type: t });
            this.render();
        }

        render() {
            this.listEl.innerHTML = '';
            if (this.resources.length === 0) {
                this.listEl.innerHTML = `<div style="padding:16px;text‑align:center;color:#888">等待捕获视频资源...</div>`;
                return;
            }
            this.resources.forEach((item, idx) => {
                item.id = item.id || ('r_' + idx + '_' + Math.random().toString(36).slice(2));
                const isOpen = this.openIndex === idx;
                const itemWrap = createElement('div', { style: { borderBottom: '1px solid #333' } });
                const titleRow = createElement('div', {
                    style: { padding: '8px 10px', cursor: 'pointer', display: 'flex', gap: '6px', alignItems: 'center' },
                    onclick: () => { this.openIndex = isOpen ? -1 : idx; this.render(); }
                });
                const tag = createElement('span', {
                    style: {
                        background: item.type === 'm3u8' ? '#4caf50' : '#2196F3',
                        color: '#000', padding: '1px 5px', borderRadius: '3px', fontSize: '10px', fontWeight: 'bold'
                    }
                }, item.type);
                const nameSpan = createElement('span', {
                    style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    title: item.url
                }, getFilename(item.url));
                titleRow.appendChild(tag);
                titleRow.appendChild(nameSpan);
                itemWrap.appendChild(titleRow);

                if (isOpen) {
                    const bodyWrap = createElement('div', { style: { padding: '10px', background: '#111' } });
                    // m3u8专属配置
                    if (item.type === 'm3u8') {
                        // 模式选择
                        const modeRow = createElement('div', { style: { display: 'flex', gap: '8px', marginBottom: '6px', flexWrap: 'wrap' } });
                        const radioTime = createElement('input', { type: 'radio', name: `dlmode_${item.id}`, value: 'time', checked: true });
                        const radioSeg = createElement('input', { type: 'radio', name: `dlmode_${item.id}`, value: 'seg' });
                        const radioMulti = createElement('input', { type: 'radio', name: `dlmode_${item.id}`, value: 'multi' });
                        modeRow.appendChild(createElement('label', { style: { whiteSpace: 'nowrap' } }, [radioTime, "时间"]));
                        modeRow.appendChild(createElement('label', { style: { whiteSpace: 'nowrap' } }, [radioSeg, "切片"]));
                        modeRow.appendChild(createElement('label', { style: { whiteSpace: 'nowrap' } }, [radioMulti, "多段"]));
                        bodyWrap.appendChild(modeRow);

                        const timeRow = createElement('div', { style: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '6px' } });
                        const inputTStart = createElement('input', { id: `tstart_${item.id}`, type: 'text', value: '00:00:00', style: { width: '90px', padding: '4px', background: '#222', color: '#fff', border: '1px solid #444' } });
                        const inputTEnd = createElement('input', { id: `tend_${item.id}`, type: 'text', style: { width: '90px', padding: '4px', background: '#222', color: '#fff', border: '1px solid #444' } });
                        timeRow.appendChild(createElement('span', {}, "时间:"));
                        timeRow.appendChild(inputTStart);
                        timeRow.appendChild(createElement('span', {}, "‑"));
                        timeRow.appendChild(inputTEnd);
                        bodyWrap.appendChild(timeRow);

                        const segRow = createElement('div', { style: { display: 'none', gap: '4px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '6px' } });
                        const inputSStart = createElement('input', { id: `sstart_${item.id}`, type: 'number', value: '0', style: { width: '60px', padding: '4px', background: '#222', color: '#fff', border: '1px solid #444' } });
                        const inputSEnd = createElement('input', { id: `send_${item.id}`, type: 'number', style: { width: '60px', padding: '4px', background: '#222', color: '#fff', border: '1px solid #444' } });
                        segRow.appendChild(createElement('span', {}, "切片:"));
                        segRow.appendChild(inputSStart);
                        segRow.appendChild(createElement('span', {}, "‑"));
                        segRow.appendChild(inputSEnd);
                        bodyWrap.appendChild(segRow);

                        // 多段模式UI
                        const multiRow = createElement('div', { style: { display: 'none', marginBottom: '6px' } });
                        const segListContainer = createElement('div', { id: `seglist_${item.id}`, style: { maxHeight: '120px', overflowY: 'auto', background: '#0a0a0a', borderRadius: '4px', padding: '4px', marginBottom: '4px', fontSize: '11px' } });
                        segListContainer.innerHTML = '<div style="color:#666;padding:4px">暂无时间段，点击下方按钮添加</div>';
                        const multiBtnRow = createElement('div', { style: { display: 'flex', gap: '4px' } });
                        const addSegBtn = createElement('button', { style: { flex: 1, padding: '4px', background: '#2196F3', border: 'none', color: '#fff', borderRadius: '3px', fontSize: '11px' } }, "➕ 预览添加时间段");
                        const clearSegBtn = createElement('button', { style: { padding: '4px 8px', background: '#f44336', border: 'none', color: '#fff', borderRadius: '3px', fontSize: '11px' } }, "🗑 清空");
                        multiBtnRow.appendChild(addSegBtn);
                        multiBtnRow.appendChild(clearSegBtn);
                        multiRow.appendChild(segListContainer);
                        multiRow.appendChild(multiBtnRow);
                        bodyWrap.appendChild(multiRow);

                        // 存储多段数据
                        item._cutSegments = [];
                        item._parsedM3u8 = null;

                        addSegBtn.onclick = async () => {
                            try {
                                if (!item._parsedM3u8) {
                                    addSegBtn.textContent = '解析中...';
                                    item._parsedM3u8 = await parseM3u8(item.url);
                                    addSegBtn.textContent = '➕ 预览添加时间段';
                                }
                                const res = await openPreviewSelectSegment(item.url);
                                if (res) {
                                    const { startIdx, endIdx } = timeToSegmentIndex(item._parsedM3u8.timeList, res.startSec, res.endSec);
                                    item._cutSegments.push({
                                        id: 'seg_' + Math.random().toString(36).slice(2, 6),
                                        startSec: res.startSec,
                                        endSec: res.endSec,
                                        startIdx,
                                        endIdx,
                                        duration: res.endSec - res.startSec
                                    });
                                    renderSegList(item.id, item._cutSegments);
                                }
                            } catch (e) { alert("添加失败:" + e.message); }
                        };

                        clearSegBtn.onclick = () => {
                            item._cutSegments = [];
                            renderSegList(item.id, item._cutSegments);
                        };

                        function renderSegList(itemId, segments) {
                            const container = document.getElementById(`seglist_${itemId}`);
                            if (!container) return;
                            if (segments.length === 0) {
                                container.innerHTML = '<div style="color:#666;padding:4px">暂无时间段，点击下方按钮添加</div>';
                                return;
                            }
                            const totalDur = segments.reduce((sum, s) => sum + s.duration, 0);
                            const totalSegs = segments.reduce((sum, s) => sum + (s.endIdx - s.startIdx + 1), 0);
                            container.innerHTML = segments.map((seg, i) => `
                                <div style="display:flex;align-items:center;gap:4px;padding:3px 4px;border-bottom:1px solid #222">
                                    <span style="color:#4caf50;font-weight:bold">${i + 1}.</span>
                                    <span style="flex:1">${formatTimeHMS(seg.startSec)} → ${formatTimeHMS(seg.endSec)}</span>
                                    <span style="color:#888">${seg.duration.toFixed(1)}s</span>
                                    <button data-seg-id="${seg.id}" style="background:#f44336;border:none;color:#fff;border-radius:2px;padding:1px 5px;font-size:10px;cursor:pointer">×</button>
                                </div>
                            `).join('') + `<div style="color:#4caf50;padding:4px;font-weight:bold">合计: ${segments.length}段 | ${formatTimeHMS(totalDur)} | ~${totalSegs}分片</div>`;
                            container.querySelectorAll('[data-seg-id]').forEach(btn => {
                                btn.onclick = () => {
                                    item._cutSegments = item._cutSegments.filter(s => s.id !== btn.dataset.segId);
                                    renderSegList(itemId, item._cutSegments);
                                };
                            });
                        }

                        // 切换显示
                        [radioTime, radioSeg, radioMulti].forEach(r => {
                            r.addEventListener('change', () => {
                                timeRow.style.display = r.value === 'time' ? 'flex' : 'none';
                                segRow.style.display = r.value === 'seg' ? 'flex' : 'none';
                                multiRow.style.display = r.value === 'multi' ? 'block' : 'none';
                            });
                        });

                        // 预览选段按钮（单段模式）
                        const previewBtn = createElement('button', {
                            style: { width: '100%', padding: '6px', marginBottom: '6px', background: '#2196F3', border: 'none', color: '#fff', borderRadius: '4px' }
                        }, "🎬预览选择时间段");
                        previewBtn.onclick = async () => {
                            try {
                                const res = await openPreviewSelectSegment(item.url);
                                if (res) {
                                    inputTStart.value = res.startHms;
                                    inputTEnd.value = res.endHms;
                                    radioTime.checked = true;
                                    timeRow.style.display = 'flex';
                                    segRow.style.display = 'none';
                                    multiRow.style.display = 'none';
                                }
                            } catch (e) { alert("预览失败:" + e.message); }
                        };
                        bodyWrap.appendChild(previewBtn);
                    }

                    // 按钮行
                    const btnRow = createElement('div', { style: { display: 'flex', gap: '6px' } });
                    const copyBtn = createElement('button', { style: { flex: 1, padding: '6px', background: '#555', border: 'none', color: '#fff', borderRadius: '4px' } }, "复制链接");
                    const dlBtn = createElement('button', { style: { flex: 1, padding: '6px', background: '#4caf50', border: 'none', borderRadius: '4px', fontWeight: 'bold' } }, "开始下载");

                    copyBtn.onclick = async () => {
                        await copyToClipboard(item.url);
                        alert("链接已复制");
                    };

                    dlBtn.onclick = async () => {
                        const opt = {};
                        if (item.type === 'm3u8') {
                            const mode = document.querySelector(`input[name="dlmode_${item.id}"]:checked`).value;
                            if (mode === 'multi') {
                                if (!item._cutSegments || item._cutSegments.length === 0) {
                                    alert('请先添加时间段');
                                    return;
                                }
                                opt.ranges = item._cutSegments.map(s => ({ start: s.startSec, end: s.endSec }));
                            } else if (mode === 'time') {
                                const tS = document.getElementById(`tstart_${item.id}`).value;
                                const tE = document.getElementById(`tend_${item.id}`).value;
                                if (tS && tE) {
                                    opt.beginSec = toSeconds(tS);
                                    opt.endSec = toSeconds(tE);
                                }
                            } else {
                                opt.startIdx = parseInt(document.getElementById(`sstart_${item.id}`).value);
                                opt.endIdx = parseInt(document.getElementById(`send_${item.id}`).value);
                            }
                        }
                        await window.TaskRunner(item.url, item.type, dlBtn, opt);
                    };
                    btnRow.appendChild(copyBtn);
                    btnRow.appendChild(dlBtn);
                    bodyWrap.appendChild(btnRow);
                    itemWrap.appendChild(bodyWrap);
                }
                this.listEl.appendChild(itemWrap);
            });
        }
    }

    // 启动
    const sniffer = new Sniffer();
    sniffer.start();
    const ui = new SimpleUI();
    ui.init();
})();