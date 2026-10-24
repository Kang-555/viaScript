// ==UserScript==
// @name         N_m3u8DL-RE 批量收集生成器
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  按先后顺序收集页面多个m3u8/mp4，批量导出txt，自动标题+数字后缀
// @match        *://*/*
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_webRequest
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isAndroid = /Android/i.test(navigator.userAgent);

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
        itemName: _tag + '-in',
        itemCopy: _tag + '-ico',
        itemDl: _tag + '-id',
        itemDel: _tag + '-idel',
        empty: _tag + '-es',
        status: _tag + '-sb',
        secTitle: _tag + '-st',
        secTxt: _tag + '-stt',
        fileRow: _tag + '-fr',
        fileInput: _tag + '-fi',
        warn: _tag + '-wn',
        summary: _tag + '-sm',
        sumLine: _tag + '-sml',
        cmdBox: _tag + '-cx',
        toast: _tag + '-tt',
        restoreBtn: _tag + '-rb',
        restoreShow: _tag + '-rb-s',
        btnPaused: _tag + '-b-w',
    };

    const state = {
        sniffedUrls: [],
        sniffedSet: new Set(),
        referer: '',
        visitedRes: new Set(),
        currentTab: 0,
        baseName: '',
        paused: false,
    };

    const M3U8_REGEX = /\.m3u8($|\?)|application\/.*mpegurl/i;
    const MP4_REGEX = /\.mp4(\?|$)/i;

    function detectType(url, contentType) {
        if (MP4_REGEX.test(url)) return 'mp4';
        if (M3U8_REGEX.test(url)) return 'm3u8';
        if (contentType) {
            if (/video\/mp4/i.test(contentType)) return 'mp4';
            if (/mpegurl/i.test(contentType)) return 'm3u8';
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
        if (state.paused) return;
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

    function processBaseName(base) {
        let name = String(base || '').trim();
        if (/《([^》]+)》/.test(name)) {
            name = name.match(/《([^》]+)》/)[1];
        } else {
            name = name.replace(/[-_][0-9]+$/, '');
        }
        return safeName(name);
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function buildSingleCommand(item, index, fname, dirPath) {
        const url = item.url;
        const type = item.type;
        const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
        const ref = state.referer || location.href;

        if (type === 'mp4') {
            const parts = [
                'curl -L "' + url + '"',
                '-H "User-Agent: ' + ua + '"',
                '-H "Referer: ' + ref + '"',
                '--connect-timeout 15',
                '--retry 3',
                '--retry-delay 2',
                '-o "' + dirPath + '/' + fname + '.mp4"'
            ];
            return parts.join(' \\\n  ');
        }

        const parts = [
            '~/test/N_m3u8DL-RE "' + url + '"',
            '-H "User-Agent: ' + ua + '"',
            '-H "Referer: ' + ref + '"',
            '--thread-count 8',
            '--download-retry-count 5',
            '--log-level error',
            '--save-dir "' + dirPath + '"',
            '--save-name "' + fname + '"'
        ];
        return parts.join(' ');
    }

    function buildBatchText() {
        const base = processBaseName(state.baseName || document.title);
        const dirPath = '/sdcard/Download/' + base;
        const lines = [];
        lines.push('mkdir -p "' + dirPath + '"');
        state.sniffedUrls.forEach((it, idx) => {
            const fname = base + '_' + (idx + 1);
            lines.push('# ===== 第' + (idx + 1) + '条 =====');
            lines.push(buildSingleCommand(it, idx, fname, dirPath));
            lines.push('');
        });
        return lines.join('\n');
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
    .${C.btn}.${C.btnPaused}{background:#ff9800;color:#000;border-color:#ff9800;}
    .${C.btnRow}{display:flex;gap:8px;padding:0 8px;margin-top:8px;}
    .${C.btnRow} .${C.btn}{flex:1;}
    .${C.manualRow}{padding:0 8px 6px;display:flex;gap:6px;flex-wrap:wrap;}
    .${C.divider}{height:1px;background:rgba(255,255,255,0.06);margin:4px 0;}
    .${C.list}{list-style:none;margin:0;padding:0;}
    .${C.item}{padding:8px 8px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:6px;-webkit-tap-highlight-color:rgba(76,175,80,0.2);}
    .${C.itemName}{font-weight:bold;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;}
    .${C.itemCopy}{background:rgba(76,175,80,0.25);border:1px solid #4caf50;color:#4caf50;font-size:10px;padding:2px 4px;border-radius:3px;cursor:pointer;flex-shrink:0;-webkit-tap-highlight-color:transparent;line-height:1.2;}
    .${C.itemDl}{background:rgba(76,175,80,0.35);border:1px solid #4caf50;color:#4caf50;font-size:10px;padding:2px 4px;border-radius:3px;cursor:pointer;flex-shrink:0;-webkit-tap-highlight-color:transparent;line-height:1.2;}
    .${C.itemDel}{background:rgba(244,67,54,0.35);border:1px solid #f44336;color:#f44336;font-size:10px;padding:2px 4px;border-radius:3px;cursor:pointer;flex-shrink:0;-webkit-tap-highlight-color:transparent;line-height:1.2;}
    .${C.empty}{text-align:center;padding:16px;color:#666;}
    .${C.status}{padding:4px 8px;border-top:1px solid rgba(255,255,255,0.06);color:#aaa;font-size:10px;flex-shrink:0;}
    .${C.secTitle}{padding:6px 8px;color:#888;font-size:10px;border-bottom:1px solid rgba(255,255,255,0.06);margin-top:4px;display:flex;align-items:center;justify-content:space-between;}
    .${C.secTxt}{color:#888;}
    .${C.fileRow}{padding:4px 8px 8px;}
    .${C.fileInput}{width:100%;padding:6px;background:#0f3460;color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:3px;font-size:12px;outline:none;box-sizing:border-box;resize:none;min-height:30px;max-height:80px;overflow-y:auto;line-height:1.4;white-space:pre-wrap;word-break:break-all;}
    .${C.fileInput}:focus{border-color:#4caf50;}
    .${C.warn}{text-align:center;padding:16px;color:#ff9800;font-size:11px;}
    .${C.summary}{padding:6px 8px;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.06);line-height:1.7;}
    .${C.sumLine}{color:#aaa;}
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
                <button class="${C.tabBtn} ${C.tabBtnActive}" data-tab="0">嗅探收集</button>
                <button class="${C.tabBtn}" data-tab="1">批量生成</button>
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
        if (state.currentTab === 0) renderTabCollect();
        else renderTabBatch();
    }

    function renderStatus() {
        if (!statusEl) return;
        const statusText = state.paused ? '已暂停' : '嗅探中';
        statusEl.textContent = `共 ${state.sniffedUrls.length} 个 | ${statusText}...`;
    }

    function getSnifferListEl() {
        return contentEl.querySelector('.' + C.list);
    }

    function getEmptyStateEl() {
        return contentEl.querySelector('.' + C.empty);
    }

    function renderTabCollect() {
        const items = state.sniffedUrls;
        let html = `
            <div class="${C.manualRow}">
                <button class="${C.btn}" id="manual-paste">手动粘贴</button>
                <button class="${C.btn} ${state.paused ? C.btnPaused : ''}" id="toggle-pause">${state.paused ? '继续嗅探' : '暂停嗅探'}</button>
                <button class="${C.btn}" id="clear-all">清空列表</button>
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
            const ul = contentEl.querySelector('.' + C.list);
            items.forEach((item, i) => {
                ul.appendChild(createSnifferItem(item, i));
            });
        }
        bindCollectEvents();
    }

    function triggerDownload(url, filename) {
        showToast('触发下载...');
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener';
        if (isIOS) a.target = '_blank';
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
        const li = document.createElement('li');
        li.className = C.item;
        li.dataset.idx = idx;
        li.dataset.url = url;
        li.title = url;
        const typeLabel = type === 'mp4' ? '🎬' : '📺';
        li.innerHTML = `
            <span class="${C.itemName}">${typeLabel} [${idx + 1}] ${name}</span>
            <button class="${C.itemDl}" title="直接下载">⬇</button>
            <button class="${C.itemCopy}" title="复制链接">复制</button>
            <button class="${C.itemDel}" title="移除这条">✕</button>
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
        li.querySelector('.' + C.itemDel).addEventListener('click', (e) => {
            e.stopPropagation();
            const key = type + '::' + url.split('?')[0];
            state.sniffedSet.delete(key);
            state.sniffedUrls.splice(idx, 1);
            renderTabCollect();
            renderStatus();
        });
        return li;
    }

    function appendSniffedItem() {
        if (state.currentTab !== 0) return;
        const ul = getSnifferListEl();
        if (!ul) {
            renderTabCollect();
            renderStatus();
            return;
        }
        const empty = getEmptyStateEl();
        if (empty) empty.remove();
        const last = state.sniffedUrls[state.sniffedUrls.length - 1];
        ul.appendChild(createSnifferItem(last, state.sniffedUrls.length - 1));
        renderStatus();
    }

    function bindCollectEvents() {
        contentEl.querySelector('#manual-paste')?.addEventListener('click', () => {
            const url = prompt('粘贴视频链接 (m3u8/mp4)：');
            if (url && url.trim()) {
                const type = detectType(url.trim(), '');
                if (type) {
                    handleVideoFound(url.trim(), type);
                    showToast('已加入列表');
                } else {
                    showToast('无法识别的链接格式');
                }
            }
        });
        contentEl.querySelector('#toggle-pause')?.addEventListener('click', () => {
            state.paused = !state.paused;
            renderTabCollect();
            renderStatus();
            showToast(state.paused ? '嗅探已暂停' : '嗅探已继续');
        });
        contentEl.querySelector('#clear-all')?.addEventListener('click', () => {
            state.sniffedUrls = [];
            state.sniffedSet.clear();
            renderTabCollect();
            renderStatus();
            showToast('已清空');
        });
    }

    function renderTabBatch() {
        if (state.sniffedUrls.length === 0) {
            contentEl.innerHTML = `<div class="${C.warn}">⚠️ 嗅探列表为空，请先收集视频</div>`;
            return;
        }
        if (!state.baseName) state.baseName = safeName(document.title);
        const previewText = buildBatchText();

        contentEl.innerHTML = `
            <div class="${C.summary}">
                <div class="${C.sumLine}">📦 共 ${state.sniffedUrls.length} 条，按嗅探先后排序</div>
            </div>
            <div class="${C.secTitle}"><span class="${C.secTxt}">基础文件名（自动加 _1 _2 …）</span></div>
            <div class="${C.fileRow}">
                <textarea class="${C.fileInput}" id="base-name">${escapeHtml(state.baseName)}</textarea>
            </div>
            <div class="${C.secTitle}"><span class="${C.secTxt}">批量命令预览</span></div>
            <textarea class="${C.cmdBox}" readonly>${escapeHtml(previewText)}</textarea>
            <div class="${C.btnRow}">
                <button class="${C.btn} ${C.btnPrimary}" id="copy-batch">📋 复制全部</button>
                <button class="${C.btn}" id="download-batch">💾 导出 batch.txt</button>
            </div>
        `;
        const baseInput = contentEl.querySelector('#base-name');
        baseInput.addEventListener('input', () => {
            state.baseName = baseInput.value;
            renderTabBatch();
        });
        contentEl.querySelector('#copy-batch').addEventListener('click', () => {
            const txt = buildBatchText();
            copyToClipboard(txt).then(ok => showToast(ok ? '批量命令已复制' : '复制失败'));
        });
        contentEl.querySelector('#download-batch').addEventListener('click', () => {
            const txt = buildBatchText();
            downloadTxt(txt, 'batch.txt');
        });
    }

    function run() {
        state.baseName = safeName(document.title);
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