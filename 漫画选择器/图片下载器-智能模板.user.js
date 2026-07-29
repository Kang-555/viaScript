// ==UserScript==
// @name         图片打包·智能模板
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  智能模板分析：取5个样本分析规律，验证后批量下载
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
    #imgToolBoxSmart{
        position:fixed;
        top: 180px;
        right: 8px;
        z-index: 99999999 !important;
        background:#fff;
        border:1px solid #bbb;
        border-radius:8px;
        padding:6px;
        width:120px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.15);
    }
    #pageInputSmart{
        width:100%;
        box-sizing:border-box;
        border:1px solid #ccc;
        border-radius:4px;
        padding:3px;
        font-size:9px;
        text-align:center;
        margin-bottom:4px;
    }
    .imgtool-btn-smart{
        display:block;
        width:100%;
        padding:3px 0;
        margin:2px 0;
        border:none;
        border-radius:4px;
        cursor:pointer;
        font-size:9px;
    }
    .imgtool-btn-smart:disabled{opacity:0.5;cursor:not-allowed;}
    .btn-step1-smart{background:#4a90e2;color:#fff;}
    .btn-step2-smart{background:#9b59b6;color:#fff;}
    .btn-step3-smart{background:#67c23a;color:#fff;}
    #imgCountSmart{
        font-size:8px;
        color:#333;
        text-align:center;
        margin:2px 0;
        line-height:1.5;
        word-break:break-all;
    }
    [data-theme="dark"] #imgToolBoxSmart {
        background: rgba(20,20,23,0.95);
        border-color: rgba(255,255,255,0.2);
    }
    [data-theme="dark"] #imgCountSmart {
        color: #ccc;
    }
    [data-theme="dark"] #pageInputSmart {
        background:#333;
        color:#eee;
        border-color:#555;
    }
  `);

  let templatePattern = null;  // 分析出的模板规律
  let sampleUrls = [];         // 收集的5个样本URL
  const MAX_CONCUR = 6;
  const SAMPLE_COUNT = 5;      // 收集样本数量
  const VERIFY_COUNT = 5;      // 验证数量

  function initUI() {
    if (document.getElementById("imgToolBoxSmart")) return;
    const wrap = document.createElement("div");
    wrap.id = "imgToolBoxSmart";
    wrap.innerHTML = `
      <button class="imgtool-btn-smart btn-step1-smart" id="step1BtnSmart">分析模板</button>
      <div id="imgCountSmart">步骤1：分析模板规律</div>
      <button class="imgtool-btn-smart btn-step2-smart" id="step2BtnSmart" style="display:none;">验证规律</button>
      <input type="number" id="pageInputSmart" placeholder="输入总页数" style="display:none;">
      <button class="imgtool-btn-smart btn-step3-smart" id="step3BtnSmart" style="display:none;">打包下载</button>
    `;
    (document.body || document.documentElement).appendChild(wrap);
    document.getElementById("step1BtnSmart").onclick = analyzeTemplates;
    document.getElementById("step2BtnSmart").onclick = verifyPattern;
    document.getElementById("step3BtnSmart").onclick = doZip;
    document.getElementById("pageInputSmart").addEventListener("input", onPageInput);
  }
  initUI();

  /**
   * 步骤1：分析模板
   * 从页面收集5个图片URL样本，分析出页码规律
   */
  async function analyzeTemplates() {
    const countEl = document.getElementById("imgCountSmart");
    const step1Btn = document.getElementById("step1BtnSmart");
    const step2Btn = document.getElementById("step2BtnSmart");

    countEl.innerText = "收集中...";
    step1Btn.disabled = true;

    // 收集5个样本URL
    sampleUrls = collectSampleUrls(SAMPLE_COUNT);

    if (sampleUrls.length < 2) {
      countEl.innerText = `样本不足(仅${sampleUrls.length}个)`;
      step1Btn.disabled = false;
      return;
    }

    countEl.innerText = `收集${sampleUrls.length}个样本`;

    // 分析规律
    templatePattern = analyzePattern(sampleUrls);

    if (!templatePattern) {
      countEl.innerText = "无法分析规律";
      step1Btn.disabled = false;
      return;
    }

    countEl.innerText = `规律: ${templatePattern.prefix}{页码}${templatePattern.suffix}.${templatePattern.ext}`;
    step2Btn.style.display = "block";
  }

  /**
   * 从页面收集样本URL
   */
  function collectSampleUrls(count) {
    const urls = [];
    const contentDiv = document.getElementById('content') || document.body;
    const imgs = contentDiv.querySelectorAll('img');

    for (const img of imgs) {
      const src = img.getAttribute('src');
      if (src && isValidImageUrl(src) && !urls.includes(src)) {
        urls.push(src);
        if (urls.length >= count) break;
      }
    }

    return urls;
  }

  /**
   * 判断是否为有效图片URL
   */
  function isValidImageUrl(url) {
    return /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url);
  }

  /**
   * 分析URL规律
   * 返回: { prefix, suffix, ext, startNum, numDigits }
   */
  function analyzePattern(urls) {
    if (urls.length < 2) return null;

    // 找出URL的共同前缀和后缀
    const firstUrl = urls[0];
    const secondUrl = urls[1];

    // 找到第一个不同的位置
    let diffStart = 0;
    while (diffStart < firstUrl.length && 
           diffStart < secondUrl.length && 
           firstUrl[diffStart] === secondUrl[diffStart]) {
      diffStart++;
    }

    // 向前找，直到遇到非数字（找到页码开始位置）
    let numStart = diffStart;
    while (numStart > 0 && /\d/.test(firstUrl[numStart - 1])) {
      numStart--;
    }

    // 提取页码
    let numEnd = numStart;
    while (numEnd < firstUrl.length && /\d/.test(firstUrl[numEnd])) {
      numEnd++;
    }

    const firstNum = parseInt(firstUrl.substring(numStart, numEnd), 10);
    const numDigits = numEnd - numStart;

    // 提取扩展名
    const extMatch = firstUrl.match(/\.(\w+)(\?.*)?$/);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';

    // 提取前缀和后缀
    const prefix = firstUrl.substring(0, numStart);
    let suffix = '';
    
    // 从页码后开始，到扩展名前，找后缀（如 _1）
    const afterNum = numEnd;
    const beforeExt = firstUrl.lastIndexOf('.');
    if (afterNum < beforeExt) {
      suffix = firstUrl.substring(afterNum, beforeExt);
    }

    // 验证其他URL是否符合相同规律
    for (let i = 1; i < urls.length; i++) {
      const url = urls[i];
      const expectedNum = firstNum + i;
      const expectedUrl = `${prefix}${String(expectedNum).padStart(numDigits, '0')}${suffix}.${ext}`;
      
      // 移除查询参数后比较
      const urlBase = url.split('?')[0];
      const expectedBase = expectedUrl.split('?')[0];
      
      if (!urlBase.endsWith(expectedBase.substring(prefix.length))) {
        // 规律不匹配，尝试找其他规律
        return findCommonPattern(urls);
      }
    }

    return {
      prefix,
      suffix,
      ext,
      startNum: firstNum,
      numDigits
    };
  }

  /**
   * 找共同规律（备用方案）
   */
  function findCommonPattern(urls) {
    // 简单处理：取第一个URL作为模板，假设页码是最后的数字
    const url = urls[0];
    const match = url.match(/^(.*\D)(\d+)([^\d]*)\.(\w+)(\?.*)?$/);
    
    if (!match) return null;

    return {
      prefix: match[1],
      suffix: match[3] || '',
      ext: match[4].toLowerCase(),
      startNum: parseInt(match[2], 10),
      numDigits: match[2].length
    };
  }

  /**
   * 步骤2：验证规律
   * 用分析出的规律生成5个URL并尝试下载，验证规律是否正确
   */
  async function verifyPattern() {
    const countEl = document.getElementById("imgCountSmart");
    const step2Btn = document.getElementById("step2BtnSmart");
    const pageInput = document.getElementById("pageInputSmart");

    if (!templatePattern) {
      countEl.innerText = "请先分析模板";
      return;
    }

    countEl.innerText = "验证中...";
    step2Btn.disabled = true;

    // 生成5个验证URL（从startNum开始）
    const verifyUrls = [];
    for (let i = 0; i < VERIFY_COUNT; i++) {
      const num = templatePattern.startNum + i;
      const url = generateUrl(num);
      verifyUrls.push(url);
    }

    // 尝试下载验证
    let successCount = 0;
    for (const url of verifyUrls) {
      const res = await fetchBlob(url, 1, 8000);  // 只试1次，8秒超时
      if (res.ok) {
        successCount++;
      }
    }

    if (successCount >= 3) {
      // 验证通过
      countEl.innerText = `验证通过(${successCount}/${VERIFY_COUNT})`;
      pageInput.style.display = "block";
      pageInput.placeholder = `从${templatePattern.startNum}开始，共?页`;
    } else {
      countEl.innerText = `验证失败(${successCount}/${VERIFY_COUNT})`;
      step2Btn.disabled = false;
    }
  }

  /**
   * 生成URL
   */
  function generateUrl(num) {
    const paddedNum = String(num).padStart(templatePattern.numDigits, '0');
    return `${templatePattern.prefix}${paddedNum}${templatePattern.suffix}.${templatePattern.ext}`;
  }

  /**
   * 输入页数处理
   */
  function onPageInput() {
    const input = document.getElementById("pageInputSmart");
    const total = parseInt(input.value, 10);
    const countEl = document.getElementById("imgCountSmart");
    const step3Btn = document.getElementById("step3BtnSmart");

    if (isNaN(total) || total < 1) {
      step3Btn.style.display = "none";
      return;
    }

    countEl.innerText = `将下载${total}张`;
    step3Btn.style.display = "block";
  }

  /**
   * 下载blob
   */
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

  /**
   * 步骤3：打包下载
   */
  async function doZip() {
    const input = document.getElementById("pageInputSmart");
    const total = parseInt(input.value, 10);
    const step3Btn = document.getElementById("step3BtnSmart");
    const countText = document.getElementById("imgCountSmart");

    if (isNaN(total) || total < 1) {
      alert("请输入有效的页数");
      return;
    }

    step3Btn.disabled = true;
    countText.innerText = '准备下载...';

    // 生成所有URL
    const imgList = [];
    for (let i = 0; i < total; i++) {
      const num = templatePattern.startNum + i;
      imgList.push(generateUrl(num));
    }

    countText.innerText = `下载 0/${total}`;

    const zip = new JSZip();
    let done = 0, success = 0, failCount = 0;
    const failUrls = [];

    const tasks = imgList.map((src, i) => async () => {
      const res = await fetchBlob(src);
      done++;
      if (res.ok) {
        success++;
        const ext = templatePattern.ext;
        zip.file(`pic_${String(i + 1).padStart(3, "0")}.${ext}`, res.blob);
      } else {
        failCount++;
        failUrls.push({ url: src, index: i });
      }
      countText.innerText = `下载 ${done}/${total}`;
    });

    await runLimit(tasks, MAX_CONCUR);

    // 补漏
    if (failCount > 0) {
      countText.innerText = `补漏 ${failCount}张...`;
      for (const item of failUrls) {
        const res = await fetchBlob(item.url);
        if (res.ok) {
          zip.file(`pic_${String(item.index + 1).padStart(3, "0")}.${templatePattern.ext}`, res.blob);
          success++;
          failCount--;
        }
      }
    }

    if (success === 0) {
      countText.innerText = "全部失败";
    } else {
      countText.innerText = "打包中...";
      try {
        const blob = await zip.generateAsync({
          type: "blob",
          compression: "STORE",
        });
        const name = (document.title || "图片合集").replace(/[\\/:*?"<>|]/g, "");
        saveAs(blob, `${name}.zip`);
        countText.innerText = failCount > 0 ? `成功${success}张，失败${failCount}张` : `成功${success}张`;
      } catch {
        countText.innerText = "打包失败";
      }
    }

    step3Btn.disabled = false;
  }

  /**
   * 并发控制
   */
  async function runLimit(tasks, limit) {
    let idx = 0;
    async function work() {
      while (idx < tasks.length) await tasks[idx++]();
    }
    await Promise.all(Array.from({ length: limit }, work));
  }
})();