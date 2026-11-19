// ==UserScript==
// @name         视频控制条
// @namespace    http://tampermonkey.net/
// @version      3.1
// @description  智能识别主视频自动播放，两行紧凑控制条支持精确跳转、长按快进、倍速控制（优化版：timeupdate事件驱动/Pointer Events统一拖拽/修复forwardHold残留）
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
    minWidth: 280,
    minHeight: 160,
    autoPlayEnabled: true,
    autoPlayDelay: 200,
    autoPlayRetryInterval: 300,
    autoPlayMaxRetries: 8,
    holdSpeed: 3,                // forwardHold 持续快进的倍速
    holdStepMs: 100,             // forwardHold 累加时间的步长 (ms)
    holdTickInterval: 50,        // forwardHold 累加定时器间隔 (ms)
    jumpSteps: [
      { text: "-5m", seconds: -300 },
      { text: "-1m", seconds: -60 },
      { text: "-10s", seconds: -10 },
      { text: "+10s", seconds: 10 },
      { text: "+1m", seconds: 60 },
      { text: "+5m", seconds: 300 }
    ],
    speedOptions: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4],
    mainVideoCacheTTL: 300
  };

  // ========== 状态 ==========
  let controller = null;
  let autoPlayTriggered = false;
  let autoPlayRetryCount = 0;

  // forwardHold 持续快进
  let forwardHoldActive = false;
  let forwardHoldTimer = null;
  let forwardOriginRate = 1;
  let forwardButton = null;

  // getMainVideo 节流缓存
  let mainVideoCache = null;
  let mainVideoCacheTime = 0;

  // video 事件监听器（destroy / 主视频切换时清理）
  let currentVideo = null;
  const videoHandlers = {
    play: null, pause: null, timeupdate: null, loadedmetadata: null,
    ratechange: null
  };

  // observer 引用
  let controllerObserver = null;
  let videoObserver = null;

  // 需持久化的 document 级监听器引用（只在 destroy 里统一清理）
  let docSpeedMenuClickHandler = null;
  let docMousemoveHandler = null;
  let docMouseupHandler = null;
  let docTouchmoveHandler = null;
  let docTouchendHandler = null;

  // 进度条拖动 rect 缓存
  let progressBarRect = null;

  // ========== 工具 ==========
  function debounce(fn, delay) {
    let timer = null;
    return function (...args) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  function formatTime(sec) {
    if (!isFinite(sec)) return "--:--";
    sec = Math.max(0, sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const pad = x => String(x).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function clearMainVideoCache() {
    mainVideoCache = null;
    mainVideoCacheTime = 0;
  }

  // ========== 主视频识别 ==========

  function getMainVideo() {
    const now = Date.now();
    if (now - mainVideoCacheTime < CONFIG.mainVideoCacheTTL && mainVideoCache && mainVideoCache.isConnected) {
      return mainVideoCache;
    }

    const allVideos = Array.from(document.querySelectorAll('video'));
    let result = null;
    if (allVideos.length > 0) {
      const candidates = allVideos.filter(v => {
        // offsetWidth/Height 不触发 reflow，rect 才触发
        const w = v.offsetWidth, h = v.offsetHeight;
        if (w < CONFIG.minWidth || h < CONFIG.minHeight) return false;
        if (v.style.visibility === 'hidden') return false;
        const rect = v.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) return false;
        // 必须在可视区内（或至少部分可见）
        if (rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
        return true;
      });

      if (candidates.length === 1) {
        result = candidates[0];
      } else if (candidates.length > 1) {
        // 多候选 → 选实际显示面积最大的（含缩放）
        let best = null, bestArea = 0;
        for (const v of candidates) {
          const r = v.getBoundingClientRect();
          const area = r.width * r.height;
          if (area > bestArea) { bestArea = area; best = v; }
        }
        result = best;
      }
    }

    mainVideoCache = result;
    mainVideoCacheTime = now;
    return result;
  }

  // ========== 视频事件绑定/解绑 ==========

  /** 清理当前 video 上绑定的所有事件（每次新 video 都调用，确保不残留） */
  function unbindVideoEvents() {
    if (!currentVideo) return;
    try {
      for (const key of Object.keys(videoHandlers)) {
        if (videoHandlers[key]) {
          currentVideo.removeEventListener(key, videoHandlers[key]);
          videoHandlers[key] = null;
        }
      }
    } catch (e) {}
    currentVideo = null;
  }

  /** 绑定新 video 的 play/pause/timeupdate/ratechange —— 支持切换到不同 video 自动重绑 */
  function bindVideoEvents(vid) {
    if (!vid || vid === currentVideo) return;

    // 先清旧的
    unbindVideoEvents();

    videoHandlers.play    = () => { startForwardHoldIfActive(); };
    videoHandlers.pause   = () => { stopForwardHold(); };
    videoHandlers.timeupdate = () => { updateTimeDisplay(); };
    videoHandlers.loadedmetadata = () => { updateTimeDisplay(); };
    videoHandlers.ratechange = () => { updateTimeDisplay(); };

    // play/pause 用 click/play 混合：有的 site 用 click 替代事件派发
    vid.addEventListener('play', videoHandlers.play);
    vid.addEventListener('pause', videoHandlers.pause);
    vid.addEventListener('timeupdate', videoHandlers.timeupdate);
    vid.addEventListener('loadedmetadata', videoHandlers.loadedmetadata);
    vid.addEventListener('ratechange', videoHandlers.ratechange);

    currentVideo = vid;
    updateTimeDisplay();
  }

  // ========== forwardHold 持续快进 ==========

  function stopForwardHold() {
    if (forwardHoldTimer) {
      clearInterval(forwardHoldTimer);
      forwardHoldTimer = null;
    }
    if (forwardHoldActive) {
      const vid = getMainVideo();
      if (vid) vid.playbackRate = forwardOriginRate;
      if (forwardButton) {
        forwardButton.style.background = CONFIG.accentColor;
        forwardButton.style.color = CONFIG.textColor;
      }
      forwardHoldActive = false;
    }
  }

  function startForwardHoldIfActive() {
    // 视频播放时如果 forwardHoldActive=true，重新启动 interval（比如 forwardHold 激活后 video 被重建）
    if (!forwardHoldActive || forwardHoldTimer) return;
    const vid = getMainVideo();
    if (!vid) return;
    forwardOriginRate = vid.playbackRate;
    vid.playbackRate = CONFIG.holdSpeed;
    forwardHoldTimer = setInterval(() => {
      const v = getMainVideo();
      if (!v) { stopForwardHold(); return; }
      try {
        v.currentTime = Math.min(v.currentTime + CONFIG.holdStepMs / 1000 * CONFIG.holdSpeed, v.duration || 99999);
      } catch (e) { stopForwardHold(); }
    }, CONFIG.holdTickInterval);
  }

  // ========== 自动播放 ==========

  function tryAutoPlayMainVideo() {
    if (!CONFIG.autoPlayEnabled) return;
    if (autoPlayTriggered) return;

    const vid = getMainVideo();
    if (!vid) {
      if (autoPlayRetryCount < CONFIG.autoPlayMaxRetries) {
        autoPlayRetryCount++;
        setTimeout(tryAutoPlayMainVideo, CONFIG.autoPlayRetryInterval);
      }
      return;
    }

    autoPlayTriggered = true;
    vid.dataset.autoPlayTriggered = "1";

    vid.play().catch(err => {
      console.log('[VideoController] 自动播放被阻止:', err.message);
      vid.muted = true;
      vid.play().catch(() => {
        console.log('[VideoController] 静音自动播放也被阻止');
      });
    });
  }

  // ========== 辅助操作 ==========

  function adjustMainVideoTime(sec) {
    const vid = getMainVideo();
    if (!vid) return;
    try {
      const dur = isFinite(vid.duration) ? vid.duration : NaN;
      vid.currentTime = Math.max(0, Math.min(vid.currentTime + sec, isFinite(dur) ? dur : vid.currentTime + sec));
    } catch (e) {}
  }

  function autoHideWhenNoVideo() {
    if (!controller) return;
    const vid = getMainVideo();
    controller.style.opacity = vid ? "1" : "0";
    controller.style.pointerEvents = vid ? "auto" : "none";
  }

  // ========== 控制面板创建 ==========

  function createController() {
    if (controller) return;

    // 延迟注入速度 select options HTML（预存 CONFIG.speedOptions）
    const speedOptsHTML = CONFIG.speedOptions.map(r =>
      `<option value="${r}">${r}x</option>`).join('');

    // —— 容器 ——
    controller = document.createElement("div");
    controller.id = "video-precise-controller";

    const savedPos = GM_getValue('controllerPos', null);
    const posInit = savedPos
      ? `left:${savedPos.x}px;top:${savedPos.y}px;`
      : `left:50%;bottom:85px;transform:translateX(-50%);`;

    Object.assign(controller.style, {
      position: 'fixed',
      background: CONFIG.debugBg,
      padding: '0',
      borderRadius: CONFIG.borderRadius,
      display: 'flex',
      flexDirection: 'column',
      gap: CONFIG.gap,
      zIndex: '2147483647',
      boxShadow: 'none',
      width: CONFIG.panelWidth,
      maxWidth: '460px',
      fontSize: CONFIG.fontSize,
      color: CONFIG.textColor,
      transition: 'opacity 0.3s ease',
      border: 'none',
      userSelect: 'none',
      touchCallout: 'none',
      ...styleObjParse(posInit),
      opacity: '1'
    });

    // —— 拖拽手柄（Pointer Events 统一鼠标+触控）——
    const dragHandle = document.createElement("div");
    Object.assign(dragHandle.style, {
      position: 'absolute', top: '0', left: '0', width: '7px', height: '7px',
      background: 'rgba(200,200,200,0.35)', cursor: 'grab', userSelect: 'none',
      zIndex: '2', borderRadius: '0 0 4px 0'
    });

    // —— 容器内部 ——
    const controllerInner = document.createElement("div");
    Object.assign(controllerInner.style, {
      padding: '12px', display: 'flex', flexDirection: 'column', gap: CONFIG.gap
    });

    // —— 拖拽状态（Pointer Events）——
    let cDragging = false, cMoved = false;
    let cDragStartX = 0, cDragStartY = 0;
    let cBtnStartX = 0, cBtnStartY = 0;

    dragHandle.style.touchAction = 'none';
    dragHandle.addEventListener('pointerdown', (e) => {
      cDragging = true;
      cMoved = false;
      cDragStartX = e.clientX;
      cDragStartY = e.clientY;
      const rect = controller.getBoundingClientRect();
      cBtnStartX = rect.left;
      cBtnStartY = rect.top;
      dragHandle.setPointerCapture && dragHandle.setPointerCapture(e.pointerId);
      dragHandle.style.cursor = 'grabbing';
      e.preventDefault();
      e.stopPropagation();
    });
    dragHandle.addEventListener('pointermove', (e) => {
      if (!cDragging) return;
      const dx = e.clientX - cDragStartX;
      const dy = e.clientY - cDragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) cMoved = true;
      const maxX = window.innerWidth - controller.offsetWidth;
      const maxY = window.innerHeight - 10;
      controller.style.left = Math.max(0, Math.min(maxX, cBtnStartX + dx)) + 'px';
      controller.style.top = Math.max(0, Math.min(maxY, cBtnStartY + dy)) + 'px';
      controller.style.bottom = 'auto';
      controller.style.right = 'auto';
      controller.style.transform = 'none';
    });
    dragHandle.addEventListener('pointerup', () => {
      if (!cDragging) return;
      cDragging = false;
      dragHandle.style.cursor = 'grab';
      if (cMoved) {
        const rect = controller.getBoundingClientRect();
        GM_setValue('controllerPos', { x: rect.left, y: rect.top });
      }
    });
    dragHandle.addEventListener('pointercancel', () => {
      if (cDragging) { cDragging = false; dragHandle.style.cursor = 'grab'; }
    });

    // —— 第一行：跳转按钮 + 倍速 + 播放 ——
    const controlWrap = document.createElement("div");
    Object.assign(controlWrap.style, {
      display: 'flex', gap: CONFIG.gap, width: '100%', alignItems: 'center'
    });

    CONFIG.jumpSteps.forEach(item => controlWrap.appendChild(createLargeButton(item.text, item.seconds)));

    // 倍速
    const speedWrap = document.createElement("div");
    Object.assign(speedWrap.style, { position: 'relative', flexShrink: '0' });

    const speedBtn = document.createElement("button");
    speedBtn.id = "speed-btn";
    speedBtn.textContent = "1x";
    Object.assign(speedBtn.style, {
      background: CONFIG.buttonColor, color: CONFIG.textColor, border: 'none',
      borderRadius: '8px', padding: '5px 10px', cursor: 'pointer',
      fontSize: '13px', minWidth: '42px', transition: '0.16s'
    });

    const speedMenu = document.createElement("select");
    speedMenu.id = "speed-select";
    speedMenu.innerHTML = speedOptsHTML;
    Object.assign(speedMenu.style, {
      position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
      background: CONFIG.buttonColor, color: CONFIG.textColor, border: 'none',
      borderRadius: '8px', padding: '5px 8px', marginBottom: '6px',
      display: 'none', zIndex: '2147483647'
    });

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

    // 点击其他地方关闭菜单 —— 只绑一次（在 createController 外）
    if (!docSpeedMenuClickHandler) {
      docSpeedMenuClickHandler = (e) => {
        if (!speedWrap.contains(e.target)) speedMenu.style.display = "none";
      };
      document.addEventListener('click', docSpeedMenuClickHandler);
    }

    speedWrap.append(speedBtn, speedMenu);

    // 播放/暂停
    const playPauseBtn = document.createElement("button");
    playPauseBtn.id = "play-pause-btn";
    playPauseBtn.textContent = "▶";
    Object.assign(playPauseBtn.style, {
      border: 'none', borderRadius: '8px', background: CONFIG.accentColor,
      color: CONFIG.textColor, padding: '6px 12px', cursor: 'pointer',
      fontSize: '16px', transition: '0.16s', flexShrink: '0'
    });
    playPauseBtn.onclick = () => {
      const vid = getMainVideo();
      if (!vid) return;
      if (vid.paused) vid.play().catch(() => {});
      else vid.pause();
    };

    // forwardHold 持续快进（点击激活/停用）
    forwardButton = document.createElement("button");
    forwardButton.id = "forward-hold-btn";
    forwardButton.textContent = "》";
    Object.assign(forwardButton.style, {
      border: 'none', borderRadius: '8px', background: CONFIG.accentColor,
      color: CONFIG.textColor, padding: '6px 12px', cursor: 'pointer',
      fontSize: '16px', transition: '0.16s', flexShrink: '0'
    });
    forwardButton.onclick = () => {
      const vid = getMainVideo();
      if (!vid) return;
      if (!forwardHoldActive) {
        forwardOriginRate = vid.playbackRate;
        forwardHoldActive = true;
        startForwardHoldIfActive();
        // 激活时按 CONFIG.holdSpeed 直接设置倍速
        vid.playbackRate = CONFIG.holdSpeed;
        forwardButton.style.background = CONFIG.textColor;
        forwardButton.style.color = CONFIG.accentColor;
      } else {
        stopForwardHold();
        if (forwardButton) {
          forwardButton.style.background = CONFIG.accentColor;
          forwardButton.style.color = CONFIG.textColor;
        }
      }
    };

    controlWrap.append(speedWrap, playPauseBtn, forwardButton);

    // —— 第二行：进度条 ——
    const progressWrap = document.createElement("div");
    Object.assign(progressWrap.style, { display: 'flex', alignItems: 'center', gap: '8px' });

    const currentTimeLabel = document.createElement("span");
    currentTimeLabel.id = "progress-current-time";
    Object.assign(currentTimeLabel.style, {
      fontFamily: 'monospace', fontSize: '12px', minWidth: '42px', textAlign: 'right'
    });
    currentTimeLabel.textContent = "00:00";

    const progressBarContainer = document.createElement("div");
    progressBarContainer.id = "progress-bar-container";
    Object.assign(progressBarContainer.style, {
      flex: '1', height: '8px', background: CONFIG.buttonColor, borderRadius: '4px',
      cursor: 'pointer', position: 'relative', overflow: 'visible'
    });

    const progressBarFill = document.createElement("div");
    progressBarFill.id = "progress-bar-fill";
    Object.assign(progressBarFill.style, {
      height: '100%', background: CONFIG.accentColor, borderRadius: '4px',
      width: '0%', transition: 'width 0.1s linear'
    });

    const progressThumb = document.createElement("div");
    progressThumb.id = "progress-thumb";
    Object.assign(progressThumb.style, {
      position: 'absolute', top: '50%', width: '14px', height: '14px',
      borderRadius: '50%', background: CONFIG.textColor,
      transform: 'translate(-50%, -50%)', left: '0%',
      boxShadow: '0 1px 3px rgba(0,0,0,0.3)', transition: 'left 0.1s linear'
    });

    progressBarContainer.append(progressBarFill, progressThumb);

    const totalTimeLabel = document.createElement("span");
    totalTimeLabel.id = "progress-total-time";
    Object.assign(totalTimeLabel.style, {
      fontFamily: 'monospace', fontSize: '12px', minWidth: '42px', textAlign: 'left'
    });
    totalTimeLabel.textContent = "00:00";

    progressWrap.append(currentTimeLabel, progressBarContainer, totalTimeLabel);

    // 缓存进度条 rect（拖动时不重复 getBoundingClientRect）
    let isDragging = false;
    let dragPercent = 0;

    function cacheProgressRect() {
      progressBarRect = progressBarContainer.getBoundingClientRect();
    }

    const updateDragUI = (clientX) => {
      const vid = getMainVideo();
      if (!vid || !isFinite(vid.duration)) return;
      // rect 在 mousedown/touchstart 时已缓存
      const rect = progressBarRect || progressBarContainer.getBoundingClientRect();
      const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      dragPercent = percent;
      progressBarFill.style.width = percent * 100 + '%';
      progressThumb.style.left = percent * 100 + '%';
      currentTimeLabel.textContent = formatTime(percent * vid.duration);
    };

    const seekToDrag = () => {
      const vid = getMainVideo();
      if (!vid || !isFinite(vid.duration)) return;
      vid.currentTime = dragPercent * vid.duration;
    };

    // 全局拖动监听器（只绑一次，引用持久化）
    if (!docMousemoveHandler)  docMousemoveHandler  = (e) => { if (isDragging) updateDragUI(e.clientX); };
    if (!docTouchmoveHandler)  docTouchmoveHandler  = (e) => { if (isDragging && e.touches && e.touches[0]) updateDragUI(e.touches[0].clientX); };
    if (!docMouseupHandler)    docMouseupHandler    = () => { if (isDragging) { isDragging = false; seekToDrag(); } };
    if (!docTouchendHandler)   docTouchendHandler   = () => { if (isDragging) { isDragging = false; seekToDrag(); } };

    document.addEventListener('mousemove', docMousemoveHandler);
    document.addEventListener('touchmove', docTouchmoveHandler, { passive: true });
    document.addEventListener('mouseup', docMouseupHandler);
    document.addEventListener('touchend', docTouchendHandler);

    progressBarContainer.addEventListener('mousedown', (e) => {
      isDragging = true;
      cacheProgressRect();
      updateDragUI(e.clientX);
    });
    progressBarContainer.addEventListener('touchstart', (e) => {
      isDragging = true;
      cacheProgressRect();
      if (e.touches && e.touches[0]) updateDragUI(e.touches[0].clientX);
    }, { passive: true });

    controllerInner.append(controlWrap, progressWrap);
    controller.append(dragHandle, controllerInner);

    if (!document.body) {
      // body 还没好就定时等一下（虽然 @run-at 默认已经是 document-idle）
      setTimeout(() => document.body && document.body.appendChild(controller), 100);
    } else {
      document.body.appendChild(controller);
    }

    // 绑定主视频事件（如果此时有主视频）
    const vid = getMainVideo();
    if (vid) bindVideoEvents(vid);

    // 防御性观察器：防止 controller 被网站 DOM 清理
    controllerObserver = new MutationObserver(() => {
      if (!document.body) return;
      if (!document.body.contains(controller)) {
        document.body.appendChild(controller);
        controller.style.opacity = "1";
        controller.style.pointerEvents = "auto";
      }
    });
    controllerObserver.observe(document.body, { childList: true, subtree: true });
  }

  // 创建带"按压动画"的跳转按钮
  function createLargeButton(text, stepSec) {
    const btn = document.createElement("button");
    btn.textContent = text;
    Object.assign(btn.style, {
      flex: '1', padding: '8px 1px', border: 'none', borderRadius: '8px',
      background: CONFIG.accentColor, color: CONFIG.textColor, fontWeight: 'bold',
      fontSize: '12px', whiteSpace: 'nowrap', transition: '0.16s',
      userSelect: 'none'
    });
    btn.addEventListener('click', () => adjustMainVideoTime(stepSec));

    const pressDown = () => { btn.style.transform = 'scale(0.96)'; };
    const pressUp = () => { btn.style.transform = 'scale(1)'; };
    btn.addEventListener('pointerdown', pressDown);
    btn.addEventListener('pointerup', pressUp);
    btn.addEventListener('pointerleave', pressUp);
    btn.addEventListener('pointercancel', pressUp);
    return btn;
  }

  // ========== 时间显示更新（被 video.timeupdate 事件驱动，替代原 interval 轮询）==========

  function updateTimeDisplay() {
    if (!controller) return;
    const vid = getMainVideo();
    if (!vid || !isFinite(vid.duration)) return;

    // 同步 play/pause 按钮
    const playPauseBtn = controller.querySelector('#play-pause-btn');
    if (playPauseBtn) playPauseBtn.textContent = vid.paused ? "▶" : "⏸";

    // 同步倍速按钮文本（仅在数值变化时写 DOM，减少重排）
    const rate = vid.playbackRate;
    const newRateText = rate + "x";
    const speedBtn = controller.querySelector('#speed-btn');
    if (speedBtn && speedBtn.textContent !== newRateText) {
      speedBtn.textContent = newRateText;
    }
    // select option 对齐：预存 CONFIG.speedOptions 减少遍历
    const speedMenu = controller.querySelector('#speed-select');
    if (speedMenu && Math.abs(+speedMenu.value - rate) > 0.01) {
      let closestIdx = 0, closestDiff = Infinity;
      for (let i = 0; i < CONFIG.speedOptions.length; i++) {
        const d = Math.abs(CONFIG.speedOptions[i] - rate);
        if (d < closestDiff) { closestDiff = d; closestIdx = i; }
      }
      speedMenu.value = CONFIG.speedOptions[closestIdx];
    }

    // 进度条（拖动中不更新 fill，避免和拖动 UI 冲突）
    const progressFill = controller.querySelector('#progress-bar-fill');
    const progressThumb = controller.querySelector('#progress-thumb');
    const progressCurrentTime = controller.querySelector('#progress-current-time');
    const progressTotalTime = controller.querySelector('#progress-total-time');

    if (progressFill && progressThumb && progressCurrentTime && progressTotalTime) {
      const percent = (vid.currentTime / vid.duration) * 100;
      progressFill.style.width = percent + '%';
      progressThumb.style.left = percent + '%';
      progressCurrentTime.textContent = formatTime(vid.currentTime);
      progressTotalTime.textContent = formatTime(vid.duration);
    }
  }

  // ========== 销毁（SPA 重置时调用） / 初始化 ==========

  function resetController() {
    stopForwardHold();
    forwardHoldActive = false;
    unbindVideoEvents();
    if (controllerObserver) { controllerObserver.disconnect(); controllerObserver = null; }
    if (videoObserver)     { videoObserver.disconnect();     videoObserver      = null; }
    if (controller && controller.parentNode) controller.parentNode.removeChild(controller);
    controller = null;
    forwardButton = null;
    clearMainVideoCache();
  }

  function init() {
    createController();
    autoHideWhenNoVideo();
    setTimeout(tryAutoPlayMainVideo, CONFIG.autoPlayDelay);
  }

  // ========== SPA 单页兼容 ==========

  let spaResetTimer = null;
  const resetForSPA = () => {
    if (spaResetTimer) clearTimeout(spaResetTimer);
    spaResetTimer = setTimeout(() => {
      autoPlayTriggered = false;
      autoPlayRetryCount = 0;
      resetController();
      createController();
      autoHideWhenNoVideo();
      spaResetTimer = null;
    }, 500);
  };

  window.addEventListener('popstate', resetForSPA);

  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;
  history.pushState   = function (...args) { origPushState.apply(this, args);   resetForSPA(); };
  history.replaceState = function (...args) { origReplaceState.apply(this, args); resetForSPA(); };

  // ========== 主视频变化检测（MutationObserver + 防抖）==========

  const debouncedVideoCheck = debounce(() => {
    const vid = getMainVideo();
    // 主视频切换检测
    if (vid && vid !== currentVideo) {
      bindVideoEvents(vid);
      clearMainVideoCache();
    }
    // 自动播放兜底
    if (!autoPlayTriggered) tryAutoPlayMainVideo();
    autoHideWhenNoVideo();
  }, 300);

  // 等 body 存在后启动 observer
  const startVideoObserver = () => {
    if (!document.body) return false;
    videoObserver = new MutationObserver(debouncedVideoCheck);
    videoObserver.observe(document.body, { childList: true, subtree: true });
    return true;
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      init();
      startVideoObserver();
    });
  } else {
    init();
    startVideoObserver();
  }

  // 兜底：body 晚于 init 才出现的情况
  setTimeout(startVideoObserver, 1000);
  setTimeout(startVideoObserver, 3000);

  // ========== 小工具 ==========

  /** 把 "left:50%;bottom:85px;transform:translateX(-50%);" 这种 style 字符串转成 CSSStyleDeclaration 对象可 assign 的 plain object */
  function styleObjParse(str) {
    const out = {};
    str.split(';').forEach(pair => {
      const [k, v] = pair.split(':').map(s => s && s.trim());
      if (k && v) {
        // 驼峰化
        const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        out[camel] = v;
      }
    });
    return out;
  }

})();
