// ==UserScript==
// @name         图片打包·元素
// @namespace    http://tampermonkey.net/
// @version      6.5
// @description  漫画图片批量下载工具：匹配地址栏/btn链接/下载漫画文本提取作品号，在div#content中查找模板img，生成图片列表并打包下载
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @require      https://cdn.jsdelivr.net/npm/jszip@3.7.1/dist/jszip.min.js
// @require      https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  GM_addStyle(`
    #imgToolBox{
        position:fixed;
        top: 120px;
        right: 8px;
        z-index: 99999999 !important;
        background:#fff;
        border:1px solid #bbb;
        border-radius:8px;
        padding:6px;
        width:100px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.15);
    }
    #pageInput{
        width:100%;
        box-sizing:border-box;
        border:1px solid #ccc;
        border-radius:4px;
        padding:3px;
        font-size:9px;
        text-align:center;
        margin-bottom:4px;
    }
    .imgtool-btn{
        display:block;
        width:100%;
        padding:3px 0;
        margin:2px 0;
        border:none;
        border-radius:4px;
        cursor:pointer;
        font-size:9px;
    }
    .imgtool-btn:disabled{opacity:0.5;cursor:not-allowed;}
    .btn-step1{background:#4a90e2;color:#fff;}
    .btn-step2{background:#9b59b6;color:#fff;}
    .btn-step3{background:#67c23a;color:#fff;}
    #imgCount{
        font-size:8px;
        color:#333;
        text-align:center;
        margin:2px 0;
        line-height:1.5;
        word-break:break-all;
    }
    [data-theme="dark"] #imgToolBox {
        background: rgba(20,20,23,0.95);
        border-color: rgba(255,255,255,0.2);
    }
    [data-theme="dark"] #imgCount {
        color: #ccc;
    }
    [data-theme="dark"] #pageInput {
        background:#333;
        color:#eee;
        border-color:#555;
    }
    .zip-anim {
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #67c23a;
        animation: zipAnim 1s infinite linear;
        margin-left: 2px;
    }
    @keyframes zipAnim {
        0% { transform: scale(0.5); opacity: 0.5; }
        50% { transform: scale(1.2); opacity: 1; }
        100% { transform: scale(0.5); opacity: 0.5; }
    }
    .dot-anim span{
        display:inline-block;
        animation: dot 1.4s infinite;
    }
    .dot-anim span:nth-child(2){animation-delay:0.2s;}
    .dot-anim span:nth-child(3){animation-delay:0.4s;}
    @keyframes dot{
        0%,100%{opacity:0.2;transform:scale(0.8);}
        50%{opacity:1;transform:scale(1);}
    }
  `);

  let imgList = [];
  let templateInfo = null;
  let bookPath = null;
  const MAX_CONCUR = 6;

  function initUI() {
    if (document.getElementById("imgToolBox")) return;
    const wrap = document.createElement("div");
    wrap.id = "imgToolBox";
    wrap.innerHTML = `
      <button class="imgtool-btn btn-step1" id="step1Btn">解析作品号</button>
      <div id="imgCount">步骤1：解析作品号</div>
      <button class="imgtool-btn btn-step2" id="step2Btn" style="display:none;">解析模板链接</button>
      <input type="number" id="pageInput" placeholder="输入总页数" style="display:none;">
      <button class="imgtool-btn btn-step3" id="step3Btn" style="display:none;">打包下载</button>
    `;
    (document.body || document.documentElement).appendChild(wrap);
    document.getElementById("step1Btn").onclick = parseBookId;
    document.getElementById("step2Btn").onclick = parseTemplateUrl;
    document.getElementById("step3Btn").onclick = doZip;
    document.getElementById("pageInput").addEventListener("input", genByInputPage);
  }
  initUI();

  /**
   * 步骤1：解析作品号
   * 从地址栏或页面链接中提取6位数字ID，格式化为 xxxx/xx
   */
  function parseBookId() {
    const countEl = document.getElementById("imgCount");
    const step1Btn = document.getElementById("step1Btn");
    const step2Btn = document.getElementById("step2Btn");
    
    let foundUrl = null;
    let bookId = null;

    // 优先从地址栏URL提取
    const currentUrl = window.location.href;
    if (currentUrl.includes('.html') && currentUrl.includes('-')) {
      foundUrl = currentUrl;
    }

    // 其次查找class包含btn的链接
    if (!foundUrl) {
      const btnLinks = document.querySelectorAll('a.btn, a[class*="btn"]');
      for (const link of btnLinks) {
        const href = link.getAttribute('href');
        const text = link.textContent || link.innerText || '';
        if ((href && href.includes('.html')) && (text.includes('下载漫画') || href.includes('-'))) {
          foundUrl = href;
          break;
        }
      }
    }

    // 最后遍历所有链接查找包含"下载漫画"文本的链接
    if (!foundUrl) {
      const allLinks = document.querySelectorAll('a');
      for (const link of allLinks) {
        const href = link.getAttribute('href');
        const text = link.textContent || link.innerText || '';
        if (text.includes('下载漫画') && href && href.includes('.html')) {
          foundUrl = href;
          break;
        }
      }
    }

    // 提取6位数字ID
    if (foundUrl) {
      const idMatch = foundUrl.match(/-(\d{6})\.html/i);
      if (idMatch) {
        bookId = idMatch[1];
        bookPath = `${bookId.substring(0, 4)}/${bookId.substring(4, 6)}`;
        countEl.innerText = `作品号: ${bookPath}`;
        step2Btn.style.display = "block";
        step1Btn.disabled = true;
        return;
      }
    }

    countEl.innerText = "解析作品号失败";
    step2Btn.style.display = "none";
    step1Btn.disabled = false;
  }

  /**
   * 步骤2：解析模板链接
   * 在div#content中查找包含作品号路径的img标签，提取完整模板URL
   */
  function parseTemplateUrl() {
    const countEl = document.getElementById("imgCount");
    const step2Btn = document.getElementById("step2Btn");
    const step3Btn = document.getElementById("step3Btn");
    const pageInput = document.getElementById("pageInput");

    if (!bookPath) {
      countEl.innerText = "请先解析作品号";
      return;
    }

    const contentDiv = document.getElementById('content');
    if (!contentDiv) {
      countEl.innerText = "解析模板链接失败";
      return;
    }

    const imgs = contentDiv.querySelectorAll('img');
    let templateUrl = null;
    
    for (const img of imgs) {
      const src = img.getAttribute('src');
      if (src && src.includes(bookPath)) {
        templateUrl = src;
        break;
      }
    }

    if (templateUrl) {
      const urlMatch = templateUrl.match(/\/data\/\d+\/\d+\/(\d+)\.(\w+)/i);
      const numDigits = urlMatch ? urlMatch[1].length : 3;
      const ext = urlMatch ? urlMatch[2].toLowerCase() : 'jpg';
      
      templateInfo = {
        host: templateUrl.replace(/\/data\/.+$/, ''),
        book: bookPath.split('/')[0],
        chap: bookPath.split('/')[1],
        numDigits: numDigits,
        ext: ext,
      };

      countEl.innerText = `模板: ${templateUrl}`;
      pageInput.style.display = "block";
      step3Btn.style.display = "none";
      step2Btn.disabled = true;
    } else {
      countEl.innerText = "解析模板链接失败";
      pageInput.style.display = "none";
      step3Btn.style.display = "none";
      step2Btn.disabled = false;
    }
  }

  /**
   * 根据输入的页数生成图片URL列表
   */
  function genByInputPage() {
    if (!templateInfo) return;
    const input = document.getElementById("pageInput");
    const total = parseInt(input.value, 10);
    const countEl = document.getElementById("imgCount");
    const step3Btn = document.getElementById("step3Btn");

    if (isNaN(total) || total < 1) {
      countEl.innerText = `模板: ${templateInfo.host}/data/${templateInfo.book}/${templateInfo.chap}/xxx.${templateInfo.ext}`;
      imgList = [];
      step3Btn.style.display = "none";
      return;
    }

    imgList = [];
    const numDigits = templateInfo.numDigits || 3;
    const ext = templateInfo.ext || 'jpg';
    for (let i = 1; i <= total; i++) {
      const num = String(i).padStart(numDigits, "0");
      const url = `${templateInfo.host}/data/${templateInfo.book}/${templateInfo.chap}/${num}.${ext}`;
      imgList.push(url);
    }
    countEl.innerText = `共${imgList.length}张图片`;
    step3Btn.style.display = "block";
  }

  async function fetchBlob(url, retries = 3, timeout = 15000) {
    for (let i = 0; i < retries; i++) {
      const result = await new Promise((resolve) => {
        let done = false;
        const end = (ok, blob) => {
          if (done) return;
          done = true;
          resolve({ ok, blob });
        };
        const timer = setTimeout(() => end(false), timeout);
        GM_xmlhttpRequest({
          method: "GET",
          url: url,
          responseType: "blob",
          headers: {
            Referer: url,
            "User-Agent": navigator.userAgent,
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          },
          onload: (r) => {
            clearTimeout(timer);
            if (r.status >= 200 && r.status < 300 && r.response && r.response.size > 0) {
              end(true, r.response);
            } else end(false);
          },
          onerror: () => { clearTimeout(timer); end(false); },
          ontimeout: () => end(false),
        });
      });
      if (result.ok) return result;
      if (i < retries - 1) await new Promise(r => setTimeout(r, 500));
    }
    return { ok: false, blob: null };
  }

  function getExt(url) {
    const m = url.match(/\.(\w+)(\?|#|$)/);
    let e = m ? m[1].toLowerCase() : "jpg";
    return ["jpg", "jpeg", "png", "gif", "webp"].includes(e) ? e : "jpg";
  }

  async function processQueue(tasks, concurrency) {
    const results = [];
    const executing = new Set();
    for (const task of tasks) {
      const p = task().then((res) => {
        executing.delete(p);
        return res;
      });
      results.push(p);
      executing.add(p);
      if (executing.size >= concurrency) await Promise.race(executing);
    }
    return Promise.all(results);
  }

  async function doZip() {
    if (!imgList || imgList.length === 0) {
      alert("请先输入页数");
      return;
    }
    const step3Btn = document.getElementById("step3Btn");
    const countText = document.getElementById("imgCount");

    step3Btn.disabled = true;
    countText.innerHTML = '下载中...';

    const zip = new JSZip();
    let done = 0, success = 0, failCount = 0;
    const total = imgList.length;
    const failUrls = [];

    const tasks = imgList.map((src, i) => async () => {
      const res = await fetchBlob(src);
      done++;
      if (res.ok) {
        success++;
        const ext = getExt(src);
        zip.file(`pic_${String(i + 1).padStart(3, "0")}.${ext}`, res.blob);
      } else {
        failCount++;
        failUrls.push({ url: src, index: i });
      }
      countText.innerHTML = `${done}/${total}`;
    });

    await processQueue(tasks, MAX_CONCUR);

    if (failCount > 0 && failUrls.length > 0) {
      countText.innerHTML = `查漏补缺中... (${failCount}张)`;
      
      for (const item of failUrls) {
        const res = await fetchBlob(item.url);
        if (res.ok) {
          const ext = getExt(item.url);
          zip.file(`pic_${String(item.index + 1).padStart(3, "0")}.${ext}`, res.blob);
          success++;
          failCount--;
        }
      }
      
      if (failCount > 0) {
        const failedList = failUrls.filter(item => {
          const idx = imgList.indexOf(item.url);
          return !zip.file(`pic_${String(idx + 1).padStart(3, "0")}.${getExt(item.url)}`);
        }).map(item => item.url);
        zip.file("_下载失败清单.txt", `以下图片下载失败（已跳过）：\n\n${failedList.join("\n")}`);
      }
    }

    if (success === 0) {
      countText.innerHTML = "全部失败";
    } else {
      countText.innerHTML = `打包中 <span class="zip-anim"></span>`;
      try {
        const blob = await zip.generateAsync({
          type: "blob",
          compression: "STORE",
        });
        const name = (document.title || "漫画图集").replace(
          /[\\/:*?"<>|]/g,
          "",
        );
        saveAs(blob, `${name}.zip`);
        countText.innerHTML = failCount > 0 ? `成功${success}张，失败${failCount}张` : `成功${success}张`;
      } catch {
        countText.innerHTML = "打包失败";
      }
    }
    step3Btn.disabled = false;
  }
})();