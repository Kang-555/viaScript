// ==UserScript==
// @name         漫画 page_url 提取器
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Hook mReader.initData 在数据产生瞬间捕获，无需等待渲染
// @match        *://*/*
// @connect      *
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// ==/UserScript==
(function () {
    "use strict";

    const __STYLE__ = `
    #mPageUrlBox{
      position:fixed;
      top:50%;
      left:8px;
      transform:translateY(-50%);
      z-index:9999999;
      background:rgba(255,255,255,0.97);
      border:1px solid #666;
      border-radius:8px;
      padding:8px 10px;
      width:130px;
      box-shadow:0 2px 10px rgba(0,0,0,0.2);
      font-family:-apple-system,sans-serif;
      user-select:none;
    }
    #mPageUrlBox.collapsed{width:30px;padding:5px;cursor:pointer;}
    #mPageUrlBox.collapsed .m-inner{display:none;}
    #mPageUrlBox.collapsed #mToggle{padding:0;}
    #mToggle{
      text-align:center;font-size:13px;font-weight:bold;color:#2c3e50;
      cursor:pointer;line-height:1;padding:2px 0 6px;
    }
    .m-btn{
      display:block;width:100%;margin:4px 0;padding:6px 0;border:none;
      border-radius:5px;color:#fff;font-size:11px;cursor:pointer;
      transition:opacity 0.15s;
    }
    .m-btn:hover:not(:disabled){opacity:0.85;}
    .m-btn:disabled{opacity:0.4;cursor:not-allowed;}
    .m-btn-scan{background:#2980b9;}
    .m-btn-txt{background:#d35400;}
    .m-btn-copy{background:#27ae60;}
    .m-btn-clear{background:#7f8c8d;}
    #mStat{
      font-size:10px;color:#2c3e50;text-align:center;margin:5px 0;padding:3px;
      background:#ecf0f1;border-radius:4px;word-break:break-all;min-height:14px;
    }
    #mSource{font-size:9px;color:#888;text-align:center;margin-bottom:4px;}
    #mHint{font-size:9px;color:#e74c3c;text-align:center;margin-top:4px;}
    `;

    const __styleEl = document.createElement("style");
    __styleEl.textContent = __STYLE__;
    (document.head || document.documentElement).appendChild(__styleEl);

    let imgList = [];
    let listSource = "";
    let boxEl = null;
    let autoCaptured = false;
    const EXT_BLACKLIST = /\.(gif|bmp)(\?|#|$)/i;
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

    function captureUrls(urls, source) {
        if (!Array.isArray(urls) || urls.length === 0) return false;
        const cleaned = urls
            .map(u => String(u).trim())
            .filter(u => u && !u.startsWith("data:") && !u.startsWith("blob:"))
            .map(u => {
                let fixed = u.replace(/^`|`$/g, "").replace(/^['"]|['"]$/g, "").trim();
                try { fixed = new URL(fixed, location.href).href; } catch (_) { }
                return fixed;
            })
            .filter(u => u && !EXT_BLACKLIST.test(u));
        const deduped = [...new Set(cleaned)];
        if (deduped.length > 0) {
            imgList = deduped;
            listSource = source;
            autoCaptured = true;
            finishScan();
            return true;
        }
        return false;
    }

    // =============== 核心：主动 Hook mReader.initData ===============
    // 脚本在 document-start 注入，此时页面 JS 还没执行
    // 我们轮询找到 mReader，立刻 hook 它的 initData 方法
    // 数据在页面 JS 调用 initData({page_url: [...]}) 的瞬间就被捕获
    // 完全不需要等 DOMContentLoaded 或图片渲染

    function getUw() {
        try { return typeof unsafeWindow !== "undefined" ? unsafeWindow : window; }
        catch (_) { return window; }
    }

    function tryHookReader() {
        const uw = getUw();

        // 方式1：直接 hook 已存在的 mReader.initData
        if (uw.mReader && typeof uw.mReader.initData === "function" && !uw.mReader.__puHooked) {
            const orig = uw.mReader.initData;
            uw.mReader.initData = function (data) {
                if (data && Array.isArray(data.page_url) && !autoCaptured) {
                    captureUrls(data.page_url, "hook:mReader.initData");
                }
                return orig.apply(this, arguments);
            };
            uw.mReader.__puHooked = true;
            return true;
        }

        // 方式2：hook 全局 initData
        if (typeof uw.initData === "function" && !uw.__puInitDataHooked) {
            const orig = uw.initData;
            uw.initData = function (data) {
                if (data && Array.isArray(data.page_url) && !autoCaptured) {
                    captureUrls(data.page_url, "hook:global.initData");
                }
                return orig.apply(this, arguments);
            };
            uw.__puInitDataHooked = true;
            return true;
        }

        // 方式3：遍历全局对象，找到任何 initData 函数并 hook
        try {
            for (const key of Object.keys(uw)) {
                if (key.startsWith("__pu")) continue;
                try {
                    const v = uw[key];
                    if (v && typeof v === "object" && typeof v.initData === "function" && !v.__puHooked) {
                        const orig = v.initData;
                        v.initData = function (data) {
                            if (data && Array.isArray(data.page_url) && !autoCaptured) {
                                captureUrls(data.page_url, "hook:" + key + ".initData");
                            }
                            return orig.apply(this, arguments);
                        };
                        v.__puHooked = true;
                        return true;
                    }
                } catch (_) { }
            }
        } catch (_) { }

        return false;
    }

    // 在 document-start 就开始高频轮询，抢在页面 JS 执行之前 hook 上
    let hookTimer = setInterval(() => {
        tryHookReader();
        if (autoCaptured) {
            clearInterval(hookTimer);
            hookTimer = null;
        }
    }, 30);

    // 5秒后停止轮询（兜底，防止页面根本没有 mReader）
    setTimeout(() => {
        if (hookTimer) {
            clearInterval(hookTimer);
            hookTimer = null;
        }
    }, 5000);

    // =============== 手动扫描（兜底 / 重扫） ===============

    function extractFromGlobal() {
        const uw = getUw();
        if (uw.mReader && uw.mReader.initData && Array.isArray(uw.mReader.initData.page_url)) {
            return captureUrls(uw.mReader.initData.page_url, "mReader.initData");
        }
        if (uw.initData && Array.isArray(uw.initData.page_url)) {
            return captureUrls(uw.initData.page_url, "global.initData");
        }
        for (const key of Object.keys(uw)) {
            try {
                const v = uw[key];
                if (v && typeof v === "object" && Array.isArray(v.page_url) && v.page_url.length > 2) {
                    return captureUrls(v.page_url, "global." + key + ".page_url");
                }
            } catch (_) { }
        }
        return false;
    }

    function extractFromHtmlSource() {
        try {
            const html = document.documentElement.outerHTML;
            const m = html.match(/"page_url"\s*:\s*(\[[\s\S]*?\])/);
            if (m) {
                try { return captureUrls(JSON.parse(m[1]), "HTML正则"); }
                catch (_) {
                    const urls = m[1].match(/["'`]?(https?:\/\/[^"'`\]]+?)["'`]?/g);
                    if (urls) return captureUrls(urls.map(s => s.replace(/^["'`]|["'`]$/g, "")), "HTML正则(宽松)");
                }
            }
        } catch (_) { }
        return false;
    }

    async function fetchAndExtract() {
        return new Promise(resolve => {
            try {
                GM_xmlhttpRequest({
                    method: "GET", url: location.href, responseType: "text",
                    timeout: 8000,
                    onload: res => {
                        if (!res.responseText) { resolve(false); return; }
                        const m = res.responseText.match(/"page_url"\s*:\s*(\[[\s\S]*?\])/);
                        if (m) {
                            try { resolve(captureUrls(JSON.parse(m[1]), "GM源码")); return; }
                            catch (_) {
                                const urls = m[1].match(/["'`]?(https?:\/\/[^"'`\]]+?)["'`]?/g);
                                if (urls) { resolve(captureUrls(urls.map(s => s.replace(/^["'`]|["'`]$/g, "")), "GM源码(宽松)")); return; }
                            }
                        }
                        resolve(false);
                    },
                    onerror: () => resolve(false),
                    ontimeout: () => resolve(false)
                });
            } catch (_) { resolve(false); }
        });
    }

    async function scanImages() {
        if (autoCaptured && imgList.length > 0) {
            finishScan();
            return;
        }
        imgList = [];
        listSource = "";
        updateStat("扫描中...");
        updateSource("");

        // 再试一次 hook（可能页面 JS 刚执行完）
        tryHookReader();
        if (autoCaptured) return;

        if (extractFromGlobal()) return;
        if (extractFromHtmlSource()) return;

        updateStat("请求源码...");
        const hit = await fetchAndExtract();
        if (hit) return;

        updateStat("未找到");
        updateSource("所有策略均未命中");
    }

    function finishScan() {
        updateStat(`${imgList.length} 条`);
        updateSource(listSource ? "来源: " + listSource : "");
        console.log(`[page_url提取器] 来源=${listSource}, 共 ${imgList.length} 条`);
    }

    function updateStat(text) { const el = document.getElementById("mStat"); if (el) el.innerText = text; }
    function updateSource(text) { const el = document.getElementById("mSource"); if (el) el.innerText = text; }

    // =============== 导出功能 ===============

    function safeName(s) { return String(s || "ManHua").replace(/[\\/:*?"<>|]/g, "_"); }
    function processBaseName(base) {
        let name = String(base || "").trim();
        if (/《([^》]+)》/.test(name)) name = name.match(/《([^》]+)》/)[1];
        else name = name.replace(/[-_][0-9]+$/, "");
        return safeName(name);
    }
    function extractFilename(url, idx) {
        try {
            const pathname = new URL(url).pathname;
            let name = pathname.split("/").filter(Boolean).pop() || "";
            name = name.split("?")[0].split("#")[0];
            if (name && /\.[a-zA-Z0-9]{2,5}$/.test(name)) return safeName(name);
        } catch (_) { }
        return `img_${String(idx + 1).padStart(3, "0")}.jpg`;
    }
    function buildBatchText() {
        const base = processBaseName(document.title || "ManHua");
        const dirPath = `/sdcard/Download/${base}`;
        const lines = [`mkdir -p "${dirPath}"`];
        imgList.forEach((url, idx) => {
            const fname = extractFilename(url, idx);
            const parts = [
                `curl -L "${url}"`,
                `-H "User-Agent: Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129.0.0.0 Mobile Safari/537.36"`,
                `-H "Referer: ${location.href}"`,
                "--connect-timeout 15", "--retry 3", "--retry-delay 2",
                `-o "${dirPath}/${fname}"`,
            ];
            lines.push(parts.join(" \\\n  "));
        });
        lines.push(`cd "${dirPath}"`);
        lines.push(`zip -r "/sdcard/Download/${base}.zip" ./*`);
        lines.push(`rm -rf "${dirPath}"`);
        lines.push(`echo "OK ${base} done"`);
        return lines.join("\n");
    }

    function copyToClipboard(text) {
        return new Promise(resolve => {
            if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(() => resolve(true), () => fallbackCopy(text, resolve));
            } else {
                fallbackCopy(text, resolve);
            }
        });
    }

    function fallbackCopy(text, resolve) {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.top = "-9999px";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); resolve(true); }
        catch (_) { resolve(false); }
        ta.remove();
    }

    function downloadTxt() {
        if (imgList.length === 0) { alert("请先扫描"); return; }
        const base = processBaseName(document.title || "ManHua");
        const content = buildBatchText();
        const filename = base + ".txt";

        if (isIOS) {
            const url = "data:text/plain;charset=utf-8," + encodeURIComponent(content);
            const w = window.open(url, "_blank");
            if (!w) location.href = url;
            updateStat("iOS: 长按文本 → 存储到文件");
            setTimeout(() => updateStat(`${imgList.length} 条`), 2500);
            return;
        }

        try {
            const blob = new Blob([content], { type: "text/plain" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.style.display = "none";
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            updateStat(`已导出 ${filename}`);
            setTimeout(() => updateStat(`${imgList.length} 条`), 2000);
        } catch (e) {
            copyToClipboard(content).then(ok => {
                updateStat(ok ? "下载失败，已复制" : "导出失败");
                setTimeout(() => updateStat(`${imgList.length} 条`), 2500);
            });
        }
    }

    function copyAll() {
        if (imgList.length === 0) { alert("请先扫描"); return; }
        const text = imgList.join("\n");
        copyToClipboard(text).then(ok => {
            updateStat(ok ? `已复制 ${imgList.length}` : "复制失败");
            setTimeout(() => updateStat(`${imgList.length} 条`), 1500);
        });
    }

    function clearList() {
        imgList = []; listSource = ""; autoCaptured = false;
        updateStat("0 条"); updateSource("");
    }
    function toggleBox() { boxEl.classList.toggle("collapsed"); }

    function initUI() {
        if (document.getElementById("mPageUrlBox")) return;
        boxEl = document.createElement("div");
        boxEl.id = "mPageUrlBox";
        boxEl.innerHTML = `
      <div id="mToggle" title="折叠/展开">PU</div>
      <div class="m-inner">
        <button class="m-btn m-btn-scan" id="mScan">扫描</button>
        <div id="mStat">0 条</div>
        <div id="mSource"></div>
        <button class="m-btn m-btn-txt" id="mTxt">导出txt</button>
        <button class="m-btn m-btn-copy" id="mCopy">复制全部</button>
        <button class="m-btn m-btn-clear" id="mClear">清空</button>
      </div>`;
        document.body.appendChild(boxEl);
        document.getElementById("mToggle").onclick = toggleBox;
        document.getElementById("mScan").onclick = scanImages;
        document.getElementById("mTxt").onclick = downloadTxt;
        document.getElementById("mCopy").onclick = copyAll;
        document.getElementById("mClear").onclick = clearList;
    }

    function waitBodyAndInit() {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", initUI, { once: true });
        } else if (document.body) {
            initUI();
        } else {
            const observer = new MutationObserver(() => {
                if (document.body) { observer.disconnect(); initUI(); }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
        }
    }
    waitBodyAndInit();
})();