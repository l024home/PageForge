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
const scriptStatusByTab = new Map(); // tabId -> { [scriptId]: { ok, error } }

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

async function injectScriptInMain(tabId, code, id, name) {
  try {
    await p(chrome.scripting, "executeScript", {
      target: { tabId },
      world: "MAIN",
      func: (scriptCode) => {
        new Function(scriptCode)();
      },
      args: [code]
    });
    scriptStatusByTab.set(tabId, {
      ...(scriptStatusByTab.get(tabId) || {}),
      [id]: { ok: true, name }
    });
    return { ok: true };
  } catch (e) {
    scriptStatusByTab.set(tabId, {
      ...(scriptStatusByTab.get(tabId) || {}),
      [id]: { ok: false, name, error: String(e) }
    });
    return { ok: false, error: String(e) };
  }
}

async function getTabIdFromSender(sender) {
  return sender.tab?.id ?? null;
}

// ---- 面板打开方式：幂等，只注册一次兜底 ----
let panelBehaviorReady = false;
let fallbackRegistered = false;

function registerTabFallback() {
  if (fallbackRegistered) return;
  fallbackRegistered = true;
  if (chrome.action?.onClicked) {
    chrome.action.onClicked.addListener(() => {
      chrome.tabs.create({ url: chrome.runtime.getURL("ui/panel.html") });
    });
  }
}

async function initPanelBehavior() {
  if (panelBehaviorReady) return;
  panelBehaviorReady = true;

  const hasSidePanel =
    chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === "function";

  if (hasSidePanel) {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      return; // 支持侧边栏，不注册 onClicked
    } catch (e) {
      console.warn("[PageForge] setPanelBehavior 失败，退化为标签页打开:", e);
    }
  } else {
    console.warn("[PageForge] 当前环境不支持 sidePanel API，退化为标签页打开");
  }

  registerTabFallback();
}

initPanelBehavior();

chrome.runtime.onInstalled.addListener(async () => {
  const data = await p(chrome.storage.local, "get", ["corsEnabled", "corsTarget"]);
  if (data.corsEnabled) {
    await setCorsRule(true, data.corsTarget || "http://localhost:3000");
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  scriptStatusByTab.delete(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "SET_CORS":
          await setCorsRule(msg.enabled, msg.origin);
          sendResponse({ ok: true });
          break;

        case "INJECT_SCRIPT": {
          const tabId = await getTabIdFromSender(sender);
          if (!tabId) { sendResponse({ ok: false, error: "no tab" }); break; }
          const result = await injectScriptInMain(tabId, msg.code, msg.id, msg.name);
          sendResponse(result);
          break;
        }

        case "SCRIPT_ERROR": {
          const tabId = await getTabIdFromSender(sender);
          if (tabId) {
            scriptStatusByTab.set(tabId, {
              ...(scriptStatusByTab.get(tabId) || {}),
              [msg.id]: { ok: false, name: msg.name, error: msg.error }
            });
          }
          sendResponse({ ok: true });
          break;
        }

        case "GET_SCRIPT_STATUS": {
          const tabId = msg.tabId;
          sendResponse({ ok: true, status: scriptStatusByTab.get(tabId) || {} });
          break;
        }

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