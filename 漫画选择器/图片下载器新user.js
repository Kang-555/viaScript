// ==UserScript==
// @name         图片打包·新
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  无清空、不累加、仅扫描打包、等图片加载再扫、超小按钮稳定不空包
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @require      https://cdn.jsdelivr.net/npm/jszip@3.7.1/dist/jszip.min.js
// @require      https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js
// @connect      *
// ==/UserScript==

(function () {
  "use strict";

  GM_addStyle(`
        #imgToolBoxLite{
            position:fixed;
            top:60px;
            left:5px;
            z-index:9999998 !important;
            background:#fff;
            border:1px solid #bbb;
            border-radius:4px;
            padding:2px;
            width:65px;
        }
        .imgtool-btn-lite{
            display:block;
            width:100%;
            padding:2px 0;
            margin:1px 0;
            border:none;
            border-radius:2px;
            cursor:pointer;
            font-size:8px;
        }
        .imgtool-btn-lite:disabled{opacity:0.5;cursor:not-allowed;}
        .btn-scan-lite{background:#e74c3c;color:#fff;}
        .btn-zip-lite{background:#9b59b6;color:#fff;}
        #imgCountLite{
            font-size:7px;
            color:#333;
            text-align:center;
            margin:1px 0;
        }
    `);

  let imgList = [];
  const MIN_W = 1100;
  const MIN_H = 200;
  const MAX_CONCUR = 6;
  let isScanning = false;

  function initUI() {
    if (document.getElementById("imgToolBoxLite")) return;
    const wrap = document.createElement("div");
    wrap.id = "imgToolBoxLite";
    wrap.innerHTML = `
            <button class="imgtool-btn-lite btn-scan-lite" id="scanBtnLite">扫描</button>
            <div id="imgCountLite">0张</div>
            <button class="imgtool-btn-lite btn-zip-lite" id="zipBtnLite">打包</button>
        `;
    document.body.appendChild(wrap);

    document.getElementById("scanBtnLite").onclick = scanImages;
    document.getElementById("zipBtnLite").onclick = doZip;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initUI);
  } else {
    initUI();
  }

  const ruleMap = {
    "588ku.com": [/!.*,/g, ""],
    "ibaotu.com": [/!.*,/g, ""],
    "doc88.com": [/_thumb\.jpg/g, ".jpg"],
    "docin.com": [/_thumb\.jpg/g, ".jpg"],
  };

  function getRule() {
    const h = location.hostname;
    for (let k in ruleMap) {
      if (h.includes(k)) return ruleMap[k];
    }
    return null;
  }

  function getBgImgs() {
    const set = new Set();
    const arr = [];
    document.querySelectorAll("div,section,li,a").forEach((el) => {
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m?.[1] && !set.has(m[1])) {
        set.add(m[1]);
        arr.push(m[1]);
      }
    });
    return arr;
  }

  // 每次扫描重置列表，不累加
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
    const lazyKeys = [
      "data-src", "data-original", "data-lazy",
      "data-url", "data-lazy-src", "data-original-src",
    ];
    for (const k of lazyKeys) {
      const v = img.getAttribute(k);
      if (v && !v.startsWith("data:") && !v.startsWith("blob:")) return v;
    }
    return "";
  }

  function waitImgLoad(img, timeout = 8000) {
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

  async function scanImages() {
    if (isScanning) return;
    isScanning = true;
    imgList = [];

    const countEl = document.getElementById("imgCountLite");
    const rule = getRule();
    const allImgs = [...document.querySelectorAll("img")];
    if (allImgs.length === 0) {
      if (countEl) countEl.innerText = "无图片";
      isScanning = false;
      return;
    }

    if (countEl) countEl.innerText = `加载中0/${allImgs.length}`;

    const waitTasks = allImgs.map((img) => waitImgLoad(img, 6000));
    await Promise.all(waitTasks);

    if (countEl) countEl.innerText = `解析中...`;

    const temp = [];
    for (const img of allImgs) {
      const src = resolveImgSrc(img);
      if (!src) continue;

      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < MIN_W && h < MIN_H) continue;

      let finalUrl = src;
      try {
        finalUrl = new URL(src, location.href).href;
      } catch (_) { }
      if (rule) finalUrl = finalUrl.replace(rule[0], rule[1]);
      temp.push(finalUrl);
    }

    temp.push(...getBgImgs());
    imgList = [...new Set(temp)];

    if (countEl) countEl.innerText = `${imgList.length}张`;
    isScanning = false;
  }

  function fetchBlob(url, retries = 2) {
    const refererHosts = [location.href, location.origin];
    return new Promise((resolve) => {
      let done = false;
      let attempt = 0;
      const end = (ok, blob) => {
        if (done) return;
        done = true;
        resolve({ ok, blob });
      };
      const tryReq = () => {
        if (attempt > retries) return end(false);
        const ref = refererHosts[attempt % refererHosts.length];
        attempt++;
        const timer = setTimeout(() => end(false), 10000);
        GM_xmlhttpRequest({
          method: "GET",
          url: url,
          responseType: "blob",
          headers: {
            Referer: ref,
            "User-Agent": navigator.userAgent,
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          },
          onload: (r) => {
            clearTimeout(timer);
            if (
              r.status >= 200 &&
              r.status < 300 &&
              r.response &&
              r.response.size > 1024
            ) {
              end(true, r.response);
            } else if (attempt <= retries) {
              setTimeout(tryReq, 300);
            } else {
              end(false);
            }
          },
          onerror: () => { clearTimeout(timer); end(false); },
          ontimeout: () => { clearTimeout(timer); end(false); },
        });
      };
      tryReq();
    });
  }

  function getExt(url) {
    const m = url.match(/\.(\w+)(\?|#|$)/);
    let e = m ? m[1].toLowerCase() : "jpg";
    return ["jpg", "jpeg", "png", "gif", "webp"].includes(e) ? e : "jpg";
  }

  async function runLimit(tasks, limit) {
    let idx = 0;
    async function work() {
      while (idx < tasks.length) await tasks[idx++]();
    }
    await Promise.all(Array.from({ length: limit }, work));
  }

  async function doZip() {
    if (imgList.length === 0) {
      alert("请等图片加载完再扫描");
      return;
    }
    const scanBtn = document.getElementById("scanBtnLite");
    const zipBtn = document.getElementById("zipBtnLite");
    const countText = document.getElementById("imgCountLite");

    scanBtn.disabled = true;
    zipBtn.disabled = true;
    countText.innerText = "处理中";

    const zip = new JSZip();
    let done = 0;
    let successCnt = 0;
    const total = imgList.length;

    const tasks = imgList.map((src, i) => async () => {
      const res = await fetchBlob(src);
      if (res.ok) {
        successCnt++;
        const ext = getExt(src);
        zip.file(`pic_${String(i + 1).padStart(3, "0")}.${ext}`, res.blob);
      }
      done++;
      if (done % 5 === 0 || done === total) {
        countText.innerText = `${done}/${total}`;
      }
    });

    await runLimit(tasks, MAX_CONCUR);

    if (successCnt === 0) {
      countText.innerText = "无有效图";
      scanBtn.disabled = false;
      zipBtn.disabled = false;
      return;
    }

    try {
      const zipBlob = await zip.generateAsync({
        type: "blob",
        compression: "STORE",
      });
      const name = (document.title || "图片合集").replace(
        /[\\/:*?"<>|]/g,
        "",
      );
      window.saveAs(zipBlob, `${name}.zip`);
      countText.innerText = `完成${successCnt}张`;
    } catch (e) {
      countText.innerText = "打包失败";
    }

    scanBtn.disabled = false;
    zipBtn.disabled = false;
  }
})();