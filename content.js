function p(obj, method, ...args) {
  return new Promise((resolve, reject) => {
    try {
      const ret = obj[method](...args, (result) => {
        const err = chrome.runtime.lastError;
        if (err) reject(err); else resolve(result);
      });
      if (ret && typeof ret.then === "function") ret.then(resolve, reject);
    } catch (e) {
      reject(e);
    }
  });
}

function matchPattern(url, pattern) {
  if (!pattern || pattern.trim() === "") return true;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(url);
}

async function applyStyles() {
  const data = await p(chrome.storage.local, "get", "styles");
  const styles = data.styles || [];
  const matched = styles.filter(s =>
    s.enabled !== false && (!s.urlPattern || matchPattern(location.href, s.urlPattern))
  );

  // 先移除旧样式，确保禁用后立即消失
  const old = document.getElementById("utk-style");
  if (old) old.remove();
  if (!matched.length) return;

  const css = matched.map(s => s.css).join("\n");
  const style = document.createElement("style");
  style.id = "utk-style";
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
}

async function applyScripts() {
  const data = await p(chrome.storage.local, "get", "scripts");
  const scripts = data.scripts || [];
  const matched = scripts.filter(s =>
    s.enabled !== false && (!s.urlPattern || matchPattern(location.href, s.urlPattern))
  );
  for (const s of matched) {
    try {
      new Function(s.code)();
    } catch (e) {
      console.warn("[Toolkit] 脚本执行失败:", s.name, e);
    }
  }
}

applyStyles();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", applyScripts);
} else {
  applyScripts();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "REFRESH") {
    applyStyles();
    applyScripts();
  }
});