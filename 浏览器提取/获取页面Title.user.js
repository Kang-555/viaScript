// ==UserScript==
// @name         页面Title提取(可复制悬浮框)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  页面右上角悬浮显示网页title，点击一键复制
// @author       You
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 创建悬浮容器
    const box = document.createElement('div');
    box.style.position = 'fixed';
    box.style.top = '12px';
    box.style.right = '12px';
    box.style.zIndex = '999999';
    box.style.background = '#222';
    box.style.color = '#fff';
    box.style.padding = '8px 12px';
    box.style.borderRadius = '6px';
    box.style.maxWidth = '320px';
    box.style.fontSize = '13px';
    box.style.cursor = 'pointer';
    box.style.boxShadow = '0 2px 8px #0004';
    box.style.userSelect = 'text';
    document.body.appendChild(box);

    // 更新显示title
    function updateTitleUI(){
        const t = document.title;
        box.innerText = `📋 ${t}`;
    }

    // 点击复制到剪贴板
    box.onclick = async ()=>{
        try {
            await navigator.clipboard.writeText(document.title);
            const old = box.innerText;
            box.innerText = '✅已复制';
            setTimeout(()=>updateTitleUI(),1200);
        }catch(err){
            console.error('复制失败',err);
        }
    }

    // 初始渲染
    updateTitleUI();

    // 监听title变化（js动态修改标题也同步更新）
    const titleObs = new MutationObserver(()=>{
        updateTitleUI();
    });
    titleObs.observe(document.querySelector('title'), {childList:true});

})();
