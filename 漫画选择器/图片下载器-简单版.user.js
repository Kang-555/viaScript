// ==UserScript==
// @name         图片打包·精简最终版(Lite)
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
  function scanImages() {
    if (isScanning) return;
    isScanning = true;
    imgList = [];

    const lazyKeys = ["src", "data-src", "data-original", "data-lazy"];
    const temp = [];
    const rule = getRule();

    document.querySelectorAll("img").forEach((img) => {
      let src = "";
      for (let k of lazyKeys) {
        if (img[k]) {
          src = img[k];
          break;
        }
      }
      if (!src || src.startsWith("data:") || src.startsWith("blob:")) return;

      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < MIN_W && h < MIN_H) return;

      if (rule) src = src.replace(rule[0], rule[1]);
      temp.push(src);
    });

    temp.push(...getBgImgs());
    imgList = [...new Set(temp)];

    const el = document.getElementById("imgCountLite");
    if (el) el.innerText = `${imgList.length}张`;

    setTimeout(() => (isScanning = false), 300);
  }

  function fetchBlob(url) {
    return new Promise((resolve) => {
      let done = false;
      const end = (ok, blob) => {
        if (done) return;
        done = true;
        resolve({ ok, blob });
      };
      setTimeout(() => end(false), 6000);
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        responseType: "blob",
        headers: {
          Referer: location.origin,
          "User-Agent": navigator.userAgent,
        },
        onload: (r) => {
          if (
            r.status >= 200 &&
            r.status < 300 &&
            r.response &&
            r.response.size > 1024
          ) {
            end(true, r.response);
          } else end(false);
        },
        onerror: () => end(false),
        ontimeout: () => end(false),
      });
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
      let name = (document.title || "图片合集").replace(/[\\/:*?"<>|]/g, "");
      saveAs(zipBlob, name + ".zip");
      countText.innerText = `完成${successCnt}张`;
    } catch (e) {
      countText.innerText = "打包失败";
    }

    scanBtn.disabled = false;
    zipBtn.disabled = false;
  }
})();