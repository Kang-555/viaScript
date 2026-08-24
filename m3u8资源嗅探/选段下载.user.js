// ==UserScript==
// @name         m3u8可视化拖拽选段下载
// @namespace    http://tampermonkey.net/
// @version      5.4
// @description  修复嗅探失效，简化面板；网页m3u8嗅探、可视化拖拽选段预览、AES-128解密、分片拼接TS、手机电脑通用
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

            // 多时间段独立下载
            if (opt.ranges && opt.ranges.length > 0) {
                const multiWriter = new MultiSegmentWriter();
                for (let i = 0; i < opt.ranges.length; i++) {
                    const range = opt.ranges[i];
                    const mapped = timeToSegmentIndex(parseRet.timeList, range.start, range.end);
                    const rangeIndices = [];
                    for (let j = mapped.startIdx; j <= mapped.endIdx; j++) {
                        if (!rangeIndices.includes(j)) rangeIndices.push(j);
                    }
                    const rangeWriter = new VideoWriter();
                    btn.textContent = `段${i + 1}/${opt.ranges.length}: 下载中`;
                    await downloadM3u8BySegments(parseRet.segments, keyCache, (p, txt) => {
                        btn.textContent = `段${i + 1}/${opt.ranges.length}: ${txt}`;
                    }, rangeWriter, rangeIndices);
                    multiWriter.addSegment(`part${i + 1}`, rangeWriter.fixedBuffers);
                }
                btn.textContent = "保存文件";
                await multiWriter.saveAll(filename);
                btn.textContent = `✅下载完成(${opt.ranges.length}段)`;
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
    // 可视化拖拽选段弹窗
    // ==========================================
    async function openPreviewSelectSegment(m3u8Url, existingSegments = []) {
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

        const videoWrap = createElement('div', { style: { position: 'relative', width: '100%', background: '#000' } });
        const video = createElement('video', {
            controls: true, autoplay: true, playsinline: true,
            style: { width: '100%', maxHeight: '50vh', display: 'block', background: '#000' }
        });
        videoWrap.appendChild(video);

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
        let endSec = Math.min(60, totalDuration || 1);
        const safeTotal = totalDuration || 1;

        const t1Text = createElement('div', { style: { fontSize: '13px', marginBottom: '4px' } }, `起始：${formatTimeHMS(startSec)}`);
        const t2Text = createElement('div', { style: { fontSize: '13px', marginBottom: '4px' } }, `结束：${formatTimeHMS(endSec)}`);
        const durText = createElement('div', { style: { fontSize: '11px', color: '#888', marginBottom: '10px' } },
            `总时长：${formatTimeHMS(totalDuration)} | 已选：${formatTimeHMS(endSec - startSec)} | ${parseRet.segments.length}分片`);

        function buildSlider(labelText, initialPct, onChange) {
            initialPct = Math.max(0, Math.min(1, initialPct));
            const wrap = createElement('div', { style: { margin: '10px 0' } });
            const label = createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px', color: '#aaa' } }, [
                createElement('span', {}, labelText),
                createElement('span', {}, `${formatTimeHMS(initialPct * safeTotal)}`)
            ]);
            const track = createElement('div', { style: { width: '100%', height: '8px', background: '#333', borderRadius: '4px', position: 'relative', cursor: 'pointer' } });
            const fill = createElement('div', { style: { position: 'absolute', height: '100%', background: '#4caf50', borderRadius: '4px', width: `${initialPct * 100}%` } });
            const thumb = createElement('div', { style: { width: '16px', height: '16px', borderRadius: '50%', background: '#4caf50', position: 'absolute', top: '-4px', marginLeft: '-8px', cursor: 'grab', left: `${initialPct * 100}%`, boxShadow: '0 0 4px #000' } });
            track.appendChild(fill);
            track.appendChild(thumb);
            wrap.appendChild(label);
            wrap.appendChild(track);

            let dragging = false;
            function setPos(pct) {
                pct = Math.max(0, Math.min(1, pct));
                const sec = pct * safeTotal;
                thumb.style.left = `${pct * 100}%`;
                fill.style.width = `${pct * 100}%`;
                label.children[1].textContent = formatTimeHMS(sec);
                onChange(sec);
            }
            function clientXToPct(clientX) {
                const rect = track.getBoundingClientRect();
                if (rect.width === 0) return 0;
                return (clientX - rect.left) / rect.width;
            }
            thumb.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); });
            thumb.addEventListener('touchstart', (e) => { dragging = true; }, { passive: true });
            track.addEventListener('mousedown', (e) => {
                if (e.target === thumb) return;
                setPos(clientXToPct(e.clientX));
            });
            document.addEventListener('mousemove', (e) => { if (dragging) setPos(clientXToPct(e.clientX)); });
            document.addEventListener('touchmove', (e) => {
                if (dragging) setPos(clientXToPct(e.touches[0].clientX));
            }, { passive: true });
            document.addEventListener('mouseup', () => dragging = false);
            document.addEventListener('touchend', () => dragging = false);
            return { wrap, setPos };
        }

        const sliderStart = buildSlider("起始时间", startSec / safeTotal, (sec) => {
            startSec = Math.min(sec, endSec);
            video.currentTime = startSec;
            t1Text.textContent = `起始：${formatTimeHMS(startSec)}`;
            durText.textContent = `总时长：${formatTimeHMS(totalDuration)} | 已选：${formatTimeHMS(endSec - startSec)} | ${parseRet.segments.length}分片`;
        });
        const sliderEnd = buildSlider("结束时间", endSec / safeTotal, (sec) => {
            endSec = Math.max(sec, startSec);
            video.currentTime = endSec;
            t2Text.textContent = `结束：${formatTimeHMS(endSec)}`;
            durText.textContent = `总时长：${formatTimeHMS(totalDuration)} | 已选：${formatTimeHMS(endSec - startSec)} | ${parseRet.segments.length}分片`;
        });

        const confirmBtn = createElement('button', {
            style: { marginTop: '10px', padding: '8px 14px', background: '#4caf50', border: 'none', borderRadius: '4px', fontWeight: 'bold', width: '100%', fontSize: '14px' }
        }, "✅确定回填时间");

        // 已添加时间段列表
        const existingList = createElement('div', {
            style: { marginTop: '12px', borderTop: '1px solid #333', paddingTop: '8px' }
        });
        if (existingSegments.length > 0) {
            const title = createElement('div', { style: { fontSize: '12px', color: '#aaa', marginBottom: '6px' } }, `已添加时间段 (${existingSegments.length}段)：`);
            existingList.appendChild(title);
            existingSegments.forEach((seg, i) => {
                const row = createElement('div', {
                    style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0', fontSize: '11px' }
                });
                const num = createElement('span', { style: { color: '#4caf50', fontWeight: 'bold' } }, `${i + 1}.`);
                const time = createElement('span', { style: { flex: 1 } }, `${formatTimeHMS(seg.startSec)} → ${formatTimeHMS(seg.endSec)}`);
                const dur = createElement('span', { style: { color: '#888' } }, `${seg.duration.toFixed(1)}s`);
                row.appendChild(num);
                row.appendChild(time);
                row.appendChild(dur);
                existingList.appendChild(row);
            });
        }

        editorWrap.appendChild(durText);
        editorWrap.appendChild(t1Text);
        editorWrap.appendChild(sliderStart.wrap);
        editorWrap.appendChild(t2Text);
        editorWrap.appendChild(sliderEnd.wrap);
        editorWrap.appendChild(confirmBtn);
        editorWrap.appendChild(existingList);

        overlay.appendChild(closeBtn);
        overlay.appendChild(videoWrap);
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
                    position: 'fixed', bottom: '16px', left: '16px', width: '44px', height: '44px',
                    borderRadius: '50%', background: '#4caf50', border: 'none', zIndex: '999990',
                    fontWeight: 'bold', fontSize: '16px', boxShadow: '0 2px 10px #0006',
                    color: '#fff', cursor: 'pointer', transition: 'transform 0.15s'
                }
            }, "🎬");

            this.panel = createElement('div', {
                id: 'm3u8-sniffer-panel',
                style: {
                    position: 'fixed', bottom: '68px', left: '16px', width: 'min(360px, calc(100vw-32px))',
                    background: 'rgba(0,0,0,0.88)', color: '#fff', borderRadius: '10px',
                    border: '1px solid #4caf50', zIndex: '999990', display: 'none', fontSize: '12px',
                    maxHeight: '75vh', overflow: 'hidden', backdropFilter: 'blur(6px)',
                    boxShadow: '0 4px 20px #0008'
                }
            });
            this.countEl = createElement('span', { style: { fontSize: '11px', opacity: '0.8' } }, "0 个资源");
            const head = createElement('div', {
                style: { padding: '10px 12px', background: 'linear-gradient(90deg,#1b5e20,#2e7d32)', fontWeight: 'bold', color: '#fff', borderRadius: '10px 10px 0 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
            }, [
                createElement('span', {}, "🎬 视频嗅探下载器"),
                this.countEl
            ]);
            this.listEl = createElement('div', { style: { overflowY: 'auto', maxHeight: '420px' } });
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
            this.resources.unshift({ id, url, type: 'm3u8' });
            this.render();
        }

        render() {
            this.listEl.innerHTML = '';
            this.countEl.textContent = `${this.resources.length} 个资源`;
            if (this.resources.length === 0) {
                this.listEl.innerHTML = `<div style="padding:20px;text-align:center;color:#888">等待捕获视频资源...<br><span style="font-size:11px">播放视频时自动嗅探</span></div>`;
                return;
            }
            this.resources.forEach((item, idx) => {
                const isOpen = this.openId === item.id;
                const itemWrap = createElement('div', { style: { borderBottom: '1px solid #333' } });
                const titleRow = createElement('div', {
                    style: { padding: '8px 10px', cursor: 'pointer', display: 'flex', gap: '6px', alignItems: 'center', background: isOpen ? '#1a1a1a' : 'transparent', transition: 'background 0.15s' },
                    onclick: () => { this.openId = isOpen ? null : item.id; this.render(); }
                });
                const tag = createElement('span', {
                    style: {
                        background: '#4caf50',
                        color: '#000', padding: '1px 5px', borderRadius: '3px', fontSize: '10px', fontWeight: 'bold', flexShrink: '0'
                    }
                }, "m3u8");
                const nameSpan = createElement('span', {
                    style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    title: item.url
                }, getFilename(item.url));
                const arrow = createElement('span', { style: { fontSize: '10px', color: '#666', transition: 'transform 0.15s', transform: isOpen ? 'rotate(90deg)' : 'none' } }, isOpen ? '▼' : '▶');
                titleRow.appendChild(tag);
                titleRow.appendChild(nameSpan);
                titleRow.appendChild(arrow);
                itemWrap.appendChild(titleRow);

                if (isOpen) {
                    const bodyWrap = createElement('div', { style: { padding: '10px', background: '#111' } });
                    // 多段模式UI
                    const multiRow = createElement('div', { style: { marginBottom: '6px' } });
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
                            const res = await openPreviewSelectSegment(item.url, item._cutSegments);
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

                    // 按钮行
                    const btnRow = createElement('div', { style: { display: 'flex', gap: '6px' } });
                    const copyBtn = createElement('button', { style: { flex: 1, padding: '6px', background: '#555', border: 'none', color: '#fff', borderRadius: '4px' } }, "复制链接");
                    const dlBtn = createElement('button', { style: { flex: 1, padding: '6px', background: '#4caf50', border: 'none', borderRadius: '4px', fontWeight: 'bold' } }, "开始下载");

                    copyBtn.onclick = async () => {
                        await copyToClipboard(item.url);
                        alert("链接已复制");
                    };

                    dlBtn.onclick = async () => {
                        if (!item._cutSegments || item._cutSegments.length === 0) {
                            alert('请先添加时间段');
                            return;
                        }
                        const opt = {
                            ranges: item._cutSegments.map(s => ({ start: s.startSec, end: s.endSec }))
                        };
                        await window.TaskRunner(item.url, 'm3u8', dlBtn, opt);
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