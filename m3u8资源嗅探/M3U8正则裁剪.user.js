// ==UserScript==
// @name         M3U8正则裁剪
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  多时间段筛选+自动生成正则
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
    let timeRanges = [{ start: 0, end: 60 }];
    let regexResult = '';

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

    function numToHms(digits) {
        let s = digits.replace(/\D/g, '').slice(0, 6);
        let result = '';
        for (let i = 0; i < s.length; i++) {
            if (i === 2 || i === 4) result += ':';
            result += s[i];
        }
        return result;
    }

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

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

    function buildTimeRangeRow(startSec, endSec, idx) {
        return `
<div class="tr-row" data-idx="${idx}">
  <span class="tr-label">段${idx + 1}</span>
  <span class="tr-times">${secToTime(startSec)} → ${secToTime(endSec)}</span>
  <button class="tr-del" data-idx="${idx}">✕</button>
</div>`;
    }

    function renderPanel() {
        if (panel) return;

        panel = document.createElement('div');
        panel.className = 'm3u8-panel';
        panel.innerHTML = `
<div class="m3u8-header">🎬 M3U8正则裁剪</div>

<div class="m3u8-section">
  <div class="m3u8-section-title">🔗 M3U8链接</div>
  <div class="m3u8-input-row">
    <input id="m3u8Input" placeholder="粘贴m3u8链接...">
    <button id="btnParse" class="btn btn-primary">解析</button>
  </div>
  <div id="statInfo" class="m3u8-stat" style="display:none"></div>
</div>

<div class="m3u8-section">
  <div class="m3u8-section-title">
    ⏱ 时间段筛选
    <button class="btn btn-add" id="btnAddRange">➕ 添加</button>
  </div>
  <div id="timeRangeList"></div>
</div>

<div class="m3u8-section">
  <div class="m3u8-section-title">📊 筛选结果</div>
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

<div id="infoText" class="m3u8-info"></div>
`;

        document.body.appendChild(panel);

        const $ = sel => panel.querySelector(sel);
        const m3u8Input = $('#m3u8Input');
        const btnParse = $('#btnParse');
        const statInfo = $('#statInfo');
        const timeRangeList = $('#timeRangeList');
        const btnAddRange = $('#btnAddRange');
        const btnPreview = $('#btnPreview');
        const btnGenRegex = $('#btnGenRegex');
        const filterInfo = $('#filterInfo');
        const regexSection = $('#regexSection');
        const regexOutput = $('#regexOutput');
        const btnCopyRegex = $('#btnCopyRegex');
        const btnCopyUrls = $('#btnCopyUrls');
        const infoText = $('#infoText');

        let dragging = null;

        function showMsg(text, type) {
            infoText.textContent = text;
            infoText.className = 'm3u8-info ' + (type || '');
        }

        function renderTimeRanges() {
            timeRangeList.innerHTML = timeRanges.map((r, i) => buildTimeRangeRow(r.start, r.end, i)).join('');

            timeRangeList.querySelectorAll('.tr-del').forEach(btn => {
                btn.onclick = () => {
                    const synced = collectTimeRanges();
                    if (!synced) return;
                    const idx = parseInt(btn.dataset.idx);
                    if (timeRanges.length <= 1) {
                        showMsg('⚠️ 至少保留一个时间段', 'warn');
                        return;
                    }
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
                input.addEventListener('change', function () {
                    const synced = collectTimeRanges();
                    if (!synced) return;
                    renderTimeRanges();
                });
            });

            timeRangeList.querySelectorAll('.tr-bar').forEach(bar => {
                const barEl = bar;
                barEl.addEventListener('mousedown', e => {
                    e.preventDefault();
                    const rect = barEl.getBoundingClientRect();
                    dragging = {
                        bar: barEl,
                        idx: parseInt(barEl.dataset.idx),
                        mode: 'move',
                        offset: (e.clientX - rect.left) / rect.width
                    };
                    updateDrag(e);
                });
                barEl.addEventListener('mousemove', e => {
                    if (dragging && dragging.bar === barEl) updateDrag(e);
                });
                barEl.addEventListener('mouseup', () => { dragging = null; });
                barEl.addEventListener('mouseleave', () => { if (dragging && dragging.bar === barEl) dragging = null; });

                barEl.querySelectorAll('.tr-bar-handle').forEach(handle => {
                    handle.addEventListener('mousedown', e => {
                        e.preventDefault();
                        e.stopPropagation();
                        dragging = {
                            bar: barEl,
                            idx: parseInt(handle.dataset.idx),
                            mode: handle.dataset.role,
                            offset: 0
                        };
                    });
                });
            });
        }

        function updateDrag(e) {
            if (!dragging || totalDuration <= 0) return;
            const rect = dragging.bar.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const sec = pct * totalDuration;
            const r = timeRanges[dragging.idx];
            if (dragging.mode === 'start') {
                r.start = Math.min(sec, r.end);
            } else if (dragging.mode === 'end') {
                r.end = Math.max(sec, r.start);
            } else {
                const len = r.end - r.start;
                let newStart = sec - len * dragging.offset;
                newStart = Math.max(0, Math.min(newStart, totalDuration - len));
                r.start = newStart;
                r.end = newStart + len;
            }
            renderTimeRanges();
        }

        document.addEventListener('mousemove', updateDrag);
        document.addEventListener('mouseup', () => { dragging = null; });

        function collectTimeRanges() {
            const rows = timeRangeList.querySelectorAll('.tr-row');
            const newRanges = [];
            for (const row of rows) {
                const idx = parseInt(row.dataset.idx);
                const startStr = row.querySelector('.tr-start').value.trim();
                const endStr = row.querySelector('.tr-end').value.trim();
                let s, e;
                try {
                    s = timeToSec(startStr);
                    e = timeToSec(endStr);
                } catch {
                    showMsg(`⚠️ 段${idx + 1} 时间格式错误`, 'error');
                    return null;
                }
                if (s >= e) {
                    showMsg(`⚠️ 段${idx + 1} 开始时间需早于结束时间`, 'error');
                    return null;
                }
                if (totalDuration > 0) {
                    s = Math.max(0, Math.min(s, totalDuration));
                    e = Math.max(0, Math.min(e, totalDuration));
                }
                newRanges.push({ start: s, end: e });
            }
            timeRanges = newRanges;
            return newRanges;
        }

        btnAddRange.onclick = () => {
            const synced = collectTimeRanges();
            if (!synced) return;
            const lastRange = timeRanges[timeRanges.length - 1];
            timeRanges.push({
                start: lastRange ? lastRange.end : 0,
                end: lastRange ? Math.min(lastRange.end + 60, totalDuration) : Math.min(60, totalDuration)
            });
            renderTimeRanges();
        };

        btnParse.onclick = async () => {
            const url = m3u8Input.value.trim();
            if (!url) {
                showMsg('⚠️ 请填入m3u8链接', 'warn');
                return;
            }
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
                timeRanges = [{ start: 0, end: Math.min(60, totalDuration) }];
                renderTimeRanges();
                showMsg('✅ 解析完成，请设置时间段', 'success');
                filterInfo.style.display = 'none';
                regexSection.style.display = 'none';
            } catch (err) {
                showMsg('❌ 跨域或链接失效：' + err.message, 'error');
            }
        };

        function syncFilter() {
            if (rawSegList.length === 0) {
                showMsg('⚠️ 请先解析M3U8', 'warn');
                return null;
            }
            const ranges = collectTimeRanges();
            if (!ranges) return null;
            const filtered = filterByTimeRanges(rawSegList, ranges);
            const totalDur = filtered.reduce((sum, s) => sum + s.dur, 0);
            filterInfo.style.display = 'block';
            filterInfo.textContent = `🎯 筛选后：${filtered.length} 个分片 | 总时长：${secToTime(totalDur)}`;
            return filtered;
        }

        btnPreview.onclick = () => {
            const filtered = syncFilter();
            if (filtered) showMsg('✅ 筛选完成', 'success');
        };

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

        btnCopyRegex.onclick = () => {
            const val = regexOutput.value.trim();
            if (!val) {
                showMsg('⚠️ 正则为空', 'warn');
                return;
            }
            GM_setClipboard(val);
            showMsg('✅ 正则已复制到剪贴板', 'success');
        };

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

        panel.querySelectorAll('.toggle-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                panel.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                const targetId = this.dataset.target;
                panel.querySelectorAll('.m3u8-section').forEach(section => {
                    section.style.display = 'none';
                });
                if (targetId) {
                    const target = panel.querySelector('#' + targetId);
                    if (target) target.style.display = 'block';
                }
            });
        });

        const startBar = $('#startBar');
        const endBar = $('#endBar');
        const startTimeInput = $('#startTime');
        const endTimeInput = $('#endTime');
        let timelineDragging = null;

        function updateTimelineUI() {
            if (totalDuration <= 0) return;
            const startPct = (timeRanges[0].start / totalDuration) * 100;
            const endPct = (timeRanges[0].end / totalDuration) * 100;
            const startFill = $('#startFill');
            const endFill = $('#endFill');
            const startHandle = $('#startHandle');
            const endHandle = $('#endHandle');
            if (startFill) startFill.style.width = startPct + '%';
            if (endFill) endFill.style.width = endPct + '%';
            if (startHandle) startHandle.style.left = startPct + '%';
            if (endHandle) endHandle.style.left = endPct + '%';
            if (startTimeInput) startTimeInput.value = secToTime(timeRanges[0].start);
            if (endTimeInput) endTimeInput.value = secToTime(timeRanges[0].end);
        }

        function handleTimelineDrag(e, mode) {
            if (totalDuration <= 0) return;
            const bar = mode === 'start' ? startBar : endBar;
            if (!bar) return;
            const rect = bar.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const sec = pct * totalDuration;
            if (mode === 'start') {
                timeRanges[0].start = Math.min(sec, timeRanges[0].end);
            } else {
                timeRanges[0].end = Math.max(sec, timeRanges[0].start);
            }
            updateTimelineUI();
            renderTimeRanges();
        }

        if (startBar) {
            startBar.addEventListener('mousedown', e => {
                e.preventDefault();
                timelineDragging = 'start';
                handleTimelineDrag(e, 'start');
            });
        }
        if (endBar) {
            endBar.addEventListener('mousedown', e => {
                e.preventDefault();
                timelineDragging = 'end';
                handleTimelineDrag(e, 'end');
            });
        }
        document.addEventListener('mousemove', e => {
            if (timelineDragging) {
                handleTimelineDrag(e, timelineDragging);
            }
        });
        document.addEventListener('mouseup', () => { timelineDragging = null; });

        if (startTimeInput) {
            startTimeInput.addEventListener('change', function() {
                try {
                    const s = timeToSec(this.value);
                    timeRanges[0].start = Math.min(s, timeRanges[0].end);
                    updateTimelineUI();
                    renderTimeRanges();
                } catch {}
            });
        }
        if (endTimeInput) {
            endTimeInput.addEventListener('change', function() {
                try {
                    const e = timeToSec(this.value);
                    timeRanges[0].end = Math.max(e, timeRanges[0].start);
                    updateTimelineUI();
                    renderTimeRanges();
                } catch {}
            });
        }

        updateTimelineUI();
    }

    function waitBody() {
        if (document.body) {
            const style = document.createElement('style');
            style.textContent = `
.m3u8-panel{position:fixed;bottom:0;right:0;z-index:999999;background:rgba(10,15,30,0.95);color:#eee;padding:12px;border-radius:10px 0 0 0;font-size:12px;min-width:340px;max-width:94vw;max-height:85vh;overflow-y:auto;box-shadow:0 4px 24px rgba(0,0,0,0.5);font-family:system-ui,sans-serif}
.m3u8-header{font-size:14px;font-weight:bold;color:#4caf50;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #333;text-align:center}
.m3u8-toggle-btns{display:flex;gap:6px;margin-bottom:10px}
.toggle-btn{flex:1;padding:8px 10px;background:rgba(40,50,70,0.6);border:1px solid #444;border-radius:6px;color:#aaa;cursor:pointer;font-size:11px;transition:all 0.2s}
.toggle-btn.active{background:#2a4a2a;border-color:#4caf50;color:#4caf50}
.toggle-btn:hover{background:rgba(50,60,80,0.6)}
.m3u8-section{background:rgba(20,30,50,0.6);border-radius:6px;padding:10px;margin-bottom:8px}
.m3u8-section-title{display:flex;align-items:center;justify-content:space-between;color:#fc6;font-weight:bold;font-size:12px;margin-bottom:8px}
.m3u8-input-row{display:flex;gap:6px}
.m3u8-input-row input{flex:1;padding:6px 8px;background:#222;color:#fff;border:1px solid #555;border-radius:4px;font-size:12px}
.m3u8-stat{margin-top:8px;padding:6px;background:#1a2a1a;border-radius:4px;font-size:11px;color:#8f8}
.stat-row{display:flex;justify-content:space-between;margin:2px 0}
.stat-row span{color:#aaa}
.stat-row b{color:#4caf50}
.m3u8-btn-row{display:flex;gap:6px;margin-top:8px}
.btn{border:none;padding:6px 10px;border-radius:4px;cursor:pointer;font-size:11px;color:#fff;font-weight:normal}
.btn-primary{background:#26c;font-weight:bold}
.btn-preview{background:#447}
.btn-generate{background:#2a7;font-weight:bold}
.btn-copy{background:#488}
.btn-add{background:#447;color:#fff;padding:6px 12px;font-size:11px;width:100%;margin-top:8px}
#btnParse{min-width:50px}
#btnPreview{flex:1}
#btnGenRegex{flex:1}
#btnCopyRegex{flex:1}
#btnCopyUrls{flex:1}
#btnAddRange{flex:1}
.m3u8-filter-info{margin-top:8px;padding:6px;background:#1a2a1a;border-radius:4px;font-size:11px;color:#8f8}
#regexOutput{width:100%;box-sizing:border-box;padding:8px;background:#111;color:#6f9;border:1px solid #333;border-radius:4px;font-family:monospace;font-size:11px;min-height:50px}
.m3u8-info{margin-top:8px;padding:6px;border-radius:4px;font-size:11px;min-height:20px;color:#888;background:rgba(40,40,40,0.4)}
.m3u8-info.success{background:#1a2a1a;color:#8f8}
.m3u8-info.warn{background:#2a2a1a;color:#fc6}
.m3u8-info.error{background:#2a1a1a;color:#faa}
.timeline-ctrl{margin-bottom:10px}
.timeline-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.timeline-label{width:32px;color:#9cf;font-size:11px;font-weight:bold}
.timeline-bar{position:relative;flex:1;height:20px;background:#333;border-radius:3px;cursor:pointer;touch-action:none;user-select:none}
.timeline-fill{position:absolute;top:0;height:100%;background:rgba(76,175,80,0.4);border-radius:3px;pointer-events:none}
.timeline-handle{position:absolute;top:-2px;width:10px;height:24px;background:#ffa500;border:1px solid #ff8c00;border-radius:3px;cursor:ew-resize;z-index:2;transform:translateX(-50%);box-shadow:0 1px 3px rgba(0,0,0,0.4)}
.timeline-input{width:70px;padding:4px 6px;background:#222;color:#fff;border:1px solid #555;border-radius:3px;text-align:center;font-size:12px;font-family:monospace}
.tr-row{background:rgba(30,40,60,0.5);border-radius:4px;padding:6px 8px;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center}
.tr-row:last-child{margin-bottom:0}
.tr-label{color:#9cf;font-weight:bold;font-size:11px}
.tr-times{color:#fc6;font-size:11px;font-family:monospace}
.tr-del{background:#a33;border:none;color:#fff;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:11px;line-height:1}
`;
            document.head.appendChild(style);
        }

        if (document.body) {
            renderPanel();
        } else {
            const observer = new MutationObserver(() => {
                if (document.body) {
                    observer.disconnect();
                    renderPanel();
                }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            setTimeout(() => {
                if (document.body) renderPanel();
            }, 5000);
        }
    }

    waitBody();
})();