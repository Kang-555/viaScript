// ==UserScript==
// @name         数字正则裁剪
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  自动嗅探m3u8+多时间段筛选+自动生成正则
// @match        http://*/*
// @match        https://*/*
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    let panel = null;
    let rawSegList = [];
    let totalDuration = 0;
    let timeRanges = [];
    let regexResult = '';
    let sniffedUrls = [];
    let sniffedSet = new Set();

    // ==========================================
    // 工具函数
    // ==========================================
    function timeToSec(str) {
        const arr = str.split(':').map(Number);
        if (arr.length !== 3 || arr.some(n => isNaN(n))) throw new Error('时间格式错误');
        return arr[0] * 3600 + arr[1] * 60 + arr[2];
    }

    function secToTime(sec) {
        sec = Math.floor(sec);
        const h = String(Math.floor(sec / 3600)).padStart(2, '0');
        const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
        const s = String(sec % 60).padStart(2, '0');
        return h + ':' + m + ':' + s;
    }

    function parseTimeInput(str) {
        if (!str) return 0;
        const s = String(str).padStart(6, '0');
        if (s.length !== 6) return 0;
        const h = parseInt(s.substring(0, 2)) || 0;
        const m = parseInt(s.substring(2, 4)) || 0;
        const sec = parseInt(s.substring(4, 6)) || 0;
        return h * 3600 + m * 60 + sec;
    }

    function formatTimeInput(seconds) {
        const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
        const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
        const s = Math.floor(seconds % 60).toString().padStart(2, '0');
        return h + m + s;
    }

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function getFilename(url) {
        try {
            const pathname = new URL(url).pathname;
            return pathname.split('/').pop() || url;
        } catch {
            return url;
        }
    }

    // ==========================================
    // 自动嗅探
    // ==========================================
    function startSniffer() {
        const m3u8Regex = /\.m3u8($|\?)|application\/.*mpegurl/i;

        // 拦截 fetch
        const originalFetch = window.fetch;
        if (originalFetch) {
            window.fetch = async function (...args) {
                const url = args[0] instanceof Request ? args[0].url : String(args[0]);
                try {
                    const response = await originalFetch.apply(this, args);
                    const contentType = response.headers.get('content-type') || '';
                    if (m3u8Regex.test(url) || m3u8Regex.test(contentType)) {
                        handleM3u8Found(url);
                    }
                    return response;
                } catch (err) {
                    if (m3u8Regex.test(url)) handleM3u8Found(url);
                    throw err;
                }
            };
        }

        // 拦截 XHR
        const originalXHR = window.XMLHttpRequest;
        if (originalXHR) {
            class HijackedXHR extends originalXHR {
                open(method, url, ...rest) {
                    this._requestUrl = url;
                    super.open(method, url, ...rest);
                }
                send(...args) {
                    this.addEventListener('readystatechange', () => {
                        if (this.readyState === 4) {
                            try {
                                const url = this.responseURL || this._requestUrl;
                                const contentType = this.getResponseHeader('content-type') || '';
                                if (m3u8Regex.test(url) || m3u8Regex.test(contentType)) {
                                    handleM3u8Found(url);
                                }
                            } catch (e) { }
                        }
                    });
                    super.send(...args);
                }
            }
            window.XMLHttpRequest = HijackedXHR;
        }

        // 扫描已有资源
        if (window.performance) {
            performance.getEntriesByType('resource').forEach(entry => {
                if (m3u8Regex.test(entry.name)) {
                    handleM3u8Found(entry.name);
                }
            });
        }
    }

    function handleM3u8Found(url) {
        const cleanUrl = url.split('?')[0];
        if (sniffedSet.has(cleanUrl)) return;
        sniffedSet.add(cleanUrl);
        sniffedUrls.push(url);
        console.log('[嗅探] 发现m3u8:', url);
        updateSniffedList();
    }

    function updateSniffedList() {
        if (!panel) return;
        const listEl = panel.querySelector('#sniffedList');
        const countEl = panel.querySelector('#sniffedCount');
        if (!listEl || !countEl) return;

        countEl.textContent = sniffedUrls.length;

        if (sniffedUrls.length === 0) {
            listEl.innerHTML = '<div class="sniffed-empty">等待嗅探...</div>';
            return;
        }

        listEl.innerHTML = sniffedUrls.map((url, idx) => `
            <div class="sniffed-item">
                <div class="sniffed-url" title="${url}">${getFilename(url)}</div>
                <button class="btn btn-sm btn-parse-sniffed" data-idx="${idx}">解析</button>
            </div>
        `).join('');

        listEl.querySelectorAll('.btn-parse-sniffed').forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.dataset.idx);
                parseM3u8Url(sniffedUrls[idx]);
            };
        });
    }

    async function parseM3u8Url(url) {
        const statInfo = panel.querySelector('#statInfo');
        showMsg('⏳ 请求m3u8...', 'warn');
        try {
            const res = await fetch(url, { credentials: 'omit' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const txt = await res.text();
            const segList = parseM3u8(txt, url);
            rawSegList = segList;
            totalDuration = segList.reduce((sum, s) => sum + s.dur, 0);

            const avgDur = segList.length > 0 ? (totalDuration / segList.length) : 0;
            statInfo.style.display = 'block';
            statInfo.innerHTML = `
<div class="stat-row"><span>总分片</span><b>${segList.length}</b></div>
<div class="stat-row"><span>总时长</span><b>${secToTime(totalDuration)}</b></div>
<div class="stat-row"><span>平均分片</span><b>${avgDur.toFixed(2)}s</b></div>
`;
            timeRanges = [];
            timeRanges._curStart = 0;
            timeRanges._curEnd = Math.min(60, totalDuration);
            updateTimeInputs();
            renderTimeRanges();
            showMsg('✅ 解析完成，请设置时间段', 'success');
            panel.querySelector('#filterInfo').style.display = 'none';
            panel.querySelector('#regexSection').style.display = 'none';
            switchTab('range');
        } catch (err) {
            showMsg('❌ 跨域或链接失效：' + err.message, 'error');
        }
    }

    // ==========================================
    // 正则生成
    // ==========================================
    function buildNumericRangeRegex(min, max) {
        if (min === max) return `(?<!\\d)${min}(?!\\d)`;
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
            return `(?<!\\d)(?:${parts.join('|')})(?!\\d)`;
        }
        return `(?<!\\d)${buildSameLengthRegex(minStr, maxStr)}(?!\\d)`;
    }

    function buildSameLengthRegex(minStr, maxStr) {
        if (minStr === maxStr) return minStr;
        const prefix = commonPrefix(minStr, maxStr);
        const suffixMin = minStr.substring(prefix.length);
        const suffixMax = maxStr.substring(prefix.length);
        return prefix + buildSuffixRegex(suffixMin, suffixMax);
    }

    function commonPrefix(a, b) {
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i++;
        return a.substring(0, i);
    }

    function buildSuffixRegex(minS, maxS) {
        if (minS === maxS) return minS;
        if (minS.length === 1) return `[${minS}-${maxS}]`;
        const minFirst = Number(minS[0]);
        const maxFirst = Number(maxS[0]);
        if (minFirst === maxFirst) {
            return minFirst + buildSuffixRegex(minS.substring(1), maxS.substring(1));
        }
        const parts = [];
        parts.push(String(minFirst) + buildSuffixRegex(minS.substring(1), '9'.repeat(minS.length - 1)));
        parts.push(String(maxFirst) + buildSuffixRegex('0'.repeat(maxS.length - 1), maxS.substring(1)));
        if (maxFirst - minFirst > 1) {
            const mid = minFirst + 1 === maxFirst - 1 ? String(minFirst + 1) : `[${minFirst + 1}-${maxFirst - 1}]`;
            parts.push(mid + '\\d'.repeat(minS.length - 1));
        }
        return `(?:${parts.join('|')})`;
    }

    function parseM3u8(text, baseUrl) {
        const segList = [];
        let currentTime = 0;
        let extInf = 0;
        const lines = text.split('\n');
        for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;
            const infMatch = line.match(/#EXTINF:([\d.]+)/);
            if (infMatch) {
                extInf = parseFloat(infMatch[1]);
                continue;
            }
            if (!line.startsWith('#')) {
                const tsUrl = new URL(line, baseUrl).href;
                segList.push({
                    start: currentTime,
                    end: currentTime + extInf,
                    dur: extInf,
                    url: tsUrl
                });
                currentTime += extInf;
            }
        }
        return segList;
    }

    function filterByTimeRanges(segList, ranges) {
        const result = [];
        const seen = new Set();
        for (const seg of segList) {
            for (const range of ranges) {
                if (seg.end >= range.start && seg.start <= range.end) {
                    if (!seen.has(seg.url)) {
                        seen.add(seg.url);
                        result.push(seg);
                    }
                    break;
                }
            }
        }
        return result;
    }

    function generateRegexFromSegList(segList, ranges) {
        if (segList.length === 0) return null;

        function getFileName(seg) {
            const url = new URL(seg.url);
            const parts = url.pathname.split('/').filter(Boolean);
            const fullName = parts[parts.length - 1];
            const dotIdx = fullName.lastIndexOf('.');
            return dotIdx === -1 ? fullName : fullName.substring(0, dotIdx);
        }

        const rangeParts = [];
        for (const range of ranges) {
            const rangeSegs = segList.filter(s => s.end >= range.start && s.start <= range.end);
            if (rangeSegs.length === 0) continue;

            const firstFile = getFileName(rangeSegs[0]);
            const lastFile = getFileName(rangeSegs[rangeSegs.length - 1]);
            const isNumeric = /^\d+$/.test(firstFile) && /^\d+$/.test(lastFile);

            if (isNumeric) {
                const min = Number(firstFile);
                const max = Number(lastFile);
                rangeParts.push(buildNumericRangeRegex(min, max));
            } else {
                const names = rangeSegs.map(getFileName).map(escapeRegex);
                rangeParts.push(`\\b(?:${names.join('|')})\\b`);
            }
        }
        return rangeParts.length > 0 ? rangeParts.join('|') : null;
    }

    // ==========================================
    // UI 渲染
    // ==========================================
    function buildTimeRangeRow(startSec, endSec, idx) {
        return `
<div class="tr-row" data-idx="${idx}">
  <span class="tr-label">段${idx + 1}</span>
  <span class="tr-times">${secToTime(startSec)} → ${secToTime(endSec)}</span>
  <button class="tr-del" data-idx="${idx}">✕</button>
</div>`;
    }

    function switchTab(tabName) {
        const tabBtns = panel.querySelectorAll('.tab-btn');
        const tabContents = panel.querySelectorAll('.m3u8-tab-content');
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(tc => {
            tc.style.display = tc.dataset.tab === tabName ? 'block' : 'none';
        });
        const targetBtn = panel.querySelector(`.tab-btn[data-tab="${tabName}"]`);
        if (targetBtn) targetBtn.classList.add('active');
    }

    function showMsg(text, type) {
        const infoText = panel.querySelector('#infoText');
        infoText.textContent = text;
        infoText.className = 'm3u8-info ' + (type || '');
    }

    function renderTimeRanges() {
        const timeRangeList = panel.querySelector('#timeRangeList');
        const timeRangeEmpty = panel.querySelector('#timeRangeEmpty');
        if (timeRanges.length === 0) {
            timeRangeList.style.display = 'none';
            timeRangeEmpty.style.display = 'block';
            return;
        }
        timeRangeEmpty.style.display = 'none';
        timeRangeList.style.display = 'block';
        timeRangeList.innerHTML = timeRanges.map((r, i) => buildTimeRangeRow(r.start, r.end, i)).join('');
        timeRangeList.querySelectorAll('.tr-del').forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.dataset.idx);
                timeRanges.splice(idx, 1);
                renderTimeRanges();
            };
        });
    }

    function updateTimeInputs() {
        const startInput = panel.querySelector('#timeStart');
        const endInput = panel.querySelector('#timeEnd');
        const totalTimeEl = panel.querySelector('#totalTime');
        if (!startInput || !endInput) return;

        const curStart = timeRanges._curStart ?? 0;
        const curEnd = timeRanges._curEnd ?? Math.min(60, totalDuration);

        startInput.value = formatTimeInput(curStart);
        endInput.value = formatTimeInput(curEnd);
        totalTimeEl.textContent = secToTime(totalDuration);
    }

    function handleTimeInputChange() {
        const startInput = panel.querySelector('#timeStart');
        const endInput = panel.querySelector('#timeEnd');
        if (!startInput || !endInput) return;

        const startSec = parseTimeInput(startInput.value);
        const endSec = parseTimeInput(endInput.value);

        timeRanges._curStart = startSec;
        timeRanges._curEnd = endSec;
    }

    function renderPanel() {
        if (panel) return;

        panel = document.createElement('div');
        panel.className = 'm3u8-panel';
        panel.innerHTML = `
<div class="m3u8-header">🎬 M3U8正则裁剪</div>

<div class="m3u8-tabs">
  <button class="tab-btn active" data-tab="link">🔗 自动嗅探</button>
  <button class="tab-btn" data-tab="range">⏱ 时间段筛选</button>
  <button class="tab-btn" data-tab="regex">🔍 正则</button>
</div>

<div class="m3u8-tab-content" data-tab="link">
  <div class="m3u8-section">
    <div class="sniffed-header">
      <span>已发现</span>
      <span id="sniffedCount">0</span>
      <span>个m3u8链接</span>
    </div>
    <div id="sniffedList" class="sniffed-list">
      <div class="sniffed-empty">等待嗅探...</div>
    </div>
    <div id="statInfo" class="m3u8-stat" style="display:none"></div>
  </div>
</div>

<div class="m3u8-tab-content" data-tab="range" style="display:none">
  <div class="m3u8-section">
    <div class="time-input-row">
      <span class="time-label">起始</span>
      <input type="number" id="timeStart" min="0" max="235959" value="000000" placeholder="HHMMSS" class="time-input">
      <span class="time-sep">-</span>
      <span class="time-label">结束</span>
      <input type="number" id="timeEnd" min="0" max="235959" value="000100" placeholder="HHMMSS" class="time-input">
    </div>
    <div class="time-total-row">
      <span class="time-total">总时长: <span id="totalTime">00:00:00</span></span>
    </div>
    <button class="btn btn-add" id="btnAddRange">➕ 添加到列表</button>
    <div id="timeRangeList" class="time-range-list" style="display:none"></div>
    <div id="timeRangeEmpty" class="time-range-empty">暂无时间段，点击上方按钮添加</div>
  </div>
</div>

<div class="m3u8-tab-content" data-tab="regex" style="display:none">
  <div class="m3u8-section">
    <div class="m3u8-btn-row">
      <button class="btn btn-preview" id="btnPreview">预览筛选</button>
      <button class="btn btn-generate" id="btnGenRegex">生成正则</button>
    </div>
    <div id="filterInfo" class="m3u8-filter-info" style="display:none"></div>
  </div>
  <div class="m3u8-section" id="regexSection" style="display:none">
    <div class="m3u8-section-title">🔍 正则表达式</div>
    <textarea id="regexOutput" rows="4" placeholder="点击『生成正则』后显示..."></textarea>
    <div class="m3u8-btn-row">
      <button class="btn btn-generate" id="btnCopyRegex">复制正则</button>
      <button class="btn btn-copy" id="btnCopyUrls">复制匹配URL</button>
    </div>
  </div>
</div>

<div id="infoText" class="m3u8-info"></div>
`;

        document.body.appendChild(panel);

        const $ = sel => panel.querySelector(sel);
        const tabBtns = panel.querySelectorAll('.tab-btn');
        const tabContents = panel.querySelectorAll('.m3u8-tab-content');
        const timeStartInput = $('#timeStart');
        const timeEndInput = $('#timeEnd');
        const timeRangeList = $('#timeRangeList');
        const timeRangeEmpty = $('#timeRangeEmpty');
        const btnAddRange = $('#btnAddRange');
        const btnPreview = $('#btnPreview');
        const btnGenRegex = $('#btnGenRegex');
        const filterInfo = $('#filterInfo');
        const regexSection = $('#regexSection');
        const regexOutput = $('#regexOutput');
        const btnCopyRegex = $('#btnCopyRegex');
        const btnCopyUrls = $('#btnCopyUrls');
        const infoText = $('#infoText');

        // 标签切换
        tabBtns.forEach(btn => {
            btn.addEventListener('click', function () {
                switchTab(this.dataset.tab);
            });
        });

        // 时间输入框变化
        timeStartInput.addEventListener('input', handleTimeInputChange);
        timeEndInput.addEventListener('input', handleTimeInputChange);

        // 添加到列表
        btnAddRange.onclick = () => {
            const curStart = timeRanges._curStart ?? 0;
            const curEnd = timeRanges._curEnd ?? 0;
            if (totalDuration <= 0) {
                showMsg('⚠️ 请先解析M3U8', 'warn');
                return;
            }
            if (curEnd <= curStart) {
                showMsg('⚠️ 结束时间需大于起始时间', 'warn');
                return;
            }
            timeRanges.push({ start: curStart, end: curEnd });
            timeRanges.sort((a, b) => a.start - b.start);
            renderTimeRanges();
            timeRanges._curStart = curEnd;
            timeRanges._curEnd = Math.min(curEnd + 60, totalDuration);
            updateTimeInputs();
            showMsg('✅ 已添加到列表', 'success');
        };

        // 预览筛选
        function syncFilter() {
            if (rawSegList.length === 0) {
                showMsg('⚠️ 请先解析M3U8', 'warn');
                return null;
            }
            const filtered = filterByTimeRanges(rawSegList, timeRanges);
            const totalDur = filtered.reduce((sum, s) => sum + s.dur, 0);
            filterInfo.style.display = 'block';
            filterInfo.textContent = `🎯 筛选后：${filtered.length} 个分片 | 总时长：${secToTime(totalDur)}`;
            return filtered;
        }

        btnPreview.onclick = () => {
            const filtered = syncFilter();
            if (filtered) showMsg('✅ 筛选完成', 'success');
        };

        // 生成正则
        btnGenRegex.onclick = () => {
            const filtered = syncFilter();
            if (!filtered) return;
            if (filtered.length === 0) {
                showMsg('⚠️ 筛选结果为空，请调整时间段', 'error');
                regexSection.style.display = 'none';
                return;
            }
            const regex = generateRegexFromSegList(filtered, timeRanges);
            if (!regex) {
                showMsg('❌ 无法生成正则', 'error');
                regexSection.style.display = 'none';
                return;
            }
            regexResult = regex;
            regexOutput.value = regex;
            regexSection.style.display = 'block';
            showMsg('✅ 正则生成成功', 'success');
        };

        // 复制正则
        btnCopyRegex.onclick = () => {
            const val = regexOutput.value.trim();
            if (!val) {
                showMsg('⚠️ 正则为空', 'warn');
                return;
            }
            GM_setClipboard(val);
            showMsg('✅ 正则已复制到剪贴板', 'success');
        };

        // 复制URL
        btnCopyUrls.onclick = () => {
            const filtered = syncFilter();
            if (!filtered) return;
            if (filtered.length === 0) {
                showMsg('⚠️ 无筛选结果', 'warn');
                return;
            }
            const urls = filtered.map(s => s.url).join('\n');
            GM_setClipboard(urls);
            showMsg(`✅ 已复制 ${filtered.length} 个URL`, 'success');
        };

        renderTimeRanges();
        updateTimeInputs();
        updateSniffedList();
    }

    // ==========================================
    // 样式
    // ==========================================
    function injectStyle() {
        const style = document.createElement('style');
        style.textContent = `
.m3u8-panel{position:fixed;bottom:0;left:0;z-index:999999;background:rgba(10,15,30,0.95);color:#eee;padding:12px;border-radius:0 10px 0 0;font-size:12px;min-width:340px;max-width:94vw;max-height:85vh;overflow-y:auto;box-shadow:0 4px 24px rgba(0,0,0,0.5);font-family:system-ui,sans-serif}
.m3u8-header{font-size:14px;font-weight:bold;color:#4caf50;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #333;text-align:center}
.m3u8-tabs{display:flex;gap:4px;margin-bottom:10px}
.tab-btn{flex:1;padding:8px 6px;background:rgba(40,50,70,0.6);border:1px solid #444;border-radius:6px;color:#aaa;cursor:pointer;font-size:11px;transition:all 0.2s}
.tab-btn.active{background:#2a4a2a;border-color:#4caf50;color:#4caf50}
.tab-btn:hover{background:rgba(50,60,80,0.6)}
.m3u8-tab-content{margin-bottom:8px}
.m3u8-section{background:rgba(20,30,50,0.6);border-radius:6px;padding:10px;margin-bottom:8px}
.m3u8-section-title{display:flex;align-items:center;justify-content:space-between;color:#fc6;font-weight:bold;font-size:12px;margin-bottom:8px}
.sniffed-header{display:flex;align-items:center;gap:4px;color:#aaa;font-size:11px;margin-bottom:8px}
.sniffed-header #sniffedCount{color:#4caf50;font-weight:bold}
.sniffed-list{max-height:200px;overflow-y:auto}
.sniffed-empty{padding:16px;text-align:center;color:#666;font-size:11px}
.sniffed-item{display:flex;align-items:center;justify-content:space-between;padding:6px 8px;background:rgba(30,40,60,0.5);border-radius:4px;margin-bottom:4px}
.sniffed-url{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#9cf;margin-right:8px}
.btn{border:none;padding:6px 10px;border-radius:4px;cursor:pointer;font-size:11px;color:#fff;font-weight:normal}
.btn-sm{padding:4px 8px;font-size:10px}
.btn-primary{background:#26c;font-weight:bold}
.btn-preview{background:#447}
.btn-generate{background:#2a7;font-weight:bold}
.btn-copy{background:#488}
.btn-add{background:#447;color:#fff;padding:6px 12px;font-size:11px;width:100%;margin-top:8px}
.m3u8-stat{margin-top:8px;padding:6px;background:#1a2a1a;border-radius:4px;font-size:11px;color:#8f8}
.stat-row{display:flex;justify-content:space-between;margin:2px 0}
.stat-row span{color:#aaa}
.stat-row b{color:#4caf50}
.m3u8-btn-row{display:flex;gap:6px;margin-top:8px}
#btnPreview{flex:1}
#btnGenRegex{flex:1}
#btnCopyRegex{flex:1}
#btnCopyUrls{flex:1}
.m3u8-filter-info{margin-top:8px;padding:6px;background:#1a2a1a;border-radius:4px;font-size:11px;color:#8f8}
#regexOutput{width:100%;box-sizing:border-box;padding:8px;background:#111;color:#6f9;border:1px solid #333;border-radius:4px;font-family:monospace;font-size:11px;min-height:50px}
.m3u8-info{margin-top:8px;padding:6px;border-radius:4px;font-size:11px;min-height:20px;color:#888;background:rgba(40,40,40,0.4)}
.m3u8-info.success{background:#1a2a1a;color:#8f8}
.m3u8-info.warn{background:#2a2a1a;color:#fc6}
.m3u8-info.error{background:#2a1a1a;color:#faa}
.time-input-row{display:flex;align-items:center;gap:6px;margin-bottom:8px}
.time-label{color:#9cf;font-size:11px;font-weight:bold}
.time-input{flex:1;padding:6px 8px;background:#222;color:#fff;border:1px solid #555;border-radius:4px;font-size:12px;font-family:monospace}
.time-input:focus{border-color:#4caf50;outline:none}
.time-sep{color:#aaa;font-size:12px}
.time-total-row{display:flex;justify-content:center;margin-bottom:8px}
.time-total{color:#888;font-size:11px;font-family:monospace}
.time-total #totalTime{color:#fc6}
.time-range-list{margin-top:8px}
.time-range-empty{margin-top:8px;padding:10px;text-align:center;color:#666;font-size:11px;background:rgba(0,0,0,0.2);border-radius:4px;border:1px dashed #333}
.tr-row{background:rgba(30,40,60,0.5);border-radius:4px;padding:6px 8px;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center}
.tr-row:last-child{margin-bottom:0}
.tr-label{color:#9cf;font-weight:bold;font-size:11px}
.tr-times{color:#fc6;font-size:11px;font-family:monospace}
.tr-del{background:#a33;border:none;color:#fff;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:11px;line-height:1}
input[type="number"]::-webkit-inner-spin-button,
input[type="number"]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
input[type="number"]{-moz-appearance:textfield}
`;
        document.head.appendChild(style);
    }

    // ==========================================
    // 启动
    // ==========================================
    function waitBody() {
        if (document.body) {
            injectStyle();
            renderPanel();
            startSniffer();
        } else {
            const observer = new MutationObserver(() => {
                if (document.body) {
                    observer.disconnect();
                    injectStyle();
                    renderPanel();
                    startSniffer();
                }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            setTimeout(() => {
                if (document.body) {
                    injectStyle();
                    renderPanel();
                    startSniffer();
                }
            }, 5000);
        }
    }

    waitBody();
})();