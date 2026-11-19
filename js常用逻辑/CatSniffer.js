/**
 * CatSniffer.js — 通用媒体资源嗅探库
 *
 * 来源：cat-catch 2.7.4 扩展的深度嗅探(search.js) + MSE缓存捕获(catch.js) 部分
 * 移植改造：移除所有 chrome.* 依赖，改为回调接口，可直接在普通页面 / 油猴脚本中使用。
 *
 * 功能覆盖：
 *   1. 劫持 fetch / XMLHttpRequest / JSON.parse / TextDecoder / String / Array / TypedArray / DataView / btoa / atob ...
 *   2. 递归遍历任意 JSON 结构中的媒体 URL / m3u8 文本 / DRM 解密 key
 *   3. 劫持 MediaSource.addSourceBuffer —— 抓取 MSE 二进制分片（无 URL 可下载场景）
 *   4. Worker 注入 —— Blob Worker 场景下把嗅探器注入 Worker 内部继续工作
 *   5. 双层 Function.prototype.toString 伪装 —— 防止网站反爬虫检测
 *   6. 自动补全 m3u8 中的相对路径 / data:base64 解码 / Vimeo playlist.json → m3u8
 *
 * 使用方式：
 *   CatSniffer.start({
 *     mediaExts: ["m3u8","m3u","mpd","mp4","mp3","flv","m4a","webm","ts","key"],
 *     enableMSE: true,          // 是否启用 MSE 二进制分片捕获
 *     enableWorker: true,       // 是否在 Blob Worker 内部继续嗅探
 *     maxLinks: 500             // 去重上限
 *   });
 *   CatSniffer.on("media", info => { /* info = { url, ext, href, blobUrl? } *\/ });
 *   CatSniffer.on("key",   info => { /* info = { key: base64, ext, href } *\/ });
 *   CatSniffer.on("mse",   info => { /* info = { mimeType, chunk } *\/ });
 *   CatSniffer.stop();
 *
 * 部署提示（油猴脚本）：
 *   在 @run-at document-start 时机加载，并确保 hook 的是 unsafeWindow 而非沙箱内的 window。
 */

