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
  const p = pattern.trim();
  if (p === "*") return true;

  let testUrl = url;
  let regexStr;

  if (p.startsWith("/")) {
    try {
      const u = new URL(url);
      testUrl = u.pathname + u.search;
    } catch {
      testUrl = url;
    }
    regexStr = p;
  } else if (p.includes("://")) {
    regexStr = p;
  } else {
    regexStr = `*://${p}`;
    const afterScheme = regexStr.indexOf("://") + 3;
    if (!regexStr.slice(afterScheme).includes("/")) {
      regexStr += "/*";
    }
  }

  const escaped = regexStr
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  try {
    return new RegExp(`^${escaped}$`).test(testUrl);
  } catch {
    return false;
  }
}

const injectedScriptIds = new Set();
const STYLE_CACHE_KEY = "utk_style_cache";

function applyCachedStylesSync() {
  let cached = "";
  try {
    cached = sessionStorage.getItem(STYLE_CACHE_KEY) || "";
  } catch {
    cached = "";
  }
  if (!cached) return;
  const old = document.getElementById("utk-style");
  if (old) old.remove();
  const style = document.createElement("style");
  style.id = "utk-style";
  style.textContent = cached;
  (document.head || document.documentElement).appendChild(style);
}

function writeStyleCache(css) {
  try {
    if (css) sessionStorage.setItem(STYLE_CACHE_KEY, css);
    else sessionStorage.removeItem(STYLE_CACHE_KEY);
  } catch {}
}

async function applyStyles() {
  const data = await p(chrome.storage.local, "get", "styles");
  const styles = data.styles || [];
  const matched = styles.filter(s =>
    s.enabled !== false && (!s.urlPattern || matchPattern(location.href, s.urlPattern))
  );

  const old = document.getElementById("utk-style");
  if (old) old.remove();

  if (!matched.length) {
    writeStyleCache("");
    return;
  }

  const css = matched.map(s => s.css).join("\n");
  const style = document.createElement("style");
  style.id = "utk-style";
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
  writeStyleCache(css);
}

async function requestScriptInjection() {
  const data = await p(chrome.storage.local, "get", "scripts");
  const scripts = data.scripts || [];
  const matched = scripts.filter(s =>
    s.enabled !== false && (!s.urlPattern || matchPattern(location.href, s.urlPattern))
  );

  for (const s of matched) {
    if (injectedScriptIds.has(s.id)) continue;
    injectedScriptIds.add(s.id);

    try {
      await p(chrome.runtime, "sendMessage", {
        type: "INJECT_SCRIPT",
        code: s.code,
        id: s.id,
        name: s.name || ""
      });
    } catch (e) {
      console.warn("[PageForge] 脚本注入请求失败:", s.name, e);
      try {
        new Function(s.code)();
      } catch (err) {
        console.warn("[PageForge] 隔离世界执行失败（可能被 CSP 拦截）:", s.name, err);
        chrome.runtime.sendMessage({
          type: "SCRIPT_ERROR",
          id: s.id,
          name: s.name || "",
          error: String(err)
        }, () => void chrome.runtime.lastError);
      }
    }
  }
}

applyCachedStylesSync();
applyStyles();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", requestScriptInjection);
} else {
  requestScriptInjection();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "REFRESH") {
    applyStyles();
    requestScriptInjection();
    sendResponse({ ok: true });
    return true;
  }
  sendResponse({ ok: false, error: "unknown message" });
  return false;
});