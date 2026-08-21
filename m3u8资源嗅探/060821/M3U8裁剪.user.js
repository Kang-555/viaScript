// ==UserScript==
// @name         M3U8裁剪
// @namespace    http://tampermonkey.net/
// @version      1.7
// @description  多时间段筛选+自动生成正则
// @match        http://*/*
// @match        https://*/*
// @grant        GM_setClipboard
// @run‑at       document‑idle
// ==/UserScript==

(function () {
    "use strict";
    let panel = null;
    let rawSegList = [];
    let filteredSegList = [];
    let keyLineCache = null;
    let timeRanges = [{ start: 0, end: 60 }];
    let regexResult = "";

    // 时间 HH:mm:ss → 秒，无效输入抛异常
    function timeToSec(str) {
        const arr = str.split(":").map(Number);
        if (arr.length !== 3 || arr.some(n => isNaN(n))) {
            throw new Error("时间格式错误");
        }
        return arr[0] * 3600 + arr[1] * 60 + arr[2];
    }

    // 秒 → HH:mm:ss
    function secToTime(sec) {
        sec = Math.floor(sec);
        const h = String(Math.floor(sec / 3600)).padStart(2, '0');
        const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
        const s = String(sec % 60).padStart(2, '0');
        return `${h}:${m}:${s}`;
    }

    // 纯数字字符串 → HH:mm:ss（自动补冒号，编辑时不补零）
    function numToHms(digits) {
        let s = digits.replace(/\D/g, "").slice(0, 6);
        let result = '';
        for (let i = 0; i < s.length; i++) {
            if (i === 2 || i === 4) result += ':';
            result += s[i];
        }
        return result;
    }

    // 正则特殊字符转义
    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // 数字范围→正则（如5-10 → [5-9]|10）
    function buildNumericRangeRegex(min, max) {
        if (min === max) return `(?<!\\d)${min}(?!\\d)`;
        const minStr = String(min);
        const maxStr = String(max);
        // 位数不同时按位数分段
        if (minStr.length !== maxStr.length) {
            const parts = [];
            // 短位段：min 到 10^n-1
            const shortMax = Math.pow(10, minStr.length) - 1;
            parts.push(buildSameLengthRegex(minStr, String(shortMax)));
            // 中间全通配段（首位不能为0）
            for (let len = minStr.length + 1; len < maxStr.length; len++) {
                parts.push('[1-9]' + '\\d'.repeat(len - 1));
            }
            // 长位段：10^(n-1) 到 max
            const longMin = Math.pow(10, maxStr.length - 1);
            parts.push(buildSameLengthRegex(String(longMin), maxStr));
            return `(?<!\\d)(?:${parts.join('|')})(?!\\d)`;
        }
        return `(?<!\\d)${buildSameLengthRegex(minStr, maxStr)}(?!\\d)`;
    }

    // 等长数字范围→正则
    function buildSameLengthRegex(minStr, maxStr) {
        if (minStr === maxStr) return minStr;
        const prefix = commonPrefix(minStr, maxStr);
        const suffixMin = minStr.substring(prefix.length);
        const suffixMax = maxStr.substring(prefix.length);
        const suffixRegex = buildSuffixRegex(suffixMin, suffixMax);
        return prefix + suffixRegex;
    }

    // 公共前缀
    function commonPrefix(a, b) {
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i++;
        return a.substring(0, i);
    }

    // 构建后缀正则（递归处理进位）
    function buildSuffixRegex(minS, maxS) {
        if (minS === maxS) return minS;
        if (minS.length === 1) return `[${minS}-${maxS}]`;
        const minFirst = Number(minS[0]);
        const maxFirst = Number(maxS[0]);
        if (minFirst === maxFirst) {
            return minFirst + buildSuffixRegex(minS.substring(1), maxS.substring(1));
        }
        const parts = [];
        // 最小边界：固定minFirst，剩余位受min约束
        parts.push(String(minFirst) + buildSuffixRegex(minS.substring(1), '9'.repeat(minS.length - 1)));
        // 最大边界：固定maxFirst，剩余位受max约束
        parts.push(String(maxFirst) + buildSuffixRegex('0'.repeat(maxS.length - 1), maxS.substring(1)));
        // 中间段：首位在(minFirst, maxFirst)之间，剩余位全通配
        if (maxFirst - minFirst > 1) {
            const mid = minFirst + 1 === maxFirst - 1
                ? String(minFirst + 1)
                : `[${minFirst + 1}-${maxFirst - 1}]`;
            parts.push(mid + '\\d'.repeat(minS.length - 1));
        }
        return `(?:${parts.join('|')})`;
    }

    // 合并连续数字范围
    function mergeContinuousRanges(nums) {
        if (nums.length === 0) return [];
        const sorted = [...new Set(nums)].sort((a, b) => a - b);
        const ranges = [];
        let start = sorted[0];
        let end = sorted[0];
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i] === end + 1) {
                end = sorted[i];
            } else {
                ranges.push([start, end]);
                start = sorted[i];
                end = sorted[i];
            }
        }
        ranges.push([start, end]);
        return ranges;
    }

    //解析m3u8文本
    function parseM3u8(text, baseUrl) {
        const segList = [];
        let currentTime = 0;
        let extInf = 0;
        let currentKeyLine = null;
        let mapLine = null;
        let targetDuration = 10;
        let hasDiscontinuity = false;
        const lines = text.split("\n");
        for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;
            if (line.startsWith("#EXT-X-TARGETDURATION")) {
                targetDuration = parseInt(line.split(":")[1]) || 10;
                continue;
            }
            if (line.startsWith("#EXT-X-KEY")) { currentKeyLine = line; continue; }
            if (line.startsWith("#EXT-X-MAP")) { mapLine = line; continue; }
            if (line.startsWith("#EXT-X-DISCONTINUITY")) {
                hasDiscontinuity = true;
                if (segList.length > 0) {
                    segList[segList.length - 1].discontinuity = true;
                }
                continue;
            }
            const infMatch = line.match(/#EXTINF:([\d\.]+)/);
            if (infMatch) {
                extInf = parseFloat(infMatch[1]);
                continue;
            }
            if (!line.startsWith("#")) {
                const tsUrl = new URL(line, baseUrl).href;
                segList.push({
                    start: currentTime,
                    end: currentTime + extInf,
                    dur: extInf,
                    url: tsUrl,
                    keyLine: currentKeyLine,
                    discontinuity: false
                });
                currentTime += extInf;
            }
        }
        return { segList, keyLine: currentKeyLine, mapLine, targetDuration, hasDiscontinuity };
    }

    //多时间段筛选分片
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

    //生成裁剪后的m3u8内容（接收已筛选的分片列表）
    function buildClipM3u8(segList, keyLine, mapLine, targetDuration) {
        let out = "#EXTM3U\n#EXT-X-VERSION:3\n";
        if (targetDuration) out += `#EXT-X-TARGETDURATION:${targetDuration}\n`;
        if (mapLine) out += mapLine + "\n";
        let lastKey = null;
        segList.forEach(s => {
            if (s.keyLine !== lastKey) {
                if (s.keyLine) out += s.keyLine + "\n";
                lastKey = s.keyLine;
            }
            if (s.discontinuity) {
                out += "#EXT-X-DISCONTINUITY\n";
            }
            out += `#EXTINF:${s.dur},\n${s.url}\n`;
        });
        out += "#EXT-X-ENDLIST\n";
        return { content: out, count: segList.length };
    }

    //从分片列表生成正则（按时间段分别取首尾序号，生成范围正则再用|拼接）
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

    //下载本地文件
    function saveTextFile(text, filename) {
        const blob = new Blob([text], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    // 构建时间段行HTML
    function buildTimeRangeRow(startSec, endSec, idx) {
        return `
<div class="time-range-row" data-idx="${idx}" style="display:flex;align-items:center;gap:4px;margin:3px 0;">
<span style="color:#9cf;font-size:11px;">段${idx + 1}:</span>
<input class="tr-start" value="${secToTime(startSec)}" style="width:72px;padding:2px;box-sizing:border-box;" placeholder="000120">
<span style="color:#888;">-</span>
<input class="tr-end" value="${secToTime(endSec)}" style="width:72px;padding:2px;box-sizing:border-box;" placeholder="000230">
<button class="tr-del" style="background:#a33;border:none;color:#fff;border-radius:3px;padding:2px 5px;cursor:pointer;font-size:11px;">✕</button>
</div>`;
    }

    //渲染UI面板
    function renderPanel() {
        if(panel) return;
        panel = document.createElement("div");
        panel.style = `position:fixed;bottom:12px;right:12px;z-index:999999;background:rgba(0,0,0,0.82);color:#fff;padding:10px 12px;border-radius:10px;font-size:12px;min-width:340px;max-width:94vw;max-height:75vh;overflow-y:auto;box-shadow:0 4px 20px rgba(0,0,0,0.4);`;
        document.body.appendChild(panel);

        panel.innerHTML = `
<div style="font-size:13px;font-weight:bold;margin-bottom:8px;color:#6cf;">🎬 M3U8裁剪 · 正则生成器</div>

<div style="margin-bottom:6px;">
  <input id="m3u8Input" placeholder="粘贴m3u8链接..." style="width:100%;box-sizing:border-box;padding:5px;border-radius:4px;border:1px solid #555;background:#222;color:#fff;">
</div>
<div style="display:flex;gap:4px;margin-bottom:8px;">
  <button id="btnParse" style="flex:1;padding:5px;background:#26c;border:none;color:#fff;border-radius:4px;cursor:pointer;font-weight:bold;">解析链接</button>
</div>

<div id="statSection" style="display:none;border-top:1px solid #333;padding-top:6px;margin-bottom:4px;">
  <div class="section-toggle" data-target="statDetails" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:4px 0;">
    <span style="color:#8f8;font-weight:bold;font-size:11px;">▶ ✅ 解析完成</span>
  </div>
  <div id="statDetails" style="display:none;padding:4px 0 8px 0;">
    <div id="statArea" style="padding:6px;background:#1a1a2a;border-radius:6px;font-size:11px;color:#acf;"></div>
  </div>
</div>

<div style="border-top:1px solid #333;padding-top:6px;margin-bottom:4px;">
  <div class="section-toggle" data-target="timeSection" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:4px 0;">
    <span style="color:#fc6;font-weight:bold;font-size:11px;">▶ ⏱ 时间段筛选</span>
    <button id="btnAddRange" style="background:#447;border:none;color:#fff;border-radius:3px;padding:2px 7px;cursor:pointer;font-size:11px;">➕ 添加</button>
  </div>
  <div id="timeSection" style="display:none;padding:4px 0 8px 0;">
    <div id="timeRangeList"></div>
  </div>
</div>

<div style="display:flex;gap:4px;margin-bottom:8px;">
  <button id="btnPreview" style="flex:1;padding:5px;background:#447;border:none;color:#fff;border-radius:4px;cursor:pointer;font-size:11px;">预览筛选</button>
  <button id="btnGenRegex" style="flex:1;padding:5px;background:#2a7;border:none;color:#fff;border-radius:4px;cursor:pointer;font-weight:bold;font-size:11px;">生成正则</button>
</div>

<div id="filterInfo" style="display:none;margin-bottom:6px;padding:4px 8px;background:#1a2a1a;border-radius:4px;font-size:11px;color:#8f8;"></div>

<div style="border-top:1px solid #333;padding-top:6px;margin-bottom:4px;">
  <div class="section-toggle" data-target="regexSection" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:4px 0;">
    <span style="color:#6ef;font-weight:bold;font-size:11px;">▶ 🔍 正则表达式</span>
  </div>
  <div id="regexSection" style="display:none;padding:4px 0 8px 0;">
    <textarea id="regexOutput" rows="3" style="width:100%;box-sizing:border-box;padding:5px;background:#111;color:#6f9;border:1px solid #333;border-radius:4px;font-family:monospace;font-size:11px;" placeholder="点击『生成正则』后显示..."></textarea>
    <div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;">
      <button id="btnCopyRegex" style="flex:1;padding:5px;background:#c82;border:none;color:#fff;border-radius:4px;cursor:pointer;font-size:11px;min-width:100px;">复制正则</button>
      <button id="btnCopyUrls" style="flex:1;padding:5px;background:#488;border:none;color:#fff;border-radius:4px;cursor:pointer;font-size:11px;min-width:100px;">复制匹配URL</button>
    </div>
  </div>
</div>

<div style="border-top:1px solid #333;padding-top:6px;margin-bottom:4px;">
  <div class="section-toggle" data-target="clipSection" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:4px 0;">
    <span style="color:#aaa;font-size:11px;">▶ 📦 裁剪M3U8文件</span>
  </div>
  <div id="clipSection" style="display:none;padding:4px 0 8px 0;">
    <div style="display:flex;gap:4px;flex-wrap:wrap;">
      <button id="btnGenClip" style="flex:1;padding:5px;background:#26c;border:none;color:#fff;border-radius:4px;cursor:pointer;font-size:11px;min-width:100px;">生成裁剪M3U8</button>
      <button id="btnCopyClip" style="flex:1;padding:5px;background:#26c;border:none;color:#fff;border-radius:4px;cursor:pointer;font-size:11px;min-width:100px;">复制裁剪文本</button>
      <button id="btnDownload" style="flex:1;padding:5px;background:#2c6;border:none;color:#fff;border-radius:4px;cursor:pointer;font-size:11px;min-width:100px;">下载clip.m3u8</button>
    </div>
  </div>
</div>

<div id="infoText" style="margin-top:8px;padding:6px;background:#2a1a1a;border-radius:4px;font-size:11px;color:#faa;min-height:20px;"></div>
`;

        const $ = sel => panel.querySelector(sel);
        const m3u8Input = $("#m3u8Input");
        const statSection = $("#statSection");
        const statArea = $("#statArea");
        const timeRangeList = $("#timeRangeList");
        const btnAddRange = $("#btnAddRange");
        const btnParse = $("#btnParse");
        const btnPreview = $("#btnPreview");
        const btnGenRegex = $("#btnGenRegex");
        const filterInfo = $("#filterInfo");
        const regexSection = $("#regexSection");
        const regexOutput = $("#regexOutput");
        const btnCopyRegex = $("#btnCopyRegex");
        const btnCopyUrls = $("#btnCopyUrls");
        const btnGenClip = $("#btnGenClip");
        const btnCopyClip = $("#btnCopyClip");
        const btnDownload = $("#btnDownload");
        const infoText = $("#infoText");

        function showMsg(text, color) {
            infoText.innerText = text;
            if (color) infoText.style.color = color;
            else infoText.style.color = '#faa';
        }

        // 折叠/展开功能
        panel.querySelectorAll('.section-toggle').forEach(toggle => {
            toggle.onclick = () => {
                const targetId = toggle.dataset.target;
                const section = panel.querySelector(`#${targetId}`);
                const titleSpan = toggle.querySelector('span');
                if (section.style.display === 'none') {
                    section.style.display = 'block';
                    titleSpan.textContent = titleSpan.textContent.replace('▶', '▼');
                } else {
                    section.style.display = 'none';
                    titleSpan.textContent = titleSpan.textContent.replace('▼', '▶');
                }
            };
        });

        function renderTimeRanges() {
            timeRangeList.innerHTML = timeRanges.map((r, i) => buildTimeRangeRow(r.start, r.end, i)).join('');
            timeRangeList.querySelectorAll('.tr-del').forEach(btn => {
                btn.onclick = () => {
                    const synced = collectTimeRanges();
                    if (!synced) { showMsg("⚠️ 请先修正时间段格式错误"); return; }
                    const idx = parseInt(btn.dataset.idx);
                    if (timeRanges.length <= 1) {
                        showMsg("至少保留一个时间段");
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
                    const formatted = numToHms(onlyDigits);
                    this.value = formatted;
                    this.selectionStart = this.selectionEnd = formatted.length;
                });
            });
        }

        function collectTimeRanges() {
            const rows = timeRangeList.querySelectorAll('.time-range-row');
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
                    showMsg(`⚠️ 段${idx + 1} 时间格式错误`);
                    return null;
                }
                if (s >= e) {
                    showMsg(`⚠️ 段${idx + 1} 开始时间需早于结束时间`);
                    return null;
                }
                newRanges.push({ start: s, end: e });
            }
            timeRanges = newRanges;
            return newRanges;
        }

        renderTimeRanges();

        btnAddRange.onclick = () => {
            const synced = collectTimeRanges();
            if (!synced) { showMsg("⚠️ 请先修正已有时间段的格式错误"); return; }
            const lastRange = timeRanges[timeRanges.length - 1];
            timeRanges.push({
                start: lastRange ? lastRange.end : 0,
                end: lastRange ? Math.min(lastRange.end + 60, (rawSegList.length > 0 ? rawSegList[rawSegList.length - 1].end : 3600)) : 60
            });
            renderTimeRanges();
        };

        let mapLineCache = null;
        let targetDurationCache = 10;

        function doParse(txt, baseUrl, sourceType) {
            const { segList, keyLine, mapLine, targetDuration, hasDiscontinuity } = parseM3u8(txt, baseUrl);
            rawSegList = segList;
            keyLineCache = keyLine;
            mapLineCache = mapLine;
            targetDurationCache = targetDuration;
            filteredSegList = segList;
            const totalDur = segList.reduce((sum, s) => sum + s.dur, 0);
            const avgDur = segList.length > 0 ? (totalDur / segList.length) : 0;
            let extraInfo = '';
            if (mapLine) extraInfo += ' | fMP4流';
            if (hasDiscontinuity) extraInfo += ' | 含不连续标记';
            statSection.style.display = 'block';
            statArea.innerHTML = `总分片：<b style="color:#fff">${segList.length}</b> 个 | 总时长：<b style="color:#fff">${secToTime(totalDur)}</b><br>平均分片：<b style="color:#fff">${avgDur.toFixed(1)}s</b> | TARGETDURATION: ${targetDuration}${extraInfo}`;
            showMsg("✅ 解析成功，请设置时间段", '#8f8');
            filterInfo.style.display = 'none';
            regexSection.style.display = 'none';
        }

        btnParse.onclick = async () => {
            const url = m3u8Input.value.trim();
            if (!url) { showMsg("⚠️ 请填入m3u8链接"); return; }
            showMsg("⏳ 请求m3u8...", '#fc6');
            try {
                const res = await fetch(url, { credentials: "omit" });
                const txt = await res.text();
                doParse(txt, url, '链接');
            } catch (err) {
                showMsg(`❌ 跨域/链接失效：${err.message}`, '#f66');
            }
        };

        function syncFilter() {
            if (rawSegList.length === 0) return false;
            const ranges = collectTimeRanges();
            if (!ranges) return false;
            filteredSegList = filterByTimeRanges(rawSegList, ranges);
            const totalDur = filteredSegList.reduce((sum, s) => sum + s.dur, 0);
            filterInfo.style.display = 'block';
            filterInfo.innerText = `🎯 筛选后：${filteredSegList.length} 个分片 | 总时长：${secToTime(totalDur)}`;
            return true;
        }

        btnPreview.onclick = () => {
            if (rawSegList.length === 0) { showMsg("⚠️ 请先解析M3U8"); return; }
            if (syncFilter()) {
                showMsg("✅ 筛选完成，可生成正则", '#8f8');
            }
        };

        btnGenRegex.onclick = () => {
            if (rawSegList.length === 0) { showMsg("⚠️ 请先解析M3U8"); return; }
            if (!syncFilter()) return;
            if (filteredSegList.length === 0) { showMsg("⚠️ 筛选结果为空，请调整时间段", '#f66'); regexSection.style.display = 'none'; return; }
            const regex = generateRegexFromSegList(filteredSegList, timeRanges);
            if (!regex) {
                showMsg("❌ 无法生成正则", '#f66');
                regexSection.style.display = 'none';
                return;
            }
            regexResult = regex;
            regexOutput.value = regex;
            regexSection.style.display = 'block';
            showMsg("✅ 正则生成成功", '#8f8');
        };

        btnCopyRegex.onclick = () => {
            const val = regexOutput.value.trim();
            if (!val) { showMsg("⚠️ 正则为空"); return; }
            GM_setClipboard(val);
            showMsg("✅ 正则已复制到剪贴板", '#8f8');
        };

        btnCopyUrls.onclick = () => {
            if (rawSegList.length === 0) { showMsg("⚠️ 请先解析M3U8"); return; }
            if (!syncFilter()) return;
            if (filteredSegList.length === 0) { showMsg("⚠️ 无筛选结果"); return; }
            const urls = filteredSegList.map(s => s.url).join('\n');
            GM_setClipboard(urls);
            showMsg(`✅ 已复制 ${filteredSegList.length} 个URL`, '#8f8');
        };

        let clipContent = null;
        btnGenClip.onclick = () => {
            if (rawSegList.length === 0) { showMsg("⚠️ 请先解析M3U8"); return; }
            if (!syncFilter()) return;
            if (filteredSegList.length === 0) { showMsg("⚠️ 筛选结果为空，请调整时间段", '#f66'); return; }
            const result = buildClipM3u8(filteredSegList, keyLineCache, mapLineCache, targetDurationCache);
            clipContent = result.content;
            showMsg(`✅ 裁剪M3U8已生成（${result.count}个分片）`, '#8f8');
        };

        btnCopyClip.onclick = () => {
            if (!clipContent) { showMsg("⚠️ 请先生成裁剪M3U8"); return; }
            GM_setClipboard(clipContent);
            showMsg("✅ 裁剪M3U8文本已复制", '#8f8');
        };

        btnDownload.onclick = () => {
            if (!clipContent) { showMsg("⚠️ 请先生成裁剪M3U8"); return; }
            saveTextFile(clipContent, "clip.m3u8");
            showMsg("✅ 已下载clip.m3u8", '#8f8');
        };
    }

    //等待body出现，渲染面板
    function waitBody(){
        if(document.body){
            renderPanel();
        }else{
            setTimeout(waitBody,120);
        }
    }
    waitBody();
})();