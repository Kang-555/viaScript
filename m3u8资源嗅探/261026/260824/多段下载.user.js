// ==UserScript==
// @name         多段下载器
// @namespace    http://tampermonkey.net/
// @version      3.5
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
                m3u8: /\.m3u8($|\?)|application\/.*mpegurl/i
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

    /**
     * TS时间戳修复工具
     * TS包固定188字节，PCR/PTS/DTS以90kHz为单位（1秒=90000）
     */
    const TSPacketFixer = {
        TS_PACKET_SIZE: 188,
        SYNC_BYTE: 0x47,
        PCR_TIMEBASE: 90000,

        /**
         * 从Uint8Array读取33位PCR值
         */
        readPCR(buf, offset) {
            const pcrBase = buf[offset] * 0x02000000
                + (buf[offset + 1] << 17)
                + (buf[offset + 2] << 9)
                + (buf[offset + 3] << 1)
                + (buf[offset + 4] >> 7);
            const pcrExt = ((buf[offset + 4] & 0x1F) << 4) | ((buf[offset + 5] >> 3) & 0x0F);
            return pcrBase * 300 + pcrExt;
        },

        /**
         * 写入33位PCR值
         */
        writePCR(buf, offset, pcrValue) {
            const pcrBase = Math.floor(pcrValue / 300);
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

        /**
         * 读取33位PTS/DTS值
         */
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

        /**
         * 写入33位PTS/DTS值
         */
        writePTS(buf, offset, ptsValue) {
            const highBits = Math.floor(ptsValue / 0x20000000) & 0x07;
            const remainder = ptsValue - highBits * 0x20000000;
            buf[offset] = (buf[offset] & 0xF0) | (highBits << 1);
            buf[offset + 1] = (remainder >> 22) & 0xFF;
            buf[offset + 2] = ((remainder >> 14) & 0xFE) | 0x01;
            buf[offset + 3] = (remainder >> 7) & 0xFF;
            buf[offset + 4] = ((remainder << 1) & 0xFE) | 0x01;
        },

        /**
         * 获取TS分片的起始和结束PCR值
         */
        getPCRRanges(data) {
            let firstPCR = null;
            let lastPCR = null;
            const len = data.length;

            for (let i = 0; i + this.TS_PACKET_SIZE <= len; i += this.TS_PACKET_SIZE) {
                if (data[i] !== this.SYNC_BYTE) continue;

                const payloadUnitStart = (data[i + 1] >> 6) & 0x01;
                const hasAdaptation = (data[i + 3] & 0x20) !== 0;
                const hasPayload = (data[i + 3] & 0x10) !== 0;

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

        /**
         * 对TS数据的所有PCR/PTS/DTS加上偏移量
         */
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
                            this.writePCR(result, pcrOffset, pcr + offset);
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
                                this.writePTS(result, ptsOffset + 1, pts + offset);
                            }

                            if (ptsDtsFlag === 0x03 && ptsOffset + 10 <= len) {
                                const dtsOffset = ptsOffset + 5;
                                const dts = this.readPTS(result, dtsOffset);
                                this.writePTS(result, dtsOffset, dts + offset);
                            }
                        }
                    }
                }
            }

            return result;
        },

        /**
         * 修复多个TS分片的时间戳连续性
         * 输入：按顺序排列的TS分片Uint8Array数组
         * 输出：时间戳连续的合并后Uint8Array
         */
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

    const downloadM3u8BySegments = async (segments, keyCache, onProgress, writer, segmentIndices = null) => {
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



    /**
     * 通用任务入口
     */
    window.TaskRunner = async (url, type, btn, opt = {}) => {
        const originalText = btn ? btn.textContent : '';
        const safeName = getSafeFileName();
        let filename = safeName + '.ts';
        console.log('[TaskRunner] 开始:', { url, type, opt });

        const writer = new VideoWriter();
        try {
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
            await downloadM3u8BySegments(segments, keyCache, (pct, txt) => { if (btn) btn.textContent = txt || pct + '%'; }, writer, segmentIndices);
            console.log('[TaskRunner] 分片下载完成');
            if (btn) btn.textContent = '保存中...';
            console.log('[TaskRunner] 生成TS文件:', filename);
            await writer.close(filename);
            console.log('[TaskRunner] TS文件生成完成');
            if (btn) btn.textContent = '完成';
        } catch (error) {
            console.error('[TaskRunner] 错误:', error);
            if (btn) btn.textContent = '错误';
            alert(`下载错误: ${error.message || error}`);
            throw error;
        }
    };

    // ==========================================
    // 7. UI悬浮面板【三标签页重构版】
    // ==========================================
    class UI {
        constructor() {
            this.root = null;
            this.content = null;

            this.resources = [];
            this.currentTab = 'resources';
            this.currentResource = null;
            this.timeRanges = [];
            this.timeRanges._curStart = 0;
            this.timeRanges._curEnd = 0;
            this.inited = false;
            this.dragging = null;
            this.downloadState = null;
            this.resourceSelectEl = null;
            this.startTrack = null;
            this.startProgress = null;
            this.startThumb = null;
            this.endTrack = null;
            this.endProgress = null;
            this.endThumb = null;
            this.startTimeEl = null;
            this.endTimeEl = null;
            this.totalTimeEl = null;
            this.rangeListEl = null;
            this.rangeEmptyEl = null;
            this.btnAddRange = null;
            this.dlInfoEl = null;
            this.dlProgressBar = null;
            this.dlProgressText = null;
            this.dlProgressDetail = null;
            this.dlEtaEl = null;
            this.btnStartDownload = null;
            this.tabBtns = [];
            this.tabPanels = [];
            this.infoBar = null;

            Bus.on('video-found', (data) => {
                this.addResource(data);
            });
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
                    width: min(360px, calc(100vw - 40px)); background: ${Config.colors.background}; color: ${Config.colors.text};
                    border: 1px solid ${Config.colors.primary}; border-radius: 8px;
                    backdrop-filter: blur(5px); display: flex; flex-direction: column;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.5);
                }
                .head {
                    padding: 8px 12px; background: rgba(255,255,255,0.08);
                    display: flex; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1);
                    font-weight: bold; color: ${Config.colors.primary}; font-size: 13px;
                }
                .tabs {
                    display: flex; border-bottom: 1px solid rgba(255,255,255,0.15);
                    background: rgba(0,0,0,0.3);
                }
                .tab-btn {
                    flex: 1; padding: 8px 4px; background: transparent; border: none;
                    color: #888; cursor: pointer; font-size: 11px; font-weight: bold;
                    border-bottom: 2px solid transparent; transition: all 0.2s;
                }
                .tab-btn.active { color: ${Config.colors.primary}; border-bottom-color: ${Config.colors.primary}; background: rgba(76,175,80,0.1); }
                .tab-btn:hover:not(.active) { color: #bbb; background: rgba(255,255,255,0.05); }
                .tab-panel { display: none; padding: 10px 12px; max-height: 320px; overflow-y: auto; }
                .tab-panel.active { display: block; }
                button { border: none; padding: 6px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }
                .btn-primary { background: ${Config.colors.primary}; color: #000; font-weight: bold; padding: 7px 10px; }
                .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
                .btn-copy { background: #555; color: #fff; }
                .btn-select { background: #2196F3; color: #fff; }
                .btn-danger { background: #c0392b; color: #fff; padding: 2px 6px; font-size: 10px; }
                .btn-row { display: flex; gap: 6px; margin-top: 8px; }
                .empty-tip { padding: 20px; text-align: center; color: #666; font-size: 11px; }
                .empty-range { padding: 10px; text-align: center; color: #555; font-size: 11px; background: rgba(0,0,0,0.2); border-radius: 4px; border: 1px dashed #333; margin-top: 8px; }
                
                .res-item { border-bottom: 1px solid rgba(255,255,255,0.08); padding: 8px; }
                .res-item:last-child { border-bottom: none; }
                .res-head { display: flex; align-items: center; gap: 6px; cursor: pointer; }
                .res-head:hover { background: rgba(255,255,255,0.05); border-radius: 4px; }
                .tag { background: ${Config.colors.primary}; color: #000; padding: 2px 6px; border-radius: 3px; font-weight: bold; font-size: 10px; flex-shrink: 0; }
                .res-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
                .res-url { font-size: 10px; color: #666; margin-top: 4px; word-break: break-all; max-height: 32px; overflow: hidden; }
                .res-actions { display: flex; gap: 4px; margin-top: 6px; }
                .res-count { font-size: 10px; color: #888; margin-top: 6px; text-align: center; }
                .selector-row { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
                .selector-row label { color: #aaa; font-size: 11px; white-space: nowrap; }
                .selector-row select { flex: 1; padding: 6px 8px; background: #1a2a1a; color: #fff; border: 1px solid #444; border-radius: 4px; font-size: 11px; min-width: 0; }
                .range-group { margin-bottom: 12px; }
                .range-group-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
                .range-label { color: #9cf; font-size: 11px; font-weight: bold; }
                .range-time-edit { color: #fc6; font-size: 11px; font-family: monospace; cursor: pointer; padding: 2px 6px; background: rgba(0,0,0,0.3); border-radius: 3px; min-width: 64px; text-align: center; outline: none; transition: background 0.2s; }
                .range-time-edit:hover { background: rgba(76,175,80,0.2); }
                .range-time-edit[contenteditable="true"] { background: #111; border: 1px solid ${Config.colors.primary}; color: ${Config.colors.primary}; cursor: text; }
                .video-track { position: relative; height: 6px; background: #333; border-radius: 3px; cursor: pointer; touch-action: none; user-select: none; }
                .video-progress { position: absolute; top: 0; left: 0; height: 100%; background: ${Config.colors.primary}; border-radius: 3px; pointer-events: none; }
                .video-thumb { position: absolute; top: 50%; width: 12px; height: 12px; background: #fff; border: 2px solid ${Config.colors.primary}; border-radius: 50%; cursor: grab; z-index: 2; transform: translate(-50%,-50%); box-shadow: 0 1px 4px rgba(0,0,0,0.5); }
                .video-thumb:active { cursor: grabbing; transform: translate(-50%,-50%) scale(1.2); }
                .total-time-row { display: flex; justify-content: center; margin-top: 6px; }
                .total-time-label { color: #888; font-size: 11px; font-family: monospace; }
                .btn-add { background: #447; color: #fff; padding: 7px 12px; font-size: 11px; width: 100%; margin-top: 8px; }
                .btn-add:hover:not(:disabled) { background: #558; }
                .btn-add:disabled { opacity: 0.5; cursor: not-allowed; }
                .tr-list { margin-top: 8px; }
                .tr-row { background: rgba(30,40,60,0.5); border-radius: 4px; padding: 6px 8px; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; }
                .tr-row:last-child { margin-bottom: 0; }
                .tr-label { color: #9cf; font-weight: bold; font-size: 11px; }
                .tr-times { color: #fc6; font-size: 11px; font-family: monospace; }
                .tr-dur { color: #8f8; font-size: 10px; margin-left: 6px; }
                .tr-del { background: #a33; border: none; color: #fff; border-radius: 3px; padding: 2px 6px; cursor: pointer; font-size: 11px; line-height: 1; }
                .dl-info { background: rgba(20,30,50,0.6); border-radius: 6px; padding: 10px; margin-bottom: 10px; }
                .dl-info-row { display: flex; justify-content: space-between; margin: 3px 0; font-size: 11px; }
                .dl-info-row span:first-child { color: #aaa; }
                .dl-info-row span:last-child { color: #fff; font-weight: bold; }
                .dl-progress { background: rgba(0,0,0,0.3); border-radius: 4px; padding: 10px; margin-bottom: 10px; }
                .dl-progress-bar { height: 14px; background: #333; border-radius: 7px; overflow: hidden; margin-bottom: 6px; }
                .dl-progress-fill { height: 100%; background: linear-gradient(90deg, ${Config.colors.primary}, #6fd66f); border-radius: 7px; transition: width 0.3s; }
                .dl-progress-text { font-size: 14px; font-weight: bold; color: ${Config.colors.primary}; text-align: center; margin-bottom: 4px; }
                .dl-progress-detail { font-size: 10px; color: #aaa; text-align: center; line-height: 1.6; }
                .dl-btn-start { width: 100%; padding: 10px; font-size: 13px; background: ${Config.colors.primary}; color: #000; font-weight: bold; }
                .dl-btn-start:disabled { opacity: 0.5; cursor: not-allowed; }
                .info-bar { padding: 6px 10px; font-size: 11px; min-height: 20px; color: #888; background: rgba(40,40,40,0.4); border-top: 1px solid rgba(255,255,255,0.1); }
                .info-bar.success { background: #1a2a1a; color: #8f8; }
                .info-bar.warn { background: #2a2a1a; color: #fc6; }
                .info-bar.error { background: #2a1a1a; color: #faa; }
            `;

            this.root = Utils.createElement('div', { class: 'box' });
            this.content = Utils.createElement('div');
            this.infoBar = Utils.createElement('div', { class: 'info-bar' });

            this.root.appendChild(this.content);
            this._buildLayout();

            this.root.appendChild(this.infoBar);

            shadow.appendChild(style);
            shadow.appendChild(this.root);

            document.body.appendChild(host);

            this.root.style.display = 'flex';
            this.inited = true;
            this._switchTab('resources');
        }

        _buildLayout() {
            const head = Utils.createElement('div', { class: 'head' }, '🎬 视频嗅探下载器');
            this.root.insertBefore(head, this.content);

            const tabs = Utils.createElement('div', { class: 'tabs' });
            const tabDefs = [
                { key: 'resources', label: '🔗 M3U8资源' },
                { key: 'ranges', label: '⏱ 时间段筛选' },
                { key: 'download', label: '⬇ 下载' }
            ];
            tabDefs.forEach(def => {
                const btn = Utils.createElement('button', { class: 'tab-btn' }, def.label);
                btn.dataset.tab = def.key;
                btn.onclick = () => this._switchTab(def.key);
                this.tabBtns.push(btn);
                tabs.appendChild(btn);
            });
            this.root.insertBefore(tabs, this.content);

            this._buildResourcesPanel();
            this._buildRangePanel();
            this._buildDownloadPanel();
        }

        _buildResourcesPanel() {
            const panel = Utils.createElement('div', { class: 'tab-panel', 'data-tab': 'resources' });
            const listEl = Utils.createElement('div', { class: 'res-list' });
            panel.appendChild(listEl);
            const countEl = Utils.createElement('div', { class: 'res-count' });
            panel.appendChild(countEl);
            this.content.appendChild(panel);
            this.tabPanels.push(panel);
            this._resListEl = listEl;
            this._resCountEl = countEl;
        }

        _buildRangePanel() {
            const panel = Utils.createElement('div', { class: 'tab-panel', 'data-tab': 'ranges' });

            const selRow = Utils.createElement('div', { class: 'selector-row' });
            const selLabel = Utils.createElement('label', {}, '选择资源:');
            const sel = Utils.createElement('select');
            sel.onchange = () => this._onResourceSelected(sel.value);
            selRow.appendChild(selLabel);
            selRow.appendChild(sel);
            panel.appendChild(selRow);
            this.resourceSelectEl = sel;

            const startGroup = Utils.createElement('div', { class: 'range-group' });
            const startHeader = Utils.createElement('div', { class: 'range-group-header' });
            const startLabel = Utils.createElement('span', { class: 'range-label' }, '起始');
            const startTime = Utils.createElement('span', { class: 'range-time-edit' }, '00:00:00');
            startTime.contentEditable = 'false';
            startTime.dataset.type = 'start';
            startTime.onclick = () => this._startTimeEdit(startTime);
            startHeader.appendChild(startLabel);
            startHeader.appendChild(startTime);
            const startTrack = Utils.createElement('div', { class: 'video-track' });
            const startProgress = Utils.createElement('div', { class: 'video-progress' });
            const startThumb = Utils.createElement('div', { class: 'video-thumb' });
            startTrack.appendChild(startProgress);
            startTrack.appendChild(startThumb);
            startTrack.addEventListener('mousedown', (e) => this._onTrackMouseDown(e, 'start'));
            startTrack.addEventListener('touchstart', (e) => this._onTrackTouchStart(e, 'start'), { passive: false });
            startGroup.appendChild(startHeader);
            startGroup.appendChild(startTrack);
            panel.appendChild(startGroup);
            this.startTrack = startTrack;
            this.startProgress = startProgress;
            this.startThumb = startThumb;
            this.startTimeEl = startTime;

            const endGroup = Utils.createElement('div', { class: 'range-group' });
            const endHeader = Utils.createElement('div', { class: 'range-group-header' });
            const endLabel = Utils.createElement('span', { class: 'range-label' }, '结束');
            const endTime = Utils.createElement('span', { class: 'range-time-edit' }, '00:01:00');
            endTime.contentEditable = 'false';
            endTime.dataset.type = 'end';
            endTime.onclick = () => this._startTimeEdit(endTime);
            endHeader.appendChild(endLabel);
            endHeader.appendChild(endTime);
            const endTrack = Utils.createElement('div', { class: 'video-track' });
            const endProgress = Utils.createElement('div', { class: 'video-progress' });
            const endThumb = Utils.createElement('div', { class: 'video-thumb' });
            endTrack.appendChild(endProgress);
            endTrack.appendChild(endThumb);
            endTrack.addEventListener('mousedown', (e) => this._onTrackMouseDown(e, 'end'));
            endTrack.addEventListener('touchstart', (e) => this._onTrackTouchStart(e, 'end'), { passive: false });
            endGroup.appendChild(endHeader);
            endGroup.appendChild(endTrack);
            panel.appendChild(endGroup);
            this.endTrack = endTrack;
            this.endProgress = endProgress;
            this.endThumb = endThumb;
            this.endTimeEl = endTime;

            const totalRow = Utils.createElement('div', { class: 'total-time-row' });
            const totalLabel = Utils.createElement('span', { class: 'total-time-label' }, '总时长: 00:00:00');
            totalRow.appendChild(totalLabel);
            panel.appendChild(totalRow);
            this.totalTimeEl = totalLabel;

            const btnAdd = Utils.createElement('button', { class: 'btn-add' }, '➕ 添加到列表');
            btnAdd.onclick = () => this._addTimeRange();
            panel.appendChild(btnAdd);
            this.btnAddRange = btnAdd;

            const rangeEmpty = Utils.createElement('div', { class: 'empty-range' }, '暂无时间段，点击上方按钮添加');
            panel.appendChild(rangeEmpty);
            this.rangeEmptyEl = rangeEmpty;

            const rangeList = Utils.createElement('div', { class: 'tr-list' });
            rangeList.style.display = 'none';
            panel.appendChild(rangeList);
            this.rangeListEl = rangeList;

            this.content.appendChild(panel);
            this.tabPanels.push(panel);

            document.addEventListener('mousemove', (e) => this._onMouseMove(e));
            document.addEventListener('mouseup', () => this._onMouseUp());
            document.addEventListener('touchmove', (e) => this._onTouchMove(e), { passive: false });
            document.addEventListener('touchend', () => this._onMouseUp());
        }

        _buildDownloadPanel() {
            const panel = Utils.createElement('div', { class: 'tab-panel', 'data-tab': 'download' });

            const infoEl = Utils.createElement('div', { class: 'dl-info' });
            infoEl.style.display = 'none';
            panel.appendChild(infoEl);
            this.dlInfoEl = infoEl;

            const btnStart = Utils.createElement('button', { class: 'dl-btn-start' }, '🚀 开始下载');
            btnStart.onclick = () => this._startDownload();
            panel.appendChild(btnStart);
            this.btnStartDownload = btnStart;

            const progressEl = Utils.createElement('div', { class: 'dl-progress' });
            progressEl.style.display = 'none';
            const bar = Utils.createElement('div', { class: 'dl-progress-bar' });
            const fill = Utils.createElement('div', { class: 'dl-progress-fill' });
            fill.style.width = '0%';
            bar.appendChild(fill);
            const text = Utils.createElement('div', { class: 'dl-progress-text' }, '0%');
            const detail = Utils.createElement('div', { class: 'dl-progress-detail' }, '准备中...');
            progressEl.appendChild(bar);
            progressEl.appendChild(text);
            progressEl.appendChild(detail);
            panel.appendChild(progressEl);
            this.dlProgressBar = fill;
            this.dlProgressText = text;
            this.dlProgressDetail = detail;

            this.content.appendChild(panel);
            this.tabPanels.push(panel);
        }

        _switchTab(name) {
            this.currentTab = name;
            this.tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
            this.tabPanels.forEach(p => p.classList.toggle('active', p.dataset.tab === name));
            if (name === 'ranges') this._refreshResourceSelect();
            if (name === 'download') this._refreshDownloadPanel();
        }

        addResource({ url, type }) {
            const exists = this.resources.some(r => r.url === url);
            if (exists) return;
            this.resources.unshift({ url, type: 'm3u8', name: Utils.getFilename(url) });
            if (this.inited) this._renderResourceList();
        }

        _renderResourceList() {
            if (!this.inited) return;
            this._resListEl.innerHTML = '';
            if (this.resources.length === 0) {
                this._resListEl.innerHTML = '<div class="empty-tip">暂无资源（请在视频页面触发嗅探）</div>';
                this._resCountEl.textContent = '';
                return;
            }

            this.resources.forEach((item, idx) => {
                const el = Utils.createElement('div', { class: 'res-item' });
                const head = Utils.createElement('div', { class: 'res-head' });
                const tag = Utils.createElement('span', { class: 'tag' }, 'M3U8');
                const name = Utils.createElement('span', { class: 'res-name', title: item.url }, item.name);
                head.appendChild(tag);
                head.appendChild(name);
                el.appendChild(head);

                const url = Utils.createElement('div', { class: 'res-url' }, item.url);
                el.appendChild(url);

                const actions = Utils.createElement('div', { class: 'res-actions' });
                const selBtn = Utils.createElement('button', { class: 'btn-select' }, '⏱ 筛选下载');
                selBtn.onclick = async () => {
                    this._switchTab('ranges');
                    await this._selectResource(item);
                };
                actions.appendChild(selBtn);
                const copyBtn = Utils.createElement('button', { class: 'btn-copy' }, '复制');
                copyBtn.onclick = () => this.copyUrl(item.url);
                actions.appendChild(copyBtn);
                el.appendChild(actions);

                this._resListEl.appendChild(el);
            });
            this._resCountEl.textContent = `共发现 ${this.resources.length} 个资源`;
        }

        _refreshResourceSelect() {
            if (!this.resourceSelectEl) return;
            this.resourceSelectEl.innerHTML = '';
            const placeholder = Utils.createElement('option', { value: '' }, '-- 选择M3U8资源 --');
            this.resourceSelectEl.appendChild(placeholder);
            this.resources.forEach(r => {
                const opt = Utils.createElement('option', { value: r.url }, r.name);
                if (this.currentResource && this.currentResource.url === r.url) opt.selected = true;
                this.resourceSelectEl.appendChild(opt);
            });
            if (this.currentResource) {
                this._updateRangeUI();
            } else {
                this._resetRangeUI();
            }
        }

        async _selectResource(item) {
            this._showInfo('⏳ 解析M3U8: ' + item.name, 'warn');
            try {
                const parsed = await parseM3u8(item.url);
                this.currentResource = {
                    url: item.url,
                    name: item.name,
                    segments: parsed.segments,
                    timeList: parsed.timeList,
                    totalDuration: parsed.totalDuration,
                    targetDuration: parsed.targetDuration
                };
                this.timeRanges = [];
                this.timeRanges._curStart = 0;
                this.timeRanges._curEnd = Math.min(60, parsed.totalDuration);
                this._refreshResourceSelect();
                this._updateRangeUI();
                this._renderRangeList();
                this._showInfo('✅ 解析完成: ' + parsed.segments.length + '分片 | ' + Utils.formatTime(parsed.totalDuration), 'success');
            } catch (err) {
                this._showInfo('❌ 解析失败: ' + err.message, 'error');
            }
        }

        async _onResourceSelected(url) {
            if (!url) return;
            const item = this.resources.find(r => r.url === url);
            if (item) await this._selectResource(item);
        }

        _resetRangeUI() {
            this.startProgress.style.width = '0%';
            this.startThumb.style.left = '0%';
            this.endProgress.style.width = '0%';
            this.endThumb.style.left = '0%';
            this.startTimeEl.textContent = '00:00:00';
            this.endTimeEl.textContent = '00:00:00';
            this.totalTimeEl.textContent = '总时长: 00:00:00';
            this.rangeListEl.style.display = 'none';
            this.rangeEmptyEl.style.display = 'block';
        }

        _updateRangeUI() {
            const res = this.currentResource;
            if (!res) return;
            const total = res.totalDuration;
            if (total <= 0) return;

            const curStart = this.timeRanges._curStart || 0;
            const curEnd = this.timeRanges._curEnd || 0;

            const startPct = (curStart / total) * 100;
            this.startProgress.style.width = startPct + '%';
            this.startThumb.style.left = startPct + '%';

            const endPct = (curEnd / total) * 100;
            this.endProgress.style.width = endPct + '%';
            this.endThumb.style.left = endPct + '%';

            this.startTimeEl.textContent = Utils.formatTime(curStart);
            this.endTimeEl.textContent = Utils.formatTime(curEnd);
            this.totalTimeEl.textContent = '总时长: ' + Utils.formatTime(total);

            this.btnAddRange.disabled = curEnd <= curStart;
        }

        _onTrackMouseDown(e, which) {
            e.preventDefault();
            if (!this.currentResource) {
                this._showInfo('⚠️ 请先选择资源', 'warn');
                return;
            }
            this.dragging = which;
            const sec = this._clientXToSec(e.clientX, which);
            this._setTime(which, sec);
        }

        _onTrackTouchStart(e, which) {
            e.preventDefault();
            if (!this.currentResource) {
                this._showInfo('⚠️ 请先选择资源', 'warn');
                return;
            }
            this.dragging = which;
            const touch = e.touches[0];
            const sec = this._clientXToSec(touch.clientX, which);
            this._setTime(which, sec);
        }

        _clientXToSec(clientX, which) {
            const track = which === 'start' ? this.startTrack : this.endTrack;
            const rect = track.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            const total = this.currentResource ? this.currentResource.totalDuration : 0;
            return Math.round(pct * total);
        }

        _onMouseMove(e) {
            if (!this.dragging) return;
            const sec = this._clientXToSec(e.clientX, this.dragging);
            this._setTime(this.dragging, sec);
        }

        _onTouchMove(e) {
            if (!this.dragging) return;
            e.preventDefault();
            const touch = e.touches[0];
            const sec = this._clientXToSec(touch.clientX, this.dragging);
            this._setTime(this.dragging, sec);
        }

        _onMouseUp() {
            this.dragging = null;
        }

        _setTime(which, sec) {
            const total = this.currentResource ? this.currentResource.totalDuration : 0;
            sec = Math.max(0, Math.min(total, sec));
            if (which === 'start') {
                this.timeRanges._curStart = sec;
                if (this.timeRanges._curEnd <= sec) {
                    this.timeRanges._curEnd = Math.min(total, sec + 1);
                }
            } else {
                this.timeRanges._curEnd = sec;
                if (this.timeRanges._curStart >= sec) {
                    this.timeRanges._curStart = Math.max(0, sec - 1);
                }
            }
            this._updateRangeUI();
        }

        _startTimeEdit(el) {
            if (!this.currentResource) {
                this._showInfo('⚠️ 请先选择资源', 'warn');
                return;
            }
            el.contentEditable = 'true';
            el.focus();
            const range = document.createRange();
            range.selectNodeContents(el);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);

            const finishEdit = () => {
                el.contentEditable = 'false';
                const text = el.textContent.trim();
                const sec = Utils.toSeconds(text);
                if (!isNaN(sec) && sec >= 0) {
                    const type = el.dataset.type;
                    this._setTime(type, sec);
                } else {
                    this._updateRangeUI();
                }
            };

            el.onblur = finishEdit;
            el.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    el.blur();
                } else if (e.key === 'Escape') {
                    el.contentEditable = 'false';
                    this._updateRangeUI();
                }
            };
        }

        _addTimeRange() {
            const start = this.timeRanges._curStart;
            const end = this.timeRanges._curEnd;
            if (end <= start) {
                this._showInfo('⚠️ 结束时间必须大于起始时间', 'warn');
                return;
            }
            this.timeRanges.push({ start, end });
            this._showInfo('✅ 已添加时间段', 'success');
            this._renderRangeList();

            const total = this.currentResource ? this.currentResource.totalDuration : 0;
            const nextStart = Math.min(end, total);
            this.timeRanges._curStart = nextStart;
            this.timeRanges._curEnd = Math.min(nextStart + 60, total);
            if (this.timeRanges._curEnd <= this.timeRanges._curStart) {
                this.timeRanges._curEnd = total;
                this.timeRanges._curStart = Math.max(0, total - 60);
            }
            this._updateRangeUI();
        }

        _renderRangeList() {
            if (this.timeRanges.length === 0) {
                this.rangeListEl.style.display = 'none';
                this.rangeEmptyEl.style.display = 'block';
                return;
            }
            this.rangeEmptyEl.style.display = 'none';
            this.rangeListEl.style.display = 'block';
            this.rangeListEl.innerHTML = '';
            this.timeRanges.forEach((r, idx) => {
                const dur = r.end - r.start;
                const row = Utils.createElement('div', { class: 'tr-row' });
                const left = Utils.createElement('div');
                left.style.display = 'flex';
                left.style.alignItems = 'center';
                const label = Utils.createElement('span', { class: 'tr-label' }, '段' + (idx + 1));
                const times = Utils.createElement('span', { class: 'tr-times' }, Utils.formatTime(r.start) + ' → ' + Utils.formatTime(r.end));
                const durEl = Utils.createElement('span', { class: 'tr-dur' }, '(' + dur + 's)');
                left.appendChild(label);
                left.appendChild(times);
                left.appendChild(durEl);
                const delBtn = Utils.createElement('button', { class: 'tr-del' }, '✕');
                delBtn.onclick = () => {
                    this.timeRanges.splice(idx, 1);
                    this._renderRangeList();
                };
                row.appendChild(left);
                row.appendChild(delBtn);
                this.rangeListEl.appendChild(row);
            });
        }

        _refreshDownloadPanel() {
            const res = this.currentResource;
            if (!res) {
                this.dlInfoEl.style.display = 'none';
                this.btnStartDownload.disabled = true;
                this.dlProgressBar.parentElement.style.display = 'none';
                return;
            }

            const totalRangeDur = this.timeRanges.reduce((sum, r) => sum + (r.end - r.start), 0);
            const totalSegs = this.timeRanges.reduce((sum, r) => {
                const mapped = timeToSegmentIndex(res.timeList, r.start, r.end);
                return sum + (mapped.endIdx - mapped.startIdx + 1);
            }, 0);

            this.dlInfoEl.style.display = 'block';
            this.dlInfoEl.innerHTML = `
                <div class="dl-info-row"><span>下载目标</span><span>${res.name}</span></div>
                <div class="dl-info-row"><span>资源</span><span>${res.name}</span></div>
                <div class="dl-info-row"><span>分片数</span><span>${res.segments.length}</span></div>
                <div class="dl-info-row"><span>时长</span><span>${Utils.formatTime(res.totalDuration)}</span></div>
                <div class="dl-info-row"><span>选中段</span><span>${this.timeRanges.length} 段 | ${Utils.formatTime(totalRangeDur)}</span></div>
            `;

            const hasRanges = this.timeRanges.length > 0;
            this.btnStartDownload.disabled = !hasRanges;
            this.btnStartDownload.textContent = hasRanges ? '🚀 开始下载' : '⚠️ 请先添加时间段';
            this.dlProgressBar.parentElement.style.display = 'none';
            this.dlProgressBar.style.width = '0%';
        }

        async _startDownload() {
            if (!this.currentResource || this.timeRanges.length === 0) {
                this._showInfo('⚠️ 请先选择资源并添加时间段', 'warn');
                return;
            }

            const res = this.currentResource;
            this.dlProgressBar.parentElement.style.display = 'block';
            this.dlProgressBar.style.width = '0%';
            this.dlProgressText.textContent = '0%';
            this.dlProgressDetail.textContent = '初始化中...';
            this.btnStartDownload.disabled = true;
            this.btnStartDownload.textContent = '⏳ 下载中...';

            const ranges = [...this.timeRanges];
            const opt = { ranges };

            if (ranges.length === 1) {
                this._showInfo('📌 下载时间段: ' + Utils.formatTime(ranges[0].start) + ' → ' + Utils.formatTime(ranges[0].end), 'warn');
            } else {
                const segCount = ranges.reduce((sum, r) => {
                    const mapped = timeToSegmentIndex(res.timeList, r.start, r.end);
                    return sum + (mapped.endIdx - mapped.startIdx + 1);
                }, 0);
                this._showInfo(`📌 多段模式：${ranges.length} 段 | 共 ${segCount} 个分片`, 'warn');
            }

            console.log('[UI._startDownload] 资源:', res.name, '时间段:', ranges);

            try {
                await window.TaskRunner(res.url, 'm3u8', this.btnStartDownload, opt);
                this.dlProgressBar.style.width = '100%';
                this.dlProgressText.textContent = '100%';
                this.dlProgressDetail.textContent = '✅ 下载完成';
                this.btnStartDownload.textContent = '✅ 重新下载';
                this.btnStartDownload.disabled = false;
                this._showInfo('✅ 下载完成: ' + res.name, 'success');
            } catch (err) {
                this.dlProgressDetail.textContent = '❌ 下载失败: ' + (err.message || err);
                this.btnStartDownload.textContent = '🔄 重试';
                this.btnStartDownload.disabled = false;
                this._showInfo('❌ 下载失败: ' + (err.message || err), 'error');
            }
        }

        copyUrl(url) {
            Utils.copyToClipboard(url).then(() => {
                this._showInfo('✅ 已复制链接', 'success');
            }).catch(() => {
                this._showInfo('❌ 复制失败', 'error');
            });
        }

        _showInfo(text, type) {
            this.infoBar.textContent = text;
            this.infoBar.className = 'info-bar' + (type ? ' ' + type : '');
        }
    }

    // 嗅探器立刻启动（网络劫持需要尽早）
    new Sniffer().start();
    // UI延迟等待body就绪后初始化
    const ui = new UI();
    ui.init().catch(err => console.error('[嗅探器] UI初始化失败:', err));
})();