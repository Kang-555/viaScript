// ==UserScript==
// @name         视频悬浮精确控制工具(智能主视频版)
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  智能识别主视频自动播放，悬浮控制条支持精确跳转、长按快进、倍速控制
// @author       You
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @license      MIT
// ==/UserScript==

(function () {
  "use strict";

  // ========== 配置 ==========
  const CONFIG = {
    defaultEnabled: true,
    panelWidth: '94%',
    borderRadius: '18px',
    debugBg: "transparent",
    buttonColor: 'rgba(40, 40, 40, 0.55)',
    accentColor: 'rgba(80, 110, 190, 0.55)',
    textColor: 'rgba(240, 240, 240, 0.96)',
    fontSize: '14px',
    gap: '8px',
    // 主视频筛选阈值
    minWidth: 280,
    minHeight: 160,
    // 自动播放
    autoPlayEnabled: true,
    autoPlayDelay: 500,
    autoPlayMaxRetries: 5
  };

  // ========== 状态变量 ==========
  let isEnabled = GM_getValue('videoControllerEnabled', CONFIG.defaultEnabled);
  let controller = null;
  let toggleButton = null;
  let timeUpdateInterval = null;
  let holdTimer = null;
  const holdSpeed = 3;
  let originPlayRate = 1;
  let mainVideo = null;
  let autoPlayTriggered = false;
  let autoPlayRetryCount = 0;

  // ========== 主视频识别逻辑 ==========

  /**
   * 获取页面中唯一主视频
   * 过滤掉预览小视频、缩略图、hover预览等干扰项
   */
  function getMainVideo() {
    const allVideos = Array.from(document.querySelectorAll('video'));
    if (allVideos.length === 0) return null;

    // 第一步：尺寸过滤 + 可视性过滤
    const candidates = allVideos.filter(v => {
      const rect = v.getBoundingClientRect();
      // 尺寸阈值过滤
      const isBigEnough = v.clientWidth >= CONFIG.minWidth && v.clientHeight >= CONFIG.minHeight;
      // 可视性检查：在视口内且未被隐藏
      const isVisible = rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.top < window.innerHeight
        && getComputedStyle(v).display !== 'none'
        && getComputedStyle(v).visibility !== 'hidden';
      return isBigEnough && isVisible;
    });

    // 第二步：仅当恰好1个符合条件时，认定为主视频
    if (candidates.length === 1) {
      return candidates[0];
    }

    // 第三步：如果有多个候选，选择面积最大的
    if (candidates.length > 1) {
      candidates.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
      return candidates[0];
    }

    return null;
  }

  /**
   * 尝试自动播放主视频
   * 延迟检测 + 轮询重试 + 防重复触发
   */
  function tryAutoPlayMainVideo() {
    if (!CONFIG.autoPlayEnabled) return;
    if (autoPlayTriggered) return;

    const vid = getMainVideo();
    if (!vid) {
      // 未找到主视频，重试
      if (autoPlayRetryCount < CONFIG.autoPlayMaxRetries) {
        autoPlayRetryCount++;
        setTimeout(tryAutoPlayMainVideo, CONFIG.autoPlayDelay);
      }
      return;
    }

    // 标记已触发，防止重复
    autoPlayTriggered = true;
    mainVideo = vid;
    vid.dataset.autoPlayTriggered = "1";

    // 尝试播放
    vid.play().catch(err => {
      console.log('[VideoController] 自动播放被阻止:', err.message);
      // 浏览器阻止有声播放时，尝试静音播放
      vid.muted = true;
      vid.play().catch(() => {
        console.log('[VideoController] 静音自动播放也被阻止');
      });
    });
  }

  // ========== 控制面板创建 ==========

  function createController() {
    if (controller) return;

    controller = document.createElement("div");
    controller.id = "video-precise-controller";
    controller.style.cssText = `
      position: fixed;
      bottom: 85px;
      left: 50%;
      transform: translateX(-50%);
      background: ${CONFIG.debugBg};
      padding: 12px;
      border-radius: ${CONFIG.borderRadius};
      display: flex;
      flex-direction: column;
      gap: ${CONFIG.gap};
      z-index: 2147483647;
      box-shadow: none;
      width: ${CONFIG.panelWidth};
      max-width: 460px;
      font-size: ${CONFIG.fontSize};
      color: ${CONFIG.textColor};
      transition: all 0.3s ease;
      border:none;
      ${isEnabled ? 'opacity: 1; transform: translateX(-50%) translateY(0);' : 'opacity: 0; transform: translateX(-50%) translateY(20px); pointer-events: none;'}
    `;

    // 第一行：跳转按钮区 (6个等宽按钮)
    const jumpWrap = document.createElement("div");
    jumpWrap.style.cssText = `display:flex;gap:${CONFIG.gap};width:100%;`;

    const jumpButtons = [
      { text: "« 1min", seconds: -60 },
      { text: "« 30s", seconds: -30 },
      { text: "« 5s", seconds: -5 },
      { text: "5s »", seconds: 5 },
      { text: "30s »", seconds: 30 },
      { text: "1min »", seconds: 60 }
    ];
    jumpButtons.forEach(item => jumpWrap.appendChild(createLargeButton(item.text, item.seconds)));

    // 第二行：速度 + 当前/总时长 + 开关按钮 (左右分布)
    const toolWrap = document.createElement("div");
    toolWrap.style.cssText = `display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:6px;`;

    // 左侧：速度选择器
    const speedBox = document.createElement("div");
    speedBox.style.cssText = `display:flex;align-items:center;gap:8px`;
    speedBox.innerHTML = `<span style="font-size:13px">速度</span>`;

    const speedSel = document.createElement("select");
    speedSel.innerHTML = `
      <option value="0.25">0.25x</option>
      <option value="0.5">0.5x</option>
      <option value="0.75">0.75x</option>
      <option value="1" selected>1x</option>
      <option value="1.25">1.25x</option>
      <option value="1.5">1.5x</option>
      <option value="2">2x</option>
      <option value="4">4x</option>
    `;
    speedSel.style.cssText = `
      background:${CONFIG.buttonColor};color:${CONFIG.textColor};border:none;border-radius:8px;padding:5px 8px;min-width:62px;
    `;
    speedSel.onchange = e => {
      const vid = getMainVideo();
      if (vid) vid.playbackRate = +e.target.value;
    };
    speedBox.appendChild(speedSel);

    // 中间：时间显示
    const timeDisplay = document.createElement("span");
    timeDisplay.style.cssText = `font-family:monospace;font-size:13px;min-width:130px;text-align:center`;
    timeDisplay.textContent = "00:00 / 00:00";

    // 右侧：开关按钮
    const switchBtn = document.createElement("button");
    switchBtn.id = "panel-toggle-btn";
    switchBtn.textContent = isEnabled ? "⏸" : "▶";
    switchBtn.style.cssText = `
      border:none;border-radius:8px;background:${isEnabled ? CONFIG.accentColor : CONFIG.buttonColor};
      color:${CONFIG.textColor};padding:6px 12px;cursor:pointer;font-size:16px;transition:0.16s;
    `;
    switchBtn.onclick = () => {
      toggleController();
      switchBtn.textContent = isEnabled ? "⏸" : "▶";
      switchBtn.style.background = isEnabled ? CONFIG.accentColor : CONFIG.buttonColor;
    };

    toolWrap.append(speedBox, timeDisplay, switchBtn);
    controller.append(jumpWrap, toolWrap);
    document.body.appendChild(controller);

    // 更新时间显示
    if (timeUpdateInterval) clearInterval(timeUpdateInterval);
    timeUpdateInterval = setInterval(() => {
      updateTimeDisplay(timeDisplay);
      autoHideWhenNoVideo();
    }, 300);

    // DOM保护
    const obs = new MutationObserver(() => {
      if (!document.body.contains(controller)) document.body.appendChild(controller);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function createLargeButton(text, stepSec) {
    const btn = document.createElement("button");
    btn.textContent = text;
    btn.style.cssText = `
      flex:1;padding:11px 2px;border:none;border-radius:10px;background:${CONFIG.accentColor};
      color:${CONFIG.textColor};font-weight:bold;font-size:13px;white-space:nowrap;transition:0.16s;
    `;

    const jumpOnce = () => adjustMainVideoTime(stepSec);
    const holdStart = () => {
      const vid = getMainVideo();
      if (!vid) return;
      originPlayRate = vid.playbackRate;
      vid.playbackRate = holdSpeed;
      holdTimer = setInterval(() => adjustMainVideoTime(stepSec), 200);
    };
    const holdStop = () => {
      clearInterval(holdTimer); holdTimer = null;
      const vid = getMainVideo();
      if (vid) vid.playbackRate = originPlayRate;
    };

    btn.addEventListener('mousedown', holdStart);
    btn.addEventListener('touchstart', holdStart);
    btn.addEventListener('mouseup', holdStop);
    btn.addEventListener('mouseleave', holdStop);
    btn.addEventListener('touchend', holdStop);
    btn.addEventListener('click', jumpOnce);

    // 按压动画
    const pressDown = () => btn.style.transform = "scale(0.96)";
    const pressUp = () => btn.style.transform = "scale(1)";
    btn.addEventListener('mousedown', pressDown);
    btn.addEventListener('touchstart', pressDown);
    btn.addEventListener('mouseup', pressUp);
    btn.addEventListener('mouseleave', pressUp);
    btn.addEventListener('touchend', pressUp);
    return btn;
  }

  function toggleController() {
    isEnabled = !isEnabled;
    GM_setValue('videoControllerEnabled', isEnabled);
    refreshToggleUI();
    if (isEnabled) {
      if (!controller) createController();
      else {
        controller.style.opacity = "1";
        controller.style.transform = "translateX(-50%) translateY(0)";
        controller.style.pointerEvents = "auto";
      }
    } else {
      if (controller) {
        controller.style.opacity = "0";
        controller.style.transform = "translateX(-50%) translateY(20px)";
        controller.style.pointerEvents = "none";
      }
    }
  }

  function refreshToggleUI() {
    if (!toggleButton) return;
    toggleButton.textContent = isEnabled ? "⏸" : "▶";
    toggleButton.style.background = isEnabled ? CONFIG.accentColor : CONFIG.buttonColor;
  }

  function createToggleButton() {
    if (toggleButton) return;
    toggleButton = document.createElement("div");
    toggleButton.id = "video-controller-toggle";
    toggleButton.style.cssText = `
      position:fixed;bottom:25px;right:25px;width:46px;height:46px;border-radius:50%;
      display:flex;align-items:center;justify-content:center;color:${CONFIG.textColor};
      font-size:20px;z-index:2147483646;cursor:pointer;transition:0.3s;border:none;
    `;
    refreshToggleUI();
    toggleButton.onclick = toggleController;
    document.body.appendChild(toggleButton);
  }

  // ========== 视频操作 ==========

  function adjustMainVideoTime(sec) {
    const vid = getMainVideo();
    if (!vid) return;
    try {
      vid.currentTime = Math.max(0, Math.min(vid.currentTime + sec, vid.duration || 99999));
    } catch (e) { }
  }

  function formatTime(sec) {
    if (isNaN(sec)) return "--:--";
    let h = Math.floor(sec / 3600);
    let m = Math.floor((sec % 3600) / 60);
    let s = Math.floor(sec % 60);
    const pad = x => String(x).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function updateTimeDisplay(displayDom) {
    const vid = getMainVideo();
    if (!vid) return;
    displayDom.textContent = `${formatTime(vid.currentTime)} / ${formatTime(vid.duration)}`;
  }

  function autoHideWhenNoVideo() {
    const vid = getMainVideo();
    if (toggleButton) toggleButton.style.display = vid ? "flex" : "none";
    if (controller && !vid) {
      controller.style.opacity = "0";
      controller.style.pointerEvents = "none";
    }
  }

  // ========== 初始化 ==========

  function init() {
    createToggleButton();
    autoHideWhenNoVideo();
    if (isEnabled) createController();
    // 延迟尝试自动播放主视频
    setTimeout(tryAutoPlayMainVideo, CONFIG.autoPlayDelay);
  }

  // 页面加载完成后初始化
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // 监听DOM变化，检测新视频
  const videoObserver = new MutationObserver(() => {
    if (!autoPlayTriggered) {
      tryAutoPlayMainVideo();
    }
    autoHideWhenNoVideo();
  });

  setTimeout(() => {
    if (document.body) {
      videoObserver.observe(document.body, { childList: true, subtree: true });
    }
  }, 1000);
})();