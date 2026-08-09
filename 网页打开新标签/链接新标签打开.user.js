// ==UserScript==
// @name         链接净化｜新标签打开+去中转直达+去广告
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  去除外链中转跳转直达原链接、链接新标签打开、隐藏网页广告、清理追踪参数（性能优化版）
// @author       You
// @match        *://*/*
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    /**
     * 优化点1：精准广告屏蔽CSS
     * 避免误杀正常内容，使用更具体的选择器
     */
    GM_addStyle(`
        /* 明确包含ad/ads/advertisement的元素 */
        [class*="ad-container"],[class*="ad-wrapper"],[class*="ad-banner"],
        [class*="ads-box"],[class*="ads-module"],[class*="advertisement"],
        [id*="ad-container"],[id*="ad-wrapper"],[id*="ad-banner"],
        [id*="ads-box"],[id*="ads-module"],[id*="advertisement"],
        
        /* 常见广告组件类名 */
        .ad-popup,.sidebar-ad,.float-ad,.modal-ad,.overlay-ad,
        
        /* 广告iframe和推广模块 */
        iframe[src*="doubleclick"],iframe[src*="googlesyndication"],
        iframe[src*="adservice"],ins.adsbygoogle,
        
        /* 明确标记为广告的元素 */
        [data-ad-slot],[data-ad-client],[aria-label="广告"],[data-ad-container],
        
        /* 百度/谷歌/腾讯广告 */
        [class*="baidu-union"],[class*="google-ads"],[class*="tencent-ad"],
        
        /* 悬浮广告和弹窗（需同时满足两个条件） */
        [class*="float-ad"][class*="fixed"],[class*="popup"][class*="ad"]
        { display:none !important; visibility:hidden !important; pointer-events:none !important; }
    `);

    /**
     * 优化点2：中转链接规则库
     * 按优先级匹配，从具体到通用
     */
    const redirectRules = [
        // 知乎中转 link.zhihu.com/?target=xxx
        { reg: /^https?:\/\/link\.zhihu\.com\/\?target=([^&]+)/, get: m => decodeURIComponent(m[1]) },
        // 掘金中转 link.juejin.cn/?target=xxx
        { reg: /^https?:\/\/link\.juejin\.cn\/\?target=([^&]+)/, get: m => decodeURIComponent(m[1]) },
        // CSDN中转 link.csdn.net/?target=xxx
        { reg: /^https?:\/\/link\.csdn\.net\/\?target=([^&]+)/, get: m => decodeURIComponent(m[1]) },
        // 简书中转 links.jianshu.com/go?target=xxx
        { reg: /^https?:\/\/links\.jianshu\.com\/go\?target=([^&]+)/, get: m => decodeURIComponent(m[1]) },
        // 豆瓣中转 www.douban.com/link2/?url=xxx
        { reg: /^https?:\/\/www\.douban\.com\/link2\/\?url=([^&]+)/, get: m => decodeURIComponent(m[1]) },
        // 微信公众号 mp.weixin.qq.com/...&url=xxx
        { reg: /^https?:\/\/mp\.weixin\.qq\.com\/.*[?&]url=([^&]+)/, get: m => decodeURIComponent(m[1]) },
        // 百度搜索跳转 www.baidu.com/link?url=xxx
        { reg: /^https?:\/\/www\.baidu\.com\/link\?url=([^&]+)/, get: m => decodeURIComponent(m[1]) },
        // 搜狗搜索跳转 m.sogou.com/web/searchList.jsp?url=xxx
        { reg: /^https?:\/\/.*\.sogou\.com\/.*[?&]url=([^&]+)/, get: m => decodeURIComponent(m[1]) },
        // 通用 ?url= 中转（需验证是完整URL）
        { reg: /[?&]url=(https?:\/\/[^&]+)/, get: m => decodeURIComponent(m[1]) },
        // 通用 ?target= 中转兜底
        { reg: /[?&]target=(https?:\/\/[^&]+)/, get: m => decodeURIComponent(m[1]) },
        // 通用 ?jump= / ?redirect= / ?to=
        { reg: /[?&](?:jump|redirect|to|goto|link)=(https?:\/\/[^&]+)/, get: m => decodeURIComponent(m[1]) }
    ];

    /**
     * 需要清理的跟踪参数列表
     * 包含常见统计平台和广告追踪参数
     */
    const trackParams = [
        // UTM跟踪参数
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
        // 广告点击ID
        "fbclid", "gclid", "msclkid", "dclid", "wbraid",
        // 国内平台追踪
        "spm", "scm", "upp_content_id", "tracker", "trackid",
        // 其他常见追踪
        "ref", "referer", "source", "medium", "campaign"
    ];

    /**
     * 优化点3：清洗单条链接URL
     * 1. 解析中转链接提取真实地址
     * 2. 清理追踪参数
     */
    function cleanLinkUrl(rawUrl) {
        if (!rawUrl) return rawUrl;
        
        let url = rawUrl.trim();
        let isCleaned = false;
        
        // 步骤1：解析中转链接，提取真实URL
        for (const rule of redirectRules) {
            const match = url.match(rule.reg);
            if (match && match[1]) {
                const extracted = rule.get(match);
                // 验证提取的是有效URL
                if (extracted && (extracted.startsWith('http://') || extracted.startsWith('https://'))) {
                    url = extracted;
                    isCleaned = true;
                    break; // 匹配到第一个规则后即停止
                }
            }
        }
        
        // 步骤2：清理追踪参数
        try {
            const urlObj = new URL(url);
            let paramsRemoved = false;
            
            trackParams.forEach(param => {
                if (urlObj.searchParams.has(param)) {
                    urlObj.searchParams.delete(param);
                    paramsRemoved = true;
                }
            });
            
            if (paramsRemoved) {
                url = urlObj.toString();
                isCleaned = true;
            }
        } catch (e) {
            // URL解析失败，返回原URL
        }
        
        // 返回清洗后的URL（如果有变化）
        return isCleaned ? url : rawUrl;
    }

    /**
     * 优化点4：防抖函数
     * 避免MutationObserver频繁触发导致性能问题
     */
    function debounce(func, delay) {
        let timer = null;
        return function(...args) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                func.apply(this, args);
            }, delay);
        };
    }

    /**
     * 优化点5：精准判断是否为锚点链接或特殊链接
     */
    function shouldSkipLink(href) {
        if (!href) return true;
        // 锚点链接
        if (href.startsWith('#')) return true;
        // javascript伪协议
        if (href.startsWith('javascript:')) return true;
        // mailto/tel协议
        if (href.startsWith('mailto:') || href.startsWith('tel:')) return true;
        // 当前页面hash变化
        try {
            const url = new URL(href);
            const currentUrl = window.location;
            if (url.origin === currentUrl.origin && 
                url.pathname === currentUrl.pathname && 
                url.search === currentUrl.search) {
                return true;
            }
        } catch (e) {}
        return false;
    }

    /**
     * 优化点6：处理单个链接
     */
    function processLink(a) {
        // 跳过已处理的链接
        if (a.dataset.linkProcessed) return;
        
        const originHref = a.getAttribute('href');
        if (shouldSkipLink(originHref)) return;
        
        // 获取绝对URL
        const absoluteUrl = a.href;
        if (!absoluteUrl || absoluteUrl === 'about:blank') return;
        
        // 清洗链接（去中转+去追踪参数）
        const cleanUrl = cleanLinkUrl(absoluteUrl);
        if (cleanUrl !== absoluteUrl) {
            a.href = cleanUrl;
        }
        
        // 强制新标签打开
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        
        // 标记为已处理
        a.dataset.linkProcessed = 'true';
    }

    /**
     * 优化点7：批量处理链接，只处理未处理的
     */
    function processLinks() {
        // 处理普通链接
        document.querySelectorAll('a:not([data-link-processed])').forEach(processLink);
        
        // 处理SVG中的链接
        document.querySelectorAll('svg a:not([data-link-processed])').forEach(processLink);
    }

    /**
     * 优化点8：事件委托 - 点击时即时处理
     * 比MutationObserver更高效
     */
    function setupEventDelegation() {
        document.addEventListener('click', (e) => {
            const link = e.target.closest('a');
            if (!link || link.dataset.linkProcessed) return;
            
            // 点击时立即处理该链接
            processLink(link);
        }, true); // 捕获阶段，优先于页面自身事件
    }

    /**
     * 优化点9：拦截JS动态跳转
     */
    function interceptDynamicLinks() {
        // 拦截window.open
        const originalOpen = window.open;
        window.open = function(url, name, specs) {
            // 清洗URL
            const cleanUrl = cleanLinkUrl(url);
            // 添加安全参数
            if (!name || name === '_blank') {
                specs = (specs ? specs + ',' : '') + 'noopener,noreferrer';
            }
            return originalOpen.call(this, cleanUrl, name, specs);
        };
        
        // 处理表单提交
        document.querySelectorAll('form:not([data-form-processed])').forEach(form => {
            if (!form.target || form.target === '_self') {
                form.target = '_blank';
            }
            form.dataset.formProcessed = 'true';
        });
    }

    // ========== 执行策略 ==========
    
    // 策略1：立即执行（如果DOM已可用）
    if (document.documentElement) {
        processLinks();
        interceptDynamicLinks();
    }
    
    // 策略2：DOM加载完成
    window.addEventListener('DOMContentLoaded', () => {
        processLinks();
        interceptDynamicLinks();
        setupEventDelegation();
    });
    
    // 策略3：页面完全加载
    window.addEventListener('load', processLinks);
    
    // 策略4：MutationObserver + 防抖（应对SPA动态内容）
    const debouncedProcessLinks = debounce(processLinks, 300);
    
    const observer = new MutationObserver((mutations) => {
        const hasNewNodes = mutations.some(m => m.addedNodes && m.addedNodes.length > 0);
        if (hasNewNodes) {
            debouncedProcessLinks();
        }
    });
    
    // 启动观察器
    function startObserver() {
        if (document.body) {
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        } else {
            window.addEventListener('DOMContentLoaded', () => {
                observer.observe(document.body, {
                    childList: true,
                    subtree: true
                });
            });
        }
    }
    
    startObserver();
})();