// ==UserScript==
// @name         m3u8嗅探下载器
// @namespace    http://tampermonkey.net/
// @version      4.1
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
    // 0. 中文提示配置
    // ==========================================
    const T = {
        title: '嗅探器',
        copy: '复制',
        preview: '预览',
        download: '下载'
    };

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
        uiId: 'gm-sniffer-v23-ts',
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
    // 4. 工具函数
    // ==========================================
    const getSafeFileName = () => {
        let title = document.title || "video";
        return title.replace(/[\\/:*?"<>|]/g, " ").trim();
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
    // 下载管理器
    // ==========================================
    // ==========================================
    // 6. TS时间戳修复器
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
                            const pesHeaderLen = result[payloadOffset + 2];
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
            const tsData = TSPacketFixer.fixTimestamps(this.buffers);
            const tsBlob = new Blob([tsData], { type: 'video/mp2t' });
            Utils.downloadBlob(tsBlob, filename.replace(/\.zip$/i, '.ts'));
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

    const downloadM3u8BySegments = async (segments, keyCache, onProgress, writer, segmentIndices = null, skipClose = false) => {
        let workSegments = [...segments];
        if (segmentIndices && segmentIndices.length > 0) {
            const indexSet = new Set(segmentIndices);
            workSegments = segments.filter((_, i) => indexSet.has(i));
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
        // 按视频时长计算进度（分片时长可能不一致）
        const totalDuration = workSegments.reduce((sum, s) => sum + (s.dur || 0), 0);
        let completedDuration = 0;

        const updateProgress = (force = false) => {
            const now = Date.now();
            if (!force && now - lastProgressUpdate < 150) return;
            lastProgressUpdate = now;
            const elapsed = (now - taskStartTs) / 1000;
            const overallPercent = totalDuration > 0 ? (completedDuration / totalDuration) * 100 : (completedCount / workSegments.length) * 100;
            const segProgress = totalDuration > 0 ? completedDuration / totalDuration : (workSegments.length > 0 ? completedCount / workSegments.length : 0);
            const etaSec = elapsed > 0 && segProgress > 0 && segProgress < 1
                ? (elapsed / segProgress) * (1 - segProgress)
                : 0;
            const speedStr = movingSpeed > 0 ? `${Utils.formatBytes(movingSpeed)}/s` : '-- KB/s';
            const completedInfo = `${completedCount}/${workSegments.length}`;
            const failInfo = failCount > 0 ? ` [失败${failCount}]` : '';
            const text = `${overallPercent.toFixed(0)}% | ${completedInfo} 分片 | ${Utils.formatBytes(totalBytes)} | ${speedStr} | ETA ${Utils.formatTime(etaSec)}${failInfo}`;
            onProgress(overallPercent, text, { completedCount, total: workSegments.length, totalBytes, speed: movingSpeed, completedDuration, totalDuration });
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
                completedDuration += workSegments[index].dur || 0;

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
        console.log(`[downloadM3u8BySegments] 已添加${segResults.length}个分片到ZIP`);

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
        let filename = type === 'm3u8' ? safeName + '.ts' : safeName + '.mp4';
        console.log('[TaskRunner] 开始:', { url, type, opt });

        const writer = new VideoWriter();
        try {
            if (type === 'm3u8') {
                if (btn) btn.textContent = '解析m3u8...';
                const parseResult = await parseM3u8(url);
                const { segments, timeList, targetDuration } = parseResult;
                console.log('[TaskRunner] 解析完成, 分片数:', segments.length);

                let segmentIndices = null;
                if (opt.ranges && opt.ranges.length > 0) {
                    segmentIndices = [];
                    for (const r of opt.ranges) {
                        const mapped = timeToSegmentIndex(timeList, r.start, r.end);
                        for (let i = mapped.startIdx; i <= mapped.endIdx; i++) {
                            if (!segmentIndices.includes(i)) segmentIndices.push(i);
                        }
                    }
                    segmentIndices.sort((a, b) => a - b);
                    console.log('[TaskRunner] 多段模式，选中分片数:', segmentIndices.length);
                } else if (opt.beginSec !== undefined && opt.endSec !== undefined) {
                    const mapped = timeToSegmentIndex(timeList, opt.beginSec, opt.endSec);
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

                const keyCache = new Map();
                const uniqueKeys = [...new Set(segments.filter(s => s.key).map(s => s.key))];
                if (uniqueKeys.length > 0) {
                    if (btn) btn.textContent = '获取加密密钥...';
                    for (const keyUrl of uniqueKeys) {
                        const keyData = await Utils.request(keyUrl, true);
                        keyCache.set(keyUrl, new Uint8Array(keyData));
                    }
                }
                console.log('[TaskRunner] 开始下载分片');
                await downloadM3u8BySegments(segments, keyCache, (pct, txt) => { if (btn) btn.textContent = txt || pct + '%'; }, writer, segmentIndices, false);
                console.log('[TaskRunner] 分片下载完成');
                if (btn) btn.textContent = '保存中...';
                console.log('[TaskRunner] 生成TS文件:', filename);
                await writer.close(filename);
                console.log('[TaskRunner] TS文件生成完成');
                if (btn) btn.textContent = '完成';
            } else {
                if (btn) btn.textContent = '下载中...';
                const dlResult = await downloadMp4(url, (pct, txt) => { if (btn) btn.textContent = txt || pct + '%'; }, writer);
                if (dlResult.nativeDl) {
                    console.log('[TaskRunner] 原生下载已触发，跳过打包');
                    if (btn) btn.textContent = '原生下载已启动';
                    return;
                }
                if (btn) btn.textContent = '保存中...';
                console.log('[TaskRunner] 生成TS文件:', filename);
                await writer.close(filename);
                console.log('[TaskRunner] TS文件生成完成');
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
    // 7. 裁剪面板（CutPanel）- 三步Tab流程
    // ==========================================
    class CutPanel {
        constructor() {
            this.root = null;
            this.shadow = null;
            this.currentTab = 0;
            this.minimized = false;
            this.closed = false;
            this.resources = [];
            this.state = window._m3cut_state = {
                currentM3u8Url: null,
                parsedM3u8: null,
                cutSegments: [],
                curBeginSec: 0,
                curEndSec: 0,
                download: {
                    status: 'idle',
                    filename: '',
                    progressPct: 0,
                    doneSegs: 0,
                    totalSegs: 0,
                    bytes: 0,
                    speedBps: 0,
                    etaSec: 0
                }
            };
            Bus.on('video-found', (data) => {
                this.addResource(data);
            });
        }

        async init() {
            if (this.root) return;
            if (this.closed) return;
            await waitBody();
            if (document.getElementById('m3cut-root')) return;

            const host = document.createElement('div');
            host.id = 'm3cut-root';
            host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999999;font-family:sans-serif;font-size:12px;';

            try {
                this.shadow = host.attachShadow({ mode: 'open' });
            } catch (e) {
                this.shadow = host;
            }

            const style = document.createElement('style');
            style.id = 'm3cut-style';
            style.textContent = `
                .m3cut-panel {
                    width:300px;background:rgba(0,0,0,0.92);color:#fff;border-radius:8px;
                    border:1px solid ${Config.colors.primary};box-shadow:0 4px 20px rgba(0,0,0,0.5);
                    display:flex;flex-direction:column;overflow:hidden;
                }
                .m3cut-mini {
                    width:36px;height:36px;border-radius:50%;background:${Config.colors.primary};
                    display:none;align-items:center;justify-content:center;cursor:pointer;
                    font-size:16px;color:#000;box-shadow:0 2px 10px rgba(0,0,0,0.3);
                }
                .m3cut-mini.show { display:flex; }
                .m3cut-tabbar {
                    display:flex;background:rgba(255,255,255,0.06);border-bottom:1px solid rgba(255,255,255,0.1);
                }
                .m3cut-tab {
                    flex:1;padding:8px 4px;text-align:center;cursor:pointer;font-size:11px;color:#888;
                    transition:all 0.2s;border-bottom:2px solid transparent;
                }
                .m3cut-tab:hover { background:rgba(255,255,255,0.05); }
                .m3cut-tab.active { color:${Config.colors.primary};border-bottom-color:${Config.colors.primary}; }
                .m3cut-tab.disabled { opacity:0.4;pointer-events:none; }
                .m3cut-btns { display:flex;justify-content:flex-end;gap:4px;padding:4px 8px;background:rgba(255,255,255,0.04); }
                .m3cut-btn {
                    background:none;border:none;color:#888;font-size:14px;cursor:pointer;padding:2px 6px;
                }
                .m3cut-btn:hover { color:#fff; }
                .m3cut-content { padding:10px;max-height:220px;overflow-y:auto; }
                .m3cut-section-title { font-size:11px;color:#aaa;margin:8px 0 6px; }
                .m3cut-section-title:first-child { margin-top:0; }
                .m3cut-resource {
                    background:rgba(255,255,255,0.05);border-radius:4px;padding:8px;margin-bottom:6px;
                    display:flex;align-items:center;gap:8px;cursor:pointer;
                }
                .m3cut-resource:hover { background:rgba(255,255,255,0.1); }
                .m3cut-tag {
                    background:${Config.colors.primary};color:#000;padding:2px 5px;border-radius:3px;
                    font-size:10px;font-weight:bold;flex-shrink:0;
                }
                .m3cut-tag.mp4 { background:#2196F3;color:#fff; }
                .m3cut-name { flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px; }
                .m3cut-arrow { color:#666;font-size:10px; }
                .m3cut-input {
                    width:100%;padding:6px 8px;background:#1a1a2e;border:1px solid #333;
                    border-radius:4px;color:#fff;font-size:11px;box-sizing:border-box;margin-bottom:8px;
                }
                .m3cut-input:focus { border-color:${Config.colors.primary};outline:none; }
                .m3cut-row { display:flex;gap:6px;align-items:center;margin-bottom:6px; }
                .m3cut-row label { min-width:32px;color:#aaa;font-size:11px; }
                .m3cut-row input { flex:1; }
                .m3cut-progress-bar {
                    height:6px;background:#333;border-radius:3px;overflow:hidden;margin:8px 0;
                }
                .m3cut-progress-fill {
                    height:100%;background:${Config.colors.primary};transition:width 0.3s;
                }
                .m3cut-progress-text { font-size:10px;color:#888;text-align:center; }
                .m3cut-btn-primary {
                    width:100%;padding:8px;background:${Config.colors.primary};color:#000;
                    border:none;border-radius:4px;font-weight:bold;cursor:pointer;font-size:11px;
                }
                .m3cut-btn-primary:disabled { opacity:0.5;cursor:not-allowed; }
                .m3cut-btn-secondary {
                    padding:6px 12px;background:#2196F3;color:#fff;border:none;border-radius:4px;
                    cursor:pointer;font-size:11px;
                }
                .m3cut-segment-list { margin-top:10px; }
                .m3cut-segment-item {
                    background:rgba(255,255,255,0.05);border-radius:4px;padding:8px;margin-bottom:4px;
                    display:flex;align-items:center;justify-content:space-between;
                }
                .m3cut-segment-info { font-size:11px; }
                .m3cut-segment-time { color:#aaa; }
                .m3cut-segment-dur { color:${Config.colors.primary};margin-left:8px; }
                .m3cut-segment-del { color:#666;cursor:pointer;font-size:14px; }
                .m3cut-segment-del:hover { color:#f44336; }
                .m3cut-summary {
                    background:rgba(0,0,0,0.3);border-radius:4px;padding:10px;font-size:11px;line-height:1.6;
                }
                .m3cut-summary-row { display:flex;gap:8px; }
                .m3cut-summary-label { color:#888;min-width:60px; }
                .m3cut-empty { text-align:center;color:#666;padding:20px;font-size:11px; }
                .m3cut-info { font-size:11px;color:#888;margin-bottom:10px; }
                .m3cut-slider-wrap {
                    position:relative;height:20px;margin:12px 0 4px;cursor:pointer;user-select:none;
                }
                .m3cut-slider-track {
                    position:absolute;top:8px;left:0;right:0;height:4px;
                    background:#333;border-radius:2px;
                }
                .m3cut-slider-range {
                    position:absolute;top:8px;height:4px;
                    background:${Config.colors.primary};border-radius:2px;pointer-events:none;
                }
                .m3cut-slider-handle {
                    position:absolute;top:3px;width:12px;height:12px;
                    background:#fff;border:2px solid ${Config.colors.primary};
                    border-radius:50%;transform:translateX(-50%);
                    cursor:grab;z-index:2;box-shadow:0 1px 4px rgba(0,0,0,0.4);
                    transition:transform 0.15s;
                }
                .m3cut-slider-handle:hover { transform:translateX(-50%) scale(1.2); }
                .m3cut-slider-handle.dragging { cursor:grabbing;transform:translateX(-50%) scale(1.3); }
                .m3cut-timeline-labels {
                    display:flex;justify-content:space-between;font-size:10px;color:#666;margin-top:2px;
                }
                .m3cut-time-label {
                    display:inline-block;padding:2px 4px;min-width:56px;text-align:center;
                    background:rgba(255,255,255,0.05);border-radius:3px;cursor:pointer;
                    font-family:monospace;font-size:11px;color:${Config.colors.primary};
                }
                .m3cut-time-label:hover { background:rgba(255,255,255,0.12); }
                .m3cut-time-label.editing {
                    background:${Config.colors.primary};color:#000;
                }
                .m3cut-time-label input {
                    width:52px;padding:0;border:none;background:transparent;
                    color:inherit;font-family:inherit;font-size:inherit;text-align:center;outline:none;
                }
                .m3cut-time-row { display:flex;align-items:center;gap:6px;margin:8px 0; }
                .m3cut-time-row .m3cut-lbl { min-width:32px;color:#aaa;font-size:11px; }
                .m3cut-duration-info {
                    font-size:10px;color:#888;text-align:center;margin:4px 0 8px;
                    font-family:monospace;
                }
                .m3cut-duration-info span { color:${Config.colors.primary}; }
            `;

            this.root = document.createElement('div');
            this.root.className = 'm3cut-panel';

            this.miniBtn = document.createElement('div');
            this.miniBtn.className = 'm3cut-mini';
            this.miniBtn.textContent = '✂';
            this.miniBtn.onclick = () => this.toggleMinimize();

            this.render();

            this.shadow.appendChild(style);
            this.shadow.appendChild(this.root);
            this.shadow.appendChild(this.miniBtn);
            document.body.appendChild(host);
        }

        render() {
            this.root.innerHTML = '';
            this.root.innerHTML = `
                <div class="m3cut-tabbar">
                    <div class="m3cut-tab ${this.currentTab === 0 ? 'active' : ''} ${this.state.parsedM3u8 ? '' : 'disabled'}" data-tab="0">🔗 链接</div>
                    <div class="m3cut-tab ${this.currentTab === 1 ? 'active' : ''} ${!this.state.parsedM3u8 ? 'disabled' : ''}" data-tab="1">⏱ 筛选</div>
                    <div class="m3cut-tab ${this.currentTab === 2 ? 'active' : ''} ${this.state.cutSegments.length === 0 ? 'disabled' : ''}" data-tab="2">⬇ 下载</div>
                </div>
                <div class="m3cut-btns">
                    <button class="m3cut-btn" title="最小化">—</button>
                    <button class="m3cut-btn" title="关闭">×</button>
                </div>
                <div class="m3cut-content"></div>
            `;

            const tabs = this.root.querySelectorAll('.m3cut-tab');
            tabs.forEach(tab => {
                tab.onclick = () => {
                    if (tab.classList.contains('disabled')) return;
                    this.currentTab = parseInt(tab.dataset.tab);
                    this.render();
                };
            });

            const btns = this.root.querySelectorAll('.m3cut-btn');
            btns[0].onclick = () => this.toggleMinimize();
            btns[1].onclick = () => this.close();

            const content = this.root.querySelector('.m3cut-content');
            if (this.currentTab === 0) this.renderTab1(content);
            else if (this.currentTab === 1) this.renderTab2(content);
            else this.renderTab3(content);
        }

        renderTab1(container) {
            container.innerHTML = `
                <div class="m3cut-section-title">📡 当前页面已嗅探资源</div>
                <div class="m3cut-resource-list"></div>
                <div class="m3cut-section-title">✏️ 手动输入链接</div>
                <input type="text" class="m3cut-input" id="m3cut-url-input" placeholder="https://.../playlist.m3u8">
                <button class="m3cut-btn-primary" id="m3cut-parse-btn">解析并进入</button>
            `;

            const listEl = container.querySelector('.m3cut-resource-list');
            if (this.resources.length === 0) {
                listEl.innerHTML = '<div class="m3cut-empty">暂无嗅探资源</div>';
            } else {
                listEl.innerHTML = this.resources.map((r, i) => `
                    <div class="m3cut-resource" data-url="${r.url}" data-type="${r.type}">
                        <span class="m3cut-tag ${r.type}">${r.type.toUpperCase()}</span>
                        <span class="m3cut-name">${Utils.getFilename(r.url)}</span>
                        <span class="m3cut-arrow">→</span>
                    </div>
                `).join('');
                listEl.querySelectorAll('.m3cut-resource').forEach(el => {
                    el.onclick = () => this.selectResource(el.dataset.url, el.dataset.type);
                });
            }

            const input = container.querySelector('#m3cut-url-input');
            input.onkeydown = (e) => { if (e.key === 'Enter') container.querySelector('#m3cut-parse-btn').click(); };

            container.querySelector('#m3cut-parse-btn').onclick = () => {
                const url = input.value.trim();
                if (!url) return;
                this.selectResource(url, 'm3u8');
            };
        }

        async selectResource(url, type) {
            const btn = document.querySelector('#m3cut-parse-btn');
            if (btn) btn.textContent = '解析中...';
            try {
                const parsed = await parseM3u8(url);
                this.state.currentM3u8Url = url;
                this.state.parsedM3u8 = parsed;
                this.state.cutSegments = [];
                this.state.curBeginSec = 0;
                this.state.curEndSec = Math.min(60, parsed.totalDuration || 0);
                this.currentTab = 1;
                this.render();
            } catch (e) {
                alert('解析失败: ' + e.message);
                if (btn) btn.textContent = '解析并进入';
            }
        }

        renderTab2(container) {
            const { parsedM3u8, curBeginSec, curEndSec } = this.state;
            const totalDuration = parsedM3u8?.totalDuration || 0;
            const totalSegs = parsedM3u8?.segments?.length || 0;

            const startPct = totalDuration > 0 ? (curBeginSec / totalDuration) * 100 : 0;
            const endPct = totalDuration > 0 ? (curEndSec / totalDuration) * 100 : 100;
            const durSec = curEndSec - curBeginSec;

            container.innerHTML = `
                <div class="m3cut-section-title">🎬 ${Utils.getFilename(this.state.currentM3u8Url)}</div>
                <div class="m3cut-info">总时长: ${Utils.formatTime(totalDuration)} | 分片数: ${totalSegs}</div>

                <div class="m3cut-slider-wrap" id="m3cut-slider">
                    <div class="m3cut-slider-track"></div>
                    <div class="m3cut-slider-range" style="left:${startPct}%;width:${endPct - startPct}%"></div>
                    <div class="m3cut-slider-handle" data-role="start" style="left:${startPct}%"></div>
                    <div class="m3cut-slider-handle" data-role="end" style="left:${endPct}%"></div>
                </div>
                <div class="m3cut-timeline-labels">
                    <span>${Utils.formatTime(0)}</span>
                    <span>${Utils.formatTime(totalDuration)}</span>
                </div>

                <div class="m3cut-time-row">
                    <span class="m3cut-lbl">起始</span>
                    <span class="m3cut-time-label" id="m3cut-time-label-start">${Utils.formatTime(curBeginSec)}</span>
                </div>
                <div class="m3cut-time-row">
                    <span class="m3cut-lbl">结束</span>
                    <span class="m3cut-time-label" id="m3cut-time-label-end">${Utils.formatTime(curEndSec)}</span>
                </div>
                <div class="m3cut-duration-info">单段时长: <span>${Utils.formatTime(durSec)} (${durSec.toFixed(1)}s)</span></div>

                <button class="m3cut-btn-primary" id="m3cut-add-seg" style="margin-bottom:10px">➕ 添加到列表</button>

                <div class="m3cut-section-title">📋 已添加时间段</div>
                <div class="m3cut-segment-list"></div>
                <div class="m3cut-info" id="m3cut-seg-total"></div>
                <button class="m3cut-btn-primary" id="m3cut-go-download">→ 去下载</button>
            `;

            this._bindSliderDrag(container, totalDuration);
            this._bindTimeLabelEdit(container, totalDuration);

            container.querySelector('#m3cut-add-seg').onclick = () => this.addSegment();
            container.querySelector('#m3cut-go-download').onclick = () => {
                this.currentTab = 2;
                this.render();
            };

            this.renderSegmentList(container);
        }

        _bindSliderDrag(container, totalDuration) {
            const slider = container.querySelector('#m3cut-slider');
            const handles = slider.querySelectorAll('.m3cut-slider-handle');
            const range = slider.querySelector('.m3cut-slider-range');

            const pctToSec = (pct) => Math.max(0, Math.min(totalDuration, (pct / 100) * totalDuration));
            const secToPct = (sec) => totalDuration > 0 ? (sec / totalDuration) * 100 : 0;

            const applyPositions = () => {
                const bs = this.state.curBeginSec;
                const es = this.state.curEndSec;
                const sp = secToPct(bs);
                const ep = secToPct(es);
                handles[0].style.left = sp + '%';
                handles[1].style.left = ep + '%';
                range.style.left = sp + '%';
                range.style.width = (ep - sp) + '%';
                container.querySelector('#m3cut-time-label-start').textContent = Utils.formatTime(bs);
                container.querySelector('#m3cut-time-label-end').textContent = Utils.formatTime(es);
                const durEl = container.querySelector('.m3cut-duration-info span');
                if (durEl) {
                    durEl.textContent = `${Utils.formatTime(es - bs)} (${(es - bs).toFixed(1)}s)`;
                }
            };

            let dragging = null;

            const onMove = (clientX) => {
                const rect = slider.getBoundingClientRect();
                let pct = ((clientX - rect.left) / rect.width) * 100;
                pct = Math.max(0, Math.min(100, pct));
                const sec = pctToSec(pct);

                if (dragging === 'start') {
                    this.state.curBeginSec = Math.min(sec, this.state.curEndSec - 0.5);
                } else if (dragging === 'end') {
                    this.state.curEndSec = Math.max(sec, this.state.curBeginSec + 0.5);
                }
                applyPositions();
            };

            const onUp = () => {
                dragging = null;
                handles.forEach(h => h.classList.remove('dragging'));
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                document.removeEventListener('touchmove', onMoveTouch);
                document.removeEventListener('touchend', onUp);
            };

            const onMoveTouch = (e) => {
                if (e.touches.length > 0) {
                    onMove(e.touches[0].clientX);
                }
            };

            handles.forEach(h => {
                const startDrag = (clientX) => {
                    dragging = h.dataset.role;
                    h.classList.add('dragging');
                    onMove(clientX);
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                    document.addEventListener('touchmove', onMoveTouch, { passive: true });
                    document.addEventListener('touchend', onUp);
                };
                h.addEventListener('mousedown', (e) => { e.preventDefault(); startDrag(e.clientX); });
                h.addEventListener('touchstart', (e) => { e.preventDefault(); startDrag(e.touches[0].clientX); }, { passive: true });
            });

            slider.addEventListener('click', (e) => {
                if (e.target.classList.contains('m3cut-slider-handle')) return;
                const rect = slider.getBoundingClientRect();
                const pct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
                const sec = pctToSec(pct);
                const distStart = Math.abs(sec - this.state.curBeginSec);
                const distEnd = Math.abs(sec - this.state.curEndSec);
                if (distStart < distEnd) {
                    this.state.curBeginSec = Math.min(sec, this.state.curEndSec - 0.5);
                } else {
                    this.state.curEndSec = Math.max(sec, this.state.curBeginSec + 0.5);
                }
                applyPositions();
            });
        }

        _bindTimeLabelEdit(container, totalDuration) {
            const labels = [
                container.querySelector('#m3cut-time-label-start'),
                container.querySelector('#m3cut-time-label-end')
            ];

            labels.forEach(label => {
                label.addEventListener('click', (e) => {
                    if (label.querySelector('input')) return;
                    e.stopPropagation();
                    const isStart = label.id.includes('start');
                    const curVal = isStart ? this.state.curBeginSec : this.state.curEndSec;
                    label.classList.add('editing');
                    label.innerHTML = `<input type="text" value="${Utils.formatTime(curVal)}" maxlength="8">`;
                    const input = label.querySelector('input');
                    input.focus();
                    input.select();

                    const commit = () => {
                        const val = input.value.trim();
                        const sec = Utils.toSeconds(val);
                        label.classList.remove('editing');
                        if (!isFinite(sec) || sec < 0) {
                            label.textContent = Utils.formatTime(curVal);
                            return;
                        }
                        let clamped = Math.min(sec, totalDuration);
                        if (isStart) {
                            this.state.curBeginSec = Math.min(clamped, this.state.curEndSec - 0.5);
                        } else {
                            this.state.curEndSec = Math.max(clamped, this.state.curBeginSec + 0.5);
                        }
                        this._refreshTab2();
                    };

                    const cancel = () => {
                        label.classList.remove('editing');
                        label.textContent = Utils.formatTime(curVal);
                    };

                    input.addEventListener('keydown', (ev) => {
                        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
                        else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
                    });
                    input.addEventListener('blur', () => commit());
                });
            });
        }

        _refreshTab2() {
            const container = this.root.querySelector('.m3cut-content');
            if (!container || this.currentTab !== 1) return;
            const { parsedM3u8, curBeginSec, curEndSec } = this.state;
            const totalDuration = parsedM3u8?.totalDuration || 0;

            const startPct = totalDuration > 0 ? (curBeginSec / totalDuration) * 100 : 0;
            const endPct = totalDuration > 0 ? (curEndSec / totalDuration) * 100 : 100;
            const durSec = curEndSec - curBeginSec;

            const handles = container.querySelectorAll('.m3cut-slider-handle');
            const range = container.querySelector('.m3cut-slider-range');
            if (handles.length === 2) {
                handles[0].style.left = startPct + '%';
                handles[1].style.left = endPct + '%';
            }
            if (range) {
                range.style.left = startPct + '%';
                range.style.width = (endPct - startPct) + '%';
            }
            const lblStart = container.querySelector('#m3cut-time-label-start');
            const lblEnd = container.querySelector('#m3cut-time-label-end');
            if (lblStart) lblStart.textContent = Utils.formatTime(curBeginSec);
            if (lblEnd) lblEnd.textContent = Utils.formatTime(curEndSec);
            const durEl = container.querySelector('.m3cut-duration-info span');
            if (durEl) durEl.textContent = `${Utils.formatTime(durSec)} (${durSec.toFixed(1)}s)`;
        }

        addSegment() {
            const { curBeginSec, curEndSec, parsedM3u8 } = this.state;
            const beginSec = curBeginSec;
            const endSec = curEndSec;

            if (!isFinite(beginSec) || !isFinite(endSec) || endSec <= beginSec) {
                alert('请输入有效的起止时间，且结束时间必须大于起始时间');
                return;
            }

            const { timeList, totalDuration } = parsedM3u8;
            const { startIdx, endIdx } = timeToSegmentIndex(timeList, beginSec, endSec);
            const duration = endSec - beginSec;

            this.state.cutSegments.push({
                id: 'seg_' + Math.random().toString(36).slice(2, 6),
                beginSec,
                endSec,
                startIdx,
                endIdx,
                duration
            });

            this.state.curBeginSec = Math.min(endSec, totalDuration);
            this.state.curEndSec = Math.min(this.state.curBeginSec + 60, totalDuration);
            if (this.state.curEndSec <= this.state.curBeginSec) {
                this.state.curEndSec = totalDuration;
            }

            this._refreshTab2();
            this.renderSegmentList(this.root.querySelector('.m3cut-content'));
        }

        renderSegmentList(container) {
            const listEl = container.querySelector('.m3cut-segment-list');
            const totalEl = container.querySelector('#m3cut-seg-total');

            if (this.state.cutSegments.length === 0) {
                listEl.innerHTML = '<div class="m3cut-empty">暂无时间段，点击上方➕添加</div>';
                totalEl.innerHTML = '';
            } else {
                listEl.innerHTML = this.state.cutSegments.map((seg, i) => `
                    <div class="m3cut-segment-item">
                        <div class="m3cut-segment-info">
                            <span class="m3cut-segment-time">${Utils.formatTime(seg.beginSec)} → ${Utils.formatTime(seg.endSec)}</span>
                            <span class="m3cut-segment-dur">${seg.duration.toFixed(1)}s</span>
                        </div>
                        <span class="m3cut-segment-del" data-id="${seg.id}">✕</span>
                    </div>
                `).join('');

                listEl.querySelectorAll('.m3cut-segment-del').forEach(el => {
                    el.onclick = () => {
                        this.state.cutSegments = this.state.cutSegments.filter(s => s.id !== el.dataset.id);
                        this.renderSegmentList(container);
                    };
                });

                const totalDur = this.state.cutSegments.reduce((sum, s) => sum + s.duration, 0);
                const totalSegs = this.state.cutSegments.reduce((sum, s) => sum + (s.endIdx - s.startIdx + 1), 0);
                totalEl.innerHTML = `合计: ${this.state.cutSegments.length}段 | ${totalDur.toFixed(1)}s | ~${totalSegs}分片`;
            }
        }

        renderTab3(container) {
            const { currentM3u8Url, parsedM3u8, cutSegments } = this.state;
            const totalSegs = cutSegments.reduce((sum, s) => sum + (s.endIdx - s.startIdx + 1), 0);
            const totalDur = cutSegments.reduce((sum, s) => sum + s.duration, 0);
            const safeName = getSafeFileName();
            const hasKey = parsedM3u8?.segments?.some(s => s.key);

            container.innerHTML = `
                <div class="m3cut-section-title">💾 输出文件名</div>
                <input type="text" class="m3cut-input" id="m3cut-filename" value="${safeName}_裁剪合集.ts">

                <div class="m3cut-section-title">📝 下载摘要</div>
                <div class="m3cut-summary">
                    <div class="m3cut-summary-row"><span class="m3cut-summary-label">资源:</span>${Utils.getFilename(currentM3u8Url)}</div>
                    <div class="m3cut-summary-row"><span class="m3cut-summary-label">模式:</span>多段裁剪(${cutSegments.length}段)顺序拼接</div>
                    <div class="m3cut-summary-row"><span class="m3cut-summary-label">总分片:</span>~${totalSegs}片</div>
                    <div class="m3cut-summary-row"><span class="m3cut-summary-label">时长:</span>${Utils.formatTime(totalDur)}</div>
                    <div class="m3cut-summary-row"><span class="m3cut-summary-label">加密:</span>${hasKey ? 'AES-128 ✓' : '无'}</div>
                </div>

                <div class="m3cut-progress-bar">
                    <div class="m3cut-progress-fill" id="m3cut-progress-fill" style="width:0%"></div>
                </div>
                <div class="m3cut-progress-text" id="m3cut-progress-text">准备就绪</div>

                <div class="m3cut-row" style="margin-top:10px">
                    <button class="m3cut-btn-secondary" id="m3cut-cancel-btn" style="display:none">■ 取消</button>
                    <button class="m3cut-btn-primary" id="m3cut-start-btn" style="flex:1">▶ 开始下载</button>
                </div>
            `;

            this._downloader = null;
            container.querySelector('#m3cut-start-btn').onclick = () => this.startDownload();
            container.querySelector('#m3cut-cancel-btn').onclick = () => this.cancelDownload();
        }

        cancelDownload() {
            if (this._downloader) {
                this._downloader.cancel();
            }
        }

        async startDownload() {
            const container = this.root.querySelector('.m3cut-content');
            const filename = container.querySelector('#m3cut-filename').value || 'video.ts';
            const startBtn = container.querySelector('#m3cut-start-btn');
            const cancelBtn = container.querySelector('#m3cut-cancel-btn');
            const progressFill = container.querySelector('#m3cut-progress-fill');
            const progressText = container.querySelector('#m3cut-progress-text');

            startBtn.disabled = true;
            startBtn.textContent = '下载中...';
            cancelBtn.style.display = 'block';

            this.state.download.status = 'running';

            try {
                const downloader = new MultiSegDownloader();
                this._downloader = downloader;
                await downloader.run(
                    this.state.cutSegments,
                    this.state.parsedM3u8,
                    filename,
                    (pct, text, info) => {
                        progressFill.style.width = pct + '%';
                        progressText.textContent = text || pct.toFixed(0) + '%';
                    }
                );

                progressText.textContent = '下载完成!';
                startBtn.textContent = '完成';
                this.state.download.status = 'done';
            } catch (e) {
                progressText.textContent = '错误: ' + e.message;
                startBtn.textContent = '下载失败';
                this.state.download.status = 'error';
                alert('下载错误: ' + e.message);
            } finally {
                startBtn.disabled = false;
                cancelBtn.style.display = 'none';
                this._downloader = null;
            }
        }

        toggleMinimize() {
            this.minimized = !this.minimized;
            this.root.style.display = this.minimized ? 'none' : 'flex';
            this.miniBtn.classList.toggle('show', this.minimized);
        }

        close() {
            this.closed = true;
            const host = document.getElementById('m3cut-root');
            if (host) host.remove();
        }

        addResource({ url, type }) {
            const normalizedType = type === 'm3u8' ? 'm3u8' : 'mp4';
            const exists = this.resources.some(r => r.url === url);
            if (exists) return;
            this.resources.unshift({ url, type: normalizedType });
            if (this.root) this.render();
        }
    }

    // ==========================================
    // 8. 多段下载引擎
    // ==========================================
    class MultiSegDownloader {
        constructor() {
            this.cancelled = false;
        }

        async run(cutSegments, parsedM3u8, filename, onProgress) {
            this.cancelled = false;
            const writer = new VideoWriter();
            const { segments } = parsedM3u8;

            const keyCache = new Map();
            const uniqueKeys = [...new Set(segments.filter(s => s.key).map(s => s.key))];
            for (const kurl of uniqueKeys) {
                if (this.cancelled) throw new Error('已取消');
                const keyData = await Utils.request(kurl, true);
                keyCache.set(kurl, new Uint8Array(keyData));
            }

            // 计算总时长（用于进度）
            const totalDurationAll = cutSegments.reduce((sum, seg) => {
                for (let i = seg.startIdx; i <= seg.endIdx; i++) {
                    sum += segments[i]?.dur || 0;
                }
                return sum;
            }, 0);
            let accumulatedDuration = 0;

            for (const segItem of cutSegments) {
                if (this.cancelled) throw new Error('已取消');

                // 当前段的时长
                const segDuration = segments.slice(segItem.startIdx, segItem.endIdx + 1)
                    .reduce((s, seg) => s + (seg.dur || 0), 0);

                const segIndices = [];
                for (let i = segItem.startIdx; i <= segItem.endIdx; i++) segIndices.push(i);

                await downloadM3u8BySegments(
                    segments,
                    keyCache,
                    (pctSeg, textSeg, infoSeg) => {
                        const doneDuration = infoSeg?.completedDuration ?? 0;
                        const overallPct = totalDurationAll > 0
                            ? ((accumulatedDuration + doneDuration) / totalDurationAll) * 100
                            : 0;
                        onProgress(overallPct, textSeg, { ...infoSeg, totalDurationAll });
                    },
                    writer,
                    segIndices,
                    true
                );
                accumulatedDuration += segDuration;
            }

            await writer.close(filename);
            onProgress(100, '完成', null);
        }

        cancel() {
            this.cancelled = true;
        }
    }

    // 嗅探器立刻启动（网络劫持需要尽早）
    new Sniffer().start();
    // 初始化裁剪面板
    const cutPanel = new CutPanel();
    cutPanel.init();
})();