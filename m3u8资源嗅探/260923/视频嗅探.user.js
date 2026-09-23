// ==UserScript==
// @name         视频资源嗅探（精简版）
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  自动嗅探页面上的视频资源（mp4、m3u8），提供播放、复制和下载功能
// @author       extracted from waterhuo
// @match        https://*/*
// @match        http://*/*
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iIzIyOGJlNiIgZD0iTTggN3YxMGw4LTV6Ii8+PC9zdmc+
// @require      https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/dplayer/1.27.1/DPlayer.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/layui/2.9.14/layui.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/flv.js/1.6.2/flv.js
// @resource     LayuiCss  https://cdnjs.cloudflare.com/ajax/libs/layui/2.9.14/css/layui.css
// @grant        unsafeWindow
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_addElement
// @grant        GM_getResourceText
// @grant        GM_webRequest
// @connect      *
// ==/UserScript==

(function () {
    "use strict";

    var set = [];
    set['auto_n'] = 0;

    // --- X/Twitter 视频拦截 ---
    if (location.host.includes("x.com") || location.host.includes("twitter.com")) {
        (function (open) {
            XMLHttpRequest.prototype.open = function () {
                this.addEventListener("load", function () {
                    try {
                        if (this.responseText && (this.responseURL.includes("/TweetDetail") || this.responseURL.includes("/UserBy"))) {
                            var data = JSON.parse(this.responseText);
                            findTwitterVideos(data);
                        }
                    } catch (e) { }
                });
                open.apply(this, arguments);
            };
        })(XMLHttpRequest.prototype.open);

        function findTwitterVideos(obj) {
            if (!obj) return;
            if (typeof obj === 'object') {
                if (obj.variants && Array.isArray(obj.variants)) {
                    var mp4s = obj.variants.filter(function (v) { return v.content_type === 'video/mp4'; });
                    if (mp4s.length > 0) {
                        mp4s.sort(function (a, b) { return (b.bitrate || 0) - (a.bitrate || 0) });
                        addUrl(mp4s[0].url, "Twitter Video");
                    }
                }
                for (var key in obj) {
                    if (obj.hasOwnProperty(key)) findTwitterVideos(obj[key]);
                }
            }
        }
    }

    // --- 初始化 ---
    if (window.self == window.top) {
        GM_addStyle(GM_getResourceText("LayuiCss").toString()
            .replace(/([^.@-]+{[^}]*}\s*)*/im, '')
            .replaceAll(/@font-face\s*\{\s*font-family:\s*layui-icon;[^}]*}/img,
                "@font-face { " +
                "font-family: layui-icon; " +
                "src: url(https://cdn.bootcdn.net/ajax/libs/layui/2.8.17/font/iconfont.eot); " +
                "src: url(https://cdn.bootcdn.net/ajax/libs/layui/2.8.17/font/iconfont.eot) format('embedded-opentype')," +
                "      url(https://cdn.bootcdn.net/ajax/libs/layui/2.8.17/font/iconfont.woff2) format('woff2')," +
                "      url(https://cdn.bootcdn.net/ajax/libs/layui/2.8.17/font/iconfont.woff) format('woff')," +
                "      url(https://cdn.bootcdn.net/ajax/libs/layui/2.8.17/font/iconfont.ttf) format('truetype')," +
                "      url(https://cdn.bootcdn.net/ajax/libs/layui/2.8.17/font/iconfont.svg) format('svg')}"));
        unsafeWindow.GM = GM;
        try { unsafeWindow.$('body') } catch (err) { unsafeWindow.$ = $; }
    }

    var userAgent = navigator.userAgent.toLowerCase();
    var platform = 'pc';
    if (userAgent.indexOf("android") != -1 || userAgent.indexOf("ios") != -1 || userAgent.indexOf("iphone") != -1 || userAgent.indexOf("ipad") != -1 || userAgent.indexOf("windows phone") != -1) {
        platform = 'phone';
    }

    var offset, weight;
    var w = window.innerWidth, h = window.innerHeight;
    if (platform == 'pc' && w > 800 && h > 600) {
        weight = ['800px', '600px'];
        offset = (h - 600) / 2 + "px";
    } else {
        if (w < 490) {
            GM_addStyle('#MyUpDown,#MyUrls{zoom: ' + (w / 490) + ';-moz-transform: scale(' + (w / 490) + ');-moz-transform-origin:right top;}');
        }
        if (platform == 'pc') {
            offset = w < h ? (h - w) / 2 + "px" : 0.1 * h + "px";
            weight = w < h ? [0.8 * w + "px", 0.8 * w + "px"] : [0.8 * h + "px", 0.8 * h + "px"];
        } else {
            offset = w < h ? (h - w) / 2 + "px" : 0.01 * h + "px";
            weight = w < h ? [0.98 * w + "px", 0.98 * w + "px"] : [0.98 * h + "px", 0.98 * h + "px"];
        }
    }

    // --- 菜单 ---
    if (platform == 'pc') {
        GM_registerMenuCommand("新资源自动打开：" + (GM_getValue("auto_n", 1) == set['auto_n'] ? "✅ 已启用" : "❌ 已禁用"), function () {
            var v = GM_getValue("auto_n", 1) == 1 ? 0 : 1;
            GM_setValue("auto_n", v);
        });
    }

    // --- UI 构建 ---
    unsafeWindow.GM_D = [];
    unsafeWindow.url_info = [];
    unsafeWindow.urls = [];
    unsafeWindow.scriptsList = [];
    unsafeWindow.url_lists = [];

    $("body").attr("id", "Top")
        .append(["<div id='MyUrls' style='text-align:left;font-family:\"Times New Roman\",Georgia,Serif !important;width:490px;background-color:#fff;color:#000;position:fixed;top:1px;right:1px;z-index:999999999999999;border-radius:4px;display:none;'>" +
            "   <div id='Allurl'>" +
            "      <span id='ManualSniff' title='手动重新嗅探' style='cursor:pointer;font-size:16px;'>🔍</span>" +
            "      <span id='Alldownload' title='下载全部'>⬇️</span>" +
            "      <span id='Allcopy' title='复制全部链接'>📋</span>" +
            "      <span id='Alldel' title='清除列表'>🗑️</span>" +
            "   </div>" +
            "   <hr style='border-color:#000;margin:5px;height:2px;background:#000;border-width:0;'>" +
            "   <div class='MyUrls' style='background-color:#fff;border-radius:4px;margin:10px 10px;max-height:500px;text-align:left;'>" +
            "      <div class='MyNR'>" +
            "         <div class='MyVideo'></div>" +
            "      </div>" +
            "   </div>" +
            "</div>"][0])
        .append(["<div id='MyUpDown' style='color:#000;position:fixed;top:1px;right:1px;z-index:1000009999999999999;font-size:20px;line-height:30px;text-align:center;cursor:pointer;'>" +
            "   <div id='redPoint' style='width:8px;height:8px;background-color:red;border-radius:50%;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);display:none;'></div>" +
            "   <div id='downIcon' style='width:30px!important;height:30px!important;line-height:30px!important;font-size:16px!important;font-family:Helvetica!important;'>⤵️</div>" +
            "</div>"][0]);

    GM_addStyle([
        '#Allurl                       { display:flex; justify-content:flex-end; align-items:center; width:94%; height:20px; box-sizing:border-box; padding-right:10px; padding-top:4px; }' +
        '#Allurl>span                  { font-size:16px; margin:0 5px; cursor:pointer; }' +
        '#MyUrls div,#MyUrls input    { box-sizing:content-box!important; line-height:100%; }' +
        '.MyUrls hr                   { background:#837b7b; border-color:#837b7b; border-width:0; height:1px; margin:0; padding:0; border:none !important; }' +
        '.MyNR                         { max-height:465px; overflow-y:auto; }' +
        '.MyNR>div                     { display:block }' +
        '.MyNR div[class^=No-isUrl]   { width:30px; text-align:right; display:inline-block; height:30px; line-height:30px !important; }' +
        '.MyNR input[class^=downUrl]  { pointer-events:auto !important; opacity:1 !important; cursor:text !important; font-size:12px; width:200px; display:inline-block; margin:0px; height:22px; border:1px solid black; border-radius:5px; padding:0 5px; background:white; color:#000 !important; }' +
        '.MyNR input[class^=downName] { font-size:12px; width:120px; display:inline-block; margin:0px; height:22px; border:1px solid black; border-radius:5px; padding:0 5px; background:white; color:black; }' +
        '.But                          { margin-left:3px; height:22px; padding:0 6px; border:none; background:#228be6; color:#fff; border-radius:10px; cursor:pointer; font-size:11px; text-align:center; line-height:22px!important; display:inline-block; }' +
        '.But:hover                    { background:#1c7ed6; }' +
        '.rmUrl                        { cursor:pointer; color:red; width:24px; height:22px; line-height:22px !important; display:inline-block; text-align:center; font-size:12px; }' +
        '#giegei717dplayer .dplayer-controller button{ background:black; }' +
        '.dplayer-controller .dplayer-bar-wrap .dplayer-bar { height:15px!important; top:-10px!important; }' +
        '.dplayer-controller .dplayer-bar-wrap .dplayer-bar>[class^=dplayer-] { height:15px!important; }' +
        '.dplayer-controller .dplayer-bar-wrap .dplayer-bar .dplayer-played .dplayer-thumb { height:22px!important; width:22px!important; }'
    ][0]);

    $(".MyNR div").append(["<div class='urlnone' style='height:22px;color:red;padding:9px 0 0 20px;font-size:15px;'> 暂时没有嗅探到视频资源</div>" +
        "<div class='downloadUrl' style='height:31px;line-height:30px;'>" +
        "<hr class='urlnone' > " +
        "<div class='No-isUrl'> 0、</div>" +
        "<input class='downUrl' autocomplete='on' placeholder='自定义视频链接' title='自定义视频下载项'> " +
        "<input class='downName' placeholder='文件名' title='默认文件名为当前页面标题'>" +
        "<div class='But SaveUrl'>下载</div>" +
        "<div class='But StopSaveUrl' style='display:none;'>0%</div>" +
        "<div class='But playUrl'>播放</div>&nbsp" +
        "</div>"][0]);

    var angle = 0;
    $("#MyUpDown").click(function () {
        var mn;
        $("#MyUrls").slideToggle("slow", function () {
            mn = mn == "1" || mn == 1 ? 1 : -1;
            if (mn == -1) $("#redPoint").css("display", "none");
            mn = -mn;
        });
        var a = angle;
        var setXZ = setInterval(function () {
            $("#MyUpDown #downIcon").css('transform', 'rotate(' + a + 'deg)');
            if (a >= angle + 45) { clearInterval(setXZ); angle += 45; }
        }, 5);
    });

    $(window).click(function (e) {
        if ($(e.target).is('#MyUrls *,#MyUpDown *,#MyUrls,#MyUpDown')) return;
        if ($("#MyUrls").css("display") != "none" && $("#MyUpDown").css('pointer-events') != 'none') {
            $("#MyUpDown").click();
            $("#MyUpDown").css('pointer-events', 'none');
            setTimeout(function () { $("#MyUpDown").css('pointer-events', 'all'); }, 500);
        }
    });

    // --- 按钮事件 ---
    $("#Alldownload").click(function () {
        $('.MyVideo .isUrl').each(function () {
            $(this).find(".SaveUrl").click();
        });
        layer.msg("开始下载");
    });

    $("#Allcopy").click(function () {
        var urlss = "";
        $('.MyVideo .isUrl').each(function () {
            urlss += $(this).find("[class^=downUrl]").attr('title').trim() + "\n";
        });
        GM_setClipboard(urlss);
        layer.msg("已复制");
    });

    $("#Alldel").click(function () {
        $('.MyVideo .isUrl').remove();
        GM_D.forEach(function (item) { item.forEach(function (i) { try { i.abort() } catch (e) { } }) });
        layer.msg("已清除");
    });

    $("#ManualSniff").click(function () {
        layer.msg("正在手动嗅探...");
        var scripts = performance.getEntriesByType("resource");
        scripts.forEach(function (x) {
            var z = x.name;
            if ((/m3u8/i.test(z) && !/\.ts/i.test(z.replaceAll(/\?.*/g, ''))) || /mp4\??.*/i.test(z)) {
                addUrl(z, document.title);
            }
        });
        $("video, source").each(function () {
            var src = $(this).attr('src');
            if (src && src.trim() !== "" && !/^blob:/i.test(src)) addUrl(src, document.title);
        });
        layer.msg("嗅探完成");
    });

    $(".downUrl").on('input', function () { $(this).attr("title", $(this).val()) });
    $(".downName").on('input', function () { $(this).attr("title", $(this).val()) });

    // --- 播放 & 下载交互 ---
    $(".MyNR .playUrl").click(function () {
        var url = $(this).prevAll(".downUrl").attr("title");
        var type = $(this).prevAll(".downUrl").data('type');
        if (!url || url.trim() === "" || url.trim().split(".").filter(function (i) { return i.trim() != ""; }).length < 2) {
            layer.msg("无有效链接");
        } else {
            dplayerUrl(url, type);
        }
    });

    $(".MyNR .SaveUrl").click(function () {
        var that = $(this);
        var url = that.prevAll(".downUrl").val();
        if (!url || url.trim() === '') {
            url = that.prevAll(".downUrl").attr('title');
            if (!url || url.trim() === '' || url.trim() === "自定义视频下载项") {
                layer.msg("无有效链接");
                return;
            }
        }
        var name = that.prevAll(".downName").val();
        if (!name || name.trim() === "") {
            name = $('title').text() || url.split("/").pop().split("?")[0] || "视频";
        }
        name = name.replaceAll(/\s+/ig, " ").trim().replace(/(\.mp4)*$/igm, "");
        var isHls = /m3u8/i.test(url);
        name = name + (isHls ? ".mp4" : ".mp4");

        that.css("display", "none").next('.StopSaveUrl').css("display", "inline-block").text("解析中...");

        var head = { 'Range': 'bytes=0-200', 'Cache-Control': 'no-store' };
        var num = GM_D.push([]) - 1;
        that.next('.StopSaveUrl').data('num', num);

        GM_D[num].push(GM_download({
            url: url,
            name: name,
            headers: head,
            onprogress: function (event) {
                if (event && event.total) {
                    var loaded = parseFloat(event.loaded / event.total * 100).toFixed(1);
                    that.css("display", "none").next(".StopSaveUrl").css("display", "inline-block").text(loaded + "%");
                }
            },
            onload: function () {
                that.text("已下载").css("display", "inline-block").next(".StopSaveUrl").css("display", "none").text("0%");
                console.warn("下载完成：" + name);
            },
            onerror: function (x) {
                console.log(x);
                that.text("错误").css("display", "inline-block").next(".StopSaveUrl").css("display", "none").text("0%");
                layer.msg("下载出错，请尝试复制链接用其他工具下载");
            }
        }));
    });

    $(".MyNR .StopSaveUrl").click(function () {
        var num = $(this).data("num");
        if (num != undefined && GM_D[num]) {
            GM_D[num].forEach(function (i) { try { i.abort() } catch (e) { } });
        }
        $(this).data("num", "").css("display", "none").text("0%").prev(".SaveUrl").text("继续").css("display", "inline-block");
    });

    // --- GM_webRequest 拦截 m3u8 ---
    try {
        GM.webRequest();
        GM_webRequest([
            { selector: '*://*/*.m3u8*', action: { redirect: { from: "(.*)", to: "\$1" } } },
            { selector: '*://*/*m3u8*', action: { redirect: { from: "(.*)", to: "\$1" } } },
        ], function (info, message, details) {
            var z = details.url;
            if (z && z.trim() !== "" && z != $('#MyUrls .downUrl').val().trim()) {
                addUrl(z);
            }
        });
    } catch (err) {
        console.log("当前浏览器不支持 GM_webRequest()");
    }

    // --- PerformanceObserver 监听网络请求 ---
    function getNetworkRequests() {
        return performance.getEntriesByType("resource").filter(function (entry) {
            return (entry.initiatorType === "video" || entry.initiatorType === "xmlhttprequest" || entry.initiatorType === "fetch");
        });
    }

    var observer = new PerformanceObserver(perfObserver);
    observer.observe({ entryTypes: ["resource"] });

    function perfObserver() {
        var length = $('.MyVideo .isUrl').length;
        var scripts = getNetworkRequests();
        scripts = scripts.filter(function (i) { return !unsafeWindow.scriptsList.includes(i) });
        if (scripts.length < 1) { scripts.push(''); }
        scripts.forEach(function (x) {
            if (x === "") return;
            var z = x.name.trim();
            if ($('.MyNR div.downloadUrl > input.downUrl').map(function () { return $(this).val(); }).get().includes(z)) return;
            unsafeWindow.url_lists.push(z);

            if ((/m3u8/i.test(z) && !/\.ts/i.test(z.replaceAll(/\?.*/g, ''))) || /mp4\??.*/i.test(z)) {
                addUrl(z);
            }

            $("video").each(function () {
                var that = $(this);
                if (that.attr('src') && that.attr('src').trim() !== "" && !/^blob:/i.test(that.attr('src'))) {
                    addUrl(that.attr('src'));
                }
                that.find("source").each(function () {
                    var s = $(this).attr('src');
                    if (s && s.trim() !== "" && !/^blob:/i.test(s)) addUrl(s);
                });
            });

            $("source").each(function () {
                var s = $(this).attr('src');
                if (s && s.trim() !== "" && !/^blob:/i.test(s)) {
                    addUrl(/^(http:|https:)/.test(s) ? s : location.href.split("://")[0] + ':' + s);
                }
            });
        });
        unsafeWindow.scriptsList = unsafeWindow.scriptsList.concat(scripts);
    }

    // --- pushState 监听（单页应用路由变化） ---
    var _wr = function (type) {
        var orig = history[type];
        return function () {
            var rv = orig.apply(this, arguments);
            var e = new Event(type);
            e.arguments = arguments;
            window.dispatchEvent(e);
            return rv;
        };
    };
    unsafeWindow.history.pushState = _wr('pushState');
    unsafeWindow.history.replaceState = _wr('replaceState');

    // --- iframe 跨窗口通信 ---
    window.addEventListener('message', function (event) {
        var url = event.data;
        if (url && url.url) addUrl(url.url, url.name, url.href);
    }, true);

    if (window.self !== window.top) {
        $('#MyUpDown,#MyUrls').css("display", "none");
    }

    // --- 核心 addUrl ---
    function addUrl(url, name, href) {
        name = name || '';
        href = href || location.href;
        if (!url || url.length < 1) return;

        if (window.self != window.top) {
            window.parent.postMessage({ url: url, name: name, href: location.href }, "*");
            return;
        }

        url = url.toString().trim();
        if (!/^(http:|https:)/.test(url)) {
            if (/^(\/{0,2}([^\.\s\/]*\.){1,3}[\w]{1,8}(:[\d]{1,5})?)\/.*/.test(url)) {
                url = href.trim().match(/^(http:|https:)/im)[0] + "//" + url.replace(/^(\/{0,2})/img, "");
            } else if (/^(\/)/.test(url)) {
                url = location.origin + url;
            }
        }

        if (!unsafeWindow.urls.includes(url)) {
            unsafeWindow.urls.push(url);
        } else {
            return;
        }

        // 特殊站点过滤
        switch (location.host) {
            case 'www.iwara.tv':
                if (!/(_Source\.mp4)/i.test(url)) return;
                break;
        }

        // HEAD 请求确认资源类型
        GM_xmlhttpRequest({
            method: "GET",
            url: url,
            fetch: true,
            headers: { 'Range': 'bytes=0-200', 'Cache-Control': 'no-store' },
            onerror: function () { },
            onload: function (response) {
                if (response.status / 100 >= 3 && response.status != 404 && response.status != 403) return;

                var Headers = response.responseHeaders;
                if (!Headers || Headers.length < 1) return;

                var Type = Headers.match(/content-type:\s*[\S]+\s/im);
                if (!Type || Type.length < 1) {
                    if (/^#EXTM3U/i.test(response.responseText)) {
                        Type = 'hls';
                    } else {
                        return;
                    }
                } else {
                    Type = Type[0].replace('content-type:', '').trim();
                    if (/.*video\/mp4.*/i.test(Type) || (/application\/octet-stream/i.test(Type) && /mp4\??.*/i.test(url))) {
                        Type = 'normal';
                    } else if (/.*\/.*mpegurl.*/i.test(Type)) {
                        Type = 'hls';
                    } else if (/.*(text\/[\w]*).*/i.test(Type) || /application\/octet-stream/i.test(Type)) {
                        if (/^#EXTM3U/i.test(response.responseText)) {
                            Type = 'hls';
                        } else {
                            return;
                        }
                    } else {
                        return;
                    }
                }

                insertListItem(url, name, Type);
            }
        });
    }

    function insertListItem(url, name, Type) {
        var x = $(".MyNR>.MyVideo");
        x.find(".urlnone").remove();
        var num = x.find('.isUrl').length + 1;
        x.append("<div class='isUrl' style='height:31px;'>" +
            "<hr> " +
            "<div class='No-isUrl'> " + num + "、</div>" +
            "<input disabled data-type='" + Type + "' class='downUrl" + num + "' title='" + url + "' value='" + url + "'> " +
            "<input title='" + (name || '自定义保存文件名') + "' class='downName" + num + "' placeholder='文件名' value='" + name + "'>" +
            "<div style='display:inline-block;' class='But copyUrl" + num + "'>复制</div>" +
            "<div style='display:inline-block;' class='But SaveUrl" + num + "'>下载</div>" +
            "<div style='display:none;' class='But StopSaveUrl" + num + "'> 0% </div>" +
            "<div style='display:inline-block;' class='But playUrl" + num + "'>播放</div>&nbsp" +
            "<div title='删除' class='rmUrl" + num + "'>&nbspx&nbsp</div>" +
            "</div>");

        bindItemEvents(num);

        if ($("#MyUrls").css("display") == "none") {
            $("#redPoint").css("display", "block");
            if (GM_getValue("auto_n", 1) == set['auto_n']) {
                $("#MyUpDown").click();
            }
        }
    }

    function bindItemEvents(num) {
        $(".MyNR .copyUrl" + num).click(function () {
            var url = $(this).prevAll(".downUrl" + num).attr("title");
            GM_setClipboard(url);
            $(this).text("已复制");
        });

        $(".MyNR .playUrl" + num).click(function () {
            var url = $(this).prevAll(".downUrl" + num).attr("title");
            var type = $(this).prevAll(".downUrl" + num).data('type');
            if (!url || url.trim() === "") {
                layer.msg("无有效链接");
            } else {
                dplayerUrl(url, type);
            }
        });

        $(".MyNR .SaveUrl" + num).click(function () {
            var that = $(this);
            var url = that.prevAll(".downUrl" + num).val() || that.prevAll(".downUrl" + num).attr('title');
            var name = that.prevAll(".downName" + num).val() || that.prevAll(".downName" + num).attr('title');
            if (!url || url.trim() === '') { layer.msg("无有效链接"); return; }
            if (!name || name.trim() === "") {
                name = $('title').text() || url.split("/").pop().split("?")[0] || "视频";
            }
            name = name.replaceAll(/\s+/ig, " ").trim().replace(/(\.mp4)*$/igm, "") + ".mp4";

            that.css("display", "none").next(".StopSaveUrl" + num).css("display", "inline-block").text("下载中...");
            var numIdx = GM_D.push([]) - 1;
            that.next(".StopSaveUrl" + num).data('num', numIdx);

            GM_D[numIdx].push(GM_download({
                url: url,
                name: name,
                headers: { 'Range': 'bytes=0-200', 'Cache-Control': 'no-store' },
                onprogress: function (event) {
                    if (event && event.total) {
                        that.next(".StopSaveUrl" + num).text(parseFloat(event.loaded / event.total * 100).toFixed(1) + "%");
                    }
                },
                onload: function () {
                    that.text("已下载").css("display", "inline-block").next(".StopSaveUrl" + num).css("display", "none").text("0%");
                },
                onerror: function () {
                    that.text("错误").css("display", "inline-block").next(".StopSaveUrl" + num).css("display", "none").text("0%");
                    layer.msg("下载出错");
                }
            }));
        });

        $(".MyNR .StopSaveUrl" + num).click(function () {
            var n = $(this).data("num");
            if (n != undefined && GM_D[n]) {
                GM_D[n].forEach(function (i) { try { i.abort() } catch (e) { } });
            }
            $(this).css("display", "none").prev(".SaveUrl" + num).text("下载").css("display", "inline-block");
        });

        $(".MyNR .rmUrl" + num).click(function () {
            var n = $(this).prevAll(".StopSaveUrl" + num).data("num");
            if (n != undefined && GM_D[n]) {
                GM_D[n].forEach(function (i) { try { i.abort() } catch (e) { } });
            }
            $(this).parent(".isUrl").remove();
            var list = $('.MyVideo .isUrl');
            list.each(function (i) { $(this).children(".No-isUrl").text(i + 1 + "、"); });
        });

        $(".MyNR .downUrl" + num).on('input', function () { $(this).attr("title", $(this).val()) });
        $(".MyNR .downName" + num).on('input', function () { $(this).attr("title", $(this).val()) });
        $(".MyNR input").dblclick(function () { this.select() });
    }

    // --- 视频播放器 ---
    var firstVideo = 0, hzh = false;
    function dplayerUrl(url, type) {
        var lay_i = unsafeWindow.dpgiegei717index || 0;
        $('#layui-layer' + lay_i + ',#layui-layer-shade' + lay_i).remove();
        var index = layer.load(2);
        var conf = {
            type: 1,
            title: url.length > 80 ? url.substring(0, 80) + "..." : url,
            shadeClose: true,
            offset: offset,
            fixed: true,
            maxmin: true,
            resize: true,
            move: '.layui-layer-title',
            moveOut: false,
            btn: [],
            area: weight,
            content: "<div id='giegei717dplayer' style='width:100%;height:100%;display:flex;align-items:center;justify-content:center;'></div>",
            success: function (layero, idx) {
                unsafeWindow.dpgiegei717 = new DPlayer({
                    element: document.getElementById("giegei717dplayer"),
                    preload: 'auto',
                    hotkey: true,
                    volume: 1,
                    mutex: true,
                    loop: false,
                    playbackSpeed: [0.1, 0.5, 1, 1.25, 1.5, 2],
                    screenshot: true,
                    autoplay: true,
                    contextmenu: [
                        {
                            text: '刷新视频',
                            click: function (player) { player.switchVideo({ url: url, type: type }); player.play(); }
                        },
                        {
                            text: '复制链接',
                            click: function () { GM_setClipboard(url); layer.msg("已复制"); }
                        }
                    ],
                    video: { url: url, type: type },
                });
                dpgiegei717.on('error', function () {
                    if (firstVideo == 0) {
                        GM_addElement('script', { src: 'https://cdn.bootcdn.net/ajax/libs/flv.js/1.6.2/flv.min.js', type: 'text/javascript' });
                        firstVideo = 1;
                        dpgiegei717.switchVideo({ url: url, type: type });
                        dpgiegei717.play();
                    }
                });
            }
        };
        layer.close(index);
        unsafeWindow.dpgiegei717index = layer.open(conf);
    }

})();