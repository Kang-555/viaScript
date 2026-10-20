// ==UserScript==
// @name         图片链接收集器（懒加载增强版）
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  扫描网页懒加载图片链接，导出 ManHuaUrls.txt 给Termux aria2下载
// @match        *://*/*
// @grant        GM_addStyle
// @connect      *
// ==/UserScript==
(function () {
    "use strict";
    GM_addStyle(`
    #linkCollectorBox{
      position:fixed;
      top:50%;
      left:8px;
      transform:translateY(-50%);
      z-index:9999999;
      background:rgba(255,255,255,0.96);
      border:1px solid #888;
      border-radius:6px;
      padding:6px 8px;
      width:72px;
      box-shadow:0 2px 8px rgba(0,0,0,0.15);
      font-family:-apple-system,sans-serif;
      user-select:none;
    }
    #linkCollectorBox.collapsed{
      width:28px;
      padding:4px;
      cursor:pointer;
    }
    #linkCollectorBox.collapsed .lc-inner{display:none;}
    #lcToggle{
      text-align:center;
      font-size:12px;
      font-weight:bold;
      color:#555;
      cursor:pointer;
      line-height:1;
      padding:2px 0 4px;
    }
    #linkCollectorBox.collapsed #lcToggle{padding:0;}
    .lc-btn{
      display:block;
      width:100%;
      margin:3px 0;
      padding:5px 0;
      border:none;
      border-radius:4px;
      color:#fff;
      font-size:10px;
      cursor:pointer;
      transition:opacity 0.15s;
    }
    .lc-btn:hover:not(:disabled){opacity:0.85;}
    .lc-btn:disabled{opacity:0.4;cursor:not-allowed;}
    .lc-btn-scan{background:#3498db;}
    .lc-btn-txt{background:#e67e22;}
    .lc-btn-copy{background:#27ae60;}
    .lc-btn-clear{background:#95a5a6;}
    #lcStat{
      font-size:9px;
      color:#333;
      text-align:center;
      margin:4px 0;
      padding:2px;
      background:#f0f0f0;
      border-radius:3px;
      word-break:break-all;
    }
    #lcOpt{
      font-size:8px;
      color:#666;
      text-align:center;
      margin-top:4px;
      line-height:1.4;
    }
    #lcOpt input{margin:0;vertical-align:middle;}
  `);
    let imgList = [];
    const MIN_W = 400;
    const MIN_H = 300;
    const EXT_BLACKLIST = /\.(gif|bmp)(\?|#|$)/i;
    let isScanning = false;
    let boxEl = null;
    const ruleMap = {
        "588ku.com": [/!.*,/g, ""],
        "ibaotu.com": [/!.*,/g, ""],
        "doc88.com": [/_thumb\.jpg/g, ".jpg"],
        "docin.com": [/_thumb\.jpg/g, ".jpg"],
    };
    function getRule() {
        const h = location.hostname;
        for (const k in ruleMap) {
            if (h.includes(k)) return ruleMap[k];
        }
        return null;
    }
    function resolveImgSrc(img) {
        if (img.currentSrc && !img.currentSrc.startsWith("data:") && !img.currentSrc.startsWith("blob:")) {
            return img.currentSrc;
        }
        if (img.src && !img.src.startsWith("data:") && !img.src.startsWith("blob:")) {
            return img.src;
        }
        if (img.srcset) {
            const candidates = img.srcset.split(",").map((s) => s.trim()).filter(Boolean);
            if (candidates.length > 0) {
                const best = candidates[candidates.length - 1];
                return best.split(/\s+/)[0];
            }
        }
        // 【增强懒加载属性列表】
        const lazyKeys = [
            "data-src", "data-original", "data-lazy",
            "data-url", "data-lazy-src", "data-original-src",
            "data-raw", "data-img", "data-image", "data-srcset"
        ];
        for (const k of lazyKeys) {
            const v = img.getAttribute(k);
            if (v && !v.startsWith("data:") && !v.startsWith("blob:")) return v;
        }
        return "";
    }
    function waitImgLoad(img, timeout = 6000) {
        return new Promise((resolve) => {
            if (img.complete && img.naturalWidth > 0) return resolve(true);
            const timer = setTimeout(() => {
                img.removeEventListener("load", onLoad);
                img.removeEventListener("error", onLoad);
                resolve(false);
            }, timeout);
            const onLoad = () => {
                clearTimeout(timer);
                resolve(true);
            };
            img.addEventListener("load", onLoad);
            img.addEventListener("error", onLoad);
            if (!img.src) {
                const dataSrc = img.getAttribute("data-src") || img.getAttribute("data-original");
                if (dataSrc) img.src = dataSrc;
            }
        });
    }
    function getBgImgs() {
        const set = new Set();
        const arr = [];
        document.querySelectorAll("div,section,li,a").forEach((el) => {
            const bg = getComputedStyle(el).backgroundImage;
            const m = bg.match(/url\(["']?(.*?)["']?\)/);
            if (m?.[1] && !set.has(m[1]) && !EXT_BLACKLIST.test(m[1])) {
                set.add(m[1]);
                arr.push(m[1]);
            }
        });
        return arr;
    }
    async function autoScrollLoad() {
        updateStat("滚动加载中...");
        const DELAY = 400;
        const MAX_WAIT = 15000;
        const t0 = Date.now();
        let lastH = 0;
        let sameHits = 0;

        const scrollStep = async () => {
            window.scrollTo(0, document.body.scrollHeight);
            await new Promise((r) => setTimeout(r, DELAY));
            const h = document.body.scrollHeight;
            if (h === lastH) {
                sameHits++;
            } else {
                sameHits = 0;
                lastH = h;
            }
            return { h, sameHits };
        };

        await scrollStep();
        while (true) {
            if (Date.now() - t0 > MAX_WAIT) break;
            const el = document.getElementById("lcStat");
            if (el) el.innerText = `滚动加载中...(${Math.round((Date.now() - t0) / 1000)}s)`;
            const { sameHits: sh } = await scrollStep();
            if (sh >= 3) break;
        }
        window.scrollTo(0, 0);
        await new Promise((r) => setTimeout(r, 300));
    }

    async function scanImages() {
        if (isScanning) return;
        isScanning = true;
        imgList = [];

        await autoScrollLoad();

        updateStat("扫描中...");
        const rule = getRule();
        const allImgs = [...document.querySelectorAll("img")];
        if (allImgs.length === 0) {
            updateStat("无<img>");
            isScanning = false;
            return;
        }
        const waitTasks = allImgs.map((img) => waitImgLoad(img, 5000));
        await Promise.all(waitTasks);
        const temp = [];
        for (const img of allImgs) {
            const src = resolveImgSrc(img);
            if (!src) continue;
            if (EXT_BLACKLIST.test(src)) continue;
            const w = img.naturalWidth || img.width || 0;
            const h = img.naturalHeight || img.height || 0;
            if (w > 0 && h > 0 && (w < MIN_W || h < MIN_H)) continue;
            let finalUrl = src;
            try {
                finalUrl = new URL(src, location.href).href;
            } catch (_) { }
            if (rule) finalUrl = finalUrl.replace(rule[0], rule[1]);
            temp.push(finalUrl);
        }
        temp.push(...getBgImgs());
        imgList = [...new Set(temp)];
        updateStat(`${imgList.length} 条`);
        console.log(`[链接收集器] 扫描完成，共 ${imgList.length} 条链接`);
        console.group("[链接收集器] 完整链接列表");
        imgList.forEach((u, i) => console.log(`${i + 1}. ${u}`));
        console.groupEnd();
        isScanning = false;
    }
    function updateStat(text) {
        const el = document.getElementById("lcStat");
        if (el) el.innerText = text;
    }
    function downloadTxt() {
        if (imgList.length === 0) {
            alert("请先扫描");
            return;
        }
        const name = (document.title || "ManHua").trim();
        const content = `#${name}\n${imgList.join("\n")}`;
        const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "ManHuaUrls.txt";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        console.log(`[链接收集器] 已下载 ManHuaUrls.txt，共 ${imgList.length} 条`);
    }
    function copyAll() {
        if (imgList.length === 0) {
            alert("请先扫描");
            return;
        }
        const text = imgList.join("\n");
        console.log("=== urls.txt ===");
        console.log(text);
        const done = () => {
            updateStat(`已复制 ${imgList.length}`);
            setTimeout(() => updateStat(`${imgList.length} 条`), 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(done, fallbackCopy);
        } else {
            fallbackCopy();
        }
        function fallbackCopy() {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand("copy"); } catch (_) { }
            document.body.removeChild(ta);
            done();
        }
    }
    function clearList() {
        imgList = [];
        updateStat("0 条");
        console.log("[链接收集器] 已清空");
    }
    function toggleBox() {
        boxEl.classList.toggle("collapsed");
    }
    function initUI() {
        if (document.getElementById("linkCollectorBox")) return;
        boxEl = document.createElement("div");
        boxEl.id = "linkCollectorBox";
        boxEl.innerHTML = `
      <div id="lcToggle" title="折叠/展开">链</div>
      <div class="lc-inner">
        <button class="lc-btn lc-btn-scan" id="lcScan">扫描</button>
        <div id="lcStat">0 条</div>
        <button class="lc-btn lc-btn-txt" id="lcTxt">导出txt</button>
        <button class="lc-btn lc-btn-copy" id="lcCopy">复制全部</button>
        <button class="lc-btn lc-btn-clear" id="lcClear">清空</button>
      </div>
    `;
        document.body.appendChild(boxEl);
        document.getElementById("lcToggle").onclick = toggleBox;
        document.getElementById("lcScan").onclick = scanImages;
        document.getElementById("lcTxt").onclick = downloadTxt;
        document.getElementById("lcCopy").onclick = copyAll;
        document.getElementById("lcClear").onclick = clearList;
    }
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initUI);
    } else {
        initUI();
    }
})();