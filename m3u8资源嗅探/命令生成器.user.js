// ==UserScript==
// @name         N_m3u8DL-RE 命令生成器
// @namespace    http://tampermonkey.net/
// @version      4.1
// @description  自动嗅探m3u8 → 生成N_m3u8DL-RE下载命令 → 导出txt
// @match        *://*/*
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isAndroid = /Android/i.test(navigator.userAgent);

    const state = {
        sniffedUrls: [],
        sniffedSet: new Set(),
        selectedUrl: null,
        startTime: '',
        endTime: '',
        fileName: '',
        currentTab: 0,
    };

    function startSniffer() {
        const m3u8Regex = /\.m3u8($|\?)|application\/.*mpegurl/i;

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

        if (window.performance && typeof performance.getEntriesByType === 'function') {
            try {
                performance.getEntriesByType('resource').forEach(entry => {
                    if (m3u8Regex.test(entry.name)) {
                        handleM3u8Found(entry.name);
                    }
                });
            } catch (e) { }
        }
    }

    function handleM3u8Found(url) {
        const cleanUrl = url.split('?')[0];
        if (state.sniffedSet.has(cleanUrl)) return;
        state.sniffedSet.add(cleanUrl);
        state.sniffedUrls.push(url);
        console.log('[嗅探] m3u8:', url);
        appendSniffedItem();
        renderStatus();
    }

    function safeName(s) {
        return String(s || 'clip').replace(/[\\/:*?"<>|]/g, '_');
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function toHMS(str) {
        str = String(str || '').replace(/\D/g, '').padStart(6, '0');
        if (str.length !== 6) return null;
        return str.substring(0, 2) + ':' + str.substring(2, 4) + ':' + str.substring(4, 6);
    }

    function buildCommand() {
        if (!state.selectedUrl) return '';
        const parts = ['~/test/N_m3u8DL-RE', `"${state.selectedUrl}"`];
        if (state.startTime && state.endTime) {
            const start = toHMS(state.startTime);
            const end = toHMS(state.endTime);
            if (start && end) {
                parts.push(`--custom-range "${start}-${end}"`);
            }
        }
        parts.push('--thread-count 8', '--download-retry-count 5', '--no-log', '--save-dir ~/storage/downloads', `--save-name "${state.fileName || 'clip'}"`);
        return parts.join(' ');
    }

    function copyToClipboard(text) {
        return new Promise((resolve) => {
            if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(() => resolve(true), () => fallbackCopy(text, resolve));
            } else if (typeof GM_setClipboard === 'function') {
                try { GM_setClipboard(text); resolve(true); } catch (e) { resolve(false); }
            } else {
                fallbackCopy(text, resolve);
            }
        });
    }

    function fallbackCopy(text, resolve) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '-9999px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            resolve(true);
        } catch (e) {
            resolve(false);
        }
        ta.remove();
    }

    function downloadTxt(content, filename) {
        if (isIOS) {
            const url = 'data:text/plain;charset=utf-8,' + encodeURIComponent(content);
            const w = window.open(url, '_blank');
            if (!w) {
                location.href = url;
            }
            showToast('iOS: 长按文本 → 存储到文件');
            return;
        }
        try {
            const blob = new Blob([content], { type: 'text/plain' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        } catch (e) {
            copyToClipboard(content).then(() => {
                showToast('下载失败，已复制到剪贴板');
            });
        }
    }

    const CSS = `
    .root{position:fixed;bottom:calc(3px + env(safe-area-inset-bottom));left:10px;z-index:999999;width:min(340px,calc(100vw - 20px));max-height:40vh;height:auto;border-radius:6px;border:1px solid #4caf50;background:rgba(0,0,0,0.85);color:#fff;font-size:11px;font-family:sans-serif;display:flex;flex-direction:column;overflow:hidden;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);transition:bottom .15s ease;align-self:flex-start;}
    .root.hidden{display:none;}
    .tab-header{display:flex;background:rgba(255,255,255,0.06);border-bottom:1px solid rgba(255,255,255,0.1);flex-shrink:0;}
    .tab-btn{flex:1;padding:7px 4px;background:transparent;color:#aaa;border:none;border-bottom:2px solid transparent;cursor:pointer;font-size:11px;transition:all .15s;-webkit-tap-highlight-color:transparent;}
    .tab-btn.active{color:#4caf50;border-bottom:2px solid #4caf50;}
    .close-btn{padding:4px 10px;color:#888;font-size:14px;background:transparent;border:none;border-left:1px solid rgba(255,255,255,0.1);cursor:pointer;-webkit-tap-highlight-color:transparent;}
    .content{flex:1;overflow-y:auto;padding:6px 0;-webkit-overflow-scrolling:touch;}
    .btn{background:transparent;border:1px solid #4caf50;color:#4caf50;padding:7px 10px;border-radius:3px;cursor:pointer;font-size:11px;-webkit-tap-highlight-color:transparent;touch-action:manipulation;}
    .btn.primary{background:#4caf50;color:#000;}
    .btn.primary:active{background:#6dcf72;}
    .btn-row{display:flex;gap:8px;padding:0 8px;margin-top:8px;}
    .btn-row .btn{flex:1;}

    .manual-row{padding:0 8px 6px;}
    .divider{height:1px;background:rgba(255,255,255,0.06);margin:4px 0;}
    .sniffer-list{list-style:none;margin:0;padding:0;}
    .sniffer-item{padding:8px 8px;border-bottom:1px solid rgba(255,255,255,0.06);cursor:pointer;display:flex;align-items:center;gap:6px;-webkit-tap-highlight-color:rgba(76,175,80,0.2);}
    .sniffer-item.selected{background:rgba(76,175,80,0.15);border-left:3px solid #4caf50;padding-left:5px;}
    .item-name{font-weight:bold;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;}
    .item-check{color:#4caf50;font-size:12px;flex-shrink:0;}
    .empty-state{text-align:center;padding:16px;color:#666;}
    .status-bar{padding:4px 8px;border-top:1px solid rgba(255,255,255,0.06);color:#aaa;font-size:10px;flex-shrink:0;}

    .picked-row{padding:8px;background:rgba(76,175,80,0.1);border-bottom:1px solid rgba(255,255,255,0.06);cursor:pointer;color:#4caf50;font-weight:bold;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .section-title{padding:6px 8px;color:#888;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.06);margin-top:4px;}
    .time-row{display:flex;align-items:center;justify-content:center;gap:8px;padding:8px;}
    .time-input{width:70px;font-family:monospace;font-size:14px;text-align:center;background:#0f3460;color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:3px;padding:6px 4px;outline:none;}
    .time-input:focus{border-color:#4caf50;}
    .time-sep{color:#888;}
    .hint{padding:0 8px 4px;color:#666;font-size:10px;text-align:center;line-height:1.5;}
    .file-row{padding:4px 8px 8px;}
    .file-input{width:100%;padding:6px;background:#0f3460;color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:3px;font-size:12px;outline:none;box-sizing:border-box;}
    .file-input:focus{border-color:#4caf50;}
    .next-row{padding:0 8px 8px;display:flex;justify-content:flex-end;}
    .warn{text-align:center;padding:16px;color:#ff9800;font-size:11px;}

    .summary{padding:6px 8px;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.06);line-height:1.7;}
    .summary .sum-link{color:#4caf50;font-weight:bold;}
    .summary .sum-line{color:#aaa;}
    .preview-title{padding:6px 8px;color:#888;font-size:10px;}
    .cmd-box{margin:0 8px;background:#0a0a1a;color:#6f9;border:1px solid #333;font-family:monospace;font-size:11px;padding:8px;border-radius:3px;min-height:80px;width:calc(100% - 16px);box-sizing:border-box;outline:none;line-height:1.5;white-space:pre-wrap;word-break:break-all;}

    .toast{position:fixed;bottom:60px;left:50%;transform:translateX(-50%);background:#4caf50;color:#000;padding:8px 16px;border-radius:4px;font-size:12px;z-index:1000000;box-shadow:0 2px 8px rgba(0,0,0,0.5);pointer-events:none;opacity:0;transition:opacity .2s;max-width:80vw;text-align:center;}
    .toast.show{opacity:1;}

    .restore-btn{position:fixed;bottom:80px;right:10px;width:32px;height:32px;border-radius:50%;background:rgba(76,175,80,0.85);color:#000;font-size:16px;border:none;cursor:pointer;z-index:999998;box-shadow:0 2px 8px rgba(0,0,0,0.5);display:none;-webkit-tap-highlight-color:transparent;}
    .restore-btn.show{display:flex;align-items:center;justify-content:center;}
    `;

    let shadowRoot, rootEl, contentEl, statusEl;
    let restoreBtnEl;

    function initPanel() {
        const host = document.createElement('div');
        host.id = 'nm-cmd-gen-host';
        document.body.appendChild(host);
        shadowRoot = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = CSS;
        shadowRoot.appendChild(style);

        rootEl = document.createElement('div');
        rootEl.className = 'root';
        rootEl.innerHTML = `
            <div class="tab-header">
                <button class="tab-btn active" data-tab="0">嗅探</button>
                <button class="tab-btn" data-tab="1">时间段</button>
                <button class="tab-btn" data-tab="2">生成</button>
                <button class="close-btn" title="关闭">×</button>
            </div>
            <div class="content"></div>
            <div class="status-bar">共 0 个 | 嗅探中...</div>
        `;
        shadowRoot.appendChild(rootEl);

        restoreBtnEl = document.createElement('button');
        restoreBtnEl.className = 'restore-btn';
        restoreBtnEl.textContent = '⬇';
        restoreBtnEl.title = '恢复面板';
        restoreBtnEl.addEventListener('click', () => {
            rootEl.classList.remove('hidden');
            restoreBtnEl.classList.remove('show');
            if (state.currentTab === 2) {
                const tb = rootEl.querySelector('.cmd-box');
                if (tb) tb.value = buildCommand();
            }
        });
        shadowRoot.appendChild(restoreBtnEl);

        contentEl = rootEl.querySelector('.content');
        statusEl = rootEl.querySelector('.status-bar');

        rootEl.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => switchTab(parseInt(btn.dataset.tab)));
        });
        rootEl.querySelector('.close-btn').addEventListener('click', () => {
            rootEl.classList.add('hidden');
            restoreBtnEl.classList.add('show');
        });

        renderTab();
        renderStatus();
        setupViewportAdjust();

        if (typeof GM_registerMenuCommand === 'function') {
            try {
                GM_registerMenuCommand('显示/隐藏 N_m3u8DL 面板', () => {
                    rootEl.classList.toggle('hidden');
                    restoreBtnEl.classList.toggle('show');
                });
            } catch (e) { }
        }
    }

    function setupViewportAdjust() {
        if (window.visualViewport) {
            const update = () => {
                const offset = window.innerHeight - window.visualViewport.height;
                if (rootEl) {
                    rootEl.style.bottom = `calc(3px + env(safe-area-inset-bottom) + ${Math.max(0, offset)}px)`;
                }
            };
            window.visualViewport.addEventListener('resize', update);
            window.visualViewport.addEventListener('scroll', update);
        }
    }

    function showToast(msg) {
        let toast = shadowRoot.querySelector('.toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.className = 'toast';
            shadowRoot.appendChild(toast);
        }
        toast.textContent = msg;
        toast.classList.add('show');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => toast.classList.remove('show'), 1800);
    }

    function switchTab(idx) {
        state.currentTab = idx;
        rootEl.querySelectorAll('.tab-btn').forEach((b, i) => {
            b.classList.toggle('active', i === idx);
        });
        renderTab();
    }

    function renderTab() {
        if (state.currentTab === 0) renderTab1();
        else if (state.currentTab === 1) renderTab2();
        else renderTab3();
    }

    function renderStatus() {
        if (!statusEl) return;
        statusEl.textContent = `共 ${state.sniffedUrls.length} 个 | 嗅探中...`;
    }

    function getSnifferListEl() {
        return contentEl.querySelector('.sniffer-list');
    }

    function getEmptyStateEl() {
        return contentEl.querySelector('.empty-state');
    }

    function renderTab1() {
        const items = state.sniffedUrls;
        let ul = getSnifferListEl();
        const empty = getEmptyStateEl();

        if (!ul) {
            let html = `
                <div class="manual-row">
                    <button class="btn" id="manual-paste">手动粘贴</button>
                </div>
                <div class="divider"></div>
            `;
            if (items.length === 0) {
                html += `<div class="empty-state">等待嗅探 m3u8...</div>`;
            } else {
                html += `<ul class="sniffer-list"></ul>`;
            }
            contentEl.innerHTML = html;

            if (items.length > 0) {
                ul = contentEl.querySelector('.sniffer-list');
                items.forEach((url, i) => {
                    ul.appendChild(createSnifferItem(url, i));
                });
            }

            bindTab1Events();
        } else {
            updateAllSelectedClasses();
        }
    }

    function createSnifferItem(url, idx) {
        const name = escapeHtml((url.split('/').pop().split('?')[0]) || url);
        const isSel = state.selectedUrl && state.selectedUrl.split('?')[0] === url.split('?')[0];
        const li = document.createElement('li');
        li.className = 'sniffer-item' + (isSel ? ' selected' : '');
        li.dataset.idx = idx;
        li.dataset.url = url;
        li.title = url;
        li.innerHTML = `
            <span class="item-name">${name}</span>
            ${isSel ? '<span class="item-check">✓</span>' : ''}
        `;
        li.addEventListener('click', () => {
            state.selectedUrl = state.sniffedUrls[parseInt(li.dataset.idx)];
            if (!state.fileName) state.fileName = safeName(document.title);
            switchTab(1);
        });
        return li;
    }

    function appendSniffedItem() {
        if (state.currentTab !== 0) return;
        const ul = getSnifferListEl();
        if (ul) {
            const empty = getEmptyStateEl();
            if (empty) empty.remove();
            ul.appendChild(createSnifferItem(state.sniffedUrls[state.sniffedUrls.length - 1], state.sniffedUrls.length - 1));
        }
        renderStatus();
    }

    function updateAllSelectedClasses() {
        const ul = getSnifferListEl();
        if (!ul) return;
        ul.querySelectorAll('.sniffer-item').forEach(li => {
            const url = li.dataset.url;
            const isSel = state.selectedUrl && state.selectedUrl.split('?')[0] === url.split('?')[0];
            li.classList.toggle('selected', isSel);
            const check = li.querySelector('.item-check');
            if (isSel) {
                if (!check) {
                    const s = document.createElement('span');
                    s.className = 'item-check';
                    s.textContent = '✓';
                    li.appendChild(s);
                }
            } else {
                if (check) check.remove();
            }
        });
    }

    function bindTab1Events() {
        contentEl.querySelector('#manual-paste')?.addEventListener('click', () => {
            const url = prompt('粘贴 m3u8 链接：');
            if (url && url.trim()) {
                handleM3u8Found(url.trim());
                state.selectedUrl = url.trim();
                if (!state.fileName) state.fileName = safeName(document.title);
                switchTab(1);
            }
        });
    }

    function renderTab2() {
        if (!state.selectedUrl) {
            contentEl.innerHTML = `<div class="warn">⚠️ 请先在嗅探 tab 选择一个 m3u8</div>`;
            return;
        }

        const urlName = escapeHtml((state.selectedUrl.split('/').pop().split('?')[0]) || state.selectedUrl);
        contentEl.innerHTML = `
            <div class="picked-row">📌 ${urlName}</div>
            <div class="section-title">── 时间范围 ──</div>
            <div class="time-row">
                <input class="time-input" id="start-time" inputmode="numeric" maxlength="6" placeholder="起始" value="${state.startTime}">
                <span class="time-sep">—</span>
                <input class="time-input" id="end-time" inputmode="numeric" maxlength="6" placeholder="结束" value="${state.endTime}">
            </div>
            <div class="hint">格式 HHMMSS（6位数字）<br>清空两个框 = 全程下载</div>
            <div class="section-title">── 文件名 ──</div>
            <div class="file-row">
                <input class="file-input" id="file-name" type="text" placeholder="保存文件名" value="${escapeHtml(state.fileName)}">
            </div>
            <div class="next-row">
                <button class="btn" id="next-btn">下一步 →</button>
            </div>
        `;

        const st = contentEl.querySelector('#start-time');
        const et = contentEl.querySelector('#end-time');
        const fn = contentEl.querySelector('#file-name');

        [st, et].forEach(input => {
            input.addEventListener('input', () => {
                input.value = input.value.replace(/\D/g, '').slice(0, 6);
                if (input === st) state.startTime = input.value;
                else state.endTime = input.value;
            });
        });

        fn.addEventListener('input', () => {
            state.fileName = fn.value;
        });

        contentEl.querySelector('#next-btn').addEventListener('click', () => switchTab(2));
        contentEl.querySelector('.picked-row').addEventListener('click', () => switchTab(0));
    }

    function renderTab3() {
        if (!state.selectedUrl) {
            contentEl.innerHTML = `<div class="warn">⚠️ 请先在嗅探 tab 选择一个 m3u8</div>`;
            return;
        }

        const urlName = escapeHtml((state.selectedUrl.split('/').pop().split('?')[0]) || state.selectedUrl);
        let timeStr = '全程下载';
        if (state.startTime && state.endTime) {
            const s = toHMS(state.startTime);
            const e = toHMS(state.endTime);
            if (s && e) timeStr = `${s} - ${e}`;
        }
        const fname = escapeHtml(state.fileName || '(未命名)');

        contentEl.innerHTML = `
            <div class="summary">
                <div class="sum-link">📌 ${urlName}</div>
                <div class="sum-line">⏱ ${timeStr}</div>
                <div class="sum-line">📄 文件名: ${fname}</div>
            </div>
            <div class="preview-title">▶ 命令预览</div>
            <textarea class="cmd-box" readonly></textarea>
            <div class="btn-row">
                <button class="btn primary" id="copy-btn">📋 复制</button>
                <button class="btn" id="download-btn">💾 下载 nm_tpl.txt</button>
            </div>
        `;

        const tb = contentEl.querySelector('.cmd-box');
        tb.value = buildCommand();

        contentEl.querySelector('#copy-btn').addEventListener('click', () => {
            copyToClipboard(buildCommand()).then(ok => {
                showToast(ok ? '已复制到剪贴板' : '复制失败');
            });
        });

        contentEl.querySelector('#download-btn').addEventListener('click', () => {
            downloadTxt(buildCommand(), 'nm_tpl.txt');
        });
    }

    function run() {
        state.fileName = safeName(document.title);
        startSniffer();
        initPanel();
    }

    if (document.body) {
        run();
    } else {
        const ob = new MutationObserver(() => {
            if (document.body) {
                ob.disconnect();
                run();
            }
        });
        ob.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(() => ob.disconnect(), 5000);
    }
})();