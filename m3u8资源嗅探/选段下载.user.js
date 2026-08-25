// ==UserScript==
// @name         m3u8可视化拖拽选段下载
// @namespace    http://tampermonkey.net/
// @version      6.3
// @description  全新UI设计；网页m3u8嗅探、全屏选段工作台、可视化拖拽选段、AES-128解密、分片拼接TS、手机电脑通用
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
    // AES-128解密
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
                m3u8: /\.m3u8($|\?)|application\/.*mpegurl/i
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
                    Bus.emit('video-found', { url, type });
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
                let contentType = req.headers.get('content-type') || '';
                const resp = await originalFetch.apply(win, args);
                // 优先读取响应头，捕获m3u8
                try {
                    const ctype = resp.headers.get('content-type');
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
                                const ctype = this.getResponseHeader('content-type');
                                self.detect(finalUrl, ctype);
                                // 额外：部分接口直接返回m3u8文本
                                if (typeof this.responseText === 'string' && this.responseText.includes('#EXTM3U')) {
                                    self.detect(finalUrl, 'application/x-mpegurl');
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
            const pcrBase = buf[offset] * 0x02000000
                + (buf[offset + 1] << 17)
                + (buf[offset + 2] << 9)
                + (buf[offset + 3] << 1)
                + (buf[offset + 4] >> 7);
            const pcrExt = ((buf[offset + 4] & 0x1F) << 4) | ((buf[offset + 5] >> 3) & 0x0F);
            return pcrBase * 300 + pcrExt;
        },

        writePCR(buf, offset, pcrValue) {
            let pcrBase = Math.floor(pcrValue / 300);
            const pcrExt = pcrValue % 300;
            const highByte = Math.floor(pcrBase / 0x02000000);
            const remainder = pcrBase - highByte * 0x02000000;
            buf[offset] = highByte & 0xFF;
            buf[offset + 1] = (remainder >> 17) & 0xFF;
            buf[offset + 2] = (remainder >> 9) & 0xFF;
            buf[offset + 3] = (remainder >> 1) & 0xFF;
            buf[offset + 4] = ((remainder & 0x01) << 7) | (pcrExt >> 4) | 0x60;
            buf[offset + 5] = (pcrExt & 0x0F) << 3 | 0x07;
        },

        readPTS(buf, offset) {
            const b0 = buf[offset];
            const b1 = buf[offset + 1];
            const b2 = buf[offset + 2];
            const b3 = buf[offset + 3];
            const b4 = buf[offset + 4];
            const pts = (b0 & 0x0E) * 0x20000000
                + (b1 << 22)
                + ((b2 & 0xFE) << 13)
                + (b3 << 6)
                + (b4 >> 1);
            return pts;
        },

        writePTS(buf, offset, ptsValue) {
            const highBits = Math.floor(ptsValue / 0x20000000) & 0x07;
            const remainder = ptsValue - highBits * 0x20000000;
            buf[offset] = (buf[offset] & 0xF0) | (highBits << 1);
            buf[offset + 1] = (remainder >> 22) & 0xFF;
            buf[offset + 2] = ((remainder >> 14) & 0xFE) | 0x01;
            buf[offset + 3] = (remainder >> 7) & 0xFF;
            buf[offset + 4] = ((remainder << 1) & 0xFE) | 0x01;
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
            for (let i = 0; i + this.TS_PACKET_SIZE <= len; i += this.TS_PACKET_SIZE) {
                if (data[i] !== this.SYNC_BYTE) continue;
                const hasAdaptation = (data[i + 3] & 0x20) !== 0;
                const hasPayload = (data[i + 3] & 0x10) !== 0;
                if (hasAdaptation) {
                    const adaptationOffset = i + 4;
                    const adaptationLength = data[adaptationOffset];
                    if (adaptationLength > 0 && adaptationOffset + 1 + adaptationLength <= i + this.TS_PACKET_SIZE) {
                        const pcrFlag = (data[adaptationOffset + 1] >> 4) & 0x01;
                        if (pcrFlag) {
                            const pcrOffset = adaptationOffset + 2;
                            const pcr = this.readPCR(data, pcrOffset);
                            this.writePCR(data, pcrOffset, pcr + offset);
                        }
                    }
                }
                if (hasPayload) {
                    const payloadUnitStart = (data[i + 1] >> 6) & 0x01;
                    let payloadOffset = i + 4;
                    if (hasAdaptation) {
                        const adaptationLength = data[payloadOffset];
                        payloadOffset += 1 + adaptationLength;
                    }
                    if (payloadUnitStart && payloadOffset + 6 <= len) {
                        const streamId = data[payloadOffset];
                        if (streamId === 0xBD || (streamId >= 0xC0 && streamId <= 0xDF) || (streamId >= 0xE0 && streamId <= 0xEF)) {
                            const ptsDtsFlag = (data[payloadOffset + 3] >> 6) & 0x03;
                            const ptsOffset = payloadOffset + 3;
                            if ((ptsDtsFlag & 0x02) && ptsOffset + 5 <= len) {
                                const pts = this.readPTS(data, ptsOffset + 1);
                                this.writePTS(data, ptsOffset + 1, pts + offset);
                            }
                            if (ptsDtsFlag === 0x03 && ptsOffset + 10 <= len) {
                                const dtsOffset = ptsOffset + 5;
                                const dts = this.readPTS(data, dtsOffset);
                                this.writePTS(data, dtsOffset, dts + offset);
                            }
                        }
                    }
                }
            }
            return data;
        },

        fixTimestamps(buffers) {
            if (buffers.length === 0) return new Uint8Array(0);
            if (buffers.length === 1) return buffers[0];

            const fixedBuffers = [];
            let baseTime = null;
            let totalOffset = 0;

            for (let i = 0; i < buffers.length; i++) {
                const buf = buffers[i];
                const { firstPCR, lastPCR } = this.getPCRRanges(buf);

                if (firstPCR === null) {
                    fixedBuffers.push(buf);
                    continue;
                }

                if (baseTime === null) {
                    totalOffset = -firstPCR;
                    const fixedBuf = this.applyTimestampOffset(buf, totalOffset);
                    fixedBuffers.push(fixedBuf);
                    baseTime = lastPCR + totalOffset;
                } else {
                    const offset = baseTime - firstPCR;
                    totalOffset += offset;
                    const fixedBuf = this.applyTimestampOffset(buf, offset);
                    fixedBuffers.push(fixedBuf);
                    baseTime = lastPCR + offset;
                }
            }

            const totalSize = fixedBuffers.reduce((sum, b) => sum + b.length, 0);
            const result = new Uint8Array(totalSize);
            let pos = 0;
            for (const fb of fixedBuffers) {
                result.set(fb, pos);
                pos += fb.length;
            }

            console.log(`[TSPacketFixer] 时间戳修复完成: ${fixedBuffers.length}个分片, 总偏移${(totalOffset / this.PCR_TIMEBASE).toFixed(2)}s`);
            return result;
        }
    };

    // ==========================================
    // 文件写入器
    // ==========================================
    class VideoWriter {
        constructor() {
            this.fixedBuffers = [];
            this.totalSize = 0;
        }
        addFixedBuffer(data) {
            const uint8 = data instanceof Uint8Array ? data : new Uint8Array(data);
            this.fixedBuffers.push(uint8);
            this.totalSize += uint8.length;
        }
        async close(filename) {
            if (this.fixedBuffers.length === 0) {
                alert('分片数据为空，无法保存');
                return;
            }
            const blob = new Blob(this.fixedBuffers, { type: 'video/mp2t' });
            downloadBlob(blob, filename.replace(/\.zip$/i, '.ts'));
        }
    }

    // ==========================================
    // 多段写入器（按时间段生成多个TS文件）
    // ==========================================
    class MultiSegmentWriter {
        constructor() {
            this.segments = [];
        }
        addSegment(name, fixedBuffers) {
            this.segments.push({ name, fixedBuffers });
        }
        async saveAll(baseFilename) {
            if (this.segments.length === 0) {
                alert('分片数据为空，无法保存');
                return;
            }
            for (let i = 0; i < this.segments.length; i++) {
                const seg = this.segments[i];
                const blob = new Blob(seg.fixedBuffers, { type: 'video/mp2t' });
                const finalName = this.segments.length === 1
                    ? baseFilename.replace(/\.zip$/i, '.ts')
                    : baseFilename.replace(/\.(ts|zip)$/i, '') + `_part${i + 1}.ts`;
                downloadBlob(blob, finalName);
                if (i < this.segments.length - 1) {
                    await sleep(500);
                }
            }
        }
    }

    // ==========================================
    // M3U8解析
    // ==========================================
    async function parseM3u8(url) {
        let content = await gmRequest(url);
        // 处理多级m3u8
        if (content.includes('#EXT-X-STREAM-INF')) {
            const lines = content.split('\n');
            let bestBandwidth = 0;
            let bestUrl = null;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
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
            if (l.startsWith('#EXT-X-KEY')) {
                const method = (l.match(/METHOD=([^,]+)/) || [])[1];
                const uri = (l.match(/URI="([^"]+)"/) || [])[1];
                const ivHex = (l.match(/IV=(0x[\da-f]+)/i) || [])[1];
                if (method === 'AES-128' && uri) {
                    currentKey = resolveUrl(url, uri);
                    currentIV = ivHex ? AESCrypto.hexToBytes(ivHex) : null;
                }
            } else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
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
        const total = segmentIndices ? segmentIndices.length : segments.length;
        const CONCURRENCY = 6;
        const MAX_RETRIES = 3;
        const results = new Array(total);
        let completed = 0;
        const progressMap = new Array(total).fill(0);

        function updateProgress() {
            const avgProgress = progressMap.reduce((a, b) => a + b, 0) / total;
            const doneCount = progressMap.filter(p => p >= 1).length;
            const totalBytes = results.reduce((sum, r) => sum + (r ? r.length : 0), 0);
            onProgress(avgProgress * 100, `${(avgProgress * 100).toFixed(1)}% | ${doneCount}/${total} | ${formatBytes(totalBytes)}`);
        }

        async function downloadOne(idx) {
            const segIdx = segmentIndices ? segmentIndices[idx] : idx;
            const seg = segments[segIdx];
            let lastError = null;

            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                try {
                    if (attempt > 0) {
                        const backoff = Math.pow(2, attempt - 1) * 1000;
                        console.warn(`[重试 ${attempt}/${MAX_RETRIES}] 分片${idx}, 等待${backoff}ms`);
                        await sleep(backoff);
                    }
                    const data = await gmRequest(seg.url, true, (loaded, totalSize) => {
                        progressMap[idx] = totalSize ? loaded / totalSize : 0.5;
                        updateProgress();
                    });
                    let decrypted = new Uint8Array(data);
                    if (seg.key) {
                        const key = keyCache.get(seg.key);
                        if (key) {
                            const iv = seg.iv || AESCrypto.sequenceToIV(seg.seq);
                            const ret = await AESCrypto.decrypt(decrypted, key, iv);
                            if (ret) decrypted = ret;
                        }
                    }
                    results[idx] = decrypted;
                    progressMap[idx] = 1;
                    completed++;
                    updateProgress();
                    return;
                } catch (e) {
                    lastError = e;
                    if (attempt >= MAX_RETRIES) {
                        console.error(`[下载失败] 分片${idx} (已重试${MAX_RETRIES}次):`, e);
                        results[idx] = new Uint8Array(0);
                        progressMap[idx] = 1;
                        completed++;
                        updateProgress();
                    }
                }
            }
        }

        for (let i = 0; i < total; i += CONCURRENCY) {
            const batch = [];
            for (let j = i; j < Math.min(i + CONCURRENCY, total); j++) {
                batch.push(downloadOne(j));
            }
            await Promise.all(batch);
        }

        // 增量时间戳修复 + 写入（边下边修复，避免累积大 buffer）
        let baseTime = null;
        for (let i = 0; i < total; i++) {
            const buf = results[i];
            if (!buf || buf.length === 0) continue;

            const { firstPCR, lastPCR } = TSPacketFixer.getPCRRanges(buf);

            if (firstPCR === null) {
                writer.addFixedBuffer(buf);
                continue;
            }

            if (baseTime === null) {
                const offset = -firstPCR;
                TSPacketFixer.applyTimestampOffset(buf, offset);
                writer.addFixedBuffer(buf);
                baseTime = lastPCR + offset;
            } else {
                const offset = baseTime - firstPCR;
                TSPacketFixer.applyTimestampOffset(buf, offset);
                writer.addFixedBuffer(buf);
                baseTime = lastPCR + offset;
            }
        }
    }

    // ==========================================
    // 下载任务入口
    // ==========================================
    window.TaskRunner = async function (url, type, btn, opt = {}) {
        const originText = btn.textContent;
        const safeName = getSafeFileName();
        const filename = safeName + '.ts';
        try {
            btn.textContent = "解析m3u8...";
            const parseRet = await parseM3u8(url);

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

            // 多时间段并发下载，下完一段立即保存
            if (opt.ranges && opt.ranges.length > 0) {
                const downloadTasks = opt.ranges.map((range, i) => {
                    const mapped = timeToSegmentIndex(parseRet.timeList, range.start, range.end);
                    const rangeIndices = [];
                    for (let j = mapped.startIdx; j <= mapped.endIdx; j++) {
                        if (!rangeIndices.includes(j)) rangeIndices.push(j);
                    }
                    return { index: i, rangeIndices, start: range.start, end: range.end };
                });

                btn.textContent = `并发下载 ${downloadTasks.length} 段中...`;
                const allWriters = new Array(downloadTasks.length);

                // 并发下载
                const promises = downloadTasks.map(async (task) => {
                    const rangeWriter = new VideoWriter();
                    await downloadM3u8BySegments(parseRet.segments, keyCache, (p, txt) => {
                        btn.textContent = `段${task.index + 1}: ${txt}`;
                    }, rangeWriter, task.rangeIndices);
                    allWriters[task.index] = rangeWriter;
                    // 该段下载完，立即触发保存
                    const segFilename = downloadTasks.length === 1
                        ? filename.replace(/\.zip$/i, '.ts')
                        : filename.replace(/\.zip$/i, '').replace(/\.[^.]+$/, '') + `_part${task.index + 1}.ts`;
                    await rangeWriter.close(segFilename);
                    console.log(`✅ 段${task.index + 1} 已保存`);
                });

                await Promise.all(promises);
                btn.textContent = `✅下载完成(${downloadTasks.length}段)`;
            } else {
                // 全量下载
                const writer = new VideoWriter();
                btn.textContent = "分片下载中";
                await downloadM3u8BySegments(parseRet.segments, keyCache, (p, txt) => { btn.textContent = txt; }, writer, null);
                btn.textContent = "保存文件";
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
    // 全屏选段工作台弹窗
    // ==========================================
    async function openPreviewSelectSegment(m3u8Url, existingSegments = []) {
        await loadHlsScript();
        const parseRet = await parseM3u8(m3u8Url);
        const totalDuration = parseRet.totalDuration;

        const overlay = createElement('div', {
            id: 'm3u8-slider',
            style: {
                position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
                background: '#0a0a0a', zIndex: '999999', overflowY: 'auto',
                display: 'flex', flexDirection: 'column'
            }
        });

        const sliderStyle = createElement('style', {}, `
            #m3u8-slider input[type="range"] {
                -webkit-appearance: none;
                appearance: none;
                width: 100%;
                height: 6px;
                background: #555;
                border-radius: 3px;
                outline: none;
                cursor: pointer;
            }
            #m3u8-slider input[type="range"]::-webkit-slider-thumb {
                -webkit-appearance: none;
                appearance: none;
                width: 16px;
                height: 16px;
                background: #000;
                border: 2px solid #fff;
                border-radius: 50%;
                cursor: pointer;
                box-shadow: 0 1px 4px rgba(0,0,0,0.5);
            }
            #m3u8-slider input[type="range"]::-moz-range-thumb {
                width: 16px;
                height: 16px;
                background: #000;
                border: 2px solid #fff;
                border-radius: 50%;
                cursor: pointer;
                box-shadow: 0 1px 4px rgba(0,0,0,0.5);
            }
        `);
        overlay.appendChild(sliderStyle);

        const header = createElement('div', {
            style: {
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '12px 16px', background: 'linear-gradient(90deg,#1b5e20,#2e7d32)',
                color: '#fff', position: 'sticky', top: 0, zIndex: 10
            }
        }, [
            createElement('span', { style: { fontSize: '16px', fontWeight: 'bold' } }, `📺 视频选段工作台`),
            createElement('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } }, [
                createElement('span', { style: { fontSize: '13px', opacity: 0.9 } }, `${existingSegments.length} 段已选`),
                createElement('button', {
                    style: {
                        background: 'none', border: 'none', color: '#fff',
                        fontSize: '20px', cursor: 'pointer', padding: '0 4px'
                    }
                }, "✕")
            ])
        ]);

        const mainContent = createElement('div', {
            style: { flex: 1, padding: '16px', color: '#fff', maxWidth: '800px', margin: '0 auto', width: '100%', boxSizing: 'border-box' }
        });

        const videoWrap = createElement('div', {
            style: { background: '#000', borderRadius: '8px', overflow: 'hidden', marginBottom: '16px' }
        });
        const video = createElement('video', {
            controls: true, autoplay: true, playsinline: true,
            style: { width: '100%', maxHeight: '45vh', display: 'block', background: '#000' }
        });
        videoWrap.appendChild(video);

        let hlsInst = null;
        if (Hls.isSupported()) {
            hlsInst = new Hls();
            hlsInst.loadSource(m3u8Url);
            hlsInst.attachMedia(video);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = m3u8Url;
        }

        let startSec = Math.min(30, totalDuration);
        let endSec = totalDuration;
        const sliderMax = Math.ceil(totalDuration);
        let activeSlider = 'end';

        const infoRow = createElement('div', {
            style: {
                display: 'flex', justifyContent: 'space-between',
                padding: '10px 14px', background: '#1a1a1a', borderRadius: '6px',
                marginBottom: '16px', fontSize: '13px', color: '#ccc'
            }
        }, [
            createElement('span', {}, `总时长：${formatTimeHMS(totalDuration)}`),
            createElement('span', {}, `${parseRet.segments.length} 分片`),
            createElement('span', { style: { color: '#4caf50' } }, `已选：${formatTimeHMS(endSec - startSec)}`)
        ]);

        const startSection = createElement('div', { style: { marginBottom: '18px' } });
        const startLabel = createElement('div', { style: { fontSize: '14px', color: '#aaa', marginBottom: '8px' } }, `起始：${formatTimeHMS(startSec)}`);
        const startSlider = createElement('input', {
            type: 'range',
            min: '0',
            max: String(sliderMax),
            step: '0.5',
            value: String(startSec),
            style: { width: '100%' }
        });
        startSection.appendChild(startLabel);
        startSection.appendChild(startSlider);

        const endSection = createElement('div', { style: { marginBottom: '20px' } });
        const endLabel = createElement('div', { style: { fontSize: '14px', color: '#aaa', marginBottom: '8px' } }, `结束：${formatTimeHMS(endSec)}`);
        const endSlider = createElement('input', {
            type: 'range',
            min: '0',
            max: String(sliderMax),
            step: '0.5',
            value: String(endSec),
            style: { width: '100%' }
        });
        endSection.appendChild(endLabel);
        endSection.appendChild(endSlider);

        function updateSliderPositions() {
            startSlider.value = String(startSec);
            endSlider.value = String(endSec);
            startLabel.textContent = `起始：${formatTimeHMS(startSec)}`;
            endLabel.textContent = `结束：${formatTimeHMS(endSec)}`;
            updateInfoRow();
        }

        startSlider.oninput = () => {
            activeSlider = 'start';
            let val = parseFloat(startSlider.value);
            startSec = Math.max(0, Math.min(val, endSec));
            startLabel.textContent = `起始：${formatTimeHMS(startSec)}`;
            video.currentTime = startSec;
            updateInfoRow();
        };

        endSlider.oninput = () => {
            activeSlider = 'end';
            let val = parseFloat(endSlider.value);
            endSec = Math.max(startSec, Math.min(val, sliderMax));
            endLabel.textContent = `结束：${formatTimeHMS(endSec)}`;
            video.currentTime = endSec;
            updateInfoRow();
        };

        const quickBtnsContainer = createElement('div', {
            style: {
                display: 'flex',
                gap: '6px',
                marginBottom: '12px',
                justifyContent: 'center'
            }
        });

        const quickBtns = [
            { label: '-5min', delta: -300 },
            { label: '-1min', delta: -60 },
            { label: '-10s', delta: -10 },
            { label: '+10s', delta: 10 },
            { label: '+1min', delta: 60 },
            { label: '+5min', delta: 300 }
        ];

        quickBtns.forEach(btn => {
            const button = createElement('button', {
                style: {
                    padding: '4px 8px',
                    background: '#333',
                    color: '#fff',
                    border: '1px solid #555',
                    borderRadius: '4px',
                    fontSize: '11px',
                    cursor: 'pointer',
                    transition: 'background 0.2s'
                },
                onmouseover: (e) => { e.target.style.background = '#444'; },
                onmouseout: (e) => { e.target.style.background = '#333'; }
            }, btn.label);

            button.onclick = () => {
                if (activeSlider === 'start') {
                    startSec = Math.max(0, Math.min(startSec + btn.delta, endSec));
                    startSlider.value = String(startSec);
                    startLabel.textContent = `起始：${formatTimeHMS(startSec)}`;
                    video.currentTime = startSec;
                } else {
                    endSec = Math.max(startSec, Math.min(endSec + btn.delta, sliderMax));
                    endSlider.value = String(endSec);
                    endLabel.textContent = `结束：${formatTimeHMS(endSec)}`;
                    video.currentTime = endSec;
                }
                updateInfoRow();
            };

            quickBtnsContainer.appendChild(button);
        });

        const hint = createElement('div', {
            style: {
                fontSize: '11px',
                color: '#666',
                textAlign: 'center',
                marginBottom: '12px'
            }
        }, '💡 拖动滑块选择范围，点击快捷按钮调整时间');

        function updateInfoRow() {
            infoRow.children[2].textContent = `已选：${formatTimeHMS(endSec - startSec)} `;
        }

        const addBtn = createElement('button', {
            style: {
                width: '100%', padding: '12px',
                background: 'linear-gradient(135deg,#4caf50,#45a049)',
                color: '#fff', border: 'none', borderRadius: '8px',
                fontSize: '15px', fontWeight: 'bold', cursor: 'pointer',
                marginBottom: '24px',
                boxShadow: '0 2px 8px rgba(76,175,80,0.3)',
                transition: 'transform 0.1s, box-shadow 0.2s'
            },
            onmouseover: (e) => {
                e.target.style.transform = 'translateY(-1px)';
                e.target.style.boxShadow = '0 4px 12px rgba(76,175,80,0.4)';
            },
            onmouseout: (e) => {
                e.target.style.transform = 'translateY(0)';
                e.target.style.boxShadow = '0 2px 8px rgba(76,175,80,0.3)';
            }
        }, "✅ 添加到列表");

        const segSection = createElement('div', {
            style: { borderTop: '1px solid #333', paddingTop: '16px', marginBottom: '20px' }
        });
        const segTitle = createElement('div', {
            style: {
                textAlign: 'center', fontSize: '12px', color: '#888',
                marginBottom: '12px',
                display: 'flex', alignItems: 'center', gap: '10px',
                justifyContent: 'center'
            }
        }, [
            createElement('span', { style: { flex: 1, height: '1px', background: '#333' } }),
            createElement('span', {}, `── 已选时间段(${existingSegments.length}段) ──`),
            createElement('span', { style: { flex: 1, height: '1px', background: '#333' } })
        ]);

        const segListContainer = createElement('div', {
            style: {
                background: '#111', borderRadius: '8px', padding: '12px',
                maxHeight: '200px', overflowY: 'auto'
            }
        });

        function renderSegList(segments) {
            segListContainer.innerHTML = '';
            if (segments.length === 0) {
                segListContainer.innerHTML = '<div style="color:#666;padding:12px;text-align:center;font-size:13px">暂无时间段，拖拽滑块选择后添加</div>';
                return;
            }
            segments.forEach((seg, i) => {
                const row = createElement('div', {
                    style: {
                        display: 'flex', alignItems: 'center', gap: '8px',
                        padding: '8px 12px', background: '#1a1a1a',
                        borderRadius: '6px', marginBottom: '6px',
                        borderLeft: '3px solid #4caf50'
                    }
                }, [
                    createElement('span', { style: { color: '#4caf50', fontWeight: 'bold', minWidth: '24px' } }, `${i + 1}.`),
                    createElement('span', { style: { flex: 1, fontSize: '13px' } }, `${formatTimeHMS(seg.startSec)} → ${formatTimeHMS(seg.endSec)} `),
                    createElement('span', { style: { color: '#888', fontSize: '12px' } }, `${seg.duration.toFixed(1)} s`),
                    createElement('button', {
                        style: {
                            background: 'rgba(244,67,54,0.2)', border: 'none',
                            color: '#f44336', borderRadius: '4px',
                            padding: '4px 8px', cursor: 'pointer',
                            fontSize: '14px', lineHeight: 1
                        }
                    }, "✕")
                ]);
                row.children[3].onclick = () => {
                    const idx = existingSegments.findIndex(s => s.id === seg.id);
                    if (idx >= 0) existingSegments.splice(idx, 1);
                    renderSegList(existingSegments);
                    segTitle.children[1].textContent = `── 已选时间段(${existingSegments.length}段) ──`;
                };
                segListContainer.appendChild(row);
            });
        }

        renderSegList(existingSegments);

        const bottomBar = createElement('div', {
            style: {
                display: 'flex', gap: '12px',
                padding: '16px', background: '#1a1a1a',
                borderRadius: '8px'
            }
        }, [
            createElement('button', {
                style: {
                    flex: 1, padding: '12px',
                    background: '#333', color: '#ccc',
                    border: 'none', borderRadius: '6px',
                    fontSize: '14px', cursor: 'pointer'
                }
            }, "🗑 清空"),
            createElement('button', {
                style: {
                    flex: 2, padding: '12px',
                    background: 'linear-gradient(135deg,#2196f3,#1976d2)',
                    color: '#fff', border: 'none', borderRadius: '6px',
                    fontSize: '14px', fontWeight: 'bold',
                    cursor: 'pointer',
                    boxShadow: '0 2px 8px rgba(33,150,243,0.3)'
                }
            }, `📥 开始下载(${existingSegments.length})`)
        ]);

        mainContent.appendChild(videoWrap);
        mainContent.appendChild(infoRow);
        mainContent.appendChild(startSection);
        mainContent.appendChild(endSection);
        mainContent.appendChild(quickBtnsContainer);
        mainContent.appendChild(hint);
        mainContent.appendChild(addBtn);
        mainContent.appendChild(segSection);
        segSection.appendChild(segTitle);
        segSection.appendChild(segListContainer);
        mainContent.appendChild(bottomBar);

        overlay.appendChild(header);
        overlay.appendChild(mainContent);
        document.body.appendChild(overlay);

        function closeOverlay() {
            if (hlsInst) hlsInst.destroy();
            overlay.remove();
        }

        addBtn.onclick = () => {
            const newSeg = {
                id: 'seg_' + Math.random().toString(36).slice(2, 6),
                startSec: startSec,
                endSec: endSec,
                duration: endSec - startSec
            };
            existingSegments.push(newSeg);
            renderSegList(existingSegments);
            segTitle.children[1].textContent = `── 已选时间段(${existingSegments.length}段) ──`;
            header.children[1].children[0].textContent = `${existingSegments.length} 段已选`;
            return newSeg;
        };

        return new Promise((resolve) => {
            bottomBar.children[0].onclick = () => {
                existingSegments.length = 0;
                renderSegList(existingSegments);
                segTitle.children[1].textContent = `── 已选时间段(0段) ──`;
                header.children[1].children[0].textContent = `0 段已选`;
            };

            bottomBar.children[1].onclick = () => {
                if (existingSegments.length === 0) {
                    alert('请先添加时间段');
                    return;
                }
                closeOverlay();
                resolve({ segments: [...existingSegments], confirmed: true });
            };

            header.children[1].children[1].onclick = () => {
                closeOverlay();
                resolve({ segments: [...existingSegments], confirmed: false });
            };
        });
    }

    // ==========================================
    // 主面板（资源列表）
    // ==========================================
    class SimpleUI {
        constructor() {
            this.resources = [];
            this.openId = null;
            this.panel = null;
            this.toggleBtn = null;
            this.listEl = null;
            Bus.on('video-found', (d) => this.addResource(d));
        }

        async init() {
            if (document.querySelector('#m3u8-sniffer-panel')) return;
            await new Promise(res => {
                if (document.body) return res();
                const ob = new MutationObserver(() => {
                    if (document.body) { ob.disconnect(); res(); }
                });
                ob.observe(document.documentElement, { childList: true, subtree: true });
            });

            this.toggleBtn = createElement('button', {
                id: 'm3u8-sniffer-toggle',
                style: {
                    position: 'fixed', bottom: '16px', left: '16px', width: '48px', height: '48px',
                    borderRadius: '50%',
                    background: 'linear-gradient(135deg,#4caf50,#2e7d32)',
                    border: 'none', zIndex: '999990',
                    fontWeight: 'bold', fontSize: '18px',
                    boxShadow: '0 4px 16px rgba(76,175,80,0.4)',
                    color: '#fff', cursor: 'pointer',
                    transition: 'transform 0.15s, box-shadow 0.2s'
                },
                onmouseover: (e) => {
                    e.target.style.transform = 'scale(1.05)';
                    e.target.style.boxShadow = '0 6px 20px rgba(76,175,80,0.5)';
                },
                onmouseout: (e) => {
                    e.target.style.transform = 'scale(1)';
                    e.target.style.boxShadow = '0 4px 16px rgba(76,175,80,0.4)';
                }
            }, "🎬");

            this.panel = createElement('div', {
                id: 'm3u8-sniffer-panel',
                style: {
                    position: 'fixed', bottom: '74px', left: '16px',
                    width: 'min(380px, calc(100vw - 32px))',
                    background: 'rgba(20, 20, 20, 0.95)',
                    color: '#fff',
                    borderRadius: '12px',
                    border: '1px solid rgba(76,175,80,0.3)',
                    zIndex: '999990',
                    display: 'none',
                    fontSize: '12px',
                    maxHeight: '75vh',
                    overflow: 'hidden',
                    backdropFilter: 'blur(10px)',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
                }
            });

            this.countEl = createElement('span', {
                style: {
                    fontSize: '12px',
                    opacity: 0.9,
                    background: 'rgba(255,255,255,0.15)',
                    padding: '2px 10px',
                    borderRadius: '10px'
                }
            }, "0 个资源");

            const head = createElement('div', {
                style: {
                    padding: '12px 14px',
                    background: 'linear-gradient(90deg,#1b5e20,#2e7d32)',
                    fontWeight: 'bold',
                    color: '#fff',
                    borderRadius: '12px 12px 0 0',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                }
            }, [
                createElement('span', { style: { fontSize: '14px' } }, "🎬 视频嗅探下载器"),
                this.countEl
            ]);

            this.listEl = createElement('div', {
                style: {
                    overflowY: 'auto',
                    maxHeight: '420px',
                    padding: '4px 0'
                }
            });

            this.panel.appendChild(head);
            this.panel.appendChild(this.listEl);

            this.toggleBtn.onclick = () => {
                const hidden = this.panel.style.display === 'none';
                this.panel.style.display = hidden ? 'block' : 'none';
                this.toggleBtn.textContent = hidden ? "🎬" : "×";
            };

            document.body.appendChild(this.toggleBtn);
            document.body.appendChild(this.panel);
            this.render();
        }

        addResource({ url, type }) {
            const exist = this.resources.some(r => r.url === url);
            if (exist) return;
            const id = 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
            this.resources.unshift({ id, url, type: 'm3u8', _cutSegments: [], _parsedM3u8: null });
            this.render();
        }

        render() {
            this.listEl.innerHTML = '';
            this.countEl.textContent = `${this.resources.length} 个资源`;
            if (this.resources.length === 0) {
                this.listEl.innerHTML = `
        < div style = "padding:30px 20px;text-align:center;color:#666" >
                        <div style="font-size:32px;margin-bottom:8px">🎬</div>
                        <div>等待捕获视频资源...</div>
                        <div style="font-size:11px;margin-top:6px;color:#555">播放视频时自动嗅探</div>
                    </div > `;
                return;
            }

            this.resources.forEach((item) => {
                const isOpen = this.openId === item.id;
                const segCount = item._cutSegments ? item._cutSegments.length : 0;
                const totalDur = segCount > 0
                    ? item._cutSegments.reduce((sum, s) => sum + s.duration, 0)
                    : 0;

                const itemWrap = createElement('div', {
                    style: {
                        borderBottom: '1px solid #2a2a2a',
                        background: isOpen ? '#1a1a1a' : 'transparent',
                        transition: 'background 0.15s'
                    }
                });

                const titleRow = createElement('div', {
                    style: {
                        padding: '10px 12px',
                        cursor: 'pointer',
                        display: 'flex',
                        gap: '8px',
                        alignItems: 'center'
                    },
                    onclick: () => { this.openId = isOpen ? null : item.id; this.render(); }
                });

                const tag = createElement('span', {
                    style: {
                        background: segCount > 0 ? '#ff9800' : '#4caf50',
                        color: '#000',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        fontSize: '10px',
                        fontWeight: 'bold',
                        flexShrink: '0'
                    }
                }, segCount > 0 ? `${segCount} 段` : 'm3u8');

                const nameSpan = createElement('span', {
                    style: {
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: '12px'
                    },
                    title: item.url
                }, getFilename(item.url));

                const arrow = createElement('span', {
                    style: {
                        fontSize: '10px',
                        color: '#666',
                        transition: 'transform 0.2s',
                        transform: isOpen ? 'rotate(90deg)' : 'none'
                    }
                }, isOpen ? '▼' : '▶');

                titleRow.appendChild(tag);
                titleRow.appendChild(nameSpan);
                titleRow.appendChild(arrow);
                itemWrap.appendChild(titleRow);

                if (isOpen) {
                    const bodyWrap = createElement('div', {
                        style: {
                            padding: '12px',
                            background: '#0f0f0f'
                        }
                    });

                    if (segCount > 0) {
                        const summaryBox = createElement('div', {
                            style: {
                                background: 'rgba(76,175,80,0.1)',
                                border: '1px solid rgba(76,175,80,0.3)',
                                borderRadius: '6px',
                                padding: '8px 12px',
                                marginBottom: '10px',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center'
                            }
                        }, [
                            createElement('span', { style: { color: '#4caf50', fontSize: '11px' } },
                                `📋 已选 ${segCount} 段 | ${formatTimeHMS(totalDur)} `),
                            createElement('span', { style: { color: '#888', fontSize: '10px' } },
                                item._cutSegments.every(c => c.startIdx != null && c.endIdx != null)
                                    ? `共${item._cutSegments.reduce((s, c) => s + (c.endIdx - c.startIdx + 1), 0)} 分片`
                                    : '分片数待解析')
                        ]);
                        bodyWrap.appendChild(summaryBox);
                    }

                    const btnRow = createElement('div', {
                        style: {
                            display: 'flex',
                            gap: '6px'
                        }
                    });

                    const segBtn = createElement('button', {
                        style: {
                            flex: 1,
                            padding: '8px',
                            background: 'linear-gradient(135deg,#2196f3,#1976d2)',
                            border: 'none',
                            color: '#fff',
                            borderRadius: '6px',
                            fontSize: '12px',
                            fontWeight: 'bold',
                            cursor: 'pointer',
                            boxShadow: '0 2px 6px rgba(33,150,243,0.3)',
                            transition: 'transform 0.1s'
                        },
                        onmouseover: (e) => { e.target.style.transform = 'translateY(-1px)'; },
                        onmouseout: (e) => { e.target.style.transform = 'translateY(0)'; }
                    }, segCount > 0 ? '🎬 继续选段' : '🎬 选段');

                    const copyBtn = createElement('button', {
                        style: {
                            padding: '8px 12px',
                            background: '#444',
                            border: 'none',
                            color: '#fff',
                            borderRadius: '6px',
                            fontSize: '12px',
                            cursor: 'pointer'
                        }
                    }, '复制');

                    const dlBtn = createElement('button', {
                        style: {
                            flex: 1,
                            padding: '8px',
                            background: segCount > 0
                                ? 'linear-gradient(135deg,#4caf50,#45a049)'
                                : '#333',
                            border: 'none',
                            color: '#fff',
                            borderRadius: '6px',
                            fontSize: '12px',
                            fontWeight: segCount > 0 ? 'bold' : 'normal',
                            cursor: segCount > 0 ? 'pointer' : 'not-allowed',
                            boxShadow: segCount > 0 ? '0 2px 6px rgba(76,175,80,0.3)' : 'none',
                            transition: 'transform 0.1s'
                        },
                        onmouseover: (e) => {
                            if (segCount > 0) e.target.style.transform = 'translateY(-1px)';
                        },
                        onmouseout: (e) => { e.target.style.transform = 'translateY(0)'; }
                    }, segCount > 0 ? `📥 下载(${segCount}段)` : '📥 下载');

                    segBtn.onclick = async () => {
                        try {
                            if (!item._parsedM3u8) {
                                segBtn.textContent = '解析中...';
                                item._parsedM3u8 = await parseM3u8(item.url);
                            }
                            const res = await openPreviewSelectSegment(item.url, item._cutSegments);
                            if (res && res.segments) {
                                item._cutSegments = res.segments.map(s => {
                                    const mapped = timeToSegmentIndex(item._parsedM3u8.timeList, s.startSec, s.endSec);
                                    return {
                                        ...s,
                                        startIdx: mapped.startIdx,
                                        endIdx: mapped.endIdx
                                    };
                                });
                                this.render();
                            }
                        } catch (e) {
                            alert("选段失败: " + e.message);
                        }
                    };

                    copyBtn.onclick = async () => {
                        await copyToClipboard(item.url);
                        alert("链接已复制");
                    };

                    dlBtn.onclick = async () => {
                        if (!item._cutSegments || item._cutSegments.length === 0) {
                            alert('请先点击"🎬 选段"添加时间段');
                            return;
                        }
                        const opt = {
                            ranges: item._cutSegments.map(s => ({ start: s.startSec, end: s.endSec }))
                        };
                        await window.TaskRunner(item.url, 'm3u8', dlBtn, opt);
                    };

                    btnRow.appendChild(segBtn);
                    btnRow.appendChild(copyBtn);
                    btnRow.appendChild(dlBtn);
                    bodyWrap.appendChild(btnRow);

                    if (segCount > 0) {
                        const segListBox = createElement('div', {
                            style: {
                                marginTop: '10px',
                                background: '#111',
                                borderRadius: '6px',
                                padding: '8px',
                                maxHeight: '100px',
                                overflowY: 'auto'
                            }
                        });

                        item._cutSegments.forEach((seg, i) => {
                            const segRow = createElement('div', {
                                style: {
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                    padding: '4px 6px',
                                    fontSize: '11px',
                                    borderBottom: i < item._cutSegments.length - 1 ? '1px solid #222' : 'none'
                                }
                            }, [
                                createElement('span', { style: { color: '#4caf50', fontWeight: 'bold', minWidth: '20px' } }, `${i + 1}.`),
                                createElement('span', { style: { flex: 1 } },
                                    `${formatTimeHMS(seg.startSec)} → ${formatTimeHMS(seg.endSec)} `),
                                createElement('span', { style: { color: '#888', fontSize: '10px' } },
                                    `${seg.duration.toFixed(1)} s`),
                                createElement('button', {
                                    style: {
                                        background: 'none',
                                        border: 'none',
                                        color: '#f44336',
                                        cursor: 'pointer',
                                        fontSize: '14px',
                                        padding: '0 4px',
                                        lineHeight: 1
                                    }
                                }, '✕')
                            ]);
                            segRow.children[3].onclick = () => {
                                item._cutSegments.splice(i, 1);
                                this.render();
                            };
                            segListBox.appendChild(segRow);
                        });

                        bodyWrap.appendChild(segListBox);
                    }

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