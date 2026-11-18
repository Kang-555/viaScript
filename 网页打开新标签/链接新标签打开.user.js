// ==UserScript==
// @name         链接净化｜新标签打开+去中转直达+去广告+自由复制
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  去除外链中转跳转直达原链接、链接新标签打开、视频播放器区域广告多层拦截（/pop /ad-skip 透明遮罩 onclick）、隐藏网页广告、清理追踪参数、解除文本复制限制（全能版）
// @author       You
// @match        *://*/*
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ============================================================
    // 1. CSS 广告屏蔽（含视频播放器区域专项规则）
    // ============================================================
    GM_addStyle(`
        /* —— 通用广告元素 —— */
        [class*="ad-container"],[class*="ad-wrapper"],[class*="ad-banner"],
        [class*="ads-box"],[class*="ads-module"],[class*="advertisement"],
        [id*="ad-container"],[id*="ad-wrapper"],[id*="ad-banner"],
        [id*="ads-box"],[id*="ads-module"],[id*="advertisement"],
        .ad-popup,.sidebar-ad,.float-ad,.modal-ad,.overlay-ad,
        iframe[src*="doubleclick"],iframe[src*="googlesyndication"],
        iframe[src*="adservice"],ins.adsbygoogle,
        [data-ad-slot],[data-ad-client],[aria-label*="广告"],[data-ad-container],
        [class*="baidu-union"],[class*="google-ads"],[class*="tencent-ad"],
        [class*="float-ad"][class*="fixed"],[class*="popup"][class*="ad"]
        { display:none !important; visibility:hidden !important; pointer-events:none !important; }

        /* —— 视频播放器区域叠加广告 —— */
        .video-ad-overlay,.ad-overlay-video,.video-overlay-ad,
        [class*="video-ad"][class*="overlay"],
        [class*="ad-skip"],[class*="skip-ad"],
        [class*="ad-close"]:not([class*="player"]),
        [id*="video-ad"],[id*="player-ad"],
        [class*="preroll"],[class*="midroll"],[class*="postroll"]
        { display:none !important; visibility:hidden !important; pointer-events:none !important; }

        /* —— 透明遮罩层：覆盖整个视频区域的点击劫持层 —— */
        .ad-mask,[class*="click-mask"][class*="ad"],
        [class*="player-mask"][class*="ad"],
        [class*="video-area"]>[class*="ad"],
        [class*="player-area"]>[class*="ad"]
        { pointer-events:none !important; }

        /* —— 自由复制：强制允许选中文本 —— */
        *, *::before, *::after {
            user-select: auto !important;
            -webkit-user-select: auto !important;
            -moz-user-select: auto !important;
            -ms-user-select: auto !important;
        }
        body {
            user-select: auto !important;
            -webkit-user-select: auto !important;
            -moz-user-select: auto !important;
            -ms-user-select: auto !important;
        }
        ::selection { background: #00bfff !important; }
    `);

    // ============================================================
    // 2. 链接净化：中转规则 + 追踪参数
    // ============================================================
    const redirectRules = [
        { reg: /^https?:\/\/link\.zhihu\.com\/\?target=([^&]+)/, get: m => decodeURIComponent(m[1]) },
        { reg: /^https?:\/\/link\.juejin\.cn\/\?target=([^&]+)/, get: m => decodeURIComponent(m[1]) },
        { reg: /^https?:\/\/link\.csdn\.net\/\?target=([^&]+)/, get: m => decodeURIComponent(m[1]) },
        { reg: /^https?:\/\/links\.jianshu\.com\/go\?target=([^&]+)/, get: m => decodeURIComponent(m[1]) },
        { reg: /^https?:\/\/www\.douban\.com\/link2\/\?url=([^&]+)/, get: m => decodeURIComponent(m[1]) },
        { reg: /^https?:\/\/mp\.weixin\.qq\.com\/.*[?&]url=([^&]+)/, get: m => decodeURIComponent(m[1]) },
        { reg: /^https?:\/\/www\.baidu\.com\/link\?url=([^&]+)/, get: m => decodeURIComponent(m[1]) },
        { reg: /^https?:\/\/.*\.sogou\.com\/.*[?&]url=([^&]+)/, get: m => decodeURIComponent(m[1]) },
        { reg: /[?&]url=(https?:\/\/[^&]+)/, get: m => decodeURIComponent(m[1]) },
        { reg: /[?&]target=(https?:\/\/[^&]+)/, get: m => decodeURIComponent(m[1]) },
        { reg: /[?&](?:jump|redirect|to|goto|link)=(https?:\/\/[^&]+)/, get: m => decodeURIComponent(m[1]) },
        { reg: /\/pop\?url=(https?:\/\/[^&]+)/, get: m => decodeURIComponent(m[1]) }
    ];

    const trackParams = [
        "utm_source","utm_medium","utm_campaign","utm_term","utm_content",
        "fbclid","gclid","msclkid","dclid","wbraid",
        "spm","scm","upp_content_id","tracker","trackid",
        "ref","referer","source","medium","campaign"
    ];

    function cleanLinkUrl(rawUrl) {
        if (!rawUrl) return rawUrl;
        let url = rawUrl.trim();
        let isCleaned = false;

        for (const rule of redirectRules) {
            const match = url.match(rule.reg);
            if (match && match[1]) {
                const extracted = rule.get(match);
                if (extracted && (extracted.startsWith('http://') || extracted.startsWith('https://'))) {
                    url = extracted;
                    isCleaned = true;
                    break;
                }
            }
        }

        try {
            const urlObj = new URL(url);
            let paramsRemoved = false;
            trackParams.forEach(p => {
                if (urlObj.searchParams.has(p)) { urlObj.searchParams.delete(p); paramsRemoved = true; }
            });
            if (paramsRemoved) { url = urlObj.toString(); isCleaned = true; }
        } catch (e) {}

        return isCleaned ? url : rawUrl;
    }

    function debounce(func, delay) {
        let timer = null;
        return function(...args) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { func.apply(this, args); }, delay);
        };
    }

    function shouldSkipLink(href) {
        if (!href) return true;
        if (href.startsWith('#')) return true;
        if (href.startsWith('javascript:')) return true;
        if (href.startsWith('mailto:') || href.startsWith('tel:')) return true;
        try {
            const url = new URL(href);
            const cur = window.location;
            if (url.origin === cur.origin && url.pathname === cur.pathname && url.search === cur.search) return true;
        } catch (e) {}
        return false;
    }

    // ============================================================
    // 3. 视频播放器区域检测 + 广告识别（多信号判定）
    // ============================================================
    const VIDEO_PLAYER_SELECTOR = [
        'video','.video-player','.player','.video-container',
        '#player','.video-wrap','.play-area','iframe[src*="player"]',
        '[class*="video-player"]','[class*="player-container"]','[class*="video-player-box"]',
        '[id*="player"]','[id*="video-player"]'
    ].join(',');

    // 强广告路径（单独出现即可判广告）
    const AD_PATH_STRONG = [
        /\/pop\?url=/i,
        /\/pop\/(redirect|jump|goto)/i,
        /\/ad\/click/i,
        /\/advertisement\//i,
        /adredirect|ad[-_]?redirect/i,
        /doubleclick|googlesyndication|adservice\.google/i,
        /adnxs|openx|pubmatic|criteo|rubicon|taboola|outbrain/i,
        /adform|admob|adcolony/i,
    ];

    // 弱信号（需与其他广告关键词叠加判定）
    const AD_PATH_WEAK = /(^|[?&\/])(ad[s]?|promo|sponsor|commercial|pre[-_]?roll|mid[-_]?roll|post[-_]?roll|bumper|in[-_]?stream)([?=&\/]|$)/i;
    const AD_HINT_RE = /\b(pop|popup|promo|offer|coupon|sponsor|sponsored|ad|ads|advert)\b/i;

    /** 多信号判定：URL / onclick / 元素属性 → 是否广告 */
    function isAdLink(url, element) {
        if (!url) return false;

        // 信号1：强广告路径（最高优先级，命中即广告）
        for (const re of AD_PATH_STRONG) { if (re.test(url)) return true; }

        // 信号2：弱广告路径 + 追踪参数组合
        if (AD_PATH_WEAK.test(url) && /[?&](from|ad_|utm_|source|campaign|spm|scm)=/i.test(url)) return true;

        // 信号3：元素属性辅助判定
        if (element) {
            const cls = (element.className || '').toString();
            const id = element.id || '';
            const attrs = [
                cls, id,
                element.getAttribute('class') || '',
                element.getAttribute('id') || '',
                element.getAttribute('data-ad') || '',
                element.getAttribute('data-popup') || '',
                element.getAttribute('data-ad-slot') || '',
                element.getAttribute('aria-label') || '',
            ].join(' ');
            if (/ad[-_]?(popup|overlay|banner|cover|skip|close|mask|btn|link|redirect)/i.test(attrs)) return true;
            if (/video[-_]?(ad|ads|overlay|pop|skip)/i.test(attrs)) return true;
            if (/(广告|推广|赞助|点此跳过|跳过广告|Ad|Skip|Sponsored|Promoted)/.test(attrs)) return true;
        }

        return false;
    }

    /** 判定 onclick / onblclick handler 是否为广告跳转 */
    function isAdOnclick(handlerStr) {
        if (!handlerStr) return false;
        const s = handlerStr.toString();
        const hasJump = /location\.(href|assign|replace)|window\.open\s*\(|open\s*\(/.test(s);
        if (!hasJump) return false;
        // 跳转 + 广告关键词 → 广告
        return AD_PATH_STRONG.some(re => re.test(s))
            || (AD_PATH_WEAK.test(s) && AD_HINT_RE.test(s))
            || AD_HINT_RE.test(s);
    }

    /** 判断是否位于视频播放器 DOM 子树内 */
    function isInVideoPlayer(target) {
        if (!target || !target.closest) return false;
        return !!target.closest(VIDEO_PLAYER_SELECTOR);
    }

    // ============================================================
    // 4. 链接处理（视频区域广告 → 直接标记 + 阻断）
    // ============================================================
    function processLink(a) {
        if (a.dataset.linkProcessed) return;
        const originHref = a.getAttribute('href');
        if (shouldSkipLink(originHref)) return;
        const absoluteUrl = a.href;
        if (!absoluteUrl || absoluteUrl === 'about:blank') return;

        // 视频区域内广告 → 标记 + 关闭指针事件 + 不设 target=_blank
        if (isInVideoPlayer(a) && isAdLink(absoluteUrl, a)) {
            console.log('[链接净化][广告] 视频区域广告<a>:', absoluteUrl);
            a.dataset.linkProcessed = 'true';
            a.dataset.adLink = '1';
            a.style.pointerEvents = 'none';
            if (a.parentNode) a.parentNode.style.pointerEvents = 'none';
            return;
        }

        const cleanUrl = cleanLinkUrl(absoluteUrl);
        if (cleanUrl !== absoluteUrl) a.href = cleanUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.dataset.linkProcessed = 'true';
    }

    function processLinks() {
        document.querySelectorAll('a:not([data-link-processed])').forEach(processLink);
        document.querySelectorAll('svg a:not([data-link-processed])').forEach(processLink);
    }

    // ============================================================
    // 5. 事件委托：视频区域全面拦截（不仅 <a>）
    // ============================================================
    function setupEventDelegation() {
        // —— 点击捕获阶段 ——
        document.addEventListener('click', (e) => {
            const target = e.target;
            const inVideo = isInVideoPlayer(target);

            if (inVideo) {
                // A. 预先标记的 [data-ad-link]（MutationObserver 已标注的）
                const marked = target.closest('[data-ad-link="1"]');
                if (marked) {
                    console.log('[链接净化][拦截] 视频区域已标记广告元素');
                    e.preventDefault(); e.stopImmediatePropagation();
                    return;
                }

                // B. <a> 标签 — 即时检测
                const link = target.closest('a');
                if (link) {
                    const href = link.href || link.getAttribute('href') || '';
                    if (isAdLink(href, link)) {
                        console.log('[链接净化][拦截] 视频区域广告<a>:', href.slice(0, 120));
                        e.preventDefault(); e.stopImmediatePropagation();
                        link.dataset.adLink = '1';
                        link.style.pointerEvents = 'none';
                        return;
                    }
                }

                // C. 非 <a> 元素 — 带 onclick 的广告覆盖层 div/span/button
                if (target.onclick && isAdOnclick(target.onclick)) {
                    console.log('[链接净化][拦截] 视频区域广告onclick元素:', (target.className || target.tagName));
                    e.preventDefault(); e.stopImmediatePropagation();
                    return;
                }

                // D. 直接点击 <video> 元素（广告跳转绑在 video 自身上）
                if (target.tagName === 'VIDEO') {
                    const vc = target.getAttribute('onclick') || target.getAttribute('onclick') || '';
                    const vc2 = target.getAttribute('ondblclick') || '';
                    if (isAdOnclick(vc) || isAdOnclick(vc2)) {
                        console.log('[链接净化][拦截] video元素广告onclick');
                        e.preventDefault(); e.stopImmediatePropagation();
                        return;
                    }
                }

                // E. 假关闭/跳过按钮（.ad-close / .skip-ad / [class*="ad-btn"] 实际跳广告）
                const fakeBtn = target.closest(
                    'button,[role="button"],[data-action],' +
                    '[class*="skip-ad"],[class*="ad-skip"],[class*="ad-close"],' +
                    '[class*="close-ad"],[class*="ad-btn"],[class*="ad-button"],' +
                    '[class*="ad-link"],[class*="click-ad"]'
                );
                if (fakeBtn) {
                    const oc = fakeBtn.onclick ? fakeBtn.onclick.toString() : '';
                    const ahref = fakeBtn.getAttribute('href') || '';
                    if (oc && isAdOnclick(oc)) {
                        console.log('[链接净化][拦截] 视频区域假关闭/跳过按钮(onclick)');
                        e.preventDefault(); e.stopImmediatePropagation();
                        return;
                    }
                    if (ahref && (isAdLink(ahref, fakeBtn) || /\/pop\?url=/i.test(ahref))) {
                        console.log('[链接净化][拦截] 视频区域假关闭/跳过按钮(href)');
                        e.preventDefault(); e.stopImmediatePropagation();
                        return;
                    }
                }
            }

            // 非视频区域：普通链接处理
            const normalLink = target.closest('a:not([data-link-processed])');
            if (normalLink) processLink(normalLink);
        }, true);

        // —— dblclick 捕获：video 上的 ondblclick 广告 ——
        document.addEventListener('dblclick', (e) => {
            if (isInVideoPlayer(e.target) && e.target.tagName === 'VIDEO') {
                const oc = e.target.getAttribute('ondblclick') || '';
                if (isAdOnclick(oc)) {
                    console.log('[链接净化][拦截] video元素广告ondblclick');
                    e.preventDefault(); e.stopImmediatePropagation();
                }
            }
        }, true);

        // —— contextmenu 捕获：右键被页面阻止 → 同时也别让视频广告在右键里藏跳转 ——
        // （自由复制 CSS 已生效，这里不额外处理右键拦截，保持页面右键可用）
    }

    // ============================================================
    // 6. 自由复制：事件拦截（让页面禁止复制的监听器失效）
    // ============================================================
    function blockCopyLimitEvents() {
        // 捕获阶段阻止页面禁止事件向下传播 —— 不自己 stop 这些事件，只停止禁止者
        document.addEventListener('selectstart', function(e) { e.stopPropagation(); }, true);
        document.addEventListener('mousedown', function(e) {
            // 只在用户真正开始选文本时停止传播，不影响 button/video 点击
            if (e.button === 0) e.stopPropagation();
        }, true);

        // copy/cut 事件：让页面的 e.preventDefault() 不生效 —— 系统剪贴板自动工作
        // 注意：这里故意不 stopImmediatePropagation，让真正想复制的代码还能跑
    }

    // ============================================================
    // 7. JS 动态跳转拦截（合并 window.open + setTimeout/setInterval）
    // ============================================================
    function interceptDynamicLinks() {
        // —— 合并两处 window.open 赋值为单次（修复原脚本重复赋值 bug） ——
        const originalOpen = window.open;
        window.open = function(url, name, specs) {
            const isAdPopup = (
                (specs && (specs.includes('width=') || specs.includes('height=')) &&
                 specs.includes('toolbar=no') && specs.includes('menubar=no')) ||
                (url && (
                    /ad|popup|modal|dialog|promo|offer|coupon/i.test(url)
                    || /doubleclick|googlesyndication/i.test(url)
                    || /\/pop\?url=/i.test(url)
                )) ||
                (!url || url === 'about:blank')
            );

            if (isAdPopup) {
                console.log('[链接净化][拦截] 广告弹窗 window.open:', url || '(empty)');
                return null;
            }

            const cleanUrl = cleanLinkUrl(url);
            const mergedSpecs = (specs ? specs + ',' : '') + 'noopener,noreferrer';
            return originalOpen.call(this, cleanUrl, name, mergedSpecs);
        };

        // —— 拦截定时器里的广告弹窗 ——
        const originalSetTimeout = window.setTimeout;
        const originalSetInterval = window.setInterval;

        window.setTimeout = function(func, delay, ...args) {
            if (typeof func === 'string') {
                if (/location\.href\s*=|location\.assign\s*\(|location\.replace\s*\(|window\.open\s*\(|alert\s*\(|confirm\s*\(|popup/i.test(func)
                    && /ad|pop|promo|offer/i.test(func)) {
                    console.log('[链接净化][拦截] 定时字符串弹窗');
                    return null;
                }
            } else if (typeof func === 'function') {
                const fs = func.toString();
                if ((/location\.href\s*=|location\.assign\s*\(|window\.open\s*\(|showModal/i.test(fs))
                    && /ad|promo|offer|coupon/i.test(fs)) {
                    console.log('[链接净化][拦截] 定时广告函数');
                    return null;
                }
            }
            return originalSetTimeout.call(this, func, delay, ...args);
        };

        window.setInterval = function(func, delay, ...args) {
            if (typeof func === 'string'
                && (/location\.href\s*=|window\.open\s*\(|popup/i.test(func))
                && /ad|pop|promo/i.test(func)) {
                console.log('[链接净化][拦截] 定时循环广告弹窗');
                return null;
            }
            return originalSetInterval.call(this, func, delay, ...args);
        };

        // —— 表单强制新标签 ——
        document.querySelectorAll('form:not([data-form-processed])').forEach(form => {
            if (!form.target || form.target === '_self') form.target = '_blank';
            form.dataset.formProcessed = 'true';
        });
    }

    // ============================================================
    // 8. 执行策略（分层触发 + 观察者 + 多时机兜底）
    // ============================================================
    const debouncedProcessLinks = debounce(processLinks, 300);
    const observer = new MutationObserver(mutations => {
        const hasNewNodes = mutations.some(m => m.addedNodes && m.addedNodes.length > 0);
        if (hasNewNodes) debouncedProcessLinks();
    });

    function startObserver() {
        const doStart = () => {
            if (document.body) observer.observe(document.body, { childList: true, subtree: true });
        };
        if (document.body) doStart();
        else window.addEventListener('DOMContentLoaded', doStart);
    }

    // 时机1：document-start 阶段（CSS 已注入，其余等 DOM 就绪）
    // @run-at document-start 保证 GM_addStyle 在任何页面样式之前生效

    // 时机2：DOM 就绪立即执行（documentElement 存在）
    if (document.documentElement) {
        processLinks();
        interceptDynamicLinks();
        blockCopyLimitEvents();
    }

    // 时机3：DOMContentLoaded
    window.addEventListener('DOMContentLoaded', () => {
        processLinks();
        interceptDynamicLinks();
        setupEventDelegation();
        blockCopyLimitEvents();
    });

    // 时机4：load（资源全部加载完）
    window.addEventListener('load', () => { processLinks(); });

    // 时机5：SPA 兜底 + 延迟重试（应对异步渲染）
    setTimeout(processLinks, 500);
    setTimeout(processLinks, 1500);
    setTimeout(processLinks, 3000);

    startObserver();
})();
