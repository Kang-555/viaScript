// ==UserScript==
// @name         媒体资源嗅探及下载(支持下载m3u8和mp4视频和音频)
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  自动嗅探页面上的视频、音频资源并提供播放、复制、下载功能（支持 mp3/mp4/m3u8），含录屏与解除复制限制。
// @author       me
// @license      Copyright me
// @match        https://*/*
// @match        http://*/*
// @icon         https://greasyfork.s3.us-east-2.amazonaws.com/fc67t00gsk98w7pbhs97xr94g1hl
// @require      https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/dplayer/1.27.1/DPlayer.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/layui/2.9.14/layui.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/flv.js/1.6.2/flv.js
// @require      https://update.greasyfork.org/scripts/433051/Trusted-Types%20Helper.user.js

// @require      https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js

// @resource     LayuiCss  https://cdnjs.cloudflare.com/ajax/libs/layui/2.9.14/css/layui.css
// @resource     qbMediaRecorderJS https://quickblox.github.io/javascript-media-recorder/qbMediaRecorder.js
// @grant        unsafeWindow
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_addElement
// @grant        GM_getResourceText
// @grant        GM_webRequest
// @connect      *
// @supportURL  【Greasy Fork 脚本技术交流】：http://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=IkMlupLSzK9E2MheU0ngdDHHnnzojNYx&authKey=v1p%2BI3vfp3Bw60DIGgWxTtQSQ0NAz4ib%2FC6lTF0LjIi8dteVCtihitq5zID%2FoM0N&noverify=0&group_code=674604829
// @downloadURL https://update.greasyfork.org/scripts/470154/%E5%AA%92%E4%BD%93%E8%B5%84%E6%BA%90%E5%97%85%E6%8E%A2%E5%8F%8A%E4%B8%8B%E8%BD%BD%28%E6%94%AF%E6%8C%81%E4%B8%8B%E8%BD%BDm3u8%E5%92%8Cmp4%E8%A7%86%E9%A2%91%E5%92%8C%E9%9F%B3%E9%A2%91%29%E5%8E%9F%E7%89%88.user.js
// @updateURL https://update.greasyfork.org/scripts/470154/%E5%AA%92%E4%BD%93%E8%B5%84%E6%BA%90%E5%97%85%E6%8E%A2%E5%8F%8A%E4%B8%8B%E8%BD%BD%28%E6%94%AF%E6%8C%81%E4%B8%8B%E8%BD%BDm3u8%E5%92%8Cmp4%E8%A7%86%E9%A2%91%E5%92%8C%E9%9F%B3%E9%A2%91%29%E5%8E%9F%E7%89%88.meta.js
// ==/UserScript==

