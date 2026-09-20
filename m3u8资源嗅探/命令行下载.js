// ==UserScript==
// @name        N_m3u8DL-RE 命令生成器
// @namespace   http://tampermonkey.net/
// @version     4.1
// @description 解析m3u8，选多个时间段，直接输出N_m3u8DL-RE命令行，保存名用网页标题
// @match       http://*/*
// @match       https://*/*
// @grant       GM_setClipboard
// @run-at      document-idle
// ==/UserScript==

(function () {
  'use strict';

  let panel = null;
  let totalDuration = 0;
  let timeRanges = [];
  let currentRange = { start: 0, end: 60 };
  let m3u8UrlVal = "";

  function secToTime(sec) {
    sec = Math.floor(sec);
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  function parseM3u8(text, baseUrl) {
    const segs = [];
    let now = 0, dur = 0;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/#EXTINF:([\d.]+)/);
      if (m) { dur = parseFloat(m[1]); continue; }
      if (!line.startsWith('#')) {
        const url = new URL(line, baseUrl).href;
        segs.push({ start: now, end: now + dur, dur, url });
        now += dur;
      }
    }
    return segs;
  }

  function buildCmd(url, ranges) {
    if (!url || !ranges.length) return "";
    const name = (document.title || "video").replace(/[\\/:*?"<>|\r\n]/g, "_");
    const args = ranges.map(r => `"${secToTime(r.start)}-${secToTime(r.end)}"`).join(" ");
    return `./N_m3u8DL-RE "${url}" --split-time-range ${args} --save-name "${name}"`;
  }

  function rangeRow(s, e, i) {
    return `<div class="tr-row" data-idx="${i}">
      <span class="tr-label">段${i + 1}</span>
      <span class="tr-times">${secToTime(s)} → ${secToTime(e)}</span>
      <button class="tr-del" data-idx="${i}">✕</button></div>`;
  }

  const CSS = `
.m3u8-panel{position:fixed;top:20px;right:20px;width:380px;max-height:85vh;overflow-y:auto;background:#1e1e2e;color:#cdd6f4;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.5);font:13px/1.5 -apple-system,"Segoe UI",sans-serif;z-index:99999}
.m3u8-header{padding:14px 16px;background:linear-gradient(135deg,#89b4fa,#a6e3a1);color:#1e1e2e;font-weight:700;font-size:14px;border-radius:12px 12px 0 0}
.m3u8-tabs{display:flex;border-bottom:1px solid #313244;background:#181825}
.tab-btn{flex:1;padding:10px 0;background:none;border:none;color:#a6adc8;cursor:pointer;font-size:12px;transition:all .2s}
.tab-btn:hover{color:#cdd6f4}
.tab-btn.active{color:#89b4fa;border-bottom:2px solid #89b4fa;background:#1e1e2e}
.m3u8-tab-content{padding:14px}
.m3u8-section+.m3u8-section{margin-top:14px;border-top:1px solid #313244;padding-top:14px}
.m3u8-input-row{display:flex;gap:8px}
.m3u8-input-row input{flex:1;padding:8px 10px;background:#313244;border:1px solid #45475a;border-radius:6px;color:#cdd6f4;font-size:12px;outline:none}
.m3u8-input-row input:focus{border-color:#89b4fa}
.btn{padding:8px 14px;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;transition:all .15s}
.btn-primary{background:#89b4fa;color:#1e1e2e}.btn-primary:hover{background:#b4befe}
.btn-add{background:#a6e3a1;color:#1e1e2e;width:100%;margin-top:10px}.btn-add:hover{background:#94e2d5}
.btn-generate{background:#f38ba8;color:#1e1e2e}.btn-generate:hover{background:#eba0ac}
.m3u8-stat{margin-top:10px;padding:8px;background:#313244;border-radius:6px;font-size:12px;color:#a6e3a1}
.dual-range{display:flex;flex-direction:column;gap:14px}
.range-group{background:#313244;border-radius:8px;padding:10px 12px}
.range-group-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.range-label{font-size:11px;color:#a6adc8}
.range-time-edit{font-family:Consolas,monospace;color:#89b4fa;font-weight:600;font-size:13px}
.video-track{position:relative;height:24px;background:#45475a;border-radius:4px;cursor:pointer;user-select:none}
.video-progress{position:absolute;top:0;left:0;height:100%;background:linear-gradient(90deg,#89b4fa,#a6e3a1);border-radius:4px;width:0;pointer-events:none}
.video-thumb{position:absolute;top:-4px;width:6px;height:32px;background:#fff;border-radius:3px;box-shadow:0 2px 8px rgba(0,0,0,.4);transform:translateX(-50%);cursor:grab}
.video-thumb:active{cursor:grabbing}
.video-time-row{margin-top:8px;text-align:center;font-size:11px;color:#a6adc8}
.video-time-total span{color:#89b4fa;font-family:Consolas,monospace}
.time-range-list{margin-top:10px;display:flex;flex-direction:column;gap:6px}
.tr-row{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#313244;border-radius:6px}
.tr-label{font-size:11px;color:#a6adc8;min-width:36px}
.tr-times{flex:1;font-family:Consolas,monospace;font-size:12px;color:#cdd6f4}
.tr-del{background:#f38ba8;color:#1e1e2e;border:none;border-radius:4px;width:22px;height:22px;cursor:pointer;font-size:12px;line-height:1}
.tr-del:hover{background:#eba0ac}
.time-range-empty{margin-top:10px;padding:10px;text-align:center;background:#313244;border-radius:6px;color:#a6adc8;font-size:11px}
.m3u8-btn-row{display:flex;gap:8px;margin-bottom:12px}
.m3u8-btn-row .btn{flex:1}
.m3u8-section-title{font-size:12px;font-weight:600;color:#a6adc8;margin-bottom:8px}
#cmdOutput{width:100%;padding:10px;background:#181825;border:1px solid #45475a;border-radius:6px;color:#cdd6f4;font-family:Consolas,monospace;font-size:12px;resize:vertical;outline:none;box-sizing:border-box}
#cmdOutput:focus{border-color:#89b4fa}
.m3u8-info{padding:8px 14px;font-size:11px;color:#a6adc8;text-align:center;min-height:16px}
.m3u8-info.ok{color:#a6e3a1}
.m3u8-info.err{color:#f38ba8}
`;

  const HTML = `
<div class="m3u8-header">M3U8 → N_m3u8DL-RE</div>

<div class="m3u8-tabs">
  <button class="tab-btn active" data-tab="link">M3U8链接</button>
  <button class="tab-btn" data-tab="range">时间段筛选</button>
  <button class="tab-btn" data-tab="cmd">命令行</button>
</div>

<div class="m3u8-tab-content" data-tab="link">
  <div class="m3u8-section">
    <div class="m3u8-input-row">
      <input id="m3u8Input" placeholder="粘贴m3u8链接...">
      <button id="btnParse" class="btn btn-primary">解析</button>
    </div>
    <div id="statInfo" class="m3u8-stat" style="display:none"></div>
  </div>
</div>

<div class="m3u8-tab-content" data-tab="range" style="display:none">
  <div class="m3u8-section">
    <div class="dual-range">
      <div class="range-group">
        <div class="range-group-header">
          <span class="range-label">起始</span>
          <span class="range-time-edit" id="startTimeEdit">00:00:00</span>
        </div>
        <div class="video-track" id="startTrack">
          <div class="video-progress" id="startProgress"></div>
          <div class="video-thumb" id="startThumb"></div>
        </div>
      </div>
      <div class="range-group">
        <div class="range-group-header">
          <span class="range-label">结束</span>
          <span class="range-time-edit" id="endTimeEdit">00:01:00</span>
        </div>
        <div class="video-track" id="endTrack">
          <div class="video-progress" id="endProgress"></div>
          <div class="video-thumb" id="endThumb"></div>
        </div>
      </div>
    </div>
    <div class="video-time-row">
      <span class="video-time-total">总时长: <span id="totalTime">00:00:00</span></span>
    </div>
    <button class="btn btn-add" id="btnAddRange">添加到列表</button>
    <div id="timeRangeList" class="time-range-list" style="display:none"></div>
    <div id="timeRangeEmpty" class="time-range-empty">暂无时间段，点击上方按钮添加</div>
  </div>
</div>

<div class="m3u8-tab-content" data-tab="cmd" style="display:none">
  <div class="m3u8-section">
    <button class="btn btn-generate" id="btnGenCmd" style="width:100%">生成命令</button>
  </div>
  <div class="m3u8-section">
    <div class="m3u8-section-title">N_m3u8DL-RE 命令</div>
    <textarea id="cmdOutput" rows="4" placeholder="点击「生成命令」后显示..."></textarea>
    <button class="btn btn-generate" id="btnCopyCmd" style="width:100%;margin-top:8px">复制命令</button>
  </div>
</div>

<div id="infoText" class="m3u8-info"></div>
`;

  function renderPanel() {
    if (panel) return;

    const styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);

    panel = document.createElement('div');
    panel.className = 'm3u8-panel';
    panel.innerHTML = HTML;
    document.body.appendChild(panel);

    const $ = sel => panel.querySelector(sel);
    const tabBtns = panel.querySelectorAll('.tab-btn');
    const tabContents = panel.querySelectorAll('.m3u8-tab-content');
    const m3u8Input = $('#m3u8Input');
    const btnParse = $('#btnParse');
    const statInfo = $('#statInfo');
    const totalTimeEl = $('#totalTime');
    const startTimeEdit = $('#startTimeEdit');
    const endTimeEdit = $('#endTimeEdit');
    const startTrack = $('#startTrack');
    const startProgress = $('#startProgress');
    const endTrack = $('#endTrack');
    const endProgress = $('#endProgress');
    const timeRangeList = $('#timeRangeList');
    const timeRangeEmpty = $('#timeRangeEmpty');
    const btnAddRange = $('#btnAddRange');
    const btnGenCmd = $('#btnGenCmd');
    const cmdOutput = $('#cmdOutput');
    const btnCopyCmd = $('#btnCopyCmd');
    const infoText = $('#infoText');

    function showMsg(text, type) {
      infoText.textContent = text;
      infoText.className = 'm3u8-info ' + (type || '');
      if (text) setTimeout(() => { if (infoText.textContent === text) infoText.textContent = ''; }, 3000);
    }

    function switchTab(name) {
      tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
      tabContents.forEach(c => c.style.display = c.dataset.tab === name ? '' : 'none');
    }

    function renderRangeList() {
      const has = timeRanges.length > 0;
      timeRangeList.style.display = has ? '' : 'none';
      timeRangeEmpty.style.display = has ? 'none' : '';
      timeRangeList.innerHTML = timeRanges.map((r, i) => rangeRow(r.start, r.end, i)).join('');
      timeRangeList.querySelectorAll('.tr-del').forEach(btn => {
        btn.addEventListener('click', () => {
          timeRanges.splice(parseInt(btn.dataset.idx), 1);
          renderRangeList();
        });
      });
    }

    tabBtns.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

    btnParse.addEventListener('click', async () => {
      const url = m3u8Input.value.trim();
      if (!url) { showMsg('请输入m3u8链接', 'err'); return; }
      try {
        const text = await fetch(url).then(r => r.text());
        const segs = parseM3u8(text, url);
        totalDuration = segs.length ? segs[segs.length - 1].end : 0;
        m3u8UrlVal = url;
        totalTimeEl.textContent = secToTime(totalDuration);
        statInfo.style.display = '';
        statInfo.textContent = `解析成功：${segs.length} 分片 · ${secToTime(totalDuration)}`;
        showMsg('解析成功', 'ok');
        switchTab('range');
      } catch (e) {
        showMsg('解析失败：' + e.message, 'err');
      }
    });

    let dragging = null;
    function setupSlider(track, progressEl, thumbSel, timeEl, which) {
      const thumb = $(thumbSel);
      function update(pct) {
        pct = Math.max(0, Math.min(1, pct));
        progressEl.style.width = (pct * 100) + '%';
        thumb.style.left = (pct * 100) + '%';
        const sec = pct * totalDuration;
        timeEl.textContent = secToTime(sec);
        return sec;
      }
      function getPct(e) {
        const rect = track.getBoundingClientRect();
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        return (cx - rect.left) / rect.width;
      }
      thumb.addEventListener('mousedown', e => { e.preventDefault(); dragging = which; });
      thumb.addEventListener('touchstart', () => dragging = which, { passive: true });
      track.addEventListener('click', e => {
        const sec = update(getPct(e));
        if (which === 'start') currentRange.start = sec;
        else currentRange.end = sec;
      });
      document.addEventListener('mousemove', e => {
        if (!dragging) return;
        const sec = update(getPct(e));
        if (dragging === 'start') currentRange.start = sec;
        else currentRange.end = sec;
      });
      document.addEventListener('touchmove', e => {
        if (!dragging) return;
        const sec = update(getPct(e));
        if (dragging === 'start') currentRange.start = sec;
        else currentRange.end = sec;
      });
      document.addEventListener('mouseup', () => dragging = null);
      document.addEventListener('touchend', () => dragging = null);
    }
    setupSlider(startTrack, startProgress, '#startThumb', startTimeEdit, 'start');
    setupSlider(endTrack, endProgress, '#endThumb', endTimeEdit, 'end');

    btnAddRange.addEventListener('click', () => {
      if (!m3u8UrlVal) { showMsg('请先解析m3u8', 'err'); return; }
      const { start: s, end: e } = currentRange;
      if (e <= s) { showMsg('结束时间必须大于开始时间', 'err'); return; }
      timeRanges.push({ start: s, end: e });
      renderRangeList();
      showMsg('已添加时间段', 'ok');
    });

    btnGenCmd.addEventListener('click', () => {
      if (!m3u8UrlVal) { showMsg('请先解析m3u8', 'err'); switchTab('link'); return; }
      const valid = timeRanges.filter(r => r.end > r.start);
      if (!valid.length) { showMsg('请先添加时间段', 'err'); switchTab('range'); return; }
      cmdOutput.value = buildCmd(m3u8UrlVal, valid);
      showMsg('命令已生成', 'ok');
    });

    btnCopyCmd.addEventListener('click', async () => {
      if (!cmdOutput.value) { showMsg('先生成命令', 'err'); return; }
      try {
        await navigator.clipboard.writeText(cmdOutput.value);
        showMsg('已复制', 'ok');
      } catch {
        GM_setClipboard(cmdOutput.value);
        showMsg('已复制（GM）', 'ok');
      }
    });

    renderRangeList();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderPanel);
  } else {
    renderPanel();
  }
})();