// ==UserScript==
// @name         M3U8预览与正则生成
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  自动解析m3u8，新标签页预览视频+进度条选择时间段，生成正则表达式
// @match        *://*/*
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const T = {
        title: 'M3U8预览',
        parse: '解析',
        preview: '预览',
        copy: '复制',
        generate: '生成正则'
    };

    const waitBody = () => new Promise(resolve => {
        if (document.body) return resolve(document.body);
        const observer = new MutationObserver(() => {
            if (document.body) {
                observer.disconnect();
                resolve(document.body);
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(() => {
            if (document.body) { observer.disconnect(); resolve(document.body); }
        }, 5000);
    });

    const getRealWindow = () => {
        try {
            if (window.fetch && /native code/.test(window.fetch.toString())) return window;
        } catch (e) {}
        try {
            if (typeof unsafeWindow !== 'undefined') {
                if (unsafeWindow && unsafeWindow.fetch) return unsafeWindow;
            }
        } catch (e) {}
        return window;
    };

    const Utils = {
        request: (url) => {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    responseType: 'text',
                    headers: { 'Referer': location.href, 'Origin': location.origin },
                    timeout: 60000,
                    onload: (res) => {
                        if (res.status >= 200 && res.status < 300) resolve(res.response);
                        else reject(new Error(`HTTP ${res.status}`));
                    },
                    onerror: (err) => reject(err),
                    ontimeout: () => reject(new Error('Timeout'))
                });
            });
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

        formatTime: (seconds) => {
            if (!isFinite(seconds) || seconds <= 0) return '00:00:00';
            seconds = Math.floor(seconds);
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = seconds % 60;
            const pad = (n) => n.toString().padStart(2, '0');
            return `${pad(h)}:${pad(m)}:${pad(s)}`;
        },

        getFileName: (url) => {
            const cleanUrl = url.split('?')[0];
            let name = cleanUrl.split('/').pop();
            if (!name || name.trim() === '' || name === '/') name = `video_${Date.now()}.ts`;
            return decodeURIComponent(name);
        },

        numToHms: (digits) => {
            let s = digits.replace(/\D/g, '').slice(0, 6);
            let result = '';
            for (let i = 0; i < s.length; i++) {
                if (i === 2 || i === 4) result += ':';
                result += s[i];
            }
            return result;
        },

        escapeRegex: (str) => {
            return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        },

        commonPrefix: (a, b) => {
            let i = 0;
            while (i < a.length && i < b.length && a[i] === b[i]) i++;
            return a.substring(0, i);
        },

        buildSuffixRegex: (minS, maxS) => {
            if (minS === maxS) return minS;
            if (minS.length === 1) return `[${minS}-${maxS}]`;
            const minFirst = Number(minS[0]);
            const maxFirst = Number(maxS[0]);
            if (minFirst === maxFirst) {
                return minFirst + Utils.buildSuffixRegex(minS.substring(1), maxS.substring(1));
            }
            const parts = [];
            parts.push(String(minFirst) + Utils.buildSuffixRegex(minS.substring(1), '9'.repeat(minS.length - 1)));
            parts.push(String(maxFirst) + Utils.buildSuffixRegex('0'.repeat(maxS.length - 1), maxS.substring(1)));
            if (maxFirst - minFirst > 1) {
                const mid = minFirst + 1 === maxFirst - 1
                    ? String(minFirst + 1)
                    : `[${minFirst + 1}-${maxFirst - 1}]`;
                parts.push(mid + '\\d'.repeat(minS.length - 1));
            }
            return `(?:${parts.join('|')})`;
        },

        buildSameLengthRegex: (minStr, maxStr) => {
            if (minStr === maxStr) return minStr;
            const prefix = Utils.commonPrefix(minStr, maxStr);
            const suffixMin = minStr.substring(prefix.length);
            const suffixMax = maxStr.substring(prefix.length);
            const suffixRegex = Utils.buildSuffixRegex(suffixMin, suffixMax);
            return prefix + suffixRegex;
        },

        buildNumericRangeRegex: (min, max) => {
            if (min === max) return `(?<!\\d)${min}(?!\\d)`;
            const minStr = String(min);
            const maxStr = String(max);
            if (minStr.length !== maxStr.length) {
                const parts = [];
                const shortMax = Math.pow(10, minStr.length) - 1;
                parts.push(Utils.buildSameLengthRegex(minStr, String(shortMax)));
                for (let len = minStr.length + 1; len < maxStr.length; len++) {
                    parts.push('[1-9]' + '\\d'.repeat(len - 1));
                }
                const longMin = Math.pow(10, maxStr.length - 1);
                parts.push(Utils.buildSameLengthRegex(String(longMin), maxStr));
                return `(?<!\\d)(?:${parts.join('|')})(?!\\d)`;
            }
            return `(?<!\\d)${Utils.buildSameLengthRegex(minStr, maxStr)}(?!\\d)`;
        }
    };

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

        for (const line of lines) {
            const l = line.trim();
            if (!l) continue;
            if (l.startsWith('#EXT-X-KEY')) {
                const method = (l.match(/METHOD=([^,]+)/) || [])[1];
                const uri = (l.match(/URI="([^"]+)"/) || [])[1];
                const ivHex = (l.match(/IV=(0x[\da-f]+)/i) || [])[1];
                if (method === 'AES-128' && uri) {
                    currentKey = Utils.resolveUrl(url, uri);
                    currentIV = ivHex ? ivHex : null;
                }
            } else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
                sequence = parseInt(l.split(':')[1]);
            } else if (l.startsWith('#EXTINF:')) {
                currentInf = parseFloat(l.match(/#EXTINF:([\d.]+)/)[1]);
            } else if (!l.startsWith('#')) {
                const segUrl = Utils.resolveUrl(url, l);
                segments.push({
                    url: segUrl,
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
    };

    const timeToSegmentIndex = (timeList, beginSec, endSec) => {
        let startIdx = 0;
        let endIdx = timeList.length - 1;
        for (let i = 0; i < timeList.length; i++) {
            if (timeList[i].tEnd >= beginSec) {
                startIdx = i;
                break;
            }
        }
        for (let i = timeList.length - 1; i >= 0; i--) {
            if (timeList[i].tStart <= endSec) {
                endIdx = i;
                break;
            }
        }
        return { startIdx, endIdx };
    };

    const generateRegexFromSegments = (segments) => {
        if (segments.length === 0) return null;

        function getFileName(seg) {
            const url = new URL(seg.url);
            const parts = url.pathname.split('/').filter(Boolean);
            const fullName = parts[parts.length - 1];
            const dotIdx = fullName.lastIndexOf('.');
            return dotIdx === -1 ? fullName : fullName.substring(0, dotIdx);
        }

        const firstFile = getFileName(segments[0]);
        const lastFile = getFileName(segments[segments.length - 1]);
        const isNumeric = /^\d+$/.test(firstFile) && /^\d+$/.test(lastFile);

        if (isNumeric) {
            const min = Number(firstFile);
            const max = Number(lastFile);
            return Utils.buildNumericRangeRegex(min, max);
        } else {
            const names = segments.map(getFileName).map(Utils.escapeRegex);
            return `\\b(?:${names.join('|')})\\b`;
        }
    };

    const openPreviewPage = (m3u8Data) => {
        const { url, segments, timeList, totalDuration } = m3u8Data;
        const segmentsJson = JSON.stringify({ url, segments, timeList, totalDuration });
        const safeTitle = document.title.replace(/[\\/:*?"<>|]/g, ' ').trim() || 'M3U8预览';

        const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>${safeTitle}</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{padding:12px;padding-bottom:calc(12px + env(safe-area-inset-bottom));font-family:system-ui;font-size:14px;background:#1a1a2e;color:#eee;min-height:100vh;-webkit-text-size-adjust:100%}
h2{margin-bottom:12px;color:#4caf50;font-size:16px}
.player-box{background:#16213e;border-radius:8px;padding:8px;margin-bottom:12px}
video{width:100%;max-height:420px;background:#000;border-radius:4px;display:block}
.info{background:#16213e;border-radius:8px;padding:12px;display:grid;grid-template-columns:1fr;gap:8px;margin-top:16px}
.info p{margin:4px 0;word-break:break-all}
.label{color:#888}
.value{color:#4caf50;font-weight:bold}
@media(min-width:600px){
    .info{grid-template-columns:1fr 1fr}
}
.section{background:#16213e;border-radius:8px;padding:10px;margin-bottom:12px}
.section-title{color:#fc6;font-weight:bold;font-size:12px;margin-bottom:8px}
.time-range-list{max-height:200px;overflow-y:auto}
.time-range-row{display:flex;align-items:center;gap:4px;margin:3px 0}
.time-range-row span{color:#9cf;font-size:11px}
.progress-bar-container{position:relative;height:36px;background:#333;border-radius:4px;margin:8px 0;cursor:pointer;overflow:hidden;touch-action:none}
.progress-bar-fill{height:100%;background:linear-gradient(90deg,#4caf50,#2196F3);border-radius:4px;transition:width 0.1s}
.progress-bar-markers{position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none}
.progress-bar-marker{position:absolute;top:0;height:100%;background:rgba(255,165,0,0.3);border-left:2px solid #ffa500;border-right:2px solid #ffa500}
.progress-bar-handle{position:absolute;top:0;width:4px;height:100%;background:#ffa500;cursor:ew-resize}
.time-input-row{display:flex;align-items:center;gap:8px;margin:8px 0}
.time-input-row label{color:#9cf;font-size:12px;min-width:40px}
.time-input-row input[type="text"]{width:80px;padding:8px 6px;background:#222;color:#fff;border:1px solid #555;border-radius:3px;text-align:center;font-size:16px}
.time-input-row .time-display{color:#8f8;font-size:12px;min-width:70px}
.hint{color:#aaa;font-size:11px;margin:4px 0}
.msg{padding:6px;border-radius:4px;font-size:11px;margin-top:8px;min-height:20px}
.msg-success{background:#1a2a1a;color:#8f8}
.msg-error{background:#2a1a1a;color:#faa}
.msg-warn{background:#2a2a1a;color:#fc6}
.btn-row{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
button{border:none;padding:10px 12px;border-radius:4px;cursor:pointer;font-size:12px;color:#fff;min-height:36px}
.btn-primary{background:#26c;font-weight:bold}
.btn-success{background:#2a7}
.btn-warning{background:#c82}
.btn-secondary{background:#488}
textarea{width:100%;padding:8px;background:#111;color:#6f9;border:1px solid #333;border-radius:4px;font-family:monospace;font-size:11px;box-sizing:border-box;min-height:60px}
.time-range-row input{width:72px;padding:8px 4px;box-sizing:border-box;background:#222;color:#fff;border:1px solid #555;border-radius:3px;font-size:14px}
.time-range-row button{background:#a33;border:none;color:#fff;border-radius:3px;padding:8px 8px;cursor:pointer;font-size:11px;min-height:32px}</style>
</head>
<body>
<h2>🎬 M3U8 预览与正则生成</h2>
<div class="player-box">
<video id="player" controls></video>
</div>
<div class="section">
<div class="section-title">📍 时间段选择（进度条 + 手动输入）</div>
<div class="time-input-row">
<label>起点</label>
<div class="progress-bar-container" id="startProgressBar">
<div class="progress-bar-fill" id="startProgressFill" style="width:0%"></div>
</div>
<input type="text" id="startTimeInput" value="00:00:00" placeholder="000120">
<span class="time-display" id="startTimeDisplay">00:00:00</span>
</div>
<div class="hint">💡 点击/拖拽进度条或手动输入设置起点</div>

<div class="time-input-row">
<label>终点</label>
<div class="progress-bar-container" id="endProgressBar">
<div class="progress-bar-fill" id="endProgressFill" style="width:0%"></div>
</div>
<input type="text" id="endTimeInput" value="00:01:00" placeholder="000230">
<span class="time-display" id="endTimeDisplay">00:01:00</span>
</div>
<div class="hint">💡 点击/拖拽进度条或手动输入设置终点</div>

<div class="btn-row">
<button class="btn-primary" id="btnAddRange">➕ 添加时间段</button>
</div>

<div style="border-top:1px solid #333;margin-top:12px;padding-top:8px;">
<div style="color:#9cf;font-size:11px;margin-bottom:4px;">已添加的时间段：</div>
<div id="timeRangeList" class="time-range-list"></div>
<div class="btn-row">
<button class="btn-warning" id="btnClearRanges">🗑️ 清空全部</button>
</div>
</div>
</div>

<div class="section">
<div class="section-title">🔍 正则生成</div>
<div class="btn-row">
<button class="btn-success" id="btnGenRegex">生成正则</button>
<button class="btn-warning" id="btnCopyRegex">复制正则</button>
<button class="btn-secondary" id="btnCopyUrls">复制匹配URL</button>
</div>
<textarea id="regexOutput" rows="3" placeholder="点击『生成正则』后显示..." style="margin-top:8px"></textarea>
<div id="regexMsg" class="msg" style="display:none"></div>
</div>

<div class="info">
<div><span class="label">原始地址：</span><br><a target="_blank" href="${url}" style="color:#2196F3;word-break:break-all">${url}</a></div>
<div><span class="label">分片总数：</span><br><span class="value">${segments.length}</span></div>
<div><span class="label">总时长：</span><br><span class="value">${Utils.formatTime(totalDuration)}</span></div>
<div><span class="label">加密状态：</span><br><span class="value">${segments.some(s => s.key) ? 'AES-128加密' : '未加密'}</span></div>
</div>

<script>
const videoData = ${segmentsJson};
const video = document.getElementById('player');
const startProgressBar = document.getElementById('startProgressBar');
const startProgressFill = document.getElementById('startProgressFill');
const endProgressBar = document.getElementById('endProgressBar');
const endProgressFill = document.getElementById('endProgressFill');
const startTimeInput = document.getElementById('startTimeInput');
const endTimeInput = document.getElementById('endTimeInput');
const startTimeDisplay = document.getElementById('startTimeDisplay');
const endTimeDisplay = document.getElementById('endTimeDisplay');
const timeRangeList = document.getElementById('timeRangeList');

let timeRanges = [];
let currentStartSec = 0;
let currentEndSec = 60;
let isDraggingStart = false;
let isDraggingEnd = false;
let currentHls = null;
let regexResult = '';

function formatTime(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '00:00:00';
    seconds = Math.floor(seconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const pad = n => n.toString().padStart(2, '0');
    return pad(h) + ':' + pad(m) + ':' + pad(s);
}

function secToTime(sec) {
    sec = Math.floor(sec);
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return h + ':' + m + ':' + s;
}

function numToHms(digits) {
    let s = digits.replace(/\D/g, '').slice(0, 6);
    let result = '';
    for (let i = 0; i < s.length; i++) {
        if (i === 2 || i === 4) result += ':';
        result += s[i];
    }
    return result;
}

function timeToSec(str) {
    const arr = str.split(':').map(Number);
    if (arr.length !== 3 || arr.some(n => isNaN(n))) throw new Error('时间格式错误');
    return arr[0] * 3600 + arr[1] * 60 + arr[2];
}

function updateStartBar(sec) {
    currentStartSec = Math.max(0, Math.min(sec, videoData.totalDuration));
    const pct = (currentStartSec / videoData.totalDuration) * 100;
    startProgressFill.style.width = pct + '%';
    startTimeInput.value = secToTime(currentStartSec);
    startTimeDisplay.textContent = secToTime(currentStartSec);
}

function updateEndBar(sec) {
    currentEndSec = Math.max(0, Math.min(sec, videoData.totalDuration));
    const pct = (currentEndSec / videoData.totalDuration) * 100;
    endProgressFill.style.width = pct + '%';
    endTimeInput.value = secToTime(currentEndSec);
    endTimeDisplay.textContent = secToTime(currentEndSec);
}

function renderTimeRanges() {
    timeRangeList.innerHTML = timeRanges.map((r, i) => {
        return '<div class="time-range-row" data-idx="' + i + '">' +
            '<span>段' + (i + 1) + ':</span>' +
            '<input class="tr-start" value="' + secToTime(r.start) + '" placeholder="000120">' +
            '<span style="color:#888">-</span>' +
            '<input class="tr-end" value="' + secToTime(r.end) + '" placeholder="000230">' +
            '<button class="tr-del" data-idx="' + i + '">✕</button>' +
            '</div>';
    }).join('');

    timeRangeList.querySelectorAll('.tr-del').forEach(btn => {
        btn.onclick = () => {
            const idx = parseInt(btn.dataset.idx);
            if (timeRanges.length <= 1) { alert('至少保留一个时间段'); return; }
            timeRanges.splice(idx, 1);
            renderTimeRanges();
        };
    });

    timeRangeList.querySelectorAll('.tr-start, .tr-end').forEach(input => {
        input.addEventListener('input', function () {
            const raw = this.value;
            const onlyDigits = raw.replace(/\D/g, '').slice(0, 6);
            this.value = numToHms(onlyDigits);
            this.selectionStart = this.selectionEnd = this.value.length;
        });
    });
}

function collectTimeRanges() {
    const rows = timeRangeList.querySelectorAll('.time-range-row');
    const newRanges = [];
    for (const row of rows) {
        const startStr = row.querySelector('.tr-start').value.trim();
        const endStr = row.querySelector('.tr-end').value.trim();
        let s, e;
        try {
            s = timeToSec(startStr);
            e = timeToSec(endStr);
        } catch {
            alert('时间段格式错误');
            return null;
        }
        if (s >= e) {
            alert('开始时间需早于结束时间');
            return null;
        }
        newRanges.push({ start: s, end: e });
    }
    timeRanges = newRanges;
    return newRanges;
}

function getSegmentsByTimeRange(startSec, endSec) {
    const { startIdx, endIdx } = timeToSegmentIndex(videoData.timeList, startSec, endSec);
    return videoData.segments.slice(startIdx, endIdx + 1);
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

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\\\]/g, '\\\\$&');
}

function commonPrefix(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return a.substring(0, i);
}

function buildSuffixRegex(minS, maxS) {
    if (minS === maxS) return minS;
    if (minS.length === 1) return '[' + minS + '-' + maxS + ']';
    const minFirst = Number(minS[0]);
    const maxFirst = Number(maxS[0]);
    if (minFirst === maxFirst) {
        return minFirst + buildSuffixRegex(minS.substring(1), maxS.substring(1));
    }
    const parts = [];
    parts.push(String(minFirst) + buildSuffixRegex(minS.substring(1), '9'.repeat(minS.length - 1)));
    parts.push(String(maxFirst) + buildSuffixRegex('0'.repeat(maxS.length - 1), maxS.substring(1)));
    if (maxFirst - minFirst > 1) {
        const mid = minFirst + 1 === maxFirst - 1 ? String(minFirst + 1) : '[' + (minFirst + 1) + '-' + (maxFirst - 1) + ']';
        parts.push(mid + '\\d'.repeat(minS.length - 1));
    }
    return '(?:' + parts.join('|') + ')';
}

function buildSameLengthRegex(minStr, maxStr) {
    if (minStr === maxStr) return minStr;
    const prefix = commonPrefix(minStr, maxStr);
    const suffixMin = minStr.substring(prefix.length);
    const suffixMax = maxStr.substring(prefix.length);
    const suffixRegex = buildSuffixRegex(suffixMin, suffixMax);
    return prefix + suffixRegex;
}

function buildNumericRangeRegex(min, max) {
    if (min === max) return '(?<!\\d)' + min + '(?!\\d)';
    const minStr = String(min);
    const maxStr = String(max);
    if (minStr.length !== maxStr.length) {
        const parts = [];
        const shortMax = Math.pow(10, minStr.length) - 1;
        parts.push(buildSameLengthRegex(minStr, String(shortMax)));
        for (let len = minStr.length + 1; len < maxStr.length; len++) {
            parts.push('[1-9]' + '\\d'.repeat(len - 1));
        }
        const longMin = Math.pow(10, maxStr.length - 1);
        parts.push(buildSameLengthRegex(String(longMin), maxStr));
        return '(?<!\\d)(?:' + parts.join('|') + ')(?!\\d)';
    }
    return '(?<!\\d)' + buildSameLengthRegex(minStr, maxStr) + '(?!\\d)';
}

function generateRegexFromSegments(segments) {
    if (segments.length === 0) return null;
    function getFileName(seg) {
        const url = new URL(seg.url);
        const parts = url.pathname.split('/').filter(Boolean);
        const fullName = parts[parts.length - 1];
        const dotIdx = fullName.lastIndexOf('.');
        return dotIdx === -1 ? fullName : fullName.substring(0, dotIdx);
    }
    const firstFile = getFileName(segments[0]);
    const lastFile = getFileName(segments[segments.length - 1]);
    const isNumeric = /^\d+$/.test(firstFile) && /^\d+$/.test(lastFile);
    if (isNumeric) {
        const min = Number(firstFile);
        const max = Number(lastFile);
        return buildNumericRangeRegex(min, max);
    } else {
        const names = segments.map(getFileName).map(escapeRegex);
        return '\\b(?:' + names.join('|') + ')\\b';
    }
}

function copyToClipboard(text) {
    if (typeof GM_setClipboard !== 'undefined') {
        try { GM_setClipboard(text); return true; } catch (e) {}
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {}).catch(() => {});
        return true;
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
        return true;
    } catch (e) { return false; }
}

function showMsg(text, type) {
    const msgEl = document.getElementById('regexMsg');
    msgEl.style.display = 'block';
    msgEl.textContent = text;
    msgEl.className = 'msg msg-' + type;
}

// 起点进度条交互
startProgressBar.addEventListener('mousedown', (e) => {
    isDraggingStart = true;
    handleStartBarClick(e);
});
startProgressBar.addEventListener('mousemove', (e) => {
    if (isDraggingStart) handleStartBarClick(e);
});
startProgressBar.addEventListener('mouseup', () => { isDraggingStart = false; });
startProgressBar.addEventListener('touchstart', (e) => {
    isDraggingStart = true;
    handleStartBarClick(e.touches[0]);
});
startProgressBar.addEventListener('touchmove', (e) => {
    if (isDraggingStart) handleStartBarClick(e.touches[0]);
});
startProgressBar.addEventListener('touchend', () => { isDraggingStart = false; });

// 终点进度条交互
endProgressBar.addEventListener('mousedown', (e) => {
    isDraggingEnd = true;
    handleEndBarClick(e);
});
endProgressBar.addEventListener('mousemove', (e) => {
    if (isDraggingEnd) handleEndBarClick(e);
});
endProgressBar.addEventListener('mouseup', () => { isDraggingEnd = false; });
endProgressBar.addEventListener('touchstart', (e) => {
    isDraggingEnd = true;
    handleEndBarClick(e.touches[0]);
});
endProgressBar.addEventListener('touchmove', (e) => {
    if (isDraggingEnd) handleEndBarClick(e.touches[0]);
});
endProgressBar.addEventListener('touchend', () => { isDraggingEnd = false; });

function seekVideo(sec) {
    try {
        if (isFinite(sec) && sec >= 0 && sec <= videoData.totalDuration) {
            video.currentTime = sec;
        }
    } catch(e) {}
}

function handleStartBarClick(e) {
    const rect = startProgressBar.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    const sec = pct * videoData.totalDuration;
    updateStartBar(sec);
    seekVideo(sec);
}

function handleEndBarClick(e) {
    const rect = endProgressBar.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    const sec = pct * videoData.totalDuration;
    updateEndBar(sec);
    seekVideo(sec);
}

// 手动输入同步
startTimeInput.addEventListener('input', function() {
    const raw = this.value;
    const onlyDigits = raw.replace(/\D/g, '').slice(0, 6);
    if (onlyDigits.length > 0) {
        this.value = numToHms(onlyDigits);
        this.selectionStart = this.selectionEnd = this.value.length;
        try {
            const sec = timeToSec(this.value);
            updateStartBar(sec);
            seekVideo(sec);
        } catch(e) {}
    }
});

endTimeInput.addEventListener('input', function() {
    const raw = this.value;
    const onlyDigits = raw.replace(/\D/g, '').slice(0, 6);
    if (onlyDigits.length > 0) {
        this.value = numToHms(onlyDigits);
        this.selectionStart = this.selectionEnd = this.value.length;
        try {
            const sec = timeToSec(this.value);
            updateEndBar(sec);
            seekVideo(sec);
        } catch(e) {}
    }
});

// 添加时间段
document.getElementById('btnAddRange').onclick = () => {
    let start = currentStartSec;
    let end = currentEndSec;
    if (end <= start) {
        end = Math.min(start + 60, videoData.totalDuration);
    }
    if (end > videoData.totalDuration) end = videoData.totalDuration;
    if (start >= end) { showMsg('⚠️ 时间段无效', 'warn'); return; }
    timeRanges.push({ start, end });
    renderTimeRanges();
    
    // 重置为下一段默认值
    updateStartBar(end);
    updateEndBar(end + 60);
    showMsg('✅ 已添加时间段: ' + secToTime(start) + ' - ' + secToTime(end), 'success');
};

document.getElementById('btnClearRanges').onclick = () => {
    timeRanges = [];
    renderTimeRanges();
    updateStartBar(0);
    updateEndBar(Math.min(60, videoData.totalDuration));
    showMsg('🗑️ 已清空时间段', 'warn');
};

document.getElementById('btnGenRegex').onclick = () => {
    const ranges = collectTimeRanges();
    if (!ranges) return;
    if (ranges.length === 0) { showMsg('⚠️ 请添加时间段', 'warn'); return; }

    const allSegments = [];
    const seenUrls = new Set();
    for (const range of ranges) {
        const segs = getSegmentsByTimeRange(range.start, range.end);
        for (const seg of segs) {
            if (!seenUrls.has(seg.url)) {
                seenUrls.add(seg.url);
                allSegments.push(seg);
            }
        }
    }

    if (allSegments.length === 0) { showMsg('⚠️ 筛选结果为空', 'warn'); return; }

    const rangeParts = [];
    for (const range of ranges) {
        const segs = getSegmentsByTimeRange(range.start, range.end);
        if (segs.length === 0) continue;
        const regex = generateRegexFromSegments(segs);
        if (regex) rangeParts.push(regex);
    }

    if (rangeParts.length === 0) { showMsg('❌ 无法生成正则', 'error'); return; }

    regexResult = rangeParts.join('|');
    document.getElementById('regexOutput').value = regexResult;
    showMsg('✅ 正则生成成功（' + allSegments.length + '个分片）', 'success');
};

document.getElementById('btnCopyRegex').onclick = () => {
    const val = document.getElementById('regexOutput').value.trim();
    if (!val) { showMsg('⚠️ 正则为空', 'warn'); return; }
    copyToClipboard(val);
    showMsg('✅ 正则已复制', 'success');
};

document.getElementById('btnCopyUrls').onclick = () => {
    const ranges = collectTimeRanges();
    if (!ranges) return;
    const allUrls = [];
    const seenUrls = new Set();
    for (const range of ranges) {
        const segs = getSegmentsByTimeRange(range.start, range.end);
        for (const seg of segs) {
            if (!seenUrls.has(seg.url)) {
                seenUrls.add(seg.url);
                allUrls.push(seg.url);
            }
        }
    }
    if (allUrls.length === 0) { showMsg('⚠️ 无匹配URL', 'warn'); return; }
    GM_setClipboard(allUrls.join('\\n'));
    showMsg('✅ 已复制 ' + allUrls.length + ' 个URL', 'success');
};

if (Hls.isSupported()) {
    currentHls = new Hls();
    currentHls.loadSource(videoData.url);
    currentHls.attachMedia(video);
    currentHls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
} else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = videoData.url;
    video.play().catch(() => {});
}

// 初始化
updateStartBar(0);
updateEndBar(Math.min(60, videoData.totalDuration));
renderTimeRanges();
<\/script>
</body>
</html>`;

        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const previewUrl = URL.createObjectURL(blob);
        const win = window.open(previewUrl, '_blank');
        if (!win) {
            if (confirm('新窗口被拦截，是否在当前页面打开预览？')) {
                window.location.href = previewUrl;
            }
        }
    };

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
            const targetWindow = getRealWindow();
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
            const targetWindow = getRealWindow();
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

    class UI {
        constructor() {
            this.root = null;
            this.list = null;
            this.toggleBtn = null;
            this.resources = [];
            this.openIndex = -1;
            this.inited = false;
            this.parseCache = {};
            Bus.on('video-found', (data) => {
                this.addResource(data);
            });
        }

        async init() {
            if (this.inited) return;
            await waitBody();
            if (document.getElementById('gm-m3u8-preview-ui')) return;

            try {
                const host = document.createElement('div');
                host.id = 'gm-m3u8-preview-ui';
                host.style.cssText = 'position:fixed;bottom:calc(20px + env(safe-area-inset-bottom));left:20px;z-index:999999;';

            const style = document.createElement('style');
            style.textContent = `
                #gm-m3u8-preview-ui .box {
                    width: min(340px, calc(100vw - 40px)); background: rgba(0,0,0,0.9); color: #fff;
                    border: 1px solid #4caf50; border-radius: 8px;
                    backdrop-filter: blur(5px); display: flex; flex-direction: column;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.5); font-family: sans-serif; font-size: 12px;
                }
                #gm-m3u8-preview-ui .head {
                    padding: 8px 12px; background: rgba(255,255,255,0.08);
                    display: flex; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1);
                    font-weight: bold; color: #4caf50;
                }
                #gm-m3u8-preview-ui .list { max-height: 260px; overflow-y: auto; padding: 4px 0; }
                #gm-m3u8-preview-ui .item { border-bottom: 1px solid rgba(255,255,255,0.06); }
                #gm-m3u8-preview-ui .item:last-child { border-bottom: none; }
                #gm-m3u8-preview-ui .item-head {
                    padding: 8px 12px; cursor: pointer; display: flex; gap: 8px;
                    align-items: center; transition: background 0.15s;
                }
                #gm-m3u8-preview-ui .item-head:hover { background: rgba(255,255,255,0.05); }
                #gm-m3u8-preview-ui .tag {
                    background: #4caf50; color: #000; padding: 2px 6px; border-radius: 3px;
                    font-weight: bold; font-size: 10px; flex-shrink: 0;
                }
                #gm-m3u8-preview-ui .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                #gm-m3u8-preview-ui .chevron { transition: transform 0.2s; color: #888; font-size: 10px; }
                #gm-m3u8-preview-ui .item.open .chevron { transform: rotate(90deg); }
                #gm-m3u8-preview-ui .item.open .item-head { background: rgba(76,175,80,0.1); }
                #gm-m3u8-preview-ui .item-body {
                    display: none; padding: 10px 12px;
                    background: rgba(0,0,0,0.35); border-top: 1px solid rgba(255,255,255,0.08);
                }
                #gm-m3u8-preview-ui .item.open .item-body { display: block; }
                #gm-m3u8-preview-ui button {
                    border: none; padding: 6px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;
                }
                #gm-m3u8-preview-ui .btn-primary {
                    flex: 1; background: #4caf50; color: #000; font-weight: bold; padding: 7px 8px;
                }
                #gm-m3u8-preview-ui .btn-secondary { background: #2196F3; color: #fff; }
                #gm-m3u8-preview-ui .btn-copy { background: #555; color: white; }
                #gm-m3u8-preview-ui .btn-row { display: flex; gap: 6px; margin-top: 8px; flex-wrap:wrap; }
                #gm-m3u8-preview-ui .empty-tip { padding: 20px; text-align: center; color: #666; }
                #gm-m3u8-preview-ui .toggle-btn {
                    position: fixed; bottom: calc(20px + env(safe-area-inset-bottom)); left: 20px; width: 44px; height: 44px;
                    border-radius: 50%; background: #4caf50; color: #000;
                    display: flex; align-items: center; justify-content: center;
                    font-size: 18px; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,0.3);
                    border: none; z-index: 999998;
                }
                #gm-m3u8-preview-ui .msg { padding: 4px 8px; border-radius: 4px; font-size: 11px; margin-top: 4px; }
                #gm-m3u8-preview-ui .msg-success { background: #1a2a1a; color: #8f8; }
                #gm-m3u8-preview-ui .msg-error { background: #2a1a1a; color: #faa; }
            `;

            const head = document.createElement('div');
            head.className = 'head';
            head.textContent = '🎬 M3U8预览与正则生成';

            this.list = document.createElement('div');
            this.list.className = 'list';

            this.root = document.createElement('div');
            this.root.className = 'box';
            this.root.appendChild(head);
            this.root.appendChild(this.list);

            this.toggleBtn = document.createElement('button');
            this.toggleBtn.className = 'toggle-btn';
            this.toggleBtn.textContent = 'V';
            this.toggleBtn.onclick = () => {
                const isHidden = this.root.style.display === 'none';
                this.root.style.display = isHidden ? 'flex' : 'none';
                this.toggleBtn.textContent = isHidden ? 'V' : 'X';
            };

            host.appendChild(style);
            host.appendChild(this.root);
            host.appendChild(this.toggleBtn);
            document.body.appendChild(host);

            this.root.style.display = 'none';
            this.inited = true;
            this.renderList();
            } catch (err) {
                console.error('[M3U8嗅探] UI创建失败:', err);
            }
        }

        addResource({ url, type }) {
            if (type !== 'm3u8') return;
            const exists = this.resources.some(r => r.url === url);
            if (exists) return;
            this.resources.unshift({ url, type });
            if (this.inited) this.renderList();
        }

        toggleItem(index) {
            this.openIndex = this.openIndex === index ? -1 : index;
            this.renderList();
        }

        copyUrl(url) {
            if (typeof GM_setClipboard !== 'undefined') {
                try { GM_setClipboard(url); alert('已复制链接'); return; } catch (e) {}
            }
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(() => alert('已复制链接')).catch(() => {});
                return;
            }
            const ta = document.createElement('textarea');
            ta.value = url; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); alert('已复制链接'); } catch (e) {}
            document.body.removeChild(ta);
        }

        async previewM3u8(url) {
            try {
                if (this.parseCache[url]) {
                    openPreviewPage(this.parseCache[url]);
                    return;
                }
                const res = await parseM3u8(url);
                this.parseCache[url] = res;
                openPreviewPage(res);
            } catch (err) {
                alert('解析失败: ' + err.message);
            }
        }

        renderList() {
            if (!this.inited || !this.list) return;
            this.list.innerHTML = '';
            if (this.resources.length === 0) {
                this.list.innerHTML = '<div class="empty-tip">暂无M3U8资源</div>';
                return;
            }

            this.resources.forEach((item, idx) => {
                item.id = item.id || ('r' + idx + '_' + Math.random().toString(36).slice(2, 6));
                const isOpen = this.openIndex === idx;
                const itemEl = document.createElement('div');
                itemEl.className = 'item' + (isOpen ? ' open' : '');

                const headEl = document.createElement('div');
                headEl.className = 'item-head';
                headEl.onclick = () => this.toggleItem(idx);
                headEl.innerHTML = `
                    <span class="tag ${item.type}">${item.type.toUpperCase()}</span>
                    <span class="name" title="${item.url}">${Utils.getFileName(item.url)}</span>
                    <span class="chevron">></span>
                `;
                itemEl.appendChild(headEl);

                if (isOpen) {
                    const bodyEl = document.createElement('div');
                    bodyEl.className = 'item-body';

                    const urlRow = document.createElement('div');
                    urlRow.style.cssText = 'margin-bottom:8px;word-break:break-all;font-size:10px;color:#666;max-height:40px;overflow:auto;';
                    urlRow.textContent = item.url;
                    bodyEl.appendChild(urlRow);

                    const btnRow = document.createElement('div');
                    btnRow.className = 'btn-row';

                    const previewBtn = document.createElement('button');
                    previewBtn.className = 'btn-primary';
                    previewBtn.textContent = '🎬 预览+生成正则';
                    previewBtn.onclick = (e) => { e.stopPropagation(); this.previewM3u8(item.url); };

                    const copyBtn = document.createElement('button');
                    copyBtn.className = 'btn-copy';
                    copyBtn.textContent = '复制';
                    copyBtn.onclick = (e) => { e.stopPropagation(); this.copyUrl(item.url); };

                    btnRow.appendChild(previewBtn);
                    btnRow.appendChild(copyBtn);
                    bodyEl.appendChild(btnRow);

                    const msgEl = document.createElement('div');
                    msgEl.className = 'msg';
                    msgEl.style.display = 'none';
                    bodyEl.appendChild(msgEl);

                    itemEl.appendChild(bodyEl);
                }

                this.list.appendChild(itemEl);
            });
        }
    }

    try {
        new Sniffer().start();
        const ui = new UI();
        ui.init().catch(err => {
            console.error('[M3U8嗅探] UI初始化失败:', err);
        });
    } catch (err) {
        console.error('[M3U8嗅探] 脚本启动失败:', err);
    }
})();