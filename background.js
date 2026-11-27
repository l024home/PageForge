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

const CORS_RULE_ID = 1;

async function setCorsRule(enabled, origin = null) {
  if (!enabled) {
    await p(chrome.declarativeNetRequest, "updateDynamicRules", {
      removeRuleIds: [CORS_RULE_ID]
    });
    return;
  }
  const targetOrigin = origin || "http://localhost:3000";
  await p(chrome.declarativeNetRequest, "updateDynamicRules", {
    removeRuleIds: [CORS_RULE_ID],
    addRules: [{
      id: CORS_RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: targetOrigin },
          { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" },
          { header: "Vary", operation: "append", value: "Origin" }
        ]
      },
      condition: {
        initiatorDomains: ["localhost", "127.0.0.1"],
        resourceTypes: ["xmlhttprequest"]
      }
    }]
  });
}

async function injectScript(tabId, code) {
  await p(chrome.scripting, "executeScript", {
    target: { tabId },
    func: (scriptCode) => {
      try { new Function(scriptCode)(); } catch (e) { console.error("[Toolkit]", e); }
    },
    args: [code],
    world: "ISOLATED"
  });
}

// ---- 侧边栏 / 面板打开方式初始化 ----
let panelBehaviorReady = false;

async function initPanelBehavior() {
  if (panelBehaviorReady) return;
  panelBehaviorReady = true;

  const hasSidePanel =
    chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === "function";

  if (hasSidePanel) {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      return; // 支持侧边栏，点击图标自动打开侧边栏，不注册 onClicked
    } catch (e) {
      console.warn("[Toolkit] setPanelBehavior 失败，退化为标签页打开:", e);
    }
  } else {
    console.warn("[Toolkit] 当前环境不支持 sidePanel API，退化为标签页打开");
  }

  // 兜底：点击扩展图标时打开独立标签页
  if (chrome.action?.onClicked) {
    chrome.action.onClicked.addListener(() => {
      chrome.tabs.create({ url: chrome.runtime.getURL("ui/panel.html") });
    });
  }
}

initPanelBehavior();

// ---- 安装与消息处理 ----
chrome.runtime.onInstalled.addListener(async () => {
  const data = await p(chrome.storage.local, "get", ["corsEnabled", "corsTarget"]);
  if (data.corsEnabled) {
    await setCorsRule(true, data.corsTarget || "http://localhost:3000");
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "SET_CORS":
          await setCorsRule(msg.enabled, msg.origin);
          sendResponse({ ok: true });
          break;
        case "INJECT_SCRIPT":
          await injectScript(msg.tabId, msg.code);
          sendResponse({ ok: true });
          break;
        case "GET_TAB_INFO":
          sendResponse({ url: sender.tab?.url || "" });
          break;
        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});