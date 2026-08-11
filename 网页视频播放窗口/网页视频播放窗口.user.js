// ==UserScript==
// @name         视频悬浮精确控制工具(智能主视频版)
// @namespace    http://tampermonkey.net/
// @version      3.1
// @description  智能识别主视频自动播放，两行紧凑控制条支持精确跳转、长按快进、倍速控制
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
    autoPlayDelay: 200,
    autoPlayRetryInterval: 300,
    autoPlayMaxRetries: 8
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
  
  // DOM元素缓存，避免重复查询
  let domCache = {
    playPauseBtn: null,
    progressFill: null,
    progressThumb: null,
    progressCurrentTime: null,
    progressTotalTime: null,
    progressBarContainer: null
  };

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
   * 快速检测 + 轮询重试 + 防重复触发
   */
  function tryAutoPlayMainVideo() {
    if (!CONFIG.autoPlayEnabled) return;
    if (autoPlayTriggered) return;

    const vid = getMainVideo();
    if (!vid) {
      // 未找到主视频，快速重试
      if (autoPlayRetryCount < CONFIG.autoPlayMaxRetries) {
        autoPlayRetryCount++;
        setTimeout(tryAutoPlayMainVideo, CONFIG.autoPlayRetryInterval);
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

    // 第一行：跳转按钮 + 速度 + 播放 (紧凑布局)
    const controlWrap = document.createElement("div");
    controlWrap.style.cssText = `display:flex;gap:${CONFIG.gap};width:100%;align-items:center;`;

    const jumpButtons = [
      { text: "« 1min", seconds: -60 },
      { text: "« 10s", seconds: -10 },
      { text: "10s »", seconds: 10 },
      { text: "1min »", seconds: 60 }
    ];
    jumpButtons.forEach(item => controlWrap.appendChild(createLargeButton(item.text, item.seconds)));

    // 速度选择器
    const speedBox = document.createElement("div");
    speedBox.style.cssText = `display:flex;align-items:center;gap:4px;flex-shrink:0;`;
    speedBox.innerHTML = `<span style="font-size:12px">速度</span>`;

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

    // 播放/暂停按钮
    const playPauseBtn = document.createElement("button");
    playPauseBtn.id = "play-pause-btn";
    playPauseBtn.textContent = "▶";
    playPauseBtn.style.cssText = `
      border:none;border-radius:8px;background:${CONFIG.accentColor};
      color:${CONFIG.textColor};padding:6px 12px;cursor:pointer;font-size:16px;transition:0.16s;flex-shrink:0;
    `;
    playPauseBtn.onclick = () => {
      const vid = getMainVideo();
      if (!vid) return;
      if (vid.paused) {
        vid.play().catch(() => {});
        playPauseBtn.textContent = "⏸";
      } else {
        vid.pause();
        playPauseBtn.textContent = "▶";
      }
    };

    controlWrap.append(speedBox, playPauseBtn);

    // 第二行：进度条
    const progressWrap = document.createElement("div");
    progressWrap.style.cssText = `display:flex;align-items:center;gap:8px;`;
    
    const currentTimeLabel = document.createElement("span");
    currentTimeLabel.id = "progress-current-time";
    currentTimeLabel.style.cssText = `font-family:monospace;font-size:12px;min-width:42px;text-align:right`;
    currentTimeLabel.textContent = "00:00";
    
    const progressBarContainer = document.createElement("div");
    progressBarContainer.id = "progress-bar-container";
    progressBarContainer.style.cssText = `
      flex:1;height:8px;background:${CONFIG.buttonColor};border-radius:4px;cursor:pointer;position:relative;overflow:visible;
    `;
    
    const progressBarFill = document.createElement("div");
    progressBarFill.id = "progress-bar-fill";
    progressBarFill.style.cssText = `
      height:100%;background:${CONFIG.accentColor};border-radius:4px;width:0%;transition:width 0.1s linear;
    `;
    
    const progressThumb = document.createElement("div");
    progressThumb.id = "progress-thumb";
    progressThumb.style.cssText = `
      position:absolute;top:50%;width:14px;height:14px;border-radius:50%;background:${CONFIG.textColor};
      transform:translate(-50%, -50%);left:0%;box-shadow:0 1px 3px rgba(0,0,0,0.3);transition:left 0.1s linear;
    `;
    
    progressBarContainer.appendChild(progressBarFill);
    progressBarContainer.appendChild(progressThumb);
    
    const totalTimeLabel = document.createElement("span");
    totalTimeLabel.id = "progress-total-time";
    totalTimeLabel.style.cssText = `font-family:monospace;font-size:12px;min-width:42px;text-align:left`;
    totalTimeLabel.textContent = "00:00";
    
    progressWrap.append(currentTimeLabel, progressBarContainer, totalTimeLabel);
    
    // 缓存进度条DOM引用
    domCache.progressFill = progressBarFill;
    domCache.progressThumb = progressThumb;
    domCache.progressCurrentTime = currentTimeLabel;
    domCache.progressTotalTime = totalTimeLabel;
    domCache.progressBarContainer = progressBarContainer;
    
    // 进度条交互
    let isDragging = false;
    
    const updateProgress = (e) => {
      const vid = getMainVideo();
      if (!vid || !vid.duration) return;
      
      const rect = domCache.progressBarContainer.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      
      vid.currentTime = percent * vid.duration;
      domCache.progressFill.style.width = `${percent * 100}%`;
      domCache.progressThumb.style.left = `${percent * 100}%`;
      domCache.progressCurrentTime.textContent = formatTime(vid.currentTime);
    };
    
    progressBarContainer.addEventListener('mousedown', (e) => {
      isDragging = true;
      updateProgress(e);
    });
    
    progressBarContainer.addEventListener('touchstart', (e) => {
      isDragging = true;
      updateProgress(e);
    }, { passive: true });
    
    document.addEventListener('mousemove', (e) => {
      if (isDragging) updateProgress(e);
    });
    
    document.addEventListener('touchmove', (e) => {
      if (isDragging) updateProgress(e);
    }, { passive: true });
    
    const stopDrag = () => { isDragging = false; };
    document.addEventListener('mouseup', stopDrag);
    document.addEventListener('touchend', stopDrag);

    // 缓存DOM引用
    domCache.playPauseBtn = playPauseBtn;

    controller.append(controlWrap, progressWrap);
    document.body.appendChild(controller);

    // 更新时间显示和播放状态
    if (timeUpdateInterval) clearInterval(timeUpdateInterval);
    timeUpdateInterval = setInterval(() => {
      updateTimeDisplay();
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
      // 清理DOM缓存
      clearDomCache();
    }
  }

  function clearDomCache() {
    domCache = {
      playPauseBtn: null,
      progressFill: null,
      progressThumb: null,
      progressCurrentTime: null,
      progressTotalTime: null,
      progressBarContainer: null
    };
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

  function updateTimeDisplay() {
    const vid = getMainVideo();
    if (!vid) return;
    
    // 同步播放/暂停按钮状态
    if (domCache.playPauseBtn) {
      domCache.playPauseBtn.textContent = vid.paused ? "▶" : "⏸";
    }
    
    // 更新进度条
    if (vid.duration && domCache.progressFill) {
      const percent = (vid.currentTime / vid.duration) * 100;
      domCache.progressFill.style.width = `${percent}%`;
      domCache.progressThumb.style.left = `${percent}%`;
      domCache.progressCurrentTime.textContent = formatTime(vid.currentTime);
      domCache.progressTotalTime.textContent = formatTime(vid.duration);
    }
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