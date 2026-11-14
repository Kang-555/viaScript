// ==UserScript==
// @name         多时间段批量 PC端
// @namespace    http://tampermonkey.net/
// @version      2.3
// @description  多时间段批量PC端下载，配合bat文件
// @match        *://*/*
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_webRequest
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const _tag = 'm' + Math.random().toString(36).slice(2, 8);
    const _MSG_KEY = '__' + _tag;
    const CSS_CLASSES = {
        root: _tag + '-root',
        hidden: _tag + '-hid',
        tabHeader: _tag + '-th',
        tabBtn: _tag + '-tb',
        tabBtnActive: _tag + '-tb-a',
        closeBtn: _tag + '-cb',
        content: _tag + '-ct',
        btn: _tag + '-b',
        btnPrimary: _tag + '-b-p',
        btnRow: _tag + '-br',
        manualRow: _tag + '-mr',
        divider: _tag + '-dv',
        list: _tag + '-sl',
        item: _tag + '-si',
        itemSel: _tag + '-si-s',
        itemName: _tag + '-in',
        itemCheck: _tag + '-ic',
        itemCopy: _tag + '-ico',
        itemDl: _tag + '-id',
        empty: _tag + '-es',
        status: _tag + '-sb',
        picked: _tag + '-pr',
        secTitle: _tag + '-st',
        secTxt: _tag + '-stt',
        secHint: _tag + '-sth',
        timeRow: _tag + '-tr',
        timeInput: _tag + '-ti',
        timeSep: _tag + '-ts',
        fileRow: _tag + '-fr',
        fileInput: _tag + '-fi',
        segList: _tag + '-slst',
        warn: _tag + '-wn',
        summary: _tag + '-sm',
        sumLink: _tag + '-sln',
        sumLine: _tag + '-sml',
        prevTitle: _tag + '-pt',
        cmdBox: _tag + '-cx',
        toast: _tag + '-tt',
        restoreBtn: _tag + '-rb',
        restoreShow: _tag + '-rb-s',
    };

    const state = {
        sniffedUrls: [],
        sniffedSet: new Set(),
        selectedUrl: null,
        segments: [],
        fileName: '',
        currentTab: 0,
        referer: '',
        visitedRes: new Set(),
    };

    const EXE = 'N_m3u8DL-CLI_v3.0.2.exe';
    const WORK_DIR = 'C:\\Users\\sjopfops\\Downloads';
    const COMMON_FLAGS = ['--enableBinaryMerge', '--enableDelAfterDone', '--noProxy'];

    const M3U8_REGEX = /\.m3u8($|\?)|application\/.*mpegurl/i;
    const MP4_REGEX = /\.mp4(\?|$)/i;

    function detectType(url, contentType) {
        if (MP4_REGEX.test(url)) return 'mp4';
        if (M3U8_REGEX.test(url)) return 'm3u8';
        if (contentType) {
            if (/video\/mp4/i.test(contentType)) return 'mp4';
            if (/mpegurl|mpegurl/i.test(contentType)) return 'm3u8';
        }
        return null;
    }

    function startSniffer() {
        const captureReferer = () => { state.referer = location.href; };
        captureReferer();

        try {
            const origOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (method, url, async) {
                this._url = url;
                this.addEventListener('load', () => {
                    try {
                        const u = this.responseURL || this._url;
                        const ct = this.getResponseHeader('content-type') || '';
                        const type = detectType(u, ct);
                        if (type) handleVideoFound(u, type);
                    } catch (e) { }
                });
                return origOpen.apply(this, arguments);
            };
        } catch (e) { }

        const origFetch = window.fetch;
        if (origFetch) {
            window.fetch = async function (...args) {
                const url = args[0] instanceof Request ? args[0].url : String(args[0]);
                captureReferer();
                try {
                    const res = await origFetch.apply(this, args);
                    const ct = res.headers.get('content-type') || '';
                    const type = detectType(url, ct);
                    if (type) handleVideoFound(url, type);
                    return res;
                } catch (err) {
                    const type = detectType(url, '');
                    if (type) handleVideoFound(url, type);
                    throw err;
                }
            };
        }

        if (window.performance && typeof PerformanceObserver !== 'undefined') {
            try {
                const scan = () => {
                    performance.getEntriesByType('resource').forEach(entry => {
                        if (state.visitedRes.has(entry.name)) return;
                        state.visitedRes.add(entry.name);
                        const type = detectType(entry.name, '');
                        if (type) handleVideoFound(entry.name, type);
                    });
                };
                scan();
                const ob = new PerformanceObserver(scan);
                ob.observe({ entryTypes: ['resource'] });
            } catch (e) {
                try {
                    performance.getEntriesByType('resource').forEach(entry => {
                        const type = detectType(entry.name, '');
                        if (type) handleVideoFound(entry.name, type);
                    });
                } catch (ee) { }
            }
        }

        const scanDOM = () => {
            document.querySelectorAll('video, source').forEach(el => {
                let src = el.getAttribute('src') || el.currentSrc || '';
                if (!src || src.startsWith('blob:')) return;
                let type = detectType(src, '');
                if (type) handleVideoFound(src, type);
                if (src && !/^https?:/.test(src) && src.startsWith('/')) {
                    src = location.origin + src;
                    type = detectType(src, '');
                    if (type) handleVideoFound(src, type);
                }
            });
        };
        scanDOM();
        if (document.body) {
            const mo = new MutationObserver(() => scanDOM());
            mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
        }

        try {
            GM_webRequest([
                { selector: '*://*/*.m3u8*', action: { redirect: { from: '(.*)', to: '$1' } } },
                { selector: '*://*/*m3u8*', action: { redirect: { from: '(.*)', to: '$1' } } },
                { selector: '*://*/*.mp4*', action: { redirect: { from: '(.*)', to: '$1' } } },
                { selector: '*://*/*mp4*', action: { redirect: { from: '(.*)', to: '$1' } } },
            ], function (info, message, details) {
                if (details && details.url) {
                    const type = detectType(details.url, '');
                    if (type) handleVideoFound(details.url, type);
                }
            });
        } catch (e) { }

        const _wrapHistory = (type) => {
            const orig = history[type];
            history[type] = function () {
                const rv = orig.apply(this, arguments);
                captureReferer();
                scanDOM();
                window.dispatchEvent(new Event(type));
                return rv;
            };
        };
        try { _wrapHistory('pushState'); _wrapHistory('replaceState'); } catch (e) { }

        window.addEventListener('message', (ev) => {
            if (ev.data && typeof ev.data === 'string') {
                const type = detectType(ev.data, '');
                if (type) handleVideoFound(ev.data, type);
            }
        }, true);
    }

    function handleVideoFound(url, type) {
        if (window.self !== window.top) {
            try {
                window.top.postMessage({
                    [_MSG_KEY]: true,
                    url: url,
                    type: type,
                    referer: state.referer || location.href
                }, '*');
            } catch (e) { }
        }
        const key = type + '::' + url.split('?')[0];
        if (state.sniffedSet.has(key)) return;
        state.sniffedSet.add(key);
        state.sniffedUrls.push({ url: url, type: type });
        console.log('[嗅探]', type + ':', url);
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

    function buildCommandFor(seg, seq, isM3U8) {
        const full = safeName(state.fileName || document.title);
        const parts = [
            '"' + EXE + '"',
            '"' + state.selectedUrl + '"',
            '--workDir "' + WORK_DIR + '\\' + full + '"',
            '--saveName "' + full + seq + '"'
        ];
        if (isM3U8 && seg && seg.start && seg.end) {
            const s = toHMS(seg.start);
            const e = toHMS(seg.end);
            if (s && e) parts.push('--downloadRange "' + s + '-' + e + '"');
        }
        parts.push(COMMON_FLAGS.join(' '));
        return parts.join(' ');
    }

    function buildBatchText() {
        const isM3U8 = (getSelectedType() || 'm3u8') !== 'mp4';
        const segments = state.segments.length ? state.segments : [{ start: '', end: '' }];
        return segments.map((seg, i) => buildCommandFor(seg, i + 1, isM3U8)).join('\n');
    }

    function buildBatText() {
        const cmds = buildBatchText().split('\n');
        return '@echo off\r\nchcp 65001 >nul\r\n\r\n' + cmds.join('\r\n') + '\r\n\r\npause';
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

    const C = CSS_CLASSES;
    const CSS = `
    .${C.root}{position:fixed;bottom:calc(3px + env(safe-area-inset-bottom));left:10px;z-index:999999;width:min(340px,calc(100vw - 20px));max-height:40vh;height:auto;border-radius:6px;border:1px solid #4caf50;background:rgba(0,0,0,0.85);color:#fff;font-size:11px;font-family:sans-serif;display:flex;flex-direction:column;overflow:hidden;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);transition:bottom .15s ease;align-self:flex-start;}
    .${C.root}.${C.hidden}{display:none;}
    .${C.tabHeader}{display:flex;background:rgba(255,255,255,0.06);border-bottom:1px solid rgba(255,255,255,0.1);flex-shrink:0;}
    .${C.tabBtn}{flex:1;padding:7px 4px;background:transparent;color:#aaa;border:none;border-bottom:2px solid transparent;cursor:pointer;font-size:11px;transition:all .15s;-webkit-tap-highlight-color:transparent;}
    .${C.tabBtn}.${C.tabBtnActive}{color:#4caf50;border-bottom:2px solid #4caf50;}
    .${C.closeBtn}{padding:4px 10px;color:#888;font-size:14px;background:transparent;border:none;border-left:1px solid rgba(255,255,255,0.1);cursor:pointer;-webkit-tap-highlight-color:transparent;}
    .${C.content}{flex:1;overflow-y:auto;padding:6px 0;-webkit-overflow-scrolling:touch;}
    .${C.btn}{background:transparent;border:1px solid #4caf50;color:#4caf50;padding:7px 10px;border-radius:3px;cursor:pointer;font-size:11px;-webkit-tap-highlight-color:transparent;touch-action:manipulation;}
    .${C.btn}.${C.btnPrimary}{background:#4caf50;color:#000;}
    .${C.btn}.${C.btnPrimary}:active{background:#6dcf72;}
    .${C.btnRow}{display:flex;gap:8px;padding:0 8px;margin-top:8px;}
    .${C.btnRow} .${C.btn}{flex:1;}
    .${C.manualRow}{padding:0 8px 6px;}
    .${C.divider}{height:1px;background:rgba(255,255,255,0.06);margin:4px 0;}
    .${C.list}{list-style:none;margin:0;padding:0;}
    .${C.item}{padding:8px 8px;border-bottom:1px solid rgba(255,255,255,0.06);cursor:pointer;display:flex;align-items:center;gap:6px;-webkit-tap-highlight-color:rgba(76,175,80,0.2);}
    .${C.item}.${C.itemSel}{background:rgba(76,175,80,0.15);border-left:3px solid #4caf50;padding-left:5px;}
    .${C.itemName}{font-weight:bold;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;}
    .${C.itemCheck}{color:#4caf50;font-size:12px;flex-shrink:0;}
    .${C.itemCopy}{background:rgba(76,175,80,0.25);border:1px solid #4caf50;color:#4caf50;font-size:10px;padding:2px 6px;border-radius:3px;cursor:pointer;flex-shrink:0;-webkit-tap-highlight-color:transparent;touch-action:manipulation;line-height:1.2;}
    .${C.itemCopy}:active{background:rgba(76,175,80,0.5);color:#000;}
    .${C.itemDl}{background:rgba(76,175,80,0.35);border:1px solid #4caf50;color:#4caf50;font-size:11px;padding:2px 5px;border-radius:3px;cursor:pointer;flex-shrink:0;-webkit-tap-highlight-color:transparent;touch-action:manipulation;line-height:1.2;}
    .${C.itemDl}:active{background:rgba(76,175,80,0.6);color:#000;}
    .${C.empty}{text-align:center;padding:16px;color:#666;}
    .${C.status}{padding:4px 8px;border-top:1px solid rgba(255,255,255,0.06);color:#aaa;font-size:10px;flex-shrink:0;}
    .${C.picked}{padding:8px;background:rgba(76,175,80,0.1);border-bottom:1px solid rgba(255,255,255,0.06);cursor:pointer;color:#4caf50;font-weight:bold;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .${C.secTitle}{padding:6px 8px;color:#888;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.06);margin-top:4px;display:flex;align-items:center;justify-content:space-between;}
    .${C.secTitle} .${C.secTxt}{color:#888;}
    .${C.secTitle} .${C.secHint}{color:#555;font-size:9px;font-weight:normal;}
    .${C.timeRow}{display:flex;align-items:center;justify-content:center;gap:8px;padding:4px 8px 8px;}
    .${C.timeInput}{width:70px;font-family:monospace;font-size:14px;text-align:center;color:#fff;border:1px solid rgba(255,255,255,0.25);border-radius:3px;padding:4px 4px;outline:none;flex-shrink:0;background:rgba(255,255,255,0.06);}
    .${C.timeInput}:focus{border-color:#4caf50;}
    .${C.timeSep}{color:#888;flex-shrink:0;}
    .${C.segList}{padding:4px 8px;display:flex;flex-direction:column;gap:6px;}
    .${C.fileRow}{padding:4px 8px 8px;}
    .${C.fileInput}{width:100%;padding:6px;background:#0f3460;color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:3px;font-size:12px;outline:none;box-sizing:border-box;resize:none;min-height:30px;max-height:80px;overflow-y:auto;line-height:1.4;white-space:pre-wrap;word-break:break-all;}
    .${C.fileInput}:focus{border-color:#4caf50;}
    .${C.warn}{text-align:center;padding:16px;color:#ff9800;font-size:11px;}
    .${C.summary}{padding:6px 8px;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.06);line-height:1.7;}
    .${C.summary} .${C.sumLink}{color:#4caf50;font-weight:bold;}
    .${C.summary} .${C.sumLine}{color:#aaa;}
    .${C.prevTitle}{padding:6px 8px;color:#888;font-size:10px;}
    .${C.cmdBox}{margin:0 8px;background:#0a0a1a;color:#6f9;border:1px solid #333;font-family:monospace;font-size:11px;padding:8px;border-radius:3px;min-height:80px;width:calc(100% - 16px);box-sizing:border-box;outline:none;line-height:1.5;white-space:pre-wrap;word-break:break-all;}
    .${C.toast}{position:fixed;bottom:60px;left:50%;transform:translateX(-50%);background:#4caf50;color:#000;padding:8px 16px;border-radius:4px;font-size:12px;z-index:1000000;box-shadow:0 2px 8px rgba(0,0,0,0.5);pointer-events:none;opacity:0;transition:opacity .2s;max-width:80vw;text-align:center;}
    .${C.toast}.show{opacity:1;}
    .${C.restoreBtn}{position:fixed;bottom:80px;right:10px;width:32px;height:32px;border-radius:50%;background:rgba(76,175,80,0.85);color:#000;font-size:16px;border:none;cursor:pointer;z-index:999998;box-shadow:0 2px 8px rgba(0,0,0,0.5);display:none;-webkit-tap-highlight-color:transparent;}
    .${C.restoreBtn}.${C.restoreShow}{display:flex;align-items:center;justify-content:center;}
    `;

    let shadowRoot, rootEl, contentEl, statusEl;
    let restoreBtnEl;
    let _hostId = _tag + '-h';

    function initPanel() {
        if (shadowRoot) return;
        if (document.getElementById(_hostId)) return;

        const host = document.createElement('div');
        host.id = _hostId;
        host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;display:block !important;';
        try {
            document.body.appendChild(host);
        } catch (e) {
            try { document.documentElement.appendChild(host); } catch (ee) { return; }
        }
        shadowRoot = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = CSS;
        shadowRoot.appendChild(style);

        rootEl = document.createElement('div');
        rootEl.className = C.root;
        rootEl.innerHTML = `
            <div class="${C.tabHeader}">
                <button class="${C.tabBtn} ${C.tabBtnActive}" data-tab="0">嗅探</button>
                <button class="${C.tabBtn}" data-tab="1">时间段</button>
                <button class="${C.tabBtn}" data-tab="2">生成</button>
                <button class="${C.closeBtn}" title="关闭">×</button>
            </div>
            <div class="${C.content}"></div>
            <div class="${C.status}">共 0 个 | 嗅探中...</div>
        `;
        shadowRoot.appendChild(rootEl);

        restoreBtnEl = document.createElement('button');
        restoreBtnEl.className = C.restoreBtn;
        restoreBtnEl.textContent = '⬇';
        restoreBtnEl.title = '恢复面板';
        restoreBtnEl.addEventListener('click', () => {
            rootEl.classList.remove(C.hidden);
            restoreBtnEl.classList.remove(C.restoreShow);
        });
        shadowRoot.appendChild(restoreBtnEl);

        contentEl = rootEl.querySelector('.' + C.content);
        statusEl = rootEl.querySelector('.' + C.status);

        rootEl.querySelectorAll('.' + C.tabBtn).forEach(btn => {
            btn.addEventListener('click', () => switchTab(parseInt(btn.dataset.tab)));
        });
        rootEl.querySelector('.' + C.closeBtn).addEventListener('click', () => {
            rootEl.classList.add(C.hidden);
            restoreBtnEl.classList.add(C.restoreShow);
        });

        renderTab();
        renderStatus();
        setupViewportAdjust();

        if (typeof GM_registerMenuCommand === 'function') {
            try {
                GM_registerMenuCommand('显示/隐藏视频嗅探面板', () => {
                    rootEl.classList.toggle(C.hidden);
                    restoreBtnEl.classList.toggle(C.restoreShow);
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
        let toast = shadowRoot.querySelector('.' + C.toast);
        if (!toast) {
            toast = document.createElement('div');
            toast.className = C.toast;
            shadowRoot.appendChild(toast);
        }
        toast.textContent = msg;
        toast.classList.add('show');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => toast.classList.remove('show'), 1800);
    }

    function switchTab(idx) {
        state.currentTab = idx;
        rootEl.querySelectorAll('.' + C.tabBtn).forEach((b, i) => {
            b.classList.toggle(C.tabBtnActive, i === idx);
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
        return contentEl.querySelector('.' + C.list);
    }

    function getEmptyStateEl() {
        return contentEl.querySelector('.' + C.empty);
    }

    function renderTab1() {
        const items = state.sniffedUrls;
        let ul = getSnifferListEl();
        const empty = getEmptyStateEl();

        if (!ul) {
            let html = `
                <div class="${C.manualRow}">
                    <button class="${C.btn}" id="manual-paste">手动粘贴</button>
                </div>
                <div class="${C.divider}"></div>
            `;
            if (items.length === 0) {
                html += `<div class="${C.empty}">等待嗅探视频资源 (m3u8/mp4)...</div>`;
            } else {
                html += `<ul class="${C.list}"></ul>`;
            }
            contentEl.innerHTML = html;

            if (items.length > 0) {
                ul = contentEl.querySelector('.' + C.list);
                items.forEach((item, i) => {
                    ul.appendChild(createSnifferItem(item, i));
                });
            }

            bindTab1Events();
        } else {
            updateAllSelectedClasses();
        }
    }

    function triggerDownload(url, filename) {
        showToast('触发下载...');
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    function createSnifferItem(item, idx) {
        const url = item.url;
        const type = item.type;
        const rawName = (url.split('/').pop().split('?')[0]) || 'clip';
        const name = escapeHtml(rawName);
        const isSel = state.selectedUrl && state.selectedUrl.split('?')[0] === url.split('?')[0];
        const li = document.createElement('li');
        li.className = C.item + (isSel ? ' ' + C.itemSel : '');
        li.dataset.idx = idx;
        li.dataset.url = url;
        li.title = url;
        const typeLabel = type === 'mp4' ? '🎬' : '📺';
        li.innerHTML = `
            <span class="${C.itemName}">${typeLabel} ${name}</span>
            ${isSel ? '<span class="' + C.itemCheck + '">✓</span>' : ''}
            <button class="${C.itemDl}" title="直接下载">⬇</button>
            <button class="${C.itemCopy}" title="复制链接">复制</button>
        `;
        const copyBtn = li.querySelector('.' + C.itemCopy);
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            copyToClipboard(url).then(ok => {
                showToast(ok ? '链接已复制' : '复制失败');
            });
        });
        li.querySelector('.' + C.itemDl).addEventListener('click', (e) => {
            e.stopPropagation();
            triggerDownload(url, safeName(rawName));
        });
        li.addEventListener('click', () => {
            state.selectedUrl = url;
            if (!state.fileName) state.fileName = safeName(document.title);
            switchTab(1);
        });
        return li;
    }

    function appendSniffedItem() {
        if (state.currentTab !== 0) return;
        const ul = getSnifferListEl();
        if (!ul) {
            renderTab1();
            renderStatus();
            return;
        }
        const empty = getEmptyStateEl();
        if (empty) empty.remove();
        const last = state.sniffedUrls[state.sniffedUrls.length - 1];
        ul.appendChild(createSnifferItem(last, state.sniffedUrls.length - 1));
        renderStatus();
    }

    function updateAllSelectedClasses() {
        const ul = getSnifferListEl();
        if (!ul) return;
        ul.querySelectorAll('.' + C.item).forEach(li => {
            const url = li.dataset.url;
            const isSel = state.selectedUrl && state.selectedUrl.split('?')[0] === url.split('?')[0];
            li.classList.toggle(C.itemSel, isSel);
            const check = li.querySelector('.' + C.itemCheck);
            if (isSel) {
                if (!check) {
                    const s = document.createElement('span');
                    s.className = C.itemCheck;
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
            const url = prompt('粘贴视频链接 (m3u8/mp4)：');
            if (url && url.trim()) {
                const type = detectType(url.trim(), '');
                if (type) {
                    handleVideoFound(url.trim(), type);
                    state.selectedUrl = url.trim();
                    if (!state.fileName) state.fileName = safeName(document.title);
                    switchTab(1);
                } else {
                    showToast('无法识别的链接格式');
                }
            }
        });
    }

    function getSelectedType() {
        if (!state.selectedUrl) return null;
        const item = state.sniffedUrls.find(function (x) { return x.url === state.selectedUrl; });
        return item ? item.type : detectType(state.selectedUrl, '');
    }

    function renderTab2() {
        if (!state.selectedUrl) {
            contentEl.innerHTML = `<div class="${C.warn}">⚠️ 请先在嗅探 tab 选择一个视频</div>`;
            return;
        }

        const type = getSelectedType();
        const typeLabel = type === 'mp4' ? 'MP4' : 'M3U8';
        const urlName = escapeHtml((state.selectedUrl.split('/').pop().split('?')[0]) || state.selectedUrl);

        if (state.segments.length === 0) state.segments = [{ start: '', end: '' }];

        const segHtml = state.segments.map((seg, i) => `
            <div class="${C.timeRow}">
                <span style="color:#888;">#${i + 1}</span>
                <input class="${C.timeInput}" data-idx="${i}" data-field="start" inputmode="numeric" maxlength="6" placeholder="起始" value="${escapeHtml(seg.start)}">
                <span class="${C.timeSep}">—</span>
                <input class="${C.timeInput}" data-idx="${i}" data-field="end" inputmode="numeric" maxlength="6" placeholder="结束" value="${escapeHtml(seg.end)}">
                <button class="${C.btn}" data-idx="${i}" data-del="1" title="删除">✕</button>
            </div>`).join('');

        contentEl.innerHTML = `
            <div class="${C.picked}">📌 [${typeLabel}] ${urlName}</div>
            <div class="${C.secTitle}"><span class="${C.secTxt}">── 基础文件名 ──</span></div>
            <div class="${C.fileRow}">
                <textarea class="${C.fileInput}" id="base-name" rows="2" placeholder="基础文件名">${escapeHtml(state.fileName)}</textarea>
            </div>
            <div class="${C.secTitle}"><span class="${C.secTxt}">── 时间段（一条=一次下载）──</span></div>
            <div class="${C.segList}">${segHtml}</div>
            <div class="${C.btnRow}" style="justify-content:center;">
                <button class="${C.btn}" id="add-seg">＋ 添加时间段</button>
            </div>
        `;

        const bn = contentEl.querySelector('#base-name');
        bn.addEventListener('input', () => {
            state.fileName = bn.value;
            bn.style.height = '0px';
            bn.style.height = Math.min(bn.scrollHeight, 80) + 'px';
        });
        bn.style.height = '0px';
        bn.style.height = Math.min(bn.scrollHeight, 80) + 'px';

        contentEl.querySelectorAll('.' + C.timeInput).forEach(inp => {
            inp.addEventListener('input', () => {
                inp.value = inp.value.replace(/\D/g, '').slice(0, 6);
                const idx = parseInt(inp.dataset.idx, 10);
                state.segments[idx][inp.dataset.field] = inp.value;
            });
        });

        contentEl.querySelectorAll('[data-del]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.idx, 10);
                state.segments.splice(idx, 1);
                if (state.segments.length === 0) state.segments = [{ start: '', end: '' }];
                renderTab2();
            });
        });

        contentEl.querySelector('#add-seg').addEventListener('click', () => {
            state.segments.push({ start: '', end: '' });
            renderTab2();
        });

        contentEl.querySelector('.' + C.picked).addEventListener('click', () => switchTab(0));
    }

    function renderTab3() {
        if (!state.selectedUrl) {
            contentEl.innerHTML = `<div class="${C.warn}">⚠️ 请先在嗅探 tab 选择一个视频</div>`;
            return;
        }

        const type = getSelectedType();
        const typeLabel = type === 'mp4' ? 'MP4 (curl)' : 'M3U8 (N_m3u8DL-CLI)';
        const urlName = escapeHtml((state.selectedUrl.split('/').pop().split('?')[0]) || state.selectedUrl);

        const txt = buildBatchText();
        const bat = buildBatText();

        contentEl.innerHTML = `
            <div class="${C.summary}">
                <div class="${C.sumLink}">📌 ${urlName}</div>
                <div class="${C.sumLine}">🔧 工具: ${typeLabel}</div>
                <div class="${C.sumLine}">🧵 命令条数: ${txt.split('\n').filter(l => l.trim()).length}</div>
            </div>
            <div class="${C.prevTitle}">▶ 命令预览（每行一条，共 ${txt.split('\n').filter(l => l.trim()).length} 条）</div>
            <textarea class="${C.cmdBox}"></textarea>
            <div class="${C.btnRow}">
                <button class="${C.btn} ${C.btnPrimary}" id="copy-btn">📋 复制命令</button>
                <button class="${C.btn}" id="download-btn">💾 下载 .txt</button>
                <button class="${C.btn}" id="download-bat">⚙️ 下载 .bat</button>
            </div>
        `;

        const tb = contentEl.querySelector('.' + C.cmdBox);
        tb.value = txt;

        tb.addEventListener('input', () => {
            state.customCommand = tb.value;
        });

        contentEl.querySelector('#copy-btn').addEventListener('click', () => {
            copyToClipboard(tb.value.trim() ? tb.value : txt).then(ok => {
                showToast(ok ? '已复制到剪贴板' : '复制失败');
            });
        });

        contentEl.querySelector('#download-btn').addEventListener('click', () => {
            const content = tb.value.trim() ? tb.value : txt;
            downloadTxt(content, safeName(state.fileName || 'batch') + '.txt');
        });

        contentEl.querySelector('#download-bat').addEventListener('click', () => {
            downloadTxt(bat, safeName(state.fileName || 'batch') + '.bat');
        });
    }

    function run() {
        state.fileName = safeName(document.title);
        startSniffer();

        if (window.self === window.top) {
            window.addEventListener('message', (ev) => {
                if (ev.data && ev.data[_MSG_KEY]) {
                    if (ev.data.referer) state.referer = ev.data.referer;
                    handleVideoFound(ev.data.url, ev.data.type);
                }
            }, true);
        }

        initPanel();
        startWatchdog();
    }

    function startWatchdog() {
        setInterval(() => {
            const host = document.getElementById(_hostId);
            if (!host || !host.isConnected || !shadowRoot) {
                shadowRoot = null;
                rootEl = null;
                contentEl = null;
                statusEl = null;
                restoreBtnEl = null;
                initPanel();
            }
        }, 2000);
    }

    function tryRun() {
        if (document.body) {
            run();
            return true;
        }
        return false;
    }

    if (!tryRun()) {
        const ob = new MutationObserver(() => {
            if (tryRun()) ob.disconnect();
        });
        ob.observe(document.documentElement, { childList: true, subtree: true });
        setInterval(() => { tryRun(); }, 1500);
    }
})();