(function() {
    "use strict";
    // # 功能设置： 0 关闭，1 开启； 注：此处设置值如果改为（0 or 1）以外的值，会导致相应功能关闭（油猴脚本菜单中的选项也不会起效）
    // 此处的设置主要考虑到手机端使用时没有油猴脚本菜单可以 开启/关闭 功能，故添加于此。
    var set = [];
    set['auto_n']   = 0    // 默认不会在嗅探出资源后自动打开列表
    set['ffmpeg_n'] = 0    // 默认不会在浏览器下载完m3u8视频后进行视频转码 （解码需要浏览器开启特定功能并且会占用大量资源）
    set['ad_n']     = 1    // 默认会在下载m3u8视频时自动过滤其中夹杂的广告，但注意 有些广告使用了混淆 会导致视频片段会被误当做广告而去除，下载的视频不完整，这种情况关闭此功能即可。
    set['checked_n']= 1    // 默认解除特殊网站对文本选中的限制，对开启此功能但仍无法解除选择限制的网站 可以提交网站给作者进行相应优化。 解除限制后可以进行复制等操作（1.70新加功能）。

    //正文
    var xcNum = 15
    if (window.self == window.top) {
        //console.log("当前页面不在iframe子页面内部 在最顶层父页面")
        GM_addElement('script', {
            textContent:  GM_getResourceText('qbMediaRecorderJS') });
        GM_addStyle( GM_getResourceText("LayuiCss").toString()
                    .replace(/([^.@-]+{[^}]*}\s*)*/im , '')
                    .replaceAll(/@font-face\s*\{\s*font-family:\s*layui-icon;[^}]*}/img,
                                "@font-face { "+
                                "font-family: layui-icon; "+
                                "src: url(https://cdn.bootcdn.net/ajax/libs/layui/2.8.17/font/iconfont.eot); "+
                                "src: url(https://cdn.bootcdn.net/ajax/libs/layui/2.8.17/font/iconfont.eot) format('embedded-opentype'),"+
                                "     url(https://cdn.bootcdn.net/ajax/libs/layui/2.8.17/font/iconfont.woff2) format('woff2'),"+
                                "     url(https://cdn.bootcdn.net/ajax/libs/layui/2.8.17/font/iconfont.woff) format('woff'),"+
                                "     url(https://cdn.bootcdn.net/ajax/libs/layui/2.8.17/font/iconfont.ttf) format('truetype'),"+
                                "     url(https://cdn.bootcdn.net/ajax/libs/layui/2.8.17/font/iconfont.svg) format('svg')}") );
        unsafeWindow.GM = GM;
        try {
            unsafeWindow.$('body')
        } catch(err) {
            //console.log(err)
            unsafeWindow.$ = $;
        }
    } else {
        // console.log("当前页面位于iframe子页面");

    }
    var userAgent = navigator.userAgent.toLowerCase();
    var platform,weight,weight1,offset;
    if(userAgent == null || userAgent == ''){
        platform = 'pc' ;
    }else{
        if(userAgent.indexOf("android") != -1 ){
            platform = 'phone';
        }else if(userAgent.indexOf("ios") != -1 || userAgent.indexOf("iphone") != -1 || userAgent.indexOf("ipad") != -1){
            platform = 'phone';
        }else if(userAgent.indexOf("windows phone") != -1 ){
            platform = 'phone';
        }else{
            platform = 'pc' ;
        }
    }
    if(platform == 'pc'){
        var menuList = []
        var info = ['❌ 已禁用','✅ 已启用']
        mkMenu([
            { No : 1 , key: "嗅探到新资源时自动打开窗口：",           keyName : "auto_n"},
            { No : 2 , key: "是否转码(需满足先决条件)：",             keyName : "ffmpeg_n"},
            { No : 3 , key: "是否在视频下载中去除m3u8中插的广告（测试版）：", keyName : "ad_n"},
            { No : 4 , key: "解除个别网站文本无法选中的限制：", keyName : "checked_n"},
        ])
    }
    var w = window.innerWidth;
    var h = window.innerHeight;
    if(platform == 'pc'&& w > 800 && h >600){
        weight = ['800px', '600px'];
        weight1 = ['550px', '700px'];
        offset = (h-600)/2+"px"
    }else{
        if(w < 490){
            var z = w/490;
            GM_addStyle( '#MyUpDown{zoom: '+z+';-moz-transform: scale('+z+');-moz-transform-origin:right top;;} '+
                        '#MyUrls{zoom: '+z+';-moz-transform: scale('+z+');-moz-transform-origin:right top;;} '+
                        '#Allurl{zoom: '+z+';-moz-transform: scale('+z+');-moz-transform-origin: right top;;}; ')
        }
        if(platform == 'pc'){
            offset = w < h ? (h-w)/2+"px" : 0.1*h+"px";
            weight = w < h ? [0.8*w+"px", 0.8*w+"px"] : [0.8*h+"px", 0.8*h+"px"];
            weight1 = w < h ? [0.8*w+"px",0.8*w+94+"px"] : [0.8*h+"px",0.8*h+94+"px"];
        }else{
            offset = w < h ? (h-w)/2+"px" : 0.01*h+"px";
            weight = w < h ? [0.98*w+"px", 0.98*w+"px"] : [0.98*h+"px", 0.98*h+"px"];
            weight1 = w < h ? [0.98*w+"px",0.98*w+94+"px"] : [0.98*h+"px",0.98*h+94+"px"];
        }
    }
    let URLAs = [],videos=[],play = 0,hzh = false;;
    var firstVideo = 0, mn = -1;
    unsafeWindow.GM_D = [];
    var href = location.href;
    var origin = location.origin
    $("body").attr("id","Top")
        .append(["<div id='MyUrls' class='jianBian' style='    text-align: left;font-family: \"Times New Roman\",Georgia,Serif !important;;width: 490px;background-color: rgb(149 228 246);color: black;position: fixed;top: 1px;right: 1px;z-index: 999999999999999;border-radius: 4px;display: none;'>" +
                 "   <div style='display: inline-block; width: 40%;height: 30px;font-size: 20px;text-align: left;line-height: 30px;'>&nbsp&nbsp&nbsp&nbsp&nbsp资源链接：</div>"+
                 "   <div id='Allurl' style=''>" +
                 "      <i id='LupinStart'  title='录屏'         style=''             ><svg width='25' height='25' xmlns='http://www.w3.org/2000/svg'><path d='m17.12494,2.35175a2.14127,2.60003 0 0 1 2.13699,2.42947l0.00428,0.17056l0,1.96666l2.11386,-1.16169a2.14127,2.60003 0 0 1 3.0209,2.19754l0.00428,0.17056l0,9.12922a2.14127,2.60003 0 0 1 -3.02176,2.37019l-0.1319,-0.07904l-1.98538,-1.29377l0,2.3005a2.14127,2.60003 0 0 1 -2.0008,2.59483l-0.14047,0.0052l-14.56063,0a2.14127,2.60003 0 0 1 -2.13699,-2.42947l-0.00428,-0.17056l0,-15.60017a2.14127,2.60003 0 0 1 2.0008,-2.59483l0.14047,-0.0052l14.56063,0zm-0.42825,3.12003l-13.70412,0l0,14.56016l13.70412,0l0,-4.16005l0.00343,-0.1092a1.28476,1.56002 0 0 1 1.7764,-1.5569l0.1122,0.06344l3.24702,2.11538l0,-7.45376l-3.32325,1.82938a1.28476,1.56002 0 0 1 -1.64449,-0.64273l-0.05567,-0.1352a1.27877,1.55274 0 0 1 -0.11135,-0.75401l-0.00428,-0.11648l0,-3.64004zm-7.70857,2.60003l3.76863,3.43204a1.28476,1.56002 0 0 1 0.09764,2.39827l-0.09764,0.09776l-3.76863,3.43204a0.85651,1.04001 0 0 1 -1.19911,-0.208l-0.5139,-0.83201a0.85651,1.04001 0 0 1 0.1713,-1.45602l2.39736,-2.18402l-2.39822,-2.18402a0.85651,1.04001 0 0 1 -0.17044,-1.45602l0.5139,-0.83201a0.85651,1.04001 0 0 1 1.19911,-0.208z'></path></svg></i>" +
                 "      <i id='LupinStop'   title='停止录屏'     style='display:none;'><svg width='25' height='25' xmlns='http://www.w3.org/2000/svg'><path fill='#ff0000' d='m15.46936,16.26799l-5.93873,0c-0.44387,0 -0.81122,-0.36612 -0.81122,-0.80852l0,-5.91894c0,-0.4424 0.36734,-0.80852 0.81122,-0.80852l5.92342,0c0.44387,0 0.81122,0.36612 0.81122,0.80852l0,5.90369c0.01531,0.45765 -0.35204,0.82377 -0.79591,0.82377z'></path><path d='m12.5,3.01138c5.24996,0 9.52034,4.25615 9.52034,9.48862s-4.27038,9.48862 -9.52034,9.48862s-9.52034,-4.25615 -9.52034,-9.48862s4.27038,-9.48862 9.52034,-9.48862m0,-2.71539c-6.76525,0 -12.24481,5.46129 -12.24481,12.20401s5.47955,12.20401 12.24481,12.20401s12.24481,-5.46129 12.24481,-12.20401s-5.47955,-12.20401 -12.24481,-12.20401z'></path></svg></i>" +
                 "      <i id='Alldownload' title='下载全部资源' style=''             ><svg width='25' height='25' xmlns='http://www.w3.org/2000/svg'><path d='m14.12784,16.18481l0.12927,-0.11217l7.107,-6.62524a0.9944,0.927 0 0 0 0,-1.31077l-0.70304,-0.65539a0.9944,0.927 0 0 0 -1.31261,-0.07694l-0.09347,0.07694l-5.26437,4.90752l0.00099,-11.01271a0.9944,0.927 0 0 0 -0.9944,-0.927l-0.9944,0a0.9944,0.927 0 0 0 -0.9944,0.927l-0.00099,11.01086l-5.26238,-4.90566a0.9944,0.927 0 0 0 -1.31261,-0.07694l-0.09347,0.07694l-0.70304,0.65539a0.9944,0.927 0 0 0 0,1.31077l7.106,6.62524a2.48601,2.31749 0 0 0 3.38594,0.11217zm7.81899,8.36614a2.48601,2.31749 0 0 0 2.48103,-2.16546l0.00497,-0.15203l0,-3.24449a0.9944,0.927 0 0 0 -0.9944,-0.927l-0.9944,0a0.9944,0.927 0 0 0 -0.9944,0.927l0,2.78099l-17.89925,0l0,-2.78099a0.9944,0.927 0 0 0 -0.9944,-0.927l-0.9944,0a0.9944,0.927 0 0 0 -0.9944,0.927l0,3.24449a2.48601,2.31749 0 0 0 2.32292,2.31286l0.16308,0.00463l18.89365,0z'></path></svg></i>" +
                 "      <i id='Allcopy'     title='复制全部链接' style=''             ><svg width='25' height='25' xmlns='http://www.w3.org/2000/svg'><path d='m21.99501,0.72222a2.28276,2.30057 0 0 1 2.2782,2.14965l0.00457,0.15092l0,13.61937a2.28276,2.30057 0 0 1 -2.13301,2.29597l-0.14975,0.0046l-2.28276,0l0,3.40484a2.28276,2.30057 0 0 1 -2.13301,2.29597l-0.14975,0.0046l-14.60969,0a2.28276,2.30057 0 0 1 -2.28276,-2.30057l0,-14.72365a2.28276,2.30057 0 0 1 2.28276,-2.30057l3.37849,-0.00092l0,-2.29965a2.28276,2.30057 0 0 1 2.13301,-2.29597l0.14975,-0.0046l13.51396,0zm-5.02208,7.3609l-13.69658,0l0,13.80342l13.69658,0l0,-13.80342zm4.56553,-4.60022l-12.60085,0l0,1.83954l8.49188,0.00092a2.28276,2.30057 0 0 1 2.2782,2.14965l0.00457,0.15092l0,8.55812l1.82621,0l0,-12.69915z'></path></svg></i>" +
                 "      <i id='Alldel'      title='清除列表'     style=''             ><svg width='25' height='25' xmlns='http://www.w3.org/2000/svg'><path d='m15.45918,0.40816a0.98639,0.93014 0 0 1 0.98639,0.93014l0,1.86028l6.90476,0a0.98639,0.93014 0 0 1 0.98639,0.93014l0,0.93014a0.98639,0.93014 0 0 1 -0.98639,0.93014l-0.98639,0l0,16.27747a2.46599,2.32535 0 0 1 -2.30422,2.3207l-0.16177,0.00465l-14.79591,0a2.46599,2.32535 0 0 1 -2.46599,-2.32535l0,-16.27747l-0.98639,0a0.98639,0.93014 0 0 1 -0.98639,-0.93014l0,-0.93014a0.98639,0.93014 0 0 1 0.98639,-0.93014l6.90476,0l0,-1.86028a0.98639,0.93014 0 0 1 0.98639,-0.93014l5.91837,0zm3.94558,5.58085l-13.80952,0l0,15.8124l13.80952,0l0,-15.8124zm-8.38435,3.25549l0,9.30141l-2.95918,0l0,-9.30141l2.95918,0zm5.91837,0l0,9.30141l-2.95918,0l0,-9.30141l2.95918,0z'></path></svg></i>" +
                 "   </div>"+
                 "   <hr style='border-color: black;margin: 5px;height: 2px;background: black;border-width: 0;'>" +
                 "   <div class='MyUrls' style='background-color: #ffffff;border-radius: 4px;margin: 10px 10px;max-height: 500px;text-align: left;'>" +
                 "      <div  class='MyBT' style='height: 35px;display: -webkit-flex;display: flex;-webkit-justify-content: space-around;;justify-content: space-around;;'>"+
                 "         <div id='MyVideo'  class='jianBian'>视频<div >视频</div></div>"+
                 "         <div id='MyAudio'  class='jianBian'>音频<div >音频</div></div>"+
                 "      </div> "+
                 "      <div class='MyNR'>"+
                 "         <div class='MyVideo'></div>  <div class='MyAudio'></div>"+
                 "      </div> "+
                 "   </div>" +
                 "</div>"][0])
        .append(["<div id='MyUpDown' class='jianBian' style='width: 30px;height: 30px;color: black;background-color:rgb(149, 228, 246);position: fixed;top: 1px;right: 1px;z-index: 1000009999999999999;font-size: 20px;line-height: 30px;text-align: center;cursor: pointer;border-radius: 30px;'>" +
                 "   <div id='redPoint' style='width: 5px;height: 5px;position: fixed;top: -25px;right: 30px;font-size: 50px;color: red;font-weight: 400;display:none; '>.</div>"+
                 "   <div id='downIcon' style='width: 30px!important;height: 30px!important;line-height: 30px!important;font-size: 20px !important;font-family: Helvetica!important;'>➕</div>"+
                 "</div>"][0])
        .append()
        .append(["<a href='#Top' id='GoTop' target='_self'  style='text-decoration: none;display: none; width: 30px;height: 30px;color: black;background-color:rgb(149, 228, 246);position: fixed; bottom: 50px;right: 1px;z-index: 9999999100000;font-size: 20px;line-height: 30px;text-align: center;cursor: pointer;border-radius: 30px;'>" +
                 "   <div id='GoTopIcon' style='width: 30px!important;height: 30px!important;line-height: 30px!important;font-size: 25px !important;font-family: Helvetica!important;' title='回到顶部'>⇡</div>"+
                 "</a>"][0])

    GM_addStyle(['@keyframes mymove { '+
                 '     0%   { background-color: #11eada; }  25%  { background-color: #1bcfdf; }  50%  { background-color: #25b7e4; }  75%  { background-color: #1bcfdf; }  100% { background-color: #11eada; } '+
                 ' } '+
                 '@-webkit-keyframes mymove {  '+
                 '     0%   { background-color: #11eada; }  25%  { background-color: #1bcfdf; }  50%  { background-color: #25b7e4; }  75%  { background-color: #1bcfdf; }  100% { background-color: #11eada; } '+
                 ' } '+
                 '#downIcon img               { width: 90%!important; height: 90%!important; margin: 5%!important; padding: 0!important; line-height: 90%!important;}'+
                 '#Allurl                     { position: relative; right: -100px; bottom: -7px; display: inline-block; width: 150px; height: 40px; color: black; font-size: 14px; text-align: center; cursor: pointer;}'+
                 '#Allurl>i                   { margin: 0 1px!important;display: inline-block; line-height: 30px;width: 30px;height: 30px; }'+
                 '#MyUrls div,#MyUrls input   { box-sizing: content-box!important;line-height: 100%; }'+
                 '.MyUrls hr                  { background: #837b7b; border-color: #837b7b; border-width: 0;height: 1px;margin: 0; padding: 0; border: none !important; }'+
                 '.jianBian                   { animation: mymove 10s infinite;-webkit-animation: mymove 10s infinite;}'+
                 '.MyBT>div                   { text-align: center;margin: 1px 0;border-radius: 5px;font-size: 17px;cursor: pointer;text-align: center;width: 49%; margin-top: 1px;padding-top: 2px;    line-height: 31px !important;}'+
                 '.MyBT>div>div               { width: 225px;margin: 0px 3px;height: 24px; background-color: white;border-radius: 5px;position: relative;top: -29px;opacity: 0; line-height: 25px !important;}'+
                 '.MyNR                       { max-height: 465px; overflow-y: auto; }'+
                 '.MyNR>div                   { display: none }'+
                 '.MyNR div[class^=No-isUrl]  { width: 30px;text-align: right;display: inline-block; height: 30px;line-height: 30px !important;}'+
                 '.MyNR input[class^=downUrl] {     pointer-events: auto !important; opacity: 1 !important; cursor: text !important;font-size: 12px;width: 145px;display: inline-block;margin: 0px;height: 22px;border: 1px solid black;border-radius: 5px;padding: 0 5px;background: white;color: #000000 !important;}'+
                 '.MyNR input[class^=downName]{ font-size: 12px;width: 35px;display: inline-block;margin: 0px;height: 22px;border: 1px solid black;border-radius: 5px;padding: 0 5px;background: white;color:black;}'+
                 '.But                        { margin-left: 5px;height:20px;width: 40px;padding: 0;border: none;background: #ffba46;border-radius:10px;cursor: pointer;line-height: 20px!important;font-size: 10px;text-align: center; }'+
                 '.MyNR div[class^=rmUrl]     { display: inline-block;cursor: pointer;color:red; width: 30px; height: 30px;line-height: 30px !important; }'+
                 '#giegei717dplayer .dplayer-controller button{ background: black; }'+
                 '.dplayer-controller .dplayer-bar-wrap .dplayer-bar { height: 15px!important;top: -10px!important;}'+
                 '.dplayer-controller .dplayer-bar-wrap .dplayer-bar>[class^=dplayer-] { height: 15px!important;}'+
                 '.dplayer-controller .dplayer-bar-wrap .dplayer-bar .dplayer-played .dplayer-thumb { height: 22px!important; width: 22px!important;}'
                ][0]);

    $(".MyNR div").append(["<div class='urlnone' style='height: 22px;color: red;padding: 9px 0 0 20px;font-size: 15px;'> 暂时没有嗅探到资源</div>"+
                           "<div class='downloadUrl' style='height: 31px; line-height: 30px;'>"+
                           "<hr    class='urlnone' > " +
                           "<div   class='No-isUrl'> 0、</div>"+
                           "<input class='downUrl'         autocomplete='on'   placeholder='请输入要下载的资源链接：' title='自定义资源下载项'> "+
                           "<input class='downName'        style=' width: 125px;'  placeholder='请输入文件名(下载用)' title='默认文件名为当前页面标题'>"+
                           "<div   class='But SaveUrl'     style='display: inline-block; '>下载</div>"+
                           "<div   class='But StopSaveUrl' style='display: none;         '>0%</div>"+
                           "<div   class='But playUrl'     style='display: inline-block; '>播放</div>&nbsp"+
                           "<div   class='rmUrl_input'     title='清空'                   >&nbspx&nbsp</div>"+
                           "</div>"][0])
    //<button class='SaveUrl' style='margin-left: 5px;height: 20px;width: 40px;padding: 0;border: none;background: white;border-radius:10px;cursor: pointer;color:black;font-size: 10px;'>下载</button><button class='StopSaveUrl' style='position: relative;top: -2px;display: none;margin-left: 5px;height: 20px;width: 40px;padding: 0;border: none;background: white;border-radius:10px;cursor: pointer;'>0%</button></div>")
    var angle = 0;
    $("#MyUpDown").click(function () {
        var that = $(this)
        //$("#Allurl").slideToggle("slow");
        $("#MyUrls").slideToggle("slow",function(){
            if (mn=="1"||mn==1){
            }else {
                $("#redPoint").css("display","none")
                //$("#Allurl").css("display","block")
                that.css("background-color", "transparent").removeClass('jianBian')
            };        mn = -mn;
        });
        if (mn=="1"||mn==1){
            //$("#Allurl").css("display","none")
            that.addClass('jianBian')
        }
        var a = angle
        var setXZ = setInterval(function(){
            a = a + 1;
            $("#MyUpDown #downIcon").css( 'transform', 'rotate('+a+'deg)');
            if ( a>=angle+45 ){ stop_XZ() }
        },5);
        function stop_XZ(){ clearInterval(setXZ); angle += 45 };

    })
    $(window).click(function (e) {
        //console.log(e.target)
        var x =$(e.target).is('#MyUrls *,#MyUpDown *,#GoTop *,#MyUrls,#MyUpDown,#GoTop')
        //console.log(x)
        if( !x && $("#MyUrls").css("display")!="none" && $("#MyUpDown").css('pointer-events') != 'none'){
            $("#MyUpDown").click()
            $("#MyUpDown").css( 'pointer-events','none')
            setTimeout(function(){ $("#MyUpDown").css( 'pointer-events','all') },500)
        }
    })
    $(".MyBT>div").click(function (){
        $('.MyBT>div>div').css('opacity', 0);
        $(this).find("div").css('opacity', 1)
        $('.MyNR>div').css('display', 'none').attr('id','')
        $('.MyNR .'+$(this).attr('id')).css('display', 'block').attr('id','My_VorA')
    })
    $(".MyBT #MyVideo")[0].click()

    //全部下载
    $("#Alldownload").click(function (){
        $('#My_VorA .isUrl').each(function(){
            $(this).find("div.But:nth-last-of-type(4)").click()
        })
        layer.msg("开始下载")
    })
    //全部复制
    $("#Allcopy").click(function (){
        var urlss ="";
        $('#My_VorA .isUrl').each(function(){
            urlss = urlss + $(this).find("[class^=downUrl]").attr('title').trim()+ "\n\n"
        })
        GM_setClipboard(urlss);
        //var aux = document.createElement("input");
        //aux.setAttribute("value", urlss);
        //document.body.appendChild(aux);
        //aux.select();
        //document.execCommand("copy");
        //document.body.removeChild(aux);
        layer.msg("已复制")
    })
    window.onload = ()=>{
        if(GM_getValue("checked_n", 1) == set['checked_n']){
            $('body :not(body)').css('user-select','auto') // 解除选中限制
            $('body #MyUrls[class=jianbian]').css('user-select', 'none') // 解除选中限制
            document.onselectstart = function(){
                event.returnValue = true;
                return true;
            }
            document.oncopy = function(){
                event.returnValue = true;
                return true;
            }
            document.onbeforecopy = function(){
                event.returnValue = true;
                return true;
            }
            document.onkeydown = function(){
                event.returnValue = true;
                return true;
            }
            document.onkeyup = function(){
                event.returnValue = true;
                return true;
            }
            document.onkeypress = function(){
                event.returnValue = true;
                return true;
            }
            function MyCopy(event){
                var text = window.getSelection().toString()
                if ( text != undefined && text != null && text.trim() != '') {
                    //GM_setClipboard( text );
                    navigator.clipboard.writeText(text)
                        .then(() => { layer.msg("已复制");console.log("已复制，由 copy 触发") })
                        .catch((error) => {  GM_setClipboard( text );})
                }
            }
            function MyKeydown(event){
                var text = window.getSelection().toString()
                if ( (event.keyCode == 67 || event.keyCode == 88) && event.ctrlKey && text != undefined && text != null && text.trim() != '') {
                    //_setClipboard( text );
                    navigator.clipboard.writeText(text)
                        .then(() => { layer.msg("已复制");console.log("已复制，由 keydown 触发") })
                        .catch((error) => {  GM_setClipboard( text );})
                }
            }
            $(window).keydown( MyKeydown(event) ).on("copy", function(event){ MyCopy(event)} )
            var set$ = setInterval(function(){
                try {
                    //unsafeWindow.$ = $;
                    $("body :not(button,input[type=button])").unbind("keypress keyup keydown copy").off( "keypress keyup keydown copy")
                    stopSet()
                } catch(err) {
                    unsafeWindow.$ = $; //console.log(err)
            }},1000);
            function stopSet(){ clearInterval(set$); };
        }
    }
    //全部清除
    $("#Alldel").click(function (){
        $('#My_VorA .isUrl').remove()
        //URLs = []
        GM_D.forEach(function(item){
            item.forEach(function(i){
                i.abort()
            })
        })
        layer.msg("已清除")
    })
    //录屏
    $("#LupinStart").click( function (){
        var constraints ={
            //audio: true,
            audio:{
                echoCancellation: true,
                autoGainControl: true,
                noiseSuppression:true
            },
            surfaceSwitching: "include",
            video: {
                frameRate: { ideal: 30},
                width: { ideal: 1920 },
                height: { ideal: 1080 },
            }
        };
        var time = 0;
        var opts = {
            onstart: function onStart() { // Use named function.
                time = new Date().getTime()
                console.log('Recorder is started'+"\n"+'开始录屏');
                $("#LupinStart").css('display','none')
                $("#LupinStop").css('display','inline-block')
            },
            onstop: function onStop(blob) {
                time = new Date().getTime() - time;
                console.log('Recorder is stop'+"\n"+'录屏结束'+'\n'+'时长：'+time);
                stream.getTracks().forEach((track) => track.stop());

                var link = document.createElement("a");
                link.href = window.URL.createObjectURL(new Blob([blob]))
                link.download = "录屏 "+ new Date().toLocaleString().replaceAll("/",'-').replaceAll(":",'-') +".mp4";
                link.click();
                link.remove();

                $("#LupinStop").css('display','none')
                $("#LupinStart").css('display','inline-block')
            },
            mimeType:  "video/webm; codecs=h264"
        };
        try {
            window.rec = new QBMediaRecorder(opts);
        } catch(err) {
            //layer.msg("当前页面不被允许录屏");
            console.log(err)
        }
        navigator.mediaDevices.getDisplayMedia(constraints).then((stream) => {
            window.stream = stream
            rec.start(stream);
        });
    })
    $("#LupinStop").click(function (){
        rec.stop()
    })

    //自带下载项功能
    $(".downUrl").on( 'input' ,function (){
        //console.log($(this).val())
        $(this).attr("title",$(this).val())
    })
    $(".downName").on( 'input' ,function (){
        //console.log($(this).val())
        $(this).attr("title",$(this).val())
    })
    $(".rmUrl_input").click(function (){
        $(this).prevAll("input").val('')
        $(this).prevAll(".downUrl").attr("title","自定义视频下载项")
        $(this).prevAll(".downName").attr("title","默认文件名为当前页面标题")
    })

    GoTop()
    window.onscroll = function(){ GoTop()}
    function GoTop(){
        var t = document.documentElement.scrollTop || document.body.scrollTop;
        if( t >= 100 ) {
             $("#GoTop").css("display","block")
        } else {
             $("#GoTop").css("display","none")
        }
    }
    //播放链接
    $(".MyNR  .playUrl").click(function (){
        var url = $(this).prevAll(".downUrl").attr("title")
        var type = $(this).prevAll(".downUrl").data('type')
        if(url == undefined || url.trim()=="" || url.trim().length == 0 || url.trim().split(".").filter(function(item){return item.trim() != "";}).length < 2){
            layer.msg("无有效链接")
        }else{
            dplayerUrl(url,0,type)
            $(".But:nth-last-of-type(2)").text('播放')
            $(this).text("播放中")
        }
    })

    //functionAll("");functionAll("","MyAudio")
    function functionAll(u,VorA="MyVideo"){
        //跳转链接
        $(".MyNR ."+VorA+" .GoUrl"+u).click(function (){
            var url = $(this).prevAll(".downUrl"+u).attr("title")
            var link = document.createElement('a');
            link.href = url;
            link.target="_blank";
            link.click();
            link.remove();
        })
        //复制链接
        $(".MyNR ."+VorA+" .CopyUrl"+u).click(function (){
            var url = $(this).prevAll(".downUrl"+u).attr("title")
            GM_setClipboard(url);
            var aux = document.createElement("input");
            aux.setAttribute("value", url);
            document.body.appendChild(aux);
            aux.select();
            document.execCommand("copy");
            document.body.removeChild(aux);
            $(this).text("已复制")
        })
        //播放链接
        $(".MyNR ."+VorA+" .playUrl"+u).click(function (){
           var url = $(this).prevAll(".downUrl"+u).attr("title")
           var type = $(this).prevAll(".downUrl"+u).data('type')
           if(url == undefined || url.trim()=="" || url.trim().length == 0 || url.trim().split(".").filter(function(item){return item.trim() != "";}).length < 2){
               layer.msg("无有效链接")
           }else{
               var ui = u==''? 0 : u
               dplayerUrl(url,ui,type)
               $(".But:nth-last-of-type(2)").text('播放')
               $(this).text("播放中")
           }
        })
        //删除此条
        $(".MyNR ."+VorA+" .rmUrl"+u).click(function (){
            var num = $(this).prevAll('.StopSaveUrl'+u).data('num')
            if(num != undefined){
                GM_D[num].forEach(function(item){
                    item.abort()
                })
            }
            $(this).parent(".isUrl").remove()
            var list = $('.isUrl')
            list.each(function(i){
                $(this).children("#No-isUrl").text(i+1+'、')
            })
        })
        $(".MyNR ."+VorA+" .downName"+u).on( 'input' ,function (){
            $(this).attr("title",$(this).val())
        })
        $(".MyNR input").dblclick( function () {
            this.select()
        })
        //下载链接
        $(".MyNR ."+VorA+" .SaveUrl"+u).click(function (){
            //$(obj).attr("disabled","disabled")
            var that = $(this)
            var url = $(that).prevAll(".downUrl"+u).val()
            if(url==undefined||url.trim()==''){
                url = $(that).prevAll(".downUrl"+u).attr('title')
                if(url==undefined||url.trim()==''||url.trim()=="自定义资源下载项"){
                    layer.msg("无有效链接");
                    return;
                }
            }
            var name = $(that).prevAll(".downName"+u).val()
            if(name==undefined||name.trim()==""){
                name = $('title').text()
                if(name==undefined||name.trim()==""){
                    name = url.split("/").pop().split("?")[0]
                    if(name==undefined||name.trim()==""){
                        name = "文件未命名"
                    }
                }
            }
            //if(! /\.[\w]+$/.test(name)&& ! /(\.com$ | \.cn)/.test(name)){ name = name + ".mp4"}
            name = name.replaceAll(/\s+/ig," ").trim().replace(/(\.mp4)*$/igm,"")
            if( $(that).parents('.MyNR>div').find('.isUrl').length>5){
                name = $(that).prevAll(".No-isUrl").text().trim() + name
            }
            //console.log(name,url)
            $(that).css("display","none").next('.StopSaveUrl'+u).css("display","inline-block").text("解析中");
            var request = [];
            var head_i = $(that).data('head_i')
            var head = $(that).data('head')
            //console.log(head)
            //head = JSON.parse(head);
            delete head['Range'];
            delete head['Cache-Control']
            var blob = [];
            var loadSize = [];
            var xhrs = 0
            var num = -1
            var href = $(that).data('head_href')
            var origin = head_i == 1 ? location.origin : $(that).data('head_origin')
            var Length =$(that).data('length')
            var Headers = $(that).data('headers')
            var Type = $(that).data('type')
            if(VorA == "MyVideo"){
                name = name+".mp4"
                if( Type !="hls" && (Length==null||Length=="null"||Length==undefined||Length==""||Length=="undefined"||Length<=0 )){
                        console.log("mp4视频单线程下载中ing。")
                        mp4Download(url)
                        return;
                }
                if( Type == "hls"){
                    m3u8Download(url)
                }else{
                    console.log("mp4视频多线程下载中ing。")
                    var RangeSize = parseInt((Length/ xcNum).toFixed(0))
                    //console.log(RangeSize)
                    for(var i=0,z=0;i<Length;i=i+RangeSize,z++){
                        var range_start=i,range_end=i+RangeSize-1;
                        if (range_end + 1 >=Length) {range_end = Length}
                        //console.log(range_start,range_end)
                        DownloadThread( z , range_start , range_end)
                    }
                    //console.log(request)
                    num =GM_D.push(request)
                    $(that).next('.StopSaveUrl'+u).data('num',num-1)
                    function DownloadThread( z, range_start , range_end){
                        //console.log(z, range_start , range_end)
                        function onprogress (event){
                            loadSize[z] = event.loaded;
                            var all_length =0;
                            loadSize.forEach( function(item){
                                all_length = all_length + item
                            });
                            var loaded = ( parseFloat( all_length / Length * 100)).toFixed(1);
                            if(loaded <= 100){
                                $(that).next(".StopSaveUrl"+ u ).text( loaded +"%");
                                console.log(u+"、线程 "+z+" ： 已下载"+ event.loaded +" 总" +event.total);
                            }
                        }
                        head.Range = "bytes=" +range_start +"-"+ range_end;
                        request[z] = GM_xmlhttpRequest({
                            method: "GET",
                            url: url,
                            fetch: false,
                            responseType: "arraybuffer",
                            headers: head ,
                            //headers: head_i==0 ? { "Range":"bytes=" +range_start +"-"+ range_end} : { 'Referer': href,'Origin': origin, "Range":"bytes=" +range_start +"-"+ range_end},
                            onprogress: onprogress ,
                            onload: function(response) {
                                //console.log(response.response);
                                blob[z] = new Blob([response.response], { type: 'video/mp4' });
                                //     console.log(blob);
                                var x=0,y=0;
                                //所有下载中线程的文件大小
                                loadSize.forEach(function(item){
                                    x = x + item
                                });
                                //所有已下载完成线程的文件大小
                                blob.forEach(function(item){
                                    y = y + item.size
                                });
                                console.log(u +"、线程 "+z+" ： 下载结束 下完线程的文件大小："+ y +" 已下载的文件大小："+ x +" 总："+ Length);
                                if (y >= Length) {
                                    var link = document.createElement("a");
                                    link.href = window.URL.createObjectURL(new Blob(blob, { type: 'video/mp4' }));
                                    link.download = name;
                                    link.click();
                                    link.remove();
                                    $(that).text("已下载").css("display","inline-block").attr("title","下载").next(".StopSaveUrl"+ u).css("display","none").text("0%");console.warn(u +"、文件下载完成：" +name)
                                }
                            },
                            onabort: function(){
                                // $(that).text("继续").css("display","inline-block").next(".StopSaveUrl1").css("display","none").text("0%");
                                console.log("abort！");
                            },
                            onerror: function(x) {
                                // $(that).text("错误").css("display","inline-block").next(".StopSaveUrl  u  ").css("display","none").text("0%");
                                console.log("error！更换线路ing");
                                request.forEach(function(item){
                                    item.abort()
                                });
                                mp4Download(url);
                                var numi = parseInt( $(that).next(".StopSaveUrl"+u ).data("num") );
                                GM_D[numi] = request;
                            },
                        });
                    }
                }
            }else if(VorA == "MyAudio"){
                name = name+".mp3"
                mp4Download(url)
            }

            function mp4Download(url){
                console.log("资源单线程下载中ing。")
                head['If-Modified-Since'] = '0';
                request.push(GM_download({
                    url: url,
                    name: name,
                    headers: head,
                    //headers: head_i==0 ? { 'If-Modified-Since': '0'} : {'Referer': href, 'If-Modified-Since': '0'},
                    onprogress : function (event) {
                        //console.log(event)
                        if (event!=null) {
                            var loaded = parseFloat(event.loaded / event.total * 100).toFixed(2);
                            if(loaded >= 100){
                                $(that).text("已下载").css("display","inline-block").attr("title","下载").next(".StopSaveUrl"+u).css("display","none");
                            }else{
                                $(that).css("display","none").next(".StopSaveUrl"+u).css("display","inline-block").text(loaded+"%");
                                console.log(u+"、单线程： 已下载"+event.loaded+" 总"+event.total+ " 比 "+loaded +"%");
                            }
                        }
                    },
                    onload : function () {
                        $(that).text("已下载").css("display","inline-block").attr("title","下载").next(".StopSaveUrl"+u).css("display","none").text("0%");
                        console.warn(u+"、文件下载完成："+name)
                    },
                    onerror : function (x) {
                        console.log(x)
                        $(that).text("错误").css("display","inline-block").attr("title","下载出错。").next(".StopSaveUrl"+u).css("display","none").text("0%");
                    }
                }))
                num =GM_D.push(request)
                $(that).next('.StopSaveUrl'+u).data('num',num-1);
            }

            function m3u8Download(url){
                console.log("m3u8解析下载中ing。")
                GM_xmlhttpRequest({
                    method: "GET",
                    url: url,
                    headers: head,
                    //headers: head_i==0 ? { } : {'Referer': href,'Origin': origin}, //,'If-Modified-Since': '0'},
                    onerror: function(x) {
                        console.log("m3u8 GET出错onerror")
                        $(that).text("错误").css("display","inline-block").attr("title","下载出错。").next(".StopSaveUrl"+u).css("display","none").text("0%");
                    },
                    onload: function(response) {
                        var err = []
                        var tsNum=0
                        var tsS = 0
                        var tsi =0
                        var tsLength
                        var list0
                        var IV="",keyData=null;
                        async function syncRequest(url) {
                            var r = '';
                            head['If-Modified-Since'] = '0'
                            await GM.xmlHttpRequest({
                                method: "GET",
                                url: url ,
                                headers: head,
                                //headers: head_i==0 ? { 'If-Modified-Since': '0' } : {'Referer': href, 'If-Modified-Since': '0'},
                                responseType: "arraybuffer",
                                }).then((value) => {console.log(value);r = value.response; }).catch(e => {console.error(e);return null});
                            return r;
                        }
                        function jiemi(pwdBlob){
                            // 引入CryptoJS库
                            //console.log('解密中')
                            // 密钥和向量
                            IV = IV==null ? keyData : IV ;
                            return aesDecryptArrayBuffer(keyData, IV, pwdBlob)//aesEncrypt(keyData, pwdBlob, IV);
                            function aesDecryptArrayBuffer(key, iv, encryptedArrayBuffer) {
                                // 转换加密的ArrayBuffer为WordArray
                                var encryptedWords = CryptoJS.lib.WordArray.create(encryptedArrayBuffer);
                                if (typeof iv === 'string') { iv = stringToArrayBuffer(iv) }
                                if (typeof key === 'string') { key = stringToArrayBuffer(key) }
                                iv = CryptoJS.lib.WordArray.create(iv);
                                key = CryptoJS.lib.WordArray.create(key);
                                // 使用CryptoJS进行AES解密
                                var decryptedWords = CryptoJS.AES.decrypt(
                                    { ciphertext: encryptedWords },
                                    key,
                                    {
                                        iv: iv,
                                        mode: CryptoJS.mode.CBC,
                                        padding: CryptoJS.pad.Pkcs7
                                    }
                                );
                                // 获取解密后的字节数组
                                var decryptedBytes = CryptoJS.enc.Base64.stringify(decryptedWords);
                                // 转换解密后的字节数组为ArrayBuffer
                                var decryptedArrayBuffer = base64ToArrayBuffer(decryptedBytes);
                                return decryptedArrayBuffer;
                            }
                            function pad(key) {
                                // 使用PKCS#7填充
                                var x = 0b0
                                while (key.length % 16 !== 0) {
                                    key += 0b0;
                                }
                                return key;
                            }
                            function base64ToArrayBuffer(base64) {
                                var binaryString = window.atob(base64);
                                var len = binaryString.length;
                                var bytes = new Uint8Array(len);
                                for (var i = 0; i < len; i++) {
                                    bytes[i] = binaryString.charCodeAt(i);
                                }
                                return bytes.buffer;
                            }
                            function arrayBufferToBase64(buffer) {
                                var binary = '';
                                var bytes = new Uint8Array(buffer);
                                var len = bytes.byteLength;
                                for (var i = 0; i < len; i++) {
                                    binary += String.fromCharCode(bytes[i]);
                                }
                                // 对二进制字符串进行Base64编码
                                return btoa(binary);
                            }
                            function stringToArrayBuffer(str) {
                                let encoder = new TextEncoder();
                                return encoder.encode(str).buffer;
                            }
                        }
                        function isTS(buffer) {
                            const d = new Uint8Array(buffer);
                            // if (buffer.byteLength < 1 * 1024) return false;
                            const s = new TextDecoder().decode(d.slice(0, 100)).trim();
                            return !(
                                s.startsWith("<!DOCTYPE") ||
                                s.startsWith("<html") ||
                                s.startsWith("{") ||
                                s.startsWith("[") ||
                                s.startsWith("<?xml")
                            );
                        }
                        function isMedia(buffer) {
                            const d = new Uint8Array(buffer);
                            if (buffer.byteLength < 50 * 1024) return false;
                            const s = new TextDecoder().decode(d.slice(0, 100)).trim();
                            return !(
                                s.startsWith("<!DOCTYPE") ||
                                s.startsWith("<html") ||
                                s.startsWith("{") ||
                                s.startsWith("[") ||
                                s.startsWith("<?xml")
                            );
                        }
                        function downTs(list,tsUrl,i,status){
                            //console.log(tsUrl)
                            head['If-Modified-Since'] = '0';
                            request[i] = GM_xmlhttpRequest({
                                method: "GET",
                                url: tsUrl,
                                headers: head,
                                //headers: head_i==0 ? { 'If-Modified-Since': '0' } : {'Referer': href, 'If-Modified-Since': '0'},
                                responseType: "arraybuffer",
                                onloadstart: function(){
                                },
                                onload: function(response) {
                                    var buf = response.response
                                    //console.log(buf)

                                    if(!isTS(buf)){
                                        $(that).text("错误").css("display","inline-block").attr("title","下载出错").next(".StopSaveUrl"+u).css("display","none").text("0%");
                                        var num = $(that).next(".StopSaveUrl"+u).data("num");
                                        console.log("出错，可能不是ts，长度:",buf.byteLength);
                                        const text = new TextDecoder("utf-8").decode(response.response);
                                        console.log({"tsUrl":tsUrl ,content: text });
                                        return
                                    }
                                    blob[i] = buf
                                    if( status == "key"){
                                        var setjm = setInterval(function(){
                                            if(keyData != null ){
                                                stopjm()
                                                blob[i] = ( new Blob([jiemi(response.response)], { type: 'video/mp4' }) )
                                            }},50);
                                        function stopjm(){ clearInterval(setjm); };
                                    }else{
                                        blob[i] = ( new Blob([response.response], { type: 'video/mp4' }) )
                                    }
                                    list0.splice(list0.indexOf(tsUrl),1)
                                    if (list0.length>0) {
                                        tsNum = parseFloat(tsNum) + 1 / tsS * 100;
                                        tsNum = tsNum >100 ? 100 : parseFloat(tsNum).toFixed(2);
                                        tsi = tsi+1
                                        console.log(u+"、已下完的视频切片数："+ tsi +" 长度："+buf.byteLength+" 总数："+ tsS);
                                        $(that).next(".StopSaveUrl"+u).text(tsNum+"%");
                                        if(list.length > 0 ){
                                            downTs(list,list.shift(),i+1,status)
                                        }
                                    }else {
                                        $(that).next(".StopSaveUrl"+u).text("100%");
                                        var is = true;
                                        try {
                                            var sab = new SharedArrayBuffer(1);
                                        } catch(err) {
                                            console.log( err.message +"\n 浏览器不支持SharedArrayBuffer")
                                            is = false
                                        }
                                        var link = document.createElement("a");
                                        if(GM_getValue("ffmpeg_n", 1) == set['ffmpeg_n'] && is){
                                            (async () => {
                                                try {
                                                    FFmpeg;
                                                } catch(err) {
                                                    console.log( err.message +"\n 没有加载FFmpeg");
                                                    await $.ajax({
                                                        async: false,
                                                        url: "https://unpkg.com/@ffmpeg/ffmpeg@0.10.0/dist/ffmpeg.min.js",
                                                        dataType: "script"
                                                    });
                                                }
                                                $(that).next(".StopSaveUrl"+u).text("转码中");
                                                const { createFFmpeg, fetchFile } = FFmpeg;
                                                const ffmpeg = createFFmpeg({
                                                    //corePath: 'https://unpkg.com/@ffmpeg/core@0.10.0/dist/ffmpeg-core.js',
                                                    log: true,
                                                    progress: ({ ratio }) => {
                                                        tsNum = (ratio * 100.0).toFixed(2)
                                                        $(that).next(".StopSaveUrl"+u).text(tsNum+"%").attr("title",'转码中');
                                                    },
                                                });
                                                console.log( '正在加载 ffmpeg-core.js');
                                                await ffmpeg.load();
                                                console.log('开始转码');
                                                ffmpeg.FS('writeFile', 'video.ts', await fetchFile(new Blob(blob)) );
                                                await ffmpeg.run('-i', 'video.ts' ,'output.mp4');
                                                console.log('转码完成');
                                                const data = ffmpeg.FS('readFile', 'output.mp4');
                                                $(that).text("已下载").css("display","inline-block").attr("title","下载").next(".StopSaveUrl"+u).css("display","none").attr("title","下载中");
                                                link.href = window.URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
                                                link.download = name;
                                                link.click();
                                                link.remove();
                                                ffmpeg.exit()
                                            })();
                                        }else{
                                            $(that).text("已下载").css("display","inline-block").attr("title","下载").next(".StopSaveUrl"+u).css("display","none").attr("title","下载中");
                                            link.href = window.URL.createObjectURL(new Blob(blob, { type: 'video/mp4' }));
                                            link.download = name;
                                            link.click();
                                            link.remove();
                                        }
                                        console.warn(u+"、文件下载完成："+name)
                                    }
                                },
                                onabort: function(){
                                    console.log("abort！");
                                },
                                onerror: function(x) {
                                    console.log("ts GET出错onerror!")
                                    console.log(x)
                                    if (err<10){
                                        err = err+1
                                        downTs(list,tsUrl,i)
                                    }else{
                                        err = 0
                                        $(that).text("错误").css("display","inline-block").attr("title","下载出错").next(".StopSaveUrl"+u).css("display","none").text("0%");
                                        var num = $(that).next(".StopSaveUrl"+u).data("num")
                                        GM_D[num].forEach(function(item){
                                            item.abort()
                                        })
                                    }
                                }
                            });
                        }
                        var Ts = response.responseText.trim()
                        //console.log(Ts)
                        //console.log(response)
                        var TsStart = Ts.split(/(#EXTINF[^\n]*|#EXT-X-STREAM-INF[^\n]*)/)[0];
                        //console.log(TsStart )
                        if(/^#EXTM3U/.test(TsStart)){
                            console.log("m3u8解析中")
                            //layer.msg("m3u8解析中", {icon: 0});
                            //console.log(Ts)
                            var num1,num2,ad_ts
                            if(GM_getValue("ad_n", 1)== set['ad_n']){
                                while( Ts.search(/#EXT-X-DISCONTINUITY/i) != -1 ){
                                    num1 = Ts.search(/#EXT-X-DISCONTINUITY/i);
                                    Ts = Ts.replace(/#EXT-X-DISCONTINUITY/i,'这是要去除的部分')
                                    num2 = Ts.search(/#EXT-X-DISCONTINUITY/i);
                                    ad_ts = num2 != -1 ? Ts.slice( num1,num2+20) : Ts.slice(num1)
                                    Ts = Ts.replace(ad_ts,"")
                                    if( Ts.search(/#EXT-X-DISCONTINUITY/i) == -1){
                                        break
                                    }
                                }
                            }
                            Ts = Ts.replaceAll(/^#(?!(EXTINF[^\n]*|EXT-X-STREAM-INF[^\n]*))[^\n]*/img,"").trim().replaceAll(/\n#/img,'??#').split('??')
                            //console.log(Ts)
                            Ts = Ts.filter(function(item){
                                return item.trim() != "";
                            });
                            //console.log(Ts);
                            var status = "",bool = "false",mapURI = "false",keyUrl,keytext;
                            TsStart.split("\n").forEach(function(item){
                                if(/#EXT-X-KEY/.test(item.trim())){
                                    status = item.match(/METHOD=[\w-]{4,10}/im)[0]
                                    if( status!=undefined && status!= null && status!=''){
                                        status = status.replaceAll(/METHOD=/igm,'').trim()
                                        if (status=='None'||status=="NONE"||status=='none'||status==''){
                                            status = ""
                                        }else{
                                            status = "key"
                                            const match = item.match(/URI="([^"]+)"/i)
                                            if (match && /\.key(?:$|[?#])/i.test(match[1])) {
                                                keyUrl = new URL(match[1], url).href
                                            }
                                            const ivMatch = item.match(/IV=([\w]+|0x[0-9a-f]+)/i);
                                            IV = ivMatch ? ivMatch[1] : null;
                                            IV = IV == null || IV == undefined || IV == "" ? null : IV.replaceAll(/(IV=)/ig,'').trim()
                                        }
                                        return;
                                    }
                                }
                                if(/#EXT-X-TARGETDURATION/.test(item.trim())){
                                    bool = "true"
                                }
                                if(/#EXT-X-MAP:URI=/.test(item.trim())){
                                    mapURI = Ts[0].split("\n")[0]+"\n"+item.replaceAll('#EXT-X-MAP:URI=','').replaceAll('"','').replaceAll("'","").trim()
                                    Ts.unshift(mapURI)
                                    var list = []
                                    Ts.forEach(function(item,i){
                                        list.push(item)
                                        list.push(mapURI)
                                    })
                                    Ts = list.slice();
                                }
                            })
                            if(status == "key"){
                                if( /^(http:|https:)?(\/{0,2}([^\.\s\/]*\.){1,2}[\w]{1,8})/.test(keyUrl) ){
                                    keyData = syncRequest(keyUrl).then(val => {
                                        keyData = val
                                        console.log( "m3u8加密,启用解密")
                                    }).catch(e => {
                                        keyData = keytext
                                        //console.log("keyData出错：")
                                        console.log(e)
                                        console.log( "m3u8加密,解密困难，尝试中")
                                        //$(that).text("错误").css("display","inline-block").attr("title","m3u8加密，暂时无法解决。").next(".StopSaveUrl"+u).css("display","none").text("0%");
                                        //console.log("m3u8加密，暂时无法解决。")
                                        //layer.msg("m3u8加密，暂时无法解决。", {icon: 2});
                                        //return;
                                    })
                                }else{
                                    $(that).text("错误").css("display","inline-block").attr("title","m3u8加密，暂时无法解决。").next(".StopSaveUrl"+u).css("display","none").text("0%");
                                    console.log("m3u8加密，暂时无法解决。")
                                    layer.msg("m3u8加密，暂时无法解决。", {icon: 2});
                                    return;
                                }
                            }
                            //console.log(Ts)
                            var tsUrl,tsUrl1;
                            Ts.forEach(function(item,i){
                                if(/^(#EXTINF[^\n]*|#EXT-X-STREAM-INF[^\n]*)/.test(item.trim())){
                                    tsUrl = item.trim().match(/\n.*/img)[0].trim()
                                    //console.log(tsUrl)
                                    if(/^(http:|https:)/.test(tsUrl)){
                                        //"完整链接"
                                        tsUrl = item.trim()
                                    }else if( /^(\/{0,2}([^\.\s\/]*\.){1,3}[\w]{1,8}(:[\d]{1,5})?)\/.*/.test(tsUrl) ){

                                        tsUrl = href.trim().match(/^(http:|https:)/im)[0]+"//"+tsUrl.replace(/^(\/{0,2})/img,"")
                                    }else if( /^(\/)/.test(tsUrl)){ //"不完整，需要拼接" https://kitreply.com/60bf2929-9e66-4368-8718-c71203664836/playlist.m3u8
                                        tsUrl1 = url.replace("://",":\\"). split(/\//)[0].replace(":\\","://")
                                        tsUrl1 = tsUrl1 + tsUrl.replaceAll(/\s*/img,"")
                                        tsUrl = item.trim().replaceAll(tsUrl.trim(),tsUrl1)

                                    }else{
                                        tsUrl1 = url.split("?")[0].split("/");
                                        tsUrl1.pop();
                                        tsUrl1 = tsUrl1.join("/")+"/"+tsUrl.replaceAll(/\s*/img,"")
                                        tsUrl = item.trim().replaceAll(tsUrl.trim(),tsUrl1)
                                    }
                                    Ts[i] = tsUrl
                                    //console.log(tsUrl)
                                }
                            })
                            //console.log(Ts)
                            if(bool == "true"){
                                console.log("m3u8没有嵌套，直接解析。")
                                Ts.forEach(function(item,i){
                                    Ts[i] = item.trim().match(/\n.*/img)[0].trim();
                                });
                                //console.log(Ts)
                                tsLength = Ts.length;
                                tsS = tsLength;
                                var TssSize = parseInt( ( tsLength/ xcNum).toFixed(0) )
                                TssSize = TssSize < 1 ? 1 : TssSize;
                                //console.log(TssSize)
                                list0 = Ts.slice();
                                for(var i=0,z=0;i < tsLength; i = i+TssSize, z++){
                                    var range_start = i,range_end = i+TssSize;
                                    if (range_end > tsLength) {range_end = tsLength}
                                    //console.log(range_start+"  __  "+range_end)
                                    var tslist = Ts.slice(range_start,range_end);
                                    //console.log(tslist)
                                    downTs(tslist, tslist.shift(),i,status)
                                }
                                num =GM_D.push(request)
                                $(that).next('.StopSaveUrl'+u).data('num',num-1);
                            }else{
                                console.log("这下边嵌套了m3u8。")
                                var maxP='0x0',maxUrl='';
                                Ts.forEach(function(item,i){
                                    tsUrl = item.split("\n",2)
                                    if( /RESOLUTION=\d+\D\d+/igm.test( tsUrl[0] )){
                                        var P = tsUrl[0].match(/RESOLUTION=\d+\D\d+/igm)[0].match(/\d+\D\d+/igm)[0]
                                        if( maxP.split(/\D/).reduce(function(val1,val2){return val1*val2}) < P.split(/\D/).reduce(function(val1,val2){return val1*val2}) ){
                                            maxUrl = tsUrl[1] ;
                                            maxP = P
                                        }
                                    }else{
                                        maxUrl = tsUrl[1]
                                        return;
                                    }
                                })
                                //console.log(maxP,maxUrl)
                                //name = name.replace(/(\.mp4)*$/igm,"")+"_"+m3u8Url.split("?")[0].split("/").pop().replace(/(\.m3u8)*$/igm,"")+".mp4"
                                GM_xmlhttpRequest({
                                    method: "GET",
                                    url: maxUrl,
                                    headers: head, //{'Referer': href },// 'If-Modified-Since': '0'},
                                    onerror: function(x) {
                                        $(that).text("错误").css("display","inline-block").attr("title","下载出错。").next(".StopSaveUrl"+u).css("display","none").text("0%");
                                        console.log(x)
                                    },
                                    onload: function(response) {
                                        url = maxUrl
                                        var Ts = response.responseText.trim()
                                        //console.log(Ts)
                                        var TsStart = Ts.split(/(#EXTINF[^\n]*)/)[0];
                                        //console.log(TsStart )
                                        if(/^#EXTM3U/.test(TsStart)){
                                            console.log("嵌套m3u8解析中")
                                            //layer.msg("嵌套m3u8解析中", {icon: 2});
                                            //console.log(Ts)
                                            var num1,num2,ad_ts
                                            if(GM_getValue("ad_n", 1)== set['ad_n']){
                                                while( Ts.search(/#EXT-X-DISCONTINUITY/i) != -1 ){
                                                    num1 = Ts.search(/#EXT-X-DISCONTINUITY/i);
                                                    Ts = Ts.replace(/#EXT-X-DISCONTINUITY/i,'这是要去除的部分')
                                                    num2 = Ts.search(/#EXT-X-DISCONTINUITY/i);
                                                    ad_ts = num2 != -1 ? Ts.slice( num1,num2+20) : Ts.slice(num1)
                                                    Ts = Ts.replace(ad_ts,"")
                                                    if( Ts.search(/#EXT-X-DISCONTINUITY/i) == -1){
                                                        break
                                                    }
                                                }
                                            }
                                            Ts = Ts.replaceAll(/^#(?!(EXTINF[^\n]*))[^\n]*/img,"").trim().replaceAll(/\n#/img,'??#').split('??')
                                            //console.log(Ts)
                                            Ts = Ts.filter(function(item){
                                                return item.trim() != "";
                                            });
                                            //console.log(Ts);
                                            var status = "",bool = "false",mapURI = "false",keyUrl,keytext;
                                            TsStart.split("\n").forEach(function(item){
                                                if(/#EXT-X-KEY/.test(item.trim())){
                                                    status = item.match(/METHOD=[\w-]{4,10}/im)[0]
                                                    if( status!=undefined && status!= null && status!=''){
                                                        status = status.replaceAll(/METHOD=/igm,'').trim()
                                                        if (status=='None'||status=="NONE"||status=='none'||status==''){
                                                            status = ""
                                                        }else{
                                                            status = "key"
                                                            keytext = item.match(/URI="[^"'\s]*"/i)[0].replaceAll(/(URI="|")/ig,'').trim()
                                                            keyUrl = keytext
                                                            if(/[\w]*\.key/.test(keyUrl)){
                                                                if( /^http[s]?:\/\/\w*\./.test(keyUrl)){    //"不完整，需要拼接"
                                                                    keyUrl = keyUrl
                                                                }else if( /^\/\/\w*\./.test(keyUrl) | /^\w*\.\w*/.test(keyUrl)){
                                                                    keyUrl = (new URL(url)).protocol + '//'+keyUrl.replaceAll(/(^\/\/)/ig,'')
                                                                }else{
                                                                    tsUrl1 = url.split("?")[0].split("/");
                                                                    tsUrl1.pop();
                                                                    keyUrl = tsUrl1.join("/")+"/"+keyUrl.replaceAll(/\s*/img,"")
                                                                }
                                                            }
                                                            IV = item.match(/IV=[\wx]*/i)[0]
                                                            IV = IV==null|IV==undefined|IV=="" ? null : IV.replaceAll(/(IV=)/ig,'').trim()
                                                        }
                                                        return;
                                                    }
                                                }
                                                if(/#EXT-X-MAP:URI=/.test(item.trim())){
                                                    mapURI = Ts[0].split("\n")[0]+"\n"+item.replaceAll('#EXT-X-MAP:URI=','').replaceAll('"','').replaceAll("'","").trim()
                                                    Ts.unshift(mapURI)
                                                    var list = []
                                                    Ts.forEach(function(item,i){
                                                        list.push(item)
                                                        list.push(mapURI)
                                                    })
                                                    Ts = list.slice();
                                                }
                                            })
                                            if(status == "key"){
                                                if( /^(http:|https:)?(\/{0,2}([^\.\s\/]*\.){1,2}[\w]{1,8})/.test(keyUrl) ){
                                                    keyData = syncRequest(keyUrl).then(val => {
                                                        keyData = val
                                                        console.log( "m3u8加密,启用解密")
                                                    }).catch(e => {
                                                        keyData = keytext
                                                        //console.log("keyData出错：")
                                                        console.log(e)
                                                        console.log( "m3u8加密,解密困难，尝试中")
                                                        //$(that).text("错误").css("display","inline-block").attr("title","m3u8加密，暂时无法解决。").next(".StopSaveUrl"+u).css("display","none").text("0%");
                                                        //console.log("m3u8加密，暂时无法解决。")
                                                        //layer.msg("m3u8加密，暂时无法解决。", {icon: 2});
                                                        //return;
                                                    })
                                                }else{
                                                    $(that).text("错误").css("display","inline-block").attr("title","m3u8加密，暂时无法解决。").next(".StopSaveUrl"+u).css("display","none").text("0%");
                                                    console.log("m3u8加密，暂时无法解决。")
                                                    layer.msg("m3u8加密，暂时无法解决。", {icon: 2});
                                                    return;
                                                }
                                            }
                                            //console.log(Ts)
                                            var tsUrl,tsUrl1;
                                            Ts.forEach(function(item,i){
                                                if(/^(#EXTINF[^\n]*|#EXT-X-STREAM-INF[^\n]*)/.test(item.trim())){
                                                    tsUrl = item.trim().match(/\n.*/img)[0].trim()
                                                    //console.log(tsUrl)
                                                    if(/^(http:|https:)/.test(tsUrl)){
                                                        //"完整链接"
                                                        tsUrl = item.trim()
                                                    }else if( /^(\/{0,2}([^\.\s\/]*\.){1,3}[\w]{1,8}(:[\d]{1,5})?)\/.*/.test(tsUrl) ){
                                                        tsUrl = href.trim().match(/^(http:|https:)/im)[0]+"//"+tsUrl.replace(/^(\/{0,2})/img,"")
                                                    }else if( /^(\/)/.test(tsUrl)){ //"不完整，需要拼接" https://kitreply.com/60bf2929-9e66-4368-8718-c71203664836/playlist.m3u8
                                                        tsUrl1 = url.replace("://",":\\"). split(/\//)[0].replace(":\\","://")
                                                        tsUrl1 = tsUrl1 + tsUrl.replaceAll(/\s*/img,"")
                                                        tsUrl = item.trim().replaceAll(tsUrl.trim(),tsUrl1)

                                                    }else{
                                                        tsUrl1 = url.split("?")[0].split("/");
                                                        tsUrl1.pop();
                                                        tsUrl1 = tsUrl1.join("/")+"/"+tsUrl.replaceAll(/\s*/img,"")
                                                        tsUrl = item.trim().replaceAll(tsUrl.trim(),tsUrl1)
                                                    }
                                                    Ts[i] = tsUrl
                                                    //console.log(tsUrl)
                                                }
                                            })
                                            //console.log(Ts)
                                            Ts.forEach(function(item,i){
                                                Ts[i] = item.trim().match(/\n.*/img)[0].trim();
                                            });
                                            tsLength = Ts.length;
                                            tsS = tsLength;
                                            var TssSize = parseInt( ( tsLength/ xcNum).toFixed(0) )
                                            TssSize = TssSize < 1 ? 1 : TssSize;
                                            list0 = Ts.slice();
                                            for(var i=0,z=0;i < tsLength; i = i+TssSize, z++){
                                                var range_start = i,range_end = i+TssSize;
                                                if (range_end > tsLength) {range_end = tsLength}
                                                //console.log(range_start+"  __  "+range_end)
                                                var tslist = Ts.slice(range_start,range_end);
                                                //console.log(tslist)
                                                downTs(tslist, tslist.shift(),i,status)
                                            }
                                            num =GM_D.push(request)
                                            $(that).next('.StopSaveUrl'+u).data('num',num-1);
                                        }else{
                                            var blob = new Blob([response.response], { type: 'video/mp4' })
                                            if( blob.size< 1024*1024/2 ){
                                                $(that).text("错误").css("display","inline-block").attr("title","URL链接异常").next(".StopSaveUrl"+u).css("display","none").text("0%");
                                                console.log("URL链接异常")
                                                layer.msg("URL链接异常，请检查链接后重试", {icon: 2});
                                                return;
                                            }
                                            var link = document.createElement("a");
                                            link.href = window.URL.createObjectURL(blob );
                                            link.download = name;
                                            link.click();
                                            link.remove();
                                            $(that).text("下载").css("display","inline-block").attr("title","下载").next(".StopSaveUrl"+u).css("display","none").text("0%");
                                        }
                                    }
                                })
                            }
                        }else{

                            if (!isMedia(response.response)) {
                                console.log("")
                                $(that).text("错误").css("display","inline-block").attr("title","下载出错。").next(".StopSaveUrl"+u).css("display","none").text("0%");
                                const bytes = new Uint8Array(buf);
                                console.log("m3u8 GET内容出错onerror，长度:", bytes.length);
                                const text = new TextDecoder("utf-8").decode(response.response);
                                console.log({"tsUrl":tsUrl ,content: text });
                                return
                            }else{
                                var link = document.createElement("a");
                                link.href = window.URL.createObjectURL(new Blob([response.response], { type: 'video/mp4' }));
                                link.download = name;
                                link.click();
                                link.remove();
                                $(that).text("已下载").css("display","inline-block").attr("title","下载").next(".StopSaveUrl"+u).css("display","none").text("0%");
                            }
                        }
                    }
                })
            }
        })
        //停止
        $(".MyNR ."+VorA+" .StopSaveUrl"+u).click(function (){
            var num = $(this).data("num")
            GM_D[num].forEach(function(item){
                item.abort()
            })
            $(this).data("num","").css("display","none").text("0%").prev(".SaveUrl"+u).text("继续").attr("title","下载中断").css("display","inline-block");
        })
    }

    try {
        GM.webRequest()

        //嗅探
        GM_webRequest([
            { selector: '*://*/*.m3u8*', action: { redirect: { from: "(.*)", to: "$1" } } },
            { selector: '*://*/*m3u8*',  action: { redirect: { from: "(.*)", to: "$1" } } },
            //{ selector: { include: '*', exclude: 'http://exclude.me/*' }, action: { redirect: 'http://new_static.url' } },
            //{ selector: { match: '*://*/*' }, action: { redirect: { from: '([^:]+)://match.me/(.*)',  to: '$1://redirected.to/$2' } } }
        ], function(info, message, details) {
            //console.log(info, message, details);
            var z = details.url;
            if(z == $('#MyUrls .downUrl').val().trim() ){ return; }
            if(z !=undefined && z.trim()!="" ){
                addUrl( z )
            }
        });

        // 针对某音网站的视频
        if( location.host == 'www.douyin.com' ){
            GM_webRequest([

                { selector: 'https://v3-web-prime.douyinvod.com/video/*', action: { redirect: { from: "(.*)", to: "$1" } } },
                { selector: 'https://v26-web-prime.douyinvod.com/video/*', action: { redirect: { from: "(.*)", to: "$1" } } },
                { selector: 'https://www.douyin.com/aweme/v1/play/?file_id=*', action: { redirect: { from: "(.*)", to: "$1" } } },
                //{ selector: { include: '*', exclude: 'http://exclude.me/*' }, action: { redirect: 'http://new_static.url' } },
                //{ selector: { match: '*://*/*' }, action: { redirect: { from: '([^:]+)://match.me/(.*)',  to: '$1://redirected.to/$2' } } }
            ], function(info, message, details) {
                //console.log(info, message, details);
                var z = details.url.trim();
                if(z == $('#MyUrls .downUrl').val().trim() ){ return; }
                if(z !=undefined && z.trim()!="" ){
                    addUrl( z )
                }
            });
        }
    } catch(err) {
        //layer.msg("当前浏览器不支持 GM_webRequest()");
        console.log("当前浏览器不支持 GM_webRequest()");
    }

    //针对某bili
    if( location.host == 'www.bilibili.com' && ( /https:\/\/www\.bilibili\.com\/video\/BV\w*/i.test(location.href)||/https:\/\/www\.bilibili\.com\/bangumi\/play\/\w*/i.test(location.href) ) ){
        window.addEventListener("pushState", function () {
            biliVideo (1)
        });
        if (window.self == window.top) {
            //console.log("当前页面是最顶层 是iframe父");
            biliVideo (0)
        }
    }
    var bili_url = ''
    var New_bili_url=''
    function biliVideo (i){
        var set$ = setInterval(function(){
            var videoData
            switch( location.href.trim().match(/(www\.bilibili\.com\/(video|bangumi))/im)[0] )
            {
                case "www.bilibili.com/video":
                    videoData = unsafeWindow.__INITIAL_STATE__.videoData
                    var name = new URLSearchParams(window.location.search);
                    var page = name.get('p'); // 返回 'value1'
                    if(page == null||page ==undefined||page ==''){
                        page = 1
                    }
                    for (let i = 0; i < videoData.pages.length; i++) {
                        if (videoData.pages[i].page == page) {
                            New_bili_url = 'https://api.bilibili.com/x/player/playurl?avid='+ videoData.aid+'&cid='+ videoData.pages[i].cid+'&qn=120'
                            name = videoData.pages[i].part
                            if( name.trim() != $('.video-title').text().trim() ){
                                name = $('.video-title').text().trim()+" —— "+ name.trim()
                            }
                            break; // 当数字为4时退出循环
                        }
                    }
                    break;
                case "www.bilibili.com/bangumi":
                    if(i==0){
                        videoData = playurlSSRData.result.play_view_business_info.episode_info
                    }else{
                        videoData = $($.get({url:location.href,async:false}).responseText).last().text()
                        videoData = JSON.parse(videoData).props.pageProps.dehydratedState.queries[0].state.data.result.play_view_business_info.episode_info
                    }
                    New_bili_url = 'https://api.bilibili.com/x/player/playurl?avid='+ videoData.aid+'&cid='+ videoData.cid+'&qn=120'
                    name = $('[class^=mediainfo_mediaTitle__]').text()+" ["+videoData.title+"] : "+videoData.long_title
                    //console.log( videoData)
                    break;
                default:
                    break;
            }
            //console.log(New_bili_url,bili_url )
            if( location.host == 'www.bilibili.com' && ( /https:\/\/www\.bilibili\.com\/video\/BV\w*/i.test(location.href)||/https:\/\/www\.bilibili\.com\/bangumi\/play\/\w*/i.test(location.href) ) && New_bili_url!=bili_url ){
                bili_url = New_bili_url
                stopSet()
                GM_xmlhttpRequest({
                    method: "GET",
                    url: bili_url ,
                    headers: {'Referer': location.href,'If-Modified-Since': '0',"Cache-Control":"no-store"},
                    onerror: function(x) {
                        console.log("bili接口数据出错: url="+bili_url)
                        console.log(x)
                    },
                    onload: function(response) {
                        //console.log(response)
                        if( response.status>400){ return; }
                        var data = response.responseText;
                        New_bili_url = JSON.parse(data).data.durl[0].url;
                        url_lists.push( New_bili_url )
                        //console.log(url)
                        //url: 'https://api.bilibili.com/x/web-interface/wbi/view/detail?platform=web&bvid='+videoData.bvid+'&aid='+videoData.aid ,
                        addUrl(New_bili_url, name )
                    }
                })
            }
        },100);
        function stopSet(){ clearInterval(set$); };
    }
    var _wr = function(type) {
        var orig = history[type];
        return function() {
            var rv = orig.apply(this, arguments);
            var e = new Event(type);
            e.arguments = arguments;
            window.dispatchEvent(e);
            return rv;
        };
    };
    unsafeWindow.history.pushState = _wr('pushState');
    unsafeWindow.history.replaceState = _wr('replaceState');

    // 覆盖console.clear函数
    //const originalClear = console.clear.bind(console);
    //unsafeWindow.console.clear = function() {
    //    console.warn('Console clear has been disabled.');
    //};
        // 覆盖console.clear函数
    //unsafeWindow.console = function() {
    //    console.warn('Console  assign() has been disabled.');
    //};

    function getNetworkRequsts(){
        return performance.getEntriesByType("resource") .filter((entry) => {
            return (entry.initiatorType === "audio"||entry.initiatorType === "video" || entry.initiatorType=== "xmlhttprequest" || entry.initiatorType=== "fetch");
        });
    }
    var observer = new PerformanceObserver(perf_observer);
    observer.observe({entryTypes: ["resource"]})
    unsafeWindow.scriptsList = []
    unsafeWindow.url_lists = []
    function perf_observer(list,observer){
        var z,m,length= 0;
        length = $('.MyUrls .isUrl').length
        var scripts =getNetworkRequsts()
        //console.log(scripts)
        scripts = scripts.filter(function(i){
            return !scriptsList.includes(i);
        } )
        if(scripts.length<1){ scripts.push('') }
        //console.log(scripts)
        scripts.forEach(function (x,i) {
            //console.log('script_foreach')
            if( x != ""){
                z = x.name.trim()
                if($('.MyNR div.downloadUrl > input.downUrl').map(function() {return $(this).val();}).get().includes(z) ){console.log('此链接是0、框里的'); return; }
                url_lists.push( z )
                //console.log(x)
                if( (/m3u8/i.test(z) && !/\.ts/i.test(z.replaceAll(/\?.*/g,''))) || /mp4\??.*/i.test(z) || /\.ogg\??.*/i.test(z) || /.*\.m4a\??.*/i.test(z) || /.*\.mp3\??.*/i.test(z) || !( /\.\w{1,5}$/i.test(z.replaceAll(/\?.*/g,'')) )){
                    if(z !=undefined && z.trim()!="" ){
                        var name = ""

                        switch( location.host )
                        {
                            case 'y.qq.com':
                                if(location.href== 'https://y.qq.com/n/ryqq/player' ){
                                    name = $('.player_music__info').text()
                                }
                                break;
                            case 'www.iwara.tv':
                                name = '['+$('a[class=username]').attr('title') +'] '+ $('title').text()
                                break;
                            case 'www.douyin.com' :
                            default:
                                break;
                        }
                        addUrl( z,name)
                    }
                }

            }
            $("video").each(function () {
                var that = $(this)
                if( that.parents("#giegei717dplayer").length!=0){  return; }
                if(!/^blob:/i.test( that.attr('src') ) ){
                    z = that.attr('src')
                    if(z !=undefined && z.trim()!="" ){
                        var name = ""
                        switch( location.host )
                        {
                            case 'buyin.jinritemai.com' :
                                if( /https\:\/\/buyin\.jinritemai\.com\/dashboard\/merch-picking-library\/merch-promoting\?/i.test( location.href ) ){
                                    var title =$(that).parents('[class^=index_module__contentCard____]').find('div[class^=index_module__authorInfo____]')
                                    name = title.find('[class^=index_module__name____]').text()
                                    var show = title.find('[class^=index_module__descLine____]').text()
                                    name = name+' --- '+show
                                    //if($('ul[class=auxo-pagination]').length!=0 && ul_li == 0){
                                    //    ul_li = 1
                                    //    $('.auxo-pagination>li:not(.auxo-pagination-item-active):not(.auxo-pagination-disabled)>a').on('click',function () {
                                    //        $('#Alldel').click()
                                    //    })
                                    //}

                                }
                                break;
                            default:
                                break;
                        }
                        addUrl( z,name)
                    }
                }
            })
            $("audio").each(function () {
                //console.log("audio")
                var that = $(this)
                z = $(this).attr('src')
                if( that.parents("#giegei717dplayer").length!=0){  return; }
                if(z !=undefined && z.trim()!="" ){
                    var name = ""
                    if( /https:\/\/y\.qq\.com\/n\/ryqq\/player/i.test(location.href) ){ name = $('.player_music__info').text() }
                    addUrl( z,name)
                }

            })
            $("source").each(function () {
                //console.log("source")
                if( $(this).parents("#giegei717dplayer").length!=0){ return; }
                if($(this).attr('src')!=undefined && $(this).attr('src').trim()!='' && !/^blob:/.test($(this).attr('src')) ){
                    if(!/^(http:|https:)/.test($(this).attr('src'))){
                        z = location.href.split("://")[0] +':'+ $(this).attr('src')
                    }else{
                        z = $(this).attr('src')
                    }
                    addUrl( z,"" )
                }
            })
        })
        scriptsList = scriptsList.concat(scripts);
        if($('.MyUrls .isUrl').length > length){
        }
    }
    var ul_li = 0



    window.addEventListener('message', function(event) {
        var url = event.data
        if( url.url== undefined || url.url == null || url.url ==""){ return; }
        addUrl(url.url, url.name , url.href)
    }, true)

    if (window.self !== window.top && ($('#MyUpDown').css("display")!="none" || $('#MyUrls').css("display")!="none") ) {
        $('#MyUpDown,#MyUrls').css("display","none")
        //console.log($('body'))
    }
    unsafeWindow.url_info = []
    unsafeWindow.urls = []
    function addUrl( url ,name='',href = location.href){
        //alert(url)
        if( url == undefined || url == null || url.length < 1){
            console.log("addurl=null, return.")
            return;
        }

        if (window.self != window.top) {
           // console.log("当前页面位于iframe子页面");
            var message = { url:url,name:name, href:location.href }; // 要传递的消息
            window.parent.postMessage(message, "*"); // *表示任意源都能收到消息
            return;
        } else {
            //console.log("当前页面不在iframe子页面内部");
            url = url.toString().trim()
            if(/^(http:|https:)/.test(url)){
                //"完整链接"
            }else if( /^(\/{0,2}([^\.\s\/]*\.){1,3}[\w]{1,8}(:[\d]{1,5})?)\/.*/.test(url) ){
                // 缺少协议
                url = href.trim().match(/^(http:|https:)/im)[0]+"//"+url.replace(/^(\/{0,2})/img,"")
            }else if( /^(\/)/.test(url)){ //"不完整，需要拼接"
                url = location.origin + url
            }
        }
        //console.log(url)
        if(! urls.includes(url.trim())){
            urls.push(url.trim())
        }else{
            return;
        }
        switch( location.host )
        {
            case 'x.com':
                if( /(\/pl\/mp4a\/|\/pl\/avc1)/i.test( url ) ){
                    return
                }
                break;
            case 'www.iwara.tv':
                if( !/(_Source\.mp4)/i.test( url ) ){
                    return
                }
                break;
            default:
                break;
        }
        //console.warn(url)
        GM_xhr( url)
        function GM_xhr( url, i=0){
            //console.warn("——————")
            //console.warn(i)
            //console.warn("——————")
            var head
            var Headers
            var Length
            var Type
            var origin= (new URL(href)).origin
            var default_web = false
            switch( location.host )
            {
                case 'web.telegram.org':
                    head = { Range:"bytes=0-200", "user-agent":
          "User-Agent Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/117.0"}
                    default_web = true
                    break;
            }
            if (!default_web){
                origin= (new URL(href)).origin
                switch( i )
                {
                    case 0:
                        head = {Referer: href, Range:"bytes=0-200", "Cache-Control":"no-store"}
                        break;
                    case 1:
                        head = {Referer: href, Origin: origin ,Range:"bytes=0-200", "Cache-Control":"no-store"}
                        break;
                    case 2:
                        head = {Range:"bytes=0-200", 'Cache-Control':"no-store"}
                        break;
                    case 3:
                        href = (new URL(url)).origin+'/'
                        head = {Referer: href, Origin: origin }// ,Range:"bytes=0-200", "Cache-Control":"no-store"}
                        break;
                    case 4:
                        origin = location.origin
                        head = {Referer: href, Origin: location.origin ,Range:"bytes=0-200", "Cache-Control":"no-store"}
                        break;
                    case 5:
                        href = url
                        head = {Referer: url, Range:"bytes=0-200"}
                        break;
                    case 6:
                    default:
                        console.log("Url始终HEAD 错误，不添加列表: "+url)
                        return;
                        break;
                }
            }
            //console.warn(1)
           // fetch(url, {
           //     method: "GET",
          //      headers: head
          //  })
          //      .then((res) => {
          //      console.log(res)
          //  })



            var get = GM_xmlhttpRequest({
                method: "GET",
                url: url,
                // fetch: true,
                withCredentials: true,
                headers: head, //{'Referer': location.href, "Range":"bytes=0-200", "Cache-Control":"no-store"},
                onerror: function(x) {
                    //console.warn(2)
                    console.log("Url错误onerror(),HEAD出错 : "+url)
                    console.log(x)
                    url_info.push( { url:url, info: "Url错误onerror,HEAD出错 ", response: x} )
                    GM_xhr( url , i+1 )
                    get.abort()
                    //return;
                },
                onload: function(response) {

                    console.log({"Url":url , "head":head, "response": response, "response.responseHeaders" : response.responseHeaders ,"response.responseText": response.responseText});
                    var x
                    var num
                    if (/https:\/\/web\.telegram\.org\/a\/progressive\/document\d{19}$/i.test( url ) ){
                        Type = 'normal'; VorA = "MyVideo"
                        x = $("#MyUrls .MyNR>."+VorA)
                        num = x.find('.isUrl').length+1
                        x.find(".urlnone").remove()
                        x.append("<div class='isUrl' style='height: 31px;'>"+
                                 "<hr    > " +
                                 "<div   class='No-isUrl'> " +num+"、</div>"+
                                 "<input disabled  data-type='"+Type+"'  class='downUrl"+num+"'   title='"+url+"' value='"+url+"'> "+
                                 "<input title='"+ (name=="" ? '自定义保存文件名' : name) +"'        class='downName"+num+"'  placeholder='文件名' value='"+name+"'>"+
                                 "<div   style='display: inline-block;'  class='But GoUrl"+num+"'      >访问</div>"+
                                 "<div   style='display: inline-block;'  class='But CopyUrl"+num+"'    >复制</div>"+
                                 "<div   style='display: inline-block;'  data-head_i='"+i+"' data-head_href='"+href+"' data-head_origin='"+origin+"' data-Headers='"+Headers+"' data-Length='"+Length+"' data-Type='"+Type+"' data-head='"+ JSON.stringify(head) +
                                 "'  class='But noSaveUrl"+num+"'    >No</div>"+
                                 "<div   style='display: none;        '  class='But StopSaveUrl"+num+"'> 0% </div>"+
                                 "<div   style='display: inline-block;'  class='But playUrl"+num+"'    >播放</div>&nbsp"+
                                 "<div   title='删除此条'                class='rmUrl"+num+"'          >&nbspx&nbsp</div>"+
                                 "</div>")
                        functionAll(num,VorA)
                        if($("#MyUrls").css("display")=="none"){
                            $("#redPoint").css("display","block")
                            $(".MyBT #"+VorA).click()
                            if(GM_getValue("auto_n", 1) == set['auto_n']){
                                $("#MyUpDown").click()
                            }
                        }
                        return
                    }else{
                        //console.warn(head)
                        if(response.status/100>=3&& response.status!=404 ){
                            console.log("Url错误onerror,HEAD 403: "+url)
                            url_info.push( { url:url, info: "Url错误onerror,HEAD 403", response: response} )
                            GM_xhr( url , i+1 )
                            return;
                        }
                        if(response.status/100>=3){
                            console.log("Url错误onerror,HEAD出错 不添加列表: "+url)
                            console.log(response)
                            url_info.push( { url:url, info: "Url错误status>400 不添加列表", response: response} )
                            GM_xhr( url , i+1 )
                            get.abort()
                        }
                        Headers = response.responseHeaders;
                        if( Headers == undefined || Headers == null || Headers ==""||Headers.length<1 ){
                            console.log("Url:"+url+",HEAD出错: responseHeaders 为空")
                            url_info.push( { url:url, info: "HEAD出错: responseHeaders 为空", response: response} )
                            return;
                        }
                        Type = Headers.match(/content-type:\s*[\S]+\s/im)
                        //console.log(Type)
                        var VorA = "MyVideo"
                        if(Type == undefined || Type == null || Type.length<1){
                            if( /^#EXTM3U/i.test(response.responseText) ){
                                Type = 'hls'; VorA = "MyVideo"
                            }else{
                                console.log("Type为空"+url)
                                console.log(response)
                                url_info.push( { url:url, info: "Type为空", response: response} )
                                return
                            }
                        }else{
                            Type = Type[0].replace('content-type:','').trim()
                            //console.log(Type)application/octet-stream
                            if( /^#EXTM3U/i.test(response.responseText) ){
                                Type = 'hls'; VorA = "MyVideo"
                            }else if( /.*video\/mp4.*/i.test( Type ) || ( /application\/octet-stream/i.test( Type ) && /mp4\??.*/i.test(url) ) ){
                                Length = Headers.match(/content-range:\s*bytes\s*0-[\d]+\/[\d]+\s/im)[0].replace(/.*\//img,'').trim()
                                if( Length < 1024*1024 || (/\.m4s(?:[?#]|$)/i.test(url)&& Length <5 * 1024*1024 )){
                                    console.log("嗅探到的视频太小x1："+Length+"B ,丢弃："+url)
                                    url_info.push( { url:url, info: "嗅探到的视频太小x1："+Length+"B ,丢弃", response: response} )
                                    return;
                                }
                                Type = 'normal'; VorA = "MyVideo"

                            }else if( /.*\/.*mpegurl.*/i.test( Type )){
                                Type = 'hls'; VorA = "MyVideo"
                            }else if( /.*audio\/.*/i.test( Type )){
                                Type = 'auto'; VorA = "MyAudio" //音乐
                            }else if( /.*(text\/[\w]*).*/i.test( Type ) || /application\/octet-stream/i.test( Type ) ) {
                                if( /^#EXTM3U/i.test(response.responseText) ){
                                    Type = 'hls'; VorA = "MyVideo"
                                }else{
                                    url_info.push( { url:url, info: "Type:"+Type, response: response} )
                                    console.log(Type, url)
                                    return;
                                }
                            }else{
                                url_info.push( { url:url, info: "Type:"+Type, response: response} )
                                console.log(Type, url)
                                return;
                            }
                        }
                    }
                    // console.warn(4)
                    //console.warn(window.self != window.top)
                    //console.log(url)
                    //console.log(Type)
                    //console.log(Length)
                    x = $("#MyUrls .MyNR>."+VorA)
                    x.find(".urlnone").remove()
                    num = x.find('.isUrl').length+1
                    x.append("<div class='isUrl' style='height: 31px;'>"+
                             "<hr    > " +
                             "<div   class='No-isUrl'> " +num+"、</div>"+
                             "<input disabled  data-type='"+Type+"'  class='downUrl"+num+"'   title='"+url+"' value='"+url+"'> "+
                             "<input title='"+ (name=="" ? '自定义保存文件名' : name) +"'        class='downName"+num+"'  placeholder='文件名' value='"+name+"'>"+
                             "<div   style='display: inline-block;'  class='But GoUrl"+num+"'      >访问</div>"+
                             "<div   style='display: inline-block;'  class='But CopyUrl"+num+"'    >复制</div>"+
                             "<div   style='display: inline-block;'  data-head_i='"+i+"' data-head_href='"+href+"' data-head_origin='"+origin+"' data-Headers='"+Headers+"' data-Length='"+Length+"' data-Type='"+Type+"' data-head='"+ JSON.stringify(head) +
                             "'  class='But SaveUrl"+num+"'    >下载</div>"+
                             "<div   style='display: none;        '  class='But StopSaveUrl"+num+"'> 0% </div>"+
                             "<div   style='display: inline-block;'  class='But playUrl"+num+"'    >播放</div>&nbsp"+
                             "<div   title='删除此条'                class='rmUrl"+num+"'          >&nbspx&nbsp</div>"+
                             "</div>")
                    functionAll(num,VorA)
                    if($("#MyUrls").css("display")=="none"){
                        $("#redPoint").css("display","block")
                        $(".MyBT #"+VorA).click()
                        if(GM_getValue("auto_n", 1) == set['auto_n']){
                            $("#MyUpDown").click()
                        }
                    }
                },
            });
            //console.log(get)
            }
    }


    function mkMenu(list){
        list.forEach( function(menu){
            var No = menu.No
            var key = menu.key
            var keyName = menu.keyName
            var keyVal = GM_getValue( keyName, 1)
            if( No == 0 ){
                menuList[No] = GM_registerMenuCommand( key , function() { eval( keyName ) })
            }else{
                menuList[No] = GM_registerMenuCommand( key+info[ keyVal == set[keyName] ? 1 : 0 ], function() {
                    keyVal = keyVal == 1 ? 0 : 1
                    GM_setValue(keyName, keyVal);
                    mkMenu( [menu] )
                }, { id: menuList[No] } );
            }
        })
    }
    function rmMenu(id){
        GM_unregisterMenuCommand(id);
    }

    function dplayerUrl(url,i,type){
        var lay_i = unsafeWindow.dpgiegei717index;
        $('#layui-layer'+lay_i+',#layui-layer-shade'+lay_i).remove()
        var index = layer.load(2);
        var conf = {
            type: 1,
            //formType: 0,
            title: i+"、"+url,
            shadeClose: true,  //点击遮罩关闭
            offset: offset,  // 垂直位置
            fixed: true,  //层固定，不随页面滚动
            maxmin: true, //最大小化
            resize: true, //拉伸
            airplay: true, //在 Safari 中开启 AirPlay
            chromecast: true, //启用 Chromecast
            move: '.layui-layer-title', // 是否允许拖动
            moveOut: false, //是否允许拖拽到窗口外
            btn: [],
            area: weight,
            content: "<div id='giegei717dplayer' style='width: 100%;height: 100%;display:flex;align-items:center;justify-content:center;'></div>"
            ,success:  function(layero, index){
                //var
                unsafeWindow.dpgiegei717 = new DPlayer({
                    element: document.getElementById("giegei717dplayer"),
                    preload: 'auto',  //视频预加载
                    hotkey: true,     //键盘热键
                    volume: 1,        //默认音量
                    mutex: true,      //互斥 同时只有一个播放器能播放
                    loop: false,      //循环播放
                    airplay: true,    //在 Safari 中开启 AirPlay
                    playbackSpeed: [0.1,0.5, 1, 1.25, 1.5, 2], //可选的播放速率
                    screenshot: true, //开启截图
                    autoplay: true,   //自动播放
                    preventClickToggle: false, //阻止点击播放器时候自动切换播放/暂停
                    contextmenu: [
                        {
                            text: '刷新视频',
                            click: (player) => {
                                //console.log(player);
                                player.switchVideo(
                                    {
                                        url: url,
                                        type: type,
                                    },
                                );
                                player.play()
                            },
                        },
                        {
                            text: '复制链接',
                            click: (player) => {
                                GM_setClipboard(url);
                                var aux = document.createElement("input");
                                aux.setAttribute("value", url);
                                document.body.appendChild(aux);
                                aux.select();
                                document.execCommand("copy");
                                document.body.removeChild(aux);
                                layer.msg("已复制")
                            }
                        }
                    ],
                    video: {
                        url: url,
                        type: type,
                    },
                });
                dpgiegei717.video.crossOrigin=null;
                dpgiegei717.on('error', function () {
                    if( firstVideo == 0 ){
                        console.log('加载video的扩展js')
                        GM_addElement('script', { src: 'https://cdn.bootcdn.net/ajax/libs/flv.js/1.6.2/flv.min.js',type: 'text/javascript' });
                        GM_addElement('script', { src: 'https://cdn.bootcdn.net/ajax/libs/shaka-player/4.3.5/shaka-player.compiled.min.js',type: 'text/javascript' });
                        GM_addElement('script', { src: 'https://cdn.bootcdn.net/ajax/libs/dashjs/4.6.0/dash.all.min.js',type: 'text/javascript' });
                        firstVideo = 1
                        dpgiegei717.switchVideo({ url: url, type: type, });
                        dpgiegei717.play()
                    }
                });
                //dp.video.crossOrigin="anonymous";
                //$("#giegei717dplayer video").attr("crossOrigin","anonymous")
                var set = setInterval(function(){
                    if($('#giegei717dplayer>.dplayer-video-wrap>video').length>0){
                        var video = $('#giegei717dplayer>.dplayer-video-wrap> video[class^=dplayer-video]')[0]
                        stopSet()
                        //双击全屏
                        var touchtime = 0;
                        var touchtarget;
                        $('#giegei717dplayer>.dplayer-video-wrap> video[class^=dplayer-video]').on("dblclick",function () {
                            if (document.fullscreenElement == null) {
                                dpgiegei717.fullScreen.request();
                            } else {
                                dpgiegei717.fullScreen.cancel();
                            }
                        }).on('touchstart', function(event) {
                            if (touchtime == 0) {
                                touchtime = new Date().getTime();
                                touchtarget = event.target;
                            } else {
                                if (event.target == touchtarget && new Date().getTime() - touchtime < 300) {
                                    // 双击事件发生
                                    //console.log('双击事件发生');
                                    if (document.fullscreenElement == null) {
                                        dpgiegei717.fullScreen.request();
                                    } else {
                                        dpgiegei717.fullScreen.cancel();
                                    }
                                    touchtime = 0;
                                } else {
                                    touchtime = new Date().getTime();
                                    touchtarget = event.target;
                                }
                            }
                        });
                        //画中画
                        $('#giegei717dplayer .dplayer-icons-right').prepend('<div class="dplayer-icon dplayer-hzh-icon" data-balloon="画中画" data-balloon-pos="up">'+
                                                                      '<span class="dplayer-icon-content"><svg width="24" height="22" xmlns="http://www.w3.org/2000/svg">'+
                                                                      '<path  d="m19.22801,9.8748l-8.11544,0l0,5.89418l8.11544,0l0,-5.89418zm4.05772,7.85891l0,-13.77273c0,-1.0806 -0.91299,-1.94508 -2.02886,-1.94508l-18.25974,0c-1.11587,0 -2.02886,0.86448 -2.02886,1.94508l0,13.77273c0,1.0806 0.91299,1.96473 2.02886,1.96473l18.25974,0c1.11587,0 2.02886,-0.88413 2.02886,-1.96473zm-2.02886,0.01965l-18.25974,0l0,-13.80221l18.25974,0l0,13.80221z"></path>'+
                                                                      '</svg></span>'+
                                                                      '</div>')
                        $('#giegei717dplayer .dplayer-icons-right>.dplayer-hzh-icon').on('click',function(){
                            var that = this;
                            if(hzh == false && !document.pictureInPictureElement){
                                video.requestPictureInPicture();
                                video.addEventListener('enterpictureinpicture', function() {
                                    // 已进入画中画模式
                                    hzh = true;
                                });
                            }else{
                                document.exitPictureInPicture();
                                video.addEventListener('leavepictureinpicture', function() {
                                    // 已退出画中画模式
                                    hzh = false;
                                });
                            }
                        })
                        //刷新按钮
                        $('#giegei717dplayer .dplayer-icons-right').prepend('<div class="dplayer-icon dplayer-reload-icon" data-balloon="刷新" data-balloon-pos="up">'+
                                                                      '<span class="dplayer-icon-content"><svg width="24" height="22" xmlns="http://www.w3.org/2000/svg" >'+
                                                                      '<path stroke="null" d="m3.06995,10.0686a0.7572,0.7696 0 0 1 0.7572,0.7696l0,0.3848c0,4.45446 3.6853,8.08083 8.2482,8.08083c2.08458,0 4.04346,-0.7596 5.54802,-2.10102l0.19384,-0.17778l0.27638,-0.2632a0.7572,0.7696 0 0 1 1.06993,0.03694l0.51717,0.56181a0.7572,0.7696 0 0 1 -0.03559,1.08822l-0.27714,0.26243c-1.94677,1.85012 -4.53791,2.9014 -7.29185,2.9014c-3.33926,0 -6.32036,-1.53844 -8.24896,-3.94037l0,0.86195a0.7572,0.7696 0 0 1 -0.7572,0.7696l-0.7572,0a0.7572,0.7696 0 0 1 -0.7572,-0.7696l0,-7.69603a0.7572,0.7696 0 0 1 0.7572,-0.7696l0.7572,0zm8.54729,-9.23523c3.2802,0 6.2083,1.52381 8.11115,3.90342l0,-0.82501a0.7572,0.7696 0 0 1 0.7572,-0.7696l0.7572,0a0.7572,0.7696 0 0 1 0.7572,0.7696l0,7.69603a0.7572,0.7696 0 0 1 -0.7572,0.7696l-0.7572,0a0.7572,0.7696 0 0 1 -0.7572,-0.7696l0,-0.3848c0,-4.45831 -3.627,-8.08083 -8.11115,-8.08083c-2.15045,0 -4.16385,0.83579 -5.66614,2.29803l-0.17794,0.17855l-0.26502,0.27475a0.7572,0.7696 0 0 1 -1.07144,0.00924l-0.53988,-0.53872a0.7572,0.7696 0 0 1 -0.00909,-1.08899l0.26502,-0.27475a10.43424,10.60512 0 0 1 7.46449,-3.16691z"></path>'+
                                                                      '</svg></span>'+
                                                                      '</div>')
                        $('#giegei717dplayer .dplayer-icons-right>.dplayer-reload-icon').on('click',function(){
                            dpgiegei717.switchVideo({ url: url, type: type, });
                            dpgiegei717.play()
                        })
                    }
                },50);
                function stopSet(){
                    clearInterval(set);
                }
                window.onresize = function () {
                    w = window.innerWidth;
                    h = window.innerHeight;
                    $("#giegei717dplayer").parents("div[id^=layui-layer]").css({"max-width": w,"max-height": h } )
                }
            }
            ,end: function(){
                $(".But:nth-last-of-type(2)").text('播放')
            }

        }
        layer.close(index);
        unsafeWindow.dpgiegei717index = layer.open(conf)
    }

})();