(function (root, factory) {
    // UMD：浏览器全局 / CommonJS / ES module 兜底
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else if (typeof define === "function" && define.amd) {
        define(factory);
    } else {
        root.CatSniffer = factory();
    }
})(typeof self !== "undefined" ? self : this, function CatSnifferFactory() {
    "use strict";

    // 模块自身源码（用于 Worker 内重新注入）
    const __SELF_SOURCE__ = CatSnifferFactory.toString();

    // ==================== 1. 配置与基础变量 ====================

    const DEFAULT_OPTS = {
        mediaExts: ["m3u8", "m3u", "mpd", "mp4", "mp3", "flv", "m4a", "webm", "ts", "key", "m4s"],
        enableMSE: true,
        enableWorker: true,
        maxLinks: 500,
        debug: false
    };

    let opts = { ...DEFAULT_OPTS };
    const listeners = { media: [], key: [], mse: [] };

    // 去重：防止同一条目重复触发回调
    const filter = new Set();
    // m3u8 相对路径解析辅助
    const baseUrlSet = new Set();
    const joinBaseUrlQueue = [];

    let isRunning = false;

    // Worker 内部标志
    const isWorker = typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;

    // ==================== 2. 工具函数 ====================

    function emit(type, payload) {
        // 1) 主线程：调用本地注册的监听器
        const arr = listeners[type];
        if (arr && arr.length) {
            for (let i = 0; i < arr.length; i++) {
                try { arr[i](payload); } catch (e) { /* 单个回调异常不影响整体 */ }
            }
        }
        // 2) Worker 场景：self.postMessage 把事件抛给外层（主线程 hookWorker 里 addEventListener 接）
        if (isWorker && typeof self.postMessage === "function") {
            try { self.postMessage({ __catSnifferEvent__: true, type: type, payload: payload }); } catch (e) {}
        }
    }

    function debug() { if (opts.debug) console.log("[CatSniffer]", ...arguments); }

    function isUrl(str) {
        return typeof str === "string" && (str.startsWith("http://") || str.startsWith("https://") || str.startsWith("//"));
    }

    function getExtension(str) {
        if (typeof str !== "string") return false;
        if (str.startsWith("//")) str = (typeof location !== "undefined" ? location.protocol + str : "https:" + str);
        let u;
        try { u = new URL(str); } catch (e) { return false; }
        let ext = u.pathname.split(".");
        if (ext.length === 1) return false;
        ext = ext.pop().toLowerCase().split("?")[0];
        if (opts.mediaExts.indexOf(ext) !== -1) return ext;
        return false;
    }

    function isJSON(str) {
        if (typeof str === "object" && str !== null) return str;
        if (typeof str !== "string") return false;
        try { return JSON.parse(str); } catch (e) { return false; }
    }

    function hexRegexTest(str) {
        return /^[A-Fa-f0-9]+$/.test(str);
    }

    function base64RegexTest(str) {
        return /^[A-Za-z0-9+/]+={0,2}$/.test(str);
    }

    function arrayToBase64(data) {
        try {
            const bytes = new Uint8Array(data);
            let binary = "";
            for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
            return typeof btoa === "function" ? btoa(binary) : false;
        } catch (e) { return false; }
    }

    function extractBaseUrl(url) {
        if (typeof url !== "string") return;
        const parts = url.split("/");
        parts.pop();
        const base = parts.join("/") + "/";
        if (!baseUrlSet.has(base)) {
            joinBaseUrlQueue.forEach(fn => fn(base));
            baseUrlSet.add(base);
        }
    }

    function getBaseUrl(url) {
        const parts = url.split("/");
        parts.pop();
        return parts.join("/") + "/";
    }

    function addBaseUrl(baseUrl, m3u8Text) {
        const reKeyURL = /URI="(.*)"/;
        const lines = m3u8Text.split("\n");
        let out = "";
        for (const ts of lines) {
            if (ts === "" || ts === " " || ts === "\n") continue;
            if (ts.includes("URI=")) {
                const m = reKeyURL.exec(ts);
                if (m && m[1] && !isUrl(m[1])) {
                    ts = ts.replace(reKeyURL, 'URI="' + baseUrl + m[1] + '"');
                }
            }
            if (ts[0] !== "#" && !isUrl(ts)) {
                if (ts.startsWith("/")) {
                    const urlSplit = baseUrl.split("/");
                    ts = urlSplit[0] + "//" + urlSplit[2] + ts;
                } else {
                    ts = baseUrl + ts;
                }
            }
            out += ts + "\n";
        }
        return out;
    }

    function TsProtocol(text) {
        const lines = text.split("\n");
        for (let i in lines) {
            if (lines[i][0] === "#") continue;
            if (lines[i].startsWith("//")) {
                lines[i] = (typeof location !== "undefined" ? location.protocol : "https:") + lines[i];
            }
        }
        return lines.join("\n");
    }

    function isFullM3u8(text) {
        const lines = text.split("\n");
        for (const ts of lines) {
            if (ts[0] === "#") continue;
            if (isUrl(ts)) return true;
            return false;
        }
        return false;
    }

    function getDataM3U8(text) {
        text = text.substring(text.indexOf("/") + 1);
        const mimeTypes = ["vnd.apple.mpegurl", "x-mpegurl", "mpegurl"];
        const matched = mimeTypes.find(t => text.toLowerCase().startsWith(t));
        if (!matched) return false;
        const rest = text.slice(matched.length + 1);
        const [prefix, data] = rest.split(/,(.+)/);
        return prefix.toLowerCase() === "base64" ? atob(data) : rest;
    }

    // 检测数组是否是 16 字节 key 的重复扩展（256 / 128 / 32 字节常见）
    function isRepeatedExpansion(array, expansionLength) {
        const buf = new Uint8Array(expansionLength);
        const u8 = new Uint8Array(array);
        for (let i = 0; i < expansionLength; i++) {
            buf[i] = u8[i];
            for (let j = i + expansionLength; j < u8.byteLength; j += expansionLength) {
                if (u8[i] !== u8[j]) return false;
            }
        }
        return buf.buffer;
    }

    // ==================== 3. 事件发射（去重 + 封装 payload） ====================

    // 数据来源标记，帮助上层 UI 区分
    const SOURCE = {
        FETCH: "fetch", XHR: "xhr", JSON_PARSE: "json", TEXT_DECODER: "textDecoder",
        STRING_INDEXOF: "indexOf", FROM_CHAR_CODE: "fromCharCode",
        BTOA: "btoa", ATOB: "atob", ESCAPE: "escape",
        ARRAY_SLICE: "arraySlice", ARRAY_JOIN: "arrayJoin",
        TYPED_ARRAY: "typedArray", DATAVIEW: "dataView", SUBARRAY: "subarray",
        WORKER: "worker", DOM_SCRIPT: "domScript", DATA_URL: "dataUrl",
        MEDIA_SOURCE: "mediaSource"
    };

    function postMedia(info) {
        let value = info.url;
        if (value instanceof ArrayBuffer || value instanceof Array) {
            if (value.byteLength === 0) return;
            // MP4 ftyp 头误判为 key 时跳过
            if (info.action === "key") {
                const u8 = new Uint8Array(value);
                if ((u8[4] === 0x73 || u8[4] === 0x66) && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) {
                    return;
                }
            }
            const b64 = arrayToBase64(value);
            if (b64 === false) return;
            value = b64;
            if (info.action === "key") info.key = b64;
            else info.url = b64;
        }
        if (info.action === "key" && value && typeof value === "string" && value.startsWith("AAAAAAAAAAAAAAAAAAAA")) {
            return;
        }
        if (filter.has(value)) return;
        filter.add(value);
        if (filter.size > opts.maxLinks) {
            // 过半时清理一遍避免无限增长
            const arr = Array.from(filter);
            filter.clear();
            for (let i = Math.floor(arr.length / 2); i < arr.length; i++) filter.add(arr[i]);
        }
        if (info.action === "media") {
            emit("media", {
                url: info.url,
                ext: info.ext,
                href: info.href || (typeof location !== "undefined" ? location.href : ""),
                source: info.source
            });
        } else if (info.action === "key") {
            emit("key", {
                key: info.key,
                ext: info.ext || "key",
                href: info.href || (typeof location !== "undefined" ? location.href : ""),
                source: info.source
            });
        }
    }

    // m3u8 文本 → Blob URL 并发射
    function toUrl(text, ext = "m3u8") {
        if (!text) return;
        if (ext === "mpd") {
            const blobUrl = URL.createObjectURL(new Blob([new TextEncoder("utf-8").encode(text)]));
            postMedia({ action: "media", url: blobUrl, ext: ext, href: (typeof location !== "undefined" ? location.href : ""), source: SOURCE.FROM_CHAR_CODE });
            return;
        }
        text = TsProtocol(text);
        if (isFullM3u8(text)) {
            const blobUrl = URL.createObjectURL(new Blob([new TextEncoder("utf-8").encode(text)]));
            postMedia({ action: "media", url: blobUrl, ext: ext, source: SOURCE.FROM_CHAR_CODE });
            return;
        }
        baseUrlSet.forEach(function (url) {
            const full = addBaseUrl(url, text);
            const blobUrl = URL.createObjectURL(new Blob([new TextEncoder("utf-8").encode(full)]));
            postMedia({ action: "media", url: blobUrl, ext: ext, source: SOURCE.FROM_CHAR_CODE });
        });
        joinBaseUrlQueue.push(function (url) {
            const full = addBaseUrl(url, text);
            const blobUrl = URL.createObjectURL(new Blob([new TextEncoder("utf-8").encode(full)]));
            postMedia({ action: "media", url: blobUrl, ext: ext, source: SOURCE.FROM_CHAR_CODE });
        });
    }

    // ==================== 4. findMedia：递归遍历任意对象/JSON 找媒体 ====================

    function findMedia(data, depth) {
        if (!data) return;
        depth = depth || 0;

        // 顶层直接是 16 字节数组 → 判为 key
        if (data instanceof Array && data.length === 16) {
            const allByte = data.every(v => typeof v === "number" && v <= 256);
            if (allByte) {
                postMedia({ action: "key", key: data, ext: "key", source: SOURCE.JSON_PARSE });
                return;
            }
        }
        if (data instanceof ArrayBuffer && data.byteLength === 16) {
            postMedia({ action: "key", key: data, ext: "key", source: SOURCE.JSON_PARSE });
            return;
        }

        for (const key in data) {
            if (!data.hasOwnProperty(key)) continue;
            const v = data[key];

            if (typeof v === "object" && v !== null) {
                if (v instanceof Array && v.length === 16) {
                    const allByte = v.every(x => typeof x === "number" && x <= 256);
                    if (allByte) {
                        postMedia({ action: "key", key: v, ext: "key", source: SOURCE.JSON_PARSE });
                        continue;
                    }
                }
                if (depth <= 20) {
                    findMedia(v, depth + 1);
                }
                continue;
            }

            if (typeof v === "string") {
                const trimmed = v.trim();
                if (isUrl(trimmed)) {
                    const ext = getExtension(trimmed);
                    if (ext) {
                        const url = trimmed.startsWith("//") ? ((typeof location !== "undefined" ? location.protocol : "https:") + trimmed) : trimmed;
                        extractBaseUrl(url);
                        postMedia({ action: "media", url: url, ext: ext, source: SOURCE.JSON_PARSE });
                    }
                    continue;
                }
                if (trimmed.substring(0, 7).toUpperCase() === "#EXTM3U") {
                    toUrl(trimmed);
                    continue;
                }
                if (/^data:(application|video|audio)\//i.test(trimmed.substring(0, 17))) {
                    const text = getDataM3U8(trimmed);
                    text && toUrl(text);
                    continue;
                }
                if (trimmed.toLowerCase().includes("urn:mpeg:dash:schema:mpd")) {
                    toUrl(trimmed, "mpd");
                    continue;
                }
            }
        }
    }

    // ==================== 5. 原生 API 劫持层 ====================

    const hooks = {
        // 记录原始引用，stop() 时恢复
        orig: {}
    };

    function hookToString(origFn, self) {
        // 让被劫持函数的 .toString() 仍返回原生串，对抗网站反爬虫
        self.toString = function () { return origFn.toString(); };
        // 保留原生引用的调用能力
        return self;
    }

    // ----- fetch -----
    function hookFetch() {
        if (typeof self.fetch !== "function") return;
        hooks.orig.fetch = self.fetch;
        const dataRE = /^data:(application|video|audio)\//i;

        self.fetch = async function (input, init) {
            let response;
            try { response = await hooks.orig.fetch.apply(this, arguments); } catch (e) { throw e; }

            const clone = response.clone();
            const inputUrl = typeof input === "object" && input ? input.url : input;

            // 先在请求参数层面嗅探
            if (inputUrl && typeof inputUrl === "string") {
                const ext = getExtension(inputUrl);
                if (ext) {
                    extractBaseUrl(inputUrl);
                    postMedia({ action: "media", url: inputUrl, ext: ext, source: SOURCE.FETCH });
                }
            }

            // 在响应体层面嗅探（JSON / m3u8 / key）
            clone.arrayBuffer().then(function (arrayBuffer) {
                if (!arrayBuffer) return;
                if (arrayBuffer.byteLength === 16) {
                    postMedia({ action: "key", key: arrayBuffer, ext: "key", source: SOURCE.FETCH });
                    return;
                }
                let text = new TextDecoder().decode(arrayBuffer);
                if (!text) return;

                const parsed = isJSON(text);
                if (parsed) { findMedia(parsed); return; }

                if (text.substring(0, 7).toUpperCase() === "#EXTM3U") {
                    const method = init && init.method ? init.method.toUpperCase() : "GET";
                    if (method !== "POST") {
                        const src = inputUrl || "";
                        if (src && typeof src === "string") {
                            toUrl(addBaseUrl(getBaseUrl(src), text));
                            postMedia({ action: "media", url: src, ext: "m3u8", source: SOURCE.FETCH });
                        } else {
                            toUrl(text);
                        }
                    } else {
                        toUrl(text);
                    }
                    return;
                }

                if (dataRE.test(text.substring(0, 17))) {
                    const t = getDataM3U8(text);
                    t && toUrl(t);
                }
            }).catch(function () { /* ignore clone errors */ });

            return response;
        };
        hookToString(hooks.orig.fetch, self.fetch);
    }

    // ----- XMLHttpRequest -----
    function hookXHR() {
        if (!self.XMLHttpRequest || !self.XMLHttpRequest.prototype) return;
        hooks.orig.xhrOpen = self.XMLHttpRequest.prototype.open;
        hooks.orig.xhrOpen.toString = hooks.orig.xhrOpen.toString;

        const dataRE = /^data:(application|video|audio)\//i;

        self.XMLHttpRequest.prototype.open = function (method) {
            method = (method || "GET").toUpperCase();
            const self = this;

            self.addEventListener("readystatechange", function () {
                if (self.status !== 200) return;

                // 16 / 32 字节 → key
                if (self.responseType === "arraybuffer" && self.response && self.response.byteLength) {
                    if (self.response.byteLength === 16 || self.response.byteLength === 32) {
                        postMedia({ action: "key", key: self.response, ext: "key", source: SOURCE.XHR });
                    }
                    if (self.responseURL && self.responseURL.includes(".ts")) {
                        extractBaseUrl(self.responseURL);
                    }
                }

                // 响应是对象（通常是 JSON 解析后的 XHR）→ 递归
                if (typeof self.response === "object" && self.response !== null) {
                    findMedia(self.response);
                    return;
                }
                if (typeof self.response !== "string" || !self.response) return;

                const responseURL = self.responseURL || "";

                // data:application/vnd.apple.mpegurl;base64,... → 解码
                if (dataRE.test(self.response)) {
                    const t = getDataM3U8(self.response);
                    t && toUrl(t);
                    return;
                }
                if (dataRE.test(responseURL)) {
                    const t = getDataM3U8(responseURL);
                    t && toUrl(t);
                    return;
                }

                // response 本身就是 URL
                if (isUrl(self.response)) {
                    const ext = getExtension(self.response);
                    if (ext) {
                        postMedia({ action: "media", url: self.response, ext: ext, source: SOURCE.XHR });
                    }
                    return;
                }

                const upper = self.response.toUpperCase();

                // m3u8 文本
                if (upper.includes("#EXTM3U")) {
                    if (self.response.substring(0, 7) === "#EXTM3U") {
                        if (method === "GET") {
                            const url = responseURL;
                            if (url) {
                                toUrl(addBaseUrl(getBaseUrl(url), self.response));
                                postMedia({ action: "media", url: url, ext: "m3u8", source: SOURCE.XHR });
                            } else {
                                toUrl(self.response);
                            }
                        } else {
                            toUrl(self.response);
                        }
                        return;
                    }
                    // m3u8 嵌在 JSON 里
                    if (isJSON(self.response)) {
                        if (method === "GET" && responseURL) {
                            postMedia({ action: "media", url: responseURL, ext: "json", source: SOURCE.XHR });
                        }
                        toUrl(self.response, "json");
                        return;
                    }
                }

                // 纯 JSON → findMedia
                const parsed = isJSON(self.response);
                if (parsed) findMedia(parsed);
            });

            return hooks.orig.xhrOpen.apply(this, arguments);
        };
        hookToString(hooks.orig.xhrOpen, self.XMLHttpRequest.prototype.open);
    }

    // ----- JSON.parse -----
    function hookJSONParse() {
        hooks.orig.JSONparse = JSON.parse;
        JSON.parse = function () {
            const data = hooks.orig.JSONparse.apply(this, arguments);
            findMedia(data);
            return data;
        };
        hookToString(hooks.orig.JSONparse, JSON.parse);
    }

    // ----- TextDecoder.decode -----
    function hookTextDecoder() {
        if (typeof TextDecoder === "undefined" || !TextDecoder.prototype) return;
        hooks.orig.textDecoderDecode = TextDecoder.prototype.decode;
        TextDecoder.prototype.decode = function () {
            const result = hooks.orig.textDecoderDecode.apply(this, arguments);
            if (result && (result.startsWith("#EXTM3U") || result.toUpperCase().includes("#EXTM3U"))) {
                const blobUrl = URL.createObjectURL(new Blob([new TextEncoder("utf-8").encode(result)]));
                postMedia({ action: "media", url: blobUrl, ext: "m3u8", source: SOURCE.TEXT_DECODER });
            }
            return result;
        };
        hookToString(hooks.orig.textDecoderDecode, TextDecoder.prototype.decode);
    }

    // ----- String.prototype.indexOf（抓 #EXTM3U 在长串里）-----
    function hookStringIndexOf() {
        hooks.orig.indexOf = String.prototype.indexOf;
        String.prototype.indexOf = function (searchValue, fromIndex) {
            const out = hooks.orig.indexOf.apply(this, arguments);
            if (searchValue === "#EXTM3U" && out !== -1) {
                const data = this.substring(fromIndex);
                toUrl(data);
            }
            return out;
        };
        hookToString(hooks.orig.indexOf, String.prototype.indexOf);
    }

    // ----- String.fromCharCode（逐字符拼接 m3u8 / 32位 hex key）-----
    function hookFromCharCode() {
        hooks.orig.fromCharCode = String.fromCharCode;
        let m3u8Text = "";
        String.fromCharCode = new Proxy(hooks.orig.fromCharCode, {
            apply: function (target, thisArg, args) {
                const data = Reflect.apply(target, thisArg, args);
                if (data.length < 7) return data;
                if (data.substring(0, 7) === "#EXTM3U" || data.includes("#EXTINF:")) {
                    m3u8Text += data;
                    if (m3u8Text.includes("#EXT-X-ENDLIST")) {
                        toUrl(m3u8Text.split("#EXT-X-ENDLIST")[0] + "#EXT-X-ENDLIST");
                        m3u8Text = "";
                    }
                    return data;
                }
                const key = data.replaceAll("\u0010", "");
                if (key.length === 32 && hexRegexTest(key)) {
                    postMedia({ action: "key", key: key, ext: "key", source: SOURCE.FROM_CHAR_CODE });
                }
                return data;
            }
        });
        // toString 返回原生引用
        try { String.fromCharCode.toString = function () { return hooks.orig.fromCharCode.toString(); }; } catch (e) {}
    }

    // ----- Array.prototype.slice（length=32,end=16 截 key）-----
    function hookArraySlice() {
        hooks.orig.arraySlice = Array.prototype.slice;
        Array.prototype.slice = function (start, end) {
            const data = hooks.orig.arraySlice.apply(this, arguments);
            if (end === 16 && this.length === 32) {
                let allNum = true;
                for (let item of data) {
                    if (typeof item !== "number" || item > 255) { allNum = false; break; }
                }
                if (allNum) {
                    postMedia({ action: "key", key: data, ext: "key", source: SOURCE.ARRAY_SLICE });
                }
            }
            return data;
        };
        hookToString(hooks.orig.arraySlice, Array.prototype.slice);
    }

    // ----- Array.prototype.join（拼出 m3u8 或 base64 key）-----
    function hookArrayJoin() {
        hooks.orig.arrayJoin = Array.prototype.join;
        Array.prototype.join = function () {
            const data = hooks.orig.arrayJoin.apply(this, arguments);
            if (typeof data !== "string") return data;
            if (data.substring(0, 7).toUpperCase() === "#EXTM3U") {
                toUrl(data);
            }
            if (data.length === 24 && base64RegexTest(data)) {
                postMedia({ action: "key", key: data, ext: "base64Key", source: SOURCE.ARRAY_JOIN });
            }
            return data;
        };
        hookToString(hooks.orig.arrayJoin, Array.prototype.join);
    }

    // ----- btoa / atob -----
    function hookBtoaAtob() {
        if (typeof self.btoa === "function") {
            hooks.orig.btoa = self.btoa;
            self.btoa = function (data) {
                const b64 = hooks.orig.btoa.apply(this, arguments);
                if (b64.length === 24 && b64.substring(22, 24) === "==") {
                    postMedia({ action: "key", key: b64, ext: "base64Key", source: SOURCE.BTOA });
                }
                if (data && data.substring(0, 7).toUpperCase() === "#EXTM3U") {
                    toUrl(data);
                }
                return b64;
            };
            hookToString(hooks.orig.btoa, self.btoa);
        }
        if (typeof self.atob === "function") {
            hooks.orig.atob = self.atob;
            self.atob = function (b64) {
                const data = hooks.orig.atob.apply(this, arguments);
                if (b64.length === 24 && b64.substring(22, 24) === "==") {
                    postMedia({ action: "key", key: b64, ext: "base64Key", source: SOURCE.ATOB });
                }
                if (data && data.substring(0, 7).toUpperCase() === "#EXTM3U") {
                    toUrl(data);
                }
                if (data && data.endsWith("</MPD>")) {
                    toUrl(data, "mpd");
                }
                return data;
            };
            hookToString(hooks.orig.atob, self.atob);
        }
        if (typeof self.escape === "function") {
            hooks.orig.escape = self.escape;
            self.escape = function (str) {
                if (str && str.length === 24 && str.substring(22, 24) === "==") {
                    postMedia({ action: "key", key: str, ext: "base64Key", source: SOURCE.ESCAPE });
                }
                return hooks.orig.escape.apply(this, arguments);
            };
            hookToString(hooks.orig.escape, self.escape);
        }
    }

    // ----- TypedArray 构造函数（16 字节判 key）-----
    function makeFindTypedArray(srcCtor) {
        return function (args) {
            const isArray = Array.isArray(args[0]) && args[0].length === 16;
            const isAB = args[0] instanceof ArrayBuffer && args[0].byteLength === 16;
            const instance = new srcCtor(...args);

            if (isArray || isAB) {
                postMedia({ action: "key", key: args[0], ext: "key", source: SOURCE.TYPED_ARRAY });
            } else if (instance.buffer && instance.buffer.byteLength === 16) {
                if (srcCtor.name === "Uint32Array") {
                    const out = new Uint8Array(16);
                    for (let i = 0; i < 4; i++) {
                        out[i * 4] = (instance[i] >>> 24) & 0xff;
                        out[i * 4 + 1] = (instance[i] >>> 16) & 0xff;
                        out[i * 4 + 2] = (instance[i] >>> 8) & 0xff;
                        out[i * 4 + 3] = instance[i] & 0xff;
                    }
                    postMedia({ action: "key", key: out.buffer, ext: "key", source: SOURCE.TYPED_ARRAY });
                } else if (srcCtor.name === "Uint16Array") {
                    const out = new Uint8Array(16);
                    for (let i = 0; i < 8; i++) {
                        out[i * 2] = (instance[i] >>> 8) & 0xff;
                        out[i * 2 + 1] = instance[i] & 0xff;
                    }
                    postMedia({ action: "key", key: out.buffer, ext: "key", source: SOURCE.TYPED_ARRAY });
                } else {
                    postMedia({ action: "key", key: instance.buffer, ext: "key", source: SOURCE.TYPED_ARRAY });
                }
            }
            return instance;
        };
    }

    function hookTypedArray() {
        const names = ["Uint8Array", "Uint16Array", "Uint32Array"];
        names.forEach(function (n) {
            if (typeof self[n] !== "function") return;
            const orig = self[n];
            hooks.orig[n] = orig;
            self[n] = new Proxy(orig, {
                construct: function (target, args) {
                    return makeFindTypedArray(orig)(args);
                }
            });
            try { self[n].toString = function () { return orig.toString(); }; } catch (e) {}
        });
    }

    // ----- TypedArray.prototype.subarray -----
    function hookSubarray() {
        const names = ["Int8Array", "Uint8Array"];
        names.forEach(function (n) {
            if (typeof self[n] === "undefined" || !self[n].prototype) return;
            const orig = self[n].prototype.subarray;
            if (typeof orig !== "function") return;
            hooks.orig[n + "Subarray"] = orig;
            self[n].prototype.subarray = function () {
                const data = orig.apply(this, arguments);
                if (data.byteLength === 16) {
                    const u8 = new Uint8Array(data);
                    const valid = Array.from(u8).every(x => typeof x === "number" && x <= 255);
                    if (valid) {
                        postMedia({ action: "key", key: u8.buffer, ext: "key", source: SOURCE.SUBARRAY });
                    }
                }
                return data;
            };
            hookToString(orig, self[n].prototype.subarray);
        });
    }

    // ----- DataView -----
    function hookDataView() {
        if (typeof self.DataView !== "function") return;
        hooks.orig.DataView = self.DataView;

        self.DataView = function () {
            const instance = new hooks.orig.DataView(...arguments);
            // 劫持 setInt8/setUint8/... 方法，在调用后检查
            const setMethods = ["setInt8", "setUint8", "setInt16", "setUint16", "setInt32", "setUint32"];
            for (const m of setMethods) {
                if (typeof instance[m] !== "function") continue;
                const origMethod = instance[m];
                instance[m] = function () {
                    const result = origMethod.apply(this, arguments);
                    if (this.byteLength === 16) {
                        postMedia({ action: "key", key: this.buffer, ext: "key", source: SOURCE.DATAVIEW });
                    }
                    return result;
                };
            }
            // 构造时的静态检测
            if (instance.byteLength === 16 && instance.buffer && instance.buffer.byteLength === 16) {
                postMedia({ action: "key", key: instance.buffer, ext: "key", source: SOURCE.DATAVIEW });
            }
            if (instance.byteLength === 256 || instance.byteLength === 128 || instance.byteLength === 32) {
                const expanded = isRepeatedExpansion(instance.buffer, 16);
                if (expanded) {
                    postMedia({ action: "key", key: expanded, ext: "key", source: SOURCE.DATAVIEW });
                }
            }
            if (instance.byteLength === 32) {
                postMedia({ action: "key", key: instance.buffer.slice(0, 16), ext: "key", source: SOURCE.DATAVIEW });
            }
            return instance;
        };
        self.DataView.toString = function () { return hooks.orig.DataView.toString(); };
    }

    // ----- Worker 注入 -----
    function hookWorker() {
        if (!opts.enableWorker || typeof self.Worker !== "function" || isWorker) return;
        hooks.orig.Worker = self.Worker;
        const selfSrc = __SELF_SOURCE__;

        // 测试 Blob Worker 是否可用
        let supportsBlobWorker = true;
        try {
            const testBlob = new Blob([""], { type: "text/javascript" });
            const testUrl = URL.createObjectURL(testBlob);
            const testWorker = new hooks.orig.Worker(testUrl);
            testWorker.addEventListener("error", function () {
                testWorker.terminate();
                URL.revokeObjectURL(testUrl);
                supportsBlobWorker = false;
            });
        } catch (e) { supportsBlobWorker = false; }

        self.Worker = function (scriptURL, options) {
            if (!supportsBlobWorker) {
                return new hooks.orig.Worker(scriptURL, options);
            }
            try {
                const xhr = new XMLHttpRequest();
                xhr.open("GET", scriptURL, false);
                xhr.send();
                if (xhr.status === 200) {
                    const blob = new Blob(["(" + selfSrc + ")();", xhr.response], { type: "text/javascript" });
                    const newWorker = new hooks.orig.Worker(URL.createObjectURL(blob), options);
                    // Worker 内 CatSniffer 会通过 self.postMessage({ __catSnifferEvent__, type, payload }) 往主线程发事件
                    newWorker.addEventListener("message", function (event) {
                        if (!event.data || !event.data.__catSnifferEvent__) return;
                        const type = event.data.type;
                        const payload = event.data.payload;
                        if (type === "media") {
                            extractBaseUrl(payload.url || "");
                            const ext = payload.ext || getExtension(payload.url) || "";
                            postMedia({ action: "media", url: payload.url, ext: ext, source: SOURCE.WORKER });
                        } else if (type === "key") {
                            postMedia({ action: "key", key: payload.key, ext: payload.ext || "key", source: SOURCE.WORKER });
                        } else if (type === "mse") {
                            emit("mse", payload);
                        }
                    });
                    return newWorker;
                }
            } catch (e) { /* 回退 */ }
            return new hooks.orig.Worker(scriptURL, options);
        };
        self.Worker.toString = function () { return hooks.orig.Worker.toString(); };
    }

    // ----- DOM 内联 script 扫描 -----
    function scanInlineScripts() {
        if (typeof document === "undefined" || document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", scanInlineScripts, { once: true });
            return;
        }
        const patterns = [
            /["']((?:(?:https?:)?\/\/)?[^"'\s]*?\.(?:m3u8|mp4|flv|m3u|mpd|webm|ts|m4s)(?:\?[^"'\s]*)?)["']/gi
        ];
        document.querySelectorAll('script:not([src])').forEach(function (script) {
            if (!script.textContent) return;
            patterns.forEach(function (pattern) {
                let match;
                while ((match = pattern.exec(script.textContent)) !== null) {
                    let url = (match[1] || match[0] || "").replace(/['"]/g, "").trim();
                    if (!url) continue;
                    if (!url.startsWith("http")) {
                        if (url.startsWith("//")) url = (typeof location !== "undefined" ? location.protocol : "https:") + url;
                        else if (!/^https?:/.test(url)) continue;
                    }
                    const ext = getExtension(url) || "m3u8";
                    postMedia({ action: "media", url: url, ext: ext, source: SOURCE.DOM_SCRIPT });
                }
            });
        });
    }

    // ==================== 6. MSE 二进制分片捕获 ====================

    // 注意：这部分只在 opts.enableMSE === true 时启用。
    // 核心原理：代理 MediaSource.prototype.addSourceBuffer，拿到每个 SourceBuffer；
    //           再代理 SourceBuffer.appendBuffer，把每个 Uint8Array 分片通过 emit("mse") 发射。

    function hookMSE() {
        if (!opts.enableMSE || typeof self.MediaSource !== "function" || !self.MediaSource.prototype) return;

        hooks.orig.addSourceBuffer = self.MediaSource.prototype.addSourceBuffer;
        hooks.orig.endOfStream = self.MediaSource.prototype.endOfStream;

        self.MediaSource.prototype.addSourceBuffer = function (mimeType) {
            const sourceBuffer = hooks.orig.addSourceBuffer.apply(this, arguments);

            // 通知上层：新轨道出现
            emit("mse-track", { mimeType: mimeType, sourceBuffer: sourceBuffer });

            // 代理 appendBuffer
            const origAppendBuffer = sourceBuffer.appendBuffer;
            sourceBuffer.appendBuffer = function (chunk) {
                emit("mse", { mimeType: mimeType, chunk: chunk, byteLength: chunk ? chunk.byteLength : 0 });
                return origAppendBuffer.apply(this, arguments);
            };
            try { sourceBuffer.appendBuffer.toString = function () { return origAppendBuffer.toString(); }; } catch (e) {}

            return sourceBuffer;
        };
        hookToString(hooks.orig.addSourceBuffer, self.MediaSource.prototype.addSourceBuffer);

        self.MediaSource.prototype.endOfStream = function () {
            emit("mse-end", {});
            return hooks.orig.endOfStream.apply(this, arguments);
        };
        hookToString(hooks.orig.endOfStream, self.MediaSource.prototype.endOfStream);
    }

    // ==================== 7. Function.prototype.toString 双层伪装 ====================

    // 把所有代理/劫持函数的 .toString() 返回原生串，让网站反爬虫检测失效
    function patchFunctionToString() {
        if (Function.prototype.toString.__catSnifferPatched) return;
        Function.prototype.toString = new Proxy(Function.prototype.toString, {
            apply: function (target, thisArg, args) {
                // 先检查是否有预注册的原生串
                if (thisArg && thisArg.__catSnifferNativeStr) return thisArg.__catSnifferNativeStr;
                return Reflect.apply(target, thisArg, args);
            }
        });
        Function.prototype.toString.__catSnifferPatched = true;
    }

    // 辅助：注册某个 hook 的原生 toString
    function registerNativeStr(hookedFn, origFn) {
        try { hookedFn.__catSnifferNativeStr = Function.prototype.toString.call(origFn); } catch (e) {}
    }

    // ==================== 8. Worker 内自动启动 ====================
    // 在 Blob Worker 场景下，本模块会被 hookWorker 注入进去，
    // 但 Worker 里没有"外部调用 .start()"的机会，所以在这里自启动。
    if (isWorker) {
        (function autoStart() {
            opts = { ...DEFAULT_OPTS };
            patchFunctionToString();
            hookFetch(); hookXHR(); hookJSONParse(); hookTextDecoder();
            hookStringIndexOf(); hookFromCharCode(); hookArraySlice();
            hookArrayJoin(); hookBtoaAtob(); hookTypedArray();
            hookSubarray(); hookDataView();
            hookWorker();
            isRunning = true;
        })();
    }

    // ==================== 9. 公共 API ====================

    return {
        /**
         * 启动嗅探。一次性启用所有 API hook + 可选 MSE 捕获。
         * @param {object} options
         * @param {string[]} options.mediaExts  - 识别为媒体资源的扩展名
         * @param {boolean}  options.enableMSE  - 是否启用 MSE 二进制分片捕获
         * @param {boolean}  options.enableWorker - 是否在 Blob Worker 内部继续嗅探
         * @param {number}   options.maxLinks   - 去重上限
         * @param {boolean}  options.debug      - 打印调试日志
         */
        start: function (options) {
            if (isRunning) return;
            opts = { ...DEFAULT_OPTS, ...(options || {}) };

            patchFunctionToString();

            // 劫持顺序很重要：fetch / XHR / JSON.parse 这几个最常用的先上
            hookFetch();
            hookXHR();
            hookJSONParse();
            hookTextDecoder();
            hookStringIndexOf();
            hookFromCharCode();
            hookArraySlice();
            hookArrayJoin();
            hookBtoaAtob();
            hookTypedArray();
            hookSubarray();
            hookDataView();
            hookWorker();
            hookMSE();

            // 注册原生 toString
            Object.keys(hooks.orig).forEach(function (k) {
                const orig = hooks.orig[k];
                if (orig && typeof orig === "function") {
                    // 找到对应的被劫持函数
                    const hooked = (function findHooked() {
                        switch (k) {
                            case "fetch": return self.fetch;
                            case "xhrOpen": return self.XMLHttpRequest && self.XMLHttpRequest.prototype.open;
                            case "JSONparse": return JSON.parse;
                            case "textDecoderDecode": return self.TextDecoder && self.TextDecoder.prototype.decode;
                            case "indexOf": return String.prototype.indexOf;
                            case "fromCharCode": return String.fromCharCode;
                            case "arraySlice": return Array.prototype.slice;
                            case "arrayJoin": return Array.prototype.join;
                            case "btoa": return self.btoa;
                            case "atob": return self.atob;
                            case "escape": return self.escape;
                            case "DataView": return self.DataView;
                            case "addSourceBuffer": return self.MediaSource && self.MediaSource.prototype.addSourceBuffer;
                            case "endOfStream": return self.MediaSource && self.MediaSource.prototype.endOfStream;
                            default:
                                if (k.endsWith("Subarray")) {
                                    const ctor = k.replace("Subarray", "");
                                    return self[ctor] && self[ctor].prototype.subarray;
                                }
                                if (["Uint8Array", "Uint16Array", "Uint32Array"].indexOf(k) !== -1) return self[k];
                                return null;
                        }
                    })();
                    if (hooked) registerNativeStr(hooked, orig);
                }
            });

            // 内联 script 扫描（DOMContentLoaded 后自动执行）
            if (!isWorker) scanInlineScripts();

            isRunning = true;
            debug("started");
        },

        /**
         * 停止嗅探，恢复所有被劫持的 API。
         * （注意：restore 只恢复本脚本劫持过的 API，不清理之前可能已有其他脚本做的劫持。）
         */
        stop: function () {
            if (!isRunning) return;
            const o = hooks.orig;

            if (o.fetch) self.fetch = o.fetch;
            if (o.xhrOpen && self.XMLHttpRequest) self.XMLHttpRequest.prototype.open = o.xhrOpen;
            if (o.JSONparse) JSON.parse = o.JSONparse;
            if (o.textDecoderDecode && self.TextDecoder) self.TextDecoder.prototype.decode = o.textDecoderDecode;
            if (o.indexOf) String.prototype.indexOf = o.indexOf;
            if (o.fromCharCode) String.fromCharCode = o.fromCharCode;
            if (o.arraySlice) Array.prototype.slice = o.arraySlice;
            if (o.arrayJoin) Array.prototype.join = o.arrayJoin;
            if (o.btoa) self.btoa = o.btoa;
            if (o.atob) self.atob = o.atob;
            if (o.escape) self.escape = o.escape;
            if (o.DataView) self.DataView = o.DataView;
            if (o.Worker) self.Worker = o.Worker;

            ["Uint8Array", "Uint16Array", "Uint32Array"].forEach(function (n) {
                if (o[n]) self[n] = o[n];
            });
            ["Int8ArraySubarray", "Uint8ArraySubarray"].forEach(function (n) {
                const ctor = n.replace("Subarray", "");
                if (o[n] && self[ctor]) self[ctor].prototype.subarray = o[n];
            });
            if (o.addSourceBuffer && self.MediaSource) self.MediaSource.prototype.addSourceBuffer = o.addSourceBuffer;
            if (o.endOfStream && self.MediaSource) self.MediaSource.prototype.endOfStream = o.endOfStream;

            // 清理去重集合
            filter.clear();
            baseUrlSet.clear();
            joinBaseUrlQueue.length = 0;

            isRunning = false;
            debug("stopped");
        },

        /**
         * 订阅事件。事件类型：
         *   "media"     → { url, ext, href, source }   发现可下载媒体（m3u8/mpd/mp4/...）
         *   "key"       → { key, ext, href, source }   发现 DRM 解密 key（base64）
         *   "mse"       → { mimeType, chunk, byteLength }  MSE 二进制分片（逐片）
         *   "mse-track" → { mimeType, sourceBuffer }  MSE 新轨道出现
         *   "mse-end"   → {}                           MSE 流结束
         */
        on: function (type, callback) {
            if (!listeners[type]) listeners[type] = [];
            listeners[type].push(callback);
            return this;
        },

        /** 取消订阅 */
        off: function (type, callback) {
            if (!listeners[type]) return this;
            const idx = listeners[type].indexOf(callback);
            if (idx !== -1) listeners[type].splice(idx, 1);
            return this;
        },

        /** 清空所有订阅 */
        removeAllListeners: function () {
            for (const k in listeners) listeners[k] = [];
            return this;
        },

        /** 手动触发一次 DOM 内联 script 扫描（调试 / 动态加载 SPA 场景） */
        rescanInlineScripts: function () { scanInlineScripts(); },

        /** 当前嗅探器是否运行中 */
        get running() { return isRunning; },

        /** 当前去重集合大小（可用于调试） */
        get filteredCount() { return filter.size }
    };
});
