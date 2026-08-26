// ==UserScript==
// @name         视频悬浮精确控制
// @namespace    http://tampermonkey.net/
// @version      2.0
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
    autoPlayMaxRetries: 8,
    holdSpeed: 3
  };

  // ========== 状态变量 ==========
  let isEnabled = GM_getValue('videoControllerEnabled', CONFIG.defaultEnabled);
  let controller = null;
  let toggleButton = null;
  let timeUpdateInterval = null;
  let autoPlayTriggered = false;
  let autoPlayRetryCount = 0;

  let controllerPos = GM_getValue('controllerPos', null);

  // 持续前进按钮状态
  let forwardHoldActive = false;
  let forwardHoldTimer = null;
  let forwardOriginRate = 1;
  let forwardButton = null;

  // getMainVideo 节流缓存
  let mainVideoCache = null;
  let mainVideoCacheTime = 0;
  const MAIN_VIDEO_CACHE_TTL = 300; // ms

  // DOM元素缓存，避免重复查询
  let domCache = {
    playPauseBtn: null,
    progressFill: null,
    progressThumb: null,
    progressCurrentTime: null,
    progressTotalTime: null,
    progressBarContainer: null,
    speedBtn: null,
    speedSelect: null
  };

  // 全局事件监听器引用（用于 destroy 时清理）
  let progressMousemoveHandler = null;
  let progressTouchmoveHandler = null;
  let progressMouseupHandler = null;
  let progressTouchendHandler = null;
  let controllerObserver = null;

  // ========== 主视频识别逻辑 ==========

  /**
   * 获取页面中唯一主视频
   * 过滤掉预览小视频、缩略图、hover预览等干扰项
   */
  function getMainVideo() {
    // 节流缓存：TTL 内直接返回上次结果，减少 getBoundingClientRect 调用
    const now = Date.now();
    if (now - mainVideoCacheTime < MAIN_VIDEO_CACHE_TTL) {
      return mainVideoCache;
    }

    const allVideos = Array.from(document.querySelectorAll('video'));
    let result = null;
    if (allVideos.length > 0) {
      // 第一步：尺寸过滤 + 可视性过滤
      const candidates = allVideos.filter(v => {
        // 尺寸阈值过滤（使用 offsetWidth/offsetHeight 避免强制重排）
        const isBigEnough = v.offsetWidth >= CONFIG.minWidth && v.offsetHeight >= CONFIG.minHeight;
        if (!isBigEnough) return false;
        // 可视性检查：rect 异常时使用 offset 备选
        const rect = v.getBoundingClientRect();
        const rectValid = rect.width > 0 && rect.height > 0;
        const offsetValid = v.offsetWidth > 0 && v.offsetHeight > 0;
        const isVisible = (rectValid || offsetValid)
          && (rectValid ? (rect.bottom > 0 && rect.top < window.innerHeight) : true)
          && v.style.visibility !== 'hidden';
        return isVisible;
      });

      // 第二步：仅当恰好1个符合条件时，认定为主视频
      if (candidates.length === 1) {
        result = candidates[0];
      } else if (candidates.length > 1) {
        // 第三步：如果有多个候选，选择面积最大的
        candidates.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
        result = candidates[0];
      }
    }

    // 更新缓存
    mainVideoCache = result;
    mainVideoCacheTime = now;
    return result;
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

    const savedPos = GM_getValue('controllerPos', null);
    let posInit;
    if (savedPos) {
      posInit = `left:${savedPos.x}px;top:${savedPos.y}px;`;
    } else {
      posInit = `left:50%;bottom:85px;transform:translateX(-50%);`;
    }

    controller.style.cssText = `
      position: fixed;
      background: ${CONFIG.debugBg};
      padding: 0;
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
      transition: opacity 0.3s ease;
      border:none;
      -webkit-user-select:none;
      user-select:none;
      -webkit-touch-callout:none;
      ${posInit}
      ${isEnabled ? 'opacity: 1;' : 'opacity: 0; pointer-events: none;'}
    `;

    const dragHandle = document.createElement("div");
    dragHandle.style.cssText = `
      display:flex;align-items:center;justify-content:center;
      padding:4px 0;background:rgba(255,255,255,0.05);
      cursor:grab;border-bottom:1px solid rgba(255,255,255,0.08);
      font-size:12px;color:rgba(255,255,255,0.35);
      letter-spacing:6px;user-select:none;
    `;
    dragHandle.textContent = '⋮⋮';

    const controllerInner = document.createElement("div");
    controllerInner.style.cssText = `padding:12px;display:flex;flex-direction:column;gap:${CONFIG.gap};`;

    let cDragging = false, cMoved = false;
    let cDragStartX = 0, cDragStartY = 0;
    let cBtnStartX = 0, cBtnStartY = 0;

    const onCtrlMouseDown = (e) => {
      cDragging = true;
      cMoved = false;
      cDragStartX = e.clientX;
      cDragStartY = e.clientY;
      const rect = controller.getBoundingClientRect();
      cBtnStartX = rect.left;
      cBtnStartY = rect.top;
      dragHandle.style.cursor = 'grabbing';
      e.preventDefault();
      e.stopPropagation();
    };

    const onCtrlMouseMove = (e) => {
      if (!cDragging) return;
      const dx = e.clientX - cDragStartX;
      const dy = e.clientY - cDragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) cMoved = true;
      const maxX = window.innerWidth - controller.offsetWidth;
      const maxY = window.innerHeight - 10;
      const newX = Math.max(0, Math.min(maxX, cBtnStartX + dx));
      const newY = Math.max(0, Math.min(maxY, cBtnStartY + dy));
      controller.style.left = newX + 'px';
      controller.style.top = newY + 'px';
      controller.style.bottom = 'auto';
      controller.style.right = 'auto';
      controller.style.transform = 'none';
    };

    const onCtrlMouseUp = () => {
      if (!cDragging) return;
      cDragging = false;
      dragHandle.style.cursor = 'grab';
      if (cMoved) {
        const rect = controller.getBoundingClientRect();
        GM_setValue('controllerPos', { x: rect.left, y: rect.top });
      }
    };

    dragHandle.addEventListener('mousedown', onCtrlMouseDown);
    document.addEventListener('mousemove', onCtrlMouseMove);
    document.addEventListener('mouseup', onCtrlMouseUp);

    const onCtrlTouchStart = (e) => {
      cDragging = true;
      cMoved = false;
      const t = e.touches[0];
      cDragStartX = t.clientX;
      cDragStartY = t.clientY;
      const rect = controller.getBoundingClientRect();
      cBtnStartX = rect.left;
      cBtnStartY = rect.top;
    };

    const onCtrlTouchMove = (e) => {
      if (!cDragging) return;
      const t = e.touches[0];
      const dx = t.clientX - cDragStartX;
      const dy = t.clientY - cDragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) cMoved = true;
      const maxX = window.innerWidth - controller.offsetWidth;
      const maxY = window.innerHeight - 10;
      const newX = Math.max(0, Math.min(maxX, cBtnStartX + dx));
      const newY = Math.max(0, Math.min(maxY, cBtnStartY + dy));
      controller.style.left = newX + 'px';
      controller.style.top = newY + 'px';
      controller.style.bottom = 'auto';
      controller.style.right = 'auto';
      controller.style.transform = 'none';
    };

    const onCtrlTouchEnd = () => {
      if (!cDragging) return;
      cDragging = false;
      if (cMoved) {
        const rect = controller.getBoundingClientRect();
        GM_setValue('controllerPos', { x: rect.left, y: rect.top });
      }
    };

    dragHandle.addEventListener('touchstart', onCtrlTouchStart, { passive: true });
    document.addEventListener('touchmove', onCtrlTouchMove, { passive: true });
    document.addEventListener('touchend', onCtrlTouchEnd);

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

    // 速度选择器（按钮 + 上拉菜单）
    const speedWrap = document.createElement("div");
    speedWrap.style.cssText = `position:relative;flex-shrink:0;`;

    const speedBtn = document.createElement("button");
    speedBtn.id = "speed-btn";
    speedBtn.textContent = "1x";
    speedBtn.style.cssText = `
      background:${CONFIG.buttonColor};color:${CONFIG.textColor};border:none;border-radius:8px;
      padding:5px 10px;cursor:pointer;font-size:13px;min-width:42px;transition:0.16s;
    `;

    const speedMenu = document.createElement("select");
    speedMenu.id = "speed-select";
    speedMenu.innerHTML = `
      <option value="0.25">0.25x</option>
      <option value="0.5">0.5x</option>
      <option value="0.75">0.75x</option>
      <option value="1" selected>1x</option>
      <option value="1.25">1.25x</option>
      <option value="1.5">1.5x</option>
      <option value="2">2x</option>
      <option value="4">4x</option>
    `;
    speedMenu.style.cssText = `
      position:absolute;bottom:100%;left:50%;transform:translateX(-50%);
      background:${CONFIG.buttonColor};color:${CONFIG.textColor};border:none;border-radius:8px;
      padding:5px 8px;margin-bottom:6px;display:none;z-index:2147483647;
    `;

    speedBtn.onclick = (e) => {
      e.stopPropagation();
      const isHidden = speedMenu.style.display === "none";
      speedMenu.style.display = isHidden ? "block" : "none";
      if (isHidden) speedMenu.focus();
    };

    speedMenu.onchange = (e) => {
      const vid = getMainVideo();
      if (vid) vid.playbackRate = +e.target.value;
      speedBtn.textContent = e.target.value + "x";
      speedMenu.style.display = "none";
    };

    // 点击其他地方关闭菜单
    document.addEventListener('click', (e) => {
      if (!speedWrap.contains(e.target)) speedMenu.style.display = "none";
    });

    speedWrap.append(speedBtn, speedMenu);
    domCache.speedBtn = speedBtn;
    domCache.speedSelect = speedMenu;

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
        vid.play().catch(() => { });
        playPauseBtn.textContent = "⏸";
      } else {
        vid.pause();
        playPauseBtn.textContent = "▶";
      }
    };

    controlWrap.append(speedWrap, playPauseBtn);

    // 持续前进按钮 》
    forwardButton = document.createElement("button");
    forwardButton.id = "forward-hold-btn";
    forwardButton.textContent = "》";
    forwardButton.style.cssText = `
      border:none;border-radius:8px;background:${CONFIG.accentColor};
      color:${CONFIG.textColor};padding:6px 12px;cursor:pointer;font-size:16px;transition:0.16s;flex-shrink:0;
    `;
    forwardButton.onclick = () => {
      const vid = getMainVideo();
      if (!vid) return;
      if (!forwardHoldActive) {
        forwardOriginRate = vid.playbackRate;
        vid.playbackRate = 2;
        forwardHoldTimer = setInterval(() => adjustMainVideoTime(10), 200);
        forwardHoldActive = true;
        forwardButton.style.background = CONFIG.textColor;
        forwardButton.style.color = CONFIG.accentColor;
      } else {
        clearInterval(forwardHoldTimer);
        forwardHoldTimer = null;
        vid.playbackRate = forwardOriginRate;
        forwardHoldActive = false;
        forwardButton.style.background = CONFIG.accentColor;
        forwardButton.style.color = CONFIG.textColor;
      }
    };

    controlWrap.appendChild(forwardButton);

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

    // 进度条交互（拖动不 seek，抬起才执行，避免视频抖动）
    let isDragging = false;
    let dragPercent = 0;

    const updateDragUI = (e) => {
      const vid = getMainVideo();
      if (!vid || !vid.duration) return;

      const rect = domCache.progressBarContainer.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      dragPercent = percent;

      domCache.progressFill.style.width = `${percent * 100}%`;
      domCache.progressThumb.style.left = `${percent * 100}%`;
      domCache.progressCurrentTime.textContent = formatTime(percent * vid.duration);
    };

    const seekToDrag = () => {
      const vid = getMainVideo();
      if (!vid || !vid.duration) return;
      vid.currentTime = dragPercent * vid.duration;
    };

    // 进度条全局监听器（命名函数，便于 destroy 时清理）
    progressMousemoveHandler = (e) => { if (isDragging) updateDragUI(e); };
    progressTouchmoveHandler = (e) => { if (isDragging) updateDragUI(e); };
    progressMouseupHandler = () => { if (isDragging) { isDragging = false; seekToDrag(); } };
    progressTouchendHandler = () => { if (isDragging) { isDragging = false; seekToDrag(); } };

    progressBarContainer.addEventListener('mousedown', (e) => {
      isDragging = true;
      updateDragUI(e);
    });

    progressBarContainer.addEventListener('touchstart', (e) => {
      isDragging = true;
      updateDragUI(e);
    }, { passive: true });

    document.addEventListener('mousemove', progressMousemoveHandler);
    document.addEventListener('touchmove', progressTouchmoveHandler, { passive: true });
    document.addEventListener('mouseup', progressMouseupHandler);
    document.addEventListener('touchend', progressTouchendHandler);

    // 缓存DOM引用
    domCache.playPauseBtn = playPauseBtn;

    controllerInner.append(controlWrap, progressWrap);
    controller.append(dragHandle, controllerInner);
    document.body.appendChild(controller);

    // 绑定视频播放/暂停事件，动态启停 UI 更新
    const vid = getMainVideo();
    if (vid) bindVideoEvents(vid);

    controllerObserver = new MutationObserver(() => {
      if (!document.body.contains(controller)) {
        document.body.appendChild(controller);
        controller.style.opacity = isEnabled ? "1" : "0";
        controller.style.pointerEvents = isEnabled ? "auto" : "none";
      }
    });
    controllerObserver.observe(document.body, { childList: true, subtree: true });
  }

  // 视频事件监听器引用（用于 destroy 时清理）
  let videoPlayHandler = null;
  let videoPauseHandler = null;

  function startTimeInterval() {
    if (timeUpdateInterval) return;
    timeUpdateInterval = setInterval(() => {
      const vid = getMainVideo();
      if (!vid || !isEnabled) {
        clearInterval(timeUpdateInterval);
        timeUpdateInterval = null;
        return;
      }
      updateTimeDisplay();
      autoHideWhenNoVideo();
    }, 300);
  }

  function stopTimeInterval() {
    if (timeUpdateInterval) {
      clearInterval(timeUpdateInterval);
      timeUpdateInterval = null;
    }
  }

  // 监听视频播放/暂停事件，动态启停 UI 更新
  function bindVideoEvents(vid) {
    // 先清理旧的监听器
    if (videoPlayHandler) vid.removeEventListener('play', videoPlayHandler);
    if (videoPauseHandler) vid.removeEventListener('pause', videoPauseHandler);

    videoPlayHandler = () => startTimeInterval();
    videoPauseHandler = () => stopTimeInterval();

    vid.addEventListener('play', videoPlayHandler);
    vid.addEventListener('pause', videoPauseHandler);

    // 初始状态：如果正在播放则启动定时器
    if (!vid.paused) startTimeInterval();
  }

  function createLargeButton(text, stepSec) {
    const btn = document.createElement("button");
    btn.textContent = text;
    btn.style.cssText = `
      flex:1;padding:11px 2px;border:none;border-radius:10px;background:${CONFIG.accentColor};
      color:${CONFIG.textColor};font-weight:bold;font-size:13px;white-space:nowrap;transition:0.16s;
      -webkit-user-select:none;user-select:none;
    `;

    const jumpOnce = () => adjustMainVideoTime(stepSec);

    btn.addEventListener('click', jumpOnce);

    // 按压动画
    const pressDown = () => { btn.style.transform = "scale(0.96)"; };
    const pressUp = () => btn.style.transform = "scale(1)";
    btn.addEventListener('mousedown', pressDown);
    btn.addEventListener('touchstart', pressDown, { passive: false });
    btn.addEventListener('mouseup', pressUp);
    btn.addEventListener('mouseleave', pressUp);
    btn.addEventListener('touchend', pressUp);
    btn.addEventListener('touchcancel', pressUp);
    return btn;
  }

  function toggleController() {
    isEnabled = !isEnabled;
    GM_setValue('videoControllerEnabled', isEnabled);
    refreshToggleUI();
    if (isEnabled) {
      if (!controller) {
        createController();
      } else {
        controller.style.opacity = "1";
        controller.style.pointerEvents = "auto";
        refreshDomCache();
      }
    } else {
      if (controller) {
        controller.style.opacity = "0";
        controller.style.pointerEvents = "none";
      }
      clearDomCache();
    }
  }

  function refreshDomCache() {
    if (!controller) return;
    domCache.playPauseBtn = document.getElementById("play-pause-btn");
    domCache.progressFill = document.getElementById("progress-bar-fill");
    domCache.progressThumb = document.getElementById("progress-thumb");
    domCache.progressCurrentTime = document.getElementById("progress-current-time");
    domCache.progressTotalTime = document.getElementById("progress-total-time");
    domCache.progressBarContainer = document.getElementById("progress-bar-container");
    domCache.speedBtn = document.getElementById("speed-btn");
    domCache.speedSelect = document.getElementById("speed-select");
  }

  function clearDomCache() {
    domCache = {
      playPauseBtn: null,
      progressFill: null,
      progressThumb: null,
      progressCurrentTime: null,
      progressTotalTime: null,
      progressBarContainer: null,
      speedBtn: null,
      speedSelect: null
    };
  }

  function refreshToggleUI() {
    if (!toggleButton) return;
    toggleButton.textContent = isEnabled ? "▼" : "▲";
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
    let longPressTimer = null;
    let longPressTriggered = false;
    const onPointerDown = () => {
      longPressTriggered = false;
      longPressTimer = setTimeout(() => {
        longPressTriggered = true;
        GM_setValue('controllerPos', null);
        controllerPos = null;
        if (controller) {
          controller.style.left = '50%';
          controller.style.bottom = '85px';
          controller.style.right = 'auto';
          controller.style.top = 'auto';
          controller.style.transform = 'translateX(-50%)';
        }
      }, 600);
    };
    const onPointerUp = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };
    toggleButton.addEventListener('mousedown', onPointerDown);
    toggleButton.addEventListener('mouseup', onPointerUp);
    toggleButton.addEventListener('mouseleave', onPointerUp);
    toggleButton.addEventListener('touchstart', onPointerDown, { passive: true });
    toggleButton.addEventListener('touchend', onPointerUp);
    toggleButton.addEventListener('touchcancel', onPointerUp);
    toggleButton.onclick = () => {
      if (longPressTriggered) return;
      toggleController();
    };
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

    // 同步倍速按钮文本
    if (domCache.speedBtn) {
      const rate = vid.playbackRate;
      const rateText = rate + "x";
      if (domCache.speedBtn.textContent !== rateText) {
        domCache.speedBtn.textContent = rateText;
      }
    }
    if (domCache.speedSelect) {
      const rate = vid.playbackRate;
      if (Math.abs(+domCache.speedSelect.value - rate) > 0.01) {
        const closest = Array.from(domCache.speedSelect.options).reduce((a, b) =>
          Math.abs(+a.value - rate) < Math.abs(+b.value - rate) ? a : b
        );
        domCache.speedSelect.value = closest.value;
      }
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
    if (controller && !vid && !isEnabled) {
      controller.style.opacity = "0";
      controller.style.pointerEvents = "none";
    }
  }

  // ========== 初始化 / 销毁 ==========

  function destroy() {
    stopTimeInterval();
    const vid = getMainVideo();
    if (vid) {
      if (videoPlayHandler) vid.removeEventListener('play', videoPlayHandler);
      if (videoPauseHandler) vid.removeEventListener('pause', videoPauseHandler);
    }
    videoPlayHandler = null;
    videoPauseHandler = null;
    if (forwardHoldTimer) {
      clearInterval(forwardHoldTimer);
      forwardHoldTimer = null;
    }
    forwardHoldActive = false;
    if (progressMousemoveHandler) document.removeEventListener('mousemove', progressMousemoveHandler);
    if (progressTouchmoveHandler) document.removeEventListener('touchmove', progressTouchmoveHandler);
    if (progressMouseupHandler) document.removeEventListener('mouseup', progressMouseupHandler);
    if (progressTouchendHandler) document.removeEventListener('touchend', progressTouchendHandler);
    progressMousemoveHandler = null;
    progressTouchmoveHandler = null;
    progressMouseupHandler = null;
    progressTouchendHandler = null;
    if (controllerObserver) {
      controllerObserver.disconnect();
      controllerObserver = null;
    }
    if (videoObserver) {
      videoObserver.disconnect();
      videoObserver = null;
    }
    if (controller && controller.parentNode) controller.parentNode.removeChild(controller);
    if (toggleButton && toggleButton.parentNode) toggleButton.parentNode.removeChild(toggleButton);
    controller = null;
    toggleButton = null;
    domCache = {
      playPauseBtn: null,
      progressFill: null,
      progressThumb: null,
      progressCurrentTime: null,
      progressTotalTime: null,
      progressBarContainer: null,
      speedBtn: null,
      speedSelect: null
    };
    mainVideoCache = null;
    mainVideoCacheTime = 0;
  }

  function init() {
    createToggleButton();
    autoHideWhenNoVideo();
    if (isEnabled) {
      createController();
    }
    setTimeout(tryAutoPlayMainVideo, CONFIG.autoPlayDelay);
  }

  // 页面加载完成后初始化
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // ========== SPA 单页兼容 ==========

  // 防抖重置，避免频繁路由切换导致 UI 闪烁
  let spaResetTimer = null;
  function resetForSPA() {
    if (spaResetTimer) clearTimeout(spaResetTimer);
    spaResetTimer = setTimeout(() => {
      autoPlayTriggered = false;
      autoPlayRetryCount = 0;
      destroy();
      init();
      spaResetTimer = null;
    }, 500);
  }

  // 监听 popstate（浏览器后退/前进）
  window.addEventListener('popstate', resetForSPA);

  // 拦截 pushState / replaceState（SPA 内部路由切换）
  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;
  history.pushState = function (...args) {
    origPushState.apply(this, args);
    resetForSPA();
  };
  history.replaceState = function (...args) {
    origReplaceState.apply(this, args);
    resetForSPA();
  };

  // 防抖工具
  function debounce(fn, delay) {
    let timer = null;
    return function (...args) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  // 监听DOM变化，检测新视频（防抖，只监听 childList）
  const debouncedVideoCheck = debounce(() => {
    if (!autoPlayTriggered) {
      tryAutoPlayMainVideo();
    }
    autoHideWhenNoVideo();
    // 有视频时确保定时器运行
    if (getMainVideo() && !timeUpdateInterval) {
      startTimeInterval();
    }
  }, 300);
  let videoObserver = null;

  setTimeout(() => {
    if (document.body) {
      videoObserver = new MutationObserver(debouncedVideoCheck);
      videoObserver.observe(document.body, { childList: true, subtree: true });
    }
  }, 1000);
})();