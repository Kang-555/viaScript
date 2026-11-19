// ==UserScript==
// @name         M3U8 链接捕获器（增强版）
// @namespace    local.m3u8.capture
// @version      2.0
// @description  深度嗅探 m3u8/mp4/mpd/flv 等媒体链接，支持多时间段裁剪 + 一键复制完整 N_m3u8DL-RE 命令
// @author       WorkBuddy
// @match        *://*/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        unsafeWindow
// ==/UserScript==

/**
 * 嗅探增强来源：cat-catch 2.7.4 search.js + Function.prototype.toString 双层伪装
 * 时间段 & 命令生成参考：N_m3u8DL-RE 多段安卓
 */

(function () {
    'use strict';

    // ======================== 基础变量 ========================

    const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const MAX_LINKS = 500;
    const MAX_KEYS = 200;

    const MEDIA_EXTS = new Set(['m3u8', 'm3u', 'mpd', 'mp4', 'mp3', 'flv', 'm4a', 'webm', 'ts', 'key', 'm4s', 'mov', 'wav', 'ogg', 'aac', 'opus']);
    const DATA_URL_RE = /^data:(application|video|audio)\//i;
    const HEX_RE = /^[A-Fa-f0-9]+$/;
    const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
    const M3U8_REGEX = /\.m3u8($|\?)/i;
    const MP4_REGEX = /\.mp4(\?|$)/i;
    const MPD_REGEX = /\.mpd($|\?)/i;

    const state = {
        sniffed: [],       // [{ url, ext, href, source }]
        keys: [],          // [{ key, href, ext }]
        selectedUrl: null, // 当前选中生成命令的链接
        segments: [],      // 时间段 [{ start: "000030", end: "000130" }, ...]
        fileName: '',
        referer: '',
        dedup: new Set(),  // url 去重
        dedupKey: new Set()
    };

    const _MSG_KEY = '__m3u8capture' + Math.random().toString(36).slice(2, 8);
    let hooks = {};

    // ======================== 工具函数 ========================

    function isUrl(str) {
        return typeof str === 'string' && (str.startsWith('http://') || str.startsWith('https://') || str.startsWith('//'));
    }
    function pcol() { return typeof location !== 'undefined' ? location.protocol : 'https:'; }

    function getExt(str) {
        if (typeof str !== 'string') return null;
        let s = str;
        if (s.startsWith('//')) s = pcol() + s;
        let u; try { u = new URL(s); } catch (e) { return null; }
        let ext = u.pathname.split('.');
        if (ext.length === 1) return null;
        ext = ext.pop().toLowerCase().split('?')[0];
        return MEDIA_EXTS.has(ext) ? ext : null;
    }

    function detectType(url, contentType) {
        if (MP4_REGEX.test(url)) return 'mp4';
        if (M3U8_REGEX.test(url)) return 'm3u8';
        if (MPD_REGEX.test(url)) return 'mpd';
        if (contentType) {
            if (/video\/mp4/i.test(contentType)) return 'mp4';
            if (/mpegurl/i.test(contentType)) return 'm3u8';
            if (/dash\+xml/i.test(contentType)) return 'mpd';
        }
        return null;
    }

    function arrayToBase64(data) {
        try {
            const u8 = new Uint8Array(data);
            let binary = '';
            for (let i = 0; i < u8.byteLength; i++) binary += String.fromCharCode(u8[i]);
            return typeof btoa === 'function' ? btoa(binary) : false;
        } catch (e) { return false; }
    }

    function escapeHtml(s) {
        return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function safeName(s) {
        return String(s || 'clip').replace(/[\\/:*?"<>|]/g, '_');
    }
    function toHMS(str) {
        str = String(str || '').replace(/\D/g, '').padStart(6, '0');
        if (str.length !== 6) return null;
        return str.substring(0, 2) + ':' + str.substring(2, 4) + ':' + str.substring(4, 6);
    }

    // m3u8 相对路径补全
    function addBaseUrl(base, text) {
        const reKeyURL = /URI="(.*)"/;
        const lines = text.split('\n');
        let out = '';
        for (const ts of lines) {
            if (ts === '' || ts === ' ') continue;
            if (ts.includes('URI=')) {
                const m = reKeyURL.exec(ts);
                if (m && m[1] && !isUrl(m[1])) ts = ts.replace(reKeyURL, 'URI="' + base + m[1] + '"');
            }
            if (ts[0] !== '#' && !isUrl(ts)) {
                if (ts.startsWith('/')) {
                    const parts = base.split('/');
                    ts = parts[0] + '//' + parts[2] + ts;
                } else { ts = base + ts; }
            }
            out += ts + '\n';
        }
        return out;
    }

    function parseDataM3U8(text) {
        text = text.substring(text.indexOf('/') + 1);
        const mimes = ['vnd.apple.mpegurl', 'x-mpegurl', 'mpegurl'];
        const matched = mimes.find(t => text.toLowerCase().startsWith(t));
        if (!matched) return null;
        const rest = text.slice(matched.length + 1);
        const [prefix, data] = rest.split(/,(.+)/);
        return prefix.toLowerCase() === 'base64' ? atob(data) : rest;
    }

    // ======================== 去重入库 ========================

    function addMedia(url, ext, source, href) {
        if (!url) return;
        // 相对路径补全
        if (typeof url === 'string' && !/^https?:/.test(url)) {
            if (url.startsWith('//')) url = pcol() + url;
            else if (!url.startsWith('blob:') && !url.startsWith('data:')) return;
        }
        const key = (ext || 'unknown') + '::' + url.split('?')[0];
        if (state.dedup.has(key)) return;
        state.dedup.add(key);
        if (state.dedup.size > MAX_LINKS * 2) {
            // 定期清理避免内存膨胀
            const arr = Array.from(state.dedup);
            state.dedup.clear();
            for (let i = Math.floor(arr.length / 2); i < arr.length; i++) state.dedup.add(arr[i]);
        }
        state.sniffed.push({
            url: url,
            ext: ext || getExt(url) || 'm3u8',
            href: href || state.referer || (typeof location !== 'undefined' ? location.href : ''),
            source: source || '',
            time: Date.now()
        });
        render();
    }

    function addKey(data, source, href, ext) {
        let key = data;
        if (data instanceof ArrayBuffer || data instanceof Array || data instanceof Uint8Array) {
            if (data.byteLength === 0 || data.length === 0) return;
            // MP4 ftyp 头误判过滤
            if (ext === 'key' && !(data instanceof Uint8Array)) {
                try { data = new Uint8Array(data); } catch (e) {}
            }
            if (data instanceof Uint8Array) {
                if ((data[4] === 0x73 || data[4] === 0x66) && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) return;
            }
            key = arrayToBase64(data);
            if (key === false) return;
        }
        if (key && typeof key === 'string' && key.startsWith('AAAAAAAAAAAAAAAAAAAA')) return;
        if (!key || state.dedupKey.has(key)) return;
        state.dedupKey.add(key);
        state.keys.push({ key: key, href: href || state.referer || '', ext: ext || 'key', source: source });
        render();
    }

    // ======================== findMedia：递归找媒体 ========================

    function findMedia(data, depth) {
        if (!data) return;
        depth = depth || 0;
        if (data instanceof Array && data.length === 16) {
            const allByte = data.every(v => typeof v === 'number' && v <= 256);
            if (allByte) { addKey(data, 'json'); return; }
        }
        if (data instanceof ArrayBuffer && data.byteLength === 16) {
            addKey(data, 'json'); return;
        }
        for (const k in data) {
            if (!data.hasOwnProperty(k)) continue;
            const v = data[k];
            if (typeof v === 'object' && v !== null) {
                if (v instanceof Array && v.length === 16) {
                    const allByte = v.every(x => typeof x === 'number' && x <= 256);
                    if (allByte) { addKey(v, 'json'); continue; }
                }
                if (depth <= 20) findMedia(v, depth + 1);
                continue;
            }
            if (typeof v === 'string') {
                const t = v.trim();
                if (isUrl(t)) {
                    const ext = getExt(t);
                    if (ext) addMedia(t.startsWith('//') ? pcol() + t : t, ext, 'json');
                    continue;
                }
                if (t.substring(0, 7).toUpperCase() === '#EXTM3U') {
                    toBlobAndEmit(t, 'm3u8'); continue;
                }
                if (DATA_URL_RE.test(t.substring(0, 17))) {
                    const text = parseDataM3U8(t);
                    text && toBlobAndEmit(text, 'm3u8'); continue;
                }
                if (t.toLowerCase().includes('urn:mpeg:dash:schema:mpd')) {
                    toBlobAndEmit(t, 'mpd'); continue;
                }
            }
        }
    }

    function isJSON(s) {
        if (typeof s === 'object' && s !== null) return s;
        if (typeof s !== 'string') return false;
        try { return JSON.parse(s); } catch (e) { return false; }
    }

    function fullM3u8(text) {
        return text.split('\n').some(line => line[0] !== '#' && isUrl(line));
    }

    function toBlobAndEmit(text, ext) {
        try {
            if (ext === 'mpd') {
                const url = URL.createObjectURL(new Blob([new TextEncoder('utf-8').encode(text)]));
                addMedia(url, ext, 'blob'); return;
            }
            const lines = text.split('\n');
            for (let i in lines) {
                if (lines[i][0] === '#') continue;
                if (lines[i].startsWith('//')) lines[i] = pcol() + lines[i];
            }
            text = lines.join('\n');
            if (fullM3u8(text)) {
                const url = URL.createObjectURL(new Blob([new TextEncoder('utf-8').encode(text)]));
                addMedia(url, ext, 'blob'); return;
            }
            // 没完整 URL，需要尝试不同 base
            try {
                const base = w.location.href.split('/'); base.pop();
                const url = URL.createObjectURL(new Blob([new TextEncoder('utf-8').encode(addBaseUrl(base.join('/') + '/', text))]));
                addMedia(url, ext, 'blob');
            } catch (e) { /* 忽略 */ }
        } catch (e) { /* ignore */ }
    }

    // ======================== 原生 API 劫持 ========================

    // 顶层 patch 让 Function.prototype.toString 双重伪装
    try {
        const __origToString = Function.prototype.toString;
        Function.prototype.toString = new Proxy(__origToString, {
            apply: function (target, thisArg, args) {
                if (thisArg && thisArg.__catNativeStr) return thisArg.__catNativeStr;
                return Reflect.apply(target, thisArg, args);
            }
        });
        Function.prototype.toString.__catPatched = true;
    } catch (e) {}

    function registerNativeStr(hooked, orig) {
        try { hooked.__catNativeStr = Function.prototype.toString.call(orig); } catch (e) {}
    }

    // -------- fetch --------
    function hookFetch() {
        const origFetch = w.fetch;
        if (!origFetch || origFetch.__catPatched) return;
        w.fetch = async function (input, init) {
            let response;
            try { response = await origFetch.apply(this, arguments); } catch (e) { throw e; }

            const clone = response.clone();
            const inputUrl = typeof input === 'object' && input ? input.url : input;
            // 1. 请求参数层面嗅探
            if (inputUrl && typeof inputUrl === 'string') {
                const ext = getExt(inputUrl);
                if (ext) addMedia(inputUrl.startsWith('//') ? pcol() + inputUrl : inputUrl, ext, 'fetch');
            }

            // 2. 响应体层面嗅探（clone 后读不影响原 response）
            clone.arrayBuffer().then(function (ab) {
                if (!ab) return;
                if (ab.byteLength === 16) { addKey(ab, 'fetch'); return; }
                let text = new TextDecoder().decode(ab);
                if (!text) return;
                const parsed = isJSON(text);
                if (parsed) { findMedia(parsed); return; }
                if (text.substring(0, 7).toUpperCase() === '#EXTM3U') {
                    const method = init && init.method ? init.method.toUpperCase() : 'GET';
                    if (method !== 'POST') {
                        const src = typeof inputUrl === 'string' ? inputUrl : '';
                        if (src) {
                            const base = src.split('/'); base.pop();
                            toBlobAndEmit(addBaseUrl(base.join('/') + '/', text), 'm3u8');
                        } else { toBlobAndEmit(text, 'm3u8'); }
                        addMedia(src || '', 'm3u8', 'fetch-response');
                    } else { toBlobAndEmit(text, 'm3u8'); }
                    return;
                }
                if (DATA_URL_RE.test(text.substring(0, 17))) {
                    const t = parseDataM3U8(text);
                    t && toBlobAndEmit(t, 'm3u8');
                }
            }).catch(function () {});

            return response;
        };
        registerNativeStr(w.fetch, origFetch);
    }

    // -------- XHR --------
    function hookXHR() {
        if (!w.XMLHttpRequest || !w.XMLHttpRequest.prototype.open || w.XMLHttpRequest.prototype.open.__catPatched) return;
        const origOpen = w.XMLHttpRequest.prototype.open;
        w.XMLHttpRequest.prototype.open = function (method) {
            method = (method || 'GET').toUpperCase();
            const self = this;
            self.addEventListener('load', function () {
                try {
                    if (self.responseType === 'arraybuffer' && self.response && self.response.byteLength) {
                        if (self.response.byteLength === 16 || self.response.byteLength === 32) addKey(self.response, 'xhr');
                        const url = self.responseURL || self._url || '';
                        if (url && url.includes('.ts')) {
                            const ext = getExt(url);
                            if (ext) addMedia(url, ext, 'xhr');
                        }
                        return;
                    }
                    if (typeof self.response === 'object' && self.response !== null) {
                        findMedia(self.response); return;
                    }
                    if (typeof self.response !== 'string' || !self.response) return;

                    const responseURL = self.responseURL || '';
                    // 先 sniff URL 本身
                    if (responseURL) {
                        const ext = getExt(responseURL);
                        if (ext) addMedia(responseURL, ext, 'xhr');
                    }
                    // data URL base64 m3u8
                    if (DATA_URL_RE.test(self.response)) {
                        const t = parseDataM3U8(self.response);
                        t && toBlobAndEmit(t, 'm3u8'); return;
                    }
                    if (DATA_URL_RE.test(responseURL)) {
                        const t = parseDataM3U8(responseURL);
                        t && toBlobAndEmit(t, 'm3u8'); return;
                    }
                    // response 本身就是 URL
                    if (isUrl(self.response)) {
                        const ext = getExt(self.response);
                        if (ext) addMedia(self.response, ext, 'xhr'); return;
                    }
                    const upper = self.response.toUpperCase();
                    if (upper.includes('#EXTM3U')) {
                        if (self.response.substring(0, 7) === '#EXTM3U') {
                            if (method === 'GET' && responseURL) {
                                const base = responseURL.split('/'); base.pop();
                                toBlobAndEmit(addBaseUrl(base.join('/') + '/', self.response), 'm3u8');
                            } else { toBlobAndEmit(self.response, 'm3u8'); }
                            return;
                        }
                        // m3u8 嵌在 JSON 里
                        if (isJSON(self.response)) {
                            findMedia(self.response);
                            if (method === 'GET' && responseURL) addMedia(responseURL, 'json', 'xhr');
                            return;
                        }
                    }
                    const parsed = isJSON(self.response);
                    if (parsed) findMedia(parsed);
                } catch (e) {}
            });
            return origOpen.apply(this, arguments);
        };
        registerNativeStr(w.XMLHttpRequest.prototype.open, origOpen);
    }

    // -------- JSON.parse --------
    function hookJSONParse() {
        const orig = JSON.parse;
        JSON.parse = function () {
            const data = orig.apply(this, arguments);
            findMedia(data);
            return data;
        };
        registerNativeStr(JSON.parse, orig);
    }

    // -------- TextDecoder.decode --------
    function hookTextDecoder() {
        if (typeof w.TextDecoder === 'undefined' || !w.TextDecoder.prototype.decode || w.TextDecoder.prototype.decode.__catPatched) return;
        const orig = w.TextDecoder.prototype.decode;
        w.TextDecoder.prototype.decode = function () {
            const result = orig.apply(this, arguments);
            if (result && (result.startsWith('#EXTM3U') || result.toUpperCase().includes('#EXTM3U'))) {
                toBlobAndEmit(result, 'm3u8');
            }
            return result;
        };
        registerNativeStr(w.TextDecoder.prototype.decode, orig);
    }

    // -------- String --------
    function hookString() {
        const origIndexOf = String.prototype.indexOf;
        String.prototype.indexOf = function (searchValue, fromIndex) {
            const out = origIndexOf.apply(this, arguments);
            if (searchValue === '#EXTM3U' && out !== -1) {
                toBlobAndEmit(this.substring(fromIndex), 'm3u8');
            }
            return out;
        };
        registerNativeStr(String.prototype.indexOf, origIndexOf);

        // fromCharCode 代理 —— 逐字符拼接 m3u8 / 检测 32 位 hex key
        const origFCC = String.fromCharCode;
        let m3u8Buf = '';
        String.fromCharCode = new Proxy(origFCC, {
            apply: function (target, thisArg, args) {
                const data = Reflect.apply(target, thisArg, args);
                if (data.length < 7) return data;
                if (data.substring(0, 7) === '#EXTM3U' || data.includes('#EXTINF:')) {
                    m3u8Buf += data;
                    if (m3u8Buf.includes('#EXT-X-ENDLIST')) {
                        toBlobAndEmit(m3u8Buf.split('#EXT-X-ENDLIST')[0] + '#EXT-X-ENDLIST', 'm3u8');
                        m3u8Buf = '';
                    }
                    return data;
                }
                const key = data.replaceAll('\u0010', '');
                if (key.length === 32 && HEX_RE.test(key)) {
                    addKey(key, 'fromCharCode');
                }
                return data;
            }
        });
        try { String.fromCharCode.__catNativeStr = Function.prototype.toString.call(origFCC); } catch (e) {}
    }

    // -------- Array --------
    function hookArray() {
        const origSlice = Array.prototype.slice;
        Array.prototype.slice = function (start, end) {
            const data = origSlice.apply(this, arguments);
            if (end === 16 && this.length === 32) {
                let allNum = true;
                for (const item of data) { if (typeof item !== 'number' || item > 255) { allNum = false; break; } }
                if (allNum) addKey(data, 'arraySlice');
            }
            return data;
        };
        registerNativeStr(Array.prototype.slice, origSlice);

        const origJoin = Array.prototype.join;
        Array.prototype.join = function () {
            const data = origJoin.apply(this, arguments);
            if (typeof data !== 'string') return data;
            if (data.substring(0, 7).toUpperCase() === '#EXTM3U') {
                toBlobAndEmit(data, 'm3u8');
            }
            if (data.length === 24 && B64_RE.test(data)) addKey(data, 'arrayJoin');
            return data;
        };
        registerNativeStr(Array.prototype.join, origJoin);
    }

    // -------- btoa / atob / escape --------
    function hookBtoaAtob() {
        if (typeof w.btoa === 'function') {
            const orig = w.btoa;
            w.btoa = function (data) {
                const b64 = orig.apply(this, arguments);
                if (b64.length === 24 && b64.substring(22, 24) === '==') addKey(b64, 'btoa');
                if (data && data.substring(0, 7).toUpperCase() === '#EXTM3U') toBlobAndEmit(data, 'm3u8');
                return b64;
            };
            registerNativeStr(w.btoa, orig);
        }
        if (typeof w.atob === 'function') {
            const orig = w.atob;
            w.atob = function (b64) {
                const data = orig.apply(this, arguments);
                if (b64.length === 24 && b64.substring(22, 24) === '==') addKey(b64, 'atob');
                if (data && data.substring(0, 7).toUpperCase() === '#EXTM3U') toBlobAndEmit(data, 'm3u8');
                if (data && data.endsWith('</MPD>')) toBlobAndEmit(data, 'mpd');
                return data;
            };
            registerNativeStr(w.atob, orig);
        }
        if (typeof w.escape === 'function') {
            const orig = w.escape;
            w.escape = function (str) {
                if (str && str.length === 24 && str.substring(22, 24) === '==') addKey(str, 'escape');
                return orig.apply(this, arguments);
            };
            registerNativeStr(w.escape, orig);
        }
    }

    // -------- TypedArray + DataView --------
    function hookTypedArray() {
        ['Uint8Array', 'Uint16Array', 'Uint32Array'].forEach(function (name) {
            if (typeof w[name] !== 'function' || w[name].__catPatched) return;
            const orig = w[name];
            w[name] = new Proxy(orig, {
                construct: function (target, args) {
                    const isArr = Array.isArray(args[0]) && args[0].length === 16;
                    const isAB = args[0] instanceof ArrayBuffer && args[0].byteLength === 16;
                    const instance = new orig(...args);
                    if (isArr || isAB) addKey(args[0], 'typedArray');
                    else if (instance.buffer && instance.buffer.byteLength === 16) {
                        // 转换为统一 16 字节 Uint8Array
                        if (name === 'Uint32Array') {
                            const out = new Uint8Array(16);
                            for (let i = 0; i < 4; i++) {
                                out[i * 4] = (instance[i] >>> 24) & 0xff;
                                out[i * 4 + 1] = (instance[i] >>> 16) & 0xff;
                                out[i * 4 + 2] = (instance[i] >>> 8) & 0xff;
                                out[i * 4 + 3] = instance[i] & 0xff;
                            }
                            addKey(out.buffer, 'typedArray');
                        } else if (name === 'Uint16Array') {
                            const out = new Uint8Array(16);
                            for (let i = 0; i < 8; i++) {
                                out[i * 2] = (instance[i] >>> 8) & 0xff;
                                out[i * 2 + 1] = instance[i] & 0xff;
                            }
                            addKey(out.buffer, 'typedArray');
                        } else {
                            addKey(instance.buffer, 'typedArray');
                        }
                    }
                    return instance;
                }
            });
            try { w[name].toString = function () { return Function.prototype.toString.call(orig); }; } catch (e) {}
        });

        // subarray
        ['Int8Array', 'Uint8Array'].forEach(function (name) {
            if (typeof w[name] === 'undefined' || !w[name].prototype || !w[name].prototype.subarray) return;
            const orig = w[name].prototype.subarray;
            if (orig.__catPatched) return;
            w[name].prototype.subarray = function () {
                const data = orig.apply(this, arguments);
                if (data.byteLength === 16) {
                    const u8 = new Uint8Array(data);
                    const valid = Array.from(u8).every(x => typeof x === 'number' && x <= 255);
                    if (valid) addKey(u8.buffer, 'subarray');
                }
                return data;
            };
            registerNativeStr(w[name].prototype.subarray, orig);
        });

        // DataView
        if (typeof w.DataView === 'function' && !w.DataView.__catPatched) {
            const orig = w.DataView;
            w.DataView = function () {
                const instance = new orig(...arguments);
                ['setInt8', 'setUint8', 'setInt16', 'setUint16', 'setInt32', 'setUint32'].forEach(function (m) {
                    if (typeof instance[m] !== 'function') return;
                    const origM = instance[m];
                    instance[m] = function () {
                        const r = origM.apply(this, arguments);
                        if (this.byteLength === 16) addKey(this.buffer, 'dataView');
                        return r;
                    };
                });
                if (instance.byteLength === 16 && instance.buffer && instance.buffer.byteLength === 16) addKey(instance.buffer, 'dataView');
                if (instance.byteLength === 32) addKey(instance.buffer.slice(0, 16), 'dataView');
                return instance;
            };
            w.DataView.toString = function () { return Function.prototype.toString.call(orig); };
        }
    }

    // ======================== Performance + DOM + History + postMessage ========================

    function startPerformanceScan() {
        if (!w.performance || typeof PerformanceObserver === 'undefined') return;
        try {
            performance.getEntriesByType('resource').forEach(function (entry) {
                const ext = getExt(entry.name);
                if (ext) addMedia(entry.name, ext, 'performance');
            });
            const ob = new PerformanceObserver(function (list) {
                list.getEntries().forEach(function (entry) {
                    const ext = getExt(entry.name);
                    if (ext) addMedia(entry.name, ext, 'performance');
                });
            });
            ob.observe({ entryTypes: ['resource'] });
        } catch (e) {}
    }

    function startDOMScan() {
        const scanNow = function () {
            const doc = typeof document !== 'undefined' ? document : null;
            if (!doc) return;
            doc.querySelectorAll('video[src], source[src]').forEach(function (el) {
                let src = el.getAttribute('src') || el.currentSrc || '';
                if (!src || src.startsWith('blob:')) return;
                let ext = getExt(src);
                if (ext) addMedia(src, ext, 'dom');
            });
            // 内联 script 正则扫描
            doc.querySelectorAll('script:not([src])').forEach(function (script) {
                if (!script.textContent) return;
                const re = /["']((?:(?:https?:)?\/\/)?[^"'\s]*?\.(?:m3u8|mp4|flv|m3u|mpd|webm|ts|m4s)(?:\?[^"'\s]*)?)["']/gi;
                let match;
                while ((match = re.exec(script.textContent)) !== null) {
                    let url = (match[1] || match[0] || '').replace(/['"]/g, '').trim();
                    if (!url) continue;
                    if (url.startsWith('//')) url = pcol() + url;
                    else if (!/^https?:/.test(url)) continue;
                    addMedia(url, getExt(url) || 'm3u8', 'domScript');
                }
            });
        };
        scanNow();
        try {
            const mo = new MutationObserver(function () {
                scanNow();
            });
            if (document.body) mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
            else document.addEventListener('DOMContentLoaded', function () {
                if (document.body) mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
            }, { once: true });
        } catch (e) {}
    }

    function hookHistory() {
        try {
            ['pushState', 'replaceState'].forEach(function (type) {
                const orig = history[type];
                history[type] = function () {
                    const rv = orig.apply(this, arguments);
                    state.referer = location.href;
                    scanNow && scanNow();
                    window.dispatchEvent(new Event(type));
                    return rv;
                };
            });
        } catch (e) {}
    }

    function hookPostMessage() {
        // iframe → top 转发 + 拦截站内 postMessage 里藏的 URL
        window.addEventListener('message', function (ev) {
            if (!ev.data) return;
            if (typeof ev.data === 'string') {
                const ext = getExt(ev.data);
                if (ext) addMedia(ev.data, ext, 'postMessage');
            } else if (typeof ev.data === 'object' && ev.data.url) {
                const ext = getExt(ev.data.url);
                if (ext) addMedia(ev.data.url, ext, 'postMessage');
            }
            // iframe 转发到 top
            if (window.self !== window.top && typeof ev.data === 'object' && !ev.data[_MSG_KEY]) {
                try {
                    window.top.postMessage(Object.assign({}, ev.data, { [_MSG_KEY]: true }), '*');
                } catch (e) {}
            }
        }, true);

        // 接收 iframe 转发过来的
        if (window.self === window.top) {
            window.addEventListener('message', function (ev) {
                if (ev.data && ev.data[_MSG_KEY]) {
                    const url = ev.data.url;
                    if (url) {
                        const ext = getExt(url);
                        if (ext) addMedia(url, ext, 'iframe');
                    }
                }
            }, true);
        }
    }

    // ======================== 命令生成 ========================

    const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

    function buildCommand() {
        if (!state.selectedUrl) return '// 请先选择一个链接';
        const url = state.selectedUrl;
        const item = state.sniffed.find(x => x.url.split('?')[0] === url.split('?')[0]);
        const ext = item ? item.ext : getExt(url) || 'm3u8';
        const ref = state.referer || (typeof location !== 'undefined' ? location.href : '');
        const ua = navigator.userAgent.replace(/"/g, '') || UA_PC;
        const baseName = safeName(state.fileName || (typeof document !== 'undefined' ? safeName(document.title) : 'clip'));

        // MP4 / 非 HLS/DASH 直链：curl 整段
        if (ext === 'mp4' || ext === 'mp3' || ext === 'flv' || ext === 'webm') {
            const dirName = safeName(typeof document !== 'undefined' ? document.title : 'clip');
            return 'mkdir -p "' + dirName + '"\n' + [
                'curl -L "' + url + '"',
                '-H "User-Agent: ' + ua + '"',
                '-H "Referer: ' + ref + '"',
                '--connect-timeout 15', '--retry 3', '--retry-delay 2',
                '-o "' + dirName + '/' + baseName + '.' + ext + '"',
            ].join(' ');
        }

        // M3U8 / MPD：按时间段
        const lines = ['# N_m3u8DL-RE 下载命令'];
        lines.push('# 视频: ' + url);
        lines.push('# Referer: ' + ref);
        lines.push('');

        let segs = state.segments.slice();
        // 如果用户没填时间段，补个空段 = 整段下载
        const hasAnySegment = segs.some(s => s.start || s.end);
        if (!hasAnySegment) {
            segs = [{ start: '', end: '' }];
        }
        segs.forEach(function (seg, i) {
            const base = [
                'N_m3u8DL-RE "' + url + '"',
                '-H "User-Agent: ' + ua + '"',
                '-H "Referer: ' + ref + '"',
                '--thread-count 8', '--download-retry-count 5',
                '--log-level info', '--auto-select',
            ];
            const s = toHMS(seg.start);
            const e = toHMS(seg.end);
            if (seg.start && seg.end && s && e) base.push('--custom-range "' + s + '-' + e + '"');
            base.push('--save-name "' + baseName + String(i + 1).padStart(2, '0') + '"');
            lines.push('# ===== 第 ' + (i + 1) + ' 段 =====');
            lines.push(base.join(' '));
            lines.push('');
        });
        return lines.join('\n');
    }

    // ======================== 剪贴板 ========================

    function copyToClipboard(text) {
        return new Promise(function (resolve) {
            if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(function () { resolve(true); }, function () { fallbackCopy(text, resolve); });
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
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); resolve(true); } catch (e) { resolve(false); }
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
            setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        } catch (e) {
            copyToClipboard(content).then(function () { toast('下载失败，已复制到剪贴板'); });
        }
    }

    // ======================== UI ========================

    let badge, panel, listEl, segList, cmdBox, tabBadge;
    let currentTab = 0;
    let toastTimer;
    const TOTAL = 3;

    function toast(msg) {
        let el = document.getElementById('__mc_toast');
        if (!el) {
            el = document.createElement('div');
            el.id = '__mc_toast';
            el.style.cssText = 'position:fixed;bottom:70px;right:16px;z-index:2147483647;'
                + 'background:#1f2937;color:#fff;padding:6px 12px;border-radius:6px;font:13px sans-serif;transition:opacity .15s';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.style.display = 'block';
        el.style.opacity = '1';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { el.style.opacity = '0'; setTimeout(function () { el.style.display = 'none'; }, 200); }, 1500);
    }

    function buildUI() {
        // Badge
        badge = document.createElement('div');
        badge.id = '__mc_badge';
        badge.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483646;'
            + 'background:#2563eb;color:#fff;border-radius:20px;padding:8px 14px;'
            + 'font:13px/1.2 sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2);user-select:none;display:flex;align-items:center;gap:6px';
        badge.innerHTML = '<span>📺 m3u8</span><span id="__mc_count" style="font-weight:bold">0</span>';
        badge.onclick = function () { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; };
        document.body.appendChild(badge);

        // Panel
        panel = document.createElement('div');
        panel.style.cssText = 'position:fixed;bottom:56px;right:16px;z-index:2147483646;'
            + 'width:min(560px,92vw);max-height:72vh;display:none;'
            + 'background:#fff;color:#111;border:1px solid #d1d5db;border-radius:8px;overflow:hidden;'
            + 'box-shadow:0 4px 20px rgba(0,0,0,.18);font:12px/1.5 sans-serif;display:flex;flex-direction:column';
        panel.innerHTML = ''
            + '<div style="display:flex;border-bottom:1px solid #e5e7eb;background:#f9fafb">'
            + '<button data-tab="0" class="__mc_tab active">🔗 链接 <span id="__mc_t0" class="__mc_tcnt">0</span></button>'
            + '<button data-tab="1" class="__mc_tab">⏱ 时间段 <span id="__mc_t1" class="__mc_tcnt"></span></button>'
            + '<button data-tab="2" class="__mc_tab">⚡ 生成命令</button>'
            + '<button id="__mc_close" title="关闭" style="margin-left:auto;border:none;background:transparent;cursor:pointer;padding:0 10px;color:#6b7280">×</button>'
            + '</div>'
            + '<div id="__mc_content" style="flex:1;overflow:auto;padding:10px"></div>';
        const tabStyle = 'border:none;background:transparent;padding:8px 10px;cursor:pointer;font:inherit;color:#6b7280;border-bottom:2px solid transparent;transition:all';
        const tabActive = 'color:#2563eb;border-bottom-color:#2563eb';
        const styleTag = document.createElement('style');
        styleTag.textContent = '.__mc_tab{' + tabStyle + '}.__mc_tab.active{' + tabActive + '} .__mc_tcnt{background:#e5e7eb;border-radius:8px;padding:0 6px;font-size:10px;margin-left:2px}';
        panel.appendChild(styleTag);
        document.body.appendChild(panel);

        // Bindings
        panel.querySelectorAll('.__mc_tab').forEach(function (btn) {
            btn.addEventListener('click', function () { switchTab(parseInt(btn.dataset.tab)); });
        });
        panel.querySelector('#__mc_close').addEventListener('click', function () { panel.style.display = 'none'; });

        render();
    }

    function switchTab(idx) {
        currentTab = idx;
        panel.querySelectorAll('.__mc_tab').forEach(function (b, i) {
            b.classList.toggle('active', i === idx);
        });
        const content = panel.querySelector('#__mc_content');
        content.innerHTML = '';
        if (idx === 0) renderTab0(content);
        else if (idx === 1) renderTab1(content);
        else renderTab2(content);
    }

    function renderTab0(content) {
        if (state.sniffed.length === 0) {
            content.innerHTML = '<div style="text-align:center;padding:20px;color:#6b7280">'
                + '等待嗅探视频资源...<br>播放一下视频页面，或打开开发者工具看看<br>'
                + '<button id="__mc_rescan" style="margin-top:10px;padding:6px 12px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer">🔄 重新扫描</button>'
                + '</div>';
            document.getElementById('__mc_rescan')?.addEventListener('click', function () {
                const ext = getExt((typeof location !== 'undefined' ? location.href : ''));
                if (ext) addMedia(location.href, ext, 'manual');
                startDOMScan();
                startPerformanceScan();
                render();
            });
            return;
        }
        const frag = document.createDocumentFragment();
        // 头部统计
        const head = document.createElement('div');
        head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px';
        head.innerHTML = '<span style="font-weight:600">📌 共 ' + state.sniffed.length + ' 个链接'
            + (state.keys.length ? ' | 🔑 ' + state.keys.length + ' 个 key' : '') + '</span>'
            + '<button id="__mc_clear" style="border:1px solid #d1d5db;background:#f9fafb;border-radius:4px;cursor:pointer;padding:2px 8px">清空</button>';
        head.querySelector('#__mc_clear').addEventListener('click', function () {
            state.sniffed = []; state.dedup.clear(); state.selectedUrl = null; state.segments = [];
            render();
        });
        frag.appendChild(head);

        // key 列表
        if (state.keys.length > 0) {
            const khead = document.createElement('div');
            khead.style.cssText = 'margin-top:10px;padding:6px;background:#fef3c7;border-radius:4px;font-size:11px;color:#92400e';
            khead.textContent = '🔑 检测到 ' + state.keys.length + ' 个 DRM 解密 key（点击复制）';
            frag.appendChild(khead);
            state.keys.forEach(function (k) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;background:#fefce8;border-radius:3px;margin-top:3px;font-size:11px';
                row.innerHTML = '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace">' + escapeHtml(k.key) + '</span>';
                const btn = document.createElement('button');
                btn.textContent = '复制';
                btn.style.cssText = 'border:1px solid #d1d5db;background:#fff;border-radius:3px;cursor:pointer;padding:1px 6px';
                btn.addEventListener('click', function () { copyToClipboard(k.key).then(function (ok) { toast(ok ? 'key 已复制' : '复制失败'); }); });
                row.appendChild(btn);
                frag.appendChild(row);
            });
        }

        frag.appendChild(document.createElement('hr'));

        // 链接列表
        state.sniffed.forEach(function (item) {
            const row = document.createElement('div');
            row.style.cssText = 'border-top:1px solid #eee;padding:6px 0;word-break:break-all;display:flex;flex-direction:column;gap:4px';
            const sel = state.selectedUrl && state.selectedUrl.split('?')[0] === item.url.split('?')[0];
            row.innerHTML = ''
                + '<div style="color:' + (sel ? '#2563eb' : '#374151') + ';font-weight:' + (sel ? 'bold' : 'normal') + '">'
                + '<span style="background:#dbeafe;color:#1d4ed8;border-radius:3px;padding:1px 5px;font-size:10px;margin-right:4px">' + escapeHtml(item.ext || '?') + '</span>'
                + (item.url.length > 160 ? escapeHtml(item.url.slice(0, 160) + '…') : escapeHtml(item.url))
                + '</div>'
                + '<div style="display:flex;gap:6px;flex-wrap:wrap">'
                + '<button data-act="pick" style="border:1px solid #2563eb;background:#2563eb;color:#fff;border-radius:4px;cursor:pointer;padding:2px 10px;font:12px sans-serif">' + (sel ? '✓ 已选中' : '📌 选它生成') + '</button>'
                + '<button data-act="copy" style="border:1px solid #d1d5db;background:#f9fafb;border-radius:4px;cursor:pointer;padding:2px 8px;font:12px sans-serif">复制链接</button>'
                + '<button data-act="cmd" style="border:1px solid #d1d5db;background:#f9fafb;border-radius:4px;cursor:pointer;padding:2px 8px;font:12px sans-serif">复制命令</button>'
                + '</div>';
            row.querySelector('[data-act="pick"]').addEventListener('click', function () {
                state.selectedUrl = item.url;
                if (!state.fileName) state.fileName = safeName(document.title);
                state.segments = [];
                switchTab(1);
            });
            row.querySelector('[data-act="copy"]').addEventListener('click', function () {
                copyToClipboard(item.url).then(function (ok) { toast(ok ? '链接已复制' : '复制失败'); });
            });
            row.querySelector('[data-act="cmd"]').addEventListener('click', function () {
                state.selectedUrl = item.url;
                const cmd = buildCommand();
                copyToClipboard(cmd).then(function (ok) { toast(ok ? '命令已复制' : '复制失败'); });
            });
            frag.appendChild(row);
        });

        content.appendChild(frag);
    }

    function renderTab1(content) {
        if (!state.selectedUrl) {
            content.innerHTML = '<div style="text-align:center;padding:30px;color:#6b7280">⚠️ 请先在"链接"tab 点一个「📌 选它生成」</div>';
            return;
        }
        const item = state.sniffed.find(x => x.url.split('?')[0] === state.selectedUrl.split('?')[0]);
        const ext = item ? item.ext : getExt(state.selectedUrl);
        const isM3U8 = ext !== 'mp4' && ext !== 'mp3' && ext !== 'flv' && ext !== 'webm';

        // 选中信息 + 文件名
        let html = '<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;padding:8px;margin-bottom:10px">'
            + '📌 <b>' + escapeHtml(state.fileName || 'clip') + '</b> · ' + escapeHtml(ext)
            + '<div style="margin-top:4px;font-size:10px;color:#1e40af;word-break:break-all">' + escapeHtml(state.selectedUrl) + '</div>'
            + '</div>';

        // 文件名编辑
        html += '<div style="margin-bottom:10px">'
            + '<label style="display:block;margin-bottom:4px;color:#374151">📝 保存文件名</label>'
            + '<input id="__mc_fn" value="' + escapeHtml(state.fileName) + '" style="width:100%;padding:6px;border:1px solid #d1d5db;border-radius:4px;box-sizing:border-box;font:inherit">'
            + '</div>';

        // 时间段
        if (isM3U8) {
            html += '<div style="margin-bottom:6px;color:#374151">'
                + '⏱ 时间段 <span style="color:#6b7280;font-size:10px">(6 位数字 HHMMSS；整行留空 = 下载整段)</span></div>'
                + '<div id="__mc_seglist"></div>'
                + '<button id="__mc_addseg" style="margin-top:6px;padding:6px 12px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer">➕ 添加时间段</button>';
        } else {
            html += '<div style="text-align:center;padding:16px;color:#6b7280;font-size:11px">💡 ' + ext + ' 是直链格式，不支持时间裁剪（整个文件下载）</div>';
        }

        content.innerHTML = html;

        // 绑定事件
        content.querySelector('#__mc_fn').addEventListener('input', function (e) {
            state.fileName = e.target.value;
        });
        if (isM3U8) {
            if (state.segments.length === 0) state.segments = [{ start: '', end: '' }];
            renderSegList(content.querySelector('#__mc_seglist'));
            content.querySelector('#__mc_addseg').addEventListener('click', function () {
                state.segments.push({ start: '', end: '' });
                renderSegList(content.querySelector('#__mc_seglist'));
            });
        }
    }

    function renderSegList(box) {
        if (!box) return;
        box.innerHTML = '';
        state.segments.forEach(function (seg, i) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 0';
            row.innerHTML = ''
                + '<span style="color:#6b7280;min-width:24px">#' + (i + 1) + '</span>'
                + '<input class="__mc_st" inputmode="numeric" maxlength="6" placeholder="起始" value="' + escapeHtml(seg.start) + '" style="width:80px;padding:4px;border:1px solid #d1d5db;border-radius:4px;font-family:monospace;box-sizing:border-box">'
                + '<span style="color:#9ca3af">—</span>'
                + '<input class="__mc_et" inputmode="numeric" maxlength="6" placeholder="结束" value="' + escapeHtml(seg.end) + '" style="width:80px;padding:4px;border:1px solid #d1d5db;border-radius:4px;font-family:monospace;box-sizing:border-box">'
                + '<button data-del="' + i + '" style="border:1px solid #ef4444;background:#fff;color:#ef4444;border-radius:4px;cursor:pointer;padding:1px 8px;font:inherit">✕</button>';
            const st = row.querySelector('.__mc_st');
            const et = row.querySelector('.__mc_et');
            st.addEventListener('input', function () {
                st.value = st.value.replace(/\D/g, '').slice(0, 6);
                state.segments[i].start = st.value;
            });
            et.addEventListener('input', function () {
                et.value = et.value.replace(/\D/g, '').slice(0, 6);
                state.segments[i].end = et.value;
            });
            row.querySelector('[data-del]').addEventListener('click', function () {
                state.segments.splice(i, 1);
                if (state.segments.length === 0) state.segments = [{ start: '', end: '' }];
                renderSegList(box);
            });
            box.appendChild(row);
        });
    }

    function renderTab2(content) {
        if (!state.selectedUrl) {
            content.innerHTML = '<div style="text-align:center;padding:30px;color:#6b7280">⚠️ 请先在"链接"tab 选一个</div>';
            return;
        }
        const cmd = buildCommand();
        const lineCount = cmd.split('\n').filter(function (l) { return l.trim() && !l.startsWith('#'); }).length;

        content.innerHTML = ''
            + '<div style="margin-bottom:10px;font-size:11px;color:#6b7280">'
            + '📄 <b>文件名</b>: ' + escapeHtml(state.fileName || '(未命名)') + ' | '
            + '📋 <b>有效命令</b>: ' + lineCount + ' 条'
            + '</div>'
            + '<textarea id="__mc_cmd" spellcheck="false" style="width:100%;min-height:200px;max-height:300px;padding:8px;background:#0f172a;color:#94a3b8;border:1px solid #334155;border-radius:4px;font:11px monospace;box-sizing:border-box;resize:vertical;white-space:pre-wrap;word-break:break-all">' + escapeHtml(cmd) + '</textarea>'
            + '<div style="display:flex;gap:8px;margin-top:10px">'
            + '<button id="__mc_copy" style="flex:1;padding:8px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:600">📋 复制全部命令</button>'
            + '<button id="__mc_dl" style="flex:1;padding:8px;background:#10b981;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:600">💾 下载 .txt</button>'
            + '</div>';

        content.querySelector('#__mc_copy').addEventListener('click', function () {
            const txt = content.querySelector('#__mc_cmd').value;
            copyToClipboard(txt).then(function (ok) { toast(ok ? '已复制！到终端粘贴即可' : '复制失败'); });
        });
        content.querySelector('#__mc_dl').addEventListener('click', function () {
            const txt = content.querySelector('#__mc_cmd').value;
            downloadTxt(txt, safeName(state.fileName || 'clip') + '.txt');
        });
    }

    function render() {
        if (!badge) return;
        // 更新计数
        const countEl = document.getElementById('__mc_count');
        if (countEl) countEl.textContent = state.sniffed.length;
        const tab0 = document.getElementById('__mc_t0');
        const tab1 = document.getElementById('__mc_t1');
        if (tab0) tab0.textContent = state.sniffed.length + (state.keys.length ? ' + ' + state.keys.length + '🔑' : '');
        if (tab1) {
            const segs = state.segments && state.segments.some(function (s) { return s.start || s.end; });
            tab1.textContent = segs ? state.segments.length + '段' : '未设置';
        }
        // 如果 panel 显示着，重绘当前 tab
        if (panel && panel.style.display !== 'none' && panel.style.display !== '') {
            const content = panel.querySelector('#__mc_content');
            if (content) switchTab(currentTab);
        }
    }

    // ======================== 启动 ========================

    function run() {
        // 防重复
        if (run.__done) return;
        run.__done = true;

        // referer 初始
        try { state.referer = location.href; } catch (e) {}
        try { if (typeof document !== 'undefined') state.fileName = safeName(document.title); } catch (e) {}

        // 劫持
        hookFetch();
        hookXHR();
        hookJSONParse();
        hookTextDecoder();
        hookString();
        hookArray();
        hookBtoaAtob();
        hookTypedArray();

        // 扫描
        startPerformanceScan();
        startDOMScan();
        hookHistory();
        hookPostMessage();

        // UI
        if (document.body) buildUI();
        else {
            const ob = new MutationObserver(function () {
                if (document.body) { buildUI(); ob.disconnect(); }
            });
            ob.observe(document.documentElement, { childList: true, subtree: true });
        }

        // 油猴菜单
        if (typeof GM_registerMenuCommand === 'function') {
            try { GM_registerMenuCommand('🔗 显示/隐藏媒体嗅探面板', function () {
                if (!badge) return;
                if (!panel || !panel.isConnected) { buildUI(); return; }
                panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
            }); } catch (e) {}
            try { GM_registerMenuCommand('📋 一键复制最新命令', function () {
                if (state.sniffed.length === 0) { toast('还没抓到链接'); return; }
                if (!state.selectedUrl) state.selectedUrl = state.sniffed[state.sniffed.length - 1].url;
                copyToClipboard(buildCommand()).then(function (ok) { toast(ok ? '最新命令已复制' : '复制失败'); });
            }); } catch (e) {}
        }

        // iframe 转发（主 window.top 接收）
        if (window.self !== window.top) {
            window.addEventListener('message', function (ev) {
                if (ev.data && ev.data[_MSG_KEY] && ev.data.url) {
                    const ext = getExt(ev.data.url);
                    if (ext) addMedia(ev.data.url, ext, 'iframe');
                }
            }, true);
        }
    }

    // 立即启动（@run-at document-start）
    run();
})();
