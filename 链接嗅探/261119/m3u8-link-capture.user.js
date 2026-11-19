// ==UserScript==
// @name         M3U8 链接捕获器
// @namespace    local.m3u8.capture
// @version      1.0
// @description  嗅探网页中的 m3u8/mpd 链接，一键复制或生成 N_m3u8DL-RE 命令。纯本地，不上传任何数据。
// @author       WorkBuddy
// @match        *://*/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const MAX = 200;
  const links = new Map();

  function add(raw) {
    if (!raw || typeof raw !== 'string' || !/\.m3u8|\.mpd/i.test(raw)) return;
    let url;
    try { url = new URL(raw, location.href).href; } catch (e) { return; }
    if (!/^https?:/.test(url) || !/\.m3u8|\.mpd/i.test(url)) return;
    if (!links.has(url) && links.size < MAX) {
      links.set(url, Date.now());
      render();
    }
  }

  // 1) hook fetch（需在 document-start 注入，才能捕获播放器初始化请求）
  try {
    const origFetch = w.fetch;
    if (origFetch) {
      w.fetch = function (input) {
        try {
          const u = typeof input === 'string' ? input : (input && input.url);
          if (u) add(u);
        } catch (e) {}
        return origFetch.apply(this, arguments);
      };
    }
  } catch (e) {}

  // 2) hook XHR
  try {
    const origOpen = w.XMLHttpRequest.prototype.open;
    w.XMLHttpRequest.prototype.open = function () {
      try { add(String(arguments[1] || '')); } catch (e) {}
      return origOpen.apply(this, arguments);
    };
  } catch (e) {}

  // 3) 扫描 Performance 资源表，兜住注入前已发出 / 未走 fetch 的请求
  setInterval(function () {
    try {
      const entries = (w.performance || performance).getEntriesByType('resource');
      for (let i = 0; i < entries.length; i++) add(entries[i].name);
    } catch (e) {}
    try {
      document.querySelectorAll('video[src], source[src]').forEach(function (el) {
        add(el.getAttribute('src'));
      });
    } catch (e) {}
  }, 1500);

  function copy(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text, 'text');
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('已复制');
  }

  function command(url) {
    return 'N_m3u8DL-RE "' + url + '" --auto-select'
      + ' -H "Referer: ' + location.origin + '/"'
      + ' -H "User-Agent: ' + navigator.userAgent.replace(/"/g, '') + '"';
  }

  let toastTimer;
  function toast(msg) {
    let el = document.getElementById('__m3u8_toast');
    if (!el) {
      el = document.createElement('div');
      el.id = '__m3u8_toast';
      el.style.cssText = 'position:fixed;bottom:70px;right:16px;z-index:2147483647;'
        + 'background:#1f2937;color:#fff;padding:6px 12px;border-radius:6px;font:13px sans-serif';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.display = 'none'; }, 1200);
  }

  let panel, list, badge;
  function build() {
    badge = document.createElement('div');
    badge.id = '__m3u8_badge';
    badge.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483646;'
      + 'background:#2563eb;color:#fff;border-radius:20px;padding:8px 14px;'
      + 'font:13px/1.2 sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2)';
    badge.textContent = 'm3u8: 0';
    badge.onclick = function () {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    };
    document.body.appendChild(badge);

    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;bottom:56px;right:16px;z-index:2147483646;'
      + 'width:min(520px,90vw);max-height:340px;overflow:auto;display:none;'
      + 'background:#fff;color:#111;border:1px solid #d1d5db;border-radius:8px;'
      + 'box-shadow:0 4px 20px rgba(0,0,0,.18);padding:10px;font:12px/1.5 sans-serif';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-weight:600';
    head.innerHTML = '<span>M3U8 链接（' + location.hostname + '）</span>';
    const clear = document.createElement('button');
    clear.textContent = '清空';
    clear.style.cssText = 'border:1px solid #d1d5db;background:#f9fafb;border-radius:4px;cursor:pointer;padding:2px 8px';
    clear.onclick = function () { links.clear(); render(); };
    head.appendChild(clear);
    panel.appendChild(head);

    list = document.createElement('div');
    panel.appendChild(list);
    document.body.appendChild(panel);
  }

  function render() {
    if (!badge) return;
    badge.textContent = 'm3u8: ' + links.size;
    list.innerHTML = '';
    if (!links.size) {
      list.innerHTML = '<div style="color:#6b7280">暂无。先播放一下视频，或开启自动播放后再看。</div>';
      return;
    }
    Array.from(links.keys()).forEach(function (url) {
      const row = document.createElement('div');
      row.style.cssText = 'border-top:1px solid #eee;padding:6px 0;word-break:break-all';
      const text = document.createElement('div');
      text.textContent = url.length > 160 ? url.slice(0, 160) + '…' : url;
      text.style.cssText = 'color:#374151;margin-bottom:4px';
      row.appendChild(text);

      const b1 = document.createElement('button');
      b1.textContent = '复制链接';
      b1.onclick = function () { copy(url); };
      const b2 = document.createElement('button');
      b2.textContent = '复制下载命令';
      b2.onclick = function () { copy(command(url)); };
      [b1, b2].forEach(function (b) {
        b.style.cssText = 'margin-right:6px;border:1px solid #d1d5db;background:#f9fafb;'
          + 'border-radius:4px;cursor:pointer;padding:2px 8px;font:12px sans-serif';
        row.appendChild(b);
      });
      list.appendChild(row);
    });
  }

  function init() {
    if (!document.body) { setTimeout(init, 50); return; }
    build();
    render();
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('显示/隐藏 M3U8 捕获面板', function () { badge.click(); });
    }
  }
  init();
})();
