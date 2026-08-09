// ==UserScript==
// @name         网页自由复制文本
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  解除网页禁止选中、复制、右键限制（性能优化版）
// @author       You
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    /**
     * 优化点1：使用CSS注入替代遍历所有元素
     * 通过<style>标签一次性设置全局样式，避免querySelectorAll('*')的性能问题
     */
    function injectGlobalStyle() {
        // 检查是否已注入过样式，避免重复添加
        if (document.getElementById('free-copy-style')) return;
        
        const style = document.createElement('style');
        style.id = 'free-copy-style';
        
        // 使用通配符*和所有元素类型强制设置user-select
        // 包含所有浏览器前缀以确保兼容性：
        // -webkit- : Chrome/Safari/Edge(新版)
        // -moz-    : Firefox
        // -ms-     : IE/旧版Edge
        style.textContent = `
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
        `;
        
        // 将样式插入到<head>，如果<head>不存在则插入到<html>
        const target = document.head || document.documentElement;
        if (target) {
            target.appendChild(style);
        }
    }

    /**
     * 优化点2：事件拦截
     * 在捕获阶段阻止相关事件传播，比目标阶段更早拦截
     */
    function blockEvents() {
        // 需要拦截的事件列表
        const eventsToBlock = [
            'selectstart',    // 文本选择开始
            'copy',           // 复制
            'cut',            // 剪切
            'contextmenu',    // 右键菜单
            'mousedown',      // 鼠标按下(某些网站用于阻止选择)
            'dragstart'       // 拖拽开始(部分网站也用于限制)
        ];
        
        // 使用捕获阶段(true)确保优先于页面自身的事件监听器
        eventsToBlock.forEach(eventType => {
            document.addEventListener(eventType, (e) => {
                // stopImmediatePropagation()会：
                // 1. 阻止事件继续向子元素传播
                // 2. 阻止同一元素上其他监听器的执行
                e.stopImmediatePropagation();
            }, true);
        });
    }

    /**
     * 优化点3：防抖函数
     * 避免频繁调用enableCopy，提升性能
     * @param {Function} func - 需要防抖的函数
     * @param {number} delay - 延迟时间(毫秒)
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
     * 核心功能：启用文本选择和复制
     */
    function enableCopy() {
        injectGlobalStyle();  // 注入全局样式
        blockEvents();        // 拦截事件
    }

    // ========== 执行策略 ==========
    
    // 策略1：立即执行（如果documentElement已存在）
    if (document.documentElement) {
        enableCopy();
    }
    
    // 策略2：DOM加载完成后执行
    window.addEventListener('DOMContentLoaded', enableCopy);
    
    // 策略3：页面完全加载后执行（包括图片等资源）
    window.addEventListener('load', enableCopy);
    
    // 策略4：延时执行，应对SPA动态内容
    setTimeout(enableCopy, 1500);
    setTimeout(enableCopy, 3000);
    
    // 策略5：使用MutationObserver监听DOM变化
    // 使用防抖避免频繁触发
    const debouncedEnableCopy = debounce(enableCopy, 200);
    
    const observer = new MutationObserver((mutations) => {
        // 检查是否有新节点添加
        const hasAddedNodes = mutations.some(mutation => 
            mutation.addedNodes && mutation.addedNodes.length > 0
        );
        
        if (hasAddedNodes) {
            debouncedEnableCopy();
        }
    });
    
    // 启动观察器
    function startObserver() {
        if (document.body) {
            observer.observe(document.body, {
                childList: true,   // 观察直接子节点
                subtree: true      // 观察所有后代节点
            });
        } else {
            // body尚未加载，等待DOMContentLoaded
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