// ============================================================
// 通用油猴脚本：导出 txt + 下载文件 + 剪贴板工具
// 复制整个 IIFE 到你的脚本里即可使用，或按需复制单个函数
// 依赖：无（纯浏览器 API，不依赖 GM_*，兼容 Via/Tampermonkey/Violentmonkey）
// ============================================================

(function () {
    "use strict";

    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isAndroid = /Android/i.test(navigator.userAgent);

    // 1. 剪贴板（Promise 版本，自动降级）
    function copyToClipboard(text) {
        return new Promise(resolve => {
            if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(
                    () => resolve(true),
                    () => fallbackCopy(text, resolve)
                );
            } else {
                fallbackCopy(text, resolve);
            }
        });
    }

    function fallbackCopy(text, resolve) {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); resolve(true); } catch (_) { resolve(false); }
        ta.remove();
    }

    // 2. 下载 / 导出文本文件
    //    iOS → data URL + 新窗口（用户长按存文件）
    //    Android/PC → Blob + <a>.click()
    //    失败 → 自动降级复制到剪贴板
    function downloadTxt(content, filename) {
        if (isIOS) {
            const url = "data:text/plain;charset=utf-8," + encodeURIComponent(content);
            const w = window.open(url, "_blank");
            if (!w) location.href = url;
            return { method: "ios-data-url" };
        }
        try {
            const blob = new Blob([content], { type: "text/plain" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.style.display = "none";
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            return { method: "blob-click" };
        } catch (e) {
            return copyToClipboard(content).then(ok => ({
                method: ok ? "fallback-copy" : "failed"
            }));
        }
    }

    // 3. 从 URL 提取安全文件名
    function extractFilename(url, fallbackIdx, ext) {
        try {
            const pathname = new URL(url).pathname;
            let name = pathname.split("/").filter(Boolean).pop() || "";
            name = name.split("?")[0].split("#")[0];
            if (name && /\.[a-zA-Z0-9]{2,5}$/.test(name)) return name;
        } catch (_) { }
        return `img_${String(fallbackIdx + 1).padStart(3, "0")}.${ext || "jpg"}`;
    }

    // 4. 安全文件名清洗（去掉 Windows 非法字符）
    function safeName(s) {
        return String(s || "ManHua").replace(/[\\/:*?"<>|]/g, "_");
    }

    // 5. 从文档标题提取基础名（去掉《》编号、尾缀数字）
    function processBaseName(base) {
        let name = String(base || "").trim();
        if (/《([^》]+)》/.test(name)) name = name.match(/《([^》]+)》/)[1];
        else name = name.replace(/[-_][0-9]+$/, "");
        return safeName(name);
    }

    // 6. HTML 转义
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    // 暴露到 window.__utils，方便其他脚本调用
    const U = {
        copyToClipboard, fallbackCopy, downloadTxt,
        extractFilename, safeName, processBaseName, escapeHtml,
        isIOS, isAndroid,
    };
    if (typeof window !== "undefined") window.__utils = U;
    return U;
})();