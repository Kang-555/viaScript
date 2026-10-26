// ==UserScript==
// @name         1DM HLS片段裁剪（导出文件版）
// @namespace    http://tampermonkey.net/
// @version      5.1
// @description  裁剪M3U8时间段，导出为本地文件，1DM打开本地文件下载指定片段
// @author       You
// @match        *://*/*
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ==========================================
    // 工具函数
    // ==========================================
    function resolveUrl(baseUrl, relativeUrl) {
        try {
            return new URL(relativeUrl, baseUrl).href;
        } catch {
            if (relativeUrl.startsWith('http')) return relativeUrl;
            if (relativeUrl.startsWith('/')) {
                const u = new URL(baseUrl);
                return u.origin + relativeUrl;
            }
            const path = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
            return path + relativeUrl;
        }
    }

    function parseTimeInput(str) {
        str = str.trim();
        if (!str) return 0;
        const parts = str.split(':').map(Number);
        if (parts.some(isNaN)) return 0;
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 1) return parts[0];
        return 0;
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
    // M3U8 解析（保留所有原始标签）
    // ==========================================
    function parseM3u8(m3u8Text, baseUrl) {
        const lines = m3u8Text.split(/\r?\n/);
        const segments = [];
        const globalTags = [];
        const keyTags = [];
        const mapTags = [];
        let targetDuration = null;
        let mediaSequence = 0;
        let currentInf = 0;
        let currentKeyLine = null;
        let currentKeyUrl = null;
        let currentIV = null;
        let sequence = 0;
        let timeAcc = 0;
        let isMaster = false;

        for (const line of lines) {
            const l = line.trim();
            if (!l) continue;

            if (l === '#EXTM3U') {
                globalTags.push(l);
                continue;
            }

            if (l.startsWith('#EXT-X-STREAM-INF') || l.startsWith('#EXT-X-MEDIA:')) {
                isMaster = true;
            }

            if (l.startsWith('#EXT-X-VERSION')) {
                globalTags.push(l);
            } else if (l.startsWith('#EXT-X-TARGETDURATION')) {
                const m = l.match(/#EXT-X-TARGETDURATION:(\d+)/);
                if (m) targetDuration = parseInt(m[1]);
            } else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
                const m = l.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
                if (m) mediaSequence = parseInt(m[1]);
                sequence = mediaSequence;
            } else if (l.startsWith('#EXT-X-KEY')) {
                currentKeyLine = l;
                keyTags.push(l);
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
            } else if (l.startsWith('#EXT-X-MAP')) {
                mapTags.push(l);
                const uri = (l.match(/URI="([^"]+)"/) || [])[1];
                if (uri) {
                    const absUri = resolveUrl(baseUrl, uri);
                    mapTags[mapTags.length - 1] = l.replace(/URI="[^"]+"/, `URI="${absUri}"`);
                }
            } else if (l.startsWith('#EXTINF:')) {
                const m = l.match(/#EXTINF:([\d\.]+)/);
                if (m) currentInf = parseFloat(m[1]);
            } else if (!l.startsWith('#')) {
                if (!isMaster) {
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
        }

        return {
            segments,
            totalDuration: timeAcc,
            isMaster,
            globalTags,
            keyTags,
            mapTags,
            targetDuration,
            mediaSequence
        };
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
    // 生成裁剪后的 M3U8 文本（保留完整标签）
    // ==========================================
    function generateCroppedM3U8(parsed, startIdx, endIdx) {
        const { segments, globalTags, keyTags, mapTags, targetDuration, mediaSequence } = parsed;
        const output = [];

        // 头部标签
        output.push('#EXTM3U');
        if (targetDuration) output.push(`#EXT-X-TARGETDURATION:${targetDuration}`);
        output.push(`#EXT-X-VERSION:3`);

        // 初始化片段（如果有）
        for (const mapTag of mapTags) {
            output.push(mapTag);
        }

        // 加密密钥（必须保留，URI 已是绝对路径）
        for (const keyTag of keyTags) {
            output.push(keyTag);
        }

        // 媒体序列号
        const firstSeg = segments[startIdx];
        output.push(`#EXT-X-MEDIA-SEQUENCE:${firstSeg ? firstSeg.seq : mediaSequence}`);

        // 如果不是从第 0 分片开始，添加 DISCONTINUITY
        if (startIdx > 0) {
            output.push('#EXT-X-DISCONTINUITY');
        }

        // 分片列表（所有 URL 已是绝对路径）
        for (let i = startIdx; i <= endIdx; i++) {
            const seg = segments[i];
            output.push(`#EXTINF:${seg.duration.toFixed(4)},`);
            output.push(seg.url);
        }

        // 结束标记
        output.push('#EXT-X-DISCONTINUITY');
        output.push('#EXT-X-ENDLIST');

        return output.join('\n');
    }

    // ==========================================
    // 主流程：裁剪 + 导出文件
    // ==========================================
    async function cropAndExport(m3u8Url, startSec, endSec, onStatus) {
        onStatus('拉取原始 M3U8...');

        const m3u8Text = await gmRequest(m3u8Url);
        const parsed = parseM3u8(m3u8Text, m3u8Url);

        if (parsed.isMaster) {
            throw new Error('检测到 Master M3U8（多级嵌套），请填入二级 Media M3U8 地址');
        }

        if (parsed.segments.length === 0) {
            throw new Error('未解析到分片');
        }

        const clampedStart = Math.max(0, startSec);
        const clampedEnd = Math.min(parsed.totalDuration, endSec);
        if (clampedEnd <= clampedStart) throw new Error('时间范围无效');

        const { startIdx, endIdx } = timeToSegmentIndex(parsed.segments, clampedStart, clampedEnd);
        const segCount = endIdx - startIdx + 1;
        const actualStart = parsed.segments[startIdx].tStart;
        const actualEnd = parsed.segments[endIdx].tEnd;

        onStatus(`裁剪分片 ${startIdx}-${endIdx} (${segCount}个) | 实际 ${actualStart.toFixed(1)}s ~ ${actualEnd.toFixed(1)}s`);

        // 生成裁剪后的 M3U8
        const croppedM3U8 = generateCroppedM3U8(parsed, startIdx, endIdx);

        // 复制到剪贴板（最可靠的方式）
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(croppedM3U8);
            onStatus('✅ 已复制到剪贴板，请粘贴到文本编辑器保存为 .m3u8 文件');
        } else {
            // 备用：创建 textarea 复制
            const textarea = document.createElement('textarea');
            textarea.value = croppedM3U8;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            onStatus('✅ 已复制到剪贴板');
        }

        const filename = `cut_${Math.round(actualStart)}s-${Math.round(actualEnd)}s.m3u8`;

        // 非阻塞提示
        setTimeout(() => {
            statusEl.style.display = 'block';
            statusEl.style.color = '#4caf50';
            statusEl.innerHTML = `✅ 裁剪完成！<br>分片: ${startIdx}-${endIdx} (${segCount}个)<br>时间段: ${actualStart.toFixed(1)}s ~ ${actualEnd.toFixed(1)}s<br><br>请：<br>1. 粘贴到文本编辑器<br>2. 保存为 ${filename}<br>3. 用 1DM 打开该文件`;
        }, 500);
    }

    // ==========================================
    // UI 悬浮面板
    // ==========================================
    function createPanel() {
        const panel = document.createElement('div');
        panel.style.cssText = `
position:fixed;bottom:20px;right:20px;z-index:999999;background:rgba(0,0,0,0.92);
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
    <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">开始</label>
    <input id="seg_start" type="text" value="0:00" style="width:100%;box-sizing:border-box;padding:8px 10px;background:#222;border:1px solid #444;border-radius:6px;color:#fff;font-size:12px;text-align:center;" placeholder="mm:ss 或 ss">
  </div>
  <div style="flex:1;">
    <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">结束</label>
    <input id="seg_end" type="text" value="1:00" style="width:100%;box-sizing:border-box;padding:8px 10px;background:#222;border:1px solid #444;border-radius:6px;color:#fff;font-size:12px;text-align:center;" placeholder="mm:ss 或 ss">
  </div>
</div>

<div id="seg_status" style="margin-bottom:10px;padding:10px;background:#1a1a1a;border-radius:6px;font-size:12px;color:#888;min-height:20px;display:none;line-height:1.5;"></div>

<button id="seg_run" style="width:100%;padding:10px;background:linear-gradient(135deg,#ff6d00,#e65100);border:none;border-radius:6px;color:#000;font-weight:bold;font-size:13px;cursor:pointer;">
✂️ 裁剪 M3U8 → 导出文件
</button>

<div style="font-size:11px;color:#666;margin-top:8px;text-align:center;">
  导出本地文件 · 1DM 打开文件下载指定片段
</div>
`;

        document.body.appendChild(panel);

        const statusEl = panel.querySelector('#seg_status');
        const btnRun = panel.querySelector('#seg_run');

        btnRun.onclick = async () => {
            const url = panel.querySelector('#seg_url').value.trim();
            const startSec = parseTimeInput(panel.querySelector('#seg_start').value);
            const endSec = parseTimeInput(panel.querySelector('#seg_end').value);

            if (!url) { alert('请填入 M3U8 地址'); return; }
            if (endSec <= startSec) { alert('结束时间必须大于开始时间'); return; }

            btnRun.disabled = true;
            btnRun.style.opacity = '0.6';
            btnRun.textContent = '处理中...';

            statusEl.style.display = 'block';
            statusEl.style.color = '#aaa';
            statusEl.textContent = '初始化...';

            try {
                await cropAndExport(url, startSec, endSec, (text) => {
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
                btnRun.textContent = '✂️ 裁剪 M3U8 → 导出文件';
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