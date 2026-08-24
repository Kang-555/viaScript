// ==UserScript==
// @name         新标签预览
// @namespace    http://tampermonkey.net/
// @version      2.5
// @description  嗅探 m3u8/mp4 视频资源，点击即可在新标签页预览播放
// @license      MIT
// @match        *://*/*
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==


(function() {
    'use strict';

    // ==========================================
    // 1. 全局配置
    // ==========================================
    const Config = {
        scanInterval: 2000,
        uiId: 'gm-sniffer-v23-ts',
        hlsJsUrl: 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js',
        colors: {
            primary: window.self === window.top ? '#4caf50' : '#e91e63',
            background: 'rgba(0, 0, 0, 0.9)',
            text: '#ffffff'
        }
    };

    // ==========================================
    // 1.1 HlsLoader：预加载并缓存 hls.js（规避 blob 沙盒限制）
    // ==========================================
    const HlsLoader = {
        _promise: null,
        _code: '',
        _loaded: false,

        load() {
            if (this._loaded) return Promise.resolve(this._code);
            if (this._promise) return this._promise;
            this._promise = new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: Config.hlsJsUrl,
                    responseType: 'text',
                    timeout: 15000,
                    onload: (res) => {
                        if (res.status >= 200 && res.status < 300 && res.response) {
                            this._code = res.response;
                            this._loaded = true;
                        }
                        resolve(this._code);
                    },
                    onerror: () => resolve(this._code),
                    ontimeout: () => resolve(this._code)
                });
            });
            return this._promise;
        },

        get code() { return this._code; },
        get loaded() { return this._loaded; }
    };
    HlsLoader.load();

    // ==========================================
    // 2. 工具函数库
    // ==========================================
    const Utils = {
        request: (url, onProgress = null) => {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    responseType: 'text',
                    headers: { 'Referer': location.href, 'Origin': location.origin },
                    timeout: 30000,
                    onprogress: (evt) => {
                        if (onProgress) onProgress(evt.loaded, evt.total);
                    },
                    onload: (res) => {
                        if (res.status >= 200 && res.status < 300) {
                            resolve(res.response);
                        } else reject(new Error(`HTTP Error ${res.status}`));
                    },
                    onerror: (err) => reject(err),
                    ontimeout: () => reject(new Error('Timeout'))
                });
            });
        },

        createElement: (tag, attrs = {}, children = []) => {
            const element = document.createElement(tag);
            for (const [key, value] of Object.entries(attrs)) {
                if (key === 'style' && typeof value === 'object') Object.assign(element.style, value);
                else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.substring(2).toLowerCase(), value);
                else element.setAttribute(key, value);
            }
            const childList = Array.isArray(children) ? children : [children];
            childList.forEach(child => {
                if (child instanceof Node) element.appendChild(child);
                else if (child !== null && child !== undefined) element.appendChild(document.createTextNode(String(child)));
            });
            return element;
        },

        getFilename: (url) => {
            const cleanUrl = url.split('?')[0];
            let name = cleanUrl.split('/').pop();
            if (!name || name.trim() === '' || name === '/') name = `video_${Date.now()}`;
            return decodeURIComponent(name);
        },

        resolveUrl: (baseUrl, relativeUrl) => {
            if (relativeUrl.startsWith('http')) return relativeUrl;
            if (relativeUrl.startsWith('/')) {
                const u = new URL(baseUrl);
                return u.origin + relativeUrl;
            }
            const path = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
            return path + relativeUrl;
        },

        copyToClipboard: (text) => {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                return navigator.clipboard.writeText(text);
            }
            return new Promise((resolve, reject) => {
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                try {
                    document.execCommand('copy');
                    resolve();
                } catch (e) {
                    reject(e);
                }
                textarea.remove();
            });
        }
    };

    // ==========================================
    // 3. 预览页面：在新标签页打开 HLS 播放器
    // ==========================================
    const openPreviewPage = async (url, type, extraInfo = {}) => {
        const safeTitle = (document.title || 'video').replace(/[\/\\:*?"<>|]/g, ' ').trim();
        await HlsLoader.load();
        const hlsCode = HlsLoader.code.replace(/<\/script>/gi, '<\\/script>');

        // 修复：先打开空白标签，再写入内容，避免白屏
        const win = window.open('', '_blank');
        if (!win) {
            alert('无法打开新标签页，请检查浏览器弹窗拦截设置');
            return;
        }

        if (type === 'm3u8') {
            const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>M3U8 预览 - ${safeTitle}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;min-height:100vh}
body{font-family:system-ui,-apple-system,sans-serif;font-size:14px;background:#1a1a2e;color:#eee;-webkit-text-size-adjust:100%}
video{display:block;width:100vw;height:auto;background:#000;line-height:0}
.overlay{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,0.85);color:#fff;z-index:9998}
.overlay.hidden{display:none}
.spinner{width:36px;height:36px;border:3px solid #333;border-top-color:#4caf50;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:14px}
@keyframes spin{to{transform:rotate(360deg)}}
.tap-icon{width:70px;height:70px;border-radius:50%;background:rgba(76,175,80,0.9);display:flex;align-items:center;justify-content:center;margin-bottom:16px;box-shadow:0 4px 20px rgba(0,0,0,0.4)}
.tap-icon svg{width:28px;height:28px;fill:#fff;margin-left:4px}
.tap-text{font-size:16px;font-weight:500}
.error{padding:40px;text-align:center;color:#ff6b6b}
.error a{color:#2196F3;text-decoration:underline}
.header{padding:12px;background:#16213e}
.header h2{color:#4caf50;font-size:16px}
.info{padding:12px;background:#1a1a2e;display:grid;grid-template-columns:1fr;gap:8px}
@media(min-width:600px){.info{grid-template-columns:1fr 1fr}}
.info p{margin:4px 0;word-break:break-all}
.label{color:#888}
.value{color:#4caf50;font-weight:bold}
.encrypt-yes{color:#ff6b6b}
.encrypt-no{color:#4caf50}
a{color:#2196F3}
.back-btn{position:fixed;top:12px;right:12px;padding:6px 14px;background:rgba(0,0,0,0.6);color:#fff;border:none;border-radius:4px;cursor:pointer;z-index:9999;font-size:12px;backdrop-filter:blur(5px)}
</style>
</head>
<body>
<video id="player" controls playsinline webkit-playsinline></video>
<div id="overlay" class="overlay">
  <div class="spinner"></div>
  <div id="overlayText">视频加载中...</div>
</div>
<button class="back-btn" onclick="window.close()">关闭</button>
<div class="header"><h2>M3U8 预览</h2></div>
<div class="info">
<div><span class="label">原始地址：</span><br><a target="_blank" href="${url}">${url}</a></div>
<div><span class="label">加密状态：</span><br>${extraInfo.encrypt ? '<span class="encrypt-yes">AES-128 加密</span>' : '<span class="encrypt-no">未加密</span>'}</div>
<div><span class="label">分片总数：</span><br><span class="value">${extraInfo.segmentCount ?? '—'}</span></div>
<div><span class="label">总时长：</span><br><span class="value">${extraInfo.duration ? extraInfo.duration.toFixed(1) + ' 秒' : '—'}</span></div>
</div>
<script>${hlsCode}</script>
<script>
(function(){
  var video = document.getElementById('player');
  var overlay = document.getElementById('overlay');
  var overlayText = document.getElementById('overlayText');

  function hideOverlay(){ overlay.classList.add('hidden'); }
  function showTap(){
    overlay.innerHTML = '<div class="tap-icon"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div><div class="tap-text">点击播放</div>';
    overlay.classList.remove('hidden');
    overlay.addEventListener('click', function(){
      hideOverlay();
      video.play().catch(function(){});
    }, {once:true});
  }
  function showError(msg){
    overlay.innerHTML = '<div class="error">' + msg + '</div>';
    overlay.classList.remove('hidden');
  }

  video.addEventListener('playing', hideOverlay);
  video.addEventListener('error', function(){
    hideOverlay();
    showError('视频加载失败，<a href="${url}" target="_blank">点击查看原始地址</a>');
  });
  video.addEventListener('autoplayfailed', showTap);

  var hasHls = typeof Hls !== 'undefined' && Hls.isSupported();
  var hls = null;

  function tryAutoPlay(){
    video.play().then(function(){
      hideOverlay();
    }).catch(function(){
      showTap();
    });
  }

  if (hasHls) {
    hls = new Hls();
    hls.loadSource(${JSON.stringify(url)});
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, function(){
      tryAutoPlay();
      setTimeout(function(){
        if (hls) {
          hls.destroy();
          hls = new Hls();
          hls.loadSource(${JSON.stringify(url)});
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, function(){ video.play().catch(function(){}); });
        }
      }, 800);
    });
    hls.on(Hls.Events.ERROR, function(evt, data){
      if (data.fatal) {
        hls.destroy();
        video.src = ${JSON.stringify(url)};
        tryAutoPlay();
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = ${JSON.stringify(url)};
    tryAutoPlay();
    video.addEventListener('loadeddata', function(){
      setTimeout(function(){ video.load(); video.play().catch(function(){}); }, 800);
    }, {once:true});
  } else {
    hideOverlay();
    showError('当前浏览器不支持 HLS 播放，请使用支持 HLS 的浏览器');
  }
})();
</script>
</body>
</html>`;
            // 直接写入新窗口，避免 Blob URL 加载时序问题
            win.document.open();
            win.document.write(html);
            win.document.close();
        } else {
            const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>视频预览 - ${safeTitle}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;min-height:100vh}
body{font-family:system-ui,-apple-system,sans-serif;font-size:14px;background:#1a1a2e;color:#eee;-webkit-text-size-adjust:100%}
video{display:block;width:100vw;height:auto;background:#000;line-height:0}
.overlay{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,0.85);color:#fff;z-index:9998}
.overlay.hidden{display:none}
.spinner{width:36px;height:36px;border:3px solid #333;border-top-color:#4caf50;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:14px}
@keyframes spin{to{transform:rotate(360deg)}}
.tap-icon{width:70px;height:70px;border-radius:50%;background:rgba(76,175,80,0.9);display:flex;align-items:center;justify-content:center;margin-bottom:16px;box-shadow:0 4px 20px rgba(0,0,0,0.4)}
.tap-icon svg{width:28px;height:28px;fill:#fff;margin-left:4px}
.tap-text{font-size:16px;font-weight:500}
.error{padding:40px;text-align:center;color:#ff6b6b}
.error a{color:#2196F3;text-decoration:underline}
.header{padding:12px;background:#16213e}
.header h2{color:#4caf50;font-size:16px}
.info{padding:12px;background:#1a1a2e}
.info p{margin:4px 0;word-break:break-all}
.label{color:#888}
a{color:#2196F3}
.back-btn{position:fixed;top:12px;right:12px;padding:6px 14px;background:rgba(0,0,0,0.6);color:#fff;border:none;border-radius:4px;cursor:pointer;z-index:9999;font-size:12px;backdrop-filter:blur(5px)}
</style>
</head>
<body>
<video id="player" controls playsinline webkit-playsinline src="${url}"></video>
<div id="overlay" class="overlay">
  <div class="spinner"></div>
  <div>视频加载中...</div>
</div>
<button class="back-btn" onclick="window.close()">关闭</button>
<div class="header"><h2>视频预览</h2></div>
<div class="info">
<p><span class="label">原始地址：</span><br><a target="_blank" href="${url}">${url}</a></p>
</div>
<script>
(function(){
  var video = document.getElementById('player');
  var overlay = document.getElementById('overlay');

  function hideOverlay(){ overlay.classList.add('hidden'); }
  function showTap(){
    overlay.innerHTML = '<div class="tap-icon"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div><div class="tap-text">点击播放</div>';
    overlay.classList.remove('hidden');
    overlay.addEventListener('click', function(){
      hideOverlay();
      video.play().catch(function(){});
    }, {once:true});
  }
  function showError(msg){
    overlay.innerHTML = '<div class="error">' + msg + '</div>';
    overlay.classList.remove('hidden');
  }

  video.addEventListener('playing', hideOverlay);
  video.addEventListener('error', function(){
    hideOverlay();
    showError('视频加载失败，<a href="${url}" target="_blank">点击查看原始地址</a>');
  });

  video.play().then(function(){
    hideOverlay();
  }).catch(function(){
    showTap();
  });
  video.addEventListener('loadeddata', function(){
    setTimeout(function(){ video.load(); video.play().catch(function(){}); }, 800);
  }, {once:true});
})();
</script>
</body>
</html>`;
            // 直接写入新窗口，避免 Blob URL 加载时序问题
            win.document.open();
            win.document.write(html);
            win.document.close();
        }
    };

    // ==========================================
    // 4. 解析 m3u8（用于预览时显示元信息）
    // ==========================================
    const parseM3u8 = async (url) => {
        let content;
        try {
            content = await Utils.request(url);
        } catch (e) {
            throw new Error('m3u8 请求失败: ' + e.message);
        }

        if (content.includes('#EXT-X-STREAM-INF')) {
            const lines = content.split('\n');
            let bestBandwidth = 0;
            let bestUrl = null;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                    const bandwidth = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) || [0, 0])[1]);
                    const nextLine = lines[i + 1]?.trim();
                    if (nextLine && !nextLine.startsWith('#') && bandwidth > bestBandwidth) {
                        bestBandwidth = bandwidth;
                        bestUrl = Utils.resolveUrl(url, nextLine);
                    }
                }
            }
            if (bestUrl) {
                url = bestUrl;
                content = await Utils.request(url);
            }
        }

        const lines = content.split('\n');
        let segmentCount = 0;
        let totalDuration = 0;
        let encrypted = false;
        let currentInf = 0;

        for (const line of lines) {
            const l = line.trim();
            if (!l) continue;
            if (l.startsWith('#EXTINF:')) {
                currentInf = parseFloat(l.match(/#EXTINF:([\d.]+)/)[1]) || 0;
                totalDuration += currentInf;
            } else if (l.startsWith('#EXT-X-KEY')) {
                if (l.includes('METHOD=AES-128')) encrypted = true;
            } else if (!l.startsWith('#')) {
                segmentCount++;
            }
        }

        return { url, segmentCount, totalDuration, encrypted };
    };

    // ==========================================
    // 5. 事件总线
    // ==========================================
    const Bus = {
        events: {},
        on(event, callback) {
            if (!this.events[event]) this.events[event] = [];
            this.events[event].push(callback);
        },
        emit(event, data) {
            if (this.events[event]) this.events[event].forEach(cb => cb(data));
        }
    };

    // ==========================================
    // 6. 网络嗅探器
    // ==========================================
    class Sniffer {
        constructor() {
            this.seenUrls = new Set();
            this.rules = {
                m3u8: /\.m3u8($|\?)|application\/.*mpegurl/i,
                mp4: /\.mp4($|\?)|video\/mp4/i,
                mov: /\.mov($|\?)|video\/quicktime/i
            };
        }

        start() {
            this.hookFetch();
            this.hookXHR();
            setInterval(() => this.scanPerformance(), Config.scanInterval);
        }

        detect(url, contentType = '') {
            if (!url) return;
            if (url.match(/^data:|^blob:|\.(png|jpg|jpeg|gif|css|js|woff|svg)($|\?)/i)) return;

            const cleanKey = url.split('?')[0];
            if (this.seenUrls.has(cleanKey)) return;

            const typeStr = contentType ? contentType.toLowerCase() : '';

            for (const [type, regex] of Object.entries(this.rules)) {
                if (regex.test(url) || regex.test(typeStr)) {
                    this.seenUrls.add(cleanKey);
                    console.log(`[嗅探] 发现 ${type}: ${url}`);
                    Bus.emit('video-found', { url, type });
                    return;
                }
            }
        }

        hookFetch() {
            const targetWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            const originalFetch = targetWindow.fetch;
            if (!originalFetch) return;
            const self = this;
            targetWindow.fetch = async (...args) => {
                const url = args[0] instanceof Request ? args[0].url : args[0];
                const response = await originalFetch.apply(targetWindow, args);
                try {
                    const clone = response.clone();
                    clone.headers.forEach((val, key) => {
                        if (key.toLowerCase() === 'content-type') self.detect(url, val);
                    });
                } catch (e) { }
                return response;
            };
        }

        hookXHR() {
            const targetWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            const originalXHR = targetWindow.XMLHttpRequest;
            if (!originalXHR) return;
            const self = this;
            class HijackedXHR extends originalXHR {
                open(method, url, ...args) {
                    this._requestUrl = url;
                    super.open(method, url, ...args);
                }
                send(...args) {
                    this.addEventListener('readystatechange', () => {
                        if (this.readyState === 4) {
                            try {
                                const contentType = this.getResponseHeader('content-type');
                                self.detect(this.responseURL || this._requestUrl, contentType);
                            } catch (e) { }
                        }
                    });
                    super.send(...args);
                }
            }
            targetWindow.XMLHttpRequest = HijackedXHR;
        }

        scanPerformance() {
            if (!window.performance) return;
            performance.getEntriesByType('resource').forEach(entry => this.detect(entry.name));
        }
    }

    // ==========================================
    // 7. UI 悬浮面板
    // ==========================================
    class UI {
        constructor() {
            this.root = null;
            this.list = null;
            this.toggleBtn = null;
            this.resources = [];
            this.openIndex = -1;
            this.previewCache = new Map();
            Bus.on('video-found', (data) => {
                if (!this.root) this.init();
                this.addResource(data);
            });
        }

        init() {
            if (document.getElementById(Config.uiId)) return;
            const host = Utils.createElement('div', {
                id: Config.uiId,
                style: { position: 'fixed', bottom: '20px', left: '20px', zIndex: 999999 }
            });
            const shadow = host.attachShadow({ mode: 'open' });

            const style = Utils.createElement('style');
            style.textContent = `
                :host { font-family: system-ui, -apple-system, sans-serif; font-size: 12px; }
                .box {
                    width: 320px; background: ${Config.colors.background}; color: ${Config.colors.text};
                    border: 1px solid ${Config.colors.primary}; border-radius: 8px;
                    backdrop-filter: blur(5px); display: flex; flex-direction: column;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.5);
                }
                .head {
                    padding: 8px 12px; background: rgba(255,255,255,0.08);
                    display: flex; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1);
                    font-weight: bold; color: ${Config.colors.primary};
                }
                .list { max-height: 260px; overflow-y: auto; padding: 4px 0; }
                .item { border-bottom: 1px solid rgba(255,255,255,0.06); }
                .item:last-child { border-bottom: none; }
                .item-head {
                    padding: 8px 12px; cursor: pointer; display: flex; gap: 8px;
                    align-items: center; transition: background 0.15s;
                }
                .item-head:hover { background: rgba(255,255,255,0.05); }
                .tag {
                    background: ${Config.colors.primary}; color: #000;
                    padding: 2px 6px; border-radius: 3px; font-weight: bold; font-size: 10px;
                    flex-shrink: 0;
                }
                .tag.mp4 { background: #2196F3; color: #fff; }
                .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .chevron { transition: transform 0.2s; color: #888; font-size: 10px; }
                .item.open .chevron { transform: rotate(90deg); }
                .item.open .item-head { background: rgba(76,175,80,0.1); }
                .item-body {
                    display: none;
                    padding: 10px 12px;
                    background: rgba(0,0,0,0.35);
                    border-top: 1px solid rgba(255,255,255,0.08);
                }
                .item.open .item-body { display: block; }
                .url-display {
                    margin-bottom: 8px; word-break: break-all;
                    font-size: 10px; color: #666;
                    max-height: 40px; overflow: auto;
                }
                button { border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }
                .btn-row { display: flex; gap: 6px; margin-top: 6px; }
                .btn-primary {
                    flex: 1; background: ${Config.colors.primary}; color: #000;
                    font-weight: bold; padding: 6px 10px;
                }
                .btn-secondary { background: #2196F3; color: #fff; }
                .btn-copy { background: #555; color: white; }
                .empty-tip { padding: 20px; text-align: center; color: #666; }
                .toggle-btn {
                    position: fixed; bottom: 20px; left: 20px; width: 44px; height: 44px;
                    border-radius: 50%; background: ${Config.colors.primary}; color: #000;
                    display: flex; align-items: center; justify-content: center;
                    font-size: 18px; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,0.3);
                    border: none; z-index: 999998;
                }
                .status {
                    font-size: 10px; color: #888; margin-left: auto;
                }
            `;

            const head = Utils.createElement('div', { class: 'head' }, [
                '视频嗅探预览',
                Utils.createElement('span', { class: 'status' }, '')
            ]);
            this.list = Utils.createElement('div', { class: 'list' });
            this.root = Utils.createElement('div', { class: 'box' }, [head, this.list]);

            this.toggleBtn = Utils.createElement('button', { class: 'toggle-btn' }, 'V');
            this.toggleBtn.onclick = () => {
                const isHidden = this.root.style.display === 'none';
                this.root.style.display = isHidden ? 'flex' : 'none';
                this.toggleBtn.textContent = isHidden ? 'V' : 'X';
            };

            shadow.appendChild(style);
            shadow.appendChild(this.root);
            shadow.appendChild(this.toggleBtn);
            (document.body || document.documentElement).appendChild(host);

            this.root.style.display = 'none';
            this.renderList();
        }

        updateStatus(text) {
            const status = this.root?.querySelector('.status');
            if (status) status.textContent = text;
        }

        addResource({ url, type }) {
            const normalizedType = type === 'm3u8' ? 'm3u8' : 'mp4';
            const exists = this.resources.some(r => r.url === url);
            if (exists) return;
            this.resources.unshift({ url, type: normalizedType });
            this.renderList();
        }

        toggleItem(index) {
            this.openIndex = this.openIndex === index ? -1 : index;
            this.renderList();
        }

        copyUrl(url) {
            Utils.copyToClipboard(url).then(() => {
                alert('已复制链接');
            }).catch(() => {
                alert('复制失败');
            });
        }

        async previewResource(item) {
            try {
                if (item.type === 'm3u8') {
                    this.updateStatus('解析 m3u8...');
                    let info = this.previewCache.get(item.url);
                    if (!info) {
                        info = await parseM3u8(item.url);
                        this.previewCache.set(item.url, info);
                    }
                    this.updateStatus('');
                    openPreviewPage(item.url, 'm3u8', {
                        segmentCount: info.segmentCount,
                        duration: info.totalDuration,
                        encrypt: info.encrypted
                    });
                } else {
                    this.updateStatus('');
                    openPreviewPage(item.url, 'mp4', {});
                }
            } catch (err) {
                this.updateStatus('');
                alert('预览失败: ' + err.message);
            }
        }

        renderList() {
            this.list.innerHTML = '';
            if (this.resources.length === 0) {
                this.list.innerHTML = '<div class="empty-tip">暂无资源</div>';
                return;
            }

            this.resources.forEach((item, idx) => {
                item.id = item.id || ('r' + idx + '_' + Math.random().toString(36).slice(2, 6));
                const isOpen = this.openIndex === idx;
                const itemEl = Utils.createElement('div', { class: 'item' + (isOpen ? ' open' : '') });

                const headEl = Utils.createElement('div', { class: 'item-head', onclick: () => this.toggleItem(idx) }, [
                    Utils.createElement('span', { class: 'tag ' + item.type }, item.type.toUpperCase()),
                    Utils.createElement('span', { class: 'name', title: item.url }, Utils.getFilename(item.url)),
                    Utils.createElement('span', { class: 'chevron' }, '>')
                ]);
                itemEl.appendChild(headEl);

                if (isOpen) {
                    const bodyEl = Utils.createElement('div', { class: 'item-body' });

                    bodyEl.appendChild(Utils.createElement('div', { class: 'url-display' }, item.url));

                    const btnRow = Utils.createElement('div', { class: 'btn-row' });
                    const previewBtn = Utils.createElement('button', { class: 'btn-primary' }, '新标签预览');
                    previewBtn.onclick = (e) => { e.stopPropagation(); this.previewResource(item); };
                    const copyBtn = Utils.createElement('button', { class: 'btn-copy' }, '复制');
                    copyBtn.onclick = (e) => { e.stopPropagation(); this.copyUrl(item.url); };
                    btnRow.appendChild(previewBtn);
                    btnRow.appendChild(copyBtn);
                    bodyEl.appendChild(btnRow);

                    itemEl.appendChild(bodyEl);
                }

                this.list.appendChild(itemEl);
            });
        }
    }


    new Sniffer().start();
    new UI();
})();