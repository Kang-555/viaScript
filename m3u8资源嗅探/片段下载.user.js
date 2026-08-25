// ==UserScript==
// @name         1DM HLS片段裁剪
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  裁剪M3U8时间段，生成新M3U8文件，触发1DM下载（1DM自负责解密/下载/合并）
// @author       You
// @match        *://*/*
// @connect      *
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ==========================================
    // 工具函数
    // ==========================================
    function resolveUrl(baseUrl, relativeUrl) {
        if (relativeUrl.startsWith('http')) return relativeUrl;
        if (relativeUrl.startsWith('/')) {
            const u = new URL(baseUrl);
            return u.origin + relativeUrl;
        }
        const path = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
        return path + relativeUrl;
    }

    function gmRequest(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'text',
                headers: { 'Referer': location.href },
                timeout: 30000,
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) resolve(res.response);
                    else reject(new Error(`HTTP ${res.status}`));
                },
                onerror: () => reject(new Error('请求失败')),
                ontimeout: () => reject(new Error('超时'))
            });
        });
    }

    // ==========================================
    // M3U8 解析（保留原始行用于重建）
    // ==========================================
    function parseM3u8(m3u8Text, baseUrl) {
        const lines = m3u8Text.split(/\r?\n/);
        const segments = [];
        let currentInf = 0;
        let currentKeyLine = null;
        let currentKeyUrl = null;
        let currentIV = null;
        let sequence = 0;
        let timeAcc = 0;

        for (const line of lines) {
            const l = line.trim();
            if (!l) continue;

            if (l.startsWith('#EXT-X-KEY')) {
                currentKeyLine = l;
                const method = (l.match(/METHOD=([^,]+)/) || [])[1];
                const uri = (l.match(/URI="([^"]+)"/) || [])[1];
                const ivHex = (l.match(/IV=(0x[\da-f]+)/i) || [])[1];
                if (method === 'AES-128' && uri) {
                    currentKeyUrl = resolveUrl(baseUrl, uri);
                    currentIV = ivHex || null;
                } else {
                    currentKeyUrl = null;
                    currentIV = null;
                }
            } else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
                sequence = parseInt(l.split(':')[1]);
            } else if (l.startsWith('#EXTINF:')) {
                const m = l.match(/#EXTINF:([\d\.]+)/);
                if (m) currentInf = parseFloat(m[1]);
            } else if (!l.startsWith('#')) {
                const seg = {
                    url: resolveUrl(baseUrl, l),
                    urlRaw: l,
                    duration: currentInf,
                    keyLine: currentKeyLine,
                    keyUrl: currentKeyUrl,
                    iv: currentIV,
                    seq: sequence++,
                    tStart: timeAcc,
                    tEnd: timeAcc + currentInf
                };
                segments.push(seg);
                timeAcc += currentInf;
            }
        }
        return { segments, totalDuration: timeAcc };
    }

    // ==========================================
    // 时间段 → 分片索引
    // ==========================================
    function timeToSegmentIndex(segments, startSec, endSec) {
        let startIdx = 0;
        let endIdx = segments.length - 1;
        for (let i = 0; i < segments.length; i++) {
            if (segments[i].tEnd >= startSec) { startIdx = i; break; }
        }
        for (let i = segments.length - 1; i >= 0; i--) {
            if (segments[i].tStart <= endSec) { endIdx = i; break; }
        }
        return { startIdx, endIdx };
    }

    // ==========================================
    // 生成裁剪后的 M3U8 文本
    // ==========================================
    function generateCroppedM3U8(segments, startIdx, endIdx) {
        const output = [];
        output.push('#EXTM3U');

        const firstSeg = segments[startIdx];

        if (firstSeg && firstSeg.keyLine) {
            let keyLine = firstSeg.keyLine;
            if (firstSeg.keyUrl !== firstSeg.url.replace(/\/[^\/]*$/, '/') +
                firstSeg.keyLine.match(/URI="([^"]+)"/)[1]) {
                keyLine = firstSeg.keyLine.replace(
                    /URI="([^"]+)"/,
                    `URI="${firstSeg.keyUrl}"`
                );
            }
            output.push(keyLine);
        }

        output.push(`#EXT-X-MEDIA-SEQUENCE:${firstSeg ? firstSeg.seq : 0}`);

        for (let i = startIdx; i <= endIdx; i++) {
            const seg = segments[i];
            output.push(`#EXTINF:${seg.duration},`);
            output.push(seg.url);
        }

        output.push('#EXT-X-ENDLIST');
        return output.join('\n');
    }

    // ==========================================
    // 生成 M3U8 data URI 并触发 1DM
    // ==========================================
    function trigger1DM(m3u8Text, filename) {
        const blob = new Blob([m3u8Text], { type: 'application/x-mpegurl' });

        const reader = new FileReader();
        reader.onload = () => {
            const dataUri = reader.result;
            const dmLink = `1dm://${encodeURIComponent(dataUri)}`;
            console.log('[1DM] 唤起:', dmLink.substring(0, 100) + '...');

            window.location.href = dmLink;

            setTimeout(() => {
                const a = document.createElement('a');
                a.href = dataUri;
                a.download = filename;
                a.click();
            }, 500);
        };
        reader.readAsDataURL(blob);
    }

    // ==========================================
    // 主流程：裁剪 + 触发 1DM
    // ==========================================
    async function cropAndTrigger1DM(m3u8Url, startSec, endSec, onStatus) {
        onStatus('拉取 M3U8...');

        const m3u8Text = await gmRequest(m3u8Url);
        const { segments, totalDuration } = parseM3u8(m3u8Text, m3u8Url);

        if (segments.length === 0) throw new Error('未解析到分片');

        const clampedStart = Math.max(0, startSec);
        const clampedEnd = Math.min(totalDuration, endSec);
        if (clampedEnd <= clampedStart) throw new Error('时间范围无效');

        const { startIdx, endIdx } = timeToSegmentIndex(segments, clampedStart, clampedEnd);
        const segCount = endIdx - startIdx + 1;
        const actualStart = segments[startIdx].tStart;
        const actualEnd = segments[endIdx].tEnd;

        onStatus(`裁剪分片 ${startIdx}-${endIdx} (${segCount}个) | 实际 ${actualStart.toFixed(1)}s ~ ${actualEnd.toFixed(1)}s`);

        const croppedM3U8 = generateCroppedM3U8(segments, startIdx, endIdx);

        const segDur = Math.round(clampedEnd - clampedStart);
        const filename = `segment_${segDur}s.m3u8`;

        onStatus('生成 M3U8 文件 → 唤起 1DM...');
        trigger1DM(croppedM3U8, filename);

        onStatus('✅ 已唤起 1DM，请在 1DM 中确认下载');
        console.log('[1DM] 裁剪完成:', filename, '分片:', segCount, '原始分片:', startIdx + '-' + endIdx);
    }

    // ==========================================
    // UI 悬浮面板
    // ==========================================
    function createPanel() {
        const panel = document.createElement('div');
        panel.style.cssText = `
position:fixed;top:20px;right:20px;z-index:999999;background:rgba(0,0,0,0.92);
color:#fff;padding:14px 16px;border-radius:10px;font-family:system-ui,sans-serif;
font-size:13px;min-width:290px;max-width:340px;box-shadow:0 8px 32px rgba(0,0,0,0.5);
border:1px solid #ff6d00;
`;

        panel.innerHTML = `
<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
  <div style="width:8px;height:8px;background:#ff6d00;border-radius:50%;animation:pulse 1.5s infinite;"></div>
  <b style="font-size:14px;color:#ff6d00;">1DM HLS 片段裁剪</b>
</div>

<div style="margin-bottom:10px;">
  <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">M3U8 地址</label>
  <input id="seg_url" style="width:100%;box-sizing:border-box;padding:8px 10px;background:#222;border:1px solid #444;border-radius:6px;color:#fff;font-size:12px;" placeholder="粘贴 m3u8 链接">
</div>

<div style="display:flex;gap:8px;margin-bottom:10px;">
  <div style="flex:1;">
    <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">开始 (秒)</label>
    <input id="seg_start" type="number" value="0" min="0" step="1" style="width:100%;box-sizing:border-box;padding:8px 10px;background:#222;border:1px solid #444;border-radius:6px;color:#fff;font-size:12px;">
  </div>
  <div style="flex:1;">
    <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">结束 (秒)</label>
    <input id="seg_end" type="number" value="60" min="1" step="1" style="width:100%;box-sizing:border-box;padding:8px 10px;background:#222;border:1px solid #444;border-radius:6px;color:#fff;font-size:12px;">
  </div>
</div>

<div style="display:flex;gap:6px;margin-bottom:10px;">
  <button class="seg-preset" data-start="0" data-end="30" style="flex:1;padding:6px;background:#333;border:1px solid #555;border-radius:5px;color:#aaa;font-size:11px;cursor:pointer;">0-30s</button>
  <button class="seg-preset" data-start="30" data-end="60" style="flex:1;padding:6px;background:#333;border:1px solid #555;border-radius:5px;color:#aaa;font-size:11px;cursor:pointer;">30-60s</button>
  <button class="seg-preset" data-start="60" data-end="120" style="flex:1;padding:6px;background:#333;border:1px solid #555;border-radius:5px;color:#aaa;font-size:11px;cursor:pointer;">1-2min</button>
</div>

<div id="seg_status" style="margin-bottom:10px;padding:10px;background:#1a1a1a;border-radius:6px;font-size:12px;color:#888;min-height:20px;display:none;line-height:1.5;"></div>

<button id="seg_run" style="width:100%;padding:10px;background:linear-gradient(135deg,#ff6d00,#e65100);border:none;border-radius:6px;color:#000;font-weight:bold;font-size:13px;cursor:pointer;">
✂️ 裁剪 M3U8 → 1DM 下载
</button>

<div style="font-size:11px;color:#666;margin-top:8px;text-align:center;">
  脚本仅裁剪 · 解密/下载/合并由 1DM 完成
</div>
`;

        document.body.appendChild(panel);

        const statusEl = panel.querySelector('#seg_status');
        const btnRun = panel.querySelector('#seg_run');

        panel.querySelectorAll('.seg-preset').forEach(btn => {
            btn.onclick = () => {
                panel.querySelector('#seg_start').value = btn.dataset.start;
                panel.querySelector('#seg_end').value = btn.dataset.end;
            };
        });

        btnRun.onclick = async () => {
            const url = panel.querySelector('#seg_url').value.trim();
            const startSec = Number(panel.querySelector('#seg_start').value);
            const endSec = Number(panel.querySelector('#seg_end').value);

            if (!url) { alert('请填入 M3U8 地址'); return; }
            if (endSec <= startSec) { alert('结束秒必须大于开始秒'); return; }

            btnRun.disabled = true;
            btnRun.style.opacity = '0.6';
            btnRun.textContent = '裁剪中...';

            statusEl.style.display = 'block';
            statusEl.style.color = '#aaa';
            statusEl.textContent = '初始化...';

            try {
                await cropAndTrigger1DM(url, startSec, endSec, (text) => {
                    statusEl.style.color = text.includes('✅') ? '#4caf50' : (text.includes('❌') ? '#e74c3c' : '#aaa');
                    statusEl.textContent = text;
                });
            } catch (e) {
                console.error(e);
                statusEl.style.color = '#e74c3c';
                statusEl.textContent = '❌ ' + e.message;
                alert('裁剪失败: ' + e.message);
            } finally {
                btnRun.disabled = false;
                btnRun.style.opacity = '1';
                btnRun.textContent = '✂️ 裁剪 M3U8 → 1DM 下载';
                setTimeout(() => { statusEl.style.display = 'none'; }, 6000);
            }
        };
    }

    // ==========================================
    // 自动填充当前页面 M3U8
    // ==========================================
    function autoDetectM3U8() {
        const videos = document.querySelectorAll('video');
        for (const v of videos) {
            const src = v.currentSrc || v.src;
            if (src && src.includes('.m3u8')) {
                const input = document.querySelector('#seg_url');
                if (input && !input.value) {
                    input.value = src;
                    console.log('[1DM] 自动填充 M3U8:', src);
                }
                break;
            }
        }
    }

    // ==========================================
    // 启动
    // ==========================================
    function waitBody() {
        return new Promise(resolve => {
            if (document.body) return resolve();
            const obs = new MutationObserver(() => {
                if (document.body) { obs.disconnect(); resolve(); }
            });
            obs.observe(document.documentElement, { childList: true, subtree: true });
        });
    }

    waitBody().then(() => {
        createPanel();
        setTimeout(autoDetectM3U8, 500);
    });

